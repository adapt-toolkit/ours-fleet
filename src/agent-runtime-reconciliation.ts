import type {
  AgentRuntimeReconciliationAuthority, AgentRuntimeReconciliationQuery,
  AuthenticatedAgentRuntimeRetireReconciliation, AuthenticatedAgentRuntimeStartReconciliation,
} from './agent-runtime-provider.js';

/**
 * Conservative production reconciliation boundary. Until a cross-process
 * positive witness exists, it authenticates uncertainty and never invents
 * absence, ownership, or exact liveness from local process state.
 */
export class ProductionAgentRuntimeReconciliationAuthority
implements AgentRuntimeReconciliationAuthority {
  readonly #start = new WeakMap<object, AuthenticatedAgentRuntimeStartReconciliation>();
  readonly #retire = new WeakMap<object, AuthenticatedAgentRuntimeRetireReconciliation>();

  async reconcileStart(_input: Readonly<AgentRuntimeReconciliationQuery>): Promise<unknown> {
    const evidence = Object.freeze({});
    this.#start.set(evidence, Object.freeze({ outcome: 'unknown' }));
    return evidence;
  }

  authenticateStart(evidence: unknown, _input: Readonly<AgentRuntimeReconciliationQuery>) {
    return evidence && typeof evidence === 'object' ? this.#start.get(evidence as object) : undefined;
  }

  async reconcileRetire(_input: Readonly<AgentRuntimeReconciliationQuery & {
    providerRuntimeId: string; retireEffectKey: string;
  }>): Promise<unknown> {
    const evidence = Object.freeze({});
    this.#retire.set(evidence, Object.freeze({ outcome: 'unknown' }));
    return evidence;
  }

  authenticateRetire(evidence: unknown, _input: Readonly<AgentRuntimeReconciliationQuery & {
    providerRuntimeId: string; retireEffectKey: string;
  }>) {
    return evidence && typeof evidence === 'object' ? this.#retire.get(evidence as object) : undefined;
  }
}
