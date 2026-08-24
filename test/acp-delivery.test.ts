import { describe, expect, it } from 'vitest';

import { AcpSession } from '../src/session/acp.js';

interface FakeAgent {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
}

function fakeSession(agent: FakeAgent, overrides: Record<string, unknown> = {}): AcpSession {
  const session = Object.create(AcpSession.prototype) as AcpSession;
  Object.assign(session as unknown as Record<string, unknown>, {
    options: { name: 'A', afterToolBoundaryTimeoutMs: 20 },
    child: { exitCode: null, killed: false },
    connection: { agent },
    sessionId: 'session-1',
    readiness: 'running',
    lastError: undefined,
    promptTail: Promise.resolve(),
    queueDepth: 0,
    steeringSupported: true,
    closing: false,
    pendingPermissions: new Map(),
    activeToolCalls: new Map(),
    toolBoundaryWaiters: new Set(),
    events: { emit: () => {} },
    sessionGeneration: 'gen-test',
    conversation: {
      append: (draft: unknown) => draft,
      appendSafe: () => undefined,
      receiptFor: () => undefined,
      recordReceipt: () => undefined,
      lastCursor: () => undefined,
      openPrompts: () => [],
      degraded: false,
    },
    ...overrides,
  });
  return session;
}

/** A fleet-tracked turn: one whose settlement `cancelActive` can actually await. */
function trackedTurn(): Record<string, unknown> {
  return { id: 'turn-1', output: '', settled: Promise.resolve(), settle: () => {} };
}

describe('AcpSession live delivery', () => {
  it('uses advertised steering while a prompt is active', async () => {
    const requests: string[] = [];
    const session = fakeSession({
      request: async method => {
        requests.push(method);
        return { outcome: 'injected' };
      },
      notify: async () => {},
    });

    const result = await session.submitPrompt('new mail', { steer: true });

    expect(result).toMatchObject({
      accepted: true, outcome: 'inconclusive', detail: 'injected',
    });
    expect(requests).toEqual(['_session/steering']);
  });

  it('falls back to a normal prompt when the adapter does not advertise steering', async () => {
    const requests: string[] = [];
    const session = fakeSession({
      request: async method => {
        requests.push(method);
        return { stopReason: 'end_turn' };
      },
      notify: async () => {},
    }, { steeringSupported: false });

    const result = await session.submitPrompt('new mail', { steer: true });

    expect(result).toMatchObject({ accepted: true, outcome: 'completed' });
    expect(requests).toEqual(['session/prompt']);
  });

  it('degrades after_tool to non-cancelling queued delivery without steering support', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      request: async method => {
        calls.push(method);
        return { stopReason: 'end_turn' };
      },
      notify: async method => { calls.push(method); },
    }, { steeringSupported: false });

    const result = await session.submitPromptAfterTool('compatible wake', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });

    expect(result).toMatchObject({
      accepted: true, outcome: 'completed',
      safeBoundary: { state: 'unsupported', activeToolCount: 0 },
    });
    expect(calls).toEqual(['session/prompt']);
  });

  it('queues one direct after_tool wake when the advertised steering path rejects it', async () => {
    const calls: string[] = [];
    let finishActive!: () => void;
    const active = new Promise<void>(resolve => { finishActive = resolve; });
    const session = fakeSession({
      request: async method => {
        calls.push(method);
        return method === '_session/steering'
          ? { outcome: 'failed' }
          : { stopReason: 'end_turn' };
      },
      notify: async () => {},
    }, { promptTail: active, queueDepth: 1 });

    const wake = session.submitPromptAfterTool('direct fallback', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    // One failed steering request waits behind the active turn; it does not
    // spin and resubmit the same monitor cursor.
    expect(calls).toEqual(['_session/steering']);
    finishActive();
    const result = await wake;

    expect(result).toMatchObject({
      accepted: true, outcome: 'completed',
      detail: 'steering rejected; queued delivery end_turn',
      safeBoundary: { state: 'direct', activeToolCount: 0 },
    });
    expect(calls).toEqual(['_session/steering', 'session/prompt']);
  });

  it('queues one wake after a real tool boundary when steering then rejects it', async () => {
    const calls: string[] = [];
    const statuses: string[] = [];
    let finishActive!: () => void;
    const active = new Promise<void>(resolve => { finishActive = resolve; });
    const session = fakeSession({
      request: async method => {
        calls.push(method);
        return method === '_session/steering'
          ? { outcome: 'failed' }
          : { stopReason: 'end_turn' };
      },
      notify: async () => {},
    }, {
      activeToolCalls: new Map([['tool-1', { lifecycle: true, permissions: new Map() }]]),
      promptTail: active,
      queueDepth: 1,
      events: { emit: (kind: string, event: { status?: string }) => {
        if (kind === 'monitor_delivery' && event.status) statuses.push(event.status);
      } },
    });
    const wake = session.submitPromptAfterTool('boundary fallback', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });
    setTimeout(() => {
      (session as unknown as { releaseTool(id: string): void }).releaseTool('tool-1');
    }, 0);
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(statuses).toEqual(['deferred', 'after_tool']);
    expect(calls).toEqual(['_session/steering']);
    finishActive();

    const result = await wake;

    expect(result).toMatchObject({
      accepted: true, outcome: 'completed',
      detail: 'steering rejected; queued delivery end_turn',
      safeBoundary: { state: 'after_tool', activeToolCount: 0 },
    });
    expect(calls).toEqual(['_session/steering', 'session/prompt']);
  });

  it('keeps a rejected queued wake unsuccessful so its monitor cursor can retry', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      request: async method => {
        calls.push(method);
        return method === '_session/steering'
          ? { outcome: 'failed' }
          : { stopReason: 'refusal' };
      },
      notify: async () => {},
    });

    const result = await session.submitPromptAfterTool('refused fallback', {
      origin: { kind: 'fleet-monitor' }, steer: true,
    });

    expect(result).toMatchObject({
      accepted: true, succeeded: false, outcome: 'refused',
      detail: 'steering rejected; queued delivery refusal',
    });
    expect(calls).toEqual(['_session/steering', 'session/prompt']);
  });

  it('cancels the tracked turn first, then acknowledges interrupting delivery', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      notify: async method => {
        calls.push(method);
      },
      request: async method => {
        calls.push(method);
        return { outcome: 'startedNewTurn' };
      },
    }, { activeTurn: trackedTurn() });

    const result = await session.submitPrompt(
      'interrupting mail', { interrupt: true, steer: true });

    expect(result).toMatchObject({
      accepted: true, outcome: 'inconclusive', detail: 'startedNewTurn',
    });
    expect(calls).toEqual(['session/cancel', '_session/steering']);
  });

  it('can deliver another interrupt while the preceding wake turn is still running', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      notify: async method => { calls.push(method); },
      request: async method => {
        calls.push(method);
        return { outcome: 'startedNewTurn' };
      },
    }, { activeTurn: trackedTurn() });

    const first = await session.submitPrompt('first wake', { interrupt: true, steer: true });
    const second = await session.submitPrompt('second wake', { interrupt: true, steer: true });

    expect(first.detail).toBe('startedNewTurn');
    expect(second.detail).toBe('startedNewTurn');
    expect(calls).toEqual([
      'session/cancel', '_session/steering',
      'session/cancel', '_session/steering',
    ]);
  });
});

