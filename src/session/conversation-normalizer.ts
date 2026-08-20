import { createHash } from 'node:crypto';

import type * as acp from '@agentclientprotocol/sdk';

import type {
  AdapterMeta, BoundedJson, BoundedPath, CapabilitiesUpdatedPayload, CappedText,
  ConversationEventKind, ConversationPayload, MessageChunkPayload, NormalizedContentBlock, NormalizedText,
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
/** Cap for each retained side of an oversized snapshot-style file diff. */
export const MAX_DIFF_TEXT_BYTES = 64 * 1024;
/** Cap for attacker-controlled filesystem paths while retaining their useful basename tail. */
export const MAX_PATH_BYTES = 4 * 1024;
/** Hard cap for the complete normalized update before the durable event envelope is added. */
export const MAX_NORMALIZED_UPDATE_BYTES = 320 * 1024;
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
  /**
   * Replace ACP tool-call IDs in both the normalized event correlation field
   * and payload. The caller may still use the original update for in-memory
   * lifecycle tracking without persisting its private identifier.
   */
  redactToolCallId?: string;
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

/** Keep a UTF-8-safe suffix. Paths and identifiers have no line semantics. */
function truncateUtf8Tail(text: string, maxBytes: number): { text: string; omittedPrefixBytes: number } {
  const buffer = Buffer.from(text);
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return { text: buffer.subarray(start).toString('utf8'), omittedPrefixBytes: start };
}

function boundedPath(raw: unknown): BoundedPath {
  const path = asString(raw) ?? '';
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes <= MAX_PATH_BYTES) return { path };
  const retained = truncateUtf8Tail(path, MAX_PATH_BYTES);
  return {
    path: retained.text,
    pathBytes,
    pathTruncated: true,
    pathDigest: digest24(path),
    pathOmittedPrefixBytes: retained.omittedPrefixBytes,
  };
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

/** Keep the newest UTF-8 tail, aligning to a whole line whenever one fits. */
function cappedTextTail(text: string, maxBytes: number): CappedText {
  const buffer = Buffer.from(text);
  const bytes = buffer.length;
  if (bytes <= maxBytes) return { text, bytes };
  let start = bytes - maxBytes;
  while (start < bytes && (buffer[start] & 0xc0) === 0x80) start++;
  let startsMidLine = start > 0 && buffer[start - 1] !== 0x0a;
  if (startsMidLine) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline >= 0 && newline + 1 < bytes) {
      start = newline + 1;
      startsMidLine = false;
    }
  }
  return {
    text: buffer.subarray(start).toString('utf8'), bytes,
    truncated: true, digest: digest24(text), omittedPrefixBytes: start,
    ...(startsMidLine ? { startsMidLine: true as const } : {}),
  };
}

/** Common unchanged edges in UTF-16 indices, adjusted away from split surrogates. */
function commonEdges(oldText: string, newText: string): { prefix: number; suffix: number } {
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && prefix < limit
      && oldText.charCodeAt(prefix) >= 0xdc00 && oldText.charCodeAt(prefix) <= 0xdfff)
    prefix--;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix
      && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  // A suffix must never begin at the low half of a surrogate pair.
  if (oldEnd < oldText.length && oldText.charCodeAt(oldEnd) >= 0xdc00
      && oldText.charCodeAt(oldEnd) <= 0xdfff) {
    oldEnd++;
    newEnd++;
  }
  return { prefix, suffix: oldText.length - oldEnd };
}

function normalizedDiff(
  item: Record<string, unknown>, redact?: string,
): Extract<NormalizedToolContent, { type: 'diff' }> {
  const path = boundedPath(item.path);
  const oldText = asString(item.oldText);
  const newText = asString(item.newText) ?? '';
  // Preserve the established small-diff contract exactly. Redacted turns also
  // retain their established placeholder shape and never derive private text.
  if (redact !== undefined || oldText === undefined
      || (Buffer.byteLength(oldText) <= MAX_TEXT_BYTES
        && Buffer.byteLength(newText) <= MAX_TEXT_BYTES)) {
    return {
      type: 'diff', ...path,
      newText: cappedText(newText, redact),
      ...(oldText !== undefined ? { oldText: cappedText(oldText, redact) } : {}),
    };
  }

  // ACP adapters may describe an append by sending two complete file snapshots.
  // Persist only the changed region: otherwise a multi-megabyte historical file
  // contributes its prefix twice while the current append disappears past the cap.
  const { prefix, suffix } = commonEdges(oldText, newText);
  const oldEnd = oldText.length - suffix;
  const newEnd = newText.length - suffix;
  const oldDelta = oldText.slice(prefix, oldEnd);
  const newDelta = newText.slice(prefix, newEnd);
  const beforeBytes = Buffer.byteLength(oldText);
  const afterBytes = Buffer.byteLength(newText);
  const commonPrefixBytes = Buffer.byteLength(oldText.slice(0, prefix));
  const commonSuffixBytes = Buffer.byteLength(oldText.slice(oldEnd));
  const operation = oldDelta.length === 0 && newDelta.length === 0
    ? 'noop' as const
    : oldDelta.length === 0 && prefix === oldText.length
      ? 'append' as const
      : newDelta.length === 0
        ? 'delete' as const
        : prefix === 0 && suffix === 0 ? 'replace' as const : 'edit' as const;
  return {
    type: 'diff', ...path, operation, beforeBytes, afterBytes,
    commonPrefixBytes, commonSuffixBytes, bounded: true,
    newText: cappedTextTail(newDelta, MAX_DIFF_TEXT_BYTES),
    ...(oldDelta.length > 0
      ? { oldText: cappedTextTail(oldDelta, MAX_DIFF_TEXT_BYTES) } : {}),
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

const SENSITIVE_JSON_KEYS = new Set([
  'auth', 'authorization', 'cookie', 'password', 'passwd', 'secret', 'token',
  'apikey', 'accesskey', 'privatekey',
]);

function redactSensitiveJson(value: unknown): { value: unknown; redacted: boolean } {
  const seen = new WeakSet<object>();
  let redacted = false;
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 32) return '[depth capped]';
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError('circular JSON');
      seen.add(current);
      return current.map(item => visit(item, depth + 1));
    }
    if (!isRecord(current)) return current;
    if (seen.has(current)) throw new TypeError('circular JSON');
    seen.add(current);
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (compact === 'env' || compact === 'environment') {
        redacted = true;
        output[key] = isRecord(nested)
          ? Object.fromEntries(Object.keys(nested).map(name => [name, '<redacted>']))
          : '<redacted>';
      } else if (SENSITIVE_JSON_KEYS.has(compact)
          || [...SENSITIVE_JSON_KEYS].some(sensitive => compact.endsWith(sensitive))) {
        redacted = true;
        output[key] = '<redacted>';
      } else output[key] = visit(nested, depth + 1);
    }
    return output;
  };
  return { value: visit(value, 0), redacted };
}

