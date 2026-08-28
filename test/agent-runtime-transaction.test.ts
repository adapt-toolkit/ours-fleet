import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { VerifiedGenerationReservation } from '../src/agent-generation-reservation.js';
import type { AgentCreationCompletionAuthority, CompleteAgentCreationBindings,
  VerifiedCompleteAgentCreation } from '../src/agent-creation-transaction.js';
import { AgentRuntimeRecordStore, runtimeCanonical, runtimeDigest } from '../src/agent-runtime-record.js';
import { AgentRuntimeTransaction, type RuntimeOperationAuthority, type RuntimeProviderEvidenceAuthority,
  type TrustedRuntimeOperationRequest, type VerifiedRuntimeOperationRequest } from '../src/agent-runtime-transaction.js';

let root: string;
let canonicalDir: string;
const reservation = {
  agentId: 'worker-1', generation: 1, planDigest: `sha256:${'1'.repeat(64)}`,
  snapshotDigest: `sha256:${'2'.repeat(64)}`, reservationDigest: `sha256:${'3'.repeat(64)}`,
} as VerifiedGenerationReservation;
const complete: CompleteAgentCreationBindings = {
  actionId: 'create-1', ...reservation, canonicalDir: '', identity: {
    name: 'worker-1', ownership: 'existing', provider: 'ours', authenticatedIdentityId: 'identity-1',
    evidenceDigest: `sha256:${'4'.repeat(64)}`, acquisition: 'external',
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-runtime-transaction-'));
  const agentRoot = join(root, 'agents', Buffer.from(reservation.agentId).toString('base64url'));
  canonicalDir = join(agentRoot, 'generations', 'canonical', '1');
  mkdirSync(canonicalDir, { recursive: true, mode: 0o700 });
  for (let cursor = canonicalDir;; cursor = dirname(cursor)) {
    chmodSync(cursor, 0o700); if (cursor === root) break;
  }
  complete.canonicalDir = canonicalDir;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(records: AgentRuntimeRecordStore) {
  const completionEvidence = {} as VerifiedCompleteAgentCreation;
  const completion: AgentCreationCompletionAuthority = {
    validateComplete: vi.fn(() => completionEvidence),
    authenticateComplete: vi.fn(value => value === completionEvidence ? Object.freeze({ ...complete,
      identity: Object.freeze({ ...complete.identity }) }) : undefined),
  };
  const requestEvidence = {} as VerifiedRuntimeOperationRequest;
  const request: TrustedRuntimeOperationRequest = {
    operation: 'start', requestActionId: 'start-1', authorizationRevision: 'auth-1',
    principal: { id: 'owner-1', kind: 'owner' }, agentId: reservation.agentId,
    generation: reservation.generation, planDigest: reservation.planDigest,
    reservationDigest: reservation.reservationDigest, issuedAt: 1,
  };
  const operations: RuntimeOperationAuthority = {
    authenticateRequest: value => value === requestEvidence ? request : undefined,
  };
  let started = false; let readinessOutcome: 'ready'|'not_ready'|'unknown' = 'ready';
  const startProofs = new WeakMap<object, object>(); const readinessProofs = new WeakMap<object, object>();
  const restoreProofs = new WeakMap<object, object>(); const retireProofs = new WeakMap<object, object>();
  const currentProofs = new WeakMap<object, object>();
  const descriptor = Object.freeze({ mode: 'inert' });
  const preparationEvidence = Object.freeze({ secret: 'process-only-secret', toJSON: () => { throw new Error('opaque'); } });
  const provider = {
    supportsIdempotentRuntimeActionKeys: true as const,
    reconcileStart: vi.fn(async (input: Record<string, unknown>) => { const raw = {};
      startProofs.set(raw, started ? { runtimeInstanceKey: input.runtimeInstanceKey, startEffectKey: input.startEffectKey,
        outcome: 'started_by_action', provider: 'inert', providerRuntimeId: 'runtime-1',
        startEvidenceDigest: `sha256:${'7'.repeat(64)}`,
        receiptDigest: runtimeDigest(runtimeCanonical({ kind: 'start-receipt',
          runtimeInstanceKey: input.runtimeInstanceKey, startEffectKey: input.startEffectKey,
          sessionLocator: 'session-1', sessionMetadataDigest: `sha256:${'6'.repeat(64)}` })),
        sessionLocator: 'session-1', sessionMetadataDigest: `sha256:${'6'.repeat(64)}` }
        : { runtimeInstanceKey: input.runtimeInstanceKey, startEffectKey: input.startEffectKey,
          outcome: 'not_started', provider: 'inert' }); return raw; }),
    startBrain: vi.fn(async () => { started = true; return {}; }),
    checkReadiness: vi.fn(async (input: Record<string, unknown>) => { const raw = {}; readinessProofs.set(raw,
      { runtimeInstanceKey: input.runtimeInstanceKey, startEffectKey: input.startEffectKey,
        providerRuntimeId: input.providerRuntimeId, outcome: readinessOutcome, evidenceDigest: `sha256:${'9'.repeat(64)}` }); return raw; }),
    reconcileRestore: vi.fn(async (input: Record<string, unknown>) => { const raw = {}; restoreProofs.set(raw,
      { runtimeInstanceKey: input.runtimeInstanceKey, startEffectKey: input.startEffectKey,
        providerRuntimeId: input.providerRuntimeId, outcome: 'current_exact', evidenceDigest: `sha256:${'a'.repeat(64)}` }); return raw; }),
    reconcileRetire: vi.fn(async (input: Record<string, unknown>) => { const raw = {}; retireProofs.set(raw,
      { runtimeInstanceKey: input.runtimeInstanceKey, retireEffectKey: input.retireEffectKey,
        providerRuntimeId: input.providerRuntimeId, outcome: 'current_exact', evidenceDigest: `sha256:${'b'.repeat(64)}` }); return raw; }),
    acquireCurrent: vi.fn(async (input: Record<string, unknown>) => { const raw = {}; currentProofs.set(raw,
      { runtimeInstanceKey: input.runtimeInstanceKey, retireEffectKey: input.retireEffectKey,
        providerRuntimeId: input.providerRuntimeId, currentOwner: true }); return raw; }),
    retire: vi.fn(async () => undefined),
  };
  const proofs: RuntimeProviderEvidenceAuthority = {
    authenticateStart: raw => startProofs.get(raw as object) as never,
    authenticateRestore: raw => restoreProofs.get(raw as object) as never,
    authenticateReadiness: raw => readinessProofs.get(raw as object) as never,
    authenticateRetire: raw => retireProofs.get(raw as object) as never,
    consumeCurrent: raw => {
      const value = currentProofs.get(raw as object) as never;
      currentProofs.delete(raw as object);
      return value;
    },
  };
  const transaction = new AgentRuntimeTransaction(completion, operations, {
    resolve: () => ({ durable: { adapterId: 'codex', adapterVersion: '1', policyDigest: `sha256:${'5'.repeat(64)}`,
      descriptorDigest: runtimeDigest(runtimeCanonical(descriptor)), descriptor }, preparationEvidence }),
  }, provider, proofs, records);
  return { transaction, requestEvidence, request, completion, provider, proofs,
    preparationEvidence,
    setReadinessOutcome: (value: typeof readinessOutcome) => { readinessOutcome = value; } };
}

describe('runtime admission prerequisite reread', () => {
  it('freshly validates completion again under the active lock before claim or provider effect', async () => {
    const records = new AgentRuntimeRecordStore(); const h = harness(records);
    let calls = 0;
    vi.mocked(h.completion.validateComplete).mockImplementation(() => {
      calls += 1; if (calls === 2) throw new Error('durable creation corrupted');
      return {} as VerifiedCompleteAgentCreation;
    });
    vi.mocked(h.completion.authenticateComplete).mockImplementation(() => Object.freeze({ ...complete,
      identity: Object.freeze({ ...complete.identity }) }));
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toThrow('durable creation corrupted');
    expect(h.completion.validateComplete).toHaveBeenCalledTimes(2);
    expect(h.provider.reconcileStart).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(dirname(dirname(canonicalDir))), 'runtime-active-claim.json'))).toBe(false);
    expect(existsSync(join(canonicalDir, 'runtime-launch-transitions'))).toBe(false);
  });

  it('securely rereads the durable prerequisite under lock and fails before claim on mode corruption', async () => {
    let corrupted = false;
    const records = new AgentRuntimeRecordStore({ beforeSecureOpen: path => {
      if (!corrupted && path.includes('runtime-prerequisites')) { corrupted = true; chmodSync(path, 0o644); }
    } });
    const h = harness(records);
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'unsafe' });
    expect(h.provider.reconcileStart).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(dirname(dirname(canonicalDir))), 'runtime-active-claim.json'))).toBe(false);
    expect(existsSync(join(canonicalDir, 'runtime-launch-transitions'))).toBe(false);
  });
});

