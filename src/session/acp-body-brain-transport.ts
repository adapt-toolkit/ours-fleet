import { createHash } from 'node:crypto';
import type * as acp from '@agentclientprotocol/sdk';
import {
  BODY_BRAIN_MAX_ID_BYTES,
  BODY_BRAIN_PROTOCOL_VERSION,
  type BodyBrainPromptOrigin,
  type BodyBrainTurnOutcome,
} from './body-brain.js';

export const ACP_BODY_BRAIN_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const ACP_BODY_BRAIN_MAX_UPDATE_BYTES = 320 * 1024;
/** Parity invariant with the landed BodyBrain recovery/conformance capacity. */
export const ACP_BODY_BRAIN_MAX_PERMISSION_OPTIONS = 16;

export interface AcpBodyReference { digest: string; bytes: number }
export interface AcpBodySource { resolve(reference: Readonly<AcpBodyReference>): Promise<Uint8Array> }
export interface AcpSessionMetadata { schemaVersion: 1; token: string; digest: string }
export interface AcpStartRequest { protocolVersion: 1; generation: string; planDigest: string }
export interface AcpRestoreRequest extends AcpStartRequest { sessionMetadata: Readonly<AcpSessionMetadata> }
export type AcpLifecycleFailureCode =
  | 'invalid_request' | 'listener_required' | 'already_started' | 'closed'
  | 'adapter_rejected' | 'adapter_unavailable' | 'incompatible_session';
export type AcpLifecycleResult =
  | { state: 'accepted'; sessionMetadata: Readonly<AcpSessionMetadata> }
  | { state: 'failed'; code: AcpLifecycleFailureCode };
export type AcpCommandFailureCode =
  | 'invalid_request' | 'generation_changed' | 'closed' | 'body_unavailable' | 'body_digest_mismatch'
  | 'body_length_mismatch' | 'body_oversize' | 'adapter_rejected' | 'adapter_unavailable';
export type AcpCommandResult = { state: 'accepted' } | { state: 'failed'; code: AcpCommandFailureCode };

interface NotificationBase {
  protocolVersion: 1;
  generation: string;
  transportSeq: number;
  notificationId: string;
}
/** Explicit protocol-owned discriminated union. Raw SDK object identities never cross this boundary. */
export type AcpBodyBrainSessionUpdate = Readonly<acp.SessionUpdate>;
export type AcpBodyBrainNotification = Readonly<NotificationBase & (
  | { kind: 'started' }
  | { kind: 'session_update'; update: AcpBodyBrainSessionUpdate }
  | { kind: 'completed'; promptId: string; outcome: BodyBrainTurnOutcome; output?: AcpBodyReference }
  | { kind: 'permission_requested'; promptId: string; permissionId: string; optionIds: readonly string[] }
  | { kind: 'exited'; code: 'clean_exit' | 'forced' | 'lost'; promptId?: string }
  | { kind: 'failed'; code: 'protocol_error' | 'adapter_error' | 'session_lost'; promptId?: string }
)>;
export type AcpDeliveryFailureCode =
  | 'invalid_notification' | 'generation_changed' | 'sequence_gap'
  | 'sequence_duplicate' | 'notification_id_conflict' | 'terminal_conflict';
export type AcpBodyBrainDelivery =
  | { state: 'notification'; notification: AcpBodyBrainNotification }
  | { state: 'failed'; code: AcpDeliveryFailureCode };

export interface AcpSubmitRequest {
  generation: string;
  commandId: string;
  promptId: string;
  origin: BodyBrainPromptOrigin;
  body: AcpBodyReference;
}
export interface AcpPermissionRequest { generation: string; commandId: string; permissionId: string; optionId: string }
export interface AcpGenerationRequest { generation: string; commandId: string }

