import {
  AgentCompositionError, AgentCompositionService,
  type AgentCompositionAuthority, type AgentCompositionRequest,
  type TrustedAdapterPolicySource, type TrustedCompositionContext,
  type VerifiedCreationCallerEvidence, type VerifiedTransactionConsumerEvidence,
} from './agent-composition-service.js';
import {
  AgentCreationTransaction, type AgentCreationFaults, type AgentCreationResult,
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
import { AgentSupervisorHandoffPublisher, type AgentSupervisorHandoffFaults } from './agent-supervisor-handoff.js';
import { TempAgentPlanReservationRoot } from './temp-agent-plan-reservation.js';
import { TempAgentSupervisorHandoffPublisher } from './temp-agent-supervisor-handoff.js';

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
    private readonly handoffs?: AgentSupervisorHandoffPublisher,
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

  async #finish(result: AgentCreationResult): Promise<PermanentAgentCreationResult> {
    if (result.state !== 'complete') return result;
    const complete = this.transaction.validateComplete(result.reservation);
    const authenticated = this.transaction.authenticateComplete(complete);
    if (!authenticated) throw new AgentCompositionError('invalid_context');
    const locator = this.#locators.publish(complete);
    await this.handoffs?.publish(complete);
    return { ...result, locator,
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
  creationFaults?: AgentCreationFaults;
  handoffFaults?: AgentSupervisorHandoffFaults;
}
export interface ProductionAgentCreationAssembly {
  root: AgentCreationCompositionRoot;
  temporary: Readonly<{ reserve(request: AgentCompositionRequest, actionId: string): Promise<Readonly<{
    agentId: string; generation: number; lifetime: 'temporary'; completion: 'deferred';
  }>> }>;
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
  const transaction = new AgentCreationTransaction(consumer, generationsAuthority, identity, identity,
    deps.creationFaults);
  const root = new AgentCreationCompositionRoot(composition, transaction, undefined,
    new AgentSupervisorHandoffPublisher(deps.trustedStateRoot, transaction, deps.handoffFaults));
  const temporaryReservations = new TempAgentPlanReservationRoot(composition, consumer, generationsAuthority);
  const temporaryHandoffs = new TempAgentSupervisorHandoffPublisher(deps.trustedStateRoot, temporaryReservations);
  type TempStatus = Readonly<{ agentId: string; generation: number;
    lifetime: 'temporary'; completion: 'deferred' }>;
  const installedTemporary = new Map<string, {
    binding: string; creatorEvidence?: unknown; ownerDelegationEvidence?: unknown;
    evidence?: Awaited<ReturnType<TempAgentPlanReservationRoot['reserve']>>; status?: TempStatus;
  }>();
  const temporary = Object.freeze({ reserve: async (request: AgentCompositionRequest, actionId: string) => {
    const source = request?.source;
    const context = request && typeof request === 'object'
      ? contexts.get(request.callerEvidence as object) : undefined;
    if (!source || !context) throw new AgentCompositionError('unauthenticated_caller');
    const key = `${source.agentId}\0${actionId}`;
    const { callerEvidence: _callerEvidence, creatorEvidence, ownerDelegationEvidence, ...plainRequest } = request;
    const binding = canonicalAdmission({ context, request: plainRequest, actionId });
    let admission = installedTemporary.get(key);
    if (admission) {
      if (admission.binding !== binding || admission.creatorEvidence !== creatorEvidence
          || admission.ownerDelegationEvidence !== ownerDelegationEvidence)
        throw new AgentCompositionError('invalid_request');
    } else {
      admission = { binding, creatorEvidence, ownerDelegationEvidence };
      installedTemporary.set(key, admission);
    }
    try { admission.evidence ??= await temporaryReservations.reserve(request, actionId); }
    catch (error) {
      if (error instanceof AgentCompositionError) installedTemporary.delete(key);
      throw error;
    }
    const handoff = await temporaryHandoffs.publish(admission.evidence);
    const status = admission.status ?? Object.freeze({ agentId: handoff.agentId, generation: handoff.generation,
      lifetime: 'temporary' as const, completion: 'deferred' as const });
    admission.status = status; return status;
  } });
  const issue = (principal: Readonly<{ id: string; kind: 'system' | 'agent' }>,
    context: ProductionIngressContext): VerifiedCreationCallerEvidence => {
    const owned = ownIngress(context);
    const evidence = Object.freeze({}) as VerifiedCreationCallerEvidence;
    contexts.set(evidence as object, Object.freeze({ principal: Object.freeze({ ...principal }), ...owned }));
    return evidence;
  };
  return Object.freeze({ root, temporary, ingress: Object.freeze({
    direct: (context: ProductionIngressContext) => issue({ id: 'system', kind: 'system' }, context),
    managed: (callerAgentId: string, context: ProductionIngressContext) =>
      issue({ id: callerAgentId, kind: 'agent' }, context),
  }) });
}

function canonicalAdmission(value: unknown): string {
  let nodes = 0;
  const visit = (current: unknown): string => {
    if (++nodes > 16_384) throw new AgentCompositionError('invalid_request');
    if (current === null || typeof current === 'string' || typeof current === 'boolean'
        || typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current);
    if (!current || typeof current !== 'object') throw new AgentCompositionError('invalid_request');
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))
      throw new AgentCompositionError('invalid_request');
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key !== 'string')) throw new AgentCompositionError('invalid_request');
    if (Array.isArray(current)) return `[${current.map(item => visit(item)).join(',')}]`;
    return `{${(keys as string[]).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set || descriptor.value === undefined)
        throw new AgentCompositionError('invalid_request');
      return `${JSON.stringify(key)}:${visit(descriptor.value)}`;
    }).join(',')}}`;
  };
  return visit(value);
}
