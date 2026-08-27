import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionAgentCreationCompositionRoot } from '../src/agent-creation-composition-root.js';
import { createProductionAgentSupervisorRehydration } from '../src/agent-supervisor-rehydration.js';
import { computeBrainDigest, computePermissionsDigest } from '../src/agent-plan.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import { computeBrainAdapterPolicyDigest } from '../src/harness/brain-adapter.js';
import type { BrainAdapterPolicy, TrustedAdapterEnforcementBindings,
  VerifiedAdapterEnforcementEvidence } from '../src/harness/brain-adapter.js';
import { resolveAuthenticatedBundledAcpAgent } from '../src/harness/acp-agent.js';
import '../src/harness/codex.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'supervisor-rehydration-'));
  mkdirSync(join(root, 'fleet.conf.d', 'roles.d'), { recursive: true });
  writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  writeFileSync(join(root, 'fleet.conf.d', 'roles.d', 'builder.yaml'),
    'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tree(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) return { mode: Number(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs),
    digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
  return { mode: Number(stat.mode), mtimeNs: String(stat.mtimeNs), children: Object.fromEntries(
    readdirSync(path).sort().map(name => [name, tree(join(path, name))])) };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical(
    (value as Record<string, unknown>)[key],
  )}`).join(',')}}`;
}

async function fixture() {
  const trustedRoot = join(root, 'trusted');
  const snapshot = loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') });
  const brain = { harness: 'codex', model: 'gpt-test', effort: 'high', session: 'acp' } as const;
  const permissions = { approval: 'ask', filesystem: 'workspace', unattended: 'deny' } as const;
  const evidence = Object.freeze({}) as VerifiedAdapterEnforcementEvidence;
  const policyValue: BrainAdapterPolicy = { schemaVersion: 1, kind: 'codex_acp', adapterVersion: '1.1.7',
    modelPolicy: { schemaVersion: 1, kind: 'syntax_only', revision: 'syntax-1' }, launch: { kind: 'bundled' } };
  const policy = { revision: 'policy-1', digest: computeBrainAdapterPolicyDigest('policy-1', policyValue),
    value: policyValue };
  const resolution = resolveAuthenticatedBundledAcpAgent('@agentclientprotocol/codex-acp', 'codex-acp', 'codex-acp');
  if (!resolution.bundled || !resolution.identity || !resolution.manifestPath || !resolution.entrypointPath
      || !resolution.version) throw new Error('test bundle unavailable');
  const trusted: TrustedAdapterEnforcementBindings = { harness: 'codex', session: 'acp',
    adapterId: 'codex-acp', adapterVersion: '1.1.7', policyDigest: policy.digest,
    brainDigest: computeBrainDigest(brain), permissionsDigest: computePermissionsDigest(permissions),
    launch: { kind: 'bundled', packageName: '@agentclientprotocol/codex-acp',
      manifestPath: resolution.manifestPath, entrypointPath: resolution.entrypointPath,
      version: resolution.version, identity: resolution.identity },
    enforcement: { approval: 'native_adapter', filesystem: 'native_adapter', unattended: 'body_controller' } };
  const policies = { resolvePolicy: () => ({ policy, enforcementEvidence: evidence }) };
  const adapterAuthority = { authenticateAdapterEvidence: (value: unknown) => value === evidence ? trusted : undefined };
  const cid = 'A'.repeat(64);
  const assembly = createProductionAgentCreationCompositionRoot({ trustedStateRoot: trustedRoot,
    identityProvisioner: { exists: async () => true,
      inspect: async () => ({ state: 'present' as const, cid }) }, identityProfile: {}, policies,
    adapterAuthority, now: () => 2 });
  const context = { operation: Object.freeze({ id: 'action-1', type: 'agent.create',
    resourceScope: 'agents/agent-1' }), authorizationRevision: 'auth-1', snapshot,
    snapshotRevision: 'graph-1', issuedAt: 1 };
  const callerEvidence = assembly.ingress.direct(context);
  await assembly.root.createPermanent({ callerEvidence, source: { kind: 'runtime_composition',
    agentId: 'agent-1', role: 'Builder', identity: { name: 'agent-1', ownership: 'existing' },
    lifecycle: 'persistent', brain, permissions } }, 'action-1');
  const driverFactory = vi.fn(() => { throw new Error('driver must not be constructed during rehydration'); });
  const reconciliation = { reconcileStart: vi.fn(), authenticateStart: vi.fn(),
    reconcileRetire: vi.fn(), authenticateRetire: vi.fn() };
  return { trustedRoot, trustedStateRoot: trustedRoot, policies, adapterAuthority, driverFactory, reconciliation };
}

