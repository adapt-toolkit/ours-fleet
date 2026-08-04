import { createHash } from 'node:crypto';

import type * as acp from '@agentclientprotocol/sdk';

import type {
  AdapterMeta, BoundedJson, CapabilitiesUpdatedPayload, CappedText, ConversationEventKind,
  ConversationPayload, MessageChunkPayload, NormalizedContentBlock, NormalizedText,
  NormalizedToolContent, PlanEntryPayload, PlanReplacePayload, ToolUpsertPayload,
  UnsupportedPayload,
} from './conversation-types.js';

/**
 * Reduce one ACP v1 `session/update` into one conversation-domain event draft.
 *
 * This is the protocol seam: v1 create/update pairs (and a future v2 upsert
 * stream) both land in the same domain shapes. The function is pure and total —
 * it never throws, never passes raw wire objects through, caps every payload,
 * and quarantines namespaced `_meta` so unknown extensions cannot leak into
 * generic rendering paths.
 */

/** Cap for any single normalized text payload (spec §5.3). */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Cap for one adapter `_meta` namespace value. */
export const MAX_META_BYTES = 16 * 1024;
/** Cap for serialized raw tool input/output retained as structured JSON. */
export const MAX_RAW_JSON_BYTES = 64 * 1024;
/** Cap for the sanitized preview of an unsupported update. */
export const MAX_UNSUPPORTED_PREVIEW_CHARS = 2_048;

export interface NormalizeOptions {
  /**
   * Replace every text payload with this placeholder, keeping byte count and
   * digest. Used for scheduled-loop turns whose output must not be retained.
   */
  redactText?: string;
}

export interface NormalizedUpdate {
  kind: ConversationEventKind;
  payload: ConversationPayload;
  messageId?: string;
  toolCallId?: string;
  adapterMeta?: AdapterMeta[];
}

const digest24 = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Truncate to a byte budget without splitting a UTF-8 code point. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buffer = Buffer.from(text).subarray(0, maxBytes);
  return buffer.toString('utf8').replace(/�+$/u, '');
}

function cappedText(raw: unknown, redact?: string): CappedText {
  const text = asString(raw) ?? '';
  const bytes = Buffer.byteLength(text);
  if (redact !== undefined)
    return { text: redact, bytes, truncated: true, digest: digest24(text) };
  if (bytes <= MAX_TEXT_BYTES) return { text, bytes };
  return {
    text: truncateUtf8(text, MAX_TEXT_BYTES), bytes,
    truncated: true, digest: digest24(text),
  };
}

function normalizedText(raw: unknown, redact?: string): NormalizedText {
  const text = asString(raw) ?? '';
  const bytes = Buffer.byteLength(text);
  if (redact !== undefined)
    return { type: 'text', text: redact, bytes, redacted: true, digest: digest24(text) };
  const capped = cappedText(text);
  return {
    type: 'text', text: capped.text, bytes,
    ...(capped.truncated ? { truncated: true as const, digest: capped.digest } : {}),
  };
}

function normalizeContentBlock(block: unknown, redact?: string): NormalizedContentBlock {
  if (!isRecord(block)) return normalizedText('', redact);
  switch (block.type) {
    case 'text':
      return normalizedText(block.text, redact);
    case 'image':
    case 'audio':
      // Described, not carried: media rendering has its own validation phase,
      // and base64 payloads must never ride into the durable store unchecked.
      return {
        type: block.type,
        mimeType: asString(block.mimeType) ?? 'application/octet-stream',
        bytes: Buffer.byteLength(asString(block.data) ?? ''),
        ...(asString(block.uri) ? { uri: asString(block.uri) } : {}),
      };
    case 'resource_link':
      return {
        type: 'resource_link',
        uri: asString(block.uri) ?? '',
        ...(asString(block.name) ? { name: asString(block.name) } : {}),
        ...(asString(block.mimeType) ? { mimeType: asString(block.mimeType) } : {}),
      };
    case 'resource': {
      const resource = isRecord(block.resource) ? block.resource : {};
      const body = asString(resource.text) ?? asString(resource.blob) ?? '';
      return {
        type: 'resource',
        ...(asString(resource.uri) ? { uri: asString(resource.uri) } : {}),
        ...(asString(resource.mimeType) ? { mimeType: asString(resource.mimeType) } : {}),
        bytes: Buffer.byteLength(body),
      };
    }
    default:
      return normalizedText(`[${asString(block.type) ?? 'unknown-content'}]`);
  }
}

