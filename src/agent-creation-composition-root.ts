import {
  AgentCompositionError, AgentCompositionService,
  type AgentCompositionAuthority, type AgentCompositionRequest,
  type TrustedAdapterPolicySource, type TrustedCompositionContext,
  type VerifiedCreationCallerEvidence, type VerifiedTransactionConsumerEvidence,
} from './agent-composition-service.js';
import {
  AgentCreationTransaction, type AgentCreationResult,
} from './agent-creation-transaction.js';
import {
  AgentStartLocatorPublisher, type AgentStartLocator,
} from './agent-start-locator.js';
import { DurableAgentGenerationAuthority } from './agent-generation-reservation.js';
import { AgentProductionIdentityAuthority } from './agent-production-identity-authority.js';
import type { AgentPlanEvidenceAuthority, PlanOperation } from './agent-plan.js';
import type { BrainAdapterEvidenceAuthority } from './harness/brain-adapter.js';
import type { ConfigResourceSnapshot } from './config-resource-loader.js';
import type { IdentityProvisioner, IdentityProvisionProfile } from './creation.js';

export interface PermanentAgentCreationResult extends AgentCreationResult {
  locator?: Readonly<AgentStartLocator>;
  identityAcquisition?: 'external' | 'created';
  identityName?: string;
}

/**
 * Production handoff root for persistent Agent creation. It intentionally owns
 * no temporary lifecycle and publishes a locator only after authenticated Complete.
 */
export class AgentCreationCompositionRoot {
  readonly #locators: AgentStartLocatorPublisher;

  constructor(
    private readonly composition: AgentCompositionService,
    private readonly transaction: AgentCreationTransaction,
    locators: AgentStartLocatorPublisher = new AgentStartLocatorPublisher(transaction),
  ) { this.#locators = locators; }

  async createPermanent(
    request: AgentCompositionRequest, actionId: string,
  ): Promise<PermanentAgentCreationResult> {
    const prepared = this.composition.prepare(request);
    if (prepared.lifecycle !== 'persistent' || prepared.identity.ownership === 'create_temporary'
        || prepared.operation.id !== actionId)
      throw new AgentCompositionError('invalid_request');
    const result = await this.transaction.persistPrepared(prepared, { actionId });
    return this.#finish(result);
  }

  async resumePermanent(agentId: string, actionId: string): Promise<PermanentAgentCreationResult> {
    return this.#finish(await this.transaction.resume({ agentId, actionId }));
  }

  #finish(result: AgentCreationResult): PermanentAgentCreationResult {
    if (result.state !== 'complete') return result;
    const complete = this.transaction.validateComplete(result.reservation);
    const authenticated = this.transaction.authenticateComplete(complete);
    if (!authenticated) throw new AgentCompositionError('invalid_context');
    return { ...result, locator: this.#locators.publish(complete),
      identityAcquisition: authenticated.identity.acquisition,
      identityName: authenticated.identity.name };
  }
}

export interface ProductionIngressContext {
  operation: Readonly<PlanOperation>;
  authorizationRevision: string;
  snapshot: ConfigResourceSnapshot;
  snapshotRevision: string;
  issuedAt: number;
}
export interface ProductionAgentCreationIngress {
  direct(context: ProductionIngressContext): VerifiedCreationCallerEvidence;
  managed(callerAgentId: string, context: ProductionIngressContext): VerifiedCreationCallerEvidence;
}
export interface ProductionAgentCreationDeps {
  trustedStateRoot: string;
  identityProvisioner: IdentityProvisioner;
  identityProfile: IdentityProvisionProfile;
  policies: TrustedAdapterPolicySource;
  adapterAuthority: BrainAdapterEvidenceAuthority;
  planEvidence?: AgentPlanEvidenceAuthority;
  now?: () => number;
}
export interface ProductionAgentCreationAssembly {
  root: AgentCreationCompositionRoot;
  ingress: ProductionAgentCreationIngress;
}

