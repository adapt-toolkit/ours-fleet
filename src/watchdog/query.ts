import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FleetError } from '../application/errors.js';
import { ROLE_NAME_RE, type FleetConfig } from '../config.js';
import { watchdogsRoot } from '../paths.js';
import { WATCHDOG_STATUS_RANK } from './alerts.js';
import type { WatchdogReport, WatchdogRoleStatus } from './report.js';
import { readSchedulerState } from './scheduler.js';
import { listRuns, readReport, type RunListEntry } from './store.js';

export interface WatchdogRoleFinding { watchdog: string; status: WatchdogRoleStatus; reason: string }

/**
 * Needs-attention integration (Task 19): worst current finding per role across
 * every configured watchdog, for FleetQueryService.status() to fold into a
 * role's problems. An `error`-status report carries no role evidence (the run
 * itself failed) so it's skipped outright, matching alerts.ts's
 * reconcileLedger rule. Healthy/idle findings (rank 0) never surface here —
 * only actionable anomalies do. "Worst" is decided by WATCHDOG_STATUS_RANK;
 * ties keep whichever watchdog was seen first. Takes `latestReport` as a
 * parameter (rather than importing store.ts directly) so it stays a pure,
 * disk-free function for unit testing; runtime.ts wires the real store.
 */
export function buildWatchdogFindings(
  cfg: { watchdogs: Array<{ name: string }> },
  latestReport: (name: string) => WatchdogReport | undefined,
): Map<string, WatchdogRoleFinding> {
  const findings = new Map<string, WatchdogRoleFinding>();
  for (const wd of cfg.watchdogs) {
    const report = latestReport(wd.name);
    if (!report || report.status === 'error') continue;
    for (const finding of report.roles) {
      const rank = WATCHDOG_STATUS_RANK[finding.status];
      if (rank <= 0) continue;
      const existing = findings.get(finding.role);
      if (existing && WATCHDOG_STATUS_RANK[existing.status] >= rank) continue;
      findings.set(finding.role, { watchdog: wd.name, status: finding.status, reason: finding.reason ?? '' });
    }
  }
  return findings;
}

export interface WatchdogSummary {
  name: string; enabled: boolean; heldDown: boolean; heldSince: string | null; intervalMs: number;
  coordinator: string; watch: string[];
  lastRunAt: string | null; nextRunAt: string | null;
  latest: RunListEntry | null;
}

const DEFAULT_REPORTS_LIMIT = 50;
const MAX_REPORTS_LIMIT = 500;

/**
 * Read-only view over watchdog config + on-disk scheduler state + stored
 * reports, for the authenticated web console. Never mutates: `list()` reads
 * config plus `readSchedulerState`/`listRuns` (both already tolerant of a
 * corrupt/missing state.json or an empty/nonexistent reports dir, per
 * store.ts and scheduler.ts), and `reports()`/`report()` reject unknown
 * watchdog names before touching disk.
 */
export class WatchdogQueryService {
  constructor(private readonly cfgProvider: () => FleetConfig) {}

  list(): { watchdogs: WatchdogSummary[] } {
    const cfg = this.cfgProvider();
    const watchdogs = cfg.watchdogs.map((wd): WatchdogSummary => {
      const state = readSchedulerState(wd.name);
      const [latest = null] = listRuns(wd.name);
      return {
        name: wd.name, enabled: wd.enabled, heldDown: state.heldDown, heldSince: state.heldSince ?? null,
        intervalMs: wd.intervalMs,
        coordinator: wd.coordinator, watch: wd.watch,
        lastRunAt: state.lastRunAt ?? null, nextRunAt: state.nextRunAt ?? null,
        latest,
      };
    });
    return { watchdogs };
  }

  reports(name: string, limit: number = DEFAULT_REPORTS_LIMIT): { runs: RunListEntry[] } {
    this.requireKnown(name);
    const n = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_REPORTS_LIMIT;
    const clamped = Math.min(Math.max(n, 1), MAX_REPORTS_LIMIT);
    return { runs: listRuns(name).slice(0, clamped) };
  }

  report(name: string, runId: string): WatchdogReport {
    this.requireKnown(name);
    // readReport parses the stored file with JSON.parse and returns the parsed object;
    // fastify re-serializes it for the HTTP response, so what's actually verifiable (and
    // what the tests assert) is deep equality with the stored JSON, not byte-for-byte
    // identity of the response bytes against the file on disk.
    const found = readReport(name, runId);
    if (!found) throw new FleetError('role_not_found', `no such report '${runId}' for watchdog '${name}'`);
    return found;
  }

  /**
   * Known means: configured today, OR a store directory already exists for a
   * watchdog that used to be configured (its history should stay readable).
   * The regex check runs before any filesystem lookup so a hostile `name`
   * (path separators, '..', etc.) can never reach `join(watchdogsRoot(), name)`.
   */
  private requireKnown(name: string): void {
    const cfg = this.cfgProvider();
    if (cfg.watchdogs.some(wd => wd.name === name)) return;
    if (ROLE_NAME_RE.test(name) && existsSync(join(watchdogsRoot(), name))) return;
    throw new FleetError('role_not_found', `no such watchdog '${name}'`);
  }
}
