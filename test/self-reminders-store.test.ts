import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { replaceFileAtomically } from '../src/atomic-file.js';
import {
  ReminderError, ReminderStore, SELF_REMINDERS_FILE, removeReminderState, type ReminderOwner,
} from '../src/reminders/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'rem-store-')); dirs.push(dir); return dir; };

const OWNER: ReminderOwner = { role: 'Dev', lifetime: 'temporary', instance: 'inst-1', cid: 'A'.repeat(64), action: 'act-1' };
const T0 = Date.parse('2027-01-20T12:00:00Z');

function harness(dir = scratch(), owner = OWNER) {
  const clock = { now: T0 };
  const logs: string[] = [];
  const store = new ReminderStore(dir, owner, () => clock.now, line => logs.push(line));
  return { dir, clock, logs, store };
}

const create = (store: ReminderStore, key = 'k1', overrides: Record<string, unknown> = {}) =>
  store.create(key, { title: 'Check CI', note: 'private note', local_time: '2027-01-20T16:00', time_zone: 'UTC', ...overrides });

const errorCode = (run: () => unknown): string => {
  try { run(); } catch (error) { if (error instanceof ReminderError) return error.code; throw error; }
  return 'ok';
};

/** Drive one reminder to the wake: due, admitted, dispatched by the release guard. */
function dispatch(h: ReturnType<typeof harness>, id: string) {
  h.clock.now = Date.parse(h.store.list({ state: 'all' }).reminders.find(item => item.id === id)!.due_at);
  const [event] = h.store.sweep();
  expect(h.store.markAdmitting(event!.id)).toBe(true);
  expect(h.store.claimDispatch(event!.id, false)).toEqual({ dispatch: true });
  return event!;
}

