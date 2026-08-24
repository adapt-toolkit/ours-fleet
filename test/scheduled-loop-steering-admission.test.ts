import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedRoleLoop } from '../src/loops/config.js';
import { ScheduledLoopManager } from '../src/loops/manager.js';
import { AcpSession } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function definition(overrides: Partial<ResolvedRoleLoop> = {}): ResolvedRoleLoop {
  return {
    name: 'health', role: 'Coordinator', intervalMs: 10 * 60_000,
    prompt: 'health pass', promptBytes: 11, promptHash: 'a'.repeat(64), enabled: true,
    initialDelayMs: 0, jitterMs: 0, sourceFile: '/private/fleet.yaml',
    definitionHash: 'a'.repeat(64),
    ...overrides,
  };
}

interface FakeTimer { callback: () => void; ms: number; cleared: boolean }

function fakeTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => {
      const timer: FakeTimer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer: unknown) => { (timer as FakeTimer).cleared = true; },
    pending: (ms: number) => timers.find(timer => timer.ms === ms && !timer.cleared),
  };
}

const settle = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 10));
};

async function startSession(
  stateDir: string, logs: string[], env: Record<string, string>, steeringOccupancyIdleMs?: number,
) {
  return AcpSession.start({
    name: 'Coordinator',
    argv: [process.execPath, fixture],
    cwd: stateDir,
    env,
    stateDir,
    mode: 'fresh',
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: line => logs.push(line),
    cancelGraceMs: 150,
    cancelTerminateGraceMs: 150,
    ...(steeringOccupancyIdleMs === undefined ? {} : { steeringOccupancyIdleMs }),
  });
}

const scheduled = (runId: string) =>
  ({ kind: 'scheduled-loop', loop: 'health', runId }) as const;

/**
 * FLEET-003. A mail wake delivered by `_session/steering` starts a turn inside
 * the adapter. Fleet issued that call without taking turn ownership, so
 * `readiness` stayed `idle`, `RoleTurnArbiter.tryScheduled` admitted a
 * scheduled loop into an adapter that was already working, and the resulting
 * `session/prompt` never received a stopReason of its own. The loop's own
 * 300000 ms deadline then fired, `session/cancel` had no turn of its own to
 * end, `awaitCancellationSettlement` expired after 15000 ms, and a LIVE
 * production role was SIGTERMed — the observed 315000 ms shape.
 *
 * Only the loop deadline and the cancel grace are shortened; admission,
 * cancellation and settlement are real code.
 */
