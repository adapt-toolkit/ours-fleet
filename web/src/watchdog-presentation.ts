// Pure presentation helpers for the Watchdogs console view. No React here —
// keep this module vitest-testable and free of DOM/component concerns
// (mirrors the fleet-presentation.ts convention in this repo).

export interface WatchdogLatestRunView {
  runId: string;
  status: 'ok' | 'anomalies' | 'error';
  startedAt: string;
  finishedAt: string;
  summary: { checked: number; healthy: number; idle: number; anomalies: number };
  error: string | null;
  /** Non-healthy roles from the latest report, when the caller has them (detail view). */
  anomalyRoles?: Array<{ role: string; status: string }>;
}

/** Client mirror of server-side WatchdogSummary (src/watchdog/query.ts), plus heldSince. */
export interface WatchdogSummaryView {
  name: string;
  enabled: boolean;
  heldDown: boolean;
  heldSince?: string | null;
  intervalMs: number;
  coordinator: string;
  watch: string[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  latest: WatchdogLatestRunView | null;
}

export function watchdogChip(w: WatchdogSummaryView): 'ready' | 'attention' | 'offline' {
  if (!w.enabled) return 'offline';
  if (w.heldDown) return 'attention';
  if (w.latest === null) return 'attention';
  if (w.latest.status === 'error') return 'attention';
  if (w.latest.summary.anomalies > 0) return 'attention';
  return 'ready';
}

export function watchdogLine(w: WatchdogSummaryView): string {
  if (w.heldDown) return `held down since ${w.heldSince ?? 'unknown'}.`;
  if (w.latest === null) return 'no runs yet.';
  if (w.latest.status === 'error') return `last run failed: ${w.latest.error}.`;
  const { checked, anomalies } = w.latest.summary;
  if (anomalies > 0) {
    if (w.latest.anomalyRoles) {
      const detail = w.latest.anomalyRoles.map(r => `${r.role} ${r.status}`).join(', ');
      return `${checked} checked, ${anomalies} ${anomalies === 1 ? 'anomaly' : 'anomalies'} (${detail}).`;
    }
    return `${checked} checked, ${anomalies} anomalies.`;
  }
  return `${checked} roles checked, all healthy.`;
}

// --- Detail-view types (client mirror of server-side src/watchdog/report.ts + store.ts) ---

export interface WatchdogEvidenceView { source: string; detail: string; observed_at: string }
export interface WatchdogFindingView {
  role: string; status: string; reason?: string;
  evidence?: WatchdogEvidenceView[]; alerted?: boolean;
}
export interface WatchdogAlertView { role: string; code: string; coordinator: string; sent_at: string }
export interface WatchdogReportView {
  schema_version: 1; watchdog: string; run_id: string;
  started_at: string; finished_at: string; status: 'ok' | 'anomalies' | 'error';
  summary: { checked: number; healthy: number; idle: number; anomalies: number };
  roles: WatchdogFindingView[]; alerts: WatchdogAlertView[]; error: string | null;
  tail?: string;
}
export interface RunListEntryView {
  runId: string; status: 'ok' | 'anomalies' | 'error'; startedAt: string; finishedAt: string;
  summary: { checked: number; healthy: number; idle: number; anomalies: number }; error: string | null;
}

/** '45s' under a minute, '1m 12s' (or '2m' on an exact boundary) at or above it; '-' when either timestamp is unparseable. */
export function runDuration(entry: { startedAt: string; finishedAt: string }): string {
  const started = Date.parse(entry.startedAt);
  const finished = Date.parse(entry.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return '-';
  const totalSeconds = Math.round(Math.max(0, finished - started) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * '' for healthy/idle findings (nothing to say). For a non-healthy finding:
 * the matching `report.alerts[]` entry when `alerted` is truthy, else the
 * cooldown-suppression sentence — mirrors the CLI's `alerted -> <coordinator>`
 * line (src/cli.ts renderReport) but spells out the timestamp and the
 * suppressed case too, since the console has no scrollback to infer it from.
 */
export function alertNote(finding: WatchdogFindingView, report: Pick<WatchdogReportView, 'alerts'>): string {
  if (finding.status === 'healthy' || finding.status === 'idle') return '';
  if (finding.alerted) {
    const alert = report.alerts.find(a => a.role === finding.role);
    return `alerted -> ${alert?.coordinator ?? 'unknown'} at ${alert?.sent_at ?? 'unknown time'}`;
  }
  return 'suppressed (open finding within cooldown)';
}

export function nextRunLabel(w: WatchdogSummaryView, now: Date): string {
  if (!w.enabled || w.nextRunAt === null) return '—';
  const diffMs = new Date(w.nextRunAt).getTime() - now.getTime();
  if (diffMs <= 0) return 'overdue';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(diffMs / 86_400_000);
  return `in ${days}d`;
}