describe('started transition crash recovery', () => {
  it('repairs missing runtime artifacts from the authenticated started event without a second start effect', async () => {
    let crash = true;
    const records = new AgentRuntimeRecordStore({ afterTransition: state => {
      if (state === 'started' && crash) { crash = false; throw new Error('crash after started'); }
    } });
    const h = harness(records);
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toThrow('crash after started');
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
    expect(existsSync(join(canonicalDir, 'runtime-binding.json'))).toBe(false);
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ready' });
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
    expect(existsSync(join(canonicalDir, 'runtime-binding.json'))).toBe(true);
    expect(existsSync(join(canonicalDir, 'runtime-provenance.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(canonicalDir, 'runtime-binding.json'), 'utf8'))).toMatchObject({
      sessionLocator: 'session-1', sessionMetadataDigest: `sha256:${'6'.repeat(64)}`,
    });
  });

  it('serializes concurrent replay so the provider start effect occurs at most once', async () => {
    const h = harness(new AgentRuntimeRecordStore());
    const [first, second] = await Promise.all([
      h.transaction.start(reservation, h.requestEvidence),
      h.transaction.start(reservation, h.requestEvidence),
    ]);
    expect(first.state).toBe('ready'); expect(second.state).toBe('ready');
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
  });

  it('keeps not-ready terminal replay inert', async () => {
    const h = harness(new AgentRuntimeRecordStore()); h.setReadinessOutcome('not_ready');
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'not_ready' });
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'not_ready' });
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
    expect(h.provider.checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('keeps ambiguous readiness terminal replay inert', async () => {
    const h = harness(new AgentRuntimeRecordStore()); h.setReadinessOutcome('unknown');
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ambiguous' });
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ambiguous' });
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
    expect(h.provider.checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('repairs a missing artifact on terminal replay from the authenticated started event', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    unlinkSync(join(canonicalDir, 'runtime-provenance.json'));
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ready' });
    expect(existsSync(join(canonicalDir, 'runtime-provenance.json'))).toBe(true);
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
  });

  it('repairs a provenance-only publication by recreating the missing binding', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    unlinkSync(join(canonicalDir, 'runtime-binding.json'));
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ready' });
    expect(existsSync(join(canonicalDir, 'runtime-binding.json'))).toBe(true);
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
  });

  it('will not repair artifacts from a started transition whose receipt mismatches metadata', async () => {
    let crash = true; const records = new AgentRuntimeRecordStore({ afterTransition: state => {
      if (state === 'started' && crash) { crash = false; throw new Error('crash after started'); }
    } });
    const h = harness(records);
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toThrow('crash after started');
    const dir = records.chainDir(canonicalDir, 'launch', 'start-1');
    const path = join(dir, readdirSync(dir).find(name => name.endsWith('-started.json'))!);
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    (value.event as Record<string, unknown>).receiptDigest = `sha256:${'0'.repeat(64)}`;
    const { digest: _digest, ...unsigned } = value; value.digest = runtimeDigest(runtimeCanonical(unsigned));
    unlinkSync(path); writeFileSync(path, `${runtimeCanonical(value)}\n`, { mode: 0o600 });
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'invalid_proof' });
    expect(existsSync(join(canonicalDir, 'runtime-binding.json'))).toBe(false);
    expect(existsSync(join(canonicalDir, 'runtime-provenance.json'))).toBe(false);
  });

  it('converges after the durable start index is published but before transitions', async () => {
    let crash = true;
    const records = new AgentRuntimeRecordStore({ afterOperationIndex: operation => {
      if (operation === 'start' && crash) { crash = false; throw new Error('crash after index'); }
    } });
    const h = harness(records);
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toThrow('crash after index');
    expect(h.provider.startBrain).not.toHaveBeenCalled();
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ready' });
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
  });

  it('rejects a different start action for the claimed generation without another provider effect', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    h.request.requestActionId = 'different-start-action';
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'corrupt' });
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
  });
});

