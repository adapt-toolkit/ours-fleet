import type { AgentCompositionRequest } from './agent-composition-service.js';
import { AgentCompositionError } from './agent-composition-service.js';
import type { PermanentAgentCreationResult, ProductionAgentCreationAssembly,
  ProductionIngressContext } from './agent-creation-composition-root.js';

export interface PermanentAgentInstallationRequest {
  context: ProductionIngressContext;
  composition: Omit<AgentCompositionRequest, 'callerEvidence'>;
  actionId: string;
}

/** Installs permanent durable state only through the real production creation/identity authorities. */
export class AgentInstallationService {
  readonly #admissions = new Map<string, Readonly<{
    binding: string; creatorEvidence?: unknown; ownerDelegationEvidence?: unknown;
  }>>();
  constructor(private readonly assembly: ProductionAgentCreationAssembly) {}
  async installPermanent(request: PermanentAgentInstallationRequest): Promise<PermanentAgentCreationResult> {
    const source = request.composition.source;
    if (source.kind !== 'runtime_composition' || source.lifecycle !== 'persistent'
        || source.identity.ownership !== 'existing') throw new AgentCompositionError('invalid_request');
    const callerEvidence = this.assembly.ingress.direct(request.context);
    const key = `${source.agentId}\0${request.actionId}`;
    const binding = admissionBinding(request);
    const prior = this.#admissions.get(key);
    if (prior) {
      if (prior.binding !== binding.binding || prior.creatorEvidence !== binding.creatorEvidence
          || prior.ownerDelegationEvidence !== binding.ownerDelegationEvidence)
        throw new AgentCompositionError('invalid_request');
      return this.assembly.root.resumePermanent(source.agentId, request.actionId);
    }
    this.#admissions.set(key, binding);
    try {
      return await this.assembly.root.createPermanent({ ...request.composition, callerEvidence }, request.actionId);
    } catch (error) {
      // Composition rejection is not an admitted attempt. Operational crashes retain
      // the same-instance admission so only its exact request may resume durable work.
      if (error instanceof AgentCompositionError) this.#admissions.delete(key);
      throw error;
    }
  }
}

function admissionBinding(request: PermanentAgentInstallationRequest): Readonly<{
  binding: string; creatorEvidence?: unknown; ownerDelegationEvidence?: unknown;
}> {
  const { creatorEvidence, ownerDelegationEvidence, ...composition } = request.composition;
  return Object.freeze({ binding: canonical({ context: request.context, composition,
    actionId: request.actionId }), creatorEvidence, ownerDelegationEvidence });
}

function canonical(value: unknown): string {
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
    if (Array.isArray(current)) {
      if (keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(String(key))))
        throw new AgentCompositionError('invalid_request');
      return `[${current.map(item => visit(item)).join(',')}]`;
    }
    return `{${(keys as string[]).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set || descriptor.value === undefined)
        throw new AgentCompositionError('invalid_request');
      return `${JSON.stringify(key)}:${visit(descriptor.value)}`;
    }).join(',')}}`;
  };
  return visit(value);
}
