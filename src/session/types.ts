import type { SessionBackendId } from '../config.js';

export type SessionReadiness =
  | 'starting'
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'failed';

export type TurnOutcome = 'completed' | 'refused' | 'cancelled' | 'failed' | 'inconclusive';

/**
 * Two independent facts about one turn, deliberately kept apart:
 *
 * - `accepted` — the live session took responsibility for the prompt. It says
 *   nothing about what the agent then did with it.
 * - `outcome` / `succeeded` — how the turn TERMINATED. Only `completed` is a
 *   terminal success. A refusal or a cancellation is a prompt that was
 *   delivered and then not carried out; every caller that needs the work
 *   actually done (mail delivery, role startup) must treat it as a failure.
 *
 * Collapsing the two is what let a refused wake commit its notification cursor
 * and a refused startup prompt log the role as up.
 */
export interface TurnResult {
  accepted: boolean;
  outcome: TurnOutcome;
  succeeded: boolean;
  detail?: string;
}

/**
 * Why a control operation failed. The distinctions exist because collapsing
 * them is what made a busy agent look dead: only `offline` is evidence that the
 * session is gone, and `timeout` explicitly does NOT say the prompt was lost.
 */
export type ControlFailureKind =
  | 'offline'              // the session is confirmed gone
  | 'control-unavailable'  // nothing answered the control plane — says nothing about the agent
  | 'timeout'              // no answer in time; the request may already have been acted on
  | 'rejected'             // the session understood the request and refused it
  | 'backend';             // the transport itself failed

export class SessionControlError extends Error {
  constructor(readonly kind: ControlFailureKind, message: string) {
    super(message);
    this.name = 'SessionControlError';
  }
}

/**
 * A prompt the live session has taken responsibility for. Interactive callers
 * stop here: the session has the prompt, and waiting for the turn to finish is
 * a different question with a different, much longer, timescale.
 */
export interface QueuedPrompt {
  promptId: string;
  /** Turns already queued ahead of this one. 0 means it starts immediately. */
  queuedBehind: number;
  /** The turn's terminal result. Never rejects. */
  completion: Promise<TurnResult>;
}

/** The single definition of terminal success. Nothing else may re-derive it. */
export const isTerminalSuccess = (outcome: TurnOutcome): boolean => outcome === 'completed';

/** Build a TurnResult with `succeeded` always consistent with `outcome`. */
export function turnResult(
  accepted: boolean, outcome: TurnOutcome, detail?: string,
): TurnResult {
  return { accepted, outcome, succeeded: isTerminalSuccess(outcome), detail };
}

export interface SessionSnapshot {
  backend: SessionBackendId;
  alive: boolean;
  readiness: SessionReadiness;
  sessionId?: string;
  lastError?: string;
  pendingPermissionId?: string;
}

export type SessionEventKind =
  | 'state'
  | 'agent_text'
  | 'thought'
  | 'tool_call'
  | 'tool_update'
  | 'permission'
  | 'turn_stop'
  | 'error';

/** What a settled permission request resolved to. */
export type PermissionDecision = 'allowed' | 'denied' | 'cancelled';

export interface SessionEvent {
  version: 1;
  seq: number;
  at: string;
  kind: SessionEventKind;
  turnId?: string;
  toolCallId?: string;
  permissionId?: string;
  text?: string;
  title?: string;
  status?: string;
  stopReason?: string;
  options?: Array<{ optionId: string; name: string; kind: string }>;
  // ── settled permission events (status: 'completed') ────────────────────────
  /** What was decided. */
  decision?: PermissionDecision;
  /** Whether policy decided it, or a human answered the prompt. */
  decisionSource?: 'automatic' | 'manual';
  /** The configured policy that produced an automatic decision. */
  policy?: string;
  /** Why, in one human-readable line. */
  reason?: string;
  /** The option actually selected, when one was. */
  optionId?: string;
}

export interface SessionHandle {
  readonly backend: SessionBackendId;
  readonly pid: number;
  isAlive(): boolean;
  snapshot(): SessionSnapshot;
  /**
   * Hand the session a prompt and return as soon as it has accepted
   * responsibility for it. Throws `SessionControlError` if it cannot.
   */
  queuePrompt(text: string): Promise<QueuedPrompt>;
  /** Queue a prompt and wait for its terminal result. */
  submitPrompt(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  respondPermission(permissionId: string, optionId: string): boolean;
  eventsSince(seq: number): SessionEvent[];
  subscribe(listener: (event: SessionEvent) => void): () => void;
  setControllerAttached(attached: boolean): void;
  close(): Promise<void>;
}