describe('FLEET-003 scheduled-loop admission after a steered wake', () => {
  it('does not admit a scheduled run into an adapter a steered wake is occupying', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-admit-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    const session = await startSession(stateDir, logs, {
      ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '4000',
    });
    const arbiter = new RoleTurnArbiter(session);

    // The wake. `submitPromptAfterTool` is the monitor's delivery path and it
    // steers when the adapter advertises support, exactly as in production.
    const wake = await session.submitPromptAfterTool('[fleet-monitor] new mail');
    expect(wake.detail).toBe('startedNewTurn');

    // THE BOUNDARY. The adapter is now running a turn nobody addressed by id.
    // Admission must see that; it must not hand the loop a prompt that can
    // never produce a stopReason.
    const attempt = await arbiter.tryScheduled(
      'health pass', { kind: 'scheduled-loop', loop: 'health', runId: 'sl_probe' });
    expect(attempt.state).toBe('skipped_busy');

    // No adapter restart, no SIGTERM, no live-role downtime.
    expect(session.isAlive()).toBe(true);
    expect(logs.join('\n')).not.toContain('ACP_CANCEL_DEADLINE_EXCEEDED');

    await session.close();
  });

  it('escalates to SIGTERM if the loop is admitted while a steered turn owns the adapter', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-sigterm-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    const session = await startSession(stateDir, logs, {
      ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '30000',
    });
    const arbiter = new RoleTurnArbiter(session);
    const clock = fakeTimers();
    let now = 0;
    const manager = new ScheduledLoopManager('Coordinator', [definition()], stateDir, arbiter, {
      now: () => now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: line => logs.push(line),
      cancelAbandonMs: 5_000,
    });

    await session.submitPromptAfterTool('[fleet-monitor] new mail');
    manager.start();
    await manager.poll();
    await settle();

    // Whether the run was admitted is the fix's decision. If admission refused
    // it there is nothing to escalate and the role stays up; if it was
    // admitted, the full 300000 + 15000 chain must be what follows.
    const runId = manager.status().loops.health.activeRunId;
    if (runId === null) {
      expect(manager.status().loops.health.lastOutcome).toBe('skipped_busy');
      expect(session.isAlive()).toBe(true);
      await manager.stop();
      await session.close();
      return;
    }

    const deadline = clock.pending(5 * 60_000);
    expect(deadline).toBeDefined();
    now = 5 * 60_000;
    deadline!.callback();
    for (let i = 0; i < 200 && manager.status().loops.health.activeRunId !== null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 200 && session.exitResult() === null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    expect(logs.join('\n')).toContain('did not settle within 150ms');
    expect(session.isAlive()).toBe(false);
    expect(manager.status().loops.health.counts.failed).toBe(1);

    await manager.stop();
    await session.close();
  });

  it('releases the lease on adapter silence, so the role is never stranded busy', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-release-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    const session = await startSession(stateDir, logs, {
      ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '250',
    }, 200);
    const arbiter = new RoleTurnArbiter(session);

    await session.submitPromptAfterTool('[fleet-monitor] new mail');
    expect((await arbiter.tryScheduled('health pass', scheduled('sl_busy'))).state)
      .toBe('skipped_busy');

    // The clearing rule. Occupancy is a lease, not a latch: once the steered
    // turn goes quiet for the grace, the loop runs again on the next tick.
    let attempt = await arbiter.tryScheduled('health pass', scheduled('sl_after'));
    for (let i = 0; i < 100 && attempt.state === 'skipped_busy'; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      attempt = await arbiter.tryScheduled('health pass', scheduled('sl_after'));
    }
    expect(attempt.state).toBe('started');
    if (attempt.state === 'started')
      expect((await attempt.queued.completion).outcome).toBe('completed');
    expect(logs.join('\n')).toContain('no longer holds the adapter (adapter silent)');
    expect(session.isAlive()).toBe(true);

    await session.close();
  });

  it('releases the lease at a real turn boundary without waiting for the silence grace', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-boundary-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    // A grace far longer than the test: only the turn-boundary path can free it.
    const session = await startSession(stateDir, logs, {
      ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '150',
    }, 10 * 60_000);
    const arbiter = new RoleTurnArbiter(session);

    await session.submitPromptAfterTool('[fleet-monitor] new mail');
    expect(session.snapshot().readiness).toBe('running');
    // Once the steered turn is over the adapter answers prompts again; that
    // owned turn's completion is the boundary that clears the lease. The lease
    // is still held here — only the boundary, not the grace, can free it.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(session.snapshot().readiness).toBe('running');
    expect((await session.submitPrompt('owner question')).outcome).toBe('completed');
    expect(logs.join('\n')).toContain('no longer holds the adapter (turn boundary)');
    expect(session.snapshot().readiness).toBe('idle');
    expect((await arbiter.tryScheduled('health pass', scheduled('sl_after'))).state)
      .toBe('started');

    await session.close();
  });

  it('releases the lease when the session closes and when the adapter exits', async () => {
    const logs: string[] = [];
    const closeDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-close-'));
    dirs.push(closeDir);
    const closing = await startSession(closeDir, logs, {
      ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '60000',
    }, 10 * 60_000);
    await closing.submitPromptAfterTool('[fleet-monitor] new mail');
    expect(closing.snapshot().readiness).toBe('running');
    await closing.close();
    expect(logs.join('\n')).toContain('no longer holds the adapter (session closed)');

    const exitLogs: string[] = [];
    const exitDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-exit-'));
    dirs.push(exitDir);
    const dying = await startSession(exitDir, exitLogs, {
      ACP_FIXTURE_STEERING_OCCUPIES: '1', ACP_FIXTURE_STEERING_TURN_MS: '60000',
    }, 10 * 60_000);
    await dying.submitPromptAfterTool('[fleet-monitor] new mail');
    expect(dying.snapshot().readiness).toBe('running');
    process.kill(dying.pid!, 'SIGKILL');
    for (let i = 0; i < 200 && dying.isAlive(); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(exitLogs.join('\n')).toContain('no longer holds the adapter (adapter exited)');
    await dying.close();
  });

  it('still cancels a genuinely working turn well inside the settlement deadline', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-steer-control-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    // Control for the six production runs that settled in 34-329 ms and were
    // never SIGTERMed. A real turn, cancelled, must still settle promptly and
    // leave the role alive.
    const session = await startSession(stateDir, logs, {});
    const arbiter = new RoleTurnArbiter(session);
    const clock = fakeTimers();
    let now = 0;
    const manager = new ScheduledLoopManager(
      'Coordinator', [definition({ prompt: 'block 5000', promptBytes: 10 })], stateDir, arbiter, {
        now: () => now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        log: line => logs.push(line),
        cancelAbandonMs: 5_000,
      });

    manager.start();
    await manager.poll();
    for (let i = 0; i < 100 && session.snapshot().readiness !== 'running'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(manager.status().loops.health.activeRunId).toMatch(/^sl_/);

    const startedAt = Date.now();
    now = 5 * 60_000;
    clock.pending(5 * 60_000)!.callback();
    for (let i = 0; i < 200 && manager.status().loops.health.activeRunId !== null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(manager.status().loops.health.lastOutcome).toContain('cancelled');
    expect(session.isAlive()).toBe(true);
    expect(logs.join('\n')).not.toContain('ACP_CANCEL_DEADLINE_EXCEEDED');

    await manager.stop();
    await session.close();
  });
});
