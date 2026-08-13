import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { replaceFileAtomically } from '../src/atomic-file.js';
import type { ResolvedRoleLoop } from '../src/loops/config.js';
import { ScheduledLoopManager } from '../src/loops/manager.js';
import { storedLoopHealth } from '../src/loops/state.js';
import type { ScheduledLoopsFile, StateWriter } from '../src/loops/state.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import type {
  ExitRecord, InterruptOutcome, QueuedPrompt, SessionEvent, SessionHandle, SessionSnapshot,
  SubmitPromptOptions, TurnCancellationSource, TurnResult,
} from '../src/session/types.js';

const dirs: string[] = [];

class FakeSession implements SessionHandle {
  readonly backend = 'acp' as const;
  readonly pid = 1;
  readiness: SessionSnapshot['readiness'] = 'idle';
  prompts: Array<{ text: string; options?: SubmitPromptOptions }> = [];
  pending: Array<(result: TurnResult) => void> = [];
  rejectQueue = false;
  interrupts: TurnCancellationSource[] = [];
  isAlive() { return true; }
  snapshot(): SessionSnapshot { return { backend: 'acp', alive: true, readiness: this.readiness }; }
  async queuePrompt(text: string, options?: SubmitPromptOptions): Promise<QueuedPrompt> {
    if (this.rejectQueue) throw new Error('CANARY_QUEUE_DETAIL');
    this.prompts.push({ text, options });
    this.readiness = 'running';
    const completion = new Promise<TurnResult>(resolve => this.pending.push(result => {
      this.readiness = 'idle';
      resolve(result);
    }));
    return { promptId: `p${this.prompts.length}`, queuedBehind: 0, completion, origin: options?.origin };
  }
  async submitPrompt(text: string, options?: SubmitPromptOptions) {
    return (await this.queuePrompt(text, options)).completion;
  }
  /** Set to model an ACP adapter whose recovery force-fails the running turn. */
  forceRecoveryOnInterrupt = false;
  async interrupt(source: TurnCancellationSource = 'local-console'): Promise<InterruptOutcome> {
    this.interrupts.push(source);
    if (!this.forceRecoveryOnInterrupt) return { state: 'settled' };
    // What AcpSession does once its cancel deadline expires: the adapter is
    // killed, so every in-flight turn settles as failed before it answers.
    this.finish({ accepted: false, outcome: 'failed', succeeded: false, detail: 'forced recovery' });
    return { state: 'forced', reasonCode: 'ACP_CANCEL_DEADLINE_EXCEEDED' };
  }
  respondPermission() { return false; }
  eventsSince(): SessionEvent[] { return []; }
  subscribe() { return () => undefined; }
  setControllerAttached() {}
  exitResult(): ExitRecord | null { return null; }
  async close() {}
  finish(result: TurnResult) { this.pending.shift()?.(result); }
}

function definition(name = 'health', overrides: Partial<ResolvedRoleLoop> = {}): ResolvedRoleLoop {
  return {
    name, role: 'Coordinator', intervalMs: 60_000, prompt: 'CANARY_LITERAL_PROMPT',
    promptBytes: 21, promptHash: 'a'.repeat(64), enabled: true,
    initialDelayMs: 60_000, jitterMs: 0, sourceFile: '/private/fleet.yaml',
    definitionHash: `${name.charCodeAt(0).toString(16)}`.repeat(64).slice(0, 64),
    ...overrides,
  };
}

/**
 * A disk that can be made full on demand. `writes` counts only the writes that
 * actually landed, so a test can prove a failed persist left the stored file
 * exactly as it was.
 */
