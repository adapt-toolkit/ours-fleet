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

  it('cancels first, then starts interrupting delivery as a normal prompt', async () => {
    const calls: string[] = [];
    let releaseActive!: () => void;
    const active = new Promise<void>(resolve => { releaseActive = resolve; });
    const session = fakeSession({
      notify: async method => {
        calls.push(method);
        releaseActive();
      },
      request: async method => {
        calls.push(method);
        return { stopReason: 'end_turn' };
      },
    }, { promptTail: active });

    const result = await session.submitPrompt('interrupting mail', { interrupt: true });

    expect(result).toMatchObject({ accepted: true, outcome: 'completed' });
    expect(calls).toEqual(['session/cancel', 'session/prompt']);
  });
});
