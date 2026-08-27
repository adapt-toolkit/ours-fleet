import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeBrainDigest, computePermissionsDigest, resolveAgentPlan,
  type AdapterValidationRecord } from '../src/agent-plan.js';
import { storeAgentPlan } from '../src/agent-plan-store.js';
import type { CompleteAgentCreationBindings, VerifiedCompleteAgentCreation } from '../src/agent-creation-transaction.js';
import { AgentStartLocatorError, AgentStartLocatorPublisher,
  readAgentStartLocator } from '../src/agent-start-locator.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-locator-')); roots.push(root);
  mkdirSync(join(root, 'fleet.conf.d', 'roles.d'), { recursive: true });
  writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  writeFileSync(join(root, 'fleet.conf.d', 'roles.d', 'builder.yaml'),
    'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
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
  const plan = resolveAgentPlan({ snapshot: loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') }),
    source: { kind: 'runtime_composition', agentId: 'agent-1', role: 'Builder',
      identity: { name: 'agent-1', ownership: 'create_persistent' }, lifecycle: 'persistent', brain, permissions },
    principal: { id: 'system', kind: 'system' }, operation: {
      id: 'action-1', type: 'agent.create', resourceScope: 'agents/agent-1' },
    authorizationRevision: 'auth-1', generation: 1, evaluatedAt: 1, adapter });
  const canonicalDir = join(root, 'state'); mkdirSync(canonicalDir, { mode: 0o700 });
  storeAgentPlan(canonicalDir, plan, plan, 'locator-test');
  const trusted: CompleteAgentCreationBindings = { actionId: 'action-1', agentId: 'agent-1', generation: 1,
    planDigest: plan.planDigest, snapshotDigest: plan.snapshotDigest,
    reservationDigest: `sha256:${'9'.repeat(64)}`, canonicalDir,
    identity: { name: 'agent-1', ownership: 'create_persistent', provider: 'ours-daemon',
      authenticatedIdentityId: 'agent-1', evidenceDigest: `sha256:${'8'.repeat(64)}`, acquisition: 'created' } };
  const evidence = {} as VerifiedCompleteAgentCreation;
  return { root, canonicalDir, plan, trusted, evidence };
}

