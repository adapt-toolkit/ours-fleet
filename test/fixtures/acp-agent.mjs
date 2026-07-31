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
const EXIT_CODE = parseInt(process.env.ACP_FIXTURE_EXIT_CODE ?? '0', 10) || 0;
// Request a tool permission on EVERY prompt, including ones whose text the test
// does not control (the runner's own startup prompt).
const ALWAYS_PERMISSION = process.env.ACP_FIXTURE_ALWAYS_PERMISSION === '1';
let promptsAnswered = 0;

const stopReasonFor = text =>
  FORCED_STOP_REASON ??
  (/\brefuse\b/i.test(text) ? 'refusal' : /\bcancel\b/i.test(text) ? 'cancelled' : 'end_turn');

/** promptId -> permission requests still awaiting a decision. */
const outstanding = new Map();

/** Ask for the same tool, offering both reject kinds so selection order matters. */
const requestPermission = promptId => {
  const id = permissionRequestId++;
  pendingPermission.set(id, { promptId });
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
        { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    },
  });
};

const answerPrompt = (id, stopReason) => {
  send({ jsonrpc: '2.0', id, result: { stopReason } });
  if (EXIT_AFTER && ++promptsAnswered >= EXIT_AFTER)
    setTimeout(() => process.exit(EXIT_CODE), 20);   // let the reply flush first
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
    // A prompt may have several outstanding requests; answer it once they settle.
    const left = (outstanding.get(pending.promptId) ?? 1) - 1;
    outstanding.set(pending.promptId, left);
    if (left > 0) return;
    outstanding.delete(pending.promptId);
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
      const slow = /\bblock(?:\s+(\d+))?\b/i.exec(text);
      if (slow) {
        // A turn that stays running for a while: the "busy agent" case. It
        // releases itself so the test never depends on a second prompt getting
        // through — prompts are serialized, so one never could.
        setTimeout(() => answerPrompt(message.id, 'end_turn'), Number(slow[1] ?? 800));
      } else if (ALWAYS_PERMISSION || text.includes('permission')) {
        // "twice" asks for the SAME tool two times in one turn, so a test can
        // check that each request is decided independently.
        const times = /\btwice\b/i.test(text) ? 2 : 1;
        outstanding.set(message.id, times);
        for (let i = 0; i < times; i++) requestPermission(message.id);
      } else {
        answerPrompt(message.id, stopReasonFor(text));
      }
      break;
    }
  }
});
