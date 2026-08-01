import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import type { FleetConfig } from '../config.js';
import type { ResolvedWatchdog } from './config.js';
import { errorReport } from './report.js';
import { executeNotifierRun, executeWatchdogRun, type WatchdogRunOutcome } from './run.js';
import { acquireRunLock, formatRunId, releaseRunLock, watchdogDir, writeReport } from './store.js';
import { readLedger, writeLedger } from './alerts.js';

const STATE_FILE = 'state.json';

export interface WatchdogSchedulerState {
  version: 1; consecutiveFailures: number; heldDown: boolean; heldSince?: string;
  lastRunAt?: string; nextRunAt?: string; lastError?: string;
}

const cleanState = (): WatchdogSchedulerState => ({ version: 1, consecutiveFailures: 0, heldDown: false });

/** Read a watchdog's scheduler state; a missing or corrupt file starts clean (mirrors readRestartLedger). */
export function readSchedulerState(name: string): WatchdogSchedulerState {
  try {
    const raw = JSON.parse(readFileSync(join(watchdogDir(name), STATE_FILE), 'utf8')) as Partial<WatchdogSchedulerState>;
    if (raw.version !== 1) return cleanState();
    return { ...cleanState(), ...raw, version: 1 };
  } catch {
    return cleanState();
  }
}

/** Write never throws: scheduler diagnostics must never take the loop down. */
export function writeSchedulerState(name: string, s: WatchdogSchedulerState): void {
  try {
    writeFileSync(join(watchdogDir(name), STATE_FILE), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  } catch { /* diagnostics must never take the loop down */ }
}

/**
 * Operator release (Task 15): clears failures and heldDown so a held-down
 * loop's next held-down poll sees a clean state and resumes running. Also
 * clears the ledger's `heldDownAlerted` flag — that flag is what makes "alert
 * once per hold-down" durable across scheduler restarts (it lives in
 * alerts.json, not state.json), so a release must reset it too or a
 * subsequent hold-down would silently alert zero times.
 *
 * Also releases the run lock (final review #2): a watchdog SIGKILLed mid-run
 * (e.g. systemd's TimeoutStopSec on a fleet-wide stop) leaves `.run-lock`
 * behind forever — the loop's `finally` that would normally release it never
 * runs. Without this, every future tick sees the lock held and reports
 * `skipped_overlap` indefinitely, and skips never alert. `ours-fleet restart
 * <watchdog>` is the documented recovery, so it must clear the lock too, not
 * just the failure/hold-down bookkeeping. Best-effort: a release failure here
 * must not turn an operator's recovery action into a crash.
 */
export function resetSchedulerState(name: string): void {
  writeSchedulerState(name, cleanState());
  const ledger = readLedger(name);
  if (ledger.heldDownAlerted) writeLedger(name, { ...ledger, heldDownAlerted: false });
  try { releaseRunLock(name); } catch { /* best effort */ }
}

export const WATCHDOG_HOLD_THRESHOLD = 3;
export const WATCHDOG_BACKOFF_MAX_MS = 3_600_000;

/** Bounded exponential backoff: 1x, 2x, 4x, ... capped at WATCHDOG_BACKOFF_MAX_MS (spec §3). */
export function watchdogBackoffMs(intervalMs: number, failures: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** (failures - 1), WATCHDOG_BACKOFF_MAX_MS);
}