function faultyDisk() {
  let full = false;
  let writes = 0;
  const writer: StateWriter = (path, contents, mode) => {
    if (full) {
      const error = new Error(
        `ENOSPC: no space left on device, write '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      error.errno = -28;
      error.syscall = 'write';
      throw error;
    }
    writes++;
    replaceFileAtomically(path, contents, mode);
  };
  return {
    writer,
    fill: () => { full = true; },
    free: () => { full = false; },
    writes: () => writes,
  };
}

function setup(
  definitions = [definition()], initialNow = 0,
  writeState?: StateWriter, cancelAbandonMs?: number,
) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-loop-manager-'));
  dirs.push(dir);
  let now = initialNow;
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const logs: string[] = [];
  const session = new FakeSession();
  const arbiter = new RoleTurnArbiter(session);
  let nowFault: Error | undefined;
  const manager = new ScheduledLoopManager('Coordinator', definitions, dir, arbiter, {
    now: () => {
      if (nowFault) { const error = nowFault; nowFault = undefined; throw error; }
      return now;
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { (timer as { cleared: boolean }).cleared = true; },
    log: line => logs.push(line),
    writeState,
    ...(cancelAbandonMs !== undefined ? { cancelAbandonMs } : {}),
  });
  const live = () => timers.filter(timer => !timer.cleared);
  return {
    dir, manager, session, arbiter, timers, logs, live,
    now: () => now,
    setNow: (value: number) => { now = value; },
    /** Make the next clock read throw, standing in for any unforeseen poll fault. */
    breakNow: (error: Error) => { nowFault = error; },
    stored: () => JSON.parse(readFileSync(join(dir, '.scheduled-loops.json'), 'utf8')) as ScheduledLoopsFile,
    /** Fire the pending schedule timer exactly as the runtime would, then drain microtasks. */
    tick: async () => {
      const timer = live().at(-1);
      if (!timer) throw new Error('no live timer: the manager stopped scheduling itself');
      timer.cleared = true;
      timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ScheduledLoopManager strict cadence', () => {
  it('uses one full interval initially, supports explicit zero, and submits typed literal provenance', async () => {
    const normal = setup();
    normal.manager.start();
    expect(normal.manager.status().loops.health.nextDueAt).toBe('1970-01-01T00:01:00.000Z');
    expect(normal.timers.at(-1)?.ms).toBe(60_000);

    const immediate = setup([definition('now', { initialDelayMs: 0, definitionHash: 'b'.repeat(64) })]);
    immediate.manager.start();
    expect(immediate.timers.at(-1)?.ms).toBe(0);
    await immediate.manager.poll();
    expect(immediate.session.prompts).toHaveLength(1);
    expect(immediate.session.prompts[0].text).toContain('[fleet-loop]');
    expect(immediate.session.prompts[0].text).toContain('CANARY_LITERAL_PROMPT');
    expect(immediate.session.prompts[0].options).toMatchObject({
      interrupt: false, origin: { kind: 'scheduled-loop', loop: 'now' },
    });
    const persisted = readFileSync(join(immediate.dir, '.scheduled-loops.json'), 'utf8');
    expect(persisted).not.toContain('CANARY_LITERAL_PROMPT');
    expect(immediate.logs.join('\n')).not.toContain('CANARY_LITERAL_PROMPT');
  });

  it('cancels a scheduled turn at a bounded deadline so it cannot monopolize the role', async () => {
    const status = setup([definition('health', { intervalMs: 10 * 60_000 })]);
    status.manager.start();
    status.setNow(60_000);
    await status.manager.runNow('health');
    const deadline = status.timers.find(timer => timer.ms === 5 * 60_000 && !timer.cleared);
    expect(deadline).toBeDefined();
    deadline!.callback();
    await Promise.resolve();
    expect(status.session.interrupts).toEqual(['scheduled-loop']);
    expect(status.logs.join('\n')).toContain('timed out');
  });

  it('releases the loop slot after a forced cancellation so the next tick runs again', async () => {
    const status = setup([definition('health', { intervalMs: 10 * 60_000 })]);
    status.manager.start();
    status.setNow(60_000);
    await status.manager.poll();
    expect(status.manager.status().loops.health.activeRunId).toMatch(/^sl_/);

    // The adapter ignored the cancel, so the session forced recovery: the turn
    // is over, and the loop must record that instead of owning the slot forever.
    status.session.forceRecoveryOnInterrupt = true;
    status.timers.find(timer => timer.ms === 5 * 60_000 && !timer.cleared)!.callback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(status.manager.status().loops.health).toMatchObject({
      activeRunId: null, lastOutcome: 'failed', counts: { failed: 1 },
    });
    expect(status.logs.join('\n')).toContain('cancellation enforced');

    // The decisive part: the very next due occurrence starts, rather than
    // reporting skipped_busy for the rest of the process's life.
    status.setNow(660_000);
    await status.manager.poll();
    expect(status.session.prompts).toHaveLength(2);
    expect(status.manager.status().loops.health.activeRunId).toMatch(/^sl_/);
    expect(status.manager.status().loops.health.counts.skippedBusy ?? 0).toBe(0);
  });

  it('abandons a run whose cancellation never settles, without double-reporting it', async () => {
    const status = setup([definition('health', { intervalMs: 10 * 60_000 })], 0, undefined, 30_000);
    status.manager.start();
    status.setNow(60_000);
    await status.manager.poll();
    const runId = status.manager.status().loops.health.activeRunId;

    // Nothing settles: not the turn, not the cancellation, not the recovery.
    status.timers.find(timer => timer.ms === 5 * 60_000 && !timer.cleared)!.callback();
    await new Promise(resolve => setImmediate(resolve));
    expect(status.manager.status().loops.health.activeRunId).toBe(runId);

    status.setNow(90_000);
    status.timers.find(timer => timer.ms === 30_000 && !timer.cleared)!.callback();
    expect(status.manager.status().loops.health).toMatchObject({
      activeRunId: null, lastOutcome: 'abandoned_unsettled', counts: { failed: 1 },
      lastError: { kind: 'abandoned_unsettled' },
    });
    expect(status.manager.status()).toMatchObject({
      health: 'degraded', anomaly: 'abandoned_unsettled',
    });

    // A late completion for a run the loop no longer owns changes nothing.
    status.session.finish({ accepted: false, outcome: 'failed', succeeded: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(status.manager.status().loops.health).toMatchObject({
      activeRunId: null, lastOutcome: 'abandoned_unsettled', counts: { failed: 1 },
    });
  });

  it('clears an active scheduled-turn deadline when the manager stops', async () => {
    const status = setup([definition('health', { intervalMs: 10 * 60_000 })]);
    await status.manager.runNow('health');
    const deadline = status.timers.find(timer => timer.ms === 5 * 60_000 && !timer.cleared);
    expect(deadline).toBeDefined();
    await status.manager.stop();
    expect(deadline!.cleared).toBe(true);
  });

  it('skips a busy owner/manual turn once with no backlog or retry-on-idle', async () => {
    const status = setup();
    status.manager.start();
    await status.arbiter.queuePrompt('owner', { origin: { kind: 'owner', requestId: 'r' } });
    status.setNow(60_000);
    await status.manager.poll();
    expect(status.session.prompts.map(item => item.text)).toEqual(['owner']);
    expect(status.manager.status().loops.health.counts).toMatchObject({ skipped: 1, skippedBusy: 1 });
    status.session.finish({ accepted: true, outcome: 'completed', succeeded: true });
    await Promise.resolve();
    await status.manager.poll();
    expect(status.session.prompts).toHaveLength(1);
    expect(status.manager.status().loops.health.nextDueAt).toBe('1970-01-01T00:02:00.000Z');
  });

  it('lets an owner claim win when it races a due scheduled occurrence', async () => {
    const status = setup();
    status.manager.start();
    status.setNow(60_000);
    const scheduled = status.manager.poll();
    await status.arbiter.queuePrompt('owner-race', {
      origin: { kind: 'owner', requestId: 'owner-race' },
    });
    await scheduled;
    expect(status.session.prompts.map(item => item.text)).toEqual(['owner-race']);
    expect(status.manager.status().loops.health).toMatchObject({
      lastOutcome: 'skipped_busy', counts: { started: 0, skippedBusy: 1 },
    });
  });

  it('evaluates simultaneous loops in name order and never overlaps them', async () => {
    const status = setup([
      definition('zeta', { definitionHash: 'c'.repeat(64) }),
      definition('alpha', { definitionHash: 'd'.repeat(64) }),
    ]);
    status.manager.start();
    status.setNow(60_000);
    await status.manager.poll();
    expect(status.session.prompts).toHaveLength(1);
    expect(status.session.prompts[0].text).toContain('loop: alpha');
    expect(status.manager.status().loops.zeta.lastOutcome).toBe('skipped_busy');
  });

  it('counts a thousand missed restart ticks without submitting catch-up work', async () => {
    const first = setup();
    first.manager.start();
    await first.manager.stop();
    const session = new FakeSession();
    const manager = new ScheduledLoopManager('Coordinator', [definition()], first.dir,
      new RoleTurnArbiter(session), {
        now: () => 60_000_000, setTimer: () => ({}), clearTimer: () => undefined, log: () => undefined,
      });
    manager.start();
    expect(session.prompts).toHaveLength(0);
    expect(manager.status().loops.health.counts).toMatchObject({ skipped: 1000, skippedMissed: 1000 });
    expect(manager.status().loops.health.nextDueAt).toBe('1970-01-01T16:41:00.000Z');
  });

  it('records an active restart as abandoned and waits for normal cadence', async () => {
    const first = setup();
    first.manager.start();
    first.setNow(60_000);
    await first.manager.poll();
    expect(first.manager.status().loops.health.activeRunId).toMatch(/^sl_/);
    const restartedSession = new FakeSession();
    const restarted = new ScheduledLoopManager('Coordinator', [definition()], first.dir,
      new RoleTurnArbiter(restartedSession), {
        now: () => 61_000, setTimer: () => ({}), clearTimer: () => undefined, log: () => undefined,
      });
    restarted.start();
    expect(restartedSession.prompts).toHaveLength(0);
    expect(restarted.status().loops.health).toMatchObject({
      activeRunId: null, lastOutcome: 'abandoned_restart', counts: { failed: 1 },
    });
  });

  it('persists operator disable and rejects queue failures until the next cadence', async () => {
    const status = setup();
    status.manager.start();
    expect(status.manager.disable('health').state).toBe('disabled');
    const restartedSession = new FakeSession();
    const restarted = new ScheduledLoopManager('Coordinator', [definition()], status.dir,
      new RoleTurnArbiter(restartedSession), {
        now: () => 10_000, setTimer: () => ({}), clearTimer: () => undefined, log: () => undefined,
      });
    restarted.start();
    expect(restarted.status().loops.health.operatorDisabled).toBe(true);
    expect(restarted.enable('health').state).toBe('started');
    restartedSession.rejectQueue = true;
    const result = await restarted.runNow('health');
    expect(result.state).toBe('unavailable');
    expect(restarted.status().loops.health.counts.failed).toBe(1);
    expect(JSON.stringify(restarted.status())).not.toContain('CANARY_QUEUE_DETAIL');
  });

  it('records terminal completion and typed owner cancellation without owner routing', async () => {
    const completed = setup();
    completed.manager.start();
    completed.setNow(60_000);
    await completed.manager.poll();
    completed.session.finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'NO_EXTERNAL_REPORT' });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed.manager.status().loops.health.counts.completed).toBe(1);
    expect(JSON.stringify(completed.manager.status())).not.toContain('NO_EXTERNAL_REPORT');

    const cancelled = setup();
    cancelled.manager.start();
    cancelled.setNow(60_000);
    await cancelled.manager.poll();
    cancelled.session.finish({
      accepted: true, outcome: 'cancelled', succeeded: false, cancellationSource: 'owner',
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(cancelled.manager.status().loops.health).toMatchObject({
      lastOutcome: 'cancelled(owner)', lastCancellationSource: 'owner', counts: { cancelled: 1 },
    });
  });

  it('retains cadence on prompt-only reload and resets it on schedule changes', () => {
    const status = setup();
    status.manager.start();
    const before = status.manager.status().loops.health.nextDueAt;
    status.setNow(10_000);
    status.manager.reconcile([definition('health', {
      prompt: 'REPLACED_LITERAL', promptHash: 'f'.repeat(64),
    })]);
    expect(status.manager.status().loops.health).toMatchObject({
      nextDueAt: before, promptHash: 'f'.repeat(64),
    });

    status.manager.reconcile([definition('health', {
      intervalMs: 120_000, initialDelayMs: 120_000, definitionHash: 'e'.repeat(64),
    })]);
    expect(status.manager.status().loops.health.nextDueAt).toBe('1970-01-01T00:02:10.000Z');
  });

  it('degrades and pauses after a material backward clock jump', async () => {
    const status = setup([definition()], 1_000_000);
    status.manager.start();
    status.setNow(0);
    await status.manager.poll();
    expect(status.session.prompts).toHaveLength(0);
    expect(status.manager.status()).toMatchObject({
      health: 'degraded', anomaly: 'clock_regression', clock: { lastWallMs: 0 },
    });
    expect(status.logs.join('\n')).toContain('backward clock jump');
  });

  it('keeps scheduling itself through an ENOSPC burst and resumes when the disk frees', async () => {
    const disk = faultyDisk();
    const enospc = setup([definition('health', { initialDelayMs: 0 })], 0, disk.writer);
    enospc.manager.start();
    const before = enospc.stored();
    const landed = disk.writes();

    disk.fill();
    await enospc.tick();

    // The occurrence could not be checkpointed, so it must not have been claimed.
    expect(enospc.session.prompts).toHaveLength(0);
    // I1: a transient write failure must never end the scheduling chain.
    expect(enospc.live()).toHaveLength(1);
    // I2: the retry is delayed, never a busy spin.
    expect(enospc.live()[0].ms).toBeGreaterThanOrEqual(1_000);
    expect(enospc.live()[0].ms).toBeLessThanOrEqual(60_000);
    // I4: in-memory health is truthful the moment the first write fails.
    expect(enospc.manager.status()).toMatchObject({ health: 'failed', anomaly: 'persist_failed' });
    // I3: nothing landed on the full disk, and the last good file is untouched.
    expect(disk.writes()).toBe(landed);
    expect(enospc.stored()).toEqual(before);
    expect(enospc.logs.join('\n')).toContain('ENOSPC');

    disk.free();
    enospc.setNow(100_000);
    await enospc.tick();

    // I6: the loop runs again and both views agree it recovered.
    expect(enospc.session.prompts).toHaveLength(1);
    expect(enospc.manager.status()).toMatchObject({ health: 'healthy', anomaly: null });
    expect(enospc.stored()).toMatchObject({ health: 'healthy', anomaly: null });
    expect(disk.writes()).toBeGreaterThan(landed);
    expect(enospc.logs.join('\n')).toContain('scheduled loop persistence recovered');
  });

  it('backs off within bounds and logs once while the disk stays full', async () => {
    const disk = faultyDisk();
    const repeated = setup([definition('health', { initialDelayMs: 0 })], 0, disk.writer);
    repeated.manager.start();
    disk.fill();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      await repeated.tick();
      expect(repeated.live()).toHaveLength(1);
      delays.push(repeated.live()[0].ms);
      repeated.setNow(repeated.now() + delays[attempt]);
    }

    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    expect(Math.max(...delays)).toBe(60_000);
    expect(repeated.session.prompts).toHaveLength(0);
    // One line per transition, not one per attempt: a full disk must not also flood the log.
    expect(repeated.logs.filter(line => line.includes('scheduled loop state write failing'))).toHaveLength(1);
  });

  it('stays armed and recovers when a poll throws for a reason the store cannot absorb', async () => {
    const flaky = setup([definition('health', { initialDelayMs: 0 })]);
    flaky.manager.start();
    flaky.breakNow(new Error('CANARY_UNFORESEEN'));
    await flaky.tick();

    expect(flaky.logs.join('\n')).toContain('scheduled loop manager failed: Error');
    expect(flaky.live()).toHaveLength(1);
    expect(flaky.live()[0].ms).toBe(1_000);
    expect(flaky.manager.status()).toMatchObject({ health: 'failed', anomaly: 'manager_task_failed' });

    await flaky.tick();
    expect(flaky.session.prompts).toHaveLength(1);
    expect(flaky.manager.status()).toMatchObject({ health: 'healthy', anomaly: null });
    expect(flaky.logs.join('\n')).toContain('scheduled loop manager recovered');
  });

  it('does not resurrect a cleared anomaly when the blocked write finally lands', async () => {
    const disk = faultyDisk();
    const both = setup([definition('health', { initialDelayMs: 0 })], 0, disk.writer);
    both.manager.start();
    disk.fill();
    both.breakNow(new Error('CANARY_UNFORESEEN'));
    await both.tick();
    // Both faults at once: the write failure is the reported one, and the poll
    // failure it displaced is what must not come back.
    expect(both.logs.join('\n')).toContain('scheduled loop manager failed: Error');
    expect(both.manager.status()).toMatchObject({ health: 'failed', anomaly: 'persist_failed' });

    both.setNow(30_000);
    await both.tick();   // polls cleanly again, but the disk is still full
    expect(both.manager.status()).toMatchObject({ health: 'failed', anomaly: 'persist_failed' });

    disk.free();
    both.setNow(60_000);
    await both.tick();
    expect(both.stored()).toMatchObject({ health: 'healthy', anomaly: null });
  });

  it('resumes from the stale checkpoint after a restart without replaying missed occurrences', async () => {
    const disk = faultyDisk();
    const crashed = setup([definition('health', { initialDelayMs: 0 })], 0, disk.writer);
    crashed.manager.start();
    disk.fill();
    for (let attempt = 0; attempt < 3; attempt++) {
      crashed.setNow(crashed.now() + 60_000);
      await crashed.tick();
    }
    const stale = crashed.stored();
    expect(stale.health).toBe('healthy');   // the flip could not be written; only staleness shows it

    // Restart against the same directory, an hour later, with the disk still full.
    const session = new FakeSession();
    const logs: string[] = [];
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const restarted = new ScheduledLoopManager(
      'Coordinator', [definition('health', { initialDelayMs: 0 })], crashed.dir,
      new RoleTurnArbiter(session), {
        now: () => 3_600_000,
        setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
        clearTimer: timer => { (timer as { cleared: boolean }).cleared = true; },
        log: line => logs.push(line),
        writeState: disk.writer,
      });
    restarted.start();

    // I5: the cursor is preserved and the backlog is skipped, never submitted.
    expect(session.prompts).toHaveLength(0);
    const state = restarted.status().loops.health;
    expect(state.counts.skippedMissed).toBeGreaterThan(0);
    expect(state.counts.started).toBe(0);
    expect(Date.parse(state.nextDueAt)).toBeGreaterThan(3_600_000);
    expect(timers.filter(timer => !timer.cleared)).toHaveLength(1);
    expect(restarted.status()).toMatchObject({ health: 'failed', anomaly: 'persist_failed' });
  });

  it('reports a stored file as stale only while a loop still owes a run', () => {
    const disabled = setup([definition('health')]);
    disabled.manager.start();
    disabled.manager.disable('health');
    const idle = disabled.stored();

    // Nothing is scheduled, so nothing is expected to advance the checkpoint.
    expect(storedLoopHealth(idle, 6 * 60 * 60_000)).toMatchObject({
      health: 'healthy', stale: false, scheduled: false,
    });

    const owing = { ...idle, loops: { health: { ...idle.loops.health, operatorDisabled: false } } };
    expect(storedLoopHealth(owing, 6 * 60 * 60_000)).toMatchObject({
      health: 'stale', recorded: 'healthy', stale: true, scheduled: true,
    });
    expect(storedLoopHealth(owing, 60_000)).toMatchObject({ health: 'healthy', stale: false });
  });

  it('quarantines corrupt state without exposing it and reinitializes delayed cadence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-loop-corrupt-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.scheduled-loops.json'), '{CANARY_CORRUPT_BODY');
    const manager = new ScheduledLoopManager('Coordinator', [definition()], dir,
      new RoleTurnArbiter(new FakeSession()), {
        now: () => 20_000, setTimer: () => ({}), clearTimer: () => undefined, log: () => undefined,
      });
    expect(manager.status()).toMatchObject({
      health: 'degraded', anomaly: 'corrupt_state_recovered',
    });
    expect(manager.status().loops.health.nextDueAt).toBe('1970-01-01T00:01:20.000Z');
    expect(existsSync(join(dir, '.scheduled-loops.json.corrupt-20000'))).toBe(true);
    expect(readFileSync(join(dir, '.scheduled-loops.json'), 'utf8')).not.toContain('CANARY_CORRUPT_BODY');
  });
});
