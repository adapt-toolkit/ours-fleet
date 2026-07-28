import { createInterface } from 'node:readline';

const sessionId = 'fixture-session';
let permissionRequestId = 10_000;
const pendingPermission = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if ('result' in message || 'error' in message) {
    const pending = pendingPermission.get(message.id);
    if (!pending) return;
    pendingPermission.delete(message.id);
    const outcome = message.result?.outcome;
    const selected = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `:${selected}` },
        },
      },
    });
    send({ jsonrpc: '2.0', id: pending.promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: { close: {} },
          },
        },
      });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      break;
    case 'session/close':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    case 'session/prompt': {
      const text = message.params.prompt.find(block => block.type === 'text')?.text ?? '';
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `echo:${text}` },
          },
        },
      });
      if (text.includes('permission')) {
        const id = permissionRequestId++;
        pendingPermission.set(id, { promptId: message.id });
        send({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: {
              toolCallId: 'fixture-tool',
              title: 'Fixture edit',
              kind: 'edit',
              status: 'pending',
              locations: [{ path: process.cwd() }],
            },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
      break;
    }
  }
});
