import type {TaskCreatedNotice} from './task-notice.js';
import type { PromptOrigin, SessionSnapshot, TurnCancellationSource, TurnOutcome } from './types.js';

/**
 * Durable conversation domain schema for managed-session consoles.
 *
 * `SessionEvent` in ./types.js remains the compact diagnostic projection; the
 * types here describe the durable per-role conversation ledger. Nothing in this
 * file touches the wire: transport updates are reduced into these shapes by a
 * session adapter, and the store assigns `seq`/`eventId`/timestamps.
 */

export type ConversationEventKind =
  | 'prompt.admitted' | 'prompt.started' | 'prompt.interrupt_requested'
  | 'message.chunk' | 'message.replace'
  | 'thought.chunk' | 'thought.replace'
  | 'plan.replace'
  | 'tool.upsert' | 'tool.content_chunk'
  | 'permission.requested' | 'permission.resolved'
  | 'file.attached'
  | 'fleet.task_created'
  | 'monitor.delivery'
  | 'usage.updated'
  | 'turn.state' | 'turn.completed'
  | 'session.state' | 'session.info' | 'session.ownership' | 'capabilities.updated'
  | 'error'
  /** A well-formed transport update this version cannot represent. Bounded, never a crash. */
  | 'unsupported';

/** Where a conversation record came from. Typed provenance, never prompt text. */
export type ConversationSource =
  | 'owner_admin_console' | 'owner_channel' | 'fleet_monitor' | 'scheduled_loop' | 'startup'
  | 'local_console' | 'agent' | 'agent_replay' | 'fleet_lifecycle';

// ── Normalized content ────────────────────────────────────────────────────────
// Every text payload is capped; oversized or redacted content keeps its byte
// count and digest so the transcript stays honest about what it is not showing.

export interface NormalizedText {
  type: 'text';
  text: string;
  /** Byte length of the ORIGINAL text, before any cap or redaction. */
  bytes: number;
  truncated?: true;
  /** Present when truncated or redacted: sha-256 (hex, first 24) of the original. */
  digest?: string;
  redacted?: true;
}

/** Media payloads are described, not carried; rendering is a later phase. */
export interface NormalizedMedia {
  type: 'image' | 'audio';
  mimeType: string;
  bytes: number;
  uri?: string;
}