export interface SchedulerDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  binPath: string;
  /**
   * The fleet config `runScheduler` loaded from the `-c FILE`/default path
   * (final review #1). Threaded into both `runOnceFor`'s and the notifier's
   * deps so a run under a non-default config doesn't silently fall back to
   * `loadConfig()`'s default `~/fleet.yaml`. `runWatchdogLoop` callers that
   * bypass `runScheduler` (tests) may omit it — the run/notifier machinery
   * falls back to `loadConfig()` itself when `cfg` is undefined.
   */
  cfg?: FleetConfig;
  /** Injectable for tests. */
  runOnceFor?: typeof executeWatchdogRun;
  /** Loop exit for tests + SIGTERM (wired by the CLI, not here). */
  shouldStop?(): boolean;
  /**
   * Scheduler-level alert hook (Task 14, spec §5.5): fired once per hold-down
   * transition (guarded in `settle` by `ledger.heldDownAlerted`, cleared by
   * `resetSchedulerState`). Default: `executeNotifierRun` — the fleet
   * process can't message on its own (deviation 4), so the default delivers
   * the alert via a one-shot notifier agent under the watchdog's identity.
   */
  onSchedulerAlert?(wd: ResolvedWatchdog, text: string): Promise<void>;
  /**
   * Injectable notifier launcher backing the default `onSchedulerAlert` —
   * consulted only when `onSchedulerAlert` itself is not supplied. Default:
   * `executeNotifierRun`. Lets tests observe/short-circuit the default alert
   * path (binPath/log/now/sleep wiring) without replacing onSchedulerAlert
   * wholesale.
   */
  notifierRun?: typeof executeNotifierRun;
  /** Poll cadence while held down. Default 5000. */
  heldPollMs?: number;
  /**
   * Injectable run-lock primitives. Default: store's acquireRunLock /
   * releaseRunLock. Both are mkdir/rmdir-backed and can throw (EACCES, EIO,
   * ENOTEMPTY on release) — the loop always classifies such a throw as a
   * failed tick rather than letting it escape (review finding #1).
   */
  locks?: { acquire(name: string): boolean; release(name: string): void };
}

/**
 * One watchdog's scheduling loop: run immediately, then repeatedly sleep the
 * backed-off interval and run again, until `shouldStop()`. No overlap (a run
 * lock guards each attempt), bounded exponential backoff on failure, and a
 * hold-down circuit breaker after WATCHDOG_HOLD_THRESHOLD consecutive
 * failures (released externally via resetSchedulerState).
 */
