import { describe, expect, it } from 'vitest';

import { AcpSession } from '../src/session/acp.js';

interface FakeAgent {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
}

function fakeSession(agent: FakeAgent, overrides: Record<string, unknown> = {}): AcpSession {
  const session = Object.create(AcpSession.prototype) as AcpSession;
  Object.assign(session as unknown as Record<string, unknown>, {
    options: { name: 'A' },
    child: { exitCode: null, killed: false },
    connection: { agent },
    sessionId: 'session-1',
    readiness: 'running',
    lastError: undefined,
    promptTail: Promise.resolve(),
    steeringSupported: true,
    pendingPermissions: new Map(),
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

  it('cancels first, then acknowledges interrupting delivery when its turn starts', async () => {
    const calls: string[] = [];
    const session = fakeSession({
      notify: async method => {
        calls.push(method);
      },
      request: async method => {
        calls.push(method);
        return { outcome: 'startedNewTurn' };
      },
    });

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
    });

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
