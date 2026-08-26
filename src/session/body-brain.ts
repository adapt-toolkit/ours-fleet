export const BODY_BRAIN_PROTOCOL_VERSION = 1 as const;
export const BODY_BRAIN_MAX_ID_BYTES = 256;
export const BODY_BRAIN_MAX_EVENTS_PAGE = 256;
export const BODY_BRAIN_MAX_ACTIVE_IDS = 128;
export const BODY_BRAIN_MAX_ADMISSIONS = 512;
export const BODY_BRAIN_MAX_COMMANDS = 512;
// Admission + completion + promotion, permission request + resolution, and mutation ledgers.
export const BODY_BRAIN_MAX_EVENTS = BODY_BRAIN_MAX_ADMISSIONS * 3 - 1
  + BODY_BRAIN_MAX_ACTIVE_IDS * 2 + BODY_BRAIN_MAX_COMMANDS;

export type BodyBrainState =
  | 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'failed' | 'terminated' | 'closed' | 'retired';
export type BodyBrainFailureCode =
  | 'invalid_request' | 'stale_generation' | 'idempotency_conflict' | 'unknown_prompt'
  | 'not_terminal' | 'unknown_permission' | 'already_settled' | 'invalid_option'
  | 'invalid_cursor' | 'closed' | 'terminated' | 'retired' | 'dependency_violation';
export type BodyBrainRecoveryFailureCode =
  | 'reference_missing' | 'adapter_incompatible' | 'protocol_mismatch'
  | 'agent_exited' | 'corrupt_recovery' | 'resume_rejected';
export type BodyBrainPromptOrigin =
  | { kind: 'startup' }
  | { kind: 'owner'; requestId: string }
  | { kind: 'local_console'; requestId: string }
  | { kind: 'monitor'; requestId: string }
  | { kind: 'scheduled'; loopId: string; runId: string };

export interface BodyBrainPromptRequest {
  generation: string;
  commandId: string;
  body: { digest: string; bytes: number };
  origin: BodyBrainPromptOrigin;
}
export interface BodyBrainAdmissionReceipt {
  commandId: string;
  promptId: string;
  state: 'queued' | 'started';
  queuedBehind: number;
  acceptedAt: string;
  cursor: string;
}
export type BodyBrainAdmissionResult =
  | { state: 'accepted'; receipt: Readonly<BodyBrainAdmissionReceipt> }
  | { state: Extract<BodyBrainFailureCode, 'invalid_request' | 'stale_generation' | 'idempotency_conflict' | 'closed' | 'terminated' | 'retired'> };

export type BodyBrainTurnOutcome = 'completed' | 'refused' | 'cancelled' | 'failed' | 'inconclusive';
export interface BodyBrainCompletion {
  promptId: string;
  outcome: BodyBrainTurnOutcome;
  completedAt: string;
  output?: { digest: string; bytes: number };
  reasonCode?: string;
}
export type BodyBrainCompletionResult =
  | { state: 'terminal'; completion: Readonly<BodyBrainCompletion> }
  | { state: 'not_terminal' | 'unknown_prompt' | 'invalid_request' | 'dependency_violation' };

export interface BodyBrainPermissionResponse {
  generation: string;
  commandId: string;
  permissionId: string;
  optionId: string;
}
export type BodyBrainPermissionResult = {
  state: 'accepted' | 'invalid_request' | 'stale_generation' | 'idempotency_conflict'
    | 'unknown_permission' | 'already_settled' | 'invalid_option' | 'closed' | 'terminated' | 'retired';
  optionId?: string;
};
export interface BodyBrainGenerationRequest { generation: string; commandId: string }
export type BodyBrainMutationResult = {
  state: 'accepted' | 'already_done' | 'invalid_request' | 'stale_generation'
    | 'idempotency_conflict' | 'closed' | 'terminated' | 'retired';
  cursor?: string;
};

