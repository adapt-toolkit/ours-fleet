import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedRoleLoop } from '../src/loops/config.js';
import { ScheduledLoopManager } from '../src/loops/manager.js';
import { AcpSession } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import { ACP_CANCEL_DEADLINE_EXCEEDED } from '../src/session/types.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function definition(overrides: Partial<ResolvedRoleLoop> = {}): ResolvedRoleLoop {
  return {
    name: 'health', role: 'Coordinator', intervalMs: 10 * 60_000,
    prompt: 'stubborn block 60000', promptBytes: 21, promptHash: 'a'.repeat(64), enabled: true,
    initialDelayMs: 0, jitterMs: 0, sourceFile: '/private/fleet.yaml',
    definitionHash: 'a'.repeat(64),
    ...overrides,
  };
}

/**
 * The confirmed cancellation-recovery shape, reproduced end to end against the ACP
 * fixture: a scheduled health pass ignores its cancellation and keeps running
 * until the loop's own deadline fires (in production ~300 s), then the ACP
 * cancel grace expires on top of it (~15 s more — the observed ~315 s), and the
 * adapter is restarted. Everything below the loop deadline uses real code; only
 * the loop's own timers are driven by the fake clock so the test is fast.
 */
describe('scheduled-loop cancellation recovery', () => {
  it('recovers a health pass that ignores cancellation, and leaves no run active', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-loop-acp-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    const session = await AcpSession.start({
      name: 'Coordinator',
      argv: [process.execPath, fixture],
      cwd: stateDir,
      env: {},
      stateDir,
      mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      log: line => logs.push(line),
      cancelGraceMs: 150,
      cancelTerminateGraceMs: 150,
    });
    const arbiter = new RoleTurnArbiter(session);
    let now = 0;
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const manager = new ScheduledLoopManager('Coordinator', [definition()], stateDir, arbiter, {
      now: () => now,
      setTimer: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: timer => { (timer as { cleared: boolean }).cleared = true; },
      log: line => logs.push(line),
      cancelAbandonMs: 5_000,
    });

    manager.start();
    await manager.poll();
    const runId = manager.status().loops.health.activeRunId;
    expect(runId).toMatch(/^sl_/);
    for (let i = 0; i < 100 && session.snapshot().readiness !== 'running'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    // The bounded deadline the loop arms for its own run: 5 min for a 10 min
    // interval. Firing it is exactly what happened at ~300 s in production.
    const deadline = timers.find(timer => timer.ms === 5 * 60_000 && !timer.cleared);
    expect(deadline).toBeDefined();
    now = 5 * 60_000;
    deadline!.callback();

    for (let i = 0; i < 200 && manager.status().loops.health.activeRunId !== null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    // The turn is over, the adapter was reclaimed, and the slot is free — no
    // permanently-active run and therefore no permanent skipped_busy.
    expect(manager.status().loops.health).toMatchObject({
      activeRunId: null, counts: { failed: 1 },
    });
    // Signal delivery is asynchronous; wait for the adapter's own exit record.
    for (let i = 0; i < 200 && session.exitResult() === null; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(session.isAlive()).toBe(false);
    expect(session.exitResult()?.detail).toContain(ACP_CANCEL_DEADLINE_EXCEEDED);
    expect(logs.join('\n')).toContain('cancellation enforced');
    // Recovery is honest about the failure without leaking the loop's prompt.
    const persisted = readFileSync(join(stateDir, '.scheduled-loops.json'), 'utf8');
    expect(persisted).not.toContain('stubborn block');
    expect(logs.join('\n')).not.toContain('stubborn block');

    await manager.stop();
    await session.close();
  });

  it('leaves the slot free even if forced recovery itself never settles the turn', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-fleet-loop-stuck-'));
    dirs.push(stateDir);
    const logs: string[] = [];
    // A grace long enough that the adapter is still running when the loop's own
    // last-resort bound fires: the loop must not wait on the session forever.
    const session = await AcpSession.start({
      name: 'Coordinator',
      argv: [process.execPath, fixture],
      cwd: stateDir,
      env: { ACP_FIXTURE_IGNORE_SIGTERM: '1' },
      stateDir,
      mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      log: line => logs.push(line),
      cancelGraceMs: 60_000,
    });
    const arbiter = new RoleTurnArbiter(session);
    let now = 0;
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const manager = new ScheduledLoopManager('Coordinator', [definition()], stateDir, arbiter, {
      now: () => now,
      setTimer: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: timer => { (timer as { cleared: boolean }).cleared = true; },
      log: line => logs.push(line),
      cancelAbandonMs: 30_000,
    });

    manager.start();
    await manager.poll();
    for (let i = 0; i < 100 && session.snapshot().readiness !== 'running'; i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    now = 5 * 60_000;
    timers.find(timer => timer.ms === 5 * 60_000 && !timer.cleared)!.callback();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(manager.status().loops.health.activeRunId).toMatch(/^sl_/);

    now = 5 * 60_000 + 30_000;
    timers.find(timer => timer.ms === 30_000 && !timer.cleared)!.callback();

    expect(manager.status().loops.health).toMatchObject({
      activeRunId: null, lastOutcome: 'abandoned_unsettled',
    });
    expect(manager.status()).toMatchObject({ health: 'degraded', anomaly: 'abandoned_unsettled' });

    // The slot is free, and so is admission itself: a later producer gets an
    // answer from the arbiter instead of queueing behind the stuck cancellation
    // for the life of the process. Without the retirement this never resolves.
    const attempt = await arbiter.tryScheduled(
      'later scheduled work', { kind: 'scheduled-loop', loop: 'health', runId: 'sl_probe' });
    expect(['started', 'skipped_busy', 'unavailable']).toContain(attempt.state);
    const [owner] = await Promise.allSettled([arbiter.queuePrompt('later owner prompt')]);
    expect(owner.status).toMatch(/fulfilled|rejected/);

    await manager.stop();
    await session.close();
  });
});
