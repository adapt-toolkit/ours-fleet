import { describe, it, expect } from 'vitest';
import {
  validateWatchdogReport, normalizeWatchdogReport, errorReport,
} from '../src/watchdog/report.js';

const good = () => ({
  schema_version: 1, watchdog: 'nightwatch', run_id: '20260731T115000Z',
  started_at: '2026-07-31T11:50:00Z', finished_at: '2026-07-31T11:51:12Z',
  status: 'anomalies',
  summary: { checked: 2, healthy: 1, idle: 0, anomalies: 1 },
  roles: [
    { role: 'Alice', status: 'blocked', reason: 'Waiting on a trust dialog.',
      evidence: [{ source: 'status', detail: 'readiness=awaiting_permission', observed_at: '2026-07-31T11:50:31Z' }],
      alerted: true },
    { role: 'Docs', status: 'healthy' },
  ],
  alerts: [{ role: 'Alice', code: 'blocked', coordinator: 'FleetCoordinator', sent_at: '2026-07-31T11:51:10Z' }],
  error: null,
});

describe('validateWatchdogReport', () => {
  it('accepts the spec example shape', () => expect(validateWatchdogReport(good())).toEqual([]));
  it('rejects non-objects, wrong schema_version, bad status, bad role status', () => {
    expect(validateWatchdogReport(null)).not.toEqual([]);
    expect(validateWatchdogReport({ ...good(), schema_version: 2 })).toContain('schema_version: expected 1');
    expect(validateWatchdogReport({ ...good(), status: 'fine' }))
      .toContain("status: expected ok|anomalies|error, got 'fine'");
    const bad = good(); (bad.roles[0] as { status: string }).status = 'sleepy';
    expect(validateWatchdogReport(bad)).toContain("roles[0].status: expected one of healthy|idle|stale|blocked|off_briefing|unreachable|unknown, got 'sleepy'");
  });
  it('requires reason on every non-healthy, non-idle finding', () => {
    const bad = good(); delete (bad.roles[0] as { reason?: string }).reason;
    expect(validateWatchdogReport(bad)).toContain('roles[0]: non-healthy finding requires a reason');
  });
  it('rejects missing summary fields and non-array roles/alerts', () => {
    const bad = good(); delete (bad.summary as { checked?: number }).checked;
    expect(validateWatchdogReport(bad).some(e => e.startsWith('summary'))).toBe(true);
    expect(validateWatchdogReport({ ...good(), roles: 'nope' })).toContain('roles: expected an array');
  });
});

describe('normalizeWatchdogReport', () => {
  it('overrides watchdog/run_id with scheduler truth, caps evidence at 3, strips control chars, truncates to 280', () => {
    const r = good();
    r.watchdog = 'spoofed'; r.run_id = 'spoofed';
    r.roles[0].evidence = Array.from({ length: 5 }, (_, i) => ({
      source: 's', detail: `x\x07${'y'.repeat(400)}${i}`, observed_at: 't',
    }));
    const n = normalizeWatchdogReport(r as never, { watchdog: 'nightwatch', run_id: '20260731T115000Z' });
    expect(n.watchdog).toBe('nightwatch');
    expect(n.run_id).toBe('20260731T115000Z');
    expect(n.roles[0].evidence).toHaveLength(3);
    expect(n.roles[0].evidence![0].detail).not.toContain('\x07');
    expect(n.roles[0].evidence![0].detail.length).toBeLessThanOrEqual(280);
  });
});

describe('errorReport', () => {
  it('builds a valid error-status report with bounded tail in error detail', () => {
    const r = errorReport({
      watchdog: 'w', run_id: '20260731T115000Z', started_at: 'a', finished_at: 'b',
      error: 'timeout', tail: 'x'.repeat(10_000),
    });
    expect(validateWatchdogReport(r)).toEqual([]);
    expect(r.status).toBe('error');
    expect(r.error).toBe('timeout');
    expect(r.summary).toEqual({ checked: 0, healthy: 0, idle: 0, anomalies: 0 });
    expect((r as { tail?: string }).tail === undefined
      || (r as { tail?: string }).tail!.length <= 4096).toBe(true);
  });
});
