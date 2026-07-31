import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import type { ResolvedWatchdog } from './config.js';
import { errorReport } from './report.js';
import { executeWatchdogRun, type WatchdogRunOutcome } from './run.js';
import { acquireRunLock, formatRunId, releaseRunLock, watchdogDir, writeReport } from './store.js';

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
 * loop's next held-down poll sees a clean state and resumes running.
 */
export function resetSchedulerState(name: string): void {
  writeSchedulerState(name, cleanState());
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
  /** Injectable for tests. */
  runOnceFor?: typeof executeWatchdogRun;
  /** Loop exit for tests + SIGTERM (wired by the CLI, not here). */
  shouldStop?(): boolean;
  /** Phase 2 hook; default no-op. */
  onSchedulerAlert?(wd: ResolvedWatchdog, text: string): Promise<void>;
  /** Poll cadence while held down. Default 5000. */
  heldPollMs?: number;
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
  const onSchedulerAlert = deps.onSchedulerAlert ?? (async () => {});
  const heldPollMs = deps.heldPollMs ?? 5_000;

  for (;;) {
    if (shouldStop()) return;

    if (readSchedulerState(wd.name).heldDown) {
      await deps.sleep(heldPollMs);
      if (shouldStop()) return;
      continue;
    }

    if (!acquireRunLock(wd.name)) {
      const t = deps.now();
      writeReport(wd.name, errorReport({
        watchdog: wd.name, run_id: formatRunId(t),
        started_at: t.toISOString(), finished_at: t.toISOString(),
        error: 'skipped_overlap',
      }));
      deps.log(`watchdog ${wd.name}: skipped run (previous run still holds the lock)`);
      // Failure count is untouched by a skip; only lastRunAt/nextRunAt move.
      const skipState = readSchedulerState(wd.name);
      const delay = watchdogBackoffMs(wd.intervalMs, skipState.consecutiveFailures);
      writeSchedulerState(wd.name, {
        ...skipState,
        lastRunAt: t.toISOString(),
        nextRunAt: new Date(t.getTime() + delay).toISOString(),
      });
      await deps.sleep(delay);
      if (shouldStop()) return;
      continue;
    }

    const startedAt = deps.now();
    let outcome: WatchdogRunOutcome | undefined;
    let thrownMessage: string | undefined;
    try {
      try {
        outcome = await runOnceFor(wd, {
          binPath: deps.binPath, log: deps.log, now: deps.now, sleep: deps.sleep,
        });
      } catch (e) {
        thrownMessage = e instanceof Error ? e.message : String(e);
      }
    } finally {
      releaseRunLock(wd.name);
    }

    const isFailure = outcome === undefined
      ? true
      : outcome.report.status === 'error' && outcome.report.error !== 'skipped_overlap';

    const s = readSchedulerState(wd.name);
    if (isFailure) {
      s.consecutiveFailures += 1;
      s.lastError = outcome ? (outcome.report.error ?? thrownMessage ?? 'unknown error') : thrownMessage;
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

    const delay = watchdogBackoffMs(wd.intervalMs, s.consecutiveFailures);
    s.nextRunAt = new Date(deps.now().getTime() + delay).toISOString();
    writeSchedulerState(wd.name, s);

    if (justHeld) {
      const msg = `watchdog ${wd.name} held down after ${WATCHDOG_HOLD_THRESHOLD} consecutive failed runs: ${s.lastError}`;
      deps.log(msg);
      await onSchedulerAlert(wd, msg);
    }

    await deps.sleep(delay);
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
  await Promise.all(watchdogs.map(wd => runWatchdogLoop(wd, deps)));
}
