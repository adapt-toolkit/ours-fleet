import { describe, expect, it, vi } from 'vitest';
import { AgentConversationRelay } from '../src/agent-conversation-control.js';
import type { AcpBodyBrainProvider } from '../src/session/acp-body-brain-transport.js';

function fixture(onStart?: (emit: (value: unknown) => void) => void) {
  let listener: ((value: unknown) => void) | undefined;
  const subscribe = vi.fn((next: (value: unknown) => void) => { listener = next; return vi.fn(); });
  const provider: AcpBodyBrainProvider = { subscribe,
    start: vi.fn(async () => { onStart?.(value => listener?.(value));
      return { state: 'accepted' as const, sessionMetadata: { schemaVersion: 1 as const,
        token: 'session', digest: `sha256:${'a'.repeat(64)}` } }; }),
    restore: vi.fn(), submit: vi.fn(async () => ({ state: 'accepted' as const })),
    respondPermission: vi.fn(async () => ({ state: 'accepted' as const })),
    cancel: vi.fn(async () => ({ state: 'accepted' as const })),
    forceTerminate: vi.fn(async () => ({ state: 'accepted' as const })),
    close: vi.fn(async () => ({ state: 'accepted' as const })),
    retire: vi.fn(async () => ({ state: 'accepted' as const })), cleanup: vi.fn(async () => undefined) };
  const relay = new AgentConversationRelay({ agentId: 'a', generation: 1,
    runtimeInstanceKey: 'runtime', providerRuntimeId: 'provider' }, 'codex-acp', provider);
  return { relay, provider, subscribe, emit: (value: unknown) => listener?.(value) };
}
const started = (seq = 1) => ({ protocolVersion: 1, generation: 'g1', transportSeq: seq,
  notificationId: `n${seq}`, kind: 'started' });

describe('AgentConversationRelay', () => {
  it('subscribes through TransportBoundary before start and atomically drains validated deliveries', async () => {
    const f = fixture(emit => emit(started()));
    await expect(f.relay.start({ protocolVersion: 1, generation: 'g1',
      planDigest: `sha256:${'b'.repeat(64)}` })).resolves.toMatchObject({ state: 'accepted' });
    expect(f.subscribe).toHaveBeenCalledOnce();
    const endpoint = f.relay.issue(); const authenticated = f.relay.authenticate(endpoint)!; const seen: unknown[] = [];
    authenticated.subscribe(delivery => seen.push(delivery));
    f.emit({ protocolVersion: 1, generation: 'g1', transportSeq: 2,
      notificationId: 'n2', kind: 'completed', promptId: 'p', outcome: 'completed' });
    expect(seen).toEqual([{ state: 'notification', notification: started() }, {
      state: 'notification', notification: expect.objectContaining({ kind: 'completed', transportSeq: 2 }) }]);
    expect(f.subscribe).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'wrong generation', value: { ...started(), generation: 'g2' } },
    { name: 'sequence gap', value: started(2) },
    { name: 'raw malformed', value: { generation: 'g1', kind: 'started' } },
  ])('fails closed before buffering $name', async ({ value }) => {
    const f = fixture(emit => emit(value));
    await f.relay.start({ protocolVersion: 1, generation: 'g1', planDigest: `sha256:${'b'.repeat(64)}` });
    expect(() => f.relay.issue()).toThrow(/unavailable/u);
    await vi.waitFor(() => expect(f.provider.cleanup).toHaveBeenCalledOnce());
  });

  it('cleans deterministically on terminal-before-claim and receiver failure', async () => {
    const terminal = fixture(emit => emit({ protocolVersion: 1, generation: 'g1', transportSeq: 1,
      notificationId: 'exit', kind: 'exited', code: 'lost' }));
    await terminal.relay.start({ protocolVersion: 1, generation: 'g1', planDigest: `sha256:${'b'.repeat(64)}` });
    expect(() => terminal.relay.issue()).toThrow();
    await vi.waitFor(() => expect(terminal.provider.cleanup).toHaveBeenCalledOnce());
    const live = fixture(); await live.relay.start({ protocolVersion: 1, generation: 'g1',
      planDigest: `sha256:${'b'.repeat(64)}` });
    live.relay.authenticate(live.relay.issue())!.subscribe(() => { throw new Error('receiver failed'); });
    live.emit(started()); await vi.waitFor(() => expect(live.provider.cleanup).toHaveBeenCalledOnce());
  });

  it('rejects copied, foreign and second-consumer endpoints', async () => {
    const left = fixture(); const right = fixture(); await left.relay.start({ protocolVersion: 1,
      generation: 'g1', planDigest: `sha256:${'b'.repeat(64)}` });
    const endpoint = left.relay.issue(); expect(right.relay.authenticate(endpoint)).toBeUndefined();
    expect(left.relay.authenticate({ ...endpoint } as never)).toBeUndefined();
    left.relay.authenticate(endpoint)!.subscribe(() => undefined);
    expect(() => left.relay.issue()).toThrow(/unavailable/u);
  });
});
