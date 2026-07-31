export const WATCHDOG_ROLE_STATUSES = ['healthy', 'idle', 'stale', 'blocked', 'off_briefing', 'unreachable', 'unknown'] as const;
export type WatchdogRoleStatus = typeof WATCHDOG_ROLE_STATUSES[number];

export interface WatchdogEvidence { source: string; detail: string; observed_at: string }
export interface WatchdogFinding {
  role: string; status: WatchdogRoleStatus; reason?: string;
  evidence?: WatchdogEvidence[]; alerted?: boolean;
}
export interface WatchdogAlert { role: string; code: string; coordinator: string; sent_at: string }
export type WatchdogReportStatus = 'ok' | 'anomalies' | 'error';
export interface WatchdogReport {
  schema_version: 1; watchdog: string; run_id: string;
  started_at: string; finished_at: string; status: WatchdogReportStatus;
  summary: { checked: number; healthy: number; idle: number; anomalies: number };
  roles: WatchdogFinding[]; alerts: WatchdogAlert[]; error: string | null;
}

const SUMMARY_KEYS = ['checked', 'healthy', 'idle', 'anomalies'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateWatchdogReport(v: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(v)) {
    errors.push('report: expected an object');
    return errors;
  }
  const r = v;

  if (r.schema_version !== 1) errors.push('schema_version: expected 1');

  for (const key of ['watchdog', 'run_id', 'started_at', 'finished_at'] as const)
    if (typeof r[key] !== 'string') errors.push(`${key}: expected a string`);

  if (r.status !== 'ok' && r.status !== 'anomalies' && r.status !== 'error')
    errors.push(`status: expected ok|anomalies|error, got '${String(r.status)}'`);

  if (!isPlainObject(r.summary)) {
    errors.push('summary: expected an object');
  } else {
    for (const key of SUMMARY_KEYS)
      if (typeof r.summary[key] !== 'number') errors.push(`summary.${key}: expected a number`);
  }

  if (!Array.isArray(r.roles)) {
    errors.push('roles: expected an array');
  } else {
    r.roles.forEach((role, i) => {
      if (!isPlainObject(role)) {
        errors.push(`roles[${i}]: expected an object`);
        return;
      }
      if (typeof role.role !== 'string') errors.push(`roles[${i}].role: expected a string`);
      if (!(WATCHDOG_ROLE_STATUSES as readonly string[]).includes(role.status as string))
        errors.push(`roles[${i}].status: expected one of ${WATCHDOG_ROLE_STATUSES.join('|')}, got '${String(role.status)}'`);
      if (role.status !== 'healthy' && role.status !== 'idle' && !role.reason)
        errors.push(`roles[${i}]: non-healthy finding requires a reason`);
    });
  }

  if (!Array.isArray(r.alerts)) errors.push('alerts: expected an array');

  if (r.error !== null && typeof r.error !== 'string') errors.push('error: expected string or null');

  return errors;
}

const cleanEvidence = (value: string, max = 280) =>
  value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);

export function normalizeWatchdogReport(r: WatchdogReport, ctx: { watchdog: string; run_id: string }): WatchdogReport {
  const copy: WatchdogReport = JSON.parse(JSON.stringify(r));
  copy.watchdog = ctx.watchdog;
  copy.run_id = ctx.run_id;
  copy.roles = copy.roles.map(role => {
    const next: WatchdogFinding = { ...role };
    if (next.reason !== undefined) next.reason = cleanEvidence(next.reason);
    if (next.evidence !== undefined) {
      next.evidence = next.evidence.slice(0, 3).map(ev => ({
        source: cleanEvidence(ev.source),
        detail: cleanEvidence(ev.detail),
        observed_at: cleanEvidence(ev.observed_at),
      }));
    }
    if (next.alerted !== undefined) next.alerted = Boolean(next.alerted);
    return next;
  });
  return copy;
}

export function errorReport(ctx: {
  watchdog: string; run_id: string; started_at: string; finished_at: string; error: string; tail?: string;
}): WatchdogReport & { tail?: string } {
  return {
    schema_version: 1,
    watchdog: ctx.watchdog,
    run_id: ctx.run_id,
    started_at: ctx.started_at,
    finished_at: ctx.finished_at,
    status: 'error',
    summary: { checked: 0, healthy: 0, idle: 0, anomalies: 0 },
    roles: [],
    alerts: [],
    error: ctx.error,
    ...(ctx.tail !== undefined ? { tail: ctx.tail.slice(-4096) } : {}),
  };
}
