import { describe, expect, it, vi } from 'vitest';
import { AgentLaunchCompositionRoot } from '../src/agent-launch-composition-root.js';
import { readStoredAgentPlan } from '../src/agent-plan-store.js';

vi.mock('../src/agent-plan-store.js', () => ({ readStoredAgentPlan: vi.fn() }));

const session = { name: 'agent-1', cwd: '/work', stateDir: '/state', mode: 'fresh' as const,
  permissions: { approval: 'allow' as const, filesystem: 'workspace' as const, unattended: 'deny' as const },
  log: vi.fn() };
describe('AgentLaunchCompositionRoot', () => {
  it('routes permanent launch only through the internal completed-generation seam', async () => {
    const handle = {}; const startSession = vi.fn(async () => handle);
    const root = new AgentLaunchCompositionRoot({ rehydrate: vi.fn(() => ({ startSession })) } as never,
      {} as never, {} as never);
    await expect(root.launch({ agentId: 'a', lifetime: 'persistent', session })).resolves.toBe(handle);
    expect(startSession).toHaveBeenCalledWith(session);
  });
  it('fails before temporary Brain effects when opaque prelaunch authentication is absent', async () => {
    const start = vi.fn(); const root = new AgentLaunchCompositionRoot({} as never,
      { rehydrate: () => ({}), authenticate: () => undefined } as never, { start });
    await expect(root.launch({ agentId: 'a', lifetime: 'temporary', session })).rejects.toThrow(/prelaunch/u);
    expect(start).not.toHaveBeenCalled();
  });
  it('starts temporary Brain from exact stored plan with no identity authority', async () => {
    const bindings = { agentId: 'a', generation: 1, actionId: 'action', planDigest: `sha256:${'a'.repeat(64)}`,
      snapshotDigest: `sha256:${'b'.repeat(64)}`, reservationDigest: `sha256:${'c'.repeat(64)}`,
      canonicalDir: '/trusted/candidate', authorizationRevision: 'auth', lifetime: 'temporary' as const,
      identityLifecycle: 'connector_session_owned' as const, completion: 'deferred' as const };
    const plan = { agentId: 'a', generation: 1, operation: { id: 'action' }, planDigest: bindings.planDigest,
      snapshotDigest: bindings.snapshotDigest, authorizationRevision: 'auth', lifecycle: 'temporary',
      identity: { ownership: 'create_temporary' }, brain: {}, permissions: {} };
    vi.mocked(readStoredAgentPlan).mockReturnValue({ plan } as never);
    const start = vi.fn(async () => ({} as never)); const root = new AgentLaunchCompositionRoot({} as never,
      { rehydrate: () => ({}), authenticate: () => bindings } as never, { start });
    await root.launch({ agentId: 'a', lifetime: 'temporary', session });
    expect(start).toHaveBeenCalledWith({ reservation: bindings, plan, session });
    expect(Object.keys(start.mock.calls[0]![0]).sort()).toEqual(['plan', 'reservation', 'session']);
  });
});
