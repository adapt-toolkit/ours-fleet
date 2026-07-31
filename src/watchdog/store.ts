import { chmodSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchdogsRoot } from '../paths.js';
import type { WatchdogReport, WatchdogReportStatus } from './report.js';

const RUN_ID_RE = /^\d{8}T\d{6}Z$/;
const REPORT_FILE_RE = /^\d{8}T\d{6}Z\.json$/;

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

export function watchdogDir(name: string): string {
  return ensureDir(join(watchdogsRoot(), name));
}

export function reportsDir(name: string): string {
  return ensureDir(join(watchdogDir(name), 'reports'));
}

function runLockPath(name: string): string {
  return join(watchdogDir(name), '.run-lock');
}

/**
 * mkdir-as-mutex: atomic across processes, unlike a lock file (open+O_EXCL
 * would work too, but a directory needs no cleanup of file contents and
 * can't be partially written). EEXIST means another run holds it.
 */
export function acquireRunLock(name: string): boolean {
  try {
    mkdirSync(runLockPath(name));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** Release-tolerant of absence: a lock already gone (or never acquired) is not an error. */
export function releaseRunLock(name: string): void {
  try { rmdirSync(runLockPath(name)); } catch { /* already gone */ }
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
