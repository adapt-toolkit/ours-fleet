import { createInterface } from 'node:readline';
const mode = process.env.STALL_FIXTURE_MODE ?? 'normal';
let active;
let permission;
const sid = 'stall-fixture-session';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const answer = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: value } });
const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const tool = (status, id = 'mutation') => update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'private tool body SECRET', kind: 'execute', status });
const retry = () => update({ sessionUpdate: 'session_info_update', _meta: { codex: { error: {
  turnId: 'native-turn-1', willRetry: true, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
  message: 'websocket idle timeout SECRET /private/workspace',
} } } });
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') answer(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, ...(mode === 'steering' ? { _meta: { steering: { supported: true } } } : {}) });
  else if (msg.method === 'session/new' || msg.method === 'session/load') answer(msg.id, { sessionId: sid });
  else if (msg.method === 'session/prompt') {
    active = msg.id;
    const prompt = msg.params.prompt.find(block => block.type === 'text').text;
    if (prompt.startsWith('This is a diagnostic interruption.')) {
      if (mode === 'recovery-silent') return;
      text('Recorded actions checked; no mutation replayed.');
      if (mode === 'recovery-stall') return;
      answer(active, { stopReason: mode === 'recovery-refused' ? 'refusal' : 'end_turn' }); active = undefined;
    } else if (prompt === 'wake') { text('wake handled'); answer(active, { stopReason: 'end_turn' }); active = undefined; }
    else {
      if (mode === 'silent') return;
      text('Initial meaningful progress SECRET');
      if (mode === 'tool' || mode === 'permission') tool('in_progress');
      else { tool('in_progress'); tool('completed'); }
      if (mode === 'permission') {
        permission = 'permission-request';
        send({ jsonrpc: '2.0', id: permission, method: 'session/request_permission', params: {
          sessionId: sid, toolCall: { toolCallId: 'mutation', title: 'private permission SECRET', kind: 'execute', status: 'pending' },
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
        } });
      }
      if (mode === 'modal') update({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active', activeFlags: ['waitingOnUserInput'] } } } });
      retry(); retry();
    }
  } else if (msg.method === 'session/cancel') {
    if (mode === 'ignore-cancel') return;
    if (mode === 'cancel-error' && active !== undefined) {
      send({ jsonrpc: '2.0', id: active, error: { code: -32000, message: 'cancel RPC error SECRET' } });
      active = undefined; return;
    }
    if (mode === 'cancel-refused' && active !== undefined) {
      answer(active, { stopReason: 'refusal' }); active = undefined; return;
    }
    if (active !== undefined) { answer(active, { stopReason: 'cancelled' }); active = undefined; }
  } else if (msg.method && msg.id !== undefined) answer(msg.id, {});
});
