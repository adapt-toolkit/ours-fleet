import type { AgentCompositionRequest, AgentPlanTransactionConsumer, PreparedAgentCreation } from './agent-composition-service.js';
import { AgentCompositionError, consumePreparedForTransaction } from './agent-composition-service.js';
import type { DurableAgentGenerationAuthority, GenerationReservationRecord,
  VerifiedGenerationReservation } from './agent-generation-reservation.js';
import type { AgentCompositionService } from './agent-composition-service.js';

const brand: unique symbol = Symbol('VerifiedTempAgentPlanReservation');
export interface VerifiedTempAgentPlanReservation { readonly [brand]: true }
export interface TempAgentPlanReservationBindings {
  prepared: PreparedAgentCreation; reservation: VerifiedGenerationReservation;
  record: Readonly<GenerationReservationRecord>;
}
export interface TempAgentPlanReservationAuthority {
  authenticate(value: VerifiedTempAgentPlanReservation): Readonly<TempAgentPlanReservationBindings> | undefined;
}

/** Persists only an authenticated temporary AgentPlan reservation. It has no identity/runtime surface. */
export class TempAgentPlanReservationRoot implements TempAgentPlanReservationAuthority {
  readonly #issued = new WeakMap<object, Readonly<TempAgentPlanReservationBindings>>();
  constructor(private readonly composition: AgentCompositionService,
    private readonly consumer: AgentPlanTransactionConsumer,
    private readonly generations: DurableAgentGenerationAuthority) {}

  async reserve(request: AgentCompositionRequest, actionId: string): Promise<VerifiedTempAgentPlanReservation> {
    const prepared = this.composition.prepare(request);
    if (prepared.lifecycle !== 'temporary' || prepared.identity.ownership !== 'create_temporary'
        || prepared.operation.id !== actionId) throw new AgentCompositionError('invalid_request');
    const plan = consumePreparedForTransaction(this.consumer, prepared);
    const reservation = await this.generations.persist(plan, actionId);
    const record = this.generations.authenticate(reservation);
    if (!record) throw new AgentCompositionError('foreign_prepared');
    const evidence = Object.freeze({ [brand]: true as const });
    this.#issued.set(evidence, Object.freeze({ prepared, reservation, record }));
    return evidence;
  }
  authenticate(value: VerifiedTempAgentPlanReservation) { return this.#issued.get(value as object); }
}
