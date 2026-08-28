import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { RoleCreationService } from '../src/application/role-creation-service.js';
import { findRole, loadConfig } from '../src/config.js';
import type { OpsDeps } from '../src/ops.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';
import '../src/harness/codex.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'role-creation-service-'));
  process.env.OURS_FLEET_HOME = root;
  writeFileSync(join(root, 'fleet.yaml'), stringify({ defaults: { harness: 'codex' }, roles: { Coord: {} } }));
});
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(root, { recursive: true, force: true }); });

const backend = (): SupervisorBackend => ({
  id: 'none', async init() { return []; }, async install() { return { created: true, detail: 'ok' }; },
  async start() {}, async stop() {}, async restart() {}, async status() { return 'inactive'; },
  async uninstall() { return { removed: true, detail: 'ok' }; },
  async liveness() { return { state: 'stopped', detail: 'inactive' }; },
  logsArgs: name => ({ cmd: 'true', args: [name] }),
});
const options = (create: ReturnType<typeof vi.fn>) => ({
  ops: { backend: backend(), binPath: '/bin/ours-fleet', log: () => {}, sleep: async () => {},
    identityProvisioner: { exists: async () => { throw new Error('legacy identity path'); } } } as OpsDeps,
  binPath: '/bin/ours-fleet', journal: false,
  permanentAgentCreation: create,
});
const completed = (input: { plan: { options: { name: string; identity?: string } }; actionId: string }) =>
  ({ state: 'complete' as const, reservation: {} as never,
    locator: { kind: 'AgentStartLocator', agentId: input.plan.options.name,
      actionId: input.actionId } as never, identityAcquisition: 'external' as const,
    identityName: input.plan.options.identity ?? input.plan.options.name });
const temporaryRuntime = { create: async (input: { plan: { options: { name: string } }; actionId: string }) =>
  ({ state: 'reserved' as const, agentId: input.plan.options.name, generation: 1,
    actionId: input.actionId, lifetime: 'temporary' as const, completion: 'deferred' as const }) };