function boundedJson(value: unknown): BoundedJson {
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? 'null'; }
  catch {
    // Circular or otherwise unserializable: keep the fact, drop the value.
    return { bytes: 0, truncated: true };
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_RAW_JSON_BYTES) return { json: value, bytes };
  return { bytes, truncated: true, digest: digest24(serialized) };
}

function quarantineMeta(meta: unknown): AdapterMeta[] | undefined {
  if (!isRecord(meta)) return undefined;
  const entries: AdapterMeta[] = [];
  for (const [namespace, value] of Object.entries(meta)) {
    let serialized: string;
    try { serialized = JSON.stringify(value) ?? 'null'; }
    catch { entries.push({ namespace, truncated: true }); continue; }
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= MAX_META_BYTES) entries.push({ namespace, value });
    else entries.push({ namespace, truncated: true, bytes });
  }
  return entries.length ? entries : undefined;
}

function planEntries(raw: unknown, redact?: string): PlanEntryPayload[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map(entry => ({
    content: cappedText(entry.content, redact),
    priority: entry.priority === 'high' || entry.priority === 'medium' || entry.priority === 'low'
      ? entry.priority : 'medium',
    status: entry.status === 'pending' || entry.status === 'in_progress' || entry.status === 'completed'
      ? entry.status : 'pending',
  }));
}

function normalizeToolContent(raw: unknown, redact?: string): NormalizedToolContent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(isRecord).map((item): NormalizedToolContent => {
    switch (item.type) {
      case 'diff':
        return {
          type: 'diff',
          path: asString(item.path) ?? '',
          newText: cappedText(item.newText, redact),
          ...(item.oldText != null ? { oldText: cappedText(item.oldText, redact) } : {}),
        };
      case 'terminal':
        return { type: 'terminal', terminalId: asString(item.terminalId) ?? '' };
      case 'content':
      default:
        return { type: 'content', content: normalizeContentBlock(item.content, redact) };
    }
  });
}

function toolUpsert(update: Record<string, unknown>, snapshot: boolean, redact?: string): ToolUpsertPayload {
  const payload: ToolUpsertPayload = {
    toolCallId: asString(update.toolCallId) ?? '',
    snapshot,
  };
  if (asString(update.title) !== undefined) payload.title = redact ?? asString(update.title);
  if (asString(update.kind) !== undefined) payload.kind = asString(update.kind);
  if (asString(update.status) !== undefined) payload.status = asString(update.status);
  const content = normalizeToolContent(update.content, redact);
  if (content) payload.content = content;
  if (Array.isArray(update.locations)) {
    payload.locations = update.locations.filter(isRecord).map(location => ({
      path: asString(location.path) ?? '',
      ...(asFiniteNumber(location.line) !== undefined ? { line: asFiniteNumber(location.line) } : {}),
    }));
  }
  if (update.rawInput !== undefined) payload.rawInput = boundedJson(update.rawInput);
  if (update.rawOutput !== undefined) payload.rawOutput = boundedJson(update.rawOutput);
  return payload;
}

function unsupported(update: unknown): UnsupportedPayload {
  let serialized: string;
  try { serialized = JSON.stringify(update) ?? String(update); }
  catch { serialized = '[unserializable update]'; }
  const kind = isRecord(update) ? asString(update.sessionUpdate) : undefined;
  return {
    sessionUpdate: kind ?? 'unknown',
    bytes: Buffer.byteLength(serialized),
    preview: serialized.slice(0, MAX_UNSUPPORTED_PREVIEW_CHARS),
  };
}