export type BodyBrainEvent = Readonly<{
  schemaVersion: 1;
  eventId: string;
  seq: number;
  at: string;
  generation: string;
  kind: 'prompt_admitted' | 'prompt_started' | 'prompt_completed' | 'permission_requested' | 'permission_resolved'
    | 'cancel_requested' | 'force_terminated' | 'closed' | 'retired';
  promptId?: string;
  permissionId?: string;
  commandId?: string;
  payload?: Readonly<Record<string, string | number | boolean>>;
}>;
export interface BodyBrainSnapshot {
  protocolVersion: 1;
  sessionRef: string;
  generation: string;
  state: BodyBrainState;
  cursor: string;
  activePromptId?: string;
  activePermissionIds: readonly string[];
}
export interface BodyBrainPageRequest { after?: string; limit?: number }
export type BodyBrainPageResult =
  | { state: 'ok'; generation: string; events: readonly BodyBrainEvent[]; nextCursor: string; hasMore: boolean }
  | { state: 'invalid_cursor'; generation: string };

export interface BodyBrainSession {
  readonly sessionRef: string;
  readonly generation: string;
  snapshot(): Readonly<BodyBrainSnapshot>;
  page(request?: BodyBrainPageRequest): BodyBrainPageResult;
  subscribe(listener: (event: BodyBrainEvent) => void): () => void;
  admitPrompt(request: BodyBrainPromptRequest): BodyBrainAdmissionResult;
  awaitCompletion(generation: string, promptId: string): BodyBrainCompletionResult | { state: 'stale_generation' };
  respondPermission(request: BodyBrainPermissionResponse): BodyBrainPermissionResult;
  requestCancel(request: BodyBrainGenerationRequest): BodyBrainMutationResult;
  forceTerminate(request: BodyBrainGenerationRequest): BodyBrainMutationResult;
  close(request: BodyBrainGenerationRequest): BodyBrainMutationResult;
  retire(request: BodyBrainGenerationRequest): BodyBrainMutationResult;
  recoveryRecord(): Readonly<BodyBrainRecoveryRecord>;
}

export interface BodyBrainRecoveryAdmission {
  requestHash: string;
  request: BodyBrainPromptRequest;
  receipt: BodyBrainAdmissionReceipt;
  completion?: BodyBrainCompletion;
}
export interface BodyBrainRecoveryPermission {
  permissionId: string;
  promptId: string;
  optionIds: readonly string[];
  settledOptionId?: string;
  cancelled?: true;
  responseCommandId?: string;
  responseHash?: string;
}
export interface BodyBrainRecoveryMutation {
  operation: 'cancel' | 'force' | 'close' | 'retire';
  commandId: string;
  requestHash: string;
  result: BodyBrainMutationResult;
}
export interface BodyBrainRecoveryPermissionCommand {
  commandId: string;
  requestHash: string;
  permissionId: string;
  optionId: string;
  decidedSeq: number;
  result: BodyBrainPermissionResult;
}
export interface BodyBrainRecoveryRecord {
  schemaVersion: 1;
  protocolVersion: 1;
  adapterId: string;
  sessionRef: string;
  generation: string;
  state: BodyBrainState;
  committedSeq: number;
  committedAt?: string;
  activePromptId?: string;
  promptQueue: readonly string[];
  activePermissionIds: readonly string[];
  events: readonly BodyBrainEvent[];
  admissions: readonly BodyBrainRecoveryAdmission[];
  permissions: readonly BodyBrainRecoveryPermission[];
  permissionCommands: readonly BodyBrainRecoveryPermissionCommand[];
  mutations: readonly BodyBrainRecoveryMutation[];
  retired: boolean;
  integrityDigest: string;
}
export type BodyBrainRestoreResult =
  | { state: 'restored'; session: BodyBrainSession }
  | { state: 'failed'; code: BodyBrainRecoveryFailureCode };
export interface BodyBrainSessionRestorer {
  restore(record: unknown): BodyBrainRestoreResult;
}

export interface BodyBrainDeterminism {
  now(): string;
  nextId(kind: 'event' | 'prompt' | 'permission'): string;
}

export class BodyBrainContractError extends Error {}
