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
