import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentProductionRuntime, createControlledAgentProductionRuntime,
  prepareManagedPersistentResource, resumeManagedPersistentResource,
  retireManagedPersistentResource, reconfigureManagedPersistentResource } from '../src/agent-production-runtime.js';
import type { ResolvedRole } from '../src/config.js';
import { AgentSupervisorControlAuthority } from '../src/agent-supervisor-control.js';
import { loadConfigResourceSnapshotFromDocuments } from '../src/config-resource-loader.js';
import { readAgentSupervisorHandoff } from '../src/agent-supervisor-handoff.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const role = (name: string): ResolvedRole => ({ name, harness: 'codex', session: 'acp', identity: name,
  model: 'gpt-5', sourceFile: 'test', permissionsDeclared: true,
  permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
  monitor: { mode: 'native', enabled: false, wake_sources: [], batch_ms: 0,
    inject: 'notification', interrupt: false } });

describe('Agent production runtime facade', () => {
  it('publishes a typed Agent under the continuously held exact control capability', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const control = new AgentSupervisorControlAuthority(trustedStateRoot); let present = false;
    const runtime = createControlledAgentProductionRuntime({ trustedStateRoot,
      identityProvisioner: { inspect: async name => present
        ? { state: 'present' as const, cid: name.repeat(64).slice(0, 64) } : { state: 'absent' as const },
      exists: async () => present, create: async name => { present = true;
        return { state: 'created_here' as const, cid: name.repeat(64).slice(0, 64) }; } }, now: () => 1 }, control);
    const snapshot = loadConfigResourceSnapshotFromDocuments({ bootstrapFile: '/typed/fleet.yaml',
      configDir: '/typed/fleet.conf.d', bootstrapBytes: Buffer.from('schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n'),
      documents: [
        { relativePath: 'roles.d/writer.yaml', bytes: Buffer.from('kind: Role\nversion: 1\nid: writer\nspec:\n  mission: Write\n') },
        { relativePath: 'brains.d/codex.yaml', bytes: Buffer.from('kind: Brain\nversion: 1\nid: codex\nspec:\n  harness: codex\n  model: gpt-5\n  effort: medium\n  session: acp\n') },
        { relativePath: 'agents.d/alice.yaml', bytes: Buffer.from('kind: Agent\nversion: 1\nid: alice\nspec:\n  role: writer\n  brain:\n    template: codex\n  identity:\n    name: alice\n    ownership: create_persistent\n  lifecycle: persistent\n  permissions:\n    approval: ask\n    filesystem: workspace\n    unattended: deny\n') },
      ] });
    await control.exclusive('alice', async lease => {
      await expect(prepareManagedPersistentResource(runtime, { snapshot, agentId: 'alice', actionId: 'start-1',
        controlLease: lease })).resolves.toMatchObject({ state: 'complete' });
      await expect(prepareManagedPersistentResource(runtime, { snapshot, agentId: 'alice', actionId: 'start-1',
        controlLease: lease })).rejects.toThrow();
    });
    await control.exclusive('other', lease => expect(resumeManagedPersistentResource(runtime, { agentId: 'alice',
      actionId: 'start-1', controlLease: lease })).rejects.toThrow(/invalid_context/u));
    await control.exclusive('alice', lease => expect(reconfigureManagedPersistentResource(runtime,
      { snapshot, agentId: 'alice', actionId: 'reconfigure-1', controlLease: lease }))
      .resolves.toMatchObject({ state: 'complete' }));
    const active = readAgentSupervisorHandoff(trustedStateRoot, 'alice');
    expect(active).toMatchObject({ generation: 2, actionId: 'reconfigure-1' });
    await control.exclusive('alice', async lease => {
      expect(control.bind(lease, { agentId: 'alice', operation: 'retire',
        priorGeneration: active.generation, targetGeneration: active.generation, actionId: 'retire-1',
        planDigest: active.planDigest, snapshotDigest: active.snapshotDigest,
        rootId: 'production-agent-creation', publisherId: 'agent-supervisor-handoff' })).toBe(true);
      await retireManagedPersistentResource(runtime, { active, actionId: 'retire-1', controlLease: lease });
    });
    expect(() => readAgentSupervisorHandoff(trustedStateRoot, 'alice')).toThrow();
  });
  it('creates permanent and temporary product Agents without exposing internal authorities', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const identities = new Map<string, string>(); const create = vi.fn(async (name: string) => {
      const cid = name.repeat(64).slice(0, 64); identities.set(name, cid);
      return { state: 'created_here' as const, cid };
    });
    const runtime = createAgentProductionRuntime({ trustedStateRoot, identityProvisioner: {
      exists: async name => identities.has(name),
      inspect: async name => identities.has(name)
        ? { state: 'present' as const, cid: identities.get(name)! } : { state: 'absent' as const }, create,
    }, now: () => 1 });
    expect(Object.keys(runtime)).toEqual([
      'create', 'createRole', 'reserveTemporaryComposition',
      'resumeTemporaryComposition', 'launch',
    ]);
    const permanent = await runtime.createRole({ role: role('Permanent'), lifetime: 'persistent', actionId: 'p-1' });
    expect(permanent).toMatchObject({ state: 'complete', identityAcquisition: 'created',
      identityName: 'Permanent' });
    await expect(runtime.createRole({ role: role('Permanent'), lifetime: 'persistent', actionId: 'p-1' }))
      .resolves.toMatchObject({ state: 'complete', locator: { agentId: 'Permanent', actionId: 'p-1' } });
    const temporary = await runtime.createRole({ role: role('Temporary'), lifetime: 'temporary', actionId: 't-1' });
    expect(temporary).toEqual({ state: 'reserved', agentId: 'Temporary', generation: 1,
      actionId: 't-1', lifetime: 'temporary', completion: 'deferred' });
    const resumed = runtime.resumeTemporaryComposition({ agentId: 'Temporary', actionId: 't-1' });
    expect(resumed).toMatchObject({ handoff: { agentId: 'Temporary', actionId: 't-1' },
      plan: { agentId: 'Temporary', lifecycle: 'temporary' } });
    writeFileSync(join(resumed.handoff.canonicalDir, 'agent-plan.json'), '{}\n', { mode: 0o600 });
    expect(() => runtime.resumeTemporaryComposition({ agentId: 'Temporary', actionId: 't-1' }))
      .toThrow(/invalid_plan/u);
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects corrupt persistent active authority instead of treating it as absence', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const identities = new Map<string, string>();
    const runtime = createAgentProductionRuntime({ trustedStateRoot, identityProvisioner: {
      exists: async name => identities.has(name),
      inspect: async name => identities.has(name)
        ? { state: 'present' as const, cid: identities.get(name)! } : { state: 'absent' as const },
      create: async name => { const cid = name.repeat(64).slice(0, 64); identities.set(name, cid);
        return { state: 'created_here' as const, cid }; },
    }, now: () => 1 });
    await runtime.createRole({ role: role('Corrupt'), lifetime: 'persistent', actionId: 'p-1' });
    writeFileSync(join(trustedStateRoot, 'agents', Buffer.from('Corrupt').toString('base64url'),
      'active.json'), '{}\n', { mode: 0o600 });
    await expect(runtime.createRole({ role: role('Corrupt'), lifetime: 'persistent', actionId: 'p-1' }))
      .rejects.toThrow(/invalid_handoff/u);
  });

  it('fails closed for non-ACP creation input', async () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'agent-product-')); roots.push(trustedStateRoot);
    const runtime = createAgentProductionRuntime({ trustedStateRoot,
      identityProvisioner: { exists: async () => false } });
    await expect(runtime.createRole({ role: { ...role('Tmux'), session: 'tmux' },
      lifetime: 'persistent', actionId: 'x' })).rejects.toThrow(/requires ACP/u);
  });
});
