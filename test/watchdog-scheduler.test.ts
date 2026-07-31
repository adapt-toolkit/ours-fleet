import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  watchdogBackoffMs, runWatchdogLoop, readSchedulerState, resetSchedulerState,
} from '../src/watchdog/scheduler.js';
import { listRuns, acquireRunLock, releaseRunLock, formatRunId } from '../src/watchdog/store.js';
import { errorReport } from '../src/watchdog/report.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wdsched-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const wd = {
  name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
  intervalMs: 600_000, watch: ['Alice'], harness: 'claude-code', session: 'tmux' as const,
  identity: 'Watchdog-nightwatch', timeoutMs: 300_000, keepReports: 50,
  alertCooldownMs: 3_600_000, sourceFile: 'f',
};

it('backs off 1x, 2x, 4x capped at 1h (spec §3)', () => {
  expect(watchdogBackoffMs(600_000, 0)).toBe(600_000);
  expect(watchdogBackoffMs(600_000, 1)).toBe(600_000);
  expect(watchdogBackoffMs(600_000, 2)).toBe(1_200_000);
  expect(watchdogBackoffMs(600_000, 3)).toBe(2_400_000);
  expect(watchdogBackoffMs(600_000, 10)).toBe(3_600_000);
});

function world(opts: { results: Array<'ok' | 'error' | 'throw'> }) {
  let i = 0; const sleeps: number[] = []; let t = 0;
  const deps = {
    now: () => new Date(t), sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    log: () => {}, binPath: '/bin/false', heldPollMs: 5_000,
    shouldStop: () => i >= opts.results.length,
    sleeps, alerts: [] as string[],
    onSchedulerAlert: async (_wd: unknown, text: string) => { deps.alerts.push(text); },
    runOnceFor: async (wd: { name: string }) => {
      const kind = opts.results[i++]; t += 1_000;
      if (kind === 'throw') throw new Error('spawn failed');
      const status = kind === 'ok' ? 'ok' : 'error';
      const report = {
        ...errorReport({
          watchdog: wd.name, run_id: formatRunId(new Date(t)),
          started_at: 'a', finished_at: 'b', error: 'x',
        }),
        status,
      } as never;
      return { report, storedPath: '' };
    },
  };
  return deps;
}

describe('watchdog scheduler', () => {
  it('runs immediately, then sleeps interval after finish; failures escalate the delay', async () => {
    const deps = world({ results: ['ok', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    expect(deps.sleeps).toEqual([600_000, 600_000, 1_200_000]);
    expect(readSchedulerState('nightwatch').consecutiveFailures).toBe(2);
  });

  it('holds down after 3 consecutive failures and alerts once (spec §3, §5.5)', async () => {
    const deps = world({ results: ['error', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    const s = readSchedulerState('nightwatch');
    expect(s.heldDown).toBe(true);
    expect(deps.alerts).toHaveLength(1);
    expect(deps.alerts[0]).toMatch(/held down after 3/);
  });

  it('a held-down loop polls for release instead of running', async () => {
    const deps = world({ results: ['error', 'error', 'error', 'ok'] });
    // after hold, shouldStop still false for one more iteration:
    let polls = 0; const origSleep = deps.sleep;
    deps.sleep = async ms => { if (ms === 5_000) polls++; await origSleep(ms); };
    deps.shouldStop = () => polls >= 2;
    await runWatchdogLoop(wd as never, deps as never);
    expect(polls).toBeGreaterThanOrEqual(2);          // never invoked runOnceFor a 4th time
  });

  it('a due tick with the lock held records skipped_overlap and does not count as failure (acceptance 4)', async () => {
    acquireRunLock('nightwatch');
    const deps = world({ results: ['ok'] });
    deps.shouldStop = () => listRuns('nightwatch').length >= 1;
    await runWatchdogLoop(wd as never, deps as never);
    releaseRunLock('nightwatch');
    const runs = listRuns('nightwatch');
    expect(runs[0].error).toBe('skipped_overlap');
    expect(readSchedulerState('nightwatch').consecutiveFailures).toBe(0);
  });

  it('a thrown run counts as a failure but never kills the loop', async () => {
    const deps = world({ results: ['throw', 'ok'] });
    await runWatchdogLoop(wd as never, deps as never);
    expect(readSchedulerState('nightwatch').consecutiveFailures).toBe(0);  // reset by the ok
  });

  it('resetSchedulerState releases a held-down watchdog', async () => {
    const deps = world({ results: ['error', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    resetSchedulerState('nightwatch');
    expect(readSchedulerState('nightwatch').heldDown).toBe(false);
  });
});
