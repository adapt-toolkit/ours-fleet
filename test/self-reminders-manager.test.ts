import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { replaceFileAtomically } from '../src/atomic-file.js';
import { ReminderManager, type ReminderAdmitter } from '../src/reminders/manager.js';
import { ReminderStore, type ReminderOwner } from '../src/reminders/store.js';
import { turnResult } from '../src/session/types.js';

const OWNER: ReminderOwner = { role: 'Dev', lifetime: 'temporary', instance: 'i', cid: 'F'.repeat(64), action: 'a' };
const T0 = Date.parse('2027-01-20T12:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'rem-mgr-')); dirs.push(dir);
  const clock = { now: T0 };
  const io = { failWrites: false };
  const store = new ReminderStore(dir, OWNER, () => clock.now, () => {}, (path, contents) => {
    if (io.failWrites) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    replaceFileAtomically(path, contents, 0o600, {}, { durable: true });
  });
  const timers: number[] = [];
  const admissions: string[] = [];
  const finish: Array<() => void> = [];
  const hooks: { afterClaim?: () => void } = {};
  /** An admitter whose prompt settles without ever reaching release (session went offline). */
  const admitter: ReminderAdmitter = {
    async tryReminder(text, _origin, beforeQueue) {
      if (!beforeQueue()) return { state: 'unavailable', error: 'declined', admitted: false };
      admissions.push(text);
      hooks.afterClaim?.();
      const completion = new Promise<ReturnType<typeof turnResult>>(resolve =>
        finish.push(() => resolve(turnResult(false, 'failed', 'offline'))));
      return { state: 'admitted', queued: { promptId: `p${admissions.length}`, queuedBehind: 0, completion } };
    },
  };
  const manager = new ReminderManager('Dev', store, admitter, {
    now: () => clock.now, log: () => {},
    setTimer: (_callback, ms) => { timers.push(ms); return ms; }, clearTimer: () => {},
  });
  return { dir, clock, io, store, timers, admissions, finish, hooks, manager };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('ReminderManager under storage faults', () => {
  it('neither strands nor spins on an admission whose release could not be recorded', async () => {
    const w = world();
    const { reminder } = w.store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC', late_window_seconds: 600 });
    w.manager.start();
    w.clock.now = Date.parse(reminder.due_at);
    // Admit, then let the completion's "back to pending" write fail.
    await w.manager.poll();
    expect(w.admissions).toHaveLength(1);
    w.io.failWrites = true;
    w.finish.shift()!();                                // the turn settles while writes fail
    await settle();
    expect(w.store.inspect(w.store.list().reminders[0]!.event!.id).event.state).toBe('admitting');

    // While storage is down, repeated polls back off instead of re-arming at 0ms.
    w.timers.length = 0;
    for (let i = 0; i < 6; i++) await w.manager.poll();
    expect(w.timers.filter(ms => ms === 0).length).toBeLessThanOrEqual(1);
    expect(w.timers.slice(-3).every(ms => ms >= 1_000)).toBe(true);

    // Storage recovers: the stranded event is recovered as undispatched and
    // retried under the same id while still inside its window.
    w.io.failWrites = false;
    const eventId = w.store.list().reminders[0]!.event!.id;
    await w.manager.poll();
    expect(w.admissions).toHaveLength(2);
    expect(w.admissions[1]).toContain(`event_id: ${eventId}`);
    w.finish.shift()!();
    await settle();

    // Past the window it expires instead of spinning on a past expiry.
    w.clock.now = Date.parse(reminder.expires_at) + 1;
    w.timers.length = 0;
    await w.manager.poll();
    await w.manager.poll();
    expect(w.store.list({ state: 'closed' }).reminders[0]).toMatchObject({ state: 'expired' });
    expect(w.timers).toEqual([]);                       // nothing open: no timer at all
  });

  it('keeps ownership of an admission whose receipt could not be recorded', async () => {
    const w = world();
    const { reminder } = w.store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC', late_window_seconds: 600 });
    w.manager.start();
    w.clock.now = Date.parse(reminder.due_at);
    w.hooks.afterClaim = () => { w.io.failWrites = true; };   // storage fails right after queue acceptance
    await w.manager.poll();
    expect(w.admissions).toHaveLength(1);
    w.hooks.afterClaim = undefined;
    // The never-released prompt settles (rejecting, even) while storage is still down.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      w.finish.shift()!();
      await settle();
    } finally { process.off('unhandledRejection', onUnhandled); }
    expect(unhandled).toEqual([]);
    w.io.failWrites = false;
    // Ownership was released: the event is recoverable, then expires on time.
    w.clock.now = Date.parse(reminder.expires_at) + 1;
    await w.manager.poll();
    expect(w.store.list({ state: 'closed' }).reminders[0]).toMatchObject({ state: 'expired' });
    expect(w.admissions).toHaveLength(1);
  });

  it('does not touch an admission still owned by a queued prompt', async () => {
    const w = world();
    const { reminder } = w.store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC' });
    w.clock.now = Date.parse(reminder.due_at);
    const [event] = w.store.sweep();
    w.store.markAdmitting(event!.id);
    expect(w.store.sweep(new Set([event!.id]))).toEqual([]);
    expect(w.store.inspect(event!.id).event.state).toBe('admitting');
    expect(w.store.nextWorkAt(new Set([event!.id]))).toBeUndefined();
    // Without a live owner it is recovered as undispatched and ready again.
    expect(w.store.sweep().map(item => item.id)).toEqual([event!.id]);
  });
});