describe('operation authority bounds', () => {
  it('owns the authenticated request before any awaited or callback-driven work', async () => {
    const h = harness(new AgentRuntimeRecordStore());
    const validEvidence = h.completion.validateComplete(reservation);
    vi.mocked(h.completion.validateComplete).mockImplementation(() => {
      h.request.requestActionId = 'mutated-after-authentication';
      h.request.authorizationRevision = 'mutated-revision';
      return validEvidence;
    });
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ready' });
    expect(h.provider.startBrain).toHaveBeenCalledWith(expect.objectContaining({
      runtimeInstanceKey: expect.stringMatching(/^sha256:/u),
    }), h.preparationEvidence);
    expect(existsSync(join(canonicalDir, 'runtime-launch-transitions'))).toBe(true);
    expect(readFileSync(join(canonicalDir, 'runtime-binding.json'), 'utf8')).not.toContain('process-only-secret');
    expect(readFileSync(join(canonicalDir, 'runtime-provenance.json'), 'utf8')).not.toContain('process-only-secret');
  });

  it('rejects agent-authorized retire and non-system restore before filesystem or provider effects', async () => {
    const h = harness(new AgentRuntimeRecordStore());
    h.request.operation = 'retire'; h.request.principal = { id: 'worker-1', kind: 'agent' };
    await expect(h.transaction.retire(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'unauthorized' });
    h.request.operation = 'restore'; h.request.principal = { id: 'owner-1', kind: 'owner' };
    h.request.recoveryReason = 'recover';
    await expect(h.transaction.restore(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.completion.validateComplete).not.toHaveBeenCalled();
    expect(h.provider.reconcileRestore).not.toHaveBeenCalled();
    expect(h.provider.reconcileRetire).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(dirname(dirname(canonicalDir))), 'runtime-prerequisites'))).toBe(false);
  });

  it('rejects unbounded recovery reasons and start requests carrying recovery metadata', async () => {
    const h = harness(new AgentRuntimeRecordStore());
    h.request.operation = 'restore'; h.request.principal = { id: 'system-1', kind: 'system' };
    h.request.recoveryReason = 'x'.repeat(513);
    await expect(h.transaction.restore(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'unauthorized' });
    h.request.operation = 'start'; h.request.principal = { id: 'owner-1', kind: 'owner' };
    h.request.recoveryReason = 'cross-operation';
    await expect(h.transaction.start(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.completion.validateComplete).not.toHaveBeenCalled();
    expect(h.provider.startBrain).not.toHaveBeenCalled();
  });
});

