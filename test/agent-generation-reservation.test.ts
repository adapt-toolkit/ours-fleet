import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeBrainDigest, computePermissionsDigest, resolveAgentPlan,
  type AdapterValidationRecord } from '../src/agent-plan.js';
import { DurableAgentGenerationAuthority, DurableAgentGenerationReader,
  type ExactGenerationReservationBindings } from '../src/agent-generation-reservation.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';

let root: string; let trusted: string;
const brain: BrainSpec = { harness: 'codex', model: 'gpt-test', effort: 'high', session: 'acp' };
const permissions: PermissionSpec = { approval: 'ask', filesystem: 'workspace', unattended: 'deny' };
const adapter: AdapterValidationRecord = {
  redacted: true, adapterId: 'codex-acp', adapterVersion: '1', policyRevision: 'policy-1',
  policyDigest: `sha256:${'1'.repeat(64)}`, brainDigest: computeBrainDigest(brain),
  permissionsDigest: computePermissionsDigest(permissions), portableDescriptor: permissions,
  nativeDescriptor: { approvalMode: 'ask', filesystemMode: 'workspace', unattendedMode: 'deny', exact: true },
  enforcement: {
    approval: { owner: 'native_adapter', policyDigest: `sha256:${'1'.repeat(64)}` },
    filesystem: { owner: 'native_adapter', policyDigest: `sha256:${'1'.repeat(64)}` },
    unattended: { owner: 'body_controller', policyDigest: `sha256:${'1'.repeat(64)}` },
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'generation-reader-')); trusted = join(root, 'trusted');
  mkdirSync(join(root, 'fleet.conf.d', 'roles.d'), { recursive: true });
  writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  writeFileSync(join(root, 'fleet.conf.d', 'roles.d', 'builder.yaml'),
    'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function selected() {
  return resolveAgentPlan({ snapshot: loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') }),
    source: { kind: 'runtime_composition', agentId: 'agent-1', role: 'Builder',
      identity: { name: 'agent-1', ownership: 'create_persistent' }, lifecycle: 'persistent', brain, permissions },
    principal: { id: 'system', kind: 'system' }, operation: {
      id: 'action-1', type: 'agent.create', resourceScope: 'agents/agent-1' },
    authorizationRevision: 'auth-1', generation: 1, evaluatedAt: 1, adapter });
}

function tree(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) return { mode: Number(stat.mode), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
  return { mode: Number(stat.mode), mtimeNs: String(stat.mtimeNs), children: Object.fromEntries(
    readdirSync(path).sort().map(name => [name, tree(join(path, name))])) };
}

async function fixture() {
  const writer = new DurableAgentGenerationAuthority(trusted);
  const evidence = await writer.persist(selected(), 'action-1');
  const record = writer.authenticate(evidence)!;
  const expected: ExactGenerationReservationBindings = { actionId: record.actionId, agentId: record.agentId,
    generation: record.generation, planDigest: record.planDigest, snapshotDigest: record.snapshotDigest,
    canonicalDir: record.canonicalDir, planBytesDigest: record.planBytesDigest,
    reservationDigest: record.reservationDigest };
  return { record, expected };
}

describe('DurableAgentGenerationReader', () => {
  it('reconstructs exact process-local evidence without changing any trusted bytes or metadata', async () => {
    const f = await fixture(); const before = tree(trusted);
    const reader = new DurableAgentGenerationReader(trusted);
    const evidence = reader.readExact(f.expected);
    expect(reader.authenticate(evidence)).toEqual(f.record);
    expect(tree(trusted)).toEqual(before);
  });

  it('constructs and fails on a missing root without creating it', () => {
    const missing = join(root, 'missing'); const reader = new DurableAgentGenerationReader(missing);
    expect(() => reader.readExact({ actionId: 'action-1', agentId: 'agent-1', generation: 1,
      planDigest: `sha256:${'1'.repeat(64)}`, snapshotDigest: `sha256:${'2'.repeat(64)}`,
      canonicalDir: join(missing, 'candidate'), planBytesDigest: `sha256:${'3'.repeat(64)}`,
      reservationDigest: `sha256:${'4'.repeat(64)}` })).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it.each(['index', 'reservation', 'candidate'] as const)(
    'fails closed for missing %s with byte-for-byte no repair or directory creation', async missing => {
      const f = await fixture();
      const agentRoot = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'));
      if (missing === 'index') unlinkSync(join(agentRoot, 'actions', `${Buffer.from('action-1').toString('base64url')}.json`));
      else if (missing === 'reservation') unlinkSync(join(agentRoot, 'reservations',
        `${String(f.record.generation).padStart(20, '0')}-${f.record.reservationDigest.slice(7)}.json`));
      else rmSync(f.record.canonicalDir, { recursive: true });
      const before = tree(trusted);
      expect(() => new DurableAgentGenerationReader(trusted).readExact(f.expected)).toThrow();
      expect(tree(trusted)).toEqual(before);
    });

  it('rejects every expected binding substitution without mutation', async () => {
    const f = await fixture(); const before = tree(trusted);
    const replacements: Record<keyof ExactGenerationReservationBindings, unknown> = {
      actionId: 'other', agentId: 'other', generation: 2,
      planDigest: `sha256:${'a'.repeat(64)}`, snapshotDigest: `sha256:${'b'.repeat(64)}`,
      canonicalDir: join(root, 'foreign'), planBytesDigest: `sha256:${'c'.repeat(64)}`,
      reservationDigest: `sha256:${'d'.repeat(64)}`,
    };
    for (const [key, value] of Object.entries(replacements))
      expect(() => new DurableAgentGenerationReader(trusted).readExact({ ...f.expected, [key]: value } as never), key)
        .toThrow();
    expect(tree(trusted)).toEqual(before);
  });

  it.each(['symlink', 'mode', 'canonical-extra', 'truncation', 'before-open-race'] as const)(
    'rejects an unsafe index %s without changing the already-hostile tree', async attack => {
      const f = await fixture();
      const agentRoot = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'));
      const path = join(agentRoot, 'actions', `${Buffer.from('action-1').toString('base64url')}.json`);
      const original = readFileSync(path);
      let racedTree: unknown; let faults = {};
      if (attack === 'symlink') {
        const target = join(root, 'foreign-index.json'); writeFileSync(target, original, { mode: 0o600 });
        unlinkSync(path); symlinkSync(target, path);
      } else if (attack === 'mode') chmodSync(path, 0o644);
      else if (attack === 'canonical-extra') {
        const value = JSON.parse(original.toString('utf8')); value.extra = true;
        writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      } else if (attack === 'truncation') writeFileSync(path, original.subarray(0, 12), { mode: 0o600 });
      else {
        const replacement = join(root, 'replacement-index.json'); writeFileSync(replacement, original, { mode: 0o600 });
        faults = { beforeSecureOpen: (opened: string) => { if (opened === path) {
          renameSync(replacement, path); racedTree = tree(trusted);
        } } };
      }
      const before = tree(trusted);
      expect(() => new DurableAgentGenerationReader(trusted, faults).readExact(f.expected)).toThrow();
      expect(tree(trusted)).toEqual(attack === 'before-open-race' ? racedTree : before);
    });
});