describe('AgentStartLocator durable handoff', () => {
  it('publishes a canonical write-once 0600 locator from authenticated completion bindings', () => {
    const f = fixture();
    const publisher = new AgentStartLocatorPublisher({
      validateComplete: () => f.evidence, authenticateComplete: value => value === f.evidence ? f.trusted : undefined,
    });
    const locator = publisher.publish(f.evidence);
    const path = join(f.canonicalDir, 'agent-start-locator.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`${canonical(locator)}\n`);
    const { locatorDigest, ...unsigned } = locator;
    expect(locatorDigest).toBe(`sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}`);
    expect(locator).toMatchObject({ authorizationRevision: 'auth-1', lifetime: 'persistent',
      identityEvidenceDigest: f.trusted.identity.evidenceDigest });
    expect(publisher.publish(f.evidence)).toEqual(locator);
    const { locatorDigest: _digest, ...expected } = locator;
    expect(readAgentStartLocator(f.canonicalDir, expected)).toEqual(locator);
  });

  it('rejects every expected-binding substitution and malformed durable presentation', () => {
    const f = fixture();
    const publisher = new AgentStartLocatorPublisher({ validateComplete: () => f.evidence,
      authenticateComplete: () => f.trusted });
    const locator = publisher.publish(f.evidence);
    const { locatorDigest: _digest, ...expected } = locator;
    const substitutions: Record<string, unknown> = {
      schemaVersion: 2, kind: 'Other', agentId: 'agent-2', actionId: 'action-2', generation: 2,
      planDigest: `sha256:${'1'.repeat(64)}`, snapshotDigest: `sha256:${'2'.repeat(64)}`,
      reservationDigest: `sha256:${'3'.repeat(64)}`, authorizationRevision: 'auth-2',
      lifetime: 'temporary', identityEvidenceDigest: `sha256:${'4'.repeat(64)}`,
    };
    for (const [key, value] of Object.entries(substitutions))
      expect(() => readAgentStartLocator(f.canonicalDir, { ...expected, [key]: value } as never), key)
        .toThrow(/invalid_locator/u);

    const path = join(f.canonicalDir, 'agent-start-locator.json');
    const variants = [
      { ...locator, extra: true }, { ...locator, locatorDigest: `sha256:${'0'.repeat(64)}` },
    ];
    for (const variant of variants) {
      writeFileSync(path, `${canonical(variant)}\n`, { mode: 0o600 });
      expect(() => readAgentStartLocator(f.canonicalDir, expected)).toThrow(/invalid_locator/u);
    }
    writeFileSync(path, '{', { mode: 0o600 });
    expect(() => readAgentStartLocator(f.canonicalDir, expected)).toThrow(/invalid_locator/u);
    writeFileSync(path, `${canonical(locator)}\n`); chmodSync(path, 0o644);
    expect(() => readAgentStartLocator(f.canonicalDir, expected)).toThrow(/invalid_locator/u);
    rmSync(path); const target = join(f.canonicalDir, 'target');
    writeFileSync(target, `${canonical(locator)}\n`, { mode: 0o600 }); symlinkSync(target, path);
    expect(() => readAgentStartLocator(f.canonicalDir, expected)).toThrow(/invalid_locator/u);

    const linkDir = join(f.root, 'linked-state'); symlinkSync(f.canonicalDir, linkDir);
    expect(() => readAgentStartLocator(linkDir, expected)).toThrow(/invalid_locator/u);
  });

  it.each(['x'.repeat(257), 'bad\ntoken'])('rejects correctly digested unsafe token %j', token => {
    const f = fixture(); const publisher = new AgentStartLocatorPublisher({ validateComplete: () => f.evidence,
      authenticateComplete: () => f.trusted });
    const locator = publisher.publish(f.evidence); const path = join(f.canonicalDir, 'agent-start-locator.json');
    const { locatorDigest: _old, ...unsigned } = { ...locator, agentId: token };
    const changed = { ...unsigned,
      locatorDigest: `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}` };
    writeFileSync(path, `${canonical(changed)}\n`); chmodSync(path, 0o600);
    const { locatorDigest: _digest, ...expected } = changed;
    expect(() => readAgentStartLocator(f.canonicalDir, expected as never)).toThrow(/invalid_locator/u);
  });

  it('rejects hostile expected bindings without invoking accessors', () => {
    const f = fixture(); const locator = new AgentStartLocatorPublisher({ validateComplete: () => f.evidence,
      authenticateComplete: () => f.trusted }).publish(f.evidence);
    const { locatorDigest: _digest, ...expected } = locator; let reads = 0;
    const accessor = { ...expected };
    Object.defineProperty(accessor, 'agentId', { enumerable: true, get() { reads++; return 'agent-1'; } });
    expect(() => readAgentStartLocator(f.canonicalDir, accessor as never)).toThrow(/invalid_locator/u);
    expect(reads).toBe(0);
    const hidden = { ...expected };
    Object.defineProperty(hidden, 'actionId', { enumerable: false, value: 'action-1' });
    expect(() => readAgentStartLocator(f.canonicalDir, hidden as never)).toThrow(/invalid_locator/u);
  });

  it('rejects foreign completion and treats directory fsync failure as write_failed', () => {
    const f = fixture(); const authority = {
      validateComplete: () => f.evidence,
      authenticateComplete: (value: VerifiedCompleteAgentCreation) => value === f.evidence ? f.trusted : undefined,
    };
    expect(() => new AgentStartLocatorPublisher(authority).publish({} as VerifiedCompleteAgentCreation))
      .toThrow(/invalid_completion/u);
    const publisher = new AgentStartLocatorPublisher(authority, { fsyncDirectory: () => { throw new Error('fsync'); } });
    expect(() => publisher.publish(f.evidence)).toThrow(AgentStartLocatorError);
    expect(() => publisher.publish(f.evidence)).toThrow(/write_failed/u);
  });

  it('rejects a conflicting extant locator without replacing it', () => {
    const f = fixture(); const path = join(f.canonicalDir, 'agent-start-locator.json');
    writeFileSync(path, '{}\n', { mode: 0o600 }); chmodSync(path, 0o600);
    const publisher = new AgentStartLocatorPublisher({ validateComplete: () => f.evidence,
      authenticateComplete: () => f.trusted });
    expect(() => publisher.publish(f.evidence)).toThrow(/publication_conflict/u);
    expect(readFileSync(path, 'utf8')).toBe('{}\n');
  });
});
