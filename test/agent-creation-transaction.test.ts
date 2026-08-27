import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentCreationTransaction, type IdentityActionBindings, type TrustedAcquisitionProof,
  type TrustedIdentityVerification, type TrustedOwnershipCapability } from '../src/agent-creation-transaction.js';
import { DurableAgentGenerationAuthority, GenerationReservationError } from '../src/agent-generation-reservation.js';
import { AgentCompositionService, consumePreparedForTransaction,
  type AgentPlanTransactionConsumer, type VerifiedTransactionConsumerEvidence } from '../src/agent-composition-service.js';
import { computeBrainDigest, computePermissionsDigest, resolveAgentPlan, type AdapterValidationRecord, type AgentPlan } from '../src/agent-plan.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';

let root: string;
let state: string;
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
function write(relative: string, contents: string): void {
  const path = join(root, 'fleet.conf.d', relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents);
}
const canonicalRecord = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRecord).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalRecord((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const recordDigest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalRecord(value)).digest('hex')}`;
function rewriteTransitionChain(canonicalDir: string, mutate: (value: Record<string, unknown>) => void): void {
  const dir = join(canonicalDir, 'identity-transitions'); const files = readdirSync(dir).sort();
  let prior: Record<string, unknown> | undefined;
  for (const file of files) {
    const path = join(dir, file); const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    mutate(value); value.prevDigest = prior?.digest ?? null; value.from = prior?.state ?? null;
    const { digest: _old, ...unsigned } = value; value.digest = recordDigest(unsigned);
    unlinkSync(path); writeFileSync(path, `${canonicalRecord(value)}\n`, { mode: 0o600 }); prior = value;
  }
}
function plan(generation = 1, agentId = 'worker-1', ownership: 'existing' | 'create_persistent' | 'create_temporary' = 'create_temporary'): AgentPlan {
  const snapshot = loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') });
  return resolveAgentPlan({ snapshot, source: {
    kind: 'runtime_composition', agentId, role: 'Builder', identity: { name: agentId, ownership },
    lifecycle: ownership === 'create_temporary' ? 'temporary' : 'persistent', brain, permissions,
  }, principal: { id: 'owner-1', kind: 'owner' }, operation: {
    id: `op-${generation}`, type: 'agent.create', resourceScope: `agents/${agentId}`,
  }, authorizationRevision: 'auth-1', generation, evaluatedAt: 1000, adapter });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-creation-')); state = join(root, 'trusted');
  mkdirSync(join(root, 'fleet.conf.d')); writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  write('roles.d/builder.yaml', 'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('trusted durable generation allocation', () => {
  it('publishes the exact plan before reservation and recovers after that crash without Prepared', async () => {
    const first = new DurableAgentGenerationAuthority(state, { afterPlan: () => { throw new Error('crash'); } });
    await expect(first.persist(plan(), 'action-1')).rejects.toThrow('crash');
    write('roles.d/builder.yaml', 'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Changed\n');
    const restarted = new DurableAgentGenerationAuthority(state);
    const evidence = await restarted.resume('worker-1', 'action-1');
    const record = restarted.authenticate(evidence)!;
    expect(readFileSync(join(record.canonicalDir, 'agent-plan.json'), 'utf8')).toContain('Build');
    expect(readFileSync(join(record.canonicalDir, 'agent-plan.json'), 'utf8')).not.toContain('Changed');
  });

  it('repairs a missing action index from the unique authenticated reservation', async () => {
    let crashed = false;
    const first = new DurableAgentGenerationAuthority(state, { afterReservation: () => {
      if (!crashed) { crashed = true; throw new Error('crash'); }
    } });
    await expect(first.persist(plan(), 'action-1')).rejects.toThrow('crash');
    const restarted = new DurableAgentGenerationAuthority(state);
    const [left, right] = await Promise.all([
      restarted.resume('worker-1', 'action-1'), restarted.resume('worker-1', 'action-1'),
    ]);
    expect(left.reservationDigest).toBe(right.reservationDigest);
    const agentRoot = dirname(dirname(dirname(restarted.authenticate(left)!.canonicalDir)));
    expect(readdirSync(join(agentRoot, 'actions'))).toHaveLength(1);
  });

  it('repairs an index publication fault and fails closed for an index without its reservation', async () => {
    let fault = true;
    const first = new DurableAgentGenerationAuthority(state, { duringIndex: () => {
      if (fault) { fault = false; throw new Error('index crash'); }
    } });
    await expect(first.persist(plan(), 'action-1')).rejects.toThrow('index crash');
    const restarted = new DurableAgentGenerationAuthority(state);
    await expect(restarted.resume('worker-1', 'action-1')).resolves.toMatchObject({ actionId: 'action-1' });

    const orphanState = join(root, 'other-trusted');
    const orphan = new DurableAgentGenerationAuthority(orphanState, { afterPlan: () => { throw new Error('plan crash'); } });
    await expect(orphan.persist(plan(), 'action-2')).rejects.toThrow('plan crash');
    const agentRoot = join(orphanState, 'agents', Buffer.from('worker-1').toString('base64url'));
    const actionId = 'action-2';
    const value = { schemaVersion: 1, kind: 'AgentGenerationActionIndex', actionId,
      agentId: 'worker-1', reservationDigest: `sha256:${'f'.repeat(64)}` };
    const canonical = `{"actionId":"action-2","agentId":"worker-1","indexDigest":"sha256:${'e'.repeat(64)}","kind":"AgentGenerationActionIndex","reservationDigest":"sha256:${'f'.repeat(64)}","schemaVersion":1}\n`;
    writeFileSync(join(agentRoot, 'actions', `${Buffer.from(actionId).toString('base64url')}.json`), canonical, { mode: 0o600 });
    await expect(new DurableAgentGenerationAuthority(orphanState).resume('worker-1', actionId))
      .rejects.toMatchObject({ code: 'corrupt_state' });
    expect(value.kind).toBe('AgentGenerationActionIndex');
  });

  it('recovers a winner after reservation with the source and Prepared discarded', async () => {
    const first = new DurableAgentGenerationAuthority(state); const winner = await first.persist(plan(), 'action-1');
    write('roles.d/builder.yaml', 'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Later\n');
    const restarted = new DurableAgentGenerationAuthority(state); const replay = await restarted.resume('worker-1', 'action-1');
    expect(replay.reservationDigest).toBe(winner.reservationDigest);
  });

  it('fails closed for differing same-action candidates and makes zero identity calls', async () => {
    const first = new DurableAgentGenerationAuthority(state, { afterPlan: () => { throw new Error('crash'); } });
    await expect(first.persist(plan(), 'same-action')).rejects.toThrow('crash');
    write('roles.d/builder.yaml', 'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Different\n');
    const second = new DurableAgentGenerationAuthority(state);
    const results = await Promise.allSettled([
      second.persist(plan(), 'same-action'), second.resume('worker-1', 'same-action'),
    ]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'action_conflict' });
    }
  });

  it('admits only the exact next generation and preserves N beside N+1', async () => {
    const authority = new DurableAgentGenerationAuthority(state);
    const one = await authority.persist(plan(1), 'action-1');
    const two = await authority.persist(plan(2), 'action-2');
    expect([one.generation, two.generation]).toEqual([1, 2]);
    expect(existsSync(join(authority.authenticate(one)!.canonicalDir, 'agent-plan.json'))).toBe(true);
    expect(existsSync(join(authority.authenticate(two)!.canonicalDir, 'agent-plan.json'))).toBe(true);
    await expect(authority.persist(plan(2, 'worker-2'), 'other')).rejects.toBeInstanceOf(GenerationReservationError);
  });

  it('rejects symlinked candidate plans, wrong-mode reservations, and zero-progress publication', async () => {
    const crashed = new DurableAgentGenerationAuthority(state, { afterPlan: () => { throw new Error('crash'); } });
    await expect(crashed.persist(plan(), 'action-1')).rejects.toThrow('crash');
    const candidateRoot = join(state, 'agents', Buffer.from('worker-1').toString('base64url'),
      'candidates', Buffer.from('action-1').toString('base64url'));
    const candidate = join(candidateRoot, readdirSync(candidateRoot)[0]!);
    const stored = join(candidate, 'agent-plan.json'); const target = join(root, 'copied-plan.json');
    writeFileSync(target, readFileSync(stored), { mode: 0o600 }); unlinkSync(stored); symlinkSync(target, stored);
    await expect(new DurableAgentGenerationAuthority(state).resume('worker-1', 'action-1'))
      .rejects.toMatchObject({ code: 'unsafe_file' });

    const other = join(root, 'mode-state'); const authority = new DurableAgentGenerationAuthority(other);
    const reserved = await authority.persist(plan(), 'action-2');
    const agentRoot = dirname(dirname(dirname(authority.authenticate(reserved)!.canonicalDir)));
    const reservation = join(agentRoot, 'reservations', readdirSync(join(agentRoot, 'reservations'))[0]!);
    chmodSync(reservation, 0o644);
    await expect(new DurableAgentGenerationAuthority(other).resume('worker-1', 'action-2'))
      .rejects.toMatchObject({ code: 'unsafe_file' });

    const zero = new DurableAgentGenerationAuthority(join(root, 'zero-state'), { write: () => 0 });
    await expect(zero.persist(plan(), 'action-3')).rejects.toMatchObject({ code: 'publication_failed' });

    let writes = 0;
    const partialState = join(root, 'partial-state');
    const partial = new DurableAgentGenerationAuthority(partialState, { write: (fd, bytes, offset, length) => {
      writes += 1; return writes === 1 ? writeSync(fd, bytes, offset, Math.min(7, length)) : 0;
    } });
    await expect(partial.persist(plan(), 'action-4')).rejects.toMatchObject({ code: 'publication_failed' });
    const reservations = join(partialState, 'agents', Buffer.from('worker-1').toString('base64url'), 'reservations');
    expect(readdirSync(reservations)).toEqual([]);
  });

  it('rejects a forged reservation record even when it remains canonical JSON and mode 0600', async () => {
    const authority = new DurableAgentGenerationAuthority(state); const evidence = await authority.persist(plan(), 'action-1');
    const record = authority.authenticate(evidence)!; const agentRoot = dirname(dirname(dirname(record.canonicalDir)));
    const path = join(agentRoot, 'reservations', readdirSync(join(agentRoot, 'reservations'))[0]!);
    const forged = readFileSync(path, 'utf8').replace('action-1', 'action-X');
    unlinkSync(path); writeFileSync(path, forged, { mode: 0o600 });
    await expect(new DurableAgentGenerationAuthority(state).resume('worker-1', 'action-1'))
      .rejects.toMatchObject({ code: 'corrupt_state' });
  });

  it('detects an in-place same-size reservation mutation across the bigint mtimeNs identity fence', async () => {
    const first = new DurableAgentGenerationAuthority(state); await first.persist(plan(), 'action-1'); let changed = false;
    const restarted = new DurableAgentGenerationAuthority(state, { beforeSecureOpen: path => {
      if (!changed && path.includes('/reservations/')) {
        changed = true; const bytes = readFileSync(path); const index = bytes.indexOf(Buffer.from('action-1'));
        bytes[index + 7] = 'X'.charCodeAt(0); writeFileSync(path, bytes, { mode: 0o600 });
      }
    } });
    await expect(restarted.resume('worker-1', 'action-1')).rejects.toMatchObject({ code: 'unsafe_file' });
  });
});

function providerHarness() {
  const proofs = new WeakMap<object, TrustedAcquisitionProof>();
  const verifications = new WeakMap<object, TrustedIdentityVerification>();
  const ownership = new WeakMap<object, TrustedOwnershipCapability>();
  const effects = new Map<string, string>();
  let creates = 0;
  let verificationOutcome: TrustedIdentityVerification['outcome'] = 'verified';
  let ownershipValid = true;
  const evidence = (bindings: IdentityActionBindings, outcome: TrustedAcquisitionProof['outcome']) => {
    const raw = {}; proofs.set(raw, { ...bindings, outcome,
      ...(outcome === 'created_by_action' ? { receiptDigest: effects.get(bindings.actionKey)! } : {}) }); return raw;
  };
  const provider = {
    supportsIdempotentActionKeys: true as const,
    lookupExisting: vi.fn(async (bindings: IdentityActionBindings) => evidence(bindings, 'existing_before_action')),
    reconcileAcquisition: vi.fn(async (bindings: IdentityActionBindings) =>
      evidence(bindings, effects.has(bindings.actionKey) ? 'created_by_action' : 'not_started')),
    createPersistent: vi.fn(async (bindings: IdentityActionBindings) => {
      if (!effects.has(bindings.actionKey)) { creates += 1; effects.set(bindings.actionKey, `sha256:${'a'.repeat(64)}`); }
      return {};
    }),
    createTemporary: vi.fn(async (bindings: IdentityActionBindings) => {
      if (!effects.has(bindings.actionKey)) { creates += 1; effects.set(bindings.actionKey, `sha256:${'a'.repeat(64)}`); }
      return {};
    }),
    verifyIdentity: vi.fn(async (bindings: IdentityActionBindings & { acquisition: 'external' | 'created' }) => {
      const raw = {}; verifications.set(raw, { ...bindings, outcome: verificationOutcome, provider: 'ours',
        ...(verificationOutcome === 'verified' ? { authenticatedIdentityId: 'identity-1' } : {}),
        evidenceDigest: `sha256:${'b'.repeat(64)}` }); return raw;
    }),
    reconcileReceipt: vi.fn(async (bindings: IdentityActionBindings & { receiptDigest: string }) => {
      const raw = {}; if (ownershipValid)
        ownership.set(raw, { ...bindings, outcome: 'created_by_action', currentOwner: true }); return raw;
    }), removeCreated: vi.fn(), closeTemporary: vi.fn(),
  };
  return { provider, authority: {
    authenticateAcquisition: (raw: unknown) => proofs.get(raw as object),
    authenticateVerification: (raw: unknown) => verifications.get(raw as object),
    authenticateOwnership: (raw: unknown) => ownership.get(raw as object),
  }, setVerification(value: TrustedIdentityVerification['outcome']) { verificationOutcome = value; },
  setOwnershipValid(value: boolean) { ownershipValid = value; }, get creates() { return creates; } };
}

function issuedConsumer(): AgentPlanTransactionConsumer {
  const evidence = {} as VerifiedTransactionConsumerEvidence;
  const service = new AgentCompositionService({ authenticateTransactionConsumer: value => value === evidence } as never,
    {} as never, { authenticateAdapterEvidence: () => undefined });
  return service.issueTransactionConsumer(evidence);
}
async function start(
  transaction: AgentCreationTransaction, generations: DurableAgentGenerationAuthority,
  selected: AgentPlan, actionId = 'action-1',
) {
  await generations.persist(selected, actionId);
  return transaction.resume({ agentId: selected.agentId, actionId });
}

describe('idempotent identity acquisition recovery', () => {
  it('issues the transaction consumer only from authenticated evidence and rejects a cloned capability', () => {
    const trusted = new WeakSet<object>(); const evidence = {} as VerifiedTransactionConsumerEvidence;
    trusted.add(evidence as object);
    const service = new AgentCompositionService({
      authenticateTransactionConsumer: value => trusted.has(value as object),
    } as never, {} as never, { authenticateAdapterEvidence: () => undefined });
    expect(() => service.issueTransactionConsumer({} as VerifiedTransactionConsumerEvidence))
      .toThrow(/unauthenticated_caller/u);
    const consumer = service.issueTransactionConsumer(evidence);
    const clone = { ...consumer };
    expect(() => consumePreparedForTransaction(clone as never, {} as never)).toThrow(/foreign_prepared/u);
    const generations = new DurableAgentGenerationAuthority(state);
    expect(() => new AgentCreationTransaction({ consume: () => plan() } as never, generations,
      providerHarness().provider, providerHarness().authority)).toThrow(/invalid_provider/u);
    expect(existsSync(join(state, 'agents'))).toBe(false);
  });

  it('recovers a crash immediately before invocation through authenticated not_started', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const crashing = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority, {
      afterCreateAuthorized: () => { throw new Error('crash'); },
    });
    await expect(start(crashing, generations, plan())).rejects.toThrow('crash');
    const resumed = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    await expect(resumed.resume({ agentId: 'worker-1', actionId: 'action-1' })).resolves.toMatchObject({ state: 'complete' });
    expect(harness.creates).toBe(1);
  });

  it('recovers an effect committed before return/transition without a second effect', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const crashing = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority, {
      afterCreate: () => { throw new Error('crash'); },
    });
    await expect(start(crashing, generations, plan())).rejects.toThrow('crash');
    const resumed = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    await expect(resumed.resume({ agentId: 'worker-1', actionId: 'action-1' })).resolves.toMatchObject({ state: 'complete' });
    expect(harness.creates).toBe(1);
  });

  it('makes concurrent stale replays follow the immutable winner with one provider effect', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const crash = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider,
      harness.authority, { afterCreateAuthorized: () => { throw new Error('crash'); } });
    await expect(start(crash, generations, plan())).rejects.toThrow('crash');
    const left = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    const right = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    const results = await Promise.all([left.resume({ agentId: 'worker-1', actionId: 'action-1' }),
      right.resume({ agentId: 'worker-1', actionId: 'action-1' })]);
    expect(results.map(value => value.state)).toEqual(['complete', 'complete']); expect(harness.creates).toBe(1);
  });

  it('makes unknown terminally ambiguous with no create effect', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const unknowns = new WeakMap<object, TrustedAcquisitionProof>();
    harness.provider.reconcileAcquisition.mockImplementation(async bindings => {
      const raw = {}; unknowns.set(raw, { ...bindings, outcome: 'unknown' }); return raw;
    });
    const transaction = new AgentCreationTransaction(issuedConsumer(), generations,
      harness.provider, { authenticateAcquisition: raw => unknowns.get(raw as object),
        authenticateVerification: harness.authority.authenticateVerification,
        authenticateOwnership: () => undefined });
    await expect(start(transaction, generations, plan())).resolves.toMatchObject({ state: 'ambiguous' });
    expect(harness.creates).toBe(0);
  });

  it('requires a receipt exactly for created_by_action and forbids foreign receipts on other outcomes', async () => {
    for (const kind of ['missing-created', 'foreign-existing'] as const) {
      const generations = new DurableAgentGenerationAuthority(join(state, kind)); const harness = providerHarness();
      const proofs = new WeakMap<object, TrustedAcquisitionProof>(); let reconciles = 0;
      if (kind === 'missing-created') harness.provider.reconcileAcquisition.mockImplementation(async bindings => {
        const raw = {}; proofs.set(raw, { ...bindings,
          outcome: reconciles++ === 0 ? 'not_started' : 'created_by_action' }); return raw;
      });
      else harness.provider.lookupExisting.mockImplementation(async bindings => {
        const raw = {}; proofs.set(raw, { ...bindings, outcome: 'existing_before_action',
          receiptDigest: `sha256:${'a'.repeat(64)}` }); return raw;
      });
      const selected = plan(1, 'worker-1', kind === 'foreign-existing' ? 'existing' : 'create_temporary');
      const tx = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider,
        { ...harness.authority, authenticateAcquisition: raw => proofs.get(raw as object) });
      await expect(start(tx, generations, selected))
        .rejects.toMatchObject({ code: 'invalid_proof' });
    }
  });

  it.each([
    ['existing', 'lookupExisting', 0],
    ['create_persistent', 'createPersistent', 1],
    ['create_temporary', 'createTemporary', 1],
  ] as const)('routes %s ownership without crossing create/delete authority', async (ownership, method, effects) => {
    const generations = new DurableAgentGenerationAuthority(join(state, ownership)); const harness = providerHarness();
    const selected = plan(1, 'worker-1', ownership);
    const transaction = new AgentCreationTransaction(issuedConsumer(),
      generations, harness.provider, harness.authority);
    const result = await start(transaction, generations, selected);
    expect(result.state).toBe('complete'); expect(harness.creates).toBe(effects);
    expect(harness.provider[method]).toHaveBeenCalledTimes(1);
    if (ownership === 'existing') {
      expect(harness.provider.createPersistent).not.toHaveBeenCalled();
      expect(harness.provider.createTemporary).not.toHaveBeenCalled();
      expect(harness.provider.removeCreated).not.toHaveBeenCalled();
      expect(harness.provider.closeTemporary).not.toHaveBeenCalled();
    }
    const record = generations.authenticate(result.reservation)!;
    const binding = JSON.parse(readFileSync(join(record.canonicalDir, 'identity-binding.json'), 'utf8'));
    expect(binding).toMatchObject({ kind: 'AuthenticatedIdentityBinding', provider: 'ours',
      authenticatedIdentityId: 'identity-1', evidenceDigest: `sha256:${'b'.repeat(64)}`,
      acquisition: ownership === 'existing' ? 'external' : 'created' });
  });

  it('returns complete from authenticated durable artifacts with zero provider calls', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const transaction = new AgentCreationTransaction(issuedConsumer(),
      generations, harness.provider, harness.authority);
    await start(transaction, generations, plan());
    for (const fn of Object.values(harness.provider)) if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    await expect(transaction.resume({ agentId: 'worker-1', actionId: 'action-1' })).resolves.toMatchObject({ state: 'complete' });
    expect(harness.provider.reconcileAcquisition).not.toHaveBeenCalled();
    expect(harness.provider.verifyIdentity).not.toHaveBeenCalled();
    const reservation = await generations.lookup('worker-1', 'action-1');
    chmodSync(join(generations.authenticate(reservation!)!.canonicalDir, 'identity-binding.json'), 0o644);
    await expect(transaction.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
  });

  it('binds snapshot/reservation/actionKey and rejects classification inconsistency on complete replay', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const transaction = new AgentCreationTransaction(issuedConsumer(),
      generations, harness.provider, harness.authority);
    const result = await start(transaction, generations, plan());
    const record = generations.authenticate(result.reservation)!;
    const binding = JSON.parse(readFileSync(join(record.canonicalDir, 'identity-binding.json'), 'utf8'));
    expect(binding).toMatchObject({ snapshotDigest: record.snapshotDigest,
      reservationDigest: record.reservationDigest }); expect(binding.actionKey).toMatch(/^sha256:/u);
    const provenancePath = join(record.canonicalDir, 'creation-provenance.json');
    const inconsistent = readFileSync(provenancePath, 'utf8')
      .replace('created_by_action', 'existing_before_action');
    unlinkSync(provenancePath); writeFileSync(provenancePath, inconsistent, { mode: 0o600 });
    await expect(transaction.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
  });

  it('detects in-place same-size binding mutation across the bigint mtimeNs identity fence', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const first = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    await start(first, generations, plan()); let changed = false;
    const restarted = new AgentCreationTransaction(issuedConsumer(),
      generations, harness.provider, harness.authority, { beforeSecureOpen: path => {
        if (!changed && path.endsWith('/identity-binding.json')) {
          changed = true; const bytes = readFileSync(path); const index = bytes.indexOf(Buffer.from('identity-1'));
          bytes[index + 9] = 'X'.charCodeAt(0); writeFileSync(path, bytes, { mode: 0o600 });
        }
      } });
    await expect(restarted.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
  });

  it('uses a fresh exact ownership capability for compensation and fails closed on mismatch', async () => {
    const firstState = join(state, 'valid'); const first = new DurableAgentGenerationAuthority(firstState);
    const valid = providerHarness(); valid.setVerification('mismatch');
    const compensated = new AgentCreationTransaction(issuedConsumer(), first, valid.provider, valid.authority);
    await expect(start(compensated, first, plan()))
      .resolves.toMatchObject({ state: 'compensated' });
    expect(valid.provider.reconcileReceipt).toHaveBeenCalledTimes(1);
    expect(valid.provider.closeTemporary).toHaveBeenCalledTimes(1);

    const second = new DurableAgentGenerationAuthority(join(state, 'invalid')); const invalid = providerHarness();
    invalid.setVerification('mismatch'); invalid.setOwnershipValid(false);
    const ambiguous = new AgentCreationTransaction(issuedConsumer(), second, invalid.provider, invalid.authority);
    await expect(start(ambiguous, second, plan()))
      .resolves.toMatchObject({ state: 'ambiguous' });
    expect(invalid.provider.closeTemporary).not.toHaveBeenCalled();
  });

  it('restarts from durable compensating and reacquires a fresh receipt capability', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    harness.setVerification('mismatch'); harness.provider.reconcileReceipt.mockRejectedValueOnce(new Error('crash'));
    const first = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    await expect(start(first, generations, plan())).rejects.toThrow('crash');
    const restarted = new AgentCreationTransaction(issuedConsumer(),
      generations, harness.provider, harness.authority);
    await expect(restarted.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .resolves.toMatchObject({ state: 'compensated' });
    expect(harness.provider.reconcileReceipt).toHaveBeenCalledTimes(2);
    expect(harness.provider.closeTemporary).toHaveBeenCalledTimes(1);
  });

  it('never deletes an external identity or compensates after publication conflict', async () => {
    const external = providerHarness(); external.setVerification('mismatch');
    const externalGenerations = new DurableAgentGenerationAuthority(join(state, 'external'));
    const externalTx = new AgentCreationTransaction(issuedConsumer(), externalGenerations, external.provider, external.authority);
    await expect(start(externalTx, externalGenerations, plan(1, 'worker-1', 'existing'), 'external-action'))
      .resolves.toMatchObject({ state: 'ambiguous' });
    expect(external.provider.removeCreated).not.toHaveBeenCalled();
    expect(external.provider.closeTemporary).not.toHaveBeenCalled();

    const generations = new DurableAgentGenerationAuthority(join(state, 'conflict')); const harness = providerHarness();
    const crash = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider,
      harness.authority, { afterCreateAuthorized: () => { throw new Error('crash'); } });
    await expect(start(crash, generations, plan())).rejects.toThrow('crash');
    const reservation = await generations.lookup('worker-1', 'action-1'); const record = generations.authenticate(reservation!)!;
    writeFileSync(join(record.canonicalDir, 'identity-binding.json'), '{}\n', { mode: 0o600 });
    const resumed = new AgentCreationTransaction(issuedConsumer(),
      generations, harness.provider, harness.authority);
    await expect(resumed.resume({ agentId: 'worker-1', actionId: 'action-1' })).resolves.toMatchObject({ state: 'ambiguous' });
    expect(harness.provider.closeTemporary).not.toHaveBeenCalled();
    expect(harness.provider.removeCreated).not.toHaveBeenCalled();
  });

  it('rejects forged acquisition tuple fields and corrupted transition/artifact modes', async () => {
    const forged = new WeakMap<object, TrustedAcquisitionProof>(); const generations = new DurableAgentGenerationAuthority(state);
    const harness = providerHarness(); harness.provider.reconcileAcquisition.mockImplementation(async bindings => {
      const raw = {}; forged.set(raw, { ...bindings, agentId: 'forged', outcome: 'not_started' }); return raw;
    });
    const tx = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, {
      ...harness.authority, authenticateAcquisition: raw => forged.get(raw as object),
    });
    await expect(start(tx, generations, plan()))
      .rejects.toMatchObject({ code: 'invalid_proof' });

    const record = generations.authenticate((await generations.lookup('worker-1', 'action-1'))!)!;
    const transition = join(record.canonicalDir, 'identity-transitions', readdirSync(join(record.canonicalDir, 'identity-transitions'))[0]!);
    chmodSync(transition, 0o644);
    await expect(tx.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
  });

  it('rejects a forged authenticated-identity binding proof before publication', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const forged = new WeakMap<object, TrustedIdentityVerification>();
    harness.provider.verifyIdentity.mockImplementation(async bindings => {
      const raw = {}; forged.set(raw, { ...bindings, agentId: 'other-agent', outcome: 'verified',
        provider: 'ours', authenticatedIdentityId: 'identity-1',
        evidenceDigest: `sha256:${'b'.repeat(64)}` }); return raw;
    });
    const transaction = new AgentCreationTransaction(issuedConsumer(), generations,
      harness.provider, { ...harness.authority, authenticateVerification: raw => forged.get(raw as object) });
    await expect(start(transaction, generations, plan()))
      .rejects.toMatchObject({ code: 'invalid_proof' });
    const reservation = await generations.lookup('worker-1', 'action-1');
    expect(existsSync(join(generations.authenticate(reservation!)!.canonicalDir, 'identity-binding.json'))).toBe(false);
  });

  it('rejects a digest-recomputed canonical acquired event missing its created receipt', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const transaction = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    const result = await start(transaction, generations, plan()); const record = generations.authenticate(result.reservation)!;
    rewriteTransitionChain(record.canonicalDir, value => {
      if (value.state === 'acquired') delete (value.event as Record<string, unknown>).receiptDigest;
    });
    for (const fn of Object.values(harness.provider)) if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    await expect(transaction.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
    expect(harness.provider.reconcileAcquisition).not.toHaveBeenCalled();
  });

  it('binds complete artifacts to the exact recomputed acquired and verified chain classification', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const transaction = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    const result = await start(transaction, generations, plan()); const record = generations.authenticate(result.reservation)!;
    rewriteTransitionChain(record.canonicalDir, value => {
      const event = value.event as Record<string, unknown>;
      if (value.state === 'acquired') { event.outcome = 'existing_before_action'; delete event.receiptDigest; }
      if (value.state === 'verified') event.acquisition = 'external';
    });
    for (const fn of Object.values(harness.provider)) if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    await expect(transaction.resume({ agentId: 'worker-1', actionId: 'action-1' }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
    expect(harness.provider.reconcileAcquisition).not.toHaveBeenCalled();
    expect(harness.provider.verifyIdentity).not.toHaveBeenCalled();
  });

  it('issues an opaque authenticated completion capability bound to the exact durable creation', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const transaction = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    const result = await start(transaction, generations, plan());
    const evidence = transaction.validateComplete(result.reservation);
    expect(transaction.authenticateComplete(evidence)).toMatchObject({
      actionId: 'action-1', agentId: 'worker-1', generation: 1,
      reservationDigest: result.reservation.reservationDigest,
      identity: { provider: 'ours', authenticatedIdentityId: 'identity-1', acquisition: 'created' },
    });
    expect(transaction.authenticateComplete({ ...evidence } as never)).toBeUndefined();
    expect(transaction.authenticateComplete({} as never)).toBeUndefined();
    const restarted = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    expect(restarted.authenticateComplete(evidence)).toBeUndefined();
    expect(restarted.authenticateComplete(restarted.validateComplete(result.reservation))).toBeDefined();
  });

  it('does not let previously issued completion evidence substitute for fresh durable validation', async () => {
    const generations = new DurableAgentGenerationAuthority(state); const harness = providerHarness();
    const transaction = new AgentCreationTransaction(issuedConsumer(), generations, harness.provider, harness.authority);
    const result = await start(transaction, generations, plan());
    const earlier = transaction.validateComplete(result.reservation);
    expect(transaction.authenticateComplete(earlier)).toBeDefined();
    const record = generations.authenticate(result.reservation)!;
    chmodSync(join(record.canonicalDir, 'identity-binding.json'), 0o644);
    await expect(() => transaction.validateComplete(result.reservation))
      .toThrow(expect.objectContaining({ code: 'corrupt_state' }));
  });
});
