import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { replaceFileAtomically } from '../atomic-file.js';
import { ReminderScheduleError, resolveSchedule } from './schedule.js';

/**
 * Durable, private, single-writer state for one agent's self-reminders.
 *
 * The runner that supervises the agent is the only writer: the agent's MCP
 * tools, the dispatch timer and the session's release guard all run in that
 * one process, and every mutation here is synchronous, so each method call is
 * its own linearization point. Asynchronous callers (a queue receipt, a turn
 * completion) never carry state across an `await`; they re-read the current
 * record and apply only forward transitions, so a late receipt can never undo
 * an acknowledgement, update or cancellation that happened meanwhile.
 *
 * Event lifecycle — the boundary that matters is `dispatched`:
 *
 *   pending ──admit──▶ admitting ──release guard──▶ dispatched ──ack──▶ acknowledged
 *      ▲                   │                            │
 *      └── not released ───┘                            └─ restart ─▶ uncertain (held)
 *
 * `dispatched` is written durably by the session's release guard immediately
 * before the prompt is handed to the model. An event found `admitting` after a
 * restart therefore provably never reached the model (reminder prompt bodies
 * are not retained, so session recovery cannot replay them) and is retried
 * under the same event id. An event found `dispatched` may or may not have been
 * seen, so it is held as `uncertain` and never automatically re-admitted.
 *
 * Urgency is an explicit opt-in per reminder (`interrupt`). Absent means false,
 * so stores written before it existed keep their exact idle-only meaning, and
 * an older runtime that ignores the field stays idle-only. An urgent event may
 * request at most ONE interruption of the agent's current turn per revision:
 * the request is durably recorded before the session is asked to cancel, so a
 * crash, a forced adapter restart or a second urgent reminder can never turn
 * it into a cancellation loop. Every later admission of that event is
 * idle-only, and only the release guard ever records `dispatched`.
 */

export const SELF_REMINDERS_FILE = '.self-reminders.json';
export const MAX_OPEN_REMINDERS = 100;
export const MAX_RETAINED_CLOSED = 200;
export const DEFAULT_LATE_WINDOW_SECONDS = 3600;
export const MAX_LATE_WINDOW_SECONDS = 7 * 24 * 3600;
export const MIN_LATE_WINDOW_SECONDS = 60;
const MAX_HORIZON_MS = 5 * 366 * 24 * 3600 * 1000;
const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS = 4000;
const MAX_REQUEST_KEY_CHARS = 200;

export type ReminderState = 'active' | 'delivered' | 'acknowledged' | 'cancelled' | 'expired';
export type ReminderEventState =
  | 'pending' | 'admitting' | 'dispatched' | 'uncertain'
  | 'acknowledged' | 'invalidated' | 'expired';

/**
 * Who a store belongs to. The fields that must match depend on lifetime,
 * because that is what each lifetime keeps stable across its ordinary
 * stop/start:
 *
 * - `permanent`: an orderly stop releases the managed runtime, and the next
 *   start provisions a new runtime instance and action for the SAME identity
 *   and state directory. Ownership is the role plus its identity CID. A
 *   removed agent's state directory is deleted, so a later same-named agent
 *   starts without this store; a replaced identity has a different CID.
 * - `temporary` (including task members): suspend/resume keeps the runtime
 *   instance and action, and retirement archives the directory with this store
 *   removed. Ownership is role, CID, instance and action.
 */
export interface ReminderOwner {
  role: string;
  lifetime: 'permanent' | 'temporary';
  /** Logical managed-runtime instance. */
  instance: string;
  cid: string;
  /** Creation action of that runtime instance. */
  action: string;
}

export interface ReminderRecord {
  id: string;
  requestKey: string;
  requestDigest: string;
  revision: number;
  state: ReminderState;
  title: string;
  note: string;
  localTime: string;
  timeZone: string;
  fold?: 0 | 1;
  dueAt: string;
  lateWindowSeconds: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  closedReason?: string;
  /** Present (true) only for an urgent reminder; absent is the idle-only default. */
  interrupt?: true;
}

/**
 * What became of an urgent event's single interruption request. `requested` is
 * the durable mark written before the session is asked to cancel; it is never
 * evidence that anything was cancelled or delivered.
 *
 * - `cancelled`: the target turn's own terminal result says it was cancelled
 *   by this request (correlated, not inferred).
 * - `ended`: the session reported the cancellation settled, but the target's
 *   terminal could not be correlated, or it ended some other way.
 * - `forced`: the adapter ignored the cancel and was restarted.
 * - `failed`: the control call failed; it may or may not have reached the adapter.
 * - `unknown`: the supervisor restarted before the outcome was recorded.
 */