export interface AcpBodyBrainProvider {
  subscribe(listener: (notification: unknown) => void): () => void;
  start(request: Readonly<AcpStartRequest>): Promise<AcpLifecycleResult>;
  restore(request: Readonly<AcpRestoreRequest>): Promise<AcpLifecycleResult>;
  submit(request: Readonly<Omit<AcpSubmitRequest, 'body'>>, body: Uint8Array): Promise<AcpCommandResult>;
  respondPermission(request: Readonly<AcpPermissionRequest>): Promise<AcpCommandResult>;
  cancel(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  forceTerminate(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  close(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  retire(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult>;
  cleanup(): Promise<void>;
}

export interface AcpTransportPresentation {
  protocolVersion: 1;
  adapterId: string;
  state: 'new' | 'launching' | 'active' | 'closed';
  generation?: string;
  lastTransportSeq: number;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && !descriptor.get && !descriptor.set;
  });
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}
function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= BODY_BRAIN_MAX_ID_BYTES;
}
function token(value: unknown): value is string {
  return bounded(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}
function digest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function bodyReference(value: unknown): value is AcpBodyReference {
  return plain(value) && exact(value, ['digest', 'bytes']) && digest(value.digest)
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0 && (value.bytes as number) <= ACP_BODY_BRAIN_MAX_BODY_BYTES;
}
function promptOrigin(value: unknown): value is BodyBrainPromptOrigin {
  if (!plain(value) || !token(value.kind)) return false;
  if (value.kind === 'startup') return exact(value, ['kind']);
  if (value.kind === 'owner' || value.kind === 'local_console' || value.kind === 'monitor')
    return exact(value, ['kind', 'requestId']) && token(value.requestId);
  return value.kind === 'scheduled' && exact(value, ['kind', 'loopId', 'runId'])
    && token(value.loopId) && token(value.runId);
}

const UPDATE_KEYS: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = Object.freeze({
  user_message_chunk: [['sessionUpdate', 'content'], ['messageId', '_meta']],
  agent_message_chunk: [['sessionUpdate', 'content'], ['messageId', '_meta']],
  agent_thought_chunk: [['sessionUpdate', 'content'], ['messageId', '_meta']],
  tool_call: [['sessionUpdate', 'toolCallId', 'title'], ['name', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput', '_meta']],
  tool_call_update: [['sessionUpdate', 'toolCallId'], ['name', 'kind', 'status', 'title', 'content', 'locations', 'rawInput', 'rawOutput', '_meta']],
  plan: [['sessionUpdate', 'entries'], ['_meta']],
  plan_update: [['sessionUpdate', 'plan'], ['_meta']],
  plan_removed: [['sessionUpdate', 'planId'], ['_meta']],
  available_commands_update: [['sessionUpdate', 'availableCommands'], ['_meta']],
  current_mode_update: [['sessionUpdate', 'currentModeId'], ['_meta']],
  config_option_update: [['sessionUpdate', 'configOptions'], ['_meta']],
  session_info_update: [['sessionUpdate'], ['title', 'updatedAt', '_meta']],
  usage_update: [['sessionUpdate', 'used', 'size'], ['cost', '_meta']],
});

function copyUpdateValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new TypeError('update depth exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > ACP_BODY_BRAIN_MAX_UPDATE_BYTES) throw new TypeError('update string oversized');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('invalid update number');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new TypeError('update array oversized');
    return Object.freeze(value.map(item => copyUpdateValue(item, depth + 1)));
  }
  if (!plain(value) || Object.keys(value).length > 4096) throw new TypeError('invalid update value');
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!bounded(key)) throw new TypeError('invalid update key');
    result[key] = copyUpdateValue(nested, depth + 1);
  }
  return Object.freeze(result);
}

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const optionalString = (value: unknown): boolean => value === undefined || nullableString(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const toolKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const toolStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
const validMeta = (value: unknown): boolean => value === undefined || value === null || plain(value);
function validAnnotations(value: unknown): boolean {
  return value === undefined || value === null || (plain(value)
    && exact(value, [], ['audience', 'lastModified', 'priority', '_meta'])
    && (value.audience === undefined || value.audience === null || (Array.isArray(value.audience)
      && value.audience.every(role => role === 'assistant' || role === 'user')))
    && optionalString(value.lastModified) && (value.priority === undefined || value.priority === null || finite(value.priority))
    && validMeta(value._meta));
}
function validResource(value: unknown): boolean {
  if (!plain(value) || typeof value.uri !== 'string' || !optionalString(value.mimeType) || !validMeta(value._meta)) return false;
  return typeof value.text === 'string'
    ? exact(value, ['uri', 'text'], ['mimeType', '_meta'])
    : typeof value.blob === 'string' && exact(value, ['uri', 'blob'], ['mimeType', '_meta']);
}
function validContent(value: unknown): boolean {
  if (!plain(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return exact(value, ['type', 'text'], ['annotations', '_meta']) && typeof value.text === 'string'
    && validAnnotations(value.annotations) && validMeta(value._meta);
  if (value.type === 'image' || value.type === 'audio') return exact(value, ['type', 'data', 'mimeType'],
    value.type === 'image' ? ['uri', 'annotations', '_meta'] : ['annotations', '_meta'])
    && typeof value.data === 'string' && typeof value.mimeType === 'string' && optionalString(value.uri)
    && validAnnotations(value.annotations) && validMeta(value._meta);
  if (value.type === 'resource_link') return exact(value, ['type', 'name', 'uri'],
    ['title', 'description', 'mimeType', 'size', 'annotations', '_meta']) && typeof value.name === 'string'
    && typeof value.uri === 'string' && optionalString(value.title) && optionalString(value.description)
    && optionalString(value.mimeType) && (value.size === undefined || value.size === null || finite(value.size))
    && validAnnotations(value.annotations) && validMeta(value._meta);
  if (value.type === 'resource') return exact(value, ['type', 'resource'], ['annotations', '_meta'])
    && validResource(value.resource) && validAnnotations(value.annotations) && validMeta(value._meta);
  return false;
}
function validToolLocation(value: unknown): boolean {
  return plain(value) && exact(value, ['path'], ['line', '_meta']) && typeof value.path === 'string'
    && (value.line === undefined || value.line === null || (Number.isSafeInteger(value.line) && (value.line as number) >= 0))
    && validMeta(value._meta);
}
function validToolFields(raw: Record<string, unknown>, create: boolean): boolean {
  return typeof raw.toolCallId === 'string' && (!create || typeof raw.title === 'string')
    && (raw.title === undefined || nullableString(raw.title)) && optionalString(raw.name)
    && (raw.kind === undefined || raw.kind === null || toolKinds.has(raw.kind as string))
    && (raw.status === undefined || raw.status === null || toolStatuses.has(raw.status as string))
    && (raw.content === undefined || raw.content === null || (Array.isArray(raw.content) && raw.content.every(item =>
      plain(item) && ((item.type === 'content' && exact(item, ['type', 'content'], ['_meta']) && validContent(item.content) && validMeta(item._meta))
        || (item.type === 'diff' && exact(item, ['type', 'path', 'newText'], ['oldText', '_meta']) && typeof item.path === 'string'
          && typeof item.newText === 'string' && optionalString(item.oldText) && validMeta(item._meta))
        || (item.type === 'terminal' && exact(item, ['type', 'terminalId'], ['_meta'])
          && typeof item.terminalId === 'string' && validMeta(item._meta))))))
    && (raw.locations === undefined || raw.locations === null
      || (Array.isArray(raw.locations) && raw.locations.every(validToolLocation)));
}
function validPlanEntry(item: unknown): boolean {
  return plain(item) && exact(item, ['content', 'priority', 'status'], ['_meta']) && typeof item.content === 'string'
    && ['high', 'medium', 'low'].includes(item.priority as string)
    && ['pending', 'in_progress', 'completed'].includes(item.status as string) && validMeta(item._meta);
}
function validPlanUpdate(value: unknown): boolean {
  if (!plain(value) || typeof value.type !== 'string' || typeof value.planId !== 'string' || !validMeta(value._meta)) return false;
  if (value.type === 'items') return exact(value, ['type', 'planId', 'entries'], ['_meta'])
    && Array.isArray(value.entries) && value.entries.every(validPlanEntry);
  if (value.type === 'file') return exact(value, ['type', 'planId', 'uri'], ['_meta']) && typeof value.uri === 'string';
  return value.type === 'markdown' && exact(value, ['type', 'planId', 'content'], ['_meta']) && typeof value.content === 'string';
}
function validSelectOption(value: unknown): boolean {
  return plain(value) && exact(value, ['value', 'name'], ['description', '_meta']) && typeof value.value === 'string'
    && typeof value.name === 'string' && optionalString(value.description) && validMeta(value._meta);
}
function validConfigOption(value: unknown): boolean {
  if (!plain(value) || typeof value.type !== 'string' || typeof value.id !== 'string' || typeof value.name !== 'string'
      || !optionalString(value.description) || (value.category !== undefined && value.category !== null
        && typeof value.category !== 'string') || !validMeta(value._meta)) return false;
  if (value.type === 'boolean') return exact(value, ['type', 'id', 'name', 'currentValue'],
    ['description', 'category', '_meta']) && typeof value.currentValue === 'boolean';
  if (value.type !== 'select' || !exact(value, ['type', 'id', 'name', 'currentValue', 'options'],
    ['description', 'category', '_meta']) || typeof value.currentValue !== 'string' || !Array.isArray(value.options)) return false;
  const options = value.options;
  const flat = options.every(validSelectOption);
  const grouped = options.every(group => plain(group) && exact(group, ['group', 'name', 'options'], ['_meta'])
    && typeof group.group === 'string' && typeof group.name === 'string' && validMeta(group._meta)
    && Array.isArray(group.options) && group.options.every(validSelectOption));
  return flat || grouped;
}
function validUpdateFields(raw: Record<string, unknown>): boolean {
  if (!validMeta(raw._meta)) return false;
  switch (raw.sessionUpdate) {
    case 'user_message_chunk': case 'agent_message_chunk': case 'agent_thought_chunk':
      return validContent(raw.content) && optionalString(raw.messageId);
    case 'tool_call': return validToolFields(raw, true);
    case 'tool_call_update': return validToolFields(raw, false);
    case 'plan': return Array.isArray(raw.entries) && raw.entries.every(validPlanEntry);
    case 'plan_update': return validPlanUpdate(raw.plan);
    case 'plan_removed': return typeof raw.planId === 'string';
    case 'available_commands_update': return Array.isArray(raw.availableCommands) && raw.availableCommands.every(item =>
      plain(item) && exact(item, ['name', 'description'], ['input', '_meta']) && typeof item.name === 'string'
      && typeof item.description === 'string' && (item.input === undefined || item.input === null
        || (plain(item.input) && exact(item.input, ['hint'], ['_meta']) && typeof item.input.hint === 'string')));
    case 'current_mode_update': return typeof raw.currentModeId === 'string';
    case 'config_option_update': return Array.isArray(raw.configOptions) && raw.configOptions.every(validConfigOption);
    case 'session_info_update': return optionalString(raw.title) && optionalString(raw.updatedAt);
    case 'usage_update': return finite(raw.used) && finite(raw.size) && (raw.cost === undefined || raw.cost === null
      || (plain(raw.cost) && exact(raw.cost, ['amount', 'currency'], ['_meta'])
        && finite(raw.cost.amount) && typeof raw.cost.currency === 'string'));
    default: return false;
  }
}

export function sanitizeAcpBodyBrainSessionUpdate(raw: unknown): AcpBodyBrainSessionUpdate | undefined {
  if (!plain(raw) || typeof raw.sessionUpdate !== 'string') return undefined;
  const shape = UPDATE_KEYS[raw.sessionUpdate];
  if (!shape || !exact(raw, shape[0], shape[1]) || !validUpdateFields(raw)) return undefined;
  try {
    const owned = copyUpdateValue(raw) as AcpBodyBrainSessionUpdate;
    if (Buffer.byteLength(canonical(owned)) > ACP_BODY_BRAIN_MAX_UPDATE_BYTES) return undefined;
    return owned;
  } catch { return undefined; }
}

const outcomes = new Set<BodyBrainTurnOutcome>(['completed', 'refused', 'cancelled', 'failed', 'inconclusive']);
function parseNotification(raw: unknown): AcpBodyBrainNotification | undefined {
  if (!plain(raw) || raw.protocolVersion !== BODY_BRAIN_PROTOCOL_VERSION || !token(raw.generation)
    || !Number.isSafeInteger(raw.transportSeq) || (raw.transportSeq as number) < 1 || !token(raw.notificationId)
    || !token(raw.kind)) return undefined;
  const base = ['protocolVersion', 'generation', 'transportSeq', 'notificationId', 'kind'];
  switch (raw.kind) {
    case 'started':
      return exact(raw, base) ? { ...raw } as unknown as AcpBodyBrainNotification : undefined;
    case 'session_update': {
      if (!exact(raw, [...base, 'update'])) return undefined;
      const update = sanitizeAcpBodyBrainSessionUpdate(raw.update);
      return update ? { ...raw, update } as unknown as AcpBodyBrainNotification : undefined;
    }
    case 'completed':
      return exact(raw, [...base, 'promptId', 'outcome'], ['output']) && token(raw.promptId)
        && outcomes.has(raw.outcome as BodyBrainTurnOutcome) && (raw.output === undefined || bodyReference(raw.output))
        ? { ...raw, ...(raw.output === undefined ? {} : { output: { ...raw.output as AcpBodyReference } }) } as unknown as AcpBodyBrainNotification : undefined;
    case 'permission_requested': {
      if (!exact(raw, [...base, 'promptId', 'permissionId', 'optionIds']) || !token(raw.promptId)
        || !token(raw.permissionId) || !Array.isArray(raw.optionIds) || raw.optionIds.length < 1
        || raw.optionIds.length > ACP_BODY_BRAIN_MAX_PERMISSION_OPTIONS || !raw.optionIds.every(token)) return undefined;
      if (new Set(raw.optionIds).size !== raw.optionIds.length) return undefined;
      return { ...raw, optionIds: [...raw.optionIds] } as unknown as AcpBodyBrainNotification;
    }
    case 'exited':
      return exact(raw, [...base, 'code'], ['promptId'])
        && (raw.code === 'clean_exit' || raw.code === 'forced' || raw.code === 'lost')
        && (raw.promptId === undefined || token(raw.promptId)) ? { ...raw } as unknown as AcpBodyBrainNotification : undefined;
    case 'failed':
      return exact(raw, [...base, 'code'], ['promptId'])
        && (raw.code === 'protocol_error' || raw.code === 'adapter_error' || raw.code === 'session_lost')
        && (raw.promptId === undefined || token(raw.promptId)) ? { ...raw } as unknown as AcpBodyBrainNotification : undefined;
    default: return undefined;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function freezeNotification(value: AcpBodyBrainNotification): AcpBodyBrainNotification {
  if (value.kind === 'permission_requested') Object.freeze(value.optionIds);
  if (value.kind === 'completed' && value.output) Object.freeze(value.output);
  return Object.freeze(value);
}

function validGenerationRequest(value: AcpGenerationRequest): boolean {
  return plain(value) && exact(value, ['generation', 'commandId']) && token(value.generation) && token(value.commandId);
}

function lifecycleResult(value: unknown): AcpLifecycleResult {
  if (!plain(value) || !token(value.state)) return Object.freeze({ state: 'failed', code: 'adapter_unavailable' });
  if (value.state === 'accepted' && exact(value, ['state', 'sessionMetadata']) && plain(value.sessionMetadata)
    && exact(value.sessionMetadata, ['schemaVersion', 'token', 'digest']) && value.sessionMetadata.schemaVersion === 1
    && bounded(value.sessionMetadata.token) && digest(value.sessionMetadata.digest)) return Object.freeze({
      state: 'accepted',
      sessionMetadata: Object.freeze({ ...value.sessionMetadata }) as unknown as AcpSessionMetadata,
    });
  const codes = new Set<AcpLifecycleFailureCode>([
    'invalid_request', 'listener_required', 'already_started', 'closed',
    'adapter_rejected', 'adapter_unavailable', 'incompatible_session',
  ]);
  return value.state === 'failed' && exact(value, ['state', 'code']) && codes.has(value.code as AcpLifecycleFailureCode)
    ? Object.freeze({ state: 'failed', code: value.code as AcpLifecycleFailureCode })
    : Object.freeze({ state: 'failed', code: 'adapter_unavailable' });
}

function commandResult(value: unknown): AcpCommandResult {
  if (!plain(value)) return Object.freeze({ state: 'failed', code: 'adapter_unavailable' });
  if (value.state === 'accepted' && exact(value, ['state'])) return Object.freeze({ state: 'accepted' });
  const codes = new Set<AcpCommandFailureCode>([
    'invalid_request', 'generation_changed', 'closed', 'body_unavailable', 'body_digest_mismatch',
    'body_length_mismatch', 'body_oversize', 'adapter_rejected', 'adapter_unavailable',
  ]);
  return value.state === 'failed' && exact(value, ['state', 'code']) && codes.has(value.code as AcpCommandFailureCode)
    ? Object.freeze({ state: 'failed', code: value.code as AcpCommandFailureCode })
    : Object.freeze({ state: 'failed', code: 'adapter_unavailable' });
}

export class AcpBodyBrainTransportBoundary {
  private listener?: (delivery: AcpBodyBrainDelivery) => void;
  private providerUnsubscribe?: () => void;
  private subscriptionEpoch = 0;
  private activeSubscriptionEpoch?: number;
  private state: 'new' | 'launching' | 'active' | 'closed' = 'new';
  private generation?: string;
  private lastTransportSeq = 0;
  private readonly notificationIds = new Map<string, string>();
  private terminalNotificationId?: string;
  private cleanupPromise?: Promise<void>;
  private providerLaunchSettlement?: Promise<void>;

  private isClosed(): boolean { return this.state === 'closed'; }

  constructor(
    private readonly adapterId: string,
    private readonly provider: AcpBodyBrainProvider,
    private readonly bodies: AcpBodySource,
  ) { if (!token(adapterId)) throw new TypeError('invalid adapter id'); }

  subscribe(listener: (delivery: AcpBodyBrainDelivery) => void): (() => void) | undefined {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (this.state === 'closed' || this.listener) return undefined;
    this.listener = listener;
    try {
      this.providerUnsubscribe = this.provider.subscribe(raw => this.deliver(raw));
      this.activeSubscriptionEpoch = ++this.subscriptionEpoch;
    }
    catch (error) { this.listener = undefined; this.providerUnsubscribe = undefined; throw error; }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listener = undefined;
      this.activeSubscriptionEpoch = undefined;
      this.subscriptionEpoch++;
      const unsubscribe = this.providerUnsubscribe;
      this.providerUnsubscribe = undefined;
      try { unsubscribe?.(); } catch { /* local delivery is already disabled */ }
    };
  }

  private deliver(raw: unknown): void {
    const listener = this.listener;
    if (!listener || this.state === 'closed') return;
    const notification = parseNotification(raw);
    let code: AcpDeliveryFailureCode | undefined;
    if (!notification) code = 'invalid_notification';
    else if (notification.generation !== this.generation) code = 'generation_changed';
    else if (notification.transportSeq <= this.lastTransportSeq) code = 'sequence_duplicate';
    else if (notification.transportSeq !== this.lastTransportSeq + 1) code = 'sequence_gap';
    else if (this.terminalNotificationId !== undefined) code = 'terminal_conflict';
    else {
      const identity = canonical(notification);
      const prior = this.notificationIds.get(notification.notificationId);
      if (prior !== undefined && prior !== identity) code = 'notification_id_conflict';
      else {
        this.notificationIds.set(notification.notificationId, identity);
        this.lastTransportSeq = notification.transportSeq;
        if (notification.kind === 'exited' || notification.kind === 'failed')
          this.terminalNotificationId = notification.notificationId;
        listener({ state: 'notification', notification: freezeNotification(notification) });
        return;
      }
    }
    listener({ state: 'failed', code });
  }

  async start(request: Readonly<AcpStartRequest>): Promise<AcpLifecycleResult> {
    if (!plain(request) || !exact(request, ['protocolVersion', 'generation', 'planDigest']))
      return { state: 'failed', code: 'invalid_request' };
    const owned = Object.freeze({ protocolVersion: 1 as const, generation: request.generation, planDigest: request.planDigest });
    return this.launch(owned, () => this.provider.start(owned));
  }
  async restore(request: Readonly<AcpRestoreRequest>): Promise<AcpLifecycleResult> {
    if (!plain(request) || !exact(request, ['protocolVersion', 'generation', 'planDigest', 'sessionMetadata'])
      || !plain(request.sessionMetadata) || !exact(request.sessionMetadata, ['schemaVersion', 'token', 'digest'])
      || request.sessionMetadata.schemaVersion !== 1 || !bounded(request.sessionMetadata.token) || !digest(request.sessionMetadata.digest))
      return { state: 'failed', code: 'invalid_request' };
    const owned = Object.freeze({ protocolVersion: 1 as const, generation: request.generation, planDigest: request.planDigest,
      sessionMetadata: Object.freeze({ ...request.sessionMetadata }) });
    return this.launch(owned, () => this.provider.restore(owned));
  }
  private async launch(request: Readonly<AcpStartRequest>, operation: () => Promise<AcpLifecycleResult>): Promise<AcpLifecycleResult> {
    if (this.state === 'closed') return { state: 'failed', code: 'closed' };
    if (this.state !== 'new') return { state: 'failed', code: 'already_started' };
    if (!this.listener) return { state: 'failed', code: 'listener_required' };
    if (!plain(request) || request.protocolVersion !== 1 || !token(request.generation) || !digest(request.planDigest))
      return { state: 'failed', code: 'invalid_request' };
    const launchSubscriptionEpoch = this.activeSubscriptionEpoch;
    this.state = 'launching';
    this.generation = request.generation;
    let providerPromise: Promise<AcpLifecycleResult>;
    try {
      providerPromise = operation();
      this.providerLaunchSettlement = providerPromise.then(() => {}, () => {});
      const result = lifecycleResult(await providerPromise);
      if (this.isClosed()) { await this.cleanup(); return Object.freeze({ state: 'failed', code: 'closed' }); }
      if (this.activeSubscriptionEpoch !== launchSubscriptionEpoch) {
        await this.cleanup(); return Object.freeze({ state: 'failed', code: 'listener_required' });
      }
      if (result.state === 'accepted') this.state = 'active';
      else await this.cleanup();
      return result;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async submit(request: Readonly<AcpSubmitRequest>): Promise<AcpCommandResult> {
    if (this.state === 'closed') return { state: 'failed', code: 'closed' };
    if (this.state !== 'active' || !plain(request) || !exact(request, ['generation', 'commandId', 'promptId', 'origin', 'body'])
      || !token(request.generation) || !token(request.commandId) || !token(request.promptId)
      || !promptOrigin(request.origin) || !bodyReference(request.body)) return { state: 'failed', code: 'invalid_request' };
    if (request.generation !== this.generation) return { state: 'failed', code: 'generation_changed' };
    const requestSnapshot = Object.freeze({
      generation: request.generation, commandId: request.commandId, promptId: request.promptId,
      origin: Object.freeze({ ...request.origin }) as BodyBrainPromptOrigin,
      body: Object.freeze({ ...request.body }),
    });
    let resolved: Uint8Array;
    try { resolved = await this.bodies.resolve(requestSnapshot.body); }
    catch { return { state: 'failed', code: 'body_unavailable' }; }
    if (!(resolved instanceof Uint8Array) || !(resolved.buffer instanceof ArrayBuffer))
      return { state: 'failed', code: 'body_unavailable' };
    try { if (resolved.byteLength > ACP_BODY_BRAIN_MAX_BODY_BYTES) return { state: 'failed', code: 'body_oversize' }; }
    catch { return { state: 'failed', code: 'body_unavailable' }; }
    let owned: Uint8Array;
    try { owned = Uint8Array.from(resolved); }
    catch { return { state: 'failed', code: 'body_unavailable' }; }
    try {
      if (owned.byteLength !== requestSnapshot.body.bytes) return { state: 'failed', code: 'body_length_mismatch' };
      if (`sha256:${createHash('sha256').update(owned).digest('hex')}` !== requestSnapshot.body.digest)
        return { state: 'failed', code: 'body_digest_mismatch' };
      const { body: _body, ...metadata } = requestSnapshot;
      return commandResult(await this.provider.submit(Object.freeze(metadata), owned));
    } finally { owned.fill(0); }
  }

  respondPermission(request: Readonly<AcpPermissionRequest>): Promise<AcpCommandResult> {
    if (this.state === 'closed') return Promise.resolve({ state: 'failed', code: 'closed' });
    if (this.state !== 'active' || !plain(request) || !exact(request, ['generation', 'commandId', 'permissionId', 'optionId'])
      || !token(request.generation) || !token(request.commandId) || !token(request.permissionId) || !token(request.optionId))
      return Promise.resolve({ state: 'failed', code: 'invalid_request' });
    if (request.generation !== this.generation) return Promise.resolve({ state: 'failed', code: 'generation_changed' });
    const owned = Object.freeze({ ...request });
    return this.provider.respondPermission(owned).then(commandResult);
  }
  cancel(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.mutate(request, value => this.provider.cancel(value)); }
  forceTerminate(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.mutate(request, value => this.provider.forceTerminate(value)); }
  close(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.mutate(request, value => this.provider.close(value)); }
  retire(request: Readonly<AcpGenerationRequest>): Promise<AcpCommandResult> { return this.mutate(request, value => this.provider.retire(value)); }
  private mutate(request: Readonly<AcpGenerationRequest>, operation: (request: Readonly<AcpGenerationRequest>) => Promise<AcpCommandResult>): Promise<AcpCommandResult> {
    if (this.state === 'closed') return Promise.resolve({ state: 'failed', code: 'closed' });
    if (this.state !== 'active' || !validGenerationRequest(request)) return Promise.resolve({ state: 'failed', code: 'invalid_request' });
    if (request.generation !== this.generation) return Promise.resolve({ state: 'failed', code: 'generation_changed' });
    return operation(Object.freeze({ ...request })).then(commandResult);
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.state = 'closed';
    this.listener = undefined;
    this.activeSubscriptionEpoch = undefined;
    this.subscriptionEpoch++;
    const unsubscribe = this.providerUnsubscribe;
    this.providerUnsubscribe = undefined;
    this.cleanupPromise = (async () => {
      await this.providerLaunchSettlement;
      try { unsubscribe?.(); } catch { /* provider cleanup still owns the resource */ }
      await this.provider.cleanup();
    })();
    return this.cleanupPromise;
  }

  presentation(): Readonly<AcpTransportPresentation> {
    return Object.freeze({
      protocolVersion: BODY_BRAIN_PROTOCOL_VERSION,
      adapterId: this.adapterId,
      state: this.state,
      ...(this.generation === undefined ? {} : { generation: this.generation }),
      lastTransportSeq: this.lastTransportSeq,
    });
  }
}
