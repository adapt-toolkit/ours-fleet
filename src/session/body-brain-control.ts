import {
  BODY_BRAIN_MAX_EVENTS, BODY_BRAIN_MAX_EVENTS_PAGE,
  type BodyBrainEvent, type BodyBrainGenerationRequest, type BodyBrainPageRequest,
  type BodyBrainPermissionResponse, type BodyBrainPromptRequest, type BodyBrainSession,
} from './body-brain.js';

/** Finite default; callers may choose any bound from 1 through BODY_BRAIN_MAX_EVENTS. */
export const BODY_BRAIN_DEFAULT_FOLLOW_BUFFER = 512;

export type BodyBrainControlCommand =
  | { kind: 'snapshot' }
  | { kind: 'page'; request?: BodyBrainPageRequest }
  | { kind: 'admit'; request: BodyBrainPromptRequest }
  | { kind: 'completion'; generation: string; promptId: string }
  | { kind: 'permission'; request: BodyBrainPermissionResponse }
  | { kind: 'cancel'; request: BodyBrainGenerationRequest }
  | { kind: 'force'; request: BodyBrainGenerationRequest }
  | { kind: 'close'; request: BodyBrainGenerationRequest }
  | { kind: 'retire'; request: BodyBrainGenerationRequest };

export type BodyBrainControlResult =
  | ReturnType<BodyBrainSession['snapshot']>
  | ReturnType<BodyBrainSession['page']>
  | ReturnType<BodyBrainSession['admitPrompt']>
  | ReturnType<BodyBrainSession['awaitCompletion']>
  | ReturnType<BodyBrainSession['respondPermission']>
  | ReturnType<BodyBrainSession['requestCancel']>
  | { state: 'invalid_request' };

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set;
  });
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

/** Pure in-process dispatch. Dependency exceptions remain dependency exceptions. */
function parseCommand(raw: unknown): BodyBrainControlCommand | undefined {
  if (!plainRecord(raw) || typeof raw.kind !== 'string') return undefined;
  switch (raw.kind) {
    case 'snapshot':
      return exact(raw, ['kind']) ? raw as { kind: 'snapshot' } : undefined;
    case 'page':
      return exact(raw, ['kind'], ['request']) ? raw as unknown as BodyBrainControlCommand : undefined;
    case 'admit':
    case 'permission':
    case 'cancel':
    case 'force':
    case 'close':
    case 'retire':
      return exact(raw, ['kind', 'request']) ? raw as unknown as BodyBrainControlCommand : undefined;
    case 'completion':
      return exact(raw, ['kind', 'generation', 'promptId']) ? raw as unknown as BodyBrainControlCommand : undefined;
    default:
      return undefined;
  }
}

const unreachable = (value: never): never => { throw new Error(`unreachable BodyBrain command: ${String(value)}`); };

export function dispatchBodyBrain(
  session: BodyBrainSession, raw: unknown,
): BodyBrainControlResult {
  const command = parseCommand(raw);
  if (!command) return { state: 'invalid_request' };
  switch (command.kind) {
    case 'snapshot': return session.snapshot();
    case 'page': return session.page(command.request);
    case 'admit': return session.admitPrompt(command.request);
    case 'completion': return session.awaitCompletion(command.generation, command.promptId);
    case 'permission': return session.respondPermission(command.request);
    case 'cancel': return session.requestCancel(command.request);
    case 'force': return session.forceTerminate(command.request);
    case 'close': return session.close(command.request);
    case 'retire': return session.retire(command.request);
    default: return unreachable(command);
  }
}

export type BodyBrainFollowCloseReason =
  | 'caller_closed' | 'invalid_cursor' | 'generation_changed' | 'discontinuity' | 'buffer_overflow';
export interface BodyBrainFollowTerminal {
  state: 'closed';
  reason: BodyBrainFollowCloseReason;
  generation: string;
  cursor: string;
}
export interface BodyBrainFollowHandle {
  close(): void;
  readonly closed: boolean;
  readonly cursor: string;
}
export interface BodyBrainFollowRequest {
  after?: string;
  pageSize?: number;
  bufferLimit?: number;
  onEvent(event: BodyBrainEvent): void;
  onClose(terminal: Readonly<BodyBrainFollowTerminal>): void;
}

