import type { ConfigResourceSnapshot } from './config-resource-loader.js';
import type { AgentPlanSource } from './agent-plan.js';
import {
  createAuthenticatedAgentPlanComposer, validateCreatorPlanAgainstTrustedBindings,
  validateOwnerDelegationAgainstTrustedBindings,
  type AgentMembership, type AgentPlan, type AgentPlanCompositionInput,
  type AgentPlanEvidenceAuthority, type CompositionLayerInput, type PlanOperation,
  type RequestPrincipal, type RoleContextLayerInput, type VerifiedCreatorPlanEvidence,
  type VerifiedOwnerDelegationEvidence,
} from './agent-plan.js';
import {
  createBrainAdapterPolicyResolver,
  type BrainAdapterEvidenceAuthority, type BrainAdapterPolicyEvidence,
  type VerifiedAdapterEnforcementEvidence,
} from './harness/brain-adapter.js';
import type { BrainSpec } from './config-resources.js';

declare const callerBrand: unique symbol;
export interface VerifiedCreationCallerEvidence { readonly [callerBrand]: true }
declare const transactionConsumerEvidenceBrand: unique symbol;
export interface VerifiedTransactionConsumerEvidence { readonly [transactionConsumerEvidenceBrand]: true }
const transactionConsumerBrand: unique symbol = Symbol('AgentPlanTransactionConsumer');
export interface AgentPlanTransactionConsumer {
  readonly [transactionConsumerBrand]: true;
}
const transactionConsumers = new WeakMap<object, (prepared: PreparedAgentCreation) => AgentPlan>();
export const authenticateTransactionConsumer = (consumer: AgentPlanTransactionConsumer): boolean =>
  transactionConsumers.has(consumer as object);
export function consumePreparedForTransaction(
  consumer: AgentPlanTransactionConsumer, prepared: PreparedAgentCreation,
): AgentPlan {
  const consume = transactionConsumers.get(consumer as object);
  if (!consume) throw new AgentCompositionError('foreign_prepared');
  return consume(prepared);
}

export interface TrustedCompositionContext {
  principal: Readonly<RequestPrincipal>;
  operation: Readonly<PlanOperation>;
  authorizationRevision: string;
  authenticatedOwnerCid?: string;
  snapshot: ConfigResourceSnapshot;
  snapshotRevision: string;
  issuedAt: number;
}

export interface TrustedGenerationAllocation {
  agentId: string;
  generation: number;
  operationId: string;
  authorizationRevision: string;
  snapshotDigest: string;
  snapshotRevision: string;
}

export interface AgentCompositionAuthority extends AgentPlanEvidenceAuthority {
  authenticateContext(evidence: VerifiedCreationCallerEvidence): Readonly<TrustedCompositionContext> | undefined;
  allocateGeneration(input: Readonly<{
    principal: RequestPrincipal; operation: PlanOperation; authorizationRevision: string;
    agentId: string; snapshotDigest: string; snapshotRevision: string;
    callerEvidence: VerifiedCreationCallerEvidence;
  }>): Readonly<TrustedGenerationAllocation>;
  authenticateTransactionConsumer?(evidence: VerifiedTransactionConsumerEvidence): boolean;
}

export interface TrustedAdapterPolicySource {
  resolvePolicy(brain: Readonly<BrainSpec>, permissions: Readonly<AgentPlan['permissions']>): Readonly<{
    policy: BrainAdapterPolicyEvidence;
    enforcementEvidence: VerifiedAdapterEnforcementEvidence;
  }>;
}

export interface AgentCompositionRequest {
  callerEvidence: VerifiedCreationCallerEvidence;
  source: AgentPlanSource;
  explicitOperation?: CompositionLayerInput;
  taskDefault?: CompositionLayerInput;
  roomDefault?: CompositionLayerInput;
  templateMember?: CompositionLayerInput;
  roleContext?: {
    template?: RoleContextLayerInput; room?: RoleContextLayerInput; taskMember?: RoleContextLayerInput;
  };
  creatorEvidence?: VerifiedCreatorPlanEvidence;
  ownerDelegationEvidence?: VerifiedOwnerDelegationEvidence;
  membership?: AgentMembership;
}

const preparedBrand: unique symbol = Symbol('PreparedAgentCreation');
export interface PreparedAgentCreation {
  readonly [preparedBrand]: true;
  readonly redacted: true;
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly generation: number;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly lifecycle: 'persistent' | 'temporary';
  readonly identity: Readonly<{ name: string; ownership: string }>;
  readonly brain: Readonly<{ harness: string; model: string; effort: string; session: string }>;
  readonly permissions: Readonly<{ approval: string; filesystem: string; unattended: string }>;
  readonly operation: Readonly<{ id: string; type: string; resourceScope: string }>;
  readonly authorizationRevision: string;
  toJSON(): never;
}

