import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentStartLocatorPublisher } from '../src/agent-start-locator.js';
import { AgentSupervisorHandoffPublisher, readAgentSupervisorHandoff } from '../src/agent-supervisor-handoff.js';
import { storeAgentPlan } from '../src/agent-plan-store.js';
import { computeBrainDigest, computePermissionsDigest, resolveAgentPlan,
  type AdapterValidationRecord } from '../src/agent-plan.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';
import type { CompleteAgentCreationBindings, VerifiedCompleteAgentCreation } from '../src/agent-creation-transaction.js';

let root: string; let trusted: string;
const brain: BrainSpec = { harness: 'codex', model: 'gpt-test', effort: 'high', session: 'acp' };
const permissions: PermissionSpec = { approval: 'ask', filesystem: 'workspace', unattended: 'deny' };
const adapter: AdapterValidationRecord = { redacted: true, adapterId: 'codex-acp', adapterVersion: '1',
  policyRevision: 'policy-1', policyDigest: `sha256:${'1'.repeat(64)}`,
  brainDigest: computeBrainDigest(brain), permissionsDigest: computePermissionsDigest(permissions),
  portableDescriptor: permissions,
  nativeDescriptor: { approvalMode: 'ask', filesystemMode: 'workspace', unattendedMode: 'deny', exact: true },
  enforcement: { approval: { owner: 'native_adapter', policyDigest: `sha256:${'1'.repeat(64)}` },
    filesystem: { owner: 'native_adapter', policyDigest: `sha256:${'1'.repeat(64)}` },
    unattended: { owner: 'body_controller', policyDigest: `sha256:${'1'.repeat(64)}` } } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'supervisor-handoff-')); trusted = join(root, 'trusted');
  mkdirSync(join(root, 'fleet.conf.d', 'roles.d'), { recursive: true });
  writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  writeFileSync(join(root, 'fleet.conf.d', 'roles.d', 'builder.yaml'),
    'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tree(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) return { mode: Number(stat.mode), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
  return { mode: Number(stat.mode), mtimeNs: String(stat.mtimeNs), children: Object.fromEntries(
    readdirSync(path).sort().map(name => [name, tree(join(path, name))])) };
}

function fixture(generation: number, actionId: string) {
  const snapshot = loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') });
  const plan = resolveAgentPlan({ snapshot, source: { kind: 'runtime_composition', agentId: 'agent-1',
    role: 'Builder', identity: { name: 'agent-1', ownership: 'create_persistent' },
    lifecycle: 'persistent', brain, permissions }, principal: { id: 'system', kind: 'system' },
    operation: { id: actionId, type: 'agent.create', resourceScope: 'agents/agent-1' },
    authorizationRevision: 'auth-1', generation, evaluatedAt: 1, adapter });
  const agentRoot = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'));
  const canonicalDir = join(agentRoot, 'candidates', Buffer.from(actionId).toString('base64url'),
    `${String(generation).padStart(20, '0')}-${plan.planDigest.slice(7)}`);
  mkdirSync(canonicalDir, { recursive: true, mode: 0o700 });
  storeAgentPlan(canonicalDir, plan, plan, 'handoff-test');
  const evidence = Object.freeze({}) as VerifiedCompleteAgentCreation;
  const complete: CompleteAgentCreationBindings = { actionId, agentId: 'agent-1', generation,
    planDigest: plan.planDigest, snapshotDigest: plan.snapshotDigest,
    reservationDigest: `sha256:${String(generation).repeat(64).slice(0, 64)}`, canonicalDir,
    identity: { name: 'agent-1', ownership: 'create_persistent', provider: 'ours-daemon',
      authenticatedIdentityId: 'CID', evidenceDigest: `sha256:${'8'.repeat(64)}`, acquisition: 'created' } };
  const authority = { validateComplete: () => evidence,
    authenticateComplete: (value: VerifiedCompleteAgentCreation) => value === evidence ? complete : undefined };
  new AgentStartLocatorPublisher(authority).publish(evidence);
  return { evidence, authority, complete };
}

