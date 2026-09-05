import type { SessionBackendId } from '../config.js';
import type {
  ConversationEventV1, ConversationSnapshot, PromptReceipt, SubmitPromptCommand,
} from './conversation-types.js';

/**
 * TURN OCCUPANCY, and nothing else: `idle` means no fleet-tracked turn is in
 * flight, which is exactly the question `arbiter.tryScheduled` asks before it
 * admits a prompt. It is NOT a claim that the agent is doing nothing — a wake
 * delivered through the `_session/steering` extension answers `startedNewTurn`
 * and runs a whole turn that fleet never gets a `session/prompt` response for
 * (ACP has no turn-end session update), so `readiness` stays `idle` for its
 * entire duration. Anything reporting activity or liveness to a human must
 * corroborate with `SessionSnapshot.activity` instead of reading `idle` here as
 * "not working".
 */
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
  | { kind: 'owner'; requestId: string; displayText?: string }
  | { kind: 'fleet-monitor' }
  | { kind: 'scheduled-loop'; loop: string; runId: string }
  | { kind: 'owner-admin-console'; commandId: string };

export interface RuntimeSelectorMetadata {
  /** Exact provider/model identifier reported by the live managed session. */
  value: string;
  /** Complete provider-supplied label for that exact value, when available. */
  label?: string;
}

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
  /** Body-free monitor safe-boundary disposition, when this was an after_tool wake. */
  safeBoundary?: {
    state: 'direct' | 'after_tool' | 'timeout' | 'unsupported';
    waitedMs: number;
    activeToolCount: number;
  };
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

/** Stable body-free reason shared by ACP recovery and durable ingress. */
export const ACP_CANCEL_DEADLINE_EXCEEDED = 'ACP_CANCEL_DEADLINE_EXCEEDED';
/** Native Codex equivalent; kept distinct so diagnostics name the failing transport. */
export const CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED =
  'CODEX_APP_SERVER_CANCEL_DEADLINE_EXCEEDED';

export class SessionControlError extends Error {
  constructor(
    readonly kind: ControlFailureKind,
    message: string,
    /** Stable body-free machine reason for recovery/audit decisions. */
    readonly reasonCode?: string,
  ) {
    super(message);
    this.name = 'SessionControlError';
  }
}

/**
 * How an explicit cancellation ended. Forced recovery is a SUCCESS: the turn is
 * over and the session is being reclaimed. Reporting it as a failed interrupt is
 * what made owners, the control plane and the web console retry an operation
 * that had already done exactly what was asked.
 */
export interface InterruptOutcome {
  /** `settled` — the turn (or nothing) ended cooperatively. `forced` — the adapter ignored the cancel and was restarted. */
  state: 'settled' | 'forced';
  /** Stable body-free reason present only for a forced recovery. */
  reasonCode?: string;
}

/**
 * What an `AgentSession.interrupt` implementation may resolve. Before 0.17.1 the
 * contract was `Promise<void>`, and resolving at all meant the cancellation had
 * taken effect cooperatively — so an implementation written against that
 * contract stays valid and keeps its exact meaning. Only in-tree consumers read
 * the richer outcome, and they normalize through `interruptOutcome` first.
 */
export type InterruptResult = InterruptOutcome | void;

/** The one place the legacy `void` reply is given its meaning: `settled`. */
export function interruptOutcome(result: InterruptResult): InterruptOutcome {
  return result ?? { state: 'settled' };
}

/**
 * A prompt the live session has taken responsibility for. Interactive callers
 * stop here: the session has the prompt, and waiting for the turn to finish is
 * a different question with a different, much longer, timescale.
 */
/**
 * What actually happened to an admitted prompt, so a caller reporting to a
 * human can be accurate instead of repeating what it asked for.
 *
 * `interrupted` is only ever returned when a turn was really cancelled for this
 * prompt. `deferred` says the session is busy with work this prompt could not
 * safely pre-empt — the prompt is admitted and will run, just not yet.
 */
export type PromptDelivery = 'started' | 'queued' | 'interrupted' | 'deferred';

export interface QueuedPrompt {
  promptId: string;
  /** Turns already queued ahead of this one. 0 means it starts immediately. */
  queuedBehind: number;
  origin?: PromptOrigin;
  /** The turn's terminal result. Never rejects. */
  completion: Promise<TurnResult>;
  /** Observed admission outcome. Absent on backends that do not report it. */
  delivery?: PromptDelivery;
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
  /** Raw wait status retained when migrating a legacy shell-exit record. */
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
  /** Inject into active work when the selected backend supports steering. */
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
  runtimeModel?: RuntimeSelectorMetadata;
  reasoningEffort?: RuntimeSelectorMetadata;
  permissionMode?: {
    /** Effective harness-neutral policy after native overrides. */
    fleetMode: import('../config.js').FleetPermissionMode;
    /** Exact harness-native approval/permission mode used by this runner. */
    nativeMode: string;
  };
  /**
   * Observed agent activity, independent of turn occupancy: the evidence a
   * human-facing surface needs before calling a role idle. When absent, no
   * evidence is not evidence of inactivity.
   */
  activity?: SessionActivity;
}