export type ReminderInterruptOutcome = 'requested' | 'cancelled' | 'ended' | 'forced' | 'failed' | 'unknown';
const INTERRUPT_OUTCOMES = new Set<string>(['requested', 'cancelled', 'ended', 'forced', 'failed', 'unknown']);

/** The turn an urgent event asked to stop: typed provenance only, never a body. */
export interface ReminderInterruptTarget {
  source: string;
  sessionId?: string;
}

export interface ReminderEventInterrupt {
  requestedAt: string;
  target: ReminderInterruptTarget;
  outcome: ReminderInterruptOutcome;
  settledAt?: string;
  reason?: string;
}

export interface ReminderEvent {
  id: string;
  reminderId: string;
  revision: number;
  state: ReminderEventState;
  createdAt: string;
  attempts: number;
  retryAt?: string;
  promptId?: string;
  admittedAt?: string;
  dispatchedAt?: string;
  closedAt?: string;
  reason?: string;
  /** The one interruption an urgent event may have requested. */
  interrupt?: ReminderEventInterrupt;
  /** Why an urgent event last found the busy turn not interruptible (diagnostic). */
  interruptDeferred?: string;
}

interface StoreFile {
  version: 1;
  owner: ReminderOwner;
  reminders: Record<string, ReminderRecord>;
  events: Record<string, ReminderEvent>;
}

export class ReminderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReminderError';
  }
}

export interface ReminderWriter {
  (path: string, contents: string): void;
}

const durableWrite: ReminderWriter = (path, contents) =>
  replaceFileAtomically(path, contents, 0o600, {}, { durable: true });

const OPEN_EVENT_STATES = new Set<ReminderEventState>(['pending', 'admitting', 'dispatched', 'uncertain']);
const iso = (ms: number) => new Date(ms).toISOString();

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(raw: unknown, field: string, max: number, required: boolean): string {
  if (raw === undefined || raw === null) {
    if (required) throw new ReminderError('invalid_request', `${field} is required`);
    return '';
  }
  if (typeof raw !== 'string') throw new ReminderError('invalid_request', `${field} must be text`);
  const value = raw.replace(/\r\n?/g, '\n').normalize('NFC');
  if (required && !value.trim()) throw new ReminderError('invalid_request', `${field} must not be blank`);
  if (value.includes('\0')) throw new ReminderError('invalid_request', `${field} must not contain NUL`);
  if (Array.from(value).length > max) throw new ReminderError('invalid_request', `${field} exceeds ${max} characters`);
  return value;
}

function lateWindow(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LATE_WINDOW_SECONDS;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)
      || raw < MIN_LATE_WINDOW_SECONDS || raw > MAX_LATE_WINDOW_SECONDS)
    throw new ReminderError('invalid_request',
      `late_window_seconds must be a whole number from ${MIN_LATE_WINDOW_SECONDS} to ${MAX_LATE_WINDOW_SECONDS}`);
  return raw;
}

function revisionOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1)
    throw new ReminderError('invalid_request', 'expected_revision must be the current positive revision');
  return raw;
}

export interface ScheduleInput {
  title?: unknown;
  note?: unknown;
  local_time?: unknown;
  time_zone?: unknown;
  fold?: unknown;
  late_window_seconds?: unknown;
  interrupt?: unknown;
}

function urgency(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new ReminderError('invalid_request', 'interrupt must be true or false');
  return raw;
}

export interface ReminderView {
  id: string;
  /** The caller's own idempotency key, so a retried or interrupted run can find its work. */
  request_key: string;
  revision: number;
  state: ReminderState;
  title: string;
  note: string;
  local_time: string;
  time_zone: string;
  fold?: 0 | 1;
  due_at: string;
  late_window_seconds: number;
  /** True only when this reminder may interrupt a busy turn when due. */
  interrupt: boolean;
  expires_at: string;
  created_at: string;
  updated_at: string;
  closed_reason?: string;
  /** The current revision's wake, if one exists. */
  event?: { id: string; state: ReminderEventState; revision: number; interrupt_state?: ReminderInterruptOutcome };
}

export class ReminderStore {
  readonly path: string;
  private state: StoreFile;

