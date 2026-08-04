import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedRoleLoop } from '../src/loops/config.js';
import { ScheduledLoopManager } from '../src/loops/manager.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import type {
  ExitRecord, QueuedPrompt, SessionEvent, SessionHandle, SessionSnapshot,
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
  async interrupt(source: TurnCancellationSource = 'local-console') { this.interrupts.push(source); }
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

function setup(definitions = [definition()], initialNow = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-loop-manager-'));
  dirs.push(dir);
  let now = initialNow;
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const logs: string[] = [];
  const session = new FakeSession();
  const arbiter = new RoleTurnArbiter(session);
  const manager = new ScheduledLoopManager('Coordinator', definitions, dir, arbiter, {
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { (timer as { cleared: boolean }).cleared = true; },
    log: line => logs.push(line),
  });
  return { dir, manager, session, arbiter, timers, logs, now: () => now, setNow: (value: number) => { now = value; } };
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