describe('RoleCreationService permanent Agent ingress', () => {
  it('binds direct creation to a generated action and direct-origin plan', async () => {
    const create = vi.fn(async input => completed(input));
    const service = new RoleCreationService(options(create));
    await service.createDirect({ name: 'Direct', harness: 'codex', session: 'acp' });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({ plan: { origin: 'direct' } });
    expect(create.mock.calls[0]![0].actionId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('preserves the authenticated managed caller in the plan passed to composition', async () => {
    const create = vi.fn(async input => completed(input));
    const service = new RoleCreationService(options(create));
    const caller = findRole(loadConfig(), 'Coord')!;
    await service.createManaged(caller, { name: 'Managed', harness: 'codex', session: 'acp' });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({ plan: { origin: 'managed', caller: 'Coord' } });
  });

  it('gives the bridge an owned frozen plan that cannot mutate spawn-critical options', async () => {
    let mutationRejected = false;
    const create = vi.fn(async input => {
      try { (input.plan.options as { name: string }).name = 'Substituted'; }
      catch { mutationRejected = true; }
      return completed(input);
    });
    const service = new RoleCreationService(options(create));
    await service.createDirect({ name: 'Immutable', harness: 'codex', session: 'acp' });
    expect(mutationRejected).toBe(true);
    expect(findRole(loadConfig(), 'Immutable')?.name).toBe('Immutable');
    expect(() => findRole(loadConfig(), 'Substituted')).toThrow(/no such role/u);
  });

  it('owns assembly-object direct and managed ingress, request, caller evidence, and action binding', async () => {
    const directEvidence = Object.freeze({ direct: true });
    const managedEvidence = Object.freeze({ managed: true });
    const direct = vi.fn(() => directEvidence as never);
    const managed = vi.fn((_caller: string) => managedEvidence as never);
    const context = vi.fn(() => ({ marker: 'context' }) as never);
    const foreignEvidence = Object.freeze({ foreign: true });
    const request = vi.fn(input => ({ callerEvidence: foreignEvidence, source: {
      agentId: input.plan.options.name,
      identityName: input.plan.options.identity ?? input.plan.options.name } }) as never);
    const createPermanent = vi.fn(async (value: { callerEvidence: unknown; source: {
      agentId: string; identityName: string } }, actionId: string) => ({ state: 'complete' as const,
      reservation: {} as never, locator: { kind: 'AgentStartLocator', agentId: value.source.agentId,
        actionId } as never, identityAcquisition: 'external' as const,
      identityName: value.source.identityName }));
    const assemblyBridge = { assembly: { ingress: { direct, managed },
      root: { createPermanent } } as never, context, request };
    const base = options(vi.fn());
    const service = new RoleCreationService({ ...base, permanentAgentCreation: assemblyBridge });
    await service.createDirect({ name: 'AssemblyDirect', session: 'acp' });
    await service.createManaged(findRole(loadConfig(), 'Coord')!, { name: 'AssemblyManaged', session: 'acp' });
    expect(direct).toHaveBeenCalledOnce();
    expect(managed).toHaveBeenCalledWith('Coord', expect.anything());
    expect(createPermanent.mock.calls[0]![0].callerEvidence).toBe(directEvidence);
    expect(createPermanent.mock.calls[1]![0].callerEvidence).toBe(managedEvidence);
    expect(createPermanent.mock.calls.flatMap(call => [call[0].callerEvidence])).not.toContain(foreignEvidence);
    expect(createPermanent.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(request.mock.calls[0]![0].plan).toBe(context.mock.calls[0]![0].plan);
    expect(Object.isFrozen(request.mock.calls[0]![0].plan.options)).toBe(true);
  });

  it('never invokes permanent composition for temporary direct creation', async () => {
    const create = vi.fn(async input => completed(input));
    const service = new RoleCreationService({ ...options(create), tempLauncher() {},
      agentProductionRuntime: temporaryRuntime });
    await service.createDirect({ name: 'Temporary', temp: true, harness: 'codex', session: 'acp' });
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps permanent tmux direct and managed creation on the explicit legacy fallback', async () => {
    const directHook = vi.fn(async input => completed(input)); const directOptions = options(directHook);
    directOptions.ops.identityProvisioner = { exists: async () => true };
    const direct = new RoleCreationService(directOptions);
    await direct.createDirect({ name: 'DirectTmux', harness: 'codex', session: 'tmux' });
    expect(directHook).not.toHaveBeenCalled();

    const managedHook = vi.fn(async input => completed(input)); const managedOptions = options(managedHook);
    managedOptions.ops.identityProvisioner = { exists: async () => true };
    const managed = new RoleCreationService(managedOptions);
    await managed.createManaged(findRole(loadConfig(), 'Coord')!, {
      name: 'ManagedTmux', harness: 'codex', session: 'tmux',
    });
    expect(managedHook).not.toHaveBeenCalled();
  });

  it('invokes composition once for web permanent ACP and zero times for web temporary ACP', async () => {
    const request = (name: string, lifetime: 'permanent' | 'temporary') => ({ name,
      harness: 'codex' as const, session: 'acp' as const, lifetime, openAfterCreate: false,
      permissions: { approval: 'ask' as const, filesystem: 'workspace' as const, unattended: 'deny' as const } });
    const permanentHook = vi.fn(async input => completed(input)); const permanentOptions = options(permanentHook);
    const permanent = new RoleCreationService({ ...permanentOptions,
      identityProvisioner: { exists: async () => false }, probeReady: async () => 'ready' });
    const permanentRequest = request('WebPermanent', 'permanent');
    const preview = await permanent.preview(permanentRequest);
    const action = await permanent.create(permanentRequest, preview.previewHash,
      'abcdef0123456789abcdef0123456789', 'browser-permanent');
    await vi.waitFor(() => expect(permanent.get(action.actionId)?.state).toBe('session_reachable'));
    expect(permanentHook).toHaveBeenCalledOnce();
    expect(permanentHook.mock.calls[0]![0]).toMatchObject({ plan: { origin: 'direct' } });

    const temporaryHook = vi.fn(async input => completed(input)); const temporaryOptions = options(temporaryHook);
    const temporary = new RoleCreationService({ ...temporaryOptions, tempLauncher() {},
      agentProductionRuntime: temporaryRuntime,
      identityProvisioner: { exists: async () => false }, probeReady: async () => 'ready' });
    const temporaryRequest = request('WebTemporary', 'temporary');
    const tempPreview = await temporary.preview(temporaryRequest);
    const tempAction = await temporary.create(temporaryRequest, tempPreview.previewHash,
      '0123456789abcdef0123456789abcdef', 'browser-temporary');
    await vi.waitFor(() => expect(temporary.get(tempAction.actionId)?.state).toBe('session_reachable'));
    expect(temporaryHook).not.toHaveBeenCalled();

    const tmuxHook = vi.fn(async input => completed(input)); const tmuxOptions = options(tmuxHook);
    const tmux = new RoleCreationService({ ...tmuxOptions,
      identityProvisioner: { exists: async () => false, create: async () => {} },
      probeReady: async () => 'ready' });
    const tmuxRequest = { ...request('WebTmux', 'permanent'), session: 'tmux' as const };
    const tmuxPreview = await tmux.preview(tmuxRequest);
    const tmuxAction = await tmux.create(tmuxRequest, tmuxPreview.previewHash,
      'fedcba9876543210fedcba9876543210', 'browser-tmux');
    await vi.waitFor(() => expect(tmux.get(tmuxAction.actionId)?.state).toBe('session_reachable'));
    expect(tmuxHook).not.toHaveBeenCalled();
  });
});