export async function runWatchdogLoop(wd: ResolvedWatchdog, deps: SchedulerDeps): Promise<void> {
  const runOnceFor = deps.runOnceFor ?? executeWatchdogRun;
  const shouldStop = deps.shouldStop ?? (() => false);
  const notifierRun = deps.notifierRun ?? executeNotifierRun;
  const onSchedulerAlert = deps.onSchedulerAlert ?? ((wd, text) => notifierRun(wd, text, {
    binPath: deps.binPath, log: deps.log, now: deps.now, sleep: deps.sleep, cfg: deps.cfg,
  }));
  const heldPollMs = deps.heldPollMs ?? 5_000;
  const locks = deps.locks ?? { acquire: acquireRunLock, release: releaseRunLock };

  /**
   * Apply one tick's outcome to state.json: update the failure streak,
   * transition into hold-down on the Nth consecutive failure (firing the
   * alert at most once per transition via the ledger's `heldDownAlerted`
   * guard — durable across restarts, unlike an in-memory flag), then sleep
   * before the next tick. On the tick that transitions into hold-down, sleep
   * `heldPollMs` rather than the (possibly hour-long) backoff delay — an
   * operator's resetSchedulerState must be noticed within one poll cycle,
   * not after the last backoff finishes (review finding #2).
   */
  const settle = async (isFailure: boolean, errorMessage: string | undefined, startedAt: Date): Promise<void> => {
    const s = readSchedulerState(wd.name);
    if (isFailure) {
      s.consecutiveFailures += 1;
      s.lastError = errorMessage;
    } else {
      s.consecutiveFailures = 0;
      s.lastError = undefined;
    }
    s.lastRunAt = startedAt.toISOString();

    let justHeld = false;
    if (s.consecutiveFailures >= WATCHDOG_HOLD_THRESHOLD && !s.heldDown) {
      s.heldDown = true;
      s.heldSince = deps.now().toISOString();
      justHeld = true;
    }

    const delay = justHeld ? heldPollMs : watchdogBackoffMs(wd.intervalMs, s.consecutiveFailures);
    s.nextRunAt = new Date(deps.now().getTime() + delay).toISOString();
    writeSchedulerState(wd.name, s);

    if (justHeld) {
      const msg = `watchdog ${wd.name} held down after ${WATCHDOG_HOLD_THRESHOLD} consecutive failed runs: ${s.lastError}`;
      deps.log(msg);
      // "Once per state change" (spec §5.5) must survive a scheduler restart, so the guard
      // lives in the ledger (alerts.json), not in memory — resetSchedulerState clears it.
      const ledger = readLedger(wd.name);
      if (!ledger.heldDownAlerted) {
        await onSchedulerAlert(wd, msg);
        writeLedger(wd.name, { ...ledger, heldDownAlerted: true });
      }
    }

    await deps.sleep(delay);
  };

  for (;;) {
    if (shouldStop()) return;

    if (readSchedulerState(wd.name).heldDown) {
      await deps.sleep(heldPollMs);
      if (shouldStop()) return;
      continue;
    }

    const tickStart = deps.now();

    // The run-lock is a filesystem mutex (mkdir/rmdir) and can throw
    // (EACCES, EIO, ENOTEMPTY on release — store.ts's release deliberately
    // rethrows non-ENOENT failures). Never let that throw escape this loop:
    // runScheduler drives every watchdog's loop via Promise.all, so an
    // uncaught throw here would kill every OTHER watchdog's loop too.
    // Classify it as this tick's failure instead (review finding #1).
    let acquired = false;
    let acquireError: string | undefined;
    try {
      acquired = locks.acquire(wd.name);
    } catch (e) {
      acquireError = e instanceof Error ? e.message : String(e);
    }

    if (acquireError !== undefined) {
      await settle(true, acquireError, tickStart);
      if (shouldStop()) return;
      continue;
    }

    if (!acquired) {
      writeReport(wd.name, errorReport({
        watchdog: wd.name, run_id: formatRunId(tickStart),
        started_at: tickStart.toISOString(), finished_at: tickStart.toISOString(),
        error: 'skipped_overlap',
      }));
      deps.log(`watchdog ${wd.name}: skipped run (previous run still holds the lock)`);
      // Failure count is untouched by a skip; only lastRunAt/nextRunAt move.
      // The backoff cadence (not the raw interval) still governs during an
      // active failure streak: a skip isn't a finished run, so it shouldn't
      // reset the retry cadence to full speed either (spec §3).
      const skipState = readSchedulerState(wd.name);
      const delay = watchdogBackoffMs(wd.intervalMs, skipState.consecutiveFailures);
      writeSchedulerState(wd.name, {
        ...skipState,
        lastRunAt: tickStart.toISOString(),
        nextRunAt: new Date(tickStart.getTime() + delay).toISOString(),
      });
      await deps.sleep(delay);
      if (shouldStop()) return;
      continue;
    }

    let outcome: WatchdogRunOutcome | undefined;
    let tickError: string | undefined;
    try {
      outcome = await runOnceFor(wd, {
        binPath: deps.binPath, log: deps.log, now: deps.now, sleep: deps.sleep, cfg: deps.cfg,
      });
    } catch (e) {
      tickError = e instanceof Error ? e.message : String(e);
    } finally {
      // Same "never escape" rule applies to release: fold a throw into this
      // tick's failure rather than letting it propagate out of the loop.
      try {
        locks.release(wd.name);
      } catch (e) {
        tickError = tickError ?? (e instanceof Error ? e.message : String(e));
      }
    }

    let errorMessage: string | undefined;
    if (outcome === undefined) {
      errorMessage = tickError;
    } else if (outcome.report.status === 'error' && outcome.report.error !== 'skipped_overlap') {
      errorMessage = outcome.report.error ?? tickError ?? 'unknown error';
    } else {
      errorMessage = tickError;
    }

    await settle(errorMessage !== undefined, errorMessage, tickStart);
    if (shouldStop()) return;
  }
}

/**
 * Run every enabled watchdog's loop concurrently until deps.shouldStop().
 * SIGTERM wiring into shouldStop is the CLI's job (Task 10), not this
 * function's.
 */
export async function runScheduler(configPath: string | undefined, deps: SchedulerDeps): Promise<void> {
  const cfg = loadConfig(configPath);
  const watchdogs = cfg.watchdogs.filter(w => w.enabled);
  const locks = deps.locks ?? { acquire: acquireRunLock, release: releaseRunLock };
  // Recover from a SIGKILLed prior run (final review #2a): a scheduler
  // restart is proof no scheduler-owned run is in flight for any of these
  // watchdogs, so any `.run-lock` still on disk is stale — left behind by a
  // process that never reached its `finally`. Without this sweep the lock
  // survives forever and every future tick reports `skipped_overlap`, which
  // never alerts and never counts as a failure either. Best-effort: a
  // release failure here must not prevent the scheduler from starting.
  for (const wd of watchdogs) {
    try { locks.release(wd.name); } catch { /* best effort */ }
  }
  await Promise.all(watchdogs.map(wd => runWatchdogLoop(wd, { ...deps, cfg })));
}