describe('restore and retire durable operation chains', () => {
  it('restores the exact runtime instance and terminal replay has zero additional provider calls', async () => {
    const h = harness(new AgentRuntimeRecordStore());
    await expect(h.transaction.start(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ready' });
    h.request.operation = 'restore'; h.request.requestActionId = 'restore-1';
    h.request.principal = { id: 'system-1', kind: 'system' }; h.request.recoveryReason = 'supervisor recovery';
    await expect(h.transaction.restore(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'restored' });
    expect(h.provider.reconcileRestore).toHaveBeenCalledTimes(1);
    expect(h.provider.startBrain).toHaveBeenCalledTimes(1);
    await expect(h.transaction.restore(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'restored' });
    expect(h.provider.reconcileRestore).toHaveBeenCalledTimes(1);
  });

  it('retires only through an authenticated current-owner capability and terminal replay is inert', async () => {
    const h = harness(new AgentRuntimeRecordStore());
    await h.transaction.start(reservation, h.requestEvidence);
    h.request.operation = 'retire'; h.request.requestActionId = 'retire-1';
    h.request.principal = { id: 'owner-1', kind: 'owner' };
    await expect(h.transaction.retire(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'retired' });
    expect(h.provider.acquireCurrent).toHaveBeenCalledTimes(1); expect(h.provider.retire).toHaveBeenCalledTimes(1);
    await expect(h.transaction.retire(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'retired' });
    expect(h.provider.acquireCurrent).toHaveBeenCalledTimes(1); expect(h.provider.retire).toHaveBeenCalledTimes(1);
  });

  it('records an uncertain retire effect as terminal ambiguous and never repeats it', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    h.request.operation = 'retire'; h.request.requestActionId = 'retire-uncertain';
    h.request.principal = { id: 'owner-1', kind: 'owner' };
    h.provider.retire.mockRejectedValueOnce(new Error('provider disconnected after effect'));
    await expect(h.transaction.retire(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ambiguous' });
    await expect(h.transaction.retire(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ambiguous' });
    expect(h.provider.acquireCurrent).toHaveBeenCalledTimes(1);
    expect(h.provider.retire).toHaveBeenCalledTimes(1);
  });

  it('converges restore after its durable operation index is published', async () => {
    let crash = true;
    const records = new AgentRuntimeRecordStore({ afterOperationIndex: operation => {
      if (operation === 'restore' && crash) { crash = false; throw new Error('crash after restore index'); }
    } });
    const h = harness(records); await h.transaction.start(reservation, h.requestEvidence);
    h.request.operation = 'restore'; h.request.requestActionId = 'restore-index-crash';
    h.request.principal = { id: 'system-1', kind: 'system' }; h.request.recoveryReason = 'recovery';
    await expect(h.transaction.restore(reservation, h.requestEvidence)).rejects.toThrow('crash after restore index');
    expect(h.provider.reconcileRestore).not.toHaveBeenCalled();
    await expect(h.transaction.restore(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'restored' });
    expect(h.provider.reconcileRestore).toHaveBeenCalledTimes(1);
  });

  it('requires a freshly consumed exact current-runtime capability before retire', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    h.request.operation = 'retire'; h.request.requestActionId = 'retire-no-owner';
    h.request.principal = { id: 'owner-1', kind: 'owner' };
    vi.spyOn(h.proofs, 'consumeCurrent').mockReturnValue(undefined);
    await expect(h.transaction.retire(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ambiguous' });
    expect(h.provider.retire).not.toHaveBeenCalled();
    await expect(h.transaction.retire(reservation, h.requestEvidence)).resolves.toMatchObject({ state: 'ambiguous' });
    expect(h.provider.acquireCurrent).toHaveBeenCalledTimes(1);
  });

  it('freshly validates creation under lock for restore and fails with zero restore effect', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    h.request.operation = 'restore'; h.request.requestActionId = 'restore-corrupt';
    h.request.principal = { id: 'system-1', kind: 'system' }; h.request.recoveryReason = 'recovery';
    const validEvidence = h.completion.validateComplete(reservation);
    let calls = 0; vi.mocked(h.completion.validateComplete).mockImplementation(() => {
      calls += 1; if (calls === 2) throw new Error('corrupt under lock');
      return validEvidence;
    });
    await expect(h.transaction.restore(reservation, h.requestEvidence)).rejects.toThrow('corrupt under lock');
    expect(h.provider.reconcileRestore).not.toHaveBeenCalled();
  });

  it('freshly validates creation under lock for retire and fails with zero retire effect', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    h.request.operation = 'retire'; h.request.requestActionId = 'retire-corrupt';
    h.request.principal = { id: 'owner-1', kind: 'owner' };
    const validEvidence = h.completion.validateComplete(reservation);
    let calls = 0; vi.mocked(h.completion.validateComplete).mockImplementation(() => {
      calls += 1; if (calls === 2) throw new Error('corrupt under lock'); return validEvidence;
    });
    await expect(h.transaction.retire(reservation, h.requestEvidence)).rejects.toThrow('corrupt under lock');
    expect(h.provider.reconcileRetire).not.toHaveBeenCalled();
    expect(h.provider.acquireCurrent).not.toHaveBeenCalled();
    expect(h.provider.retire).not.toHaveBeenCalled();
  });

  it('rejects corrupted runtime artifacts before restore provider effects', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    const path = join(canonicalDir, 'runtime-binding.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.extra = 'forged'; unlinkSync(path);
    writeFileSync(path, `${runtimeCanonical(value)}\n`, { mode: 0o600 });
    h.request.operation = 'restore'; h.request.requestActionId = 'restore-forged';
    h.request.principal = { id: 'system-1', kind: 'system' }; h.request.recoveryReason = 'recovery';
    await expect(h.transaction.restore(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'corrupt' });
    expect(h.provider.reconcileRestore).not.toHaveBeenCalled();
  });

  it('rejects a recomputed session metadata substitution before restore effects', async () => {
    const h = harness(new AgentRuntimeRecordStore()); await h.transaction.start(reservation, h.requestEvidence);
    const path = join(canonicalDir, 'runtime-binding.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.sessionLocator = 'foreign-session'; unlinkSync(path);
    writeFileSync(path, `${runtimeCanonical(value)}\n`, { mode: 0o600 });
    h.request.operation = 'restore'; h.request.requestActionId = 'restore-substituted';
    h.request.principal = { id: 'system-1', kind: 'system' }; h.request.recoveryReason = 'recovery';
    await expect(h.transaction.restore(reservation, h.requestEvidence)).rejects.toMatchObject({ code: 'corrupt' });
    expect(h.provider.reconcileRestore).not.toHaveBeenCalled();
  });
});