describe('ReminderManager timer discipline', () => {
  it('backs off when overdue work cannot be moved, and resets on progress', async () => {
    let overdue = true;
    const timers: number[] = [];
    const clock = { now: T0 };
    const store = {
      sweep: () => [],
      nextWorkAt: () => overdue ? clock.now - 1 : clock.now + 30_000,
    } as unknown as ReminderStore;
    const manager = new ReminderManager('Dev', store, {} as ReminderAdmitter, {
      now: () => clock.now, log: () => {},
      setTimer: (_callback, ms) => { timers.push(ms); return ms; }, clearTimer: () => {},
    });
    manager.start();
    timers.length = 0;
    for (let i = 0; i < 9; i++) await manager.poll();
    expect(timers).toEqual([0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    overdue = false;
    await manager.poll();
    expect(timers.at(-1)).toBe(30_000);
    overdue = true;
    await manager.poll();
    expect(timers.at(-1)).toBe(0);
  });
});

describe('ReminderManager at an idle boundary', () => {
  /** A role that answers `busy` until released; timers are captured and fired by hand. */
  function boundaryWorld() {
    const w = world();
    const role = { busy: true, polls: 0 };
    const live = new Map<number, { ms: number; callback: () => void }>();
    let ids = 0;
    const admitter: ReminderAdmitter = {
      async tryReminder(text, _origin, beforeQueue) {
        role.polls++;
        if (role.busy) return { state: 'busy' };
        if (!beforeQueue()) return { state: 'unavailable', error: 'declined', admitted: false };
        w.admissions.push(text);
        return { state: 'admitted', queued: { promptId: 'p', queuedBehind: 0, completion: new Promise(() => {}) } };
      },
    };
    const manager = new ReminderManager('Dev', w.store, admitter, {
      now: () => w.clock.now, log: () => {},
      setTimer: (callback, ms) => { const id = ++ids; live.set(id, { ms, callback }); return id; },
      clearTimer: id => { live.delete(id as number); },
    });
    const armed = () => [...live.values()].map(timer => timer.ms);
    /** Advance the clock to the armed timer and run its poll. */
    const fire = async () => {
      expect(live.size).toBe(1);
      const [id, timer] = [...live.entries()][0]!;
      live.delete(id);
      w.clock.now += timer.ms;
      timer.callback();
      await settle();
    };
    const { reminder } = w.store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC', late_window_seconds: 600 });
    return { ...w, role, manager, armed, fire, dueAt: Date.parse(reminder.due_at) };
  }

  it('admits at the boundary that ends a busy wait instead of at the next backoff step', async () => {
    const w = boundaryWorld();
    w.manager.start();
    w.clock.now = w.dueAt;
    await w.manager.poll();
    // Busy retries at 0, 2, 6, 14, 30 and 60s: the next would be 90s.
    for (let i = 0; i < 5; i++) await w.fire();
    expect(w.clock.now - w.dueAt).toBe(60_000);
    expect(w.armed()).toEqual([30_000]);
    w.clock.now = w.dueAt + 62_000;                    // the Owner's turn ends here
    w.role.busy = false;
    w.manager.boundary();
    expect(w.armed()).toEqual([0]);
    await w.fire();
    expect(w.admissions).toHaveLength(1);
    expect(w.clock.now - w.dueAt).toBe(62_000);
  });

  it('keeps backing off when the role is still busy at a boundary', async () => {
    const w = boundaryWorld();
    w.manager.start();
    w.clock.now = w.dueAt;
    await w.manager.poll();
    expect(w.armed()).toEqual([2_000]);
    w.manager.boundary();
    await w.fire();
    expect(w.admissions).toEqual([]);
    expect(w.armed()).toEqual([4_000]);
  });

  it('coalesces repeated boundaries into one poll and one admission', async () => {
    const w = boundaryWorld();
    w.manager.start();
    w.clock.now = w.dueAt;
    await w.manager.poll();
    w.role.busy = false;
    const before = w.role.polls;
    for (let i = 0; i < 3; i++) w.manager.boundary();
    expect(w.armed()).toEqual([0]);
    await w.fire();
    expect(w.role.polls - before).toBe(1);
    expect(w.admissions).toHaveLength(1);
    const afterAdmission = w.armed();
    w.manager.boundary();                              // nothing is waiting on busy any more
    expect(w.armed()).toEqual(afterAdmission);
  });

  it('rechecks at once when the boundary arrives while a poll is reading the role as busy', async () => {
    const w = boundaryWorld();
    w.manager.start();
    w.clock.now = w.dueAt;
    await w.manager.poll();
    const polling = w.manager.poll();                 // reads busy...
    w.manager.boundary();                              // ...while the role goes idle
    w.role.busy = false;
    await polling;
    expect(w.armed()).toEqual([0]);
    await w.fire();
    expect(w.admissions).toHaveLength(1);
  });

  it('ignores a boundary when nothing waits on a busy role, and after stop', async () => {
    const w = boundaryWorld();
    w.manager.boundary();                              // not started
    expect(w.armed()).toEqual([]);
    w.manager.start();
    await w.fire();                                    // initial poll: nothing due yet
    const idleTimers = w.armed();
    w.manager.boundary();
    expect(w.armed()).toEqual(idleTimers);
    w.clock.now = w.dueAt;
    await w.manager.poll();
    expect(w.armed()).toEqual([2_000]);
    w.manager.stop();
    w.manager.boundary();
    expect(w.armed()).toEqual([]);
  });
});
