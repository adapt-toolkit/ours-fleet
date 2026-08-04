import type { PromptOrigin, TurnCancellationSource, TurnOutcome } from './types.js';

/**
 * Durable conversation domain schema (ACP web console, spec §5.2).
 *
 * `SessionEvent` in ./types.js remains the compact diagnostic projection; the
 * types here describe the durable per-role conversation ledger. Nothing in this
 * file touches the wire: ACP updates are reduced into these shapes by the
 * normalizer, and the store (phase 1) assigns `seq`/`eventId`/timestamps.
 */

export type ConversationEventKind =
  | 'prompt.admitted' | 'prompt.started' | 'prompt.interrupt_requested'
  | 'message.chunk' | 'message.replace'
  | 'thought.chunk' | 'thought.replace'
  | 'plan.replace'
  | 'tool.upsert' | 'tool.content_chunk'
  | 'permission.requested' | 'permission.resolved'
  | 'usage.updated'
  | 'turn.state' | 'turn.completed'
  | 'session.state' | 'session.info' | 'capabilities.updated'
  | 'error'
  /** A well-formed ACP update this version cannot represent. Bounded, never a crash. */
  | 'unsupported';

/** Where a conversation record came from. Typed provenance, never prompt text. */
export type ConversationSource =
  | 'browser' | 'owner_channel' | 'fleet_monitor' | 'scheduled_loop' | 'startup'
  | 'local_console' | 'agent' | 'agent_replay';

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
}

export type NormalizedToolContent =
  | { type: 'content'; content: NormalizedContentBlock }
  | { type: 'diff'; path: string; newText: CappedText; oldText?: CappedText }
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
  locations?: Array<{ path: string; line?: number }>;
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
  /** Sanitized JSON preview, capped; enough to diagnose, never to exhaust. */
  preview?: string;
}

export interface PromptAdmittedPayload {
  text?: NormalizedText;
  /** External E2E bodies stay out of fleet state: digest/size only. */
  external?: { digest: string; bytes: number };
  queuedBehind: number;
}

export interface PromptStartedPayload {
  queuedBehind?: number;
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
}

export type ConversationPayload =
  | MessageChunkPayload | ThoughtChunkPayload | PlanReplacePayload | ToolUpsertPayload
  | UsageUpdatedPayload | SessionStatePayload | SessionInfoPayload
  | CapabilitiesUpdatedPayload | UnsupportedPayload | PromptAdmittedPayload
  | PromptStartedPayload | PromptInterruptRequestedPayload | PermissionRequestedPayload
  | PermissionResolvedPayload | TurnStatePayload | TurnCompletedPayload
  | SessionLifecyclePayload | ErrorPayload;

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
  source?: ConversationSource;
  actor?: { browserSession?: string; externalSenderDigest?: string };
  payload: ConversationPayload;
  adapterMeta?: AdapterMeta[];
}

// ── Browser commands and receipts (phase 1 transport contracts) ──────────────

export interface SubmitPromptCommand {
  /** Idempotency-Key / clientRequestId. Reuse with a different body is a conflict. */
  commandId: string;
  text: string;
  source: 'browser';
  actorBrowserSession: string;
}

export interface PromptReceipt {
  commandId: string;
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

export interface ConversationSnapshot {
  sessionGeneration: string;
  readiness: 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'failed' | 'offline';
  queueDepth: number;
  pendingPermissionIds: string[];
  historyDegraded?: boolean;
}

export interface ConversationPage {
  events: ConversationEventV1[];
  firstAvailableCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  snapshot: ConversationSnapshot;
}

export type { PromptOrigin };
