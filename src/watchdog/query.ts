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

/** Shared configured-or-surviving-history addressability rule. */
export function watchdogAddressable(
  name: string,
  configured: readonly string[],
  historyExists: (validName: string) => boolean =
    validName => existsSync(join(watchdogsRoot(), validName)),
): boolean {
  if (configured.includes(name)) return true;
  return ROLE_NAME_RE.test(name) && historyExists(name);
}

/**
 * Needs-attention integration: worst current finding per role across
 * every configured watchdog, for FleetQueryService.status() to fold into a
 * role's problems. An `error`-status report carries no role evidence (the run
 * itself failed) so it's skipped outright, matching alerts.ts's
 * reconcileLedger rule. Healthy/idle findings (rank 0) never surface here —
 * only actionable anomalies do. "Worst" is decided by WATCHDOG_STATUS_RANK;
 * ties keep whichever watchdog was seen first. Takes `latestReport` as a
 * parameter (rather than importing store.ts directly) so it stays a pure,
 * disk-free function for unit testing; runtime.ts wires the real store.
 *
 * Skips disabled watchdogs: a watchdog turned off in config
 * still has its last stored report sitting on disk, and without this check
 * that stale report's findings would pin roles in "Needs attention" forever
 * — an operator disabling a noisy/broken watchdog has no way to make the
 * findings it already produced go away.
 */
export function buildWatchdogFindings(
  cfg: { watchdogs: Array<{ name: string; enabled: boolean }> },
  latestReport: (name: string) => WatchdogReport | undefined,
): Map<string, WatchdogRoleFinding> {
  const findings = new Map<string, WatchdogRoleFinding>();
  for (const wd of cfg.watchdogs) {
    if (!wd.enabled) continue;
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

/**
 * Memoizes a findings-map builder with a short TTL (mirrors runtime.ts's
 * cachedConfigProvider pattern). status() calls its injected watchdogFindings
 * provider once per role, so an unmemoized thunk turns a single list() sweep
 * into O(roles x watchdogs) disk reads, repeated every 1-3s of console
 * polling. `now` is injectable (defaults to Date.now) so the TTL boundary is
 * unit-testable without real timers.
 */
export function cachedWatchdogFindingsProvider(
  build: () => Map<string, WatchdogRoleFinding>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Map<string, WatchdogRoleFinding> {
  let cached: { at: number; value: Map<string, WatchdogRoleFinding> } | undefined;
  return () => {
    const at = now();
    if (!cached || at - cached.at >= ttlMs) cached = { at, value: build() };
    return cached.value;
  };
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
    if (watchdogAddressable(name, cfg.watchdogs.map(wd => wd.name))) return;
    throw new FleetError('role_not_found', `no such watchdog '${name}'`);
  }
}