/**
 * Regression cover for the owner-visible "request failed before completion"
 * (`[ede_diagnostic] ... stop_reason=tool_use` / `stop_reason=null`).
 *
 * An interrupting prompt used to send `session/cancel` unconditionally and then
 * issue `session/prompt` immediately. When the running turn was one the ADAPTER
 * started — steering's `startedNewTurn`, which fleet never tracks — there was no
 * `activeTurn` to await, so the prompt raced the adapter's transcript repair and
 * landed on an unresolved `tool_use`. With nothing running at all the cancel was
 * still sent, and the prompt landed on a bare interrupted user message.
 */
describe('AcpSession interrupting delivery never orphans a tool_use', () => {
  it('does not cancel an untracked adapter turn that is inside a tool call', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      notify: async method => { calls.push(method); },
      request: async method => {
        calls.push(method);
        return { stopReason: 'end_turn' };
      },
    }, {
      steeringSupported: false,
      activeToolCalls: new Map([['tool-1', { lifecycle: true, permissions: new Map() }]]),
    });

    const queued = await session.queuePrompt('owner request', {
      interrupt: true, interruptSource: 'owner', origin: { kind: 'owner', requestId: 'r1' },
    });

    expect(calls).not.toContain('session/cancel');
    expect(queued.delivery).toBe('deferred');
    await expect(queued.completion).resolves.toMatchObject({ outcome: 'completed' });
    expect(calls).toEqual(['session/prompt']);
  });

  it('still cancels a fleet-tracked turn, whose settlement it can await', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      notify: async method => { calls.push(method); },
      request: async method => {
        calls.push(method);
        return { stopReason: 'end_turn' };
      },
    }, {
      steeringSupported: false,
      activeToolCalls: new Map([['tool-1', { lifecycle: true, permissions: new Map() }]]),
      activeTurn: trackedTurn(),
    });

    const queued = await session.queuePrompt('owner request', {
      interrupt: true, interruptSource: 'owner', origin: { kind: 'owner', requestId: 'r1' },
    });

    expect(queued.delivery).toBe('interrupted');
    expect(calls).toEqual(['session/cancel', 'session/prompt']);
  });

  it('does not cancel an idle session', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      notify: async method => { calls.push(method); },
      request: async method => {
        calls.push(method);
        return { stopReason: 'end_turn' };
      },
    }, { steeringSupported: false });

    const queued = await session.queuePrompt('owner request', {
      interrupt: true, interruptSource: 'owner', origin: { kind: 'owner', requestId: 'r1' },
    });

    expect(calls).toEqual(['session/prompt']);
    expect(queued.delivery).toBe('started');
  });

});
