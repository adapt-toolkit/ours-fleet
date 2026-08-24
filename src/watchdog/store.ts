import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { watchdogsRoot } from '../paths.js';
// store.ts imports config.ts (ROLE_NAME_RE) but not the reverse — config.ts's
// import graph (config-yaml, isolation/policy, harness/registry, watchdog/config)
// never reaches back into watchdog/store.ts, so this does not create a cycle.
import { ROLE_NAME_RE } from '../config.js';
import type { WatchdogReport, WatchdogReportStatus } from './report.js';

const RUN_ID_RE = /^\d{8}T\d{6}Z$/;
const REPORT_FILE_RE = /^\d{8}T\d{6}Z\.json$/;
/**
 * A lock directory briefly exists before acquireRunLock can rename its
 * prewritten owner.json into it. Missing/corrupt owner metadata is therefore
 * reclaimable only after this grace period, never while that acquisition
 * window may still be in progress.
 */
export const RUN_LOCK_OWNER_GRACE_MS = 10_000;

/**
 * mkdirSync's `mode` is masked by the process umask and ignored outright when
 * the directory already exists, so an explicit chmod after mkdir is the only
 * way to guarantee 0700 regardless of umask or prior state.
 */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Choke point every other helper in this module goes through to reach a
 * watchdog's on-disk state. Validates `name` BEFORE any join/mkdir (defense
 * in depth): a caller that forgets its own ROLE_NAME_RE guard
 * (as the CLI's `watchdogKnown` once did) must not be able to turn an
 * unvalidated `name` into `join(watchdogsRoot(), '../../victim')` and mkdir
 * an arbitrary path on disk.
 */
export function watchdogDir(name: string): string {
  if (!ROLE_NAME_RE.test(name)) throw new Error(`invalid watchdog name '${name}'`);
  return ensureDir(join(watchdogsRoot(), name));
}

export function reportsDir(name: string): string {
  return ensureDir(join(watchdogDir(name), 'reports'));
}

function runLockPath(name: string): string {
  return join(watchdogDir(name), '.run-lock');
}

function runLockOwnerPath(name: string): string {
  return join(runLockPath(name), 'owner.json');
}

export interface RunLockOwner { pid: number; at: string }

/**
 * mkdir-as-mutex: atomic across processes, unlike a lock file (open+O_EXCL
 * would work too, but a directory needs no cleanup of file contents and
 * can't be partially written). EEXIST means another run holds it.
 *
 * Stamps `owner.json` with our pid: ownership metadata is what
 * lets a later `reclaimStaleRunLock` tell a lock abandoned by a dead process
 * apart from one genuinely held by a live run. A naive "mkdir, then
 * writeFileSync(owner.json)" leaves an unnecessarily wide window —
 * between the mkdir succeeding and the write landing — where the lock dir
 * exists but owner.json doesn't yet. A `reclaimStaleRunLock` call from
 * another process landing in exactly that window would see a lock with no
 * (or corrupt) owner metadata and treat a genuinely live lock as a legacy
 * one, reclaiming it out from under us. Do all slow work (building the JSON,
 * writing it, chmod) to a per-pid temp file BEFORE mkdir, then publish it with
 * one rename. There is still an unavoidable interval between those two
 * syscalls; reclaimStaleRunLock protects it by treating a fresh ownerless lock
 * as held for RUN_LOCK_OWNER_GRACE_MS. The temp file is unique per-pid (this
 * function is synchronous, so there's no same-process concurrent-call hazard
 * either) and is cleaned up if mkdir loses the race.
 */
export function acquireRunLock(name: string): boolean {
  const dir = watchdogDir(name);
  const owner: RunLockOwner = { pid: process.pid, at: new Date().toISOString() };
  const tempOwnerPath = join(dir, `.owner.${process.pid}.tmp`);
  writeFileSync(tempOwnerPath, JSON.stringify(owner), { mode: 0o600 });
  chmodSync(tempOwnerPath, 0o600);
  try {
    mkdirSync(runLockPath(name));
  } catch (e) {
    try { unlinkSync(tempOwnerPath); } catch { /* best effort cleanup */ }
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  renameSync(tempOwnerPath, runLockOwnerPath(name));
  return true;
}

/**
 * Release-tolerant of absence: a lock already gone (or never acquired) is not
 * an error. Recursive because the lock dir now holds `owner.json` alongside
 * the mkdir mutex itself — a plain rmdir would fail ENOTEMPTY.
 */
export function releaseRunLock(name: string): void {
  try {
    rmSync(runLockPath(name), { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
}

/** Reads a run lock's owner metadata; missing or corrupt yields undefined. */
export function readRunLockOwner(name: string): RunLockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(runLockOwnerPath(name), 'utf8')) as Partial<RunLockOwner>;
    if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0 || typeof raw.at !== 'string') return undefined;
    return { pid: raw.pid as number, at: raw.at };
  } catch {
    return undefined;
  }
}

/** True iff `pid` names a live process. EPERM means the process exists but we can't signal it — still alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Only a demonstrably stale run lock may be
 * reclaimed — a lock is stale iff it isn't held at all, its owner metadata
 * names a dead pid, or its owner metadata is missing/corrupt AND the lock dir
 * is older than RUN_LOCK_OWNER_GRACE_MS. The age gate closes the interprocess
 * interval between acquireRunLock's mkdir and owner.json rename: a concurrent
 * scheduler sees a fresh ownerless lock as held, not stale. A live owner (a
 * foreground `watchdog-run`, another scheduler instance, an in-progress run)
 * is left strictly alone: reclaiming it would let two runs share the same temp
 * dir.
 * Returns true when the lock is (now) not held — whether because it was
 * already absent or because a stale lock was just removed; false when a live
 * lock was found and deliberately left in place.
 */
export function reclaimStaleRunLock(name: string): boolean {
  const path = runLockPath(name);
  if (!existsSync(path)) return true;
  const owner = readRunLockOwner(name);
  if (owner !== undefined && pidAlive(owner.pid)) return false;
  if (owner === undefined) {
    try {
      if (Date.now() - statSync(path).mtimeMs < RUN_LOCK_OWNER_GRACE_MS) return false;
    } catch (e) {
      // The holder may have released between existsSync and statSync.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw e;
    }
  }
  releaseRunLock(name);
  return true;
}

/** Lexical-chronological UTC run id, e.g. '20260731T115000Z'. */
export function formatRunId(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export interface RunListEntry {
  runId: string; status: WatchdogReportStatus; startedAt: string; finishedAt: string;
  summary: WatchdogReport['summary']; error: string | null;
}

const CORRUPT_SUMMARY = { checked: 0, healthy: 0, idle: 0, anomalies: 0 };

function reportPath(name: string, runId: string): string {
  return join(reportsDir(name), `${runId}.json`);
}

/** Newest-first run ids currently on disk, derived from filenames alone. */
function runIdsDesc(name: string): string[] {
  return readdirSync(reportsDir(name))
    .filter(f => REPORT_FILE_RE.test(f))
    .sort()
    .reverse()
    .map(f => f.slice(0, -'.json'.length));
}

export function writeReport(name: string, report: WatchdogReport): string {
  const path = reportPath(name, report.run_id);
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Newest-first run listing; a corrupt report file yields a synthetic 'error' entry rather than throwing. */
export function listRuns(name: string): RunListEntry[] {
  return runIdsDesc(name).map((runId): RunListEntry => {
    try {
      const report = JSON.parse(readFileSync(reportPath(name, runId), 'utf8')) as WatchdogReport;
      return {
        runId, status: report.status, startedAt: report.started_at, finishedAt: report.finished_at,
        summary: report.summary, error: report.error,
      };
    } catch {
      return { runId, status: 'error', startedAt: '', finishedAt: '', summary: CORRUPT_SUMMARY, error: 'unreadable report file' };
    }
  });
}

/** Reads one run's full report. Rejects non-conforming runIds (path-traversal guard) and corrupt files by returning undefined. */
export function readReport(name: string, runId: string): WatchdogReport | undefined {
  if (!RUN_ID_RE.test(runId)) return undefined;
  try {
    return JSON.parse(readFileSync(reportPath(name, runId), 'utf8')) as WatchdogReport;
  } catch {
    return undefined;
  }
}

export function latestReport(name: string): WatchdogReport | undefined {
  const [newest] = runIdsDesc(name);
  return newest === undefined ? undefined : readReport(name, newest);
}

/** Deletes all but the `keep` newest reports (oldest first); returns the number pruned. */
export function pruneReports(name: string, keep: number): number {
  const stale = runIdsDesc(name).slice(keep);
  for (const runId of stale) {
    try { unlinkSync(reportPath(name, runId)); } catch { /* best effort */ }
  }
  return stale.length;
}