describe('production Agent supervisor rehydration', () => {
  it('constructs without creating a missing trusted root', () => {
    const missing = join(root, 'missing');
    createProductionAgentSupervisorRehydration({ trustedStateRoot: missing,
      policies: { resolvePolicy: () => { throw new Error('not called'); } },
      adapterAuthority: { authenticateAdapterEvidence: () => undefined },
      driverFactory: () => { throw new Error('not called'); },
      reconciliation: { reconcileStart: async () => ({}), authenticateStart: () => undefined,
        reconcileRetire: async () => ({}), authenticateRetire: () => undefined } });
    expect(existsSync(missing)).toBe(false);
  });

  it('rehydrates one frozen opaque seam with no filesystem, driver, or reconciliation effect', async () => {
    const f = await fixture(); const before = tree(f.trustedRoot);
    const root = createProductionAgentSupervisorRehydration({ ...f, now: () => 10 });
    const seam = root.rehydrate('agent-1');
    expect(seam).toMatchObject({ agentId: 'agent-1', generation: 1,
      start: expect.any(Function), restore: expect.any(Function) });
    expect(Object.isFrozen(seam)).toBe(true);
    expect(tree(f.trustedRoot)).toEqual(before);
    expect(f.driverFactory).not.toHaveBeenCalled();
    expect(f.reconciliation.reconcileStart).not.toHaveBeenCalled();
    expect(f.reconciliation.reconcileRetire).not.toHaveBeenCalled();
  });

  it('returns fresh process-local seams while preserving identical durable bindings', async () => {
    const f = await fixture();
    const deps = { ...f, now: () => 10 };
    const first = createProductionAgentSupervisorRehydration(deps).rehydrate('agent-1');
    const second = createProductionAgentSupervisorRehydration(deps).rehydrate('agent-1');
    expect(first).not.toBe(second);
    expect([first.agentId, first.generation]).toEqual([second.agentId, second.generation]);
    expect(f.driverFactory).not.toHaveBeenCalled();
  });

  it('fails before preparation when the active locator digest is substituted', async () => {
    const f = await fixture(); const agentRoot = join(f.trustedRoot, 'agents', Buffer.from('agent-1').toString('base64url'));
    const path = join(agentRoot, 'active.json'); const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace(/"locatorDigest":"sha256:[a-f0-9]{64}"/u,
      `"locatorDigest":"sha256:${'0'.repeat(64)}"`), { mode: 0o600 });
    const before = tree(f.trustedRoot);
    expect(() => createProductionAgentSupervisorRehydration(f).rehydrate('agent-1')).toThrow();
    expect(tree(f.trustedRoot)).toEqual(before); expect(f.driverFactory).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'mode', 'canonical-extra', 'truncation', 'authenticated-substitution'] as const)(
    'fails closed on active-record %s with full-tree and runtime effects unchanged', async attack => {
      const f = await fixture();
      const agentRoot = join(f.trustedRoot, 'agents', Buffer.from('agent-1').toString('base64url'));
      const path = join(agentRoot, 'active.json'); const original = readFileSync(path);
      if (attack === 'symlink') {
        const target = join(root, 'foreign-active.json'); writeFileSync(target, original, { mode: 0o600 });
        unlinkSync(path); symlinkSync(target, path);
      } else if (attack === 'mode') chmodSync(path, 0o644);
      else if (attack === 'canonical-extra') {
        const value = JSON.parse(original.toString('utf8')); value.extra = true;
        writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 });
      } else if (attack === 'truncation') writeFileSync(path, original.subarray(0, 12), { mode: 0o600 });
      else {
        const value = JSON.parse(original.toString('utf8')); value.actionId = 'action-other';
        const { handoffDigest: _prior, ...unsigned } = value;
        value.handoffDigest = `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}`;
        writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 });
      }
      const before = tree(f.trustedRoot);
      expect(() => createProductionAgentSupervisorRehydration(f).rehydrate('agent-1')).toThrow();
      expect(tree(f.trustedRoot)).toEqual(before);
      expect(f.driverFactory).not.toHaveBeenCalled();
      expect(f.reconciliation.reconcileStart).not.toHaveBeenCalled();
      expect(f.reconciliation.reconcileRetire).not.toHaveBeenCalled();
    });
});