function boundedJson(value: unknown): BoundedJson {
  let serialized: string;
  let safe: unknown;
  let redacted = false;
  try {
    const result = redactSensitiveJson(value);
    safe = result.value;
    redacted = result.redacted;
    serialized = JSON.stringify(safe) ?? 'null';
  }
  catch {
    // Circular or otherwise unserializable: keep the fact, drop the value.
    return { bytes: 0, truncated: true };
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_RAW_JSON_BYTES)
    return { json: safe, bytes, ...(redacted ? { redacted: true as const } : {}) };
  return {
    bytes, truncated: true, digest: digest24(serialized),
    ...(redacted ? { redacted: true as const } : {}),
  };
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
        return normalizedDiff(item, redact);
      case 'terminal':
        return { type: 'terminal', terminalId: asString(item.terminalId) ?? '' };
      case 'content':
      default:
        return { type: 'content', content: normalizeContentBlock(item.content, redact) };
    }
  });
}

function toolUpsert(
  update: Record<string, unknown>, snapshot: boolean, options: NormalizeOptions,
): ToolUpsertPayload {
  const redact = options.redactText;
  const payload: ToolUpsertPayload = {
    toolCallId: options.redactToolCallId ?? asString(update.toolCallId) ?? '',
    snapshot,
  };
  if (asString(update.title) !== undefined) payload.title = redact ?? asString(update.title);
  if (asString(update.kind) !== undefined) payload.kind = asString(update.kind);
  if (asString(update.status) !== undefined) payload.status = asString(update.status);
  const content = normalizeToolContent(update.content, redact);
  if (content) payload.content = content;
  if (Array.isArray(update.locations)) {
    payload.locations = update.locations.filter(isRecord).map(location => ({
      ...boundedPath(location.path),
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
    sessionUpdate: truncateUtf8(kind ?? 'unknown', 256),
    bytes: Buffer.byteLength(serialized),
    preview: serialized.slice(0, MAX_UNSUPPORTED_PREVIEW_CHARS),
    ...(Buffer.byteLength(serialized) > Buffer.byteLength(serialized.slice(0, MAX_UNSUPPORTED_PREVIEW_CHARS))
      ? { digest: digest24(serialized) } : {}),
  };
}

function capNormalizedUpdate(result: NormalizedUpdate, sessionUpdate: string): NormalizedUpdate {
  let serialized: string;
  try { serialized = JSON.stringify(result); }
  catch {
    return {
      kind: 'unsupported',
      payload: {
        sessionUpdate: truncateUtf8(sessionUpdate, 256),
        bytes: 0,
        preview: '[normalized update was not serializable]',
      },
    };
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_NORMALIZED_UPDATE_BYTES) return result;
  return {
    kind: 'unsupported',
    payload: {
      sessionUpdate: truncateUtf8(sessionUpdate, 256),
      bytes,
      digest: digest24(serialized),
      preview: `[normalized update exceeded ${MAX_NORMALIZED_UPDATE_BYTES}-byte durable-event cap]`,
    },
  };
}

export function normalizeSessionUpdate(
  update: acp.SessionUpdate, options: NormalizeOptions = {},
): NormalizedUpdate {
  const redact = options.redactText;
  const raw: unknown = update;
  if (!isRecord(raw) || typeof raw.sessionUpdate !== 'string')
    return capNormalizedUpdate({ kind: 'unsupported', payload: unsupported(raw) }, 'unknown');
  const sessionUpdate = raw.sessionUpdate;
  const adapterMeta = quarantineMeta(raw._meta);
  const withMeta = (result: Omit<NormalizedUpdate, 'adapterMeta'>): NormalizedUpdate =>
    capNormalizedUpdate(adapterMeta ? { ...result, adapterMeta } : result, sessionUpdate);

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
      const payload = toolUpsert(raw, raw.sessionUpdate === 'tool_call', options);
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