  /**
   * Load or create the store for exactly this owner (see `ReminderOwner`). A
   * store written for anyone else is never adopted: it is moved aside and
   * nothing in it is delivered, so a same-named successor or a replaced
   * identity cannot inherit a predecessor's wakes.
   */
  constructor(
    stateDir: string, readonly owner: ReminderOwner, private readonly now: () => number,
    private readonly log: (line: string) => void = () => {},
    private readonly write: ReminderWriter = durableWrite,
  ) {
    this.path = join(stateDir, SELF_REMINDERS_FILE);
    let restored: StoreFile | undefined;
    if (existsSync(this.path)) {
      let reason: string | undefined;
      try {
        if (!privateFile(this.path)) throw new Error('insecure');
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile;
        if (!validFile(parsed)) reason = 'corrupt';
        else if (!sameOwner(parsed.owner, owner)) reason = 'foreign-owner';
        else {
          // A permanent agent's runtime is re-provisioned on every orderly
          // start; record the current one, keep the reminders.
          parsed.owner = { ...owner };
          restored = parsed;
        }
      } catch { reason = 'corrupt'; }
      if (!restored) {
        const aside = `${this.path}.${reason}-${now()}`;
        renameSync(this.path, aside);
        chmodSync(aside, 0o600);
        this.log(`[${owner.role}] self-reminder store ${reason}; moved aside, nothing in it will be delivered`);
      }
    }
    this.state = restored ?? { version: 1, owner: { ...owner }, reminders: {}, events: {} };
    if (restored) this.recover();
    this.persist();
  }

  /** Restart recovery. Never re-admits anything that may have reached the model. */
  private recover(): void {
    const at = iso(this.now());
    for (const event of Object.values(this.state.events)) {
      // An interruption requested by the previous process has an unknown end.
      // Keep the mark (so it is never requested again) and say so.
      if (event.interrupt?.outcome === 'requested')
        event.interrupt = { ...event.interrupt, outcome: 'unknown', settledAt: at, reason: 'restarted_before_outcome' };
      if (event.state === 'admitting') {
        // The release guard never ran, so the model never saw it.
        event.state = 'pending';
        delete event.promptId;
        delete event.retryAt;
      } else if (event.state === 'dispatched') {
        event.state = 'uncertain';
        event.reason = 'restarted_after_dispatch';
        event.closedAt = at;
      }
    }
  }

  private persist(): void {
    this.write(this.path, JSON.stringify(this.state, null, 2) + '\n');
    chmodSync(this.path, 0o600);
  }

