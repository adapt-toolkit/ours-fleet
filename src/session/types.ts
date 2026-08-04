import type { SessionBackendId } from '../config.js';
import type {
  ConversationEventV1, ConversationSnapshot, PromptReceipt, SubmitPromptCommand,
} from './conversation-types.js';

export type SessionReadiness =
  | 'starting'
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'failed';

export type TurnOutcome = 'completed' | 'refused' | 'cancelled' | 'failed' | 'inconclusive';
export type TurnCancellationSource =
  | 'owner' | 'local-console' | 'fleet-monitor' | 'scheduled-loop' | 'shutdown';
export type PromptOrigin =
  | { kind: 'startup' }
  | { kind: 'local-console' }
  | { kind: 'owner'; requestId: string }
  | { kind: 'fleet-monitor' }
  | { kind: 'scheduled-loop'; loop: string; runId: string }
  | { kind: 'browser'; commandId: string };

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
  /** Present only when fleet can prove what initiated a cancelled turn. */
  cancellationSource?: TurnCancellationSource;
  /** Final assistant text captured structurally by a backend, when available. */
  output?: string;
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
  origin?: PromptOrigin;
  /** The turn's terminal result. Never rejects. */
  completion: Promise<TurnResult>;
}

/**
 * How a session's process ended.
 *
 * `unknown` is the honest answer when no evidence was recorded — the previous
 * code wrote the word `crash` there, asserting a failure it had not observed.
 * `session-destroyed` (the console was torn down out from under a live process)
 * and `program-exit` (the program decided to leave) are different events and
 * must not collapse into one another, because they imply different next starts.
 */
export type ExitClass = 'clean' | 'program-exit' | 'signal' | 'session-destroyed' | 'unknown';

export interface ExitRecord {
  version: 1;
  class: ExitClass;
  /** Exit code, when the program exited of its own accord. */
  code?: number;
  /** Signal that killed it, when one did. */
  signal?: string;
  /** Raw wait status as the pane shell saw it (tmux only). */
  status?: number;
  at?: string;
  /** One line an operator can read. */
  detail: string;
}

/**
 * Classify a shell `$?`. Above 128 the shell is reporting 128+signal — the only
 * signal evidence a pane wrapper can give us.
 */
export function classifyShellStatus(status: number): ExitRecord {
  if (!Number.isFinite(status))
    return { version: 1, class: 'unknown', detail: 'pane wrote an unreadable exit status' };
  if (status === 0)
    return { version: 1, class: 'clean', code: 0, status, detail: 'exited cleanly (code 0)' };
  if (status > 128) {
    const signal = status - 128;
    return {
      version: 1, class: 'signal', signal: `SIG${signal}`, status,
      detail: `killed by signal ${signal} (shell status ${status})`,
    };
  }
  return { version: 1, class: 'program-exit', code: status, status, detail: `exited with code ${status}` };
}

/** Classify a child process exit reported directly by node. */
export function classifyChildExit(code: number | null, signal: string | null): ExitRecord {
  if (signal)
    return { version: 1, class: 'signal', signal, detail: `killed by ${signal}` };
  if (code === 0)
    return { version: 1, class: 'clean', code: 0, detail: 'exited cleanly (code 0)' };
  if (code === null)
    return { version: 1, class: 'unknown', detail: 'the process ended with neither a code nor a signal' };
  return { version: 1, class: 'program-exit', code, detail: `exited with code ${code}` };
}

/** The single definition of terminal success. Nothing else may re-derive it. */
export const isTerminalSuccess = (outcome: TurnOutcome): boolean => outcome === 'completed';

/** Build a TurnResult with `succeeded` always consistent with `outcome`. */
export function turnResult(
  accepted: boolean, outcome: TurnOutcome, detail?: string, output?: string,
  cancellationSource?: TurnCancellationSource,
): TurnResult {
  return {
    accepted, outcome, succeeded: isTerminalSuccess(outcome), detail, output,
    ...(outcome === 'cancelled' && cancellationSource ? { cancellationSource } : {}),
  };
}

export interface SubmitPromptOptions {
  /** Cancel active work before delivering this prompt. */
  interrupt?: boolean;
  /** Internal provenance; ordinary callers must leave this unset. */
  interruptSource?: TurnCancellationSource;
  /** Typed in-process provenance. Text markers never grant this origin. */
  origin?: PromptOrigin;
  /** Use the ACP steering extension when available; ignored by other backends. */
  steer?: boolean;
  /** Audit-grade actor detail persisted with the conversation admission record. */
  actor?: { browserSession?: string };
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
  origin?: PromptOrigin;
  cancellationSource?: TurnCancellationSource;
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

export interface ConversationHandlePage {
  events: ConversationEventV1[];
  firstAvailableCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  snapshot: ConversationSnapshot;
}

export interface SessionHandle {
  readonly backend: SessionBackendId;
  readonly pid: number;
  isAlive(): boolean;
  snapshot(): SessionSnapshot;
  // ── durable conversation ledger (ACP sessions only) ────────────────────────
  conversationPage?(request: { after?: string; limit?: number }): ConversationHandlePage;
  conversationSnapshot?(): ConversationSnapshot;
  subscribeConversation?(listener: (event: ConversationEventV1) => void): () => void;
  /** Durably admit an idempotent browser prompt; resolves on admission. */
  submitPromptBrowser?(command: SubmitPromptCommand): Promise<PromptReceipt>;
  /**
   * Hand the session a prompt and return as soon as it has accepted
   * responsibility for it. Throws `SessionControlError` if it cannot.
   */
  queuePrompt(text: string, options?: SubmitPromptOptions): Promise<QueuedPrompt>;
  /** Queue a prompt and wait for its terminal result. */
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<TurnResult>;
  interrupt(source?: TurnCancellationSource): Promise<void>;
  respondPermission(permissionId: string, optionId: string): boolean;
  eventsSince(seq: number): SessionEvent[];
  subscribe(listener: (event: SessionEvent) => void): () => void;
  setControllerAttached(attached: boolean): void;
  /** How the backing process ended, or null while it is still running. */
  exitResult(): ExitRecord | null;
  close(): Promise<void>;
}
