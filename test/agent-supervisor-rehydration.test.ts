import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionAgentCreationCompositionRoot } from '../src/agent-creation-composition-root.js';
import { createInternalAgentSupervisorRehydration,
  createProductionAgentSupervisorRehydration } from '../src/agent-supervisor-rehydration.js';
import { agentRuntimeSessionRequestBindings } from '../src/agent-launch-composition-root.js';
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
  it('uses exact restore, never fresh start, in a second process-local rehydrator over durable ready state', async () => {
    const f = await fixture(); const starts: string[] = []; const restores: string[] = [];
    const makeDriver = () => { let listener: ((value: unknown) => void) | undefined;
      const accepted = async () => ({ state: 'accepted' as const });
      return { subscribe: (next: (value: unknown) => void) => { listener = next; return () => { listener = undefined; }; },
        start: async (request: { lifecycle: { generation: string } }) => { starts.push(request.lifecycle.generation);
          return { state: 'accepted' as const, sessionMetadata: { schemaVersion: 1 as const,
            token: 'durable-session', digest: `sha256:${'d'.repeat(64)}` } }; },
        restore: async (request: { lifecycle: { generation: string; sessionMetadata?: { token: string } } }) => {
          restores.push(`${request.lifecycle.generation}:${request.lifecycle.sessionMetadata?.token}`);
          return { state: 'accepted' as const, sessionMetadata: request.lifecycle.sessionMetadata! }; },
        submit: accepted, respondPermission: accepted, cancel: accepted, forceTerminate: accepted,
        close: accepted, retire: accepted, cleanup: async () => { listener = undefined; } };
    };
    const startEvidence = new WeakMap<object, 'not_started'>();
    const reconciliation = { reconcileStart: async () => { const evidence = {}; startEvidence.set(evidence, 'not_started'); return evidence; },
      authenticateStart: (evidence: unknown) => evidence && typeof evidence === 'object' && startEvidence.has(evidence as object)
        ? { outcome: 'not_started' as const } : undefined,
      reconcileRetire: async () => ({}), authenticateRetire: () => ({ outcome: 'already_absent' as const }) };
    const deps = { ...f, driverFactory: vi.fn(() => makeDriver() as never), reconciliation, now: () => 10 };
    const options = { name: 'agent-1', cwd: f.trustedRoot, stateDir: f.trustedRoot, mode: 'fresh' as const,
      permissions: { approval: 'ask' as const, filesystem: 'workspace' as const, unattended: 'deny' as const },
      log: () => undefined };
    const context = (id: string) => ({ evidence: Object.freeze({}), sessionRequestId: id,
      sessionRequest: agentRuntimeSessionRequestBindings(options) });
    const first = createInternalAgentSupervisorRehydration(deps).rehydrate('agent-1');
    const firstSession = await first.startSession(options, context('first'));
    expect(starts).toEqual(['g1']); expect(restores).toEqual([]); await firstSession.close();
    const second = createInternalAgentSupervisorRehydration(deps).rehydrate('agent-1');
    const secondSession = await second.startSession(options, context('second'));
    expect(starts).toEqual(['g1']); expect(restores).toEqual(['g1:durable-session']);
    expect(secondSession).toBeDefined(); await secondSession.close();
    const agentRoot = join(f.trustedRoot, 'agents', Buffer.from('agent-1').toString('base64url'));
    const active = JSON.parse(readFileSync(join(agentRoot, 'active.json'), 'utf8'));
    const bindingPath = join(active.canonicalDir, 'runtime-binding.json');
    const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
    binding.sessionMetadataDigest = `sha256:${'0'.repeat(64)}`;
    writeFileSync(bindingPath, `${canonical(binding)}\n`, { mode: 0o600 });
    const third = createInternalAgentSupervisorRehydration(deps).rehydrate('agent-1');
    await expect(third.startSession(options, context('third'))).rejects.toThrow();
    expect(starts).toEqual(['g1']); expect(restores).toEqual(['g1:durable-session']);
    expect(deps.driverFactory).toHaveBeenCalledTimes(2);
  });
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
    expect(Object.keys(seam).sort()).toEqual(['agentId', 'generation', 'restore', 'start']);
    expect((seam as unknown as { startSession?: unknown }).startSession).toBeUndefined();
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
