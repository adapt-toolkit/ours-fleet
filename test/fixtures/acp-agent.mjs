import { createInterface } from 'node:readline';

const sessionId = 'fixture-session';
let permissionRequestId = 10_000;
const pendingPermission = new Map();
let activePromptId;
let pendingToolwaitAnswer;
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
if (process.env.ACP_FIXTURE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
let promptsAnswered = 0;
// FLEET-003: model the extension behaviour where `_session/steering` with no
// live turn STARTS one. That turn owns the adapter, is not addressable by a
// JSON-RPC id, and swallows any prompt that arrives while it runs.
const STEERING_OCCUPIES = process.env.ACP_FIXTURE_STEERING_OCCUPIES === '1';
const STEERING_TURN_MS = parseInt(process.env.ACP_FIXTURE_STEERING_TURN_MS ?? '400', 10) || 400;
let steeringTurnActive = false;

const stopReasonFor = text =>
  FORCED_STOP_REASON ??
  (/\brefuse\b/i.test(text) ? 'refusal' : /\bcancel\b/i.test(text) ? 'cancelled' : 'end_turn');

/** promptId -> permission requests still awaiting a decision. */
const outstanding = new Map();
/** promptId -> delay after its last permission resolves, for boundary-race tests. */
const permissionCompletionDelay = new Map();

/** Ask for the same tool, offering both reject kinds so selection order matters. */
const requestPermission = (promptId, location = process.cwd(), shape = 'located-edit') => {
  const id = permissionRequestId++;
  pendingPermission.set(id, { promptId });
  const locationlessExecute = shape !== 'located-edit';
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: 'fixture-tool',
        title: locationlessExecute ? 'Protected MCP approval' : 'Fixture edit',
        kind: locationlessExecute ? 'execute' : 'edit',
        status: 'pending',
        ...(locationlessExecute ? {} : { locations: [{ path: location }] }),
      },
      options: locationlessExecute ? [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
      ] : [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
      ...(shape === 'protected-mcp'
        ? { _meta: { is_mcp_tool_approval: true } }
        : shape === 'malformed-protected-mcp'
          ? { _meta: { is_mcp_tool_approval: 'true' } }
          : {}),
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

// Production-shaped Codex edit event: adapters commonly report an append as
// complete before/after file snapshots. Keep the fixture multi-megabyte so the
// durable ACP path, not only the pure normalizer, proves the historical prefix
// cannot reach web conversation events.
const emitLargeWorklogAppend = () => {
  const oldText = 'HISTORICAL_MARKER ours-mcp start\n' + 'historical-line\n'.repeat(220_000);
  const appended = 'CURRENT_SESSION_APPEND žluťoučký kůň 🧪\nsecond-current-line\n';
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'large-worklog-edit',
    title: 'Edit WORKLOG.md',
    kind: 'edit',
    status: 'completed',
    locations: [{ path: `${process.cwd()}/WORKLOG.md` }],
    content: [{
      type: 'diff', path: `${process.cwd()}/WORKLOG.md`,
      oldText, newText: oldText + appended,
    }],
  });
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
    const delay = permissionCompletionDelay.get(pending.promptId) ?? 0;
    permissionCompletionDelay.delete(pending.promptId);
    if (delay > 0)
      setTimeout(() => answerPrompt(pending.promptId, FORCED_STOP_REASON ?? 'end_turn'), delay);
    else answerPrompt(pending.promptId, FORCED_STOP_REASON ?? 'end_turn');
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
            sessionCapabilities: {
              close: {},
              ...(process.env.ACP_FIXTURE_RESUME_SESSION === '1' ? { resume: {} } : {}),
            },
          },
          _meta: { steering: { supported: true } },
        },
      });
      break;
    case 'session/new':
      if (process.env.ACP_FIXTURE_REQUIRE_MCP_SERVERS === '1'
          && !Array.isArray(message.params?.mcpServers)) {
        send({ jsonrpc: '2.0', id: message.id,
          error: { code: -32602, message: 'Invalid params: mcpServers required' } });
        break;
      }
      // Echo back what the CLIENT actually declared, so a test can assert that
      // per-role MCP servers and the agent-specific `_meta` options reached the
      // wire instead of being dropped on the way to the ACP launch.
      if (process.env.ACP_FIXTURE_ECHO_SESSION_PARAMS === '1') {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `new-params:${JSON.stringify({
              mcpServers: message.params?.mcpServers ?? null,
              _meta: message.params?._meta ?? null,
              disableInheritedMcp:
                process.env.OURS_FLEET_CODEX_DISABLE_INHERITED_MCP ?? null,
            })}`,
          },
          messageId: 'new-params-1',
        });
      }
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      break;
    case 'session/resume':
      if (process.env.ACP_FIXTURE_REQUIRE_MCP_SERVERS === '1'
          && !Array.isArray(message.params?.mcpServers)) {
        send({ jsonrpc: '2.0', id: message.id,
          error: { code: -32602, message: 'Invalid params: mcpServers required' } });
        break;
      }
      if (process.env.ACP_FIXTURE_ECHO_SESSION_PARAMS === '1') {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `resume-params:${JSON.stringify({
            mcpServers: message.params?.mcpServers ?? null,
            disableInheritedMcp:
              process.env.OURS_FLEET_CODEX_DISABLE_INHERITED_MCP ?? null,
          })}` },
          messageId: 'resume-params-1',
        });
      }
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    case 'session/load':
      if (process.env.ACP_FIXTURE_REQUIRE_MCP_SERVERS === '1'
          && !Array.isArray(message.params?.mcpServers)) {
        send({ jsonrpc: '2.0', id: message.id,
          error: { code: -32602, message: 'Invalid params: mcpServers required' } });
        break;
      }
      // ACP `session/load` replays prior history as ordinary updates BEFORE the
      // response — the dedupe-on-replay case a durable transcript must survive.
      if (process.env.ACP_FIXTURE_REPLAY === '1') {
        update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed question' }, messageId: 'replay-user-1' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' }, messageId: 'replay-msg-1' });
      }
      if (process.env.ACP_FIXTURE_ECHO_SESSION_PARAMS === '1') {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `load-params:${JSON.stringify({
            mcpServers: message.params?.mcpServers ?? null,
            disableInheritedMcp:
              process.env.OURS_FLEET_CODEX_DISABLE_INHERITED_MCP ?? null,
          })}` },
          messageId: 'load-params-1',
        });
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
      // FLEET-003 wire shape: while a steering-started turn owns the adapter,
      // an arriving prompt is folded into that turn. It produces updates but
      // NEVER receives a stopReason of its own — the observed production
      // signature of a scheduled run that hangs to its 300 s deadline.
      if (STEERING_OCCUPIES && steeringTurnActive) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `absorbed:${text}` },
        });
        break;
      }
      if (/\bambiguous phase\b/i.test(text)) {
        update({
          sessionUpdate: 'agent_message_chunk', messageId: 'ambiguous-1',
          content: { type: 'text', text: 'Unclassified adapter output' },
          _meta: { codex: { phase: 'future_phase' } },
        });
      } else if (/\bphased\b/i.test(text)) {
        update({
          sessionUpdate: 'agent_message_chunk', messageId: 'commentary-1',
          content: { type: 'text', text: 'Checking the implementation.\n' },
          _meta: { codex: { phase: 'commentary' } },
        });
        update({
          sessionUpdate: 'agent_message_chunk', messageId: 'final-1',
          content: { type: 'text', text: 'Implementation is ready.' },
          _meta: { codex: { phase: 'final_answer' } },
        });
      } else {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `echo:${text}` },
        });
      }
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
      } else if (/\blarge worklog append\b/i.test(text)) {
        emitLargeWorklogAppend();
        answerPrompt(message.id, stopReasonFor(text));
      } else if (/\brich\b/i.test(text)) {
        emitRichTurn(text);
        answerPrompt(message.id, stopReasonFor(text));
      } else if (/\btoolwait(?:\s+(\d+))?\b/i.test(text)) {
        const delay = Number(/\btoolwait(?:\s+(\d+))?\b/i.exec(text)?.[1] ?? 100);
        update({
          sessionUpdate: 'tool_call', toolCallId: 'wait-tool', title: 'Wait fixture tool',
          kind: 'execute', status: 'in_progress',
        });
        setTimeout(() => {
          update({ sessionUpdate: 'tool_call_update', toolCallId: 'wait-tool', status: 'completed' });
          const answer = () => answerPrompt(message.id, stopReasonFor(text));
          pendingToolwaitAnswer = answer;
          setTimeout(() => {
            if (pendingToolwaitAnswer === answer) {
              pendingToolwaitAnswer = null;
              answer();
            }
          }, 5000);
        }, delay);
      } else if (/\blate\b/i.test(text)) {
        // Start a tool, then wait: only session/cancel releases this prompt,
        // and the cancel path emits the late updates first.
        latePrompts.add(message.id);
        update({ sessionUpdate: 'tool_call', toolCallId: 'late-tool', title: 'Late fixture tool', kind: 'execute', status: 'in_progress' });
      } else if (ALWAYS_PERMISSION || text.includes('permission')) {
        // "twice" asks for the SAME tool two times in one turn, so a test can
        // check that each request is decided independently.
        const times = /\btwice\b/i.test(text) ? 2 : 1;
        const completionDelay = /\bpermission linger(?:\s+(\d+))?/i.exec(text);
        if (completionDelay)
          permissionCompletionDelay.set(message.id, Number(completionDelay[1] ?? 100));
        outstanding.set(message.id, times);
        const location = /\bpermission location dangling\b/i.test(text)
          ? `${process.cwd()}/dangling.txt`
          : /\bpermission location escape\b/i.test(text)
          ? `${process.cwd()}/escape/new.txt`
          : /\bpermission location missing\b/i.test(text)
            ? `${process.cwd()}/new/deep/file.txt`
            : /\bpermission location loop\b/i.test(text)
              ? `${process.cwd()}/loop/file.txt`
              : /\bpermission location swap\b/i.test(text)
                ? `${process.cwd()}/swap/file.txt` : process.cwd();
        const shape = /\bpermission protected mcp malformed\b/i.test(text)
          ? 'malformed-protected-mcp'
          : /\bpermission protected mcp\b/i.test(text)
            ? 'protected-mcp'
            : /\bpermission locationless execute\b/i.test(text)
              ? 'locationless-execute'
              : 'located-edit';
        for (let i = 0; i < times; i++) requestPermission(message.id, location, shape);
      } else {
        answerPrompt(message.id, stopReasonFor(text));
      }
      break;
    }
    case '_session/steering': {
      const text = message.params.prompt.find(block => block.type === 'text')?.text ?? '';
      // A steered wake that starts its own turn and runs a tool in it. Fleet
      // never gets a session/prompt response for this turn, so `readiness`
      // cannot see it (FLEET-002) — only the tool/update stream can.
      if (/\bsteer tool\b/i.test(text))
        update({
          sessionUpdate: 'tool_call', toolCallId: 'steer-tool', title: 'Steered fixture tool',
          kind: 'execute', status: 'in_progress',
        });
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
      const startedNewTurn = !activePromptId;
      // A steering call that starts a turn really occupies the adapter, and
      // that turn has no JSON-RPC id, so its end is never reported as a
      // stopReason. It keeps emitting updates until it finishes on its own.
      if (STEERING_OCCUPIES && startedNewTurn) {
        steeringTurnActive = true;
        const beat = setInterval(() => update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'steer-work' },
        }), Math.max(10, Math.floor(STEERING_TURN_MS / 4)));
        beat.unref?.();
        setTimeout(() => { clearInterval(beat); steeringTurnActive = false; }, STEERING_TURN_MS)
          .unref?.();
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { outcome: startedNewTurn ? 'startedNewTurn' : 'injected' },
      });
      if (pendingToolwaitAnswer) {
        const answer = pendingToolwaitAnswer;
        pendingToolwaitAnswer = null;
        setTimeout(() => answer(), 5);
      }
      break;
    }
    case 'session/cancel':
      // Cancelling reaches the steering-started turn. The absorbed prompt has
      // no turn of its own to end, so it stays unanswered — this is why the
      // client's settlement deadline expires and escalates to SIGTERM.
      if (STEERING_OCCUPIES && steeringTurnActive) {
        steeringTurnActive = false;
        break;
      }
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
