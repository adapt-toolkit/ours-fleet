import { createInterface } from 'node:readline';

const sessionId = 'fixture-session';
let permissionRequestId = 10_000;
const pendingPermission = new Map();
let activePromptId;
// A "stubborn" prompt ignores session/cancel entirely: the adapter-misbehavior
// case the client's cancel-escalation grace period exists for.
const stubbornPrompts = new Set();
// A "late" prompt emits updates AFTER session/cancel, before its cancelled
// response — the valid late-update window ACP clients must accept.
const latePrompts = new Set();
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
const PROMPT_DELAY_MS = parseInt(process.env.ACP_FIXTURE_PROMPT_DELAY_MS ?? '0', 10) || 0;
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
  if (activePromptId === id) activePromptId = undefined;
  if (EXIT_AFTER && ++promptsAnswered >= EXIT_AFTER)
    setTimeout(() => process.exit(EXIT_CODE), 20);   // let the reply flush first
};

const update = value => send({
  jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
});

// The full standard-update repertoire, exercised by a "rich" prompt: user echo,
// messageId'd chunks, thoughts, plans, a rich tool lifecycle, usage, and the
// session-level updates. Order mirrors what maintained adapters actually emit.
const emitRichTurn = text => {
  update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, messageId: 'user-1' });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning the answer' } });
  update({
    sessionUpdate: 'plan',
    entries: [
      { content: 'inspect input', priority: 'high', status: 'completed' },
      { content: 'answer', priority: 'medium', status: 'in_progress' },
    ],
  });
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'rich-tool',
    title: 'Apply fixture edit',
    kind: 'edit',
    status: 'in_progress',
    locations: [{ path: `${process.cwd()}/a.txt`, line: 3 }],
    rawInput: { path: 'a.txt' },
    content: [{ type: 'content', content: { type: 'text', text: 'reading a.txt' } }],
    _meta: { fixture: { stage: 'start' } },
  });
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'rich-tool',
    status: 'completed',
    rawOutput: { ok: true },
    content: [
      { type: 'diff', path: `${process.cwd()}/a.txt`, oldText: 'old', newText: 'new' },
      { type: 'terminal', terminalId: 'rich-term' },
    ],
  });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' }, messageId: 'msg-1' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'message' }, messageId: 'msg-1' });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second message' }, messageId: 'msg-2' });
  update({ sessionUpdate: 'usage_update', used: 1_200, size: 200_000, cost: { amount: 0.02, currency: 'USD' } });
  update({ sessionUpdate: 'session_info_update', title: 'Rich fixture session' });
  update({ sessionUpdate: 'available_commands_update', availableCommands: [
    { name: 'fixture_command', description: 'A fixture command', input: { hint: 'topic' } },
  ] });
  update({ sessionUpdate: 'current_mode_update', currentModeId: 'fixture-mode' });
  update({ sessionUpdate: 'config_option_update', configOptions: [
    { id: 'model', name: 'Model', value: 'fixture' },
  ] });
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
    if (selected === 'cancelled') {
      outstanding.delete(pending.promptId);
      return;
    }
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
            loadSession: process.env.ACP_FIXTURE_LOAD_SESSION === '1',
            sessionCapabilities: { close: {} },
          },
          _meta: { steering: { supported: true } },
        },
      });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      break;
    case 'session/load':
      // ACP `session/load` replays prior history as ordinary updates BEFORE the
      // response — the dedupe-on-replay case a durable transcript must survive.
      if (process.env.ACP_FIXTURE_REPLAY === '1') {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed question' }, messageId: 'replay-user-1' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' }, messageId: 'replay-msg-1' });
      }
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    case 'session/close':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    // Echo the mode as an update BEFORE answering, so a test can observe which
    // modeId actually arrived. ACP_FIXTURE_SET_MODE_FAIL=1 refuses instead.
    case 'session/set_mode':
      if (process.env.ACP_FIXTURE_SET_MODE_FAIL === '1') {
        send({ jsonrpc: '2.0', id: message.id,
          error: { code: -32602, message: 'mode unavailable' } });
        break;
      }
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `mode:${message.params.modeId}` },
          },
        },
      });
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
      activePromptId = message.id;
      if (/\bstubborn\b/i.test(text)) stubbornPrompts.add(message.id);
      const slow = /\bblock(?:\s+(\d+))?\b/i.exec(text);
      if (PROMPT_DELAY_MS > 0) {
        setTimeout(() => answerPrompt(message.id, stopReasonFor(text)), PROMPT_DELAY_MS);
      } else if (slow) {
        // A turn that stays running for a while: the "busy agent" case. It
        // releases itself so the test never depends on a second prompt getting
        // through — prompts are serialized, so one never could.
        setTimeout(() => answerPrompt(message.id, 'end_turn'), Number(slow[1] ?? 800));
      } else if (/\brich\b/i.test(text)) {
        emitRichTurn(text);
        answerPrompt(message.id, stopReasonFor(text));
      } else if (/\blate\b/i.test(text)) {
        // Start a tool, then wait: only session/cancel releases this prompt,
        // and the cancel path emits the late updates first.
        latePrompts.add(message.id);
        update({ sessionUpdate: 'tool_call', toolCallId: 'late-tool', title: 'Late fixture tool', kind: 'execute', status: 'in_progress' });
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
    case '_session/steering': {
      const text = message.params.prompt.find(block => block.type === 'text')?.text ?? '';
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `steer:${text}` },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { outcome: activePromptId ? 'injected' : 'startedNewTurn' },
      });
      break;
    }
    case 'session/cancel':
      if (activePromptId !== undefined && !stubbornPrompts.has(activePromptId)) {
        // A "late" prompt keeps producing valid updates between the cancel
        // notification and the terminal response — ACP requires clients to
        // accept them, so the fixture exercises that window explicitly.
        if (latePrompts.has(activePromptId)) {
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'late-tool', status: 'completed' });
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late tail' }, messageId: 'late-msg-1' });
        }
        send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'cancelled' } });
        activePromptId = undefined;
      }
      break;
  }
});