describe('Agent supervisor active-generation handoff', () => {
  it('publishes authenticated on-disk locator bindings and reads a private canonical record', async () => {
    const f = fixture(1, 'action-1');
    const record = await new AgentSupervisorHandoffPublisher(trusted, f.authority).publish(f.evidence);
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toEqual(record);
    expect(statSync(join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'), 'active.json')).mode & 0o777)
      .toBe(0o600);
    expect(record).toMatchObject({ generation: 1, locatorDigest: expect.stringMatching(/^sha256:/u),
      planBytesDigest: expect.stringMatching(/^sha256:/u) });
  });

  it('allows absent, identical, and exact N+1 while rejecting rollback and skip', async () => {
    const one = fixture(1, 'action-1'); const publisher1 = new AgentSupervisorHandoffPublisher(trusted, one.authority);
    const first = await publisher1.publish(one.evidence); expect(await publisher1.publish(one.evidence)).toEqual(first);
    const two = fixture(2, 'action-2'); const publisher2 = new AgentSupervisorHandoffPublisher(trusted, two.authority);
    const second = await publisher2.publish(two.evidence); expect(second.generation).toBe(2);
    await expect(publisher1.publish(one.evidence)).rejects.toMatchObject({ code: 'generation_conflict' });
    const four = fixture(4, 'action-4');
    await expect(new AgentSupervisorHandoffPublisher(trusted, four.authority).publish(four.evidence))
      .rejects.toMatchObject({ code: 'generation_conflict' });
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toEqual(second);
  });

  it('never trusts a caller locator object and rejects corrupted active bytes', async () => {
    const f = fixture(1, 'action-1'); await new AgentSupervisorHandoffPublisher(trusted, f.authority).publish(f.evidence);
    const path = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'), 'active.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('action-1', 'action-X'), { mode: 0o600 });
    expect(() => readAgentSupervisorHandoff(trusted, 'agent-1')).toThrow(/invalid_handoff/u);
  });

  it('fault after atomic replace leaves a complete new record, never torn bytes', async () => {
    const one = fixture(1, 'action-1'); await new AgentSupervisorHandoffPublisher(trusted, one.authority).publish(one.evidence);
    const two = fixture(2, 'action-2');
    await expect(new AgentSupervisorHandoffPublisher(trusted, two.authority,
      { afterReplace: () => { throw new Error('crash'); } }).publish(two.evidence)).rejects.toThrow();
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toMatchObject({ generation: 2, actionId: 'action-2' });
  });

  it.each(['symlink', 'mode', 'canonical-extra', 'truncation', 'before-open-race'] as const)(
    'rejects an unsafe active record %s without reader mutation', async attack => {
      const f = fixture(1, 'action-1'); await new AgentSupervisorHandoffPublisher(trusted, f.authority).publish(f.evidence);
      const path = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'), 'active.json');
      const original = readFileSync(path); let racedTree: unknown; let faults = {};
      if (attack === 'symlink') {
        const target = join(root, 'foreign-active.json'); writeFileSync(target, original, { mode: 0o600 });
        unlinkSync(path); symlinkSync(target, path);
      } else if (attack === 'mode') chmodSync(path, 0o644);
      else if (attack === 'canonical-extra') {
        const value = JSON.parse(original.toString('utf8')); value.extra = true;
        writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      } else if (attack === 'truncation') writeFileSync(path, original.subarray(0, 12), { mode: 0o600 });
      else {
        const replacement = join(root, 'replacement-active.json'); writeFileSync(replacement, original, { mode: 0o600 });
        faults = { beforeSecureOpen: (opened: string) => { if (opened === path) {
          renameSync(replacement, path); racedTree = tree(trusted);
        } } };
      }
      const before = tree(trusted);
      expect(() => readAgentSupervisorHandoff(trusted, 'agent-1', faults)).toThrow(/invalid_handoff/u);
      expect(tree(trusted)).toEqual(attack === 'before-open-race' ? racedTree : before);
    });

  it('preserves the prior CAS value on pre-replace crash and short write, with no temp residue', async () => {
    const one = fixture(1, 'action-1'); const first = await new AgentSupervisorHandoffPublisher(trusted, one.authority)
      .publish(one.evidence);
    const two = fixture(2, 'action-2');
    await expect(new AgentSupervisorHandoffPublisher(trusted, two.authority,
      { beforeReplace: () => { throw new Error('crash'); } }).publish(two.evidence)).rejects.toThrow();
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toEqual(first);
    await expect(new AgentSupervisorHandoffPublisher(trusted, two.authority,
      { write: () => 0 }).publish(two.evidence)).rejects.toMatchObject({ code: 'write_failed' });
    const agentRoot = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'));
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toEqual(first);
    expect(readdirSync(agentRoot).filter(name => name.startsWith('.active.') && name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([false, true])(
    'temp-file fsync failure preserves an %s prior state and removes temp residue', async withPrior => {
      let prior;
      if (withPrior) {
        const one = fixture(1, 'action-1'); prior = await new AgentSupervisorHandoffPublisher(trusted, one.authority)
          .publish(one.evidence);
      }
      const next = fixture(withPrior ? 2 : 1, withPrior ? 'action-2' : 'action-1');
      await expect(new AgentSupervisorHandoffPublisher(trusted, next.authority,
        { fsyncFile: () => { throw new Error('file fsync failed'); } }).publish(next.evidence))
        .rejects.toMatchObject({ code: 'write_failed' });
      const agentRoot = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'));
      if (prior) expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toEqual(prior);
      else expect(existsSync(join(agentRoot, 'active.json'))).toBe(false);
      expect(readdirSync(agentRoot).filter(name => name.startsWith('.active.') && name.endsWith('.tmp'))).toEqual([]);
    });

  it('directory-fsync failure after replace leaves one complete readable new record', async () => {
    const one = fixture(1, 'action-1'); await new AgentSupervisorHandoffPublisher(trusted, one.authority).publish(one.evidence);
    const two = fixture(2, 'action-2');
    await expect(new AgentSupervisorHandoffPublisher(trusted, two.authority,
      { fsyncDirectory: () => { throw new Error('directory fsync failed'); } }).publish(two.evidence))
      .rejects.toMatchObject({ code: 'write_failed' });
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toMatchObject({ generation: 2, actionId: 'action-2' });
  });

  it('serializes concurrent N+1 CAS contenders so exactly one authenticated record wins', async () => {
    const one = fixture(1, 'action-1'); await new AgentSupervisorHandoffPublisher(trusted, one.authority).publish(one.evidence);
    const left = fixture(2, 'action-left'); const right = fixture(2, 'action-right');
    const settled = await Promise.allSettled([
      new AgentSupervisorHandoffPublisher(trusted, left.authority).publish(left.evidence),
      new AgentSupervisorHandoffPublisher(trusted, right.authority).publish(right.evidence),
    ]);
    const fulfilled = settled.filter((value): value is PromiseFulfilledResult<Readonly<import('../src/agent-supervisor-handoff.js').AgentSupervisorHandoff>> => value.status === 'fulfilled');
    const rejected = settled.filter(value => value.status === 'rejected');
    expect(fulfilled).toHaveLength(1); expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: 'generation_conflict' } });
    expect(readAgentSupervisorHandoff(trusted, 'agent-1')).toEqual(fulfilled[0]!.value);
  });
});
