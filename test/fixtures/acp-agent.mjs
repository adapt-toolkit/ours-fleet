import { createInterface } from 'node:readline';

const sessionId = 'fixture-session';
let permissionRequestId = 10_000;
const pendingPermission = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');

// Terminal-outcome modes. A prompt's own text picks one ("refuse …"/"cancel …");
// ACP_FIXTURE_STOP_REASON forces one for EVERY prompt, which is how the runner
// tests exercise a refused startup prompt whose text they do not control.
const FORCED_STOP_REASON = process.env.ACP_FIXTURE_STOP_REASON;
// Exit the agent process after this many prompts (0 = never), so a runner test
// can let a normal session finish instead of blocking forever.
const EXIT_AFTER = parseInt(process.env.ACP_FIXTURE_EXIT_AFTER ?? '0', 10) || 0;
let promptsAnswered = 0;

const stopReasonFor = text =>
  FORCED_STOP_REASON ??
  (/\brefuse\b/i.test(text) ? 'refusal' : /\bcancel\b/i.test(text) ? 'cancelled' : 'end_turn');

const answerPrompt = (id, stopReason) => {
  send({ jsonrpc: '2.0', id, result: { stopReason } });
  if (EXIT_AFTER && ++promptsAnswered >= EXIT_AFTER)
    setTimeout(() => process.exit(0), 20);   // let the reply flush first
};

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
    answerPrompt(pending.promptId, FORCED_STOP_REASON ?? 'end_turn');
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
        answerPrompt(message.id, stopReasonFor(text));
      }
      break;
    }
  }
});
