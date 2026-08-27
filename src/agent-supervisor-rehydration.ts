import { createHash } from 'node:crypto';
import type { TrustedAdapterPolicySource } from './agent-composition-service.js';
import { DurableAgentCreationCompletionAuthority } from './agent-creation-transaction.js';
import { DurableAgentGenerationReader } from './agent-generation-reservation.js';
import { readStoredAgentPlan } from './agent-plan-store.js';
import { readAgentStartLocator, type AgentStartLocatorExpectedBindings } from './agent-start-locator.js';
import { readAgentSupervisorHandoff } from './agent-supervisor-handoff.js';
import { AgentRuntimeRecordStore, runtimeCanonical, runtimeDigest } from './agent-runtime-record.js';
import { AgentRuntimeTransaction, type RuntimeOperationAuthority, type TrustedRuntimeOperationRequest,
  type VerifiedRuntimeOperationRequest } from './agent-runtime-transaction.js';
import { AgentRuntimePreparationAuthority, AuthenticatedAgentRuntimeProvider,
  RecordedAgentRuntimePlanAuthority, attachRuntimePreparation,
  type AgentRuntimeDriverFactory, type AgentRuntimeReconciliationAuthority,
  type DurableRuntimeAdapterDescriptor } from './agent-runtime-provider.js';
import { BrainAdapterPreparationAuthority, type BrainAdapterEvidenceAuthority } from './harness/brain-adapter.js';

export interface PermanentAgentSupervisorSeam {
  readonly agentId: string;
  readonly generation: number;
  start(): Promise<Readonly<{ state: string; runtimeInstanceKey: string }>>;
  restore(reason: string): Promise<Readonly<{ state: string; runtimeInstanceKey: string }>>;
}
export interface ProductionAgentSupervisorRehydration {
  rehydrate(agentId: string): PermanentAgentSupervisorSeam;
}
export interface ProductionAgentSupervisorRehydrationDeps {
  trustedStateRoot: string;
  policies: TrustedAdapterPolicySource;
  adapterAuthority: BrainAdapterEvidenceAuthority;
  driverFactory: AgentRuntimeDriverFactory;
  reconciliation: AgentRuntimeReconciliationAuthority;
  now?: () => number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const digest = (value: unknown): string => `sha256:${createHash('sha256')
  .update(runtimeCanonical(value)).digest('hex')}`;

/** Construct a read-only rehydrator. No trusted directory or external runtime is touched here. */
export function createProductionAgentSupervisorRehydration(
  deps: ProductionAgentSupervisorRehydrationDeps,
): ProductionAgentSupervisorRehydration {
  if (!deps || typeof deps !== 'object' || typeof deps.trustedStateRoot !== 'string'
      || !deps.policies || !deps.adapterAuthority) throw new TypeError('invalid supervisor rehydration dependencies');
  const generations = new DurableAgentGenerationReader(deps.trustedStateRoot);
  const completions = new DurableAgentCreationCompletionAuthority(generations);
  const plans = new RecordedAgentRuntimePlanAuthority(completions);
  const brains = new BrainAdapterPreparationAuthority(deps.adapterAuthority);
  const preparations = new AgentRuntimePreparationAuthority(brains, plans);
  const now = deps.now ?? Date.now;

  const rehydrate = (agentId: string): PermanentAgentSupervisorSeam => {
    if (!TOKEN.test(agentId)) throw new TypeError('invalid supervisor agent id');
    const active = readAgentSupervisorHandoff(deps.trustedStateRoot, agentId);
    const reservation = generations.readExact(active);
    const completeEvidence = completions.validateComplete(reservation);
    const complete = completions.authenticateComplete(completeEvidence);
    if (!complete) throw new TypeError('supervisor completion unavailable');
    const plan = readStoredAgentPlan(complete.canonicalDir, complete, 'supervisor-rehydration').plan;
    if (plan.identity.name !== complete.identity.name || plan.identity.ownership !== complete.identity.ownership
        || active.identityEvidenceDigest !== complete.identity.evidenceDigest)
      throw new TypeError('supervisor identity binding mismatch');
    const expected: AgentStartLocatorExpectedBindings = { schemaVersion: 1, kind: 'AgentStartLocator',
      agentId: complete.agentId, actionId: complete.actionId, generation: complete.generation,
      planDigest: complete.planDigest, snapshotDigest: complete.snapshotDigest,
      reservationDigest: complete.reservationDigest, authorizationRevision: plan.authorizationRevision,
      lifetime: 'persistent', identityEvidenceDigest: complete.identity.evidenceDigest };
    const locator = readAgentStartLocator(complete.canonicalDir, expected);
    if (locator.locatorDigest !== active.locatorDigest) throw new TypeError('supervisor locator mismatch');
    const policy = deps.policies.resolvePolicy(plan.brain, plan.permissions);
    if (policy.policy.revision !== plan.adapter.policyRevision
        || policy.policy.digest !== plan.adapter.policyDigest)
      throw new TypeError('supervisor policy mismatch');
    const planEvidence = plans.resolve(reservation);
    const descriptorValue = Object.freeze({ schemaVersion: 1, adapterId: plan.adapter.adapterId,
      adapterVersion: plan.adapter.adapterVersion, policyDigest: plan.adapter.policyDigest,
      native: plan.adapter.nativeDescriptor });
    const descriptor: DurableRuntimeAdapterDescriptor = Object.freeze({ adapterId: plan.adapter.adapterId,
      adapterVersion: plan.adapter.adapterVersion, policyDigest: plan.adapter.policyDigest,
      descriptorDigest: runtimeDigest(runtimeCanonical(descriptorValue)), descriptor: descriptorValue });
    const preparation = preparations.prepare(planEvidence, policy, descriptor);
    const resolved = attachRuntimePreparation(descriptor, preparation);
    const adapters = { resolve: (value: typeof complete) => {
      if (runtimeCanonical(value) !== runtimeCanonical(complete)) throw new TypeError('supervisor completion mismatch');
      return resolved;
    } };
    const requests = new WeakMap<object, Readonly<TrustedRuntimeOperationRequest>>();
    const operations: RuntimeOperationAuthority = { authenticateRequest: evidence => requests.get(evidence as object) };
    const provider = new AuthenticatedAgentRuntimeProvider(preparations, complete, deps.driverFactory, deps.reconciliation);
    const transaction = new AgentRuntimeTransaction(completions, operations, adapters, provider, provider,
      new AgentRuntimeRecordStore());
    const issue = (operation: 'start' | 'restore', reason?: string): VerifiedRuntimeOperationRequest => {
      const evidence = Object.freeze({}) as VerifiedRuntimeOperationRequest;
      const requestActionId = digest({ kind: `supervisor.${operation}`, agentId: complete.agentId,
        generation: complete.generation, reservationDigest: complete.reservationDigest }).slice(7);
      requests.set(evidence as object, Object.freeze({ operation, requestActionId,
        authorizationRevision: plan.authorizationRevision, principal: Object.freeze({ id: 'system', kind: 'system' }),
        agentId: complete.agentId, generation: complete.generation, planDigest: complete.planDigest,
        reservationDigest: complete.reservationDigest, issuedAt: now(),
        ...(reason === undefined ? {} : { recoveryReason: reason }) }));
      return evidence;
    };
    const seam = Object.freeze({ agentId: complete.agentId,
      generation: complete.generation,
      start: () => transaction.start(reservation, issue('start')),
      restore: (reason: string) => transaction.restore(reservation, issue('restore', reason)) });
    return seam;
  };
  return Object.freeze({ rehydrate });
}