export type AgentCompositionErrorCode =
  | 'invalid_request' | 'unauthenticated_caller' | 'invalid_context' | 'invalid_lineage'
  | 'invalid_generation' | 'generation_reuse' | 'adapter_rejected' | 'resolution_rejected'
  | 'foreign_prepared';
export class AgentCompositionError extends Error {
  constructor(readonly code: AgentCompositionErrorCode) {
    super(`agent composition: ${code}`); this.name = 'AgentCompositionError';
  }
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
function exactData(
  value: unknown, required: readonly string[], optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')
      || required.some(key => !keys.includes(key))
      || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set
      && descriptor.value !== undefined;
  });
}
function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return true;
  seen.add(value as object);
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string' || (!Array.isArray(value) && key === 'length')) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) return false;
    if (Array.isArray(value) && key === 'length') return true;
    return descriptor.enumerable && deeplyFrozen(descriptor.value, seen);
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownPlainData(value: unknown): unknown {
  let nodes = 0;
  const copy = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 16_384 || depth > 64) throw new AgentCompositionError('invalid_request');
    if (current === null || typeof current === 'boolean'
        || typeof current === 'number' && Number.isFinite(current)) return current;
    if (typeof current === 'string') {
      if (Buffer.byteLength(current) > 128 * 1024) throw new AgentCompositionError('invalid_request');
      return current;
    }
    if (!current || typeof current !== 'object') throw new AgentCompositionError('invalid_request');
    const array = Array.isArray(current);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(current)))
      throw new AgentCompositionError('invalid_request');
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key !== 'string')) throw new AgentCompositionError('invalid_request');
    if (array) {
      const length = current.length;
      if (!Number.isSafeInteger(length) || length > 4096) throw new AgentCompositionError('invalid_request');
      const allowed = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
      if (keys.some(key => typeof key !== 'string' || !allowed.has(key)))
        throw new AgentCompositionError('invalid_request');
      const output: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set)
          throw new AgentCompositionError('invalid_request');
        output.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(output);
    }
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set
          || descriptor.value === undefined) throw new AgentCompositionError('invalid_request');
      output[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  };
  return copy(value, 0);
}

export class AgentCompositionService {
  readonly #plans = new WeakMap<object, AgentPlan>();
  readonly #prepared = new WeakSet<object>();
  readonly #generations = new Map<string, number>();
  readonly #resolveAdapter: ReturnType<typeof createBrainAdapterPolicyResolver>;

  constructor(
    private readonly authority: AgentCompositionAuthority,
    private readonly policies: TrustedAdapterPolicySource,
    adapterAuthority: BrainAdapterEvidenceAuthority,
    private readonly now: () => number = Date.now,
  ) {
    this.#resolveAdapter = createBrainAdapterPolicyResolver(adapterAuthority);
  }

