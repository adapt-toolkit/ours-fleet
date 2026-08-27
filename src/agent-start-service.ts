import type { PreparedAgentCreation } from './agent-composition-service.js';
import type {
  AgentCreationResult,
  AgentCreationTransaction,
} from './agent-creation-transaction.js';
import type {
  AgentRuntimeTransaction,
  RuntimeOperationResult,
  VerifiedRuntimeOperationRequest,
} from './agent-runtime-transaction.js';

export interface AgentStartRequest {
  creation: Readonly<{ actionId: string; targetEvidence?: unknown }>;
  runtimeEvidence: VerifiedRuntimeOperationRequest;
}

export type AgentStartResult =
  | Readonly<{ stage: 'creation'; creation: AgentCreationResult }>
  | Readonly<{ stage: 'runtime'; creation: AgentCreationResult; runtime: RuntimeOperationResult }>;

type CreationStartTransaction = Pick<AgentCreationTransaction, 'persistPrepared'>;
type RuntimeStartTransaction = Pick<AgentRuntimeTransaction, 'start'>;

export class AgentStartService {
  constructor(
    private readonly creation: CreationStartTransaction,
    private readonly runtime: RuntimeStartTransaction,
  ) {}

  async start(prepared: PreparedAgentCreation, request: AgentStartRequest): Promise<AgentStartResult> {
    const creationInput = Object.freeze({
      actionId: request.creation.actionId,
      targetEvidence: request.creation.targetEvidence,
    });
    const runtimeEvidence = request.runtimeEvidence;
    const creation = await this.creation.persistPrepared(prepared, creationInput);
    if (creation.state !== 'complete') return Object.freeze({ stage: 'creation', creation });
    const runtime = await this.runtime.start(creation.reservation, runtimeEvidence);
    return Object.freeze({ stage: 'runtime', creation, runtime });
  }
}