export interface NormalizedResourceLink {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface NormalizedResource {
  type: 'resource';
  uri?: string;
  mimeType?: string;
  bytes: number;
}

export type NormalizedContentBlock =
  | NormalizedText | NormalizedMedia | NormalizedResourceLink | NormalizedResource;

/** A capped text fragment inside a larger payload (diff sides, previews). */
export interface CappedText {
  text: string;
  bytes: number;
  truncated?: true;
  digest?: string;
  /** Bytes omitted from the front when the retained fragment is a tail. */
  omittedPrefixBytes?: number;
  /** The retained tail starts inside one logical line because that line alone exceeded the cap. */
  startsMidLine?: true;
}

/** A path kept as a UTF-8-safe tail, with additive provenance only when capped. */
export interface BoundedPath {
  path: string;
  pathBytes?: number;
  pathTruncated?: true;
  pathDigest?: string;
  pathOmittedPrefixBytes?: number;
}

export type NormalizedToolContent =
  | { type: 'content'; content: NormalizedContentBlock }
  | BoundedPath & {
      type: 'diff';
      newText: CappedText;
      oldText?: CappedText;
      /** Additive provenance for oversized snapshot diffs reduced to their changed region. */
      operation?: 'append' | 'edit' | 'delete' | 'noop' | 'replace';
      beforeBytes?: number;
      afterBytes?: number;
      commonPrefixBytes?: number;
      commonSuffixBytes?: number;
      bounded?: true;
    }
  /** A tool-owned display terminal reference — never a PTY attachment. */
  | { type: 'terminal'; terminalId: string };

/**
 * Adapter-specific `_meta`, quarantined by namespace. The UI may ignore any
 * entry; nothing outside adapter-specific renderers may interpret `value`.
 */
export interface AdapterMeta {
  namespace: string;
  value?: unknown;
  /** Set when the value exceeded the metadata cap and was dropped. */
  truncated?: true;
  bytes?: number;
}

// ── Event payloads ───────────────────────────────────────────────────────────

export interface MessageChunkPayload {
  role: 'user' | 'assistant';
  content: NormalizedContentBlock;
}

export interface ThoughtChunkPayload {
  content: NormalizedContentBlock;
}

export interface PlanEntryPayload {
  content: CappedText;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanReplacePayload {
  /** Absent for the standard whole-session plan; set for ID'd (unstable) plans. */
  planId?: string;
  entries?: PlanEntryPayload[];
  /** Unstable plan representations we can reference but not structure. */
  file?: { uri: string };
  markdown?: CappedText;
  removed?: true;
}

export interface ToolUpsertPayload {
  toolCallId: string;
  /** True for `tool_call` (full snapshot), false for `tool_call_update` (patch). */
  snapshot: boolean;
  title?: string;
  kind?: string;
  status?: string;
  content?: NormalizedToolContent[];
  locations?: Array<BoundedPath & { line?: number }>;
  rawInput?: BoundedJson;
  rawOutput?: BoundedJson;
}

export interface UsageUpdatedPayload {
  used: number;
  size: number;
  /** Agent-reported; absence is normal and cost semantics differ per adapter. */
  cost?: { amount: number; currency: string };
}

export interface SessionStatePayload {
  currentModeId?: string;
}

/** First event of a generation: the launch it belongs to and that launch's task, or null for a non-task role. */
export interface SessionOwnershipPayload {
  /** Null for a role without temp-supervisor metadata (explicitly standalone). */
  launchId: string | null;
  taskId: string | null;
}

export interface SessionInfoPayload {
  title?: string | null;
  updatedAt?: string | null;
}

export interface CapabilitiesUpdatedPayload {
  commands?: Array<{ name: string; description: CappedText; inputHint?: string }>;
  configOptions?: BoundedJson;
}

export interface UnsupportedPayload {
  /** The wire discriminant (or 'unknown' when even that was absent). */
  sessionUpdate: string;
  bytes: number;
  /** Digest of the omitted original/normalized representation when it was bounded. */
  digest?: string;
  /** Sanitized JSON preview, capped; enough to diagnose, never to exhaust. */
  preview?: string;
}

export interface PromptAdmittedPayload {
  text?: NormalizedText;
  /** Human-only display body; never used to recover or dispatch an external prompt. */
  displayText?: NormalizedText;
  /** External E2E bodies stay out of fleet state: digest/size only. */
  external?: { digest: string; bytes: number };
  queuedBehind: number;
}

export interface PromptStartedPayload {
  queuedBehind?: number;
  /** Present when one adapter turn carries several admitted prompts; `turnId` is the shared turn. */
  batch?: { turnId: string; index: number; size: number };
}

export interface PromptInterruptRequestedPayload {
  commandId?: string;
  cancellationSource?: TurnCancellationSource;
}

export interface PermissionRequestedPayload {
  toolCallId?: string;
  title?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  expiresAt?: string;
}

export interface PermissionResolvedPayload {
  decision: 'allowed' | 'denied' | 'cancelled' | 'expired';
  decisionSource: 'automatic' | 'manual';
  optionId?: string;
  policy?: string;
  reason?: string;
}

/** Body-free monitor evidence. Tool ids, titles, output, and wake text are never stored. */
export interface MonitorDeliveryPayload {
  policy: 'after_tool';
  state: 'deferred' | 'direct' | 'after_tool' | 'timeout' | 'unsupported';
  activeToolCount: number;
  waitedMs: number;
}

export interface TurnStatePayload {
  state: 'queued' | 'running' | 'awaiting_permission' | 'interrupt_requested';
}

export interface TurnCompletedPayload {
  outcome: TurnOutcome | 'unknown_after_restart';
  stopReason?: string;
  cancellationSource?: TurnCancellationSource;
}

export interface SessionLifecyclePayload {
  status: 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'failed' | 'offline';
  detail?: string;
}

export interface ErrorPayload {
  message: string;
}

/** Structured-but-untrusted JSON, serialized and capped rather than trusted. */
export interface BoundedJson {
  json?: unknown;
  bytes: number;
  truncated?: true;
  digest?: string;
  redacted?: true;
}

export type ConversationPayload =
  | { attachment: import('../file-delivery/types.js').DeliveredFile }
  | MessageChunkPayload | ThoughtChunkPayload | PlanReplacePayload | ToolUpsertPayload
  | UsageUpdatedPayload | SessionStatePayload | SessionInfoPayload | SessionOwnershipPayload
  | CapabilitiesUpdatedPayload | UnsupportedPayload | PromptAdmittedPayload
  | PromptStartedPayload | PromptInterruptRequestedPayload | PermissionRequestedPayload
  | PermissionResolvedPayload | TurnStatePayload | TurnCompletedPayload
  | MonitorDeliveryPayload
  | SessionLifecyclePayload | ErrorPayload | TaskCreatedNotice;

// ── The durable event ────────────────────────────────────────────────────────

export interface ConversationEventV1 {
  schemaVersion: 1;
  roleId: string;
  /** Opaque, durable, unique. Browser dedupe key across replay/reconnect. */
  eventId: string;
  /** Durable monotonic sequence for this role's store. */
  seq: number;
  at: string;
  /** Changes on every runner restart; pending IDs from prior generations are stale. */
  sessionGeneration: string;
  acpSessionId?: string;
  kind: ConversationEventKind;
  /** Fleet admission ID. */
  promptId?: string;
  /** Fleet turn ID; v1 turns reuse the prompt ID. */
  turnId?: string;
  /** Agent-owned when supplied; optional in ACP v1. */
  messageId?: string;
  toolCallId?: string;
  permissionId?: string;
  /**
   * The idempotency key of the command that produced this record. Persisted so
   * the command-id index can be rebuilt from segments alone on recovery.
   */
  commandId?: string;
  source?: ConversationSource;
  actor?: { browserSession?: string; externalSenderDigest?: string };
  payload: ConversationPayload;
  adapterMeta?: AdapterMeta[];
}

// ── Browser commands and receipt transport contracts ────────────────────────

export interface SubmitPromptCommand {
  expectedSessionGeneration?: string;
  /** Live speech must not silently queue behind an unrelated turn. */
  requireIdle?: boolean;
  /** Idempotency-Key / clientRequestId. Reuse with a different body is a conflict. */
  commandId: string;
  text: string;
  source: 'owner_admin_console';
  actorBrowserSession: string;
}

export interface PromptReceipt {
  commandId: string;
  /** Original durable admission generation; absent when historical provenance is unknown. */
  sessionGeneration?: string;
  promptId: string;
  state: 'queued' | 'starting';
  queuedBehind: number;
  acceptedAt: string;
  /** Cursor of the durable `prompt.admitted` event. */
  eventCursor: string;
}

export interface PermissionDecisionCommand {
  commandId: string;
  permissionId: string;
  sessionGeneration: string;
  optionId: string;
}

/** One admitted prompt not yet handed to the agent, as reported by the queue that owns it. */
export interface PendingPromptSummary {
  promptId: string;
  source: ConversationSource;
  admittedAt: string;
  bytes: number;
  /** A bounded preview, present only for a body the ledger already holds. */
  text?: string;
  textTruncated?: boolean;
}

export interface ConversationSnapshot {
  sessionGeneration: string;
  readiness: 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'failed' | 'offline';
  queueDepth: number;
  pendingPermissionIds: string[];
  historyDegraded?: boolean;
  /** Live observation is unavailable; REST may still serve canonical durable data. */
  observationFailure?: 'capture_failed';
  /** Every waiting prompt, in delivery order; `pendingPromptCount` equals its length. */
  pendingPrompts?: PendingPromptSummary[];
  pendingPromptCount?: number;
}

/** Position captured synchronously with the owning backend's complete live state. */
export interface ObservationPosition {
  sessionGeneration: string;
  stateRevision: number;
  ledgerBarrier: number;
}

export interface ConversationObservationState extends ConversationSnapshot, ObservationPosition {
  alive: boolean;
  activePromptIds: string[];
  pendingPrompts: PendingPromptSummary[];
  pendingPromptCount: number;
  /** Already presented and sanitized by the backend; never reconstructed from raw options. */
  pendingPermissions: Array<PermissionRequestedPayload & { permissionId: string }>;
  commands: NonNullable<CapabilitiesUpdatedPayload['commands']>;
  runtimeModel?: SessionSnapshot['runtimeModel'];
  reasoningEffort?: SessionSnapshot['reasoningEffort'];
  permissionMode?: SessionSnapshot['permissionMode'];
}

export interface ConversationObservation {
  snapshot: ConversationObservationState;
  unsubscribe(): void;
}

export interface ConversationPage {
  events: ConversationEventV1[];
  firstAvailableCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  snapshot: ConversationSnapshot;
}

export type { PromptOrigin };