function cursorSeq(value: string): number | undefined {
  const match = /^bb:(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) return undefined;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : undefined;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function eventIdentity(event: BodyBrainEvent): string {
  return canonical(event);
}

/**
 * Subscribe-first follow with a fixed replay watermark. Callback failures are
 * isolated; delivery cursor advancement reflects the contiguous ledger, not UI success.
 */
export function followBodyBrain(
  session: BodyBrainSession, request: BodyBrainFollowRequest,
): BodyBrainFollowHandle {
  const generation = session.generation;
  const requestedSeq = cursorSeq(request.after ?? 'bb:0');
  let deliveredSeq = 0;
  let deliveredCursor = 'bb:0';
  let initialVerifiedSeq = 0;
  let closed = false;
  let replaying = true;
  let unsubscribe: () => void = () => {};
  let subscriptionReady = false;
  let pendingTerminal: BodyBrainFollowCloseReason | undefined;
  const buffered: BodyBrainEvent[] = [];
  const delivered = new Map<number, string>();
  const pageSize = request.pageSize ?? BODY_BRAIN_MAX_EVENTS_PAGE;
  const bufferLimit = request.bufferLimit ?? BODY_BRAIN_DEFAULT_FOLLOW_BUFFER;

  const notifyTerminal = (reason: BodyBrainFollowCloseReason): void => {
    try { request.onClose(Object.freeze({ state: 'closed', reason, generation, cursor: deliveredCursor })); }
    catch { /* consumer isolation */ }
  };
  const terminal = (reason: BodyBrainFollowCloseReason): void => {
    if (closed) return;
    closed = true;
    if (!subscriptionReady) { pendingTerminal = reason; return; }
    try { unsubscribe(); } catch { /* close remains terminal */ }
    notifyTerminal(reason);
  };
  const accept = (event: BodyBrainEvent): boolean => {
    if (event.generation !== generation) { terminal('generation_changed'); return false; }
    const identity = eventIdentity(event);
    if (event.seq <= deliveredSeq) {
      // The caller owns the already-consumed prefix; this helper has no event
      // identity for it and therefore ignores subscription overlap within it.
      if (event.seq <= initialVerifiedSeq) return true;
      if (delivered.get(event.seq) !== identity) terminal('discontinuity');
      return !closed;
    }
    if (event.seq !== deliveredSeq + 1) { terminal('discontinuity'); return false; }
    deliveredSeq = event.seq;
    deliveredCursor = `bb:${deliveredSeq}`;
    delivered.set(event.seq, identity);
    try { request.onEvent(event); } catch { /* consumer isolation */ }
    return true;
  };
  const subscribed = (event: BodyBrainEvent): void => {
    if (closed) return;
    if (event.generation !== generation) { terminal('generation_changed'); return; }
    if (replaying) {
      buffered.push(event);
      if (buffered.length > bufferLimit) terminal('buffer_overflow');
      return;
    }
    accept(event);
  };

  unsubscribe = session.subscribe(subscribed);
  subscriptionReady = true;
  if (pendingTerminal) {
    try { unsubscribe(); } catch { /* close remains terminal */ }
    notifyTerminal(pendingTerminal);
  }
  const handle: BodyBrainFollowHandle = {
    close: () => terminal('caller_closed'),
    get closed() { return closed; },
    get cursor() { return deliveredCursor; },
  };
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > BODY_BRAIN_MAX_EVENTS_PAGE
      || !Number.isSafeInteger(bufferLimit) || bufferLimit < 1 || bufferLimit > BODY_BRAIN_MAX_EVENTS
      || requestedSeq === undefined) {
    terminal('invalid_cursor'); return handle;
  }
  let snapshot: Readonly<ReturnType<BodyBrainSession['snapshot']>>;
  try { snapshot = session.snapshot(); }
  catch (error) { closed = true; try { unsubscribe(); } catch { /* dependency error remains primary */ } throw error; }
  if (closed) return handle;
  if (snapshot.generation !== generation) { terminal('generation_changed'); return handle; }
  const watermark = cursorSeq(snapshot.cursor);
  if (watermark === undefined || requestedSeq > watermark) { terminal('invalid_cursor'); return handle; }
  deliveredSeq = requestedSeq;
  deliveredCursor = `bb:${deliveredSeq}`;
  initialVerifiedSeq = requestedSeq;

  while (!closed && deliveredSeq < watermark) {
    let page: ReturnType<BodyBrainSession['page']>;
    try { page = session.page({ after: deliveredCursor, limit: pageSize }); }
    catch (error) { closed = true; try { unsubscribe(); } catch { /* dependency error remains primary */ } throw error; }
    if (page.state !== 'ok') { terminal('invalid_cursor'); break; }
    if (page.generation !== generation) { terminal('generation_changed'); break; }
    const eligible = page.events.filter(event => event.seq <= watermark);
    if (!eligible.length) { terminal('discontinuity'); break; }
    for (const event of eligible) if (!accept(event)) break;
  }
  if (closed) return handle;
  for (let index = 0; index < buffered.length && !closed; index++) accept(buffered[index]!);
  if (!closed) replaying = false;
  return handle;
}