function ownIngress(context: ProductionIngressContext): Omit<TrustedCompositionContext, 'principal'> {
  const keys = ['operation', 'authorizationRevision', 'snapshot', 'snapshotRevision', 'issuedAt'];
  if (!context || typeof context !== 'object' || Array.isArray(context)
      || Reflect.ownKeys(context).some(key => typeof key !== 'string' || !keys.includes(key))
      || keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(context, key);
        return !descriptor || !descriptor.enumerable || descriptor.get || descriptor.set;
      })) throw new AgentCompositionError('invalid_context');
  const operation = context.operation;
  const operationKeys = ['id', 'type', 'resourceScope'];
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
      || Reflect.ownKeys(operation).some(key => typeof key !== 'string' || !operationKeys.includes(key))
      || operationKeys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(operation, key);
        return !descriptor || !descriptor.enumerable || descriptor.get || descriptor.set;
      }) || !Object.isFrozen(context.snapshot)) throw new AgentCompositionError('invalid_context');
  return Object.freeze({ operation: Object.freeze({ id: operation.id, type: operation.type,
    resourceScope: operation.resourceScope }), authorizationRevision: context.authorizationRevision,
  snapshot: context.snapshot, snapshotRevision: context.snapshotRevision, issuedAt: context.issuedAt });
}

/** Assemble one authority-coherent production graph; no foreign service/transaction pairing is exposed. */
export function createProductionAgentCreationCompositionRoot(
  deps: ProductionAgentCreationDeps,
): ProductionAgentCreationAssembly {
  const contexts = new WeakMap<object, Readonly<TrustedCompositionContext>>();
  const allocatedAgents = new Set<string>();
  const transactionEvidence = Object.freeze({}) as VerifiedTransactionConsumerEvidence;
  const planEvidence = deps.planEvidence;
  const authority: AgentCompositionAuthority = {
    authenticateContext: evidence => contexts.get(evidence as object),
    // H1a production creation is initial generation only. Exact-action retries use
    // resumePermanent and never re-prepare or invent a next durable generation.
    allocateGeneration: input => {
      if (allocatedAgents.has(input.agentId)) throw new AgentCompositionError('generation_reuse');
      allocatedAgents.add(input.agentId);
      return Object.freeze({ agentId: input.agentId, generation: 1, operationId: input.operation.id,
        authorizationRevision: input.authorizationRevision, snapshotDigest: input.snapshotDigest,
        snapshotRevision: input.snapshotRevision });
    },
    authenticateTransactionConsumer: evidence => evidence === transactionEvidence,
    authenticateCreator: evidence => planEvidence?.authenticateCreator(evidence),
    authenticateOwnerDelegation: evidence => planEvidence?.authenticateOwnerDelegation(evidence),
  };
  const composition = new AgentCompositionService(authority, deps.policies, deps.adapterAuthority, deps.now);
  const consumer = composition.issueTransactionConsumer(transactionEvidence);
  const generationsAuthority = new DurableAgentGenerationAuthority(deps.trustedStateRoot);
  const identity = new AgentProductionIdentityAuthority(deps.identityProvisioner, deps.identityProfile);
  const transaction = new AgentCreationTransaction(consumer, generationsAuthority, identity, identity);
  const root = new AgentCreationCompositionRoot(composition, transaction);
  const issue = (principal: Readonly<{ id: string; kind: 'system' | 'agent' }>,
    context: ProductionIngressContext): VerifiedCreationCallerEvidence => {
    const owned = ownIngress(context);
    const evidence = Object.freeze({}) as VerifiedCreationCallerEvidence;
    contexts.set(evidence as object, Object.freeze({ principal: Object.freeze({ ...principal }), ...owned }));
    return evidence;
  };
  return Object.freeze({ root, ingress: Object.freeze({
    direct: (context: ProductionIngressContext) => issue({ id: 'system', kind: 'system' }, context),
    managed: (callerAgentId: string, context: ProductionIngressContext) =>
      issue({ id: callerAgentId, kind: 'agent' }, context),
  }) });
}
