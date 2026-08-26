import { createHash } from 'node:crypto';
import {
  BODY_BRAIN_MAX_ACTIVE_IDS, BODY_BRAIN_MAX_ADMISSIONS, BODY_BRAIN_MAX_EVENTS_PAGE,
  BODY_BRAIN_MAX_COMMANDS, BODY_BRAIN_MAX_EVENTS, BODY_BRAIN_MAX_ID_BYTES, BODY_BRAIN_PROTOCOL_VERSION,
  BodyBrainContractError,
  type BodyBrainAdmissionReceipt, type BodyBrainAdmissionResult, type BodyBrainCompletion,
  type BodyBrainCompletionResult, type BodyBrainDeterminism, type BodyBrainEvent,
  type BodyBrainGenerationRequest, type BodyBrainMutationResult, type BodyBrainPageRequest,
  type BodyBrainPageResult, type BodyBrainPermissionResponse, type BodyBrainPermissionResult,
  type BodyBrainPromptRequest, type BodyBrainRecoveryAdmission, type BodyBrainRecoveryPermission,
  type BodyBrainRecoveryRecord, type BodyBrainRestoreResult, type BodyBrainSession,
  type BodyBrainRecoveryMutation, type BodyBrainRecoveryPermissionCommand,
  type BodyBrainSessionRestorer, type BodyBrainSnapshot, type BodyBrainState,
  type BodyBrainTurnOutcome,
} from './body-brain.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_REASON_BYTES = 256;
const cursor = (seq: number): string => `bb:${seq}`;

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new BodyBrainContractError('value is not canonical JSON');
  return `{${Object.keys(value).sort().map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new BodyBrainContractError('undefined is not canonical JSON');
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}
const hash = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function dataOnly(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key)))) return false;
  } else if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set
        || !dataOnly(descriptor.value, seen)) return false;
  }
  return true;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  const names = keys.map(key => key.endsWith('?') ? key.slice(0, -1) : key);
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => names.includes(key))
    && keys.filter(key => !key.endsWith('?')).every(key => Object.hasOwn(value as object, key));
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  const names = keys.map(key => key.endsWith('?') ? key.slice(0, -1) : key);
  return Object.keys(value).every(key => names.includes(key))
    && keys.filter(key => !key.endsWith('?')).every(key => Object.hasOwn(value, key));
}
function token(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
    && Buffer.byteLength(value) <= BODY_BRAIN_MAX_ID_BYTES;
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function parseCursor(value: string | undefined, max: number): number | undefined {
  if (value === undefined) return 0;
  const match = /^bb:(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) return undefined;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq <= max ? seq : undefined;
}
function validOrigin(origin: BodyBrainPromptRequest['origin']): boolean {
  if (!origin || typeof origin !== 'object') return false;
  if (origin.kind === 'startup') return Object.keys(origin).length === 1;
  if (origin.kind === 'scheduled')
    return Object.keys(origin).length === 3 && token(origin.loopId) && token(origin.runId);
  return ['owner', 'local_console', 'monitor'].includes(origin.kind)
    && Object.keys(origin).length === 2 && token(origin.requestId);
}
function validPrompt(request: BodyBrainPromptRequest): boolean {
  return dataOnly(request) && exact(request, ['generation', 'commandId', 'body', 'origin'])
    && token(request.generation) && token(request.commandId)
    && exact(request.body, ['digest', 'bytes']) && DIGEST.test(request.body.digest)
    && Number.isSafeInteger(request.body.bytes) && request.body.bytes >= 0
    && request.body.bytes <= MAX_BODY_BYTES && validOrigin(request.origin);
}

interface AdmissionEntry extends BodyBrainRecoveryAdmission {}
interface PermissionEntry extends BodyBrainRecoveryPermission {}
type EventFields = Pick<BodyBrainEvent, 'kind'> & Partial<Omit<BodyBrainEvent, 'kind'>>;

export class FakeBodyBrainSession implements BodyBrainSession {
  readonly sessionRef: string;
  readonly generation: string;
  readonly #events: BodyBrainEvent[] = [];
  readonly #listeners = new Set<(event: BodyBrainEvent) => void>();
  readonly #ids = new Set<string>();
  readonly #admissions = new Map<string, AdmissionEntry>();
  readonly #prompts = new Map<string, AdmissionEntry>();
  readonly #permissions = new Map<string, PermissionEntry>();
  readonly #permissionCommands = new Map<string, { hash: string; result: BodyBrainPermissionResult }>();
  readonly #permissionCommandRecords = new Map<string, BodyBrainRecoveryPermissionCommand>();
  readonly #mutationCommands = new Map<string, { hash: string; result: BodyBrainMutationResult }>();
  readonly #mutationRecords = new Map<string, BodyBrainRecoveryMutation>();
  readonly #queue: string[] = [];
  #seq: number;
  #lastAt?: string;
  #state: BodyBrainState;
  #activePromptId?: string;
  #retired: boolean;

  constructor(
    readonly adapterId: string, sessionRef: string, generation: string,
    readonly determinism: BodyBrainDeterminism,
    restored?: Readonly<BodyBrainRecoveryRecord>,
  ) {
    if (!token(adapterId) || !token(sessionRef) || !token(generation)
        || !determinism || typeof determinism.now !== 'function' || typeof determinism.nextId !== 'function')
      throw new BodyBrainContractError('invalid fake Body–Brain construction');
    this.sessionRef = sessionRef;
    this.generation = generation;
    this.#seq = restored?.committedSeq ?? 0;
    this.#lastAt = restored?.committedAt;
    this.#state = restored?.state ?? 'idle';
    this.#activePromptId = restored?.activePromptId;
    this.#retired = restored?.retired ?? false;
    for (const event of restored?.events ?? []) {
      const copy = deepFreeze(clone(event)); this.#events.push(copy); this.#ids.add(copy.eventId);
    }
    for (const command of restored?.permissionCommands ?? []) {
      const copy = deepFreeze(clone(command)); this.#permissionCommandRecords.set(copy.commandId, copy);
      this.#permissionCommands.set(copy.commandId, { hash: copy.requestHash, result: copy.result });
    }
    for (const entry of restored?.admissions ?? []) {
      const copy = clone(entry);
      this.#admissions.set(copy.request.commandId, copy);
      this.#prompts.set(copy.receipt.promptId, copy);
      this.#ids.add(copy.receipt.promptId);
    }
    for (const permission of restored?.permissions ?? []) {
      const copy = clone(permission);
      this.#permissions.set(copy.permissionId, copy);
      this.#ids.add(copy.permissionId);
      if (copy.responseCommandId && copy.responseHash) this.#permissionCommands.set(copy.responseCommandId, {
        hash: copy.responseHash, result: { state: 'accepted', optionId: copy.settledOptionId },
      });
    }
    this.#queue.push(...(restored?.promptQueue ?? []));
    for (const mutation of restored?.mutations ?? []) {
      const copy = clone(mutation); this.#mutationRecords.set(copy.commandId, copy);
      this.#mutationCommands.set(copy.commandId, { hash: copy.requestHash, result: copy.result });
    }
  }

  snapshot(): Readonly<BodyBrainSnapshot> {
    return deepFreeze({
      protocolVersion: BODY_BRAIN_PROTOCOL_VERSION, sessionRef: this.sessionRef,
      generation: this.generation, state: this.#state, cursor: cursor(this.#seq),
      ...(this.#activePromptId ? { activePromptId: this.#activePromptId } : {}),
      activePermissionIds: [...this.#permissions.values()]
        .filter(value => !value.settledOptionId && !value.cancelled).map(value => value.permissionId).sort(),
    });
  }

  page(request: BodyBrainPageRequest = {}): BodyBrainPageResult {
    if (!dataOnly(request) || !request || typeof request !== 'object'
        || Object.keys(request).some(key => !['after', 'limit'].includes(key)))
      return { state: 'invalid_cursor', generation: this.generation };
    const after = parseCursor(request.after, this.#seq);
    const limit = request.limit ?? BODY_BRAIN_MAX_EVENTS_PAGE;
    if (after === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > BODY_BRAIN_MAX_EVENTS_PAGE)
      return { state: 'invalid_cursor', generation: this.generation };
    const remaining = this.#events.filter(event => event.seq > after);
    const events = remaining.slice(0, limit);
    return deepFreeze({
      state: 'ok' as const, generation: this.generation, events: [...events],
      nextCursor: cursor(events.at(-1)?.seq ?? after), hasMore: remaining.length > events.length,
    });
  }

  subscribe(listener: (event: BodyBrainEvent) => void): () => void {
    if (typeof listener !== 'function') throw new BodyBrainContractError('listener must be a function');
    this.#listeners.add(listener);
    let active = true;
    return () => { if (active) this.#listeners.delete(listener); active = false; };
  }

  admitPrompt(raw: BodyBrainPromptRequest): BodyBrainAdmissionResult {
    if (!validPrompt(raw)) return { state: 'invalid_request' };
    const request = clone(raw);
    const requestHash = hash(request);
    const previous = this.#admissions.get(request.commandId);
    if (previous) return previous.requestHash === requestHash
      ? { state: 'accepted', receipt: deepFreeze(clone(previous.receipt)) }
      : { state: 'idempotency_conflict' };
    const fenced = this.#fence(request.generation);
    if (fenced) return { state: fenced };
    if (this.#admissions.size >= BODY_BRAIN_MAX_ADMISSIONS) return { state: 'invalid_request' };
    if (this.#events.length >= BODY_BRAIN_MAX_EVENTS) return { state: 'invalid_request' };
    const promptId = this.#nextId('prompt');
    const queuedBehind = this.#activePromptId ? this.#queue.length + 1 : 0;
    const event = this.#emit('prompt_admitted', { promptId, commandId: request.commandId,
      payload: { bodyDigest: request.body.digest, bodyBytes: request.body.bytes, queuedBehind } });
    const receipt: BodyBrainAdmissionReceipt = deepFreeze({
      commandId: request.commandId, promptId, state: queuedBehind ? 'queued' : 'started',
      queuedBehind, acceptedAt: event.at, cursor: cursor(event.seq),
    });
    const entry = { requestHash, request, receipt };
    this.#admissions.set(request.commandId, entry);
    this.#prompts.set(promptId, entry);
    if (!this.#activePromptId) this.#activePromptId = promptId;
    else this.#queue.push(promptId);
    this.#state = 'running';
    return { state: 'accepted', receipt };
  }

  awaitCompletion(generation: string, promptId: string): BodyBrainCompletionResult | { state: 'stale_generation' } {
    if (!token(generation) || !token(promptId)) return { state: 'invalid_request' };
    if (generation !== this.generation) return { state: 'stale_generation' };
    const entry = this.#prompts.get(promptId);
    if (!entry) return { state: 'unknown_prompt' };
    return entry.completion
      ? { state: 'terminal', completion: deepFreeze(clone(entry.completion)) }
      : { state: 'not_terminal' };
  }

  respondPermission(raw: BodyBrainPermissionResponse): BodyBrainPermissionResult {
    if (!dataOnly(raw) || !exact(raw, ['generation', 'commandId', 'permissionId', 'optionId'])
        || !token(raw.generation) || !token(raw.commandId) || !token(raw.permissionId) || !token(raw.optionId))
      return { state: 'invalid_request' };
    const request = clone(raw); const requestHash = hash(request);
    const prior = this.#permissionCommands.get(request.commandId);
    if (prior) return prior.hash === requestHash ? prior.result : { state: 'idempotency_conflict' };
    if (request.generation !== this.generation) return { state: 'stale_generation' };
    if (this.#permissionCommandRecords.size >= BODY_BRAIN_MAX_COMMANDS) return { state: 'invalid_request' };
    if (this.#retired) return this.#rememberPermission(request, requestHash, { state: 'retired' });
    if (this.#state === 'terminated') return this.#rememberPermission(request, requestHash, { state: 'terminated' });
    if (this.#state === 'closed') return this.#rememberPermission(request, requestHash, { state: 'closed' });
    const permission = this.#permissions.get(request.permissionId);
    if (!permission) return this.#rememberPermission(request, requestHash, { state: 'unknown_permission' });
    if (permission.settledOptionId || permission.cancelled)
      return this.#rememberPermission(request, requestHash, { state: 'already_settled',
        ...(permission.settledOptionId ? { optionId: permission.settledOptionId } : {}) });
    if (!permission.optionIds.includes(request.optionId))
      return this.#rememberPermission(request, requestHash, { state: 'invalid_option' });
    if (this.#events.length >= BODY_BRAIN_MAX_EVENTS) return { state: 'invalid_request' };
    const prepared = this.#prepareEvents([{ kind: 'permission_resolved', permissionId: request.permissionId,
      promptId: permission.promptId, commandId: request.commandId, payload: { optionId: request.optionId } }]);
    permission.settledOptionId = request.optionId;
    permission.responseCommandId = request.commandId;
    permission.responseHash = requestHash;
    const result = this.#rememberPermission(request, requestHash,
      { state: 'accepted', optionId: request.optionId }, prepared[0]!.seq);
    this.#commitEvents(prepared);
    this.#state = this.#activePromptId ? 'running' : 'idle';
    return result;
  }

  requestCancel(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.#mutation('cancel', request, 'cancel_requested', false);
  }
  forceTerminate(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.#mutation('force', request, 'force_terminated', true);
  }
  close(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.#mutation('close', request, 'closed', true);
  }
  retire(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.#mutation('retire', request, 'retired', true);
  }

  /** Deterministic adapter script: request one permission without exposing a provider payload. */
  scriptPermission(generation: string, promptId: string, optionIds: readonly string[]): string | undefined {
    if (generation !== this.generation || this.#activePromptId !== promptId || !dataOnly(optionIds)
        || !Array.isArray(optionIds)
        || !optionIds.length || optionIds.length > 16 || new Set(optionIds).size !== optionIds.length
        || optionIds.some(value => !token(value)) || this.#permissions.size >= BODY_BRAIN_MAX_ACTIVE_IDS
        || this.#events.length >= BODY_BRAIN_MAX_EVENTS) return undefined;
    const permissionId = this.#nextId('permission');
    const prepared = this.#prepareEvents([{ kind: 'permission_requested', promptId, permissionId,
      payload: { optionCount: optionIds.length } }]);
    this.#permissions.set(permissionId, { permissionId, promptId, optionIds: [...optionIds] });
    this.#state = 'awaiting_permission';
    this.#commitEvents(prepared);
    return permissionId;
  }

  /** Deterministic adapter script: settle one admitted prompt. */
  scriptCompletion(
    generation: string, promptId: string, outcome: BodyBrainTurnOutcome,
    output?: { digest: string; bytes: number }, reasonCode?: string,
  ): BodyBrainCompletionResult | { state: 'stale_generation' } {
    if (generation !== this.generation) return { state: 'stale_generation' };
    const entry = this.#prompts.get(promptId);
    if (!entry) return { state: 'unknown_prompt' };
    if (entry.completion) return { state: 'terminal', completion: entry.completion };
    if (this.#activePromptId !== promptId
        || [...this.#permissions.values()].some(item => item.promptId === promptId
          && !item.settledOptionId && !item.cancelled))
      return { state: 'dependency_violation' };
    if (!dataOnly(output) || !['completed', 'refused', 'cancelled', 'failed', 'inconclusive'].includes(outcome)
        || (output && (!DIGEST.test(output.digest) || !Number.isSafeInteger(output.bytes)
          || output.bytes < 0 || output.bytes > MAX_BODY_BYTES))
        || (reasonCode !== undefined && (!token(reasonCode) || Buffer.byteLength(reasonCode) > MAX_REASON_BYTES)))
      throw new BodyBrainContractError('invalid scripted completion');
    const promoted = this.#queue[0];
    const fields: EventFields[] = [{ kind: 'prompt_completed', promptId, payload: { outcome,
      ...(output ? { outputDigest: output.digest, outputBytes: output.bytes } : {}),
      ...(reasonCode ? { reasonCode } : {}) } }];
    if (promoted) fields.push({ kind: 'prompt_started', promptId: promoted,
      payload: { queuedBehind: this.#queue.length - 1 } });
    if (this.#events.length + fields.length > BODY_BRAIN_MAX_EVENTS) return { state: 'invalid_request' };
    const prepared = this.#prepareEvents(fields);
    const event = prepared[0]!;
    entry.completion = deepFreeze({ promptId, outcome, completedAt: event.at,
      ...(output ? { output: clone(output) } : {}), ...(reasonCode ? { reasonCode } : {}) });
    if (this.#activePromptId === promptId) this.#activePromptId = this.#queue.shift();
    if (this.#activePromptId) {
      this.#state = 'running';
    } else this.#state = 'idle';
    this.#commitEvents(prepared);
    return { state: 'terminal', completion: entry.completion };
  }

  recoveryRecord(): Readonly<BodyBrainRecoveryRecord> {
    const unsigned = {
      schemaVersion: 1 as const, protocolVersion: BODY_BRAIN_PROTOCOL_VERSION,
      adapterId: this.adapterId, sessionRef: this.sessionRef, generation: this.generation,
      state: this.#state, committedSeq: this.#seq,
      ...(this.#lastAt ? { committedAt: this.#lastAt } : {}),
      ...(this.#activePromptId ? { activePromptId: this.#activePromptId } : {}),
      promptQueue: [...this.#queue],
      activePermissionIds: [...this.#permissions.values()].filter(item => !item.settledOptionId && !item.cancelled)
        .map(item => item.permissionId).sort(),
      events: this.#events.map(clone),
      admissions: [...this.#admissions.values()].map(clone),
      permissions: [...this.#permissions.values()].map(clone),
      permissionCommands: [...this.#permissionCommandRecords.values()].map(clone),
      mutations: [...this.#mutationRecords.values()].map(clone), retired: this.#retired,
    };
    return deepFreeze({ ...unsigned, integrityDigest: hash(unsigned) });
  }

  #rememberPermission(
    request: BodyBrainPermissionResponse, requestHash: string, raw: BodyBrainPermissionResult, decidedSeq = this.#seq,
  ): BodyBrainPermissionResult {
    const result = deepFreeze(clone(raw));
    const record = deepFreeze({ commandId: request.commandId, requestHash,
      permissionId: request.permissionId, optionId: request.optionId, decidedSeq, result });
    this.#permissionCommands.set(request.commandId, { hash: requestHash, result });
    this.#permissionCommandRecords.set(request.commandId, record);
    return result;
  }

  #terminalEventFields(reasonCode: 'force_terminated' | 'retired', commandId: string): EventFields[] {
    const fields: EventFields[] = [];
    for (const permission of this.#permissions.values()) {
      if (permission.settledOptionId || permission.cancelled) continue;
      fields.push({ kind: 'permission_resolved', promptId: permission.promptId,
        permissionId: permission.permissionId, payload: { decision: 'cancelled' } });
    }
    const incomplete = [...(this.#activePromptId ? [this.#activePromptId] : []), ...this.#queue];
    for (const promptId of incomplete) {
      const entry = this.#prompts.get(promptId);
      if (!entry || entry.completion) continue;
      fields.push({ kind: 'prompt_completed', promptId,
        payload: { outcome: 'inconclusive', reasonCode } });
    }
    fields.push({ kind: reasonCode, commandId });
    return fields;
  }

  #settleForTerminal(reasonCode: 'force_terminated' | 'retired', events: readonly BodyBrainEvent[]): void {
    for (const permission of this.#permissions.values())
      if (!permission.settledOptionId && !permission.cancelled) permission.cancelled = true;
    for (const event of events) {
      if (event.kind !== 'prompt_completed' || !event.promptId) continue;
      const entry = this.#prompts.get(event.promptId)!;
      entry.completion = deepFreeze({ promptId: event.promptId, outcome: 'inconclusive',
        completedAt: event.at, reasonCode });
    }
    this.#activePromptId = undefined;
    this.#queue.length = 0;
  }

  #fence(generation: string): 'stale_generation' | 'closed' | 'terminated' | 'retired' | undefined {
    if (generation !== this.generation) return 'stale_generation';
    if (this.#retired) return 'retired';
    if (this.#state === 'terminated') return 'terminated';
    if (this.#state === 'closed') return 'closed';
    return undefined;
  }
  #mutation(
    operation: string, raw: BodyBrainGenerationRequest,
    kind: BodyBrainEvent['kind'], terminal: boolean,
  ): BodyBrainMutationResult {
    if (!dataOnly(raw) || !exact(raw, ['generation', 'commandId'])
        || !token(raw.generation) || !token(raw.commandId))
      return { state: 'invalid_request' };
    const request = clone(raw); const requestHash = hash({ operation, request });
    const prior = this.#mutationCommands.get(request.commandId);
    if (prior) return prior.hash === requestHash ? prior.result : { state: 'idempotency_conflict' };
    if (request.generation !== this.generation) return { state: 'stale_generation' };
    if (operation !== 'retire' && this.#retired) return { state: 'retired' };
    if (operation !== 'retire' && this.#state === 'terminated') return { state: 'terminated' };
    if (operation !== 'retire' && this.#state === 'closed') return { state: 'closed' };
    if ((operation === 'retire' && this.#retired) || (operation === 'close' && this.#state === 'closed')) {
      if (this.#mutationRecords.size >= BODY_BRAIN_MAX_COMMANDS) return { state: 'invalid_request' };
      const result = Object.freeze({ state: 'already_done' as const });
      this.#mutationCommands.set(request.commandId, { hash: requestHash, result });
      this.#mutationRecords.set(request.commandId, {
        operation: operation as BodyBrainRecoveryMutation['operation'], commandId: request.commandId,
        requestHash, result,
      });
      return result;
    }
    if (this.#mutationRecords.size >= BODY_BRAIN_MAX_COMMANDS) return { state: 'invalid_request' };
    const terminalReason = operation === 'force' ? 'force_terminated' : operation === 'retire' ? 'retired' : undefined;
    const fields = terminalReason ? this.#terminalEventFields(terminalReason, request.commandId)
      : [{ kind, commandId: request.commandId,
        ...(this.#activePromptId ? { promptId: this.#activePromptId } : {}) }];
    if (this.#events.length + fields.length > BODY_BRAIN_MAX_EVENTS) return { state: 'invalid_request' };
    const prepared = this.#prepareEvents(fields);
    if (terminalReason) this.#settleForTerminal(terminalReason, prepared);
    this.#commitEvents(prepared);
    const event = prepared.at(-1)!;
    if (operation === 'retire') { this.#retired = true; this.#state = 'retired'; }
    else if (operation === 'close') this.#state = 'closed';
    else if (operation === 'force') this.#state = 'terminated';
    else if (terminal) this.#state = 'terminated';
    const result = Object.freeze({ state: 'accepted' as const, cursor: cursor(event.seq) });
    this.#mutationCommands.set(request.commandId, { hash: requestHash, result });
    this.#mutationRecords.set(request.commandId, {
      operation: operation as BodyBrainRecoveryMutation['operation'], commandId: request.commandId,
      requestHash, result,
    });
    return result;
  }
  #nextId(kind: 'event' | 'prompt' | 'permission'): string {
    const id = this.determinism.nextId(kind);
    if (!token(id) || this.#ids.has(id)) throw new BodyBrainContractError('ID source violated uniqueness/bounds');
    this.#ids.add(id); return id;
  }
  #emit(kind: BodyBrainEvent['kind'], fields: Partial<BodyBrainEvent>): BodyBrainEvent {
    const prepared = this.#prepareEvents([{ kind, ...fields }]);
    this.#commitEvents(prepared);
    return prepared[0]!;
  }
  #prepareEvents(specs: readonly EventFields[]): BodyBrainEvent[] {
    if (this.#events.length + specs.length > BODY_BRAIN_MAX_EVENTS)
      throw new BodyBrainContractError('event ledger capacity exceeded');
    let nextSeq = this.#seq;
    let priorAt = this.#lastAt;
    const stagedIds = new Set<string>();
    const events: BodyBrainEvent[] = [];
    for (const fields of specs) {
    if (fields.payload && (Object.keys(fields.payload).length > 16
        || Object.values(fields.payload).some(value => typeof value === 'string'
          && Buffer.byteLength(value) > BODY_BRAIN_MAX_ID_BYTES)))
      throw new BodyBrainContractError('event payload exceeds bounds');
    const at = this.determinism.now();
    if (!iso(at) || (priorAt !== undefined && at <= priorAt))
      throw new BodyBrainContractError('clock source violated strict monotonicity');
    const eventId = this.determinism.nextId('event');
    if (!token(eventId) || this.#ids.has(eventId) || stagedIds.has(eventId))
      throw new BodyBrainContractError('ID source violated uniqueness/bounds');
    stagedIds.add(eventId);
    const event = deepFreeze(clone({ schemaVersion: 1 as const, eventId, seq: ++nextSeq,
      at, generation: this.generation, ...fields }));
    canonical(event);
    events.push(event); priorAt = at;
    }
    return events;
  }
  #commitEvents(events: readonly BodyBrainEvent[]): void {
    for (const event of events) {
      this.#seq = event.seq; this.#lastAt = event.at; this.#ids.add(event.eventId); this.#events.push(event);
      for (const listener of [...this.#listeners]) { try { listener(event); } catch { /* isolated */ } }
    }
  }
}

function validRecovery(raw: unknown, adapterId: string): raw is BodyBrainRecoveryRecord {
  if (!dataOnly(raw) || !exact(raw, ['schemaVersion', 'protocolVersion', 'adapterId', 'sessionRef', 'generation', 'state',
    'committedSeq', 'committedAt?', 'activePromptId?', 'promptQueue', 'activePermissionIds',
    'events', 'admissions', 'permissions', 'permissionCommands', 'mutations', 'retired',
    'integrityDigest'])) return false;
  const value = raw as unknown as BodyBrainRecoveryRecord;
  if (value.schemaVersion !== 1 || value.protocolVersion !== 1 || value.adapterId !== adapterId
      || !token(value.adapterId) || !token(value.sessionRef) || !token(value.generation)
      || !['starting', 'idle', 'running', 'awaiting_permission', 'failed', 'terminated', 'closed', 'retired']
        .includes(value.state) || !Number.isSafeInteger(value.committedSeq)
      || value.committedSeq < 0 || typeof value.retired !== 'boolean'
      || (value.committedSeq === 0 ? value.committedAt !== undefined : !iso(value.committedAt))
      || (value.activePromptId !== undefined && !token(value.activePromptId))
      || !Array.isArray(value.promptQueue) || value.promptQueue.length > BODY_BRAIN_MAX_ADMISSIONS
      || value.promptQueue.some((id: unknown) => !token(id))
      || new Set(value.promptQueue).size !== value.promptQueue.length
      || !Array.isArray(value.activePermissionIds) || value.activePermissionIds.length > BODY_BRAIN_MAX_ACTIVE_IDS
      || value.activePermissionIds.some(id => !token(id)) || new Set(value.activePermissionIds).size !== value.activePermissionIds.length
      || !Array.isArray(value.events) || value.events.length !== value.committedSeq
      || value.events.length > BODY_BRAIN_MAX_EVENTS
      || !Array.isArray(value.admissions) || value.admissions.length > BODY_BRAIN_MAX_ADMISSIONS
      || !Array.isArray(value.permissions) || value.permissions.length > BODY_BRAIN_MAX_ACTIVE_IDS
      || !Array.isArray(value.permissionCommands) || value.permissionCommands.length > BODY_BRAIN_MAX_COMMANDS
      || !Array.isArray(value.mutations) || value.mutations.length > BODY_BRAIN_MAX_COMMANDS
      || !DIGEST.test(value.integrityDigest)) return false;
  const eventIds = new Set<string>(); let priorAt: string | undefined;
  for (const [index, event] of value.events.entries()) {
    if (!exactKeys(event, ['schemaVersion', 'eventId', 'seq', 'at', 'generation', 'kind', 'promptId?',
      'permissionId?', 'commandId?', 'payload?']) || event.schemaVersion !== 1 || event.seq !== index + 1
      || !token(event.eventId) || eventIds.has(event.eventId) || !iso(event.at)
      || (priorAt !== undefined && event.at <= priorAt) || event.generation !== value.generation
      || !['prompt_admitted', 'prompt_started', 'prompt_completed', 'permission_requested',
        'permission_resolved', 'cancel_requested', 'force_terminated', 'closed', 'retired'].includes(event.kind)
      || (event.promptId !== undefined && !token(event.promptId))
      || (event.permissionId !== undefined && !token(event.permissionId))
      || (event.commandId !== undefined && !token(event.commandId))
      || (event.payload !== undefined && (!dataOnly(event.payload)
        || Object.keys(event.payload).length > 16 || Object.values(event.payload).some(item =>
          !['string', 'number', 'boolean'].includes(typeof item))))) return false;
    eventIds.add(event.eventId); priorAt = event.at;
    const common = ['schemaVersion', 'eventId', 'seq', 'at', 'generation', 'kind'];
    if (event.kind === 'prompt_admitted'
        && !exactKeys(event, [...common, 'promptId', 'commandId', 'payload'])) return false;
    if ((event.kind === 'prompt_started' || event.kind === 'prompt_completed')
        && !exactKeys(event, [...common, 'promptId', 'payload'])) return false;
    if (event.kind === 'permission_requested'
        && !exactKeys(event, [...common, 'promptId', 'permissionId', 'payload'])) return false;
    if (event.kind === 'permission_resolved'
        && !exactKeys(event, [...common, 'promptId', 'permissionId', 'commandId?', 'payload'])) return false;
    if (['cancel_requested', 'force_terminated', 'closed', 'retired'].includes(event.kind)
        && !exactKeys(event, [...common, 'promptId?', 'commandId'])) return false;
  }
  if ((value.committedSeq === 0 && value.committedAt !== undefined)
      || (value.committedSeq > 0 && value.committedAt !== value.events.at(-1)?.at)) return false;
  const admissionCommands = new Set<string>(); const promptIds = new Set<string>();
  for (const admission of value.admissions) {
    if (!exactKeys(admission, ['requestHash', 'request', 'receipt', 'completion?'])
        || !DIGEST.test(admission.requestHash) || !validPrompt(admission.request)
        || admission.request.generation !== value.generation
        || hash(admission.request) !== admission.requestHash
        || !exactKeys(admission.receipt, ['commandId', 'promptId', 'state', 'queuedBehind', 'acceptedAt', 'cursor'])
        || admission.receipt.commandId !== admission.request.commandId || !token(admission.receipt.promptId)
        || !['queued', 'started'].includes(admission.receipt.state)
        || !Number.isSafeInteger(admission.receipt.queuedBehind) || admission.receipt.queuedBehind < 0
        || admission.receipt.queuedBehind > BODY_BRAIN_MAX_ADMISSIONS || !iso(admission.receipt.acceptedAt)
        || parseCursor(admission.receipt.cursor, value.committedSeq) === undefined
        || admissionCommands.has(admission.request.commandId) || promptIds.has(admission.receipt.promptId)) return false;
    admissionCommands.add(admission.request.commandId); promptIds.add(admission.receipt.promptId);
    const admittedSeq = parseCursor(admission.receipt.cursor, value.committedSeq);
    const admittedEvent = admittedSeq === undefined ? undefined : value.events[admittedSeq - 1];
    if (!admittedEvent || admittedEvent.kind !== 'prompt_admitted'
        || admittedEvent.promptId !== admission.receipt.promptId
        || admittedEvent.commandId !== admission.request.commandId
        || admittedEvent.at !== admission.receipt.acceptedAt
        || canonical(admittedEvent.payload) !== canonical({ bodyDigest: admission.request.body.digest,
          bodyBytes: admission.request.body.bytes, queuedBehind: admission.receipt.queuedBehind })) return false;
    if (admission.completion && (!exactKeys(admission.completion,
      ['promptId', 'outcome', 'completedAt', 'output?', 'reasonCode?'])
      || admission.completion.promptId !== admission.receipt.promptId
      || !['completed', 'refused', 'cancelled', 'failed', 'inconclusive'].includes(admission.completion.outcome)
      || !iso(admission.completion.completedAt)
      || (admission.completion.output !== undefined && (!exactKeys(admission.completion.output, ['digest', 'bytes'])
        || !DIGEST.test(admission.completion.output.digest)
        || !Number.isSafeInteger(admission.completion.output.bytes) || admission.completion.output.bytes < 0
        || admission.completion.output.bytes > MAX_BODY_BYTES))
      || (admission.completion.reasonCode !== undefined && !token(admission.completion.reasonCode)))) return false;
    if (admission.completion) {
      const completionEvent = value.events.find(event => event.kind === 'prompt_completed'
        && event.promptId === admission.receipt.promptId && event.at === admission.completion!.completedAt);
      const expectedPayload = { outcome: admission.completion.outcome,
        ...(admission.completion.output ? { outputDigest: admission.completion.output.digest,
          outputBytes: admission.completion.output.bytes } : {}),
        ...(admission.completion.reasonCode ? { reasonCode: admission.completion.reasonCode } : {}) };
      if (!completionEvent || canonical(completionEvent.payload) !== canonical(expectedPayload)) return false;
    }
  }
  const permissionIds = new Set<string>();
  for (const permission of value.permissions) {
    if (!exactKeys(permission, ['permissionId', 'promptId', 'optionIds', 'settledOptionId?', 'cancelled?',
      'responseCommandId?', 'responseHash?']) || !token(permission.permissionId)
      || !promptIds.has(permission.promptId) || permissionIds.has(permission.permissionId)
      || !Array.isArray(permission.optionIds) || !permission.optionIds.length || permission.optionIds.length > 16
      || permission.optionIds.some((option: unknown) => !token(option))
      || new Set(permission.optionIds).size !== permission.optionIds.length
      || (permission.settledOptionId !== undefined && !permission.optionIds.includes(permission.settledOptionId))
      || (permission.cancelled !== undefined && permission.cancelled !== true)
      || (permission.cancelled && permission.settledOptionId !== undefined)
      || ((permission.responseCommandId === undefined) !== (permission.responseHash === undefined))
      || (permission.responseCommandId !== undefined && (!token(permission.responseCommandId)
        || permission.settledOptionId === undefined || !DIGEST.test(permission.responseHash!)
        || hash({ generation: value.generation,
          commandId: permission.responseCommandId, permissionId: permission.permissionId,
          optionId: permission.settledOptionId }) !== permission.responseHash))) return false;
    permissionIds.add(permission.permissionId);
    if (!value.events.some(event => event.kind === 'permission_requested'
      && event.permissionId === permission.permissionId && event.promptId === permission.promptId
      && canonical(event.payload) === canonical({ optionCount: permission.optionIds.length }))) return false;
    if (permission.settledOptionId && !value.events.some(event => event.kind === 'permission_resolved'
      && event.permissionId === permission.permissionId && event.promptId === permission.promptId
      && event.commandId === permission.responseCommandId
      && canonical(event.payload) === canonical({ optionId: permission.settledOptionId }))) return false;
    if (permission.cancelled && !value.events.some(event => event.kind === 'permission_resolved'
      && event.permissionId === permission.permissionId && event.promptId === permission.promptId
      && event.commandId === undefined
      && canonical(event.payload) === canonical({ decision: 'cancelled' }))) return false;
    if (permission.responseCommandId && !value.permissionCommands.some(command =>
      command.commandId === permission.responseCommandId && command.result.state === 'accepted')) return false;
  }
  const permissionCommandIds = new Set<string>();
  for (const command of value.permissionCommands) {
    if (!exactKeys(command, ['commandId', 'requestHash', 'permissionId', 'optionId', 'decidedSeq', 'result'])
        || !token(command.commandId) || permissionCommandIds.has(command.commandId)
        || !token(command.permissionId) || !token(command.optionId) || !DIGEST.test(command.requestHash)
        || !Number.isSafeInteger(command.decidedSeq) || command.decidedSeq < 0
        || command.decidedSeq > value.committedSeq
        || command.requestHash !== hash({ generation: value.generation, commandId: command.commandId,
          permissionId: command.permissionId, optionId: command.optionId })
        || !exactKeys(command.result, ['state', 'optionId?'])
        || !['accepted', 'unknown_permission', 'already_settled', 'invalid_option', 'closed', 'terminated', 'retired']
          .includes(command.result.state))
      return false;
    const permission = value.permissions.find(item => item.permissionId === command.permissionId);
    const priorEvents = value.events.slice(0, command.decidedSeq);
    const requested = priorEvents.find(event => event.kind === 'permission_requested'
      && event.permissionId === command.permissionId);
    const resolved = priorEvents.find(event => event.kind === 'permission_resolved'
      && event.permissionId === command.permissionId);
    if (command.result.state === 'accepted' && (!permission || !requested
        || permission.settledOptionId !== command.optionId || command.result.optionId !== command.optionId
        || permission.responseCommandId !== command.commandId || resolved?.seq !== command.decidedSeq
        || resolved.commandId !== command.commandId)) return false;
    if (command.result.state === 'unknown_permission' && requested) return false;
    if (command.result.state === 'invalid_option' && (!permission || !requested || resolved
        || permission.optionIds.includes(command.optionId) || command.result.optionId !== undefined)) return false;
    if (command.result.state === 'already_settled' && (!permission || !requested || !resolved
        || command.result.optionId !== (resolved.payload?.optionId as string | undefined))) return false;
    if (command.result.state === 'closed' && (!priorEvents.some(event => event.kind === 'closed')
        || command.result.optionId !== undefined)) return false;
    if (command.result.state === 'terminated' && (!priorEvents.some(event => event.kind === 'force_terminated')
        || command.result.optionId !== undefined)) return false;
    if (command.result.state === 'retired' && (!priorEvents.some(event => event.kind === 'retired')
        || command.result.optionId !== undefined)) return false;
    permissionCommandIds.add(command.commandId);
  }
  if (value.activePromptId !== undefined && !promptIds.has(value.activePromptId)) return false;
  if (value.activePermissionIds.some(id => !permissionIds.has(id))) return false;
  const expectedActive = value.permissions.filter(item => !item.settledOptionId && !item.cancelled)
    .map(item => item.permissionId).sort();
  if (canonical([...value.activePermissionIds].sort()) !== canonical(expectedActive)) return false;
  if (value.activePromptId && (value.promptQueue.includes(value.activePromptId)
      || value.admissions.find(item => item.receipt.promptId === value.activePromptId)?.completion)) return false;
  if (value.promptQueue.some(id => value.admissions.find(item => item.receipt.promptId === id)?.completion)) return false;
  const incomplete = value.admissions.filter(item => !item.completion).map(item => item.receipt.promptId);
  const correlated = [...(value.activePromptId ? [value.activePromptId] : []), ...value.promptQueue];
  if (!['terminated', 'closed', 'retired', 'failed'].includes(value.state)
      && canonical(incomplete.sort()) !== canonical(correlated.sort())) return false;
  if (['terminated', 'retired'].includes(value.state)
      && (incomplete.length || correlated.length || value.activePermissionIds.length)) return false;
  if (value.retired !== (value.state === 'retired')) return false;
  const unsettledForActive = value.permissions.some(item => item.promptId === value.activePromptId
    && !item.settledOptionId && !item.cancelled);
  const expectedState = value.activePromptId ? (unsettledForActive ? 'awaiting_permission' : 'running') : 'idle';
  if (!['terminated', 'closed', 'retired', 'failed'].includes(value.state) && value.state !== expectedState) return false;
  let simulatedActive: string | undefined; const simulatedQueue: string[] = [];
  const simulatedPermissions = new Map<string, { promptId: string; optionIds: readonly string[];
    settledOptionId?: string; cancelled?: true }>();
  let simulatedLifecycle: 'open' | 'closed' | 'terminated' | 'retired' = 'open';
  let retiringFromClosed = false;
  let expectedStart: string | undefined;
  for (const event of value.events) {
    if (simulatedLifecycle === 'retired') return false;
    if (simulatedLifecycle === 'terminated' && event.kind !== 'retired') return false;
    if (simulatedLifecycle === 'closed') {
      const retireSweep = (event.kind === 'prompt_completed' && event.payload?.reasonCode === 'retired')
        || (event.kind === 'permission_resolved' && event.payload?.decision === 'cancelled');
      if (!retireSweep && event.kind !== 'retired') return false;
      retiringFromClosed ||= retireSweep;
    }
    const terminalSweep = event.kind === 'prompt_completed'
      && (event.payload?.reasonCode === 'force_terminated' || event.payload?.reasonCode === 'retired');
    if (expectedStart && event.kind !== 'prompt_started' && !terminalSweep) return false;
    if (event.kind === 'prompt_admitted') {
      const admission = value.admissions.find(item => item.receipt.promptId === event.promptId);
      const queuedBehind = simulatedActive ? simulatedQueue.length + 1 : 0;
      if (!admission || admission.receipt.queuedBehind !== queuedBehind
          || admission.receipt.state !== (queuedBehind ? 'queued' : 'started')) return false;
      if (simulatedActive) simulatedQueue.push(admission.receipt.promptId);
      else simulatedActive = admission.receipt.promptId;
    } else if (event.kind === 'prompt_completed') {
      if (!simulatedActive || event.promptId !== simulatedActive) return false;
      if ([...simulatedPermissions.values()].some(permission => permission.promptId === event.promptId
        && !permission.settledOptionId && !permission.cancelled)) return false;
      simulatedActive = simulatedQueue.shift(); expectedStart = terminalSweep ? undefined : simulatedActive;
    } else if (event.kind === 'prompt_started') {
      if (!expectedStart || event.promptId !== expectedStart) return false;
      if (canonical(event.payload) !== canonical({ queuedBehind: simulatedQueue.length })) return false;
      expectedStart = undefined;
    } else if (event.kind === 'permission_requested') {
      const permission = value.permissions.find(item => item.permissionId === event.permissionId);
      if (!simulatedActive || event.promptId !== simulatedActive || !event.permissionId || !permission
          || simulatedPermissions.has(event.permissionId)) return false;
      simulatedPermissions.set(event.permissionId, { promptId: permission.promptId,
        optionIds: permission.optionIds });
    } else if (event.kind === 'permission_resolved') {
      if (!event.permissionId) return false;
      const permission = simulatedPermissions.get(event.permissionId);
      if (!permission || permission.promptId !== event.promptId
          || permission.settledOptionId || permission.cancelled) return false;
      if (event.commandId) {
        const optionId = event.payload?.optionId;
        if (typeof optionId !== 'string' || !permission.optionIds.includes(optionId)) return false;
        permission.settledOptionId = optionId;
      } else {
        if (canonical(event.payload) !== canonical({ decision: 'cancelled' })) return false;
        permission.cancelled = true;
      }
    } else if (event.kind === 'cancel_requested' || event.kind === 'closed') {
      if (event.promptId !== simulatedActive) return false;
      if (event.kind === 'closed') simulatedLifecycle = 'closed';
    } else if (event.kind === 'force_terminated' || event.kind === 'retired') {
      if (simulatedActive || simulatedQueue.length || event.promptId !== undefined) return false;
      simulatedActive = undefined; simulatedQueue.length = 0; expectedStart = undefined;
      simulatedLifecycle = event.kind === 'retired' ? 'retired' : 'terminated';
      if (event.kind === 'retired') retiringFromClosed = false;
    }
    if (['cancel_requested', 'force_terminated', 'closed', 'retired'].includes(event.kind)
        && event.payload !== undefined) return false;
  }
  if (expectedStart) return false;
  if (retiringFromClosed) return false;
  if ((value.state === 'terminated' && simulatedLifecycle !== 'terminated')
      || (value.state === 'closed' && simulatedLifecycle !== 'closed')
      || (value.state === 'retired' && simulatedLifecycle !== 'retired')) return false;
  if (simulatedActive !== value.activePromptId || canonical(simulatedQueue) !== canonical(value.promptQueue)) return false;
  if (simulatedPermissions.size !== value.permissions.length) return false;
  for (const permission of value.permissions) {
    const simulated = simulatedPermissions.get(permission.permissionId);
    if (!simulated || simulated.promptId !== permission.promptId
        || canonical(simulated.optionIds) !== canonical(permission.optionIds)
        || simulated.settledOptionId !== permission.settledOptionId
        || simulated.cancelled !== permission.cancelled) return false;
  }
  const mutationCommands = new Set<string>();
  for (const mutation of value.mutations) {
    if (!exactKeys(mutation, ['operation', 'commandId', 'requestHash', 'result'])
      || !['cancel', 'force', 'close', 'retire'].includes(mutation.operation)
      || !token(mutation.commandId) || mutationCommands.has(mutation.commandId)
      || !DIGEST.test(mutation.requestHash)
      || mutation.requestHash !== hash({ operation: mutation.operation,
        request: { generation: value.generation, commandId: mutation.commandId } })
      || !exactKeys(mutation.result, ['state', 'cursor?'])
      || !['accepted', 'already_done'].includes(mutation.result.state)
      || (mutation.result.state === 'accepted'
        ? parseCursor(mutation.result.cursor, value.committedSeq) === undefined
        : mutation.result.cursor !== undefined)) return false;
    if (mutation.result.state === 'already_done') { mutationCommands.add(mutation.commandId); continue; }
    const seq = parseCursor(mutation.result.cursor, value.committedSeq)!;
    const event = value.events[seq - 1];
    const expectedKind = ({ cancel: 'cancel_requested', force: 'force_terminated',
      close: 'closed', retire: 'retired' } as Record<string, string>)[mutation.operation];
    if (!event || event.kind !== expectedKind || event.commandId !== mutation.commandId
        || event.payload !== undefined) return false;
    mutationCommands.add(mutation.commandId);
  }
  const allIds = [...eventIds, ...promptIds, ...permissionIds];
  if (new Set(allIds).size !== allIds.length) return false;
  const { integrityDigest, ...unsigned } = value;
  return hash(unsigned) === integrityDigest;
}

export class FakeBodyBrainSessionRestorer implements BodyBrainSessionRestorer {
  constructor(readonly adapterId: string, readonly determinism: BodyBrainDeterminism) {}
  restore(raw: unknown): BodyBrainRestoreResult {
    if (raw === undefined || raw === null) return { state: 'failed', code: 'reference_missing' };
    if (!raw || typeof raw !== 'object') return { state: 'failed', code: 'corrupt_recovery' };
    const candidate = raw as Record<string, unknown>;
    if (candidate.protocolVersion !== BODY_BRAIN_PROTOCOL_VERSION)
      return { state: 'failed', code: 'protocol_mismatch' };
    if (candidate.adapterId !== this.adapterId) return { state: 'failed', code: 'adapter_incompatible' };
    try {
      if (!validRecovery(raw, this.adapterId)) return { state: 'failed', code: 'corrupt_recovery' };
    } catch { return { state: 'failed', code: 'corrupt_recovery' }; }
    if (raw.state === 'terminated' || raw.state === 'failed') return { state: 'failed', code: 'agent_exited' };
    if (raw.state === 'retired' || raw.retired) return { state: 'failed', code: 'resume_rejected' };
    try {
      const nextAt = this.determinism.now();
      const issued = new Set([
        ...raw.events.map(event => event.eventId),
        ...raw.admissions.map(entry => entry.receipt.promptId),
        ...raw.permissions.map(entry => entry.permissionId),
      ]);
      const prefetched = new Map<'event' | 'prompt' | 'permission', string>();
      for (const kind of ['event', 'prompt', 'permission'] as const) {
        const id = this.determinism.nextId(kind);
        if (!token(id) || issued.has(id) || [...prefetched.values()].includes(id))
          return { state: 'failed', code: 'corrupt_recovery' };
        prefetched.set(kind, id);
      }
      if (!iso(nextAt) || (raw.committedAt !== undefined && nextAt <= raw.committedAt))
        return { state: 'failed', code: 'corrupt_recovery' };
      let prefetchedAt: string | undefined = nextAt;
      const continuity: BodyBrainDeterminism = {
        now: () => { if (prefetchedAt) { const value = prefetchedAt; prefetchedAt = undefined; return value; }
          return this.determinism.now(); },
        nextId: kind => { const value = prefetched.get(kind); if (value) { prefetched.delete(kind); return value; }
          return this.determinism.nextId(kind); },
      };
      return { state: 'restored', session: new FakeBodyBrainSession(
        this.adapterId, raw.sessionRef, raw.generation, continuity, raw,
      ) };
    } catch { return { state: 'failed', code: 'corrupt_recovery' }; }
  }
}