export interface SessionActivity {
  /** Tool calls currently reserved (lifecycle open or permission pending). */
  activeToolCalls: number;
  /** When the agent last sent ANY session update, replay excluded. */
  lastUpdateAt?: string;
}

/** Provider-neutral behavior exposed by a session transport. */
export interface AgentSessionCapabilities {
  streaming: boolean;
  durableConversation: boolean;
  promptInput: boolean;
  interrupt: boolean;
  steering: boolean;
  permissions: boolean;
  toolBoundaryDelivery: boolean;
  messagePhases: boolean;
  resume: boolean;
}

/** Conservative static capabilities used before a live session is reachable. */
export function sessionBackendCapabilities(
  backend: SessionBackendId, harness?: string,
): AgentSessionCapabilities {
  if (backend === 'codex-app-server') return {
    streaming: true,
    durableConversation: true,
    promptInput: true,
    interrupt: true,
    steering: true,
    permissions: true,
    toolBoundaryDelivery: false,
    messagePhases: true,
    resume: true,
  };
  return {
    streaming: true,
    durableConversation: true,
    promptInput: true,
    interrupt: true,
    steering: false,
    permissions: true,
    toolBoundaryDelivery: true,
    messagePhases: harness === 'codex',
    resume: true,
  };
}

export type SessionEventKind =
  | 'state'
  | 'agent_text'
  | 'thought'
  | 'tool_call'
  | 'tool_update'
  | 'permission'
  | 'monitor_delivery'
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
  /**
   * Adapter-authenticated presentation phase for assistant text. Only the
   * exact Codex phase marker is promoted; absence/unknown values stay unset.
   */
  messagePhase?: 'commentary' | 'final_answer';
  /** Stable adapter message/item id when supplied. */
  messageId?: string;
  /** True when the adapter is replaying history rather than emitting live work. */
  replayed?: boolean;
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
  /** Body-free evidence for monitor safe-boundary delivery. */
  monitorPolicy?: 'after_tool';
  activeToolCount?: number;
  waitedMs?: number;
}

export interface ConversationHandlePage {
  events: ConversationEventV1[];
  firstAvailableCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  snapshot: ConversationSnapshot;
}

/**
 * The live, harness-neutral contract between Fleet and one agent session.
 * Harness adapters construct this handle; orchestration code must not depend
 * on any concrete transport which implements it.
 */
export interface AgentSession {
  readonly backend: SessionBackendId;
  readonly pid: number;
  /** Live capabilities; optional only for source compatibility with external adapters. */
  readonly capabilities?: AgentSessionCapabilities;
  isAlive(): boolean;
  snapshot(): SessionSnapshot;
  // ── durable conversation ledger ────────────────────────────────────────────
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
  /** Monitor-only safe-boundary delivery. Never implies human/control cancellation. */
  submitPromptAfterTool?(text: string, options?: SubmitPromptOptions): Promise<TurnResult>;
  /**
   * Cancel the active turn. Resolves when the cancellation has taken effect —
   * cooperatively (`settled`) or through bounded forced recovery (`forced`).
   * It rejects only when the cancellation itself could not be delivered.
   *
   * The return type is widened to `InterruptResult` for one reason: an
   * implementation written against the pre-0.17.1 `Promise<void>` contract must
   * keep compiling. Read it through `interruptOutcome`, never directly.
   */
  interrupt(source?: TurnCancellationSource): Promise<InterruptResult>;
  respondPermission(permissionId: string, optionId: string): boolean;
  /** Generation-bound browser decision; stale/settled/invalid all fail closed. */
  respondPermissionV2?(
    permissionId: string, optionId: string, sessionGeneration: string,
  ): 'accepted' | 'stale';
  eventsSince(seq: number): SessionEvent[];
  subscribe(listener: (event: SessionEvent) => void): () => void;
  setControllerAttached(attached: boolean): void;
  /** How the backing process ended, or null while it is still running. */
  exitResult(): ExitRecord | null;
  close(): Promise<void>;
}

/** @deprecated Public compatibility name; use AgentSession. */
export type SessionHandle = AgentSession;