  prepare(request: AgentCompositionRequest): PreparedAgentCreation {
    try { return this.#prepare(request); }
    catch (error) {
      if (error instanceof AgentCompositionError) throw error;
      throw new AgentCompositionError('invalid_request');
    }
  }

  #prepare(request: AgentCompositionRequest): PreparedAgentCreation {
    if (!exactData(request, ['callerEvidence', 'source'], [
      'explicitOperation', 'taskDefault', 'roomDefault', 'templateMember', 'roleContext',
      'creatorEvidence', 'ownerDelegationEvidence', 'membership',
    ])) throw new AgentCompositionError('invalid_request');
    const owned = ownPlainData({
      source: request.source,
      ...(request.explicitOperation === undefined ? {} : { explicitOperation: request.explicitOperation }),
      ...(request.taskDefault === undefined ? {} : { taskDefault: request.taskDefault }),
      ...(request.roomDefault === undefined ? {} : { roomDefault: request.roomDefault }),
      ...(request.templateMember === undefined ? {} : { templateMember: request.templateMember }),
      ...(request.roleContext === undefined ? {} : { roleContext: request.roleContext }),
      ...(request.membership === undefined ? {} : { membership: request.membership }),
    }) as Omit<AgentPlanCompositionInput, 'creatorEvidence' | 'ownerDelegationEvidence'>;
    let context: Readonly<TrustedCompositionContext> | undefined;
    try { context = this.authority.authenticateContext(request.callerEvidence); }
    catch { throw new AgentCompositionError('unauthenticated_caller'); }
    if (!context) throw new AgentCompositionError('unauthenticated_caller');
    if (!exactData(context, [
      'principal', 'operation', 'authorizationRevision', 'snapshot', 'snapshotRevision', 'issuedAt',
    ], ['authenticatedOwnerCid'])
        || !exactData(context.principal, ['id', 'kind'])
        || !TOKEN.test(context.principal.id)
        || !['agent', 'owner', 'system'].includes(context.principal.kind)
        || !exactData(context.operation, ['id', 'type', 'resourceScope'])
        || !TOKEN.test(context.operation.id) || !TOKEN.test(context.operation.type)
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(context.operation.resourceScope)
        || !TOKEN.test(context.authorizationRevision)
        || context.authenticatedOwnerCid !== undefined && !TOKEN.test(context.authenticatedOwnerCid)
        || !exactData(context.snapshot, [
          'schemaVersion', 'bootstrapFile', 'configDir', 'digest', 'bootstrap', 'sources',
          'resources', 'diagnostics',
        ]) || context.snapshot.schemaVersion !== 2
        || !deeplyFrozen(context) || !deeplyFrozen(context.snapshot)
        || !TOKEN.test(context.snapshotRevision) || !SHA.test(context.snapshot.digest)
        || !Number.isSafeInteger(context.issuedAt) || context.issuedAt < 0)
      throw new AgentCompositionError('invalid_context');
    const agentId = owned.source?.agentId;
    if (!TOKEN.test(agentId)) throw new AgentCompositionError('invalid_request');
    if (owned.source.kind === 'persistent_resource'
        && !context.snapshot.resources.Agent?.[agentId])
      throw new AgentCompositionError('invalid_request');

    if (context.principal.kind === 'owner' && !context.authenticatedOwnerCid)
      throw new AgentCompositionError('unauthenticated_caller');
    let creatorRecord: ReturnType<AgentCompositionAuthority['authenticateCreator']>;
    if (context.principal.kind === 'agent') {
      if (!request.creatorEvidence) throw new AgentCompositionError('invalid_lineage');
      try {
        creatorRecord = this.authority.authenticateCreator(request.creatorEvidence);
        if (!creatorRecord || creatorRecord.trusted.agentId !== context.principal.id
            || creatorRecord.plan.agentId !== context.principal.id)
          throw new AgentCompositionError('invalid_lineage');
        validateCreatorPlanAgainstTrustedBindings(creatorRecord.plan, creatorRecord.trusted);
      }
      catch { throw new AgentCompositionError('invalid_lineage'); }
    }
    let ownerRecord: ReturnType<AgentCompositionAuthority['authenticateOwnerDelegation']>;
    if (request.ownerDelegationEvidence) {
      try {
        ownerRecord = this.authority.authenticateOwnerDelegation(request.ownerDelegationEvidence);
        if (!ownerRecord) throw new Error('missing');
        validateOwnerDelegationAgainstTrustedBindings(ownerRecord.grant, ownerRecord.trusted);
      } catch { throw new AgentCompositionError('invalid_lineage'); }
    }

    let allocation: Readonly<TrustedGenerationAllocation>;
    try { allocation = this.authority.allocateGeneration({
      principal: context.principal, operation: context.operation,
      authorizationRevision: context.authorizationRevision, agentId,
      snapshotDigest: context.snapshot.digest, snapshotRevision: context.snapshotRevision,
      callerEvidence: request.callerEvidence,
    }); } catch { throw new AgentCompositionError('invalid_generation'); }
    try {
      if (!exactData(allocation, [
        'agentId', 'generation', 'operationId', 'authorizationRevision',
        'snapshotDigest', 'snapshotRevision',
      ]) || allocation.agentId !== agentId
          || allocation.operationId !== context.operation.id
          || allocation.authorizationRevision !== context.authorizationRevision
          || allocation.snapshotDigest !== context.snapshot.digest
          || allocation.snapshotRevision !== context.snapshotRevision
          || !Number.isSafeInteger(allocation.generation) || allocation.generation < 1)
        throw new AgentCompositionError('invalid_generation');
    } catch { throw new AgentCompositionError('invalid_generation'); }
    const generationKey = `${context.snapshot.digest}\0${context.snapshotRevision}\0${agentId}`
      + `\0${context.operation.id}\0${context.operation.type}\0${context.operation.resourceScope}`;
    if ((this.#generations.get(generationKey) ?? 0) >= allocation.generation)
      throw new AgentCompositionError('generation_reuse');
    // Allocation is consumed before fallible policy/plan work; a failed attempt cannot reuse it.
    this.#generations.set(generationKey, allocation.generation);

    const adapterResolver = { resolve: (brain: Readonly<BrainSpec>, permissions: AgentPlan['permissions']) => {
      let bound;
      try { bound = this.policies.resolvePolicy(brain, permissions); }
      catch { throw new AgentCompositionError('adapter_rejected'); }
      try { return this.#resolveAdapter({ brain, permissions, ...bound }); }
      catch { throw new AgentCompositionError('adapter_rejected'); }
    } };
    const composition: AgentPlanCompositionInput = {
      ...owned,
      ...(request.creatorEvidence === undefined ? {} : { creatorEvidence: request.creatorEvidence }),
      ...(request.ownerDelegationEvidence === undefined ? {} : {
        ownerDelegationEvidence: request.ownerDelegationEvidence,
      }),
    };
    const evidenceAuthority: AgentPlanEvidenceAuthority = {
      authenticateCreator: evidence => evidence === request.creatorEvidence ? creatorRecord : undefined,
      authenticateOwnerDelegation: evidence =>
        evidence === request.ownerDelegationEvidence ? ownerRecord : undefined,
    };
    let plan: AgentPlan;
    try {
      plan = createAuthenticatedAgentPlanComposer(evidenceAuthority, {
        snapshot: context.snapshot, principal: context.principal, operation: context.operation,
        authorizationRevision: context.authorizationRevision, generation: allocation.generation,
        evaluatedAt: this.now(),
      }, adapterResolver)(composition);
    } catch (error) {
      if (error instanceof AgentCompositionError) throw error;
      throw new AgentCompositionError('resolution_rejected');
    }
    if (plan.agentId !== allocation.agentId || plan.generation !== allocation.generation
        || plan.snapshotDigest !== context.snapshot.digest
        || plan.operation.id !== context.operation.id || plan.operation.type !== context.operation.type
        || plan.operation.resourceScope !== context.operation.resourceScope
        || plan.authorizationRevision !== context.authorizationRevision)
      throw new AgentCompositionError('resolution_rejected');
    const prepared = freeze({
      [preparedBrand]: true as const, redacted: true as const, schemaVersion: 1 as const,
      agentId: plan.agentId, generation: plan.generation, planDigest: plan.planDigest,
      snapshotDigest: plan.snapshotDigest, lifecycle: plan.lifecycle,
      identity: { name: plan.identity.name, ownership: plan.identity.ownership },
      brain: { harness: plan.brain.harness, model: plan.brain.model,
        effort: plan.brain.effort, session: plan.brain.session },
      permissions: { ...plan.permissions }, operation: { ...plan.operation },
      authorizationRevision: plan.authorizationRevision,
      toJSON(): never { throw new AgentCompositionError('foreign_prepared'); },
    });
    this.#plans.set(prepared, plan);
    this.#prepared.add(prepared);
    return prepared;
  }

  inspect(prepared: PreparedAgentCreation): Readonly<Record<string, unknown>> {
    if (!this.#prepared.has(prepared)) throw new AgentCompositionError('foreign_prepared');
    return freeze({
      redacted: true, schemaVersion: 1, agentId: prepared.agentId, generation: prepared.generation,
      planDigest: prepared.planDigest, snapshotDigest: prepared.snapshotDigest,
      lifecycle: prepared.lifecycle, identity: { ...prepared.identity }, brain: { ...prepared.brain },
      permissions: { ...prepared.permissions }, operation: { ...prepared.operation },
      authorizationRevision: prepared.authorizationRevision,
    });
  }

  /** Issue the only capability creation transactions accept. */
  issueTransactionConsumer(evidence: VerifiedTransactionConsumerEvidence): AgentPlanTransactionConsumer {
    let authenticated = false;
    try { authenticated = this.authority.authenticateTransactionConsumer?.(evidence) === true; }
    catch { /* fail closed */ }
    if (!authenticated) throw new AgentCompositionError('unauthenticated_caller');
    const consumer: AgentPlanTransactionConsumer = Object.freeze({
      [transactionConsumerBrand]: true as const,
    });
    transactionConsumers.set(consumer, prepared => this.#consume(prepared));
    return consumer;
  }

  #consume(prepared: PreparedAgentCreation): AgentPlan {
    const plan = this.#plans.get(prepared);
    if (!plan) throw new AgentCompositionError('foreign_prepared');
    // Prepared is an authority capability, not a reusable plan handle.  Removing
    // it before returning also makes callback re-entry fail closed.
    this.#plans.delete(prepared);
    return plan;
  }
}