describe('ReminderStore', () => {
  it('creates idempotently by request key and refuses conflicting reuse', () => {
    const h = harness();
    const first = create(h.store);
    expect(first.created).toBe(true);
    expect(first.reminder).toMatchObject({
      request_key: 'k1', revision: 1, state: 'active', title: 'Check CI', note: 'private note',
      local_time: '2027-01-20T16:00:00', time_zone: 'UTC', due_at: '2027-01-20T16:00:00.000Z',
      late_window_seconds: 3600, expires_at: '2027-01-20T17:00:00.000Z',
    });
    const again = create(h.store);
    expect(again).toEqual({ reminder: first.reminder, created: false });
    expect(errorCode(() => create(h.store, 'k1', { title: 'Different' }))).toBe('request_key_conflict');
    expect(h.store.list().reminders).toHaveLength(1);
  });

  it('persists privately and survives a restart of the same runtime instance', () => {
    const h = harness();
    const { reminder } = create(h.store);
    const path = join(h.dir, SELF_REMINDERS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new ReminderStore(h.dir, OWNER, () => h.clock.now);
    expect(reopened.list().reminders.map(item => item.id)).toEqual([reminder.id]);
  });

  it('never adopts a store written for another instance, identity or role', () => {
    for (const foreign of [
      { ...OWNER, instance: 'inst-2' }, { ...OWNER, cid: 'B'.repeat(64) },
      { ...OWNER, action: 'act-2' }, { ...OWNER, role: 'Other' }, { ...OWNER, lifetime: 'permanent' as const },
    ]) {
      const h = harness();
      create(h.store);
      const successor = harness(h.dir, foreign);
      expect(successor.store.list({ state: 'all' }).reminders).toEqual([]);
      expect(successor.store.sweep()).toEqual([]);
      expect(successor.logs.join('\n')).toMatch(/foreign-owner; moved aside/);
      expect(readdirSync(h.dir).some(name => name.startsWith(`${SELF_REMINDERS_FILE}.foreign-owner-`))).toBe(true);
    }
  });

  it('keeps a permanent agent\'s reminders when its runtime is re-provisioned for the same identity', () => {
    const permanent: ReminderOwner = { ...OWNER, lifetime: 'permanent' };
    const h = harness(scratch(), permanent);
    const { reminder } = create(h.store);
    // Orderly stop releases the runtime; the next start has a new instance and action.
    const next = harness(h.dir, { ...permanent, instance: 'inst-2', action: 'act-2' });
    expect(next.store.list().reminders.map(item => item.id)).toEqual([reminder.id]);
    expect(next.logs).toEqual([]);
    // A different identity (replacement) or role is still never adopted.
    expect(harness(h.dir, { ...permanent, instance: 'inst-3', cid: 'B'.repeat(64) }).store.list().reminders).toEqual([]);
  });

  it('sets aside a corrupt or insecure store instead of trusting it', () => {
    const dir = scratch();
    writeFileSync(join(dir, SELF_REMINDERS_FILE), '{not json', { mode: 0o600 });
    expect(harness(dir).logs.join()).toMatch(/corrupt; moved aside/);
    const loose = scratch();
    create(harness(loose).store);
    chmodSync(join(loose, SELF_REMINDERS_FILE), 0o644);
    const reopened = harness(loose);
    expect(reopened.store.list({ state: 'all' }).reminders).toEqual([]);
  });

  it('guards update and cancel with the expected revision, and closes for good', () => {
    const h = harness();
    const { reminder } = create(h.store);
    expect(errorCode(() => h.store.update(reminder.id, 2, { title: 'x' }))).toBe('stale_revision');
    const updated = h.store.update(reminder.id, 1, { local_time: '2027-01-20T18:00' });
    expect(updated).toMatchObject({ revision: 2, due_at: '2027-01-20T18:00:00.000Z', title: 'Check CI' });
    expect(errorCode(() => h.store.cancel(reminder.id, 1))).toBe('stale_revision');
    const cancelled = h.store.cancel(reminder.id, 2);
    expect(cancelled).toMatchObject({ revision: 3, state: 'cancelled' });
    expect(errorCode(() => h.store.update(reminder.id, 3, { title: 'x' }))).toBe('closed');
    expect(errorCode(() => h.store.cancel('rem_unknown', 1))).toBe('not_found');
    h.clock.now = Date.parse('2027-01-20T18:30:00Z');
    expect(h.store.sweep()).toEqual([]);
  });

  it('validates inputs before writing anything', () => {
    const h = harness();
    expect(errorCode(() => create(h.store, 'k', { local_time: '2027-01-20T11:00' }))).toBe('not_in_future');
    expect(errorCode(() => create(h.store, 'k', { local_time: '2033-01-20T11:00' }))).toBe('too_far');
    expect(errorCode(() => create(h.store, 'k', { title: '  ' }))).toBe('invalid_request');
    expect(errorCode(() => create(h.store, 'k', { title: 'a\0b' }))).toBe('invalid_request');
    expect(errorCode(() => create(h.store, 'k', { late_window_seconds: 10 }))).toBe('invalid_request');
    expect(errorCode(() => create(h.store, 'k', { late_window_seconds: 8 * 86400 }))).toBe('invalid_request');
    expect(errorCode(() => create(h.store, 'k', { time_zone: 'Nowhere/Land' }))).toBe('invalid_time_zone');
    expect(errorCode(() => create(h.store, '', {}))).toBe('invalid_request');
    expect(h.store.list({ state: 'all' }).reminders).toEqual([]);
  });

  it('runs the wake lifecycle: due, admitted, dispatched at release, acknowledged once', () => {
    const h = harness();
    const { reminder } = create(h.store);
    h.clock.now = Date.parse('2027-01-20T15:59:59Z');
    expect(h.store.sweep()).toEqual([]);
    const event = dispatch(h, reminder.id);
    expect(h.store.inspect(event.id)).toMatchObject({
      current: true, eligible: true, reminder: { state: 'delivered', note: 'private note' },
      event: { state: 'dispatched' },
    });
    expect(errorCode(() => h.store.ack(event.id, 2))).toBe('stale_revision');
    expect(h.store.ack(event.id, 1)).toMatchObject({ acknowledged: true, duplicate: false });
    expect(h.store.ack(event.id, 1)).toMatchObject({ acknowledged: true, duplicate: true });
    expect(h.store.list().reminders).toEqual([]);
    expect(h.store.list({ state: 'closed' }).reminders[0]).toMatchObject({ state: 'acknowledged' });
    expect(h.store.nextWorkAt()).toBeUndefined();
  });

  it('cannot acknowledge an event that never reached the agent or was superseded', () => {
    const h = harness();
    const { reminder } = create(h.store);
    h.clock.now = Date.parse(reminder.due_at);
    const [pending] = h.store.sweep();
    expect(errorCode(() => h.store.ack(pending!.id, 1))).toBe('not_acknowledgeable');
    expect(h.store.markAdmitting(pending!.id)).toBe(true);
    expect(errorCode(() => h.store.ack(pending!.id, 1))).toBe('not_acknowledgeable');
    expect(h.store.claimDispatch(pending!.id, false).dispatch).toBe(true);
    // Postponing after the wake voids it: the old event can no longer be acked.
    h.store.update(reminder.id, 1, { local_time: '2027-01-20T18:00' });
    expect(h.store.inspect(pending!.id)).toMatchObject({ current: false, eligible: false, event: { state: 'invalidated' } });
    expect(errorCode(() => h.store.ack(pending!.id, 1))).toBe('not_acknowledgeable');
  });

  it('refuses dispatch at release for cancelled, revised, expired, stopping or unwritable', () => {
    const cases: Array<[string, (h: ReturnType<typeof harness>, id: string) => void, string, boolean]> = [
      ['cancel', (h, id) => h.store.cancel(id, 1), 'event_not_admitting', false],
      ['update', (h, id) => h.store.update(id, 1, { title: 'new' }), 'event_not_admitting', false],
      ['expire', h => { h.clock.now += 3601_000; }, 'expired', false],
      ['stopping', () => {}, 'stopping', true],
    ];
    for (const [, mutate, reason, stopping] of cases) {
      const h = harness();
      const { reminder } = create(h.store);
      h.clock.now = Date.parse(reminder.due_at);
      const [event] = h.store.sweep();
      h.store.markAdmitting(event!.id);
      mutate(h, reminder.id);
      expect(h.store.claimDispatch(event!.id, stopping)).toEqual({ dispatch: false, reason });
      expect(h.store.inspect(event!.id).event.state).not.toBe('dispatched');
    }
  });

  it('refuses dispatch when the dispatched record cannot be made durable', () => {
    const dir = scratch();
    let failDir = false;
    const store = new ReminderStore(dir, OWNER, () => T0, () => {}, (path, contents) =>
      replaceFileAtomically(path, contents, 0o600, {
        fsyncDirectory: () => { if (failDir) throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
      }, { durable: true }));
    const { reminder } = store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC' });
    const late = new ReminderStore(dir, OWNER, () => Date.parse(reminder.due_at), () => {}, (path, contents) =>
      replaceFileAtomically(path, contents, 0o600, {
        fsyncDirectory: () => { if (failDir) throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
      }, { durable: true }));
    const [event] = late.sweep();
    expect(late.markAdmitting(event!.id)).toBe(true);
    failDir = true;
    expect(late.claimDispatch(event!.id, false)).toEqual({ dispatch: false, reason: 'dispatch_commit_failed' });
    // Not handed over, so the live dispatcher may still retry it under the same id.
    expect(late.inspect(event!.id).event.state).toBe('admitting');
    // The rename landed but its durability is unknown. Whichever version a crash
    // leaves, recovery is safe: an old `admitting` retries a wake that was never
    // sent, and this `dispatched` is held as uncertain rather than sent again.
    failDir = false;
    const restarted = new ReminderStore(dir, OWNER, () => Date.parse(reminder.due_at));
    expect(restarted.inspect(event!.id).event.state).toBe('uncertain');
    expect(restarted.sweep()).toEqual([]);
  });

  it('keeps the previous file when the dispatched record cannot be written at all', () => {
    const dir = scratch();
    let fail = false;
    const write = (path: string, contents: string) => {
      if (fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      replaceFileAtomically(path, contents, 0o600, {}, { durable: true });
    };
    const clock = { now: T0 };
    const store = new ReminderStore(dir, OWNER, () => clock.now, () => {}, write);
    const { reminder } = store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC' });
    clock.now = Date.parse(reminder.due_at);
    const [event] = store.sweep();
    expect(store.markAdmitting(event!.id)).toBe(true);
    fail = true;
    expect(store.claimDispatch(event!.id, false)).toEqual({ dispatch: false, reason: 'dispatch_commit_failed' });
    expect(store.inspect(event!.id).event.state).toBe('admitting');
    const restarted = new ReminderStore(dir, OWNER, () => clock.now);
    expect(restarted.inspect(event!.id).event.state).toBe('pending');
    expect(restarted.sweep().map(item => item.id)).toEqual([event!.id]);
  });

  it('recovers after a crash: never-released events retry as the same event, dispatched ones are held', () => {
    const h = harness();
    const a = create(h.store, 'a').reminder;
    const b = create(h.store, 'b', { local_time: '2027-01-20T16:05' }).reminder;
    h.clock.now = Date.parse(b.due_at);
    const [ea, eb] = h.store.sweep();
    expect([ea!.reminderId, eb!.reminderId]).toEqual([a.id, b.id]);
    h.store.markAdmitting(ea!.id);                       // crash before the release guard ran
    h.store.markAdmitting(eb!.id);
    h.store.recordReceipt(eb!.id, 'prompt-b');
    expect(h.store.claimDispatch(eb!.id, false).dispatch).toBe(true);  // crash after handoff, before ack

    const restarted = new ReminderStore(h.dir, OWNER, () => h.clock.now);
    expect(restarted.inspect(ea!.id).event.state).toBe('pending');
    expect(restarted.inspect(eb!.id)).toMatchObject({ event: { state: 'uncertain', reason: 'restarted_after_dispatch' }, eligible: true });
    // Only the never-released event is ready again — same id, no new event.
    expect(restarted.sweep().map(event => event.id)).toEqual([ea!.id]);
    expect(restarted.list().uncertain_events).toBe(1);
    // The held event can still be acknowledged by the agent, but is never re-admitted.
    expect(restarted.markAdmitting(eb!.id)).toBe(false);
    expect(restarted.ack(eb!.id, 1)).toMatchObject({ acknowledged: true });
  });

  it('never dispatches before the due time, even if the wall clock steps back after admission', () => {
    const h = harness();
    const { reminder } = create(h.store);
    h.clock.now = Date.parse(reminder.due_at);
    const [event] = h.store.sweep();
    expect(h.store.markAdmitting(event!.id)).toBe(true);
    h.clock.now -= 60_000;
    expect(h.store.claimDispatch(event!.id, false)).toEqual({ dispatch: false, reason: 'not_due' });
    expect(h.store.list().reminders[0]).toMatchObject({ state: 'active' });
    // The same event returns to pending and is not re-admitted until it is due.
    h.store.releaseUndispatched(event!.id, h.clock.now);
    expect(h.store.sweep()).toEqual([]);
    expect(h.store.markAdmitting(event!.id)).toBe(false);
    h.clock.now = Date.parse(reminder.due_at);
    expect(h.store.sweep().map(item => item.id)).toEqual([event!.id]);
    expect(h.store.markAdmitting(event!.id)).toBe(true);
    expect(h.store.claimDispatch(event!.id, false)).toEqual({ dispatch: true });
  });

  it('never lets a late receipt or completion move an event backwards', () => {
    const h = harness();
    const { reminder } = create(h.store);
    const event = dispatch(h, reminder.id);
    h.store.ack(event.id, 1);                          // agent acks before the receipt is recorded
    h.store.recordReceipt(event.id, 'late-receipt');
    h.store.releaseUndispatched(event.id, h.clock.now);
    expect(h.store.inspect(event.id).event.state).toBe('acknowledged');
    expect(JSON.parse(readFileSync(join(h.dir, SELF_REMINDERS_FILE), 'utf8')).events[event.id].promptId).toBeUndefined();

    const other = create(h.store, 'k2', { local_time: '2027-01-20T17:00' }).reminder;
    h.clock.now = Date.parse(other.due_at);
    const [second] = h.store.sweep();
    h.store.markAdmitting(second!.id);
    h.store.cancel(other.id, 1);                       // cancel before the receipt arrives
    h.store.recordReceipt(second!.id, 'late');
    h.store.releaseUndispatched(second!.id, h.clock.now);
    expect(h.store.inspect(second!.id).event.state).toBe('invalidated');
  });

  it('expires a missed reminder after its late window without creating a wake', () => {
    const h = harness();
    const { reminder } = create(h.store, 'k', { late_window_seconds: 600 });
    h.clock.now = Date.parse(reminder.due_at) + 600_000;
    expect(h.store.sweep()).toEqual([]);
    expect(h.store.list({ state: 'closed' }).reminders[0]).toMatchObject({ state: 'expired', closed_reason: 'late_window_elapsed' });
  });

  it('pages without loss and bounds open and retained reminders', () => {
    const h = harness();
    const at = (i: number) => new Date(Date.parse('2027-01-21T00:00:00Z') + i * 60_000).toISOString().slice(0, 16);
    for (let i = 0; i < 100; i++) create(h.store, `k${i}`, { local_time: at(i) });
    expect(errorCode(() => create(h.store, 'overflow'))).toBe('limit_reached');
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = h.store.list({ limit: 30, ...(after ? { after } : {}) });
      seen.push(...page.reminders.map(item => item.id));
      if (!page.more) break;
      after = page.after;
    }
    expect(new Set(seen).size).toBe(100);
    for (const item of h.store.list({ limit: 100 }).reminders) h.store.cancel(item.id, item.revision);
    for (let i = 0; i < 150; i++) {
      const { reminder } = create(h.store, `more${i}`);
      h.store.cancel(reminder.id, 1);
    }
    expect(h.store.list({ state: 'closed', limit: 100 }).more).toBe(true);
    const all: string[] = [];
    after = undefined;
    for (;;) {
      const page = h.store.list({ state: 'all', limit: 100, ...(after ? { after } : {}) });
      all.push(...page.reminders.map(item => item.id));
      if (!page.more) break;
      after = page.after;
    }
    expect(all.length).toBe(200);
  });

  it('removes a retired agent\'s state, including set-aside copies and temp files', () => {
    const h = harness();
    const { reminder } = create(h.store);
    dispatch(h, reminder.id);
    writeFileSync(join(h.dir, `${SELF_REMINDERS_FILE}.corrupt-1`), 'x');
    writeFileSync(join(h.dir, `.${SELF_REMINDERS_FILE}.1.tmp`), 'x');
    writeFileSync(join(h.dir, 'unrelated'), 'keep');
    removeReminderState(h.dir);
    expect(readdirSync(h.dir)).toEqual(['unrelated']);
    expect(existsSync(join(h.dir, SELF_REMINDERS_FILE))).toBe(false);
  });
});
