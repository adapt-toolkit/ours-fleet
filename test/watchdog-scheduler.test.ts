import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  watchdogBackoffMs, runWatchdogLoop, readSchedulerState, resetSchedulerState, writeSchedulerState,
  runScheduler,
} from '../src/watchdog/scheduler.js';
import { listRuns, acquireRunLock, releaseRunLock, formatRunId, watchdogDir } from '../src/watchdog/store.js';
import { errorReport } from '../src/watchdog/report.js';
import { readLedger, writeLedger } from '../src/watchdog/alerts.js';
import { loadConfig } from '../src/config.js';

/** A pid that is guaranteed dead: spawnSync blocks until the child has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
}

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

  it('a lock-primitive throw (acquire) counts as a failed tick and the loop survives (review #1)', async () => {
    const deps = world({ results: ['ok', 'ok', 'ok'] });   // safety net only; should never be consumed
    let attempts = 0;
    (deps as unknown as { locks: { acquire(name: string): boolean; release(name: string): void } }).locks = {
      acquire: (_name: string) => { attempts++; throw new Error('EACCES: lock dir'); },
      release: (_name: string) => {},
    };
    // Bounded independently of `attempts` so a build that ignores injected
    // locks (i.e. still calls the real store fns) can't hang the suite.
    deps.shouldStop = () => attempts >= 3 || deps.sleeps.length >= 10;
    await runWatchdogLoop(wd as never, deps as never);
    expect(attempts).toBe(3);
    const s = readSchedulerState('nightwatch');
    expect(s.consecutiveFailures).toBe(3);
    expect(s.lastError).toBe('EACCES: lock dir');
  });

  it('the tick that transitions into hold-down sleeps heldPollMs, not the backoff delay (review #2)', async () => {
    const deps = world({ results: ['error', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    expect(deps.sleeps[2]).toBe(5_000);   // would be 2_400_000 (4x backoff) pre-fix
  });

  it('a skip tick during an active failure streak keeps the backoff cadence, not the raw interval (review #3, pinned deviation)', async () => {
    writeSchedulerState('nightwatch', { version: 1, consecutiveFailures: 2, heldDown: false });
    acquireRunLock('nightwatch');
    const deps = world({ results: [] });
    deps.shouldStop = () => deps.sleeps.length >= 1;
    await runWatchdogLoop(wd as never, deps as never);
    releaseRunLock('nightwatch');
    expect(deps.sleeps).toEqual([1_200_000]);   // 2x interval: watchdogBackoffMs(600_000, 2)
    expect(readSchedulerState('nightwatch').consecutiveFailures).toBe(2);
  });

  it('three consecutive thrown runs also trip the hold-down circuit, proving throws count as failures (review #4)', async () => {
    const deps = world({ results: ['throw', 'throw', 'throw'] });
    await runWatchdogLoop(wd as never, deps as never);
    const s = readSchedulerState('nightwatch');
    expect(s.heldDown).toBe(true);
    expect(s.lastError).toBe('spawn failed');
    expect(deps.alerts).toHaveLength(1);
  });

  it('a hold-down transition with ledger.heldDownAlerted already true fires no alert (durable "once per state change", spec §5.5)', async () => {
    writeLedger('nightwatch', { version: 1, open: {}, heldDownAlerted: true });
    const deps = world({ results: ['error', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    expect(readSchedulerState('nightwatch').heldDown).toBe(true);
    expect(deps.alerts).toHaveLength(0);   // guard held, so onSchedulerAlert never fired
  });

  it('a fresh hold-down transition sets ledger.heldDownAlerted after alerting', async () => {
    const deps = world({ results: ['error', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    expect(deps.alerts).toHaveLength(1);
    expect(readLedger('nightwatch').heldDownAlerted).toBe(true);
  });

  it('resetSchedulerState clears ledger.heldDownAlerted, so a later hold-down alerts again', async () => {
    writeLedger('nightwatch', { version: 1, open: {}, heldDownAlerted: true });
    resetSchedulerState('nightwatch');
    expect(readLedger('nightwatch').heldDownAlerted).toBe(false);

    const deps = world({ results: ['error', 'error', 'error'] });
    await runWatchdogLoop(wd as never, deps as never);
    expect(deps.alerts).toHaveLength(1);   // alerts again after the reset cleared the flag
  });

  it('the default onSchedulerAlert (no override) invokes the injected notifierRun hook with the alert text', async () => {
    const deps = world({ results: ['error', 'error', 'error'] });
    delete (deps as { onSchedulerAlert?: unknown }).onSchedulerAlert;
    const calls: Array<{ name: string; text: string }> = [];
    (deps as unknown as { notifierRun: (wd: { name: string }, text: string, d: unknown) => Promise<void> }).notifierRun =
      async (w, text) => { calls.push({ name: w.name, text }); };
    await runWatchdogLoop(wd as never, deps as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('nightwatch');
    expect(calls[0].text).toMatch(/held down after 3/);
  });
});

describe('runScheduler threads its loaded cfg through to run + notifier deps (final review #1)', () => {
  const cfgPath = () => join(dir, 'fleet.yaml');
  const writeCfgFile = () => writeFileSync(cfgPath(),
    'roles:\n  Alice: {}\nwatchdogs:\n  nightwatch: { coordinator: FleetCoordinator }\n');

  it('passes the scheduler-loaded cfg into runOnceFor\'s deps, not the default loadConfig() fallback', async () => {
    writeCfgFile();
    const expectedCfg = loadConfig(cfgPath());
    let seenCfg: unknown;
    let calls = 0;
    const deps = {
      now: () => new Date(), sleep: async () => {}, log: () => {}, binPath: '/bin/false',
      shouldStop: () => calls >= 1,
      runOnceFor: async (w: { name: string }, runDeps: { cfg?: unknown }) => {
        calls++;
        seenCfg = runDeps.cfg;
        return {
          report: errorReport({
            watchdog: w.name, run_id: formatRunId(new Date()),
            started_at: 'a', finished_at: 'b', error: 'x',
          }),
          storedPath: '',
        };
      },
    };
    await runScheduler(cfgPath(), deps as never);
    expect(seenCfg).toEqual(expectedCfg);
  });

  it('passes the scheduler-loaded cfg into the default onSchedulerAlert/notifierRun path', async () => {
    writeCfgFile();
    const expectedCfg = loadConfig(cfgPath());
    let seenCfg: unknown;
    let notifierCalled = false;
    const deps = {
      now: () => new Date(), sleep: async () => {}, log: () => {}, binPath: '/bin/false',
      shouldStop: () => notifierCalled,
      runOnceFor: async (w: { name: string }) => ({
        report: {
          ...errorReport({
            watchdog: w.name, run_id: formatRunId(new Date()),
            started_at: 'a', finished_at: 'b', error: 'boom',
          }),
          status: 'error',
        },
        storedPath: '',
      }),
      notifierRun: async (_w: unknown, _text: string, runDeps: { cfg?: unknown }) => {
        seenCfg = runDeps.cfg;
        notifierCalled = true;
      },
    };
    await runScheduler(cfgPath(), deps as never);
    expect(seenCfg).toEqual(expectedCfg);
  });
});

describe('runScheduler recovers a run lock at startup, but only when it is demonstrably stale (finding #2)', () => {
  const writeCfg = () => writeFileSync(join(dir, 'fleet.yaml'),
    'roles:\n  Alice: {}\nwatchdogs:\n  nightwatch: { coordinator: FleetCoordinator }\n');

  it('reclaims a lock whose owner pid is dead, so a SIGKILLed prior run does not wedge scheduling forever', async () => {
    writeCfg();
    // Simulate a stale lock left by a SIGKILLed prior run: a lock dir whose
    // owner.json names a pid that is no longer alive (acquireRunLock itself
    // always stamps our OWN — live — pid, so it can't be used to construct
    // this fixture; the owner file has to be written directly).
    const lockDir = join(watchdogDir('nightwatch'), '.run-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));
    const deps = {
      now: () => new Date(), sleep: async () => {}, log: () => {}, binPath: '/bin/false',
      shouldStop: () => true, // never actually tick — only prove the startup sweep ran
    };
    await runScheduler(join(dir, 'fleet.yaml'), deps as never);
    expect(acquireRunLock('nightwatch')).toBe(true); // lock was reclaimed; re-acquirable
    releaseRunLock('nightwatch');
  });

  it('reclaims a legacy lock dir with no owner.json (pre-finding-#2 locks)', async () => {
    writeCfg();
    mkdirSync(join(watchdogDir('nightwatch'), '.run-lock'), { recursive: true });
    const deps = {
      now: () => new Date(), sleep: async () => {}, log: () => {}, binPath: '/bin/false',
      shouldStop: () => true,
    };
    await runScheduler(join(dir, 'fleet.yaml'), deps as never);
    expect(acquireRunLock('nightwatch')).toBe(true);
    releaseRunLock('nightwatch');
  });

  it('does NOT clear a lock held by a live process — a foreground watchdog-run (or another scheduler) must survive a scheduler restart', async () => {
    writeCfg();
    acquireRunLock('nightwatch'); // owner.json now names THIS (alive) process's pid
    const logs: string[] = [];
    let sleeps = 0;
    const deps = {
      now: () => new Date(), sleep: async () => { sleeps += 1; }, log: (l: string) => logs.push(l),
      binPath: '/bin/false',
      shouldStop: () => sleeps >= 1,   // one tick (the skip) is enough to prove the point
      // If the startup sweep wrongly cleared the live lock (pre-fix behavior), the loop
      // would reach here instead of observing the lock still held and skipping.
      runOnceFor: async () => { throw new Error('must not have run: lock was live'); },
    };
    await runScheduler(join(dir, 'fleet.yaml'), deps as never);
    // The lock is untouched: still acquirable only after we release it ourselves.
    expect(acquireRunLock('nightwatch')).toBe(false);
    expect(logs.some(l => /run lock held by live pid \d+ — not reclaimed/.test(l))).toBe(true);
    releaseRunLock('nightwatch');
    // And the tick that ran against the still-held lock recorded skipped_overlap,
    // exactly as an ordinary overlap would — never the thrown "must not have run".
    expect(listRuns('nightwatch')[0]?.error).toBe('skipped_overlap');
  });
});

describe('resetSchedulerState reclaims the run lock too, but only if stale (final review #2b, tightened by finding #2)', () => {
  it('an operator restart of a held-down watchdog clears a STALE lock, not just the failure/hold-down state', () => {
    const lockDir = join(watchdogDir('nightwatch'), '.run-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));
    resetSchedulerState('nightwatch');
    expect(acquireRunLock('nightwatch')).toBe(true);
    releaseRunLock('nightwatch');
  });

  it('does NOT clear a lock held by a live process', () => {
    acquireRunLock('nightwatch');
    resetSchedulerState('nightwatch');
    expect(acquireRunLock('nightwatch')).toBe(false);   // still held — reset must not have reclaimed it
    releaseRunLock('nightwatch');
  });
});