export function normalizeSessionUpdate(
  update: acp.SessionUpdate, options: NormalizeOptions = {},
): NormalizedUpdate {
  const redact = options.redactText;
  const raw: unknown = update;
  if (!isRecord(raw) || typeof raw.sessionUpdate !== 'string')
    return { kind: 'unsupported', payload: unsupported(raw) };
  const adapterMeta = quarantineMeta(raw._meta);
  const withMeta = (result: Omit<NormalizedUpdate, 'adapterMeta'>): NormalizedUpdate =>
    adapterMeta ? { ...result, adapterMeta } : result;

  switch (raw.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk': {
      const payload: MessageChunkPayload = {
        role: raw.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant',
        content: normalizeContentBlock(raw.content, redact),
      };
      const messageId = asString(raw.messageId);
      return withMeta({ kind: 'message.chunk', payload, ...(messageId ? { messageId } : {}) });
    }
    case 'agent_thought_chunk': {
      const messageId = asString(raw.messageId);
      return withMeta({
        kind: 'thought.chunk',
        payload: { content: normalizeContentBlock(raw.content, redact) },
        ...(messageId ? { messageId } : {}),
      });
    }
    case 'tool_call':
    case 'tool_call_update': {
      const payload = toolUpsert(raw, raw.sessionUpdate === 'tool_call', redact);
      return withMeta({
        kind: 'tool.upsert', payload,
        ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      });
    }
    case 'plan':
      return withMeta({
        kind: 'plan.replace',
        payload: { entries: planEntries(raw.entries, redact) },
      });
    case 'plan_update': {
      // Unstable representation: normalize what is structured, reference the rest.
      const plan = isRecord(raw.plan) ? raw.plan : {};
      const payload: PlanReplacePayload = {
        ...(asString(plan.planId) ? { planId: asString(plan.planId) } : {}),
      };
      if (plan.type === 'items') payload.entries = planEntries(plan.entries, redact);
      else if (plan.type === 'file' && asString(plan.uri)) payload.file = { uri: asString(plan.uri)! };
      else if (plan.type === 'markdown') payload.markdown = cappedText(plan.content, redact);
      return withMeta({ kind: 'plan.replace', payload });
    }
    case 'plan_removed':
      return withMeta({
        kind: 'plan.replace',
        payload: {
          ...(asString(raw.planId) ? { planId: asString(raw.planId) } : {}),
          removed: true,
        },
      });
    case 'usage_update': {
      const cost = isRecord(raw.cost)
        && asFiniteNumber(raw.cost.amount) !== undefined && asString(raw.cost.currency)
        ? { amount: asFiniteNumber(raw.cost.amount)!, currency: asString(raw.cost.currency)! }
        : undefined;
      return withMeta({
        kind: 'usage.updated',
        payload: {
          used: asFiniteNumber(raw.used) ?? 0,
          size: asFiniteNumber(raw.size) ?? 0,
          ...(cost ? { cost } : {}),
        },
      });
    }
    case 'current_mode_update':
      return withMeta({
        kind: 'session.state',
        payload: { currentModeId: asString(raw.currentModeId) },
      });
    case 'session_info_update':
      return withMeta({
        kind: 'session.info',
        payload: {
          ...(raw.title !== undefined ? { title: asString(raw.title) ?? null } : {}),
          ...(raw.updatedAt !== undefined ? { updatedAt: asString(raw.updatedAt) ?? null } : {}),
        },
      });
    case 'available_commands_update': {
      const commands = Array.isArray(raw.availableCommands)
        ? raw.availableCommands.filter(isRecord).map(command => ({
          name: asString(command.name) ?? '',
          description: cappedText(command.description),
          ...(isRecord(command.input) && asString(command.input.hint)
            ? { inputHint: asString(command.input.hint) } : {}),
        }))
        : [];
      const payload: CapabilitiesUpdatedPayload = { commands };
      return withMeta({ kind: 'capabilities.updated', payload });
    }
    case 'config_option_update':
      // Structured but adapter-shaped: retained as bounded JSON for later,
      // capability-gated rendering rather than trusted field-by-field today.
      return withMeta({
        kind: 'capabilities.updated',
        payload: { configOptions: boundedJson(raw.configOptions) },
      });
    default:
      return withMeta({ kind: 'unsupported', payload: unsupported(raw) });
  }
}