  /**
   * Apply a mutation and persist it as one step. If the write fails the
   * in-memory state is restored, so memory never claims what disk does not.
   */
  private commit<T>(mutate: (state: StoreFile) => T): T {
    const before = structuredClone(this.state);
    try {
      const result = mutate(this.state);
      this.persist();
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  private reminder(id: unknown): ReminderRecord {
    if (typeof id !== 'string' || !Object.hasOwn(this.state.reminders, id))
      throw new ReminderError('not_found', 'no such reminder for this agent');
    return this.state.reminders[id]!;
  }

  private event(id: unknown): ReminderEvent {
    if (typeof id !== 'string' || !Object.hasOwn(this.state.events, id))
      throw new ReminderError('not_found', 'no such reminder event for this agent');
    return this.state.events[id]!;
  }

  private schedule(input: ScheduleInput, previous?: ReminderRecord) {
    const title = input.title === undefined && previous ? previous.title : text(input.title, 'title', MAX_TITLE_CHARS, true);
    const note = input.note === undefined && previous ? previous.note : text(input.note, 'note', MAX_NOTE_CHARS, false);
    const retime = !previous || input.local_time !== undefined || input.time_zone !== undefined || input.fold !== undefined;
    const late = input.late_window_seconds === undefined && previous
      ? previous.lateWindowSeconds : lateWindow(input.late_window_seconds);
    const interrupt = input.interrupt === undefined && previous
      ? previous.interrupt === true : urgency(input.interrupt);
    let when: { localTime: string; timeZone: string; fold?: 0 | 1; dueAt: number };
    if (retime) {
      try {
        when = resolveSchedule(
          input.local_time ?? previous?.localTime, input.time_zone ?? previous?.timeZone,
          input.fold === undefined ? (input.local_time === undefined && input.time_zone === undefined ? previous?.fold : undefined) : input.fold);
      } catch (error) {
        if (error instanceof ReminderScheduleError) throw new ReminderError(error.code, error.message);
        throw error;
      }
      const now = this.now();
      if (when.dueAt <= now) throw new ReminderError('not_in_future', 'the reminder time must be in the future');
      if (when.dueAt - now > MAX_HORIZON_MS) throw new ReminderError('too_far', 'the reminder time must be within five years');
    } else {
      when = { localTime: previous.localTime, timeZone: previous.timeZone, fold: previous.fold, dueAt: Date.parse(previous.dueAt) };
    }
    return { title, note, ...when, late, interrupt };
  }

  private openCount(): number {
    return Object.values(this.state.reminders).filter(item => item.state === 'active' || item.state === 'delivered').length;
  }

  create(requestKey: unknown, input: ScheduleInput): { reminder: ReminderView; created: boolean } {
    const key = text(requestKey, 'request_key', MAX_REQUEST_KEY_CHARS, true);
    const requestDigest = digest({
      title: input.title ?? null, note: input.note ?? null, local_time: input.local_time ?? null,
      time_zone: input.time_zone ?? null, fold: input.fold ?? null,
      late_window_seconds: input.late_window_seconds ?? null,
      // Only an explicit urgent request changes the digest, so a retry of a
      // call made before `interrupt` existed (or with it false) still matches.
      ...(input.interrupt === true ? { interrupt: true } : {}),
    });
    const existing = Object.values(this.state.reminders).find(item => item.requestKey === key);
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new ReminderError('request_key_conflict', 'request_key was already used with different input');
      return { reminder: this.view(existing), created: false };
    }
    if (this.openCount() >= MAX_OPEN_REMINDERS)
      throw new ReminderError('limit_reached', `at most ${MAX_OPEN_REMINDERS} open reminders per agent`);
    const values = this.schedule(input);
    return this.commit(state => {
      const at = iso(this.now());
      const record: ReminderRecord = {
        id: `rem_${randomUUID()}`, requestKey: key, requestDigest, revision: 1, state: 'active',
        title: values.title, note: values.note, localTime: values.localTime, timeZone: values.timeZone,
        ...(values.fold === undefined ? {} : { fold: values.fold }),
        dueAt: iso(values.dueAt), lateWindowSeconds: values.late,
        expiresAt: iso(values.dueAt + values.late * 1000), createdAt: at, updatedAt: at,
        ...(values.interrupt ? { interrupt: true as const } : {}),
      };
      state.reminders[record.id] = record;
      this.prune(state);
      return { reminder: this.view(record), created: true };
    });
  }

  update(id: unknown, expectedRevision: unknown, input: ScheduleInput): ReminderView {
    const record = this.reminder(id);
    const revision = revisionOf(expectedRevision);
    if (record.revision !== revision)
      throw new ReminderError('stale_revision', `reminder is at revision ${record.revision}`);
    if (record.state !== 'active' && record.state !== 'delivered')
      throw new ReminderError('closed', `reminder is ${record.state}`);
    if (Object.values(input).every(value => value === undefined))
      throw new ReminderError('invalid_request', 'nothing to update');
    const values = this.schedule(input, record);
    return this.commit(state => {
      const target = state.reminders[record.id]!;
      const at = iso(this.now());
      this.supersedeEvents(state, target.id, 'superseded_by_update', at);
      Object.assign(target, {
        revision: target.revision + 1, state: 'active' as const,
        title: values.title, note: values.note, localTime: values.localTime, timeZone: values.timeZone,
        dueAt: iso(values.dueAt), lateWindowSeconds: values.late,
        expiresAt: iso(values.dueAt + values.late * 1000), updatedAt: at,
      });
      if (values.fold === undefined) delete target.fold; else target.fold = values.fold;
      if (values.interrupt) target.interrupt = true; else delete target.interrupt;
      delete target.closedReason;
      return this.view(target);
    });
  }

  cancel(id: unknown, expectedRevision: unknown): ReminderView {
    const record = this.reminder(id);
    const revision = revisionOf(expectedRevision);
    if (record.revision !== revision)
      throw new ReminderError('stale_revision', `reminder is at revision ${record.revision}`);
    if (record.state !== 'active' && record.state !== 'delivered')
      throw new ReminderError('closed', `reminder is ${record.state}`);
    return this.commit(state => {
      const target = state.reminders[record.id]!;
      const at = iso(this.now());
      this.supersedeEvents(state, target.id, 'cancelled', at);
      target.revision++;
      target.state = 'cancelled';
      target.closedReason = 'cancelled';
      target.updatedAt = at;
      this.prune(state);
      return this.view(target);
    });
  }

  list(filter: { state?: unknown; limit?: unknown; after?: unknown } = {}) {
    const scope = filter.state ?? 'open';
    if (!['open', 'closed', 'all'].includes(scope as string))
      throw new ReminderError('invalid_request', "state must be 'open', 'closed' or 'all'");
    const limit = filter.limit ?? 50;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ReminderError('invalid_request', 'limit must be 1..100');
    if (filter.after !== undefined && typeof filter.after !== 'string')
      throw new ReminderError('invalid_request', 'after must be a reminder id from a previous page');
    const open = (item: ReminderRecord) => item.state === 'active' || item.state === 'delivered';
    const rows = Object.values(this.state.reminders)
      .filter(item => scope === 'all' || (scope === 'open') === open(item))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
    const start = filter.after ? rows.findIndex(item => item.id === filter.after) + 1 : 0;
    if (filter.after && start === 0)
      throw new ReminderError('invalid_request', 'after does not name a reminder in this listing');
    const page = rows.slice(start, start + limit);
    const more = start + limit < rows.length;
    return {
      reminders: page.map(item => this.view(item)),
      more, ...(more ? { after: page.at(-1)!.id } : {}),
      uncertain_events: Object.values(this.state.events).filter(event => event.state === 'uncertain').length,
    };
  }

  inspect(eventId: unknown) {
    const event = this.event(eventId);
    const record = this.state.reminders[event.reminderId];
    const now = this.now();
    const current = Boolean(record && record.revision === event.revision);
    const eligible = Boolean(record && current && (event.state === 'dispatched' || event.state === 'uncertain')
      && (record.state === 'delivered' || record.state === 'active'));
    return {
      event: this.eventView(event),
      reminder: record ? this.view(record) : undefined,
      current, eligible,
      late_by_ms: record ? Math.max(0, now - Date.parse(record.dueAt)) : undefined,
    };
  }

  ack(eventId: unknown, expectedRevision: unknown) {
    const event = this.event(eventId);
    const revision = revisionOf(expectedRevision);
    if (event.revision !== revision)
      throw new ReminderError('stale_revision', `event belongs to revision ${event.revision}`);
    if (event.state === 'acknowledged') return { event: this.eventView(event), acknowledged: true, duplicate: true };
    if (event.state !== 'dispatched' && event.state !== 'uncertain')
      throw new ReminderError('not_acknowledgeable', `event is ${event.state}`);
    const record = this.state.reminders[event.reminderId];
    if (!record || record.revision !== event.revision)
      throw new ReminderError('stale_revision', 'the reminder changed after this wake; this event is no longer current');
    return this.commit(state => {
      const target = state.events[event.id]!;
      const at = iso(this.now());
      target.state = 'acknowledged';
      target.closedAt = at;
      const owner = state.reminders[target.reminderId]!;
      owner.state = 'acknowledged';
      owner.closedReason = 'acknowledged';
      owner.updatedAt = at;
      this.prune(state);
      return { event: this.eventView(target), acknowledged: true, duplicate: false };
    });
  }

  // ── dispatch side (runner only) ────────────────────────────────────────────

  /**
   * Earliest instant the dispatcher has work, or undefined when idle.
   * `live` names admissions still owned by a queued prompt in this process:
   * their own completion re-arms the dispatcher, so they are not work here.
   */
  nextWorkAt(live: ReadonlySet<string> = new Set()): number | undefined {
    let next: number | undefined;
    const consider = (value: number) => { next = next === undefined ? value : Math.min(next, value); };
    for (const record of Object.values(this.state.reminders)) {
      if (record.state !== 'active') continue;
      const open = this.openEvent(record);
      if (open && live.has(open.id)) continue;
      if (!open) consider(Date.parse(record.dueAt));
      else if (open.state === 'pending') consider(open.retryAt ? Date.parse(open.retryAt) : Date.parse(record.dueAt));
      else if (open.state === 'admitting') consider(Date.parse(record.dueAt));
      if (!open || open.state === 'pending' || open.state === 'admitting') consider(Date.parse(record.expiresAt));
    }
    return next;
  }

  private openEvent(record: ReminderRecord): ReminderEvent | undefined {
    return Object.values(this.state.events).find(event => event.reminderId === record.id
      && event.revision === record.revision && OPEN_EVENT_STATES.has(event.state));
  }

  /**
   * Expire what is past its window and create a pending event for each due
   * reminder. Returns the events ready to admit now, earliest due first.
   */
  sweep(live: ReadonlySet<string> = new Set()): ReminderEvent[] {
    const now = this.now();
    let changed = false;
    const ready: ReminderEvent[] = [];
    const next = structuredClone(this.state);
    for (const record of Object.values(next.reminders).sort((a, b) => a.dueAt.localeCompare(b.dueAt))) {
      if (record.state !== 'active') continue;
      const open = Object.values(next.events).find(event => event.reminderId === record.id
        && event.revision === record.revision && OPEN_EVENT_STATES.has(event.state));
      if (open && live.has(open.id)) continue;
      if (open?.state === 'admitting') {
        // No queued prompt in this process owns it (a write that would have
        // returned it to pending failed). The release guard never committed
        // a dispatch, so it is still undispatched: the same move as restart
        // recovery, made here so it can neither strand nor spin.
        open.state = 'pending';
        delete open.promptId;
        delete open.retryAt;
        changed = true;
      }
      if (now >= Date.parse(record.expiresAt) && (!open || open.state === 'pending')) {
        if (open) { open.state = 'expired'; open.closedAt = iso(now); }
        record.state = 'expired';
        record.closedReason = 'late_window_elapsed';
        record.updatedAt = iso(now);
        changed = true;
        continue;
      }
      if (now < Date.parse(record.dueAt)) continue;
      if (!open) {
        const event: ReminderEvent = {
          id: `rev_${randomUUID()}`, reminderId: record.id, revision: record.revision,
          state: 'pending', createdAt: iso(now), attempts: 0,
        };
        next.events[event.id] = event;
        changed = true;
        ready.push(event);
      } else if (open.state === 'pending' && (!open.retryAt || Date.parse(open.retryAt) <= now)) {
        ready.push(open);
      }
    }
    if (changed) {
      this.prune(next);
      const before = this.state;
      this.state = next;
      try { this.persist(); } catch (error) { this.state = before; throw error; }
    }
    return ready.map(event => structuredClone(this.state.events[event.id]!));
  }

  /** Durable claim made before the prompt is queued. False: do not queue. */
  markAdmitting(eventId: string): boolean {
    const event = this.state.events[eventId];
    const record = event && this.state.reminders[event.reminderId];
    const now = this.now();
    if (!event || event.state !== 'pending' || !record || record.state !== 'active'
        || record.revision !== event.revision || now < Date.parse(record.dueAt)
        || now >= Date.parse(record.expiresAt)) return false;
    return this.commit(() => {
      event.state = 'admitting';
      event.attempts++;
      event.admittedAt = iso(this.now());
      delete event.retryAt;
      return true;
    });
  }

  /** Record the session's queue receipt; never moves an event backwards. */
  recordReceipt(eventId: string, promptId: string): void {
    const event = this.state.events[eventId];
    if (!event || (event.state !== 'admitting' && event.state !== 'dispatched') || event.promptId) return;
    this.commit(() => { event.promptId = promptId; });
  }

  /**
   * The release guard: called synchronously by the session at the moment the
   * prompt would be handed to the model. It returns true only after
   * `dispatched` is durably on disk; any doubt refuses the dispatch.
   */
  claimDispatch(eventId: string, stopping: boolean): { dispatch: boolean; reason?: string } {
    const event = this.state.events[eventId];
    const record = event && this.state.reminders[event.reminderId];
    if (!event || event.state !== 'admitting') return { dispatch: false, reason: 'event_not_admitting' };
    if (stopping) return { dispatch: false, reason: 'stopping' };
    const at = this.now();
    const close = (state: ReminderEventState, reason: string) => {
      try {
        this.commit(() => { event.state = state; event.reason = reason; event.closedAt = iso(at); });
      } catch { /* left admitting: recovery returns it to pending, still undispatched */ }
      return { dispatch: false, reason };
    };
    if (!record || record.revision !== event.revision || record.state !== 'active')
      return close('invalidated', 'stale_revision');
    // The wall clock can step back after admission. Not due yet means not yet:
    // the event stays undispatched and is admitted again once it is due.
    if (at < Date.parse(record.dueAt)) return { dispatch: false, reason: 'not_due' };
    if (at >= Date.parse(record.expiresAt)) {
      try {
        this.commit(() => {
          event.state = 'expired'; event.reason = 'late_window_elapsed'; event.closedAt = iso(at);
          record.state = 'expired'; record.closedReason = 'late_window_elapsed'; record.updatedAt = iso(at);
        });
      } catch { /* undispatched either way */ }
      return { dispatch: false, reason: 'expired' };
    }
    try {
      this.commit(() => {
        event.state = 'dispatched';
        event.dispatchedAt = iso(at);
        record.state = 'delivered';
        record.updatedAt = iso(at);
      });
    } catch {
      return { dispatch: false, reason: 'dispatch_commit_failed' };
    }
    return { dispatch: true };
  }

  /**
   * Whether this undispatched event may still ask to interrupt a busy turn: its
   * reminder is urgent and current, and no interruption was ever requested
   * for it (in this process or before a restart).
   */
  mayInterrupt(eventId: string): boolean {
    const event = this.state.events[eventId];
    const record = event && this.state.reminders[event.reminderId];
    return Boolean(event && record && record.interrupt === true && !event.interrupt
      && (event.state === 'pending' || event.state === 'admitting')
      && record.state === 'active' && record.revision === event.revision);
  }

  /**
   * Durable mark made BEFORE the session is asked to cancel. False: do not
   * interrupt. Once written it is never cleared, which is what bounds every
   * urgent event to one interruption.
   */
  markInterruptRequested(eventId: string, target: ReminderInterruptTarget): boolean {
    if (!this.mayInterrupt(eventId) || this.state.events[eventId]!.state !== 'admitting') return false;
    const event = this.state.events[eventId]!;
    try {
      this.commit(() => {
        event.interrupt = {
          requestedAt: iso(this.now()), outcome: 'requested',
          target: { source: target.source, ...(target.sessionId ? { sessionId: target.sessionId } : {}) },
        };
        delete event.interruptDeferred;
      });
    } catch { return false; }
    return true;
  }

  /**
   * Record why an urgent event did not interrupt this time. Written only when
   * the reason changes, so a long busy stretch costs one write, not one per poll.
   */
  recordInterruptDeferred(eventId: string, reason: string): void {
    const event = this.state.events[eventId];
    if (!event || event.interrupt || event.interruptDeferred === reason) return;
    try { this.commit(() => { event.interruptDeferred = reason; }); }
    catch { /* diagnostic only */ }
  }

  /** How the requested interruption ended. Diagnostic; never moves the event. */
  recordInterruptOutcome(eventId: string, outcome: Exclude<ReminderInterruptOutcome, 'requested'>, reason?: string): void {
    const event = this.state.events[eventId];
    if (!event?.interrupt || event.interrupt.outcome !== 'requested') return;
    try {
      this.commit(() => {
        event.interrupt = {
          ...event.interrupt!, outcome, settledAt: iso(this.now()), ...(reason ? { reason } : {}),
        };
      });
    } catch { /* stays `requested`: still never re-requested, still not delivered */ }
  }

  /** Still the current, undispatched claim this process made? Re-checked after every await. */
  stillAdmitting(eventId: string): boolean {
    const event = this.state.events[eventId];
    const record = event && this.state.reminders[event.reminderId];
    return Boolean(event && record && event.state === 'admitting' && record.state === 'active'
      && record.revision === event.revision);
  }

  /**
   * An admission that ended without the release guard dispatching it (queue
   * refused, session died, release refused while stopping) goes back to
   * pending. Anything already past `admitting` is left exactly as it is.
   */
  releaseUndispatched(eventId: string, retryAt: number): void {
    const event = this.state.events[eventId];
    if (!event || event.state !== 'admitting') return;
    try {
      this.commit(() => {
        event.state = 'pending';
        event.retryAt = iso(retryAt);
        delete event.promptId;
      });
    } catch { /* stays admitting; restart recovery makes the same move */ }
  }

  eventSummary(eventId: string): { event: ReminderEvent; reminder: ReminderRecord } | undefined {
    const event = this.state.events[eventId];
    const reminder = event && this.state.reminders[event.reminderId];
    return event && reminder ? structuredClone({ event, reminder }) : undefined;
  }

  private supersedeEvents(state: StoreFile, reminderId: string, reason: string, at: string): void {
    for (const event of Object.values(state.events))
      if (event.reminderId === reminderId && OPEN_EVENT_STATES.has(event.state)) {
        event.state = 'invalidated';
        event.reason = reason;
        event.closedAt = at;
      }
  }

  /** Bound retained history; open reminders and their events are never dropped. */
  private prune(state: StoreFile): void {
    const closed = Object.values(state.reminders)
      .filter(item => item.state !== 'active' && item.state !== 'delivered'
        && !Object.values(state.events).some(event => event.reminderId === item.id && event.state === 'uncertain'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const item of closed.slice(MAX_RETAINED_CLOSED)) {
      delete state.reminders[item.id];
      for (const [id, event] of Object.entries(state.events))
        if (event.reminderId === item.id) delete state.events[id];
    }
  }

  private view(record: ReminderRecord): ReminderView {
    const event = Object.values(this.state.events)
      .filter(item => item.reminderId === record.id && item.revision === record.revision)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      id: record.id, request_key: record.requestKey, revision: record.revision, state: record.state,
      title: record.title, note: record.note,
      local_time: record.localTime, time_zone: record.timeZone,
      ...(record.fold === undefined ? {} : { fold: record.fold }),
      due_at: record.dueAt, late_window_seconds: record.lateWindowSeconds, interrupt: record.interrupt === true,
      expires_at: record.expiresAt,
      created_at: record.createdAt, updated_at: record.updatedAt,
      ...(record.closedReason ? { closed_reason: record.closedReason } : {}),
      ...(event ? { event: {
        id: event.id, state: event.state, revision: event.revision,
        ...(event.interrupt ? { interrupt_state: event.interrupt.outcome } : {}),
      } } : {}),
    };
  }

  private eventView(event: ReminderEvent) {
    return {
      id: event.id, reminder_id: event.reminderId, revision: event.revision, state: event.state,
      created_at: event.createdAt,
      ...(event.dispatchedAt ? { dispatched_at: event.dispatchedAt } : {}),
      ...(event.closedAt ? { closed_at: event.closedAt } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.interruptDeferred ? { interrupt_deferred: event.interruptDeferred } : {}),
      ...(event.interrupt ? { interrupt: {
        state: event.interrupt.outcome, requested_at: event.interrupt.requestedAt,
        target_source: event.interrupt.target.source,
        ...(event.interrupt.settledAt ? { settled_at: event.interrupt.settledAt } : {}),
        ...(event.interrupt.reason ? { reason: event.interrupt.reason } : {}),
      } } : {}),
    };
  }
}

function sameOwner(a: ReminderOwner, b: ReminderOwner): boolean {
  if (a.role !== b.role || a.lifetime !== b.lifetime || a.cid.toUpperCase() !== b.cid.toUpperCase()) return false;
  return a.lifetime === 'permanent' || (a.instance === b.instance && a.action === b.action);
}

function privateFile(path: string): boolean {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && (uid === undefined || stat.uid === uid);
}

function validFile(value: unknown): value is StoreFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as StoreFile;
  const owner = file.owner;
  if (file.version !== 1 || !owner || typeof owner !== 'object'
      || !['role', 'instance', 'cid', 'action'].every(key => typeof (owner as unknown as Record<string, unknown>)[key] === 'string')
      || (owner.lifetime !== 'permanent' && owner.lifetime !== 'temporary')
      || !file.reminders || typeof file.reminders !== 'object' || !file.events || typeof file.events !== 'object')
    return false;
  const reminderStates = new Set(['active', 'delivered', 'acknowledged', 'cancelled', 'expired']);
  const eventStates = new Set(['pending', 'admitting', 'dispatched', 'uncertain', 'acknowledged', 'invalidated', 'expired']);
  return Object.entries(file.reminders).every(([id, item]) => item && item.id === id
      && Number.isSafeInteger(item.revision) && item.revision >= 1 && reminderStates.has(item.state)
      && typeof item.requestKey === 'string' && typeof item.title === 'string' && typeof item.note === 'string'
      && Number.isFinite(Date.parse(item.dueAt)) && Number.isFinite(Date.parse(item.expiresAt))
      && (item.interrupt === undefined || item.interrupt === true))
    && Object.entries(file.events).every(([id, item]) => item && item.id === id
      && typeof item.reminderId === 'string' && Number.isSafeInteger(item.revision) && eventStates.has(item.state)
      && Number.isSafeInteger(item.attempts)
      && (item.interrupt === undefined || (typeof item.interrupt === 'object' && item.interrupt !== null
        && typeof item.interrupt.requestedAt === 'string' && typeof item.interrupt.target?.source === 'string'
        && INTERRUPT_OUTCOMES.has(item.interrupt.outcome))));
}

/** Remove a retired agent's reminder store and any quarantined copies. */
export function removeReminderState(stateDir: string): void {
  rmSync(join(stateDir, SELF_REMINDERS_FILE), { force: true });
  try {
    for (const name of readdirSync(stateDir))
      if (name.startsWith(`${SELF_REMINDERS_FILE}.`) || name.startsWith(`.${SELF_REMINDERS_FILE}.`)) rmSync(join(stateDir, name), { force: true });
  } catch { /* directory already gone */ }
}

