import { describe, expect, it } from 'vitest';
import {
  alertNote, nextRunLabel, runDuration, watchdogChip, watchdogLine,
  type WatchdogReportView, type WatchdogSummaryView,
} from '../../web/src/watchdog-presentation.js';

const base = (overrides: Partial<WatchdogSummaryView> = {}): WatchdogSummaryView => ({
  name: 'nightwatch', enabled: true, heldDown: false, heldSince: null,
  intervalMs: 600_000, coordinator: 'FleetCoordinator', watch: ['Alice'],
  lastRunAt: '2026-07-31T12:00:00Z', nextRunAt: '2026-07-31T12:10:00Z',
  latest: null,
  ...overrides,
});

const healthyLatest = {
  runId: '20260731T120000Z', status: 'ok' as const,
  startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:00:05Z',
  summary: { checked: 4, healthy: 4, idle: 0, anomalies: 0 }, error: null,
};

const anomalyLatest = {
  runId: '20260731T120000Z', status: 'anomalies' as const,
  startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:00:05Z',
  summary: { checked: 4, healthy: 3, idle: 0, anomalies: 1 }, error: null,
};

const errorLatest = {
  runId: '20260731T120000Z', status: 'error' as const,
  startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:00:05Z',
  summary: { checked: 0, healthy: 0, idle: 0, anomalies: 0 }, error: 'timed out',
};

describe('watchdogChip', () => {
  it('disabled watchdog is offline regardless of other state', () => {
    expect(watchdogChip(base({ enabled: false, heldDown: true, latest: errorLatest }))).toBe('offline');
  });

  it('held-down watchdog needs attention', () => {
    expect(watchdogChip(base({ heldDown: true, latest: healthyLatest }))).toBe('attention');
  });

  it('never-ran enabled watchdog needs attention', () => {
    expect(watchdogChip(base({ latest: null }))).toBe('attention');
  });

  it('errored latest run needs attention', () => {
    expect(watchdogChip(base({ latest: errorLatest }))).toBe('attention');
  });

  it('anomalies in latest run need attention', () => {
    expect(watchdogChip(base({ latest: anomalyLatest }))).toBe('attention');
  });

  it('healthy latest run is ready', () => {
    expect(watchdogChip(base({ latest: healthyLatest }))).toBe('ready');
  });
});

describe('watchdogLine', () => {
  it('renders the exact healthy sentence shape', () => {
    expect(watchdogLine(base({ latest: healthyLatest }))).toBe('4 roles checked, all healthy.');
  });

  it('renders anomaly detail when anomalyRoles is provided, singular for one anomaly', () => {
    const latest = { ...anomalyLatest, anomalyRoles: [{ role: 'Alice', status: 'blocked' }] };
    expect(watchdogLine(base({ latest }))).toBe('4 checked, 1 anomaly (Alice blocked).');
  });

  it('renders plural anomaly detail with multiple roles', () => {
    const latest = {
      ...anomalyLatest, summary: { ...anomalyLatest.summary, anomalies: 2 },
      anomalyRoles: [{ role: 'Alice', status: 'blocked' }, { role: 'Bob', status: 'stale' }],
    };
    expect(watchdogLine(base({ latest }))).toBe('4 checked, 2 anomalies (Alice blocked, Bob stale).');
  });

  it('falls back to a plain count when anomalyRoles is absent', () => {
    expect(watchdogLine(base({ latest: anomalyLatest }))).toBe('4 checked, 1 anomalies.');
  });

  it('renders the error sentence', () => {
    expect(watchdogLine(base({ latest: errorLatest }))).toBe('last run failed: timed out.');
  });

  it('renders held-down since a known time', () => {
    expect(watchdogLine(base({ heldDown: true, heldSince: '2026-07-31T10:00:00Z', latest: errorLatest })))
      .toBe('held down since 2026-07-31T10:00:00Z.');
  });

  it('renders held-down with unknown time when heldSince is missing', () => {
    expect(watchdogLine(base({ heldDown: true, heldSince: null, latest: healthyLatest })))
      .toBe('held down since unknown.');
  });

  it('renders no-runs-yet for a watchdog that has never run', () => {
    expect(watchdogLine(base({ latest: null }))).toBe('no runs yet.');
  });

  it('held-down takes precedence over error/anomalies/healthy', () => {
    expect(watchdogLine(base({ heldDown: true, heldSince: '2026-07-31T10:00:00Z', latest: anomalyLatest })))
      .toBe('held down since 2026-07-31T10:00:00Z.');
  });

  it('error takes precedence over anomalies', () => {
    const latest = { ...errorLatest, summary: { ...errorLatest.summary, anomalies: 1 } };
    expect(watchdogLine(base({ latest }))).toBe('last run failed: timed out.');
  });
});

describe('nextRunLabel', () => {
  const now = new Date('2026-07-31T12:00:00Z');

  it('is a dash when there is no scheduled next run', () => {
    expect(nextRunLabel(base({ nextRunAt: null }), now)).toBe('—');
  });

  it('is a dash for a disabled watchdog even with a stale nextRunAt', () => {
    expect(nextRunLabel(base({ enabled: false, nextRunAt: '2026-07-31T12:10:00Z' }), now)).toBe('—');
  });

  it('renders minutes for a near-future run', () => {
    expect(nextRunLabel(base({ nextRunAt: '2026-07-31T12:03:00Z' }), now)).toBe('in 3m');
  });

  it('renders hours for a further-future run', () => {
    expect(nextRunLabel(base({ nextRunAt: '2026-07-31T15:00:00Z' }), now)).toBe('in 3h');
  });

  it('is overdue when the scheduled time has passed', () => {
    expect(nextRunLabel(base({ nextRunAt: '2026-07-31T11:00:00Z' }), now)).toBe('overdue');
  });
});

describe('runDuration', () => {
  it('renders plain seconds under a minute', () => {
    expect(runDuration({ startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:00:45Z' })).toBe('45s');
  });

  it('renders minutes and seconds compound form over a minute', () => {
    expect(runDuration({ startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:01:12Z' })).toBe('1m 12s');
  });

  it('omits the seconds part on an exact minute boundary', () => {
    expect(runDuration({ startedAt: '2026-07-31T12:00:00Z', finishedAt: '2026-07-31T12:02:00Z' })).toBe('2m');
  });

  it('is a dash when startedAt is unparseable', () => {
    expect(runDuration({ startedAt: 'not-a-date', finishedAt: '2026-07-31T12:00:00Z' })).toBe('-');
  });

  it('is a dash when finishedAt is unparseable', () => {
    expect(runDuration({ startedAt: '2026-07-31T12:00:00Z', finishedAt: '' })).toBe('-');
  });

  it('clamps a negative span (clock skew) to zero rather than going negative', () => {
    expect(runDuration({ startedAt: '2026-07-31T12:00:10Z', finishedAt: '2026-07-31T12:00:00Z' })).toBe('0s');
  });
});

describe('alertNote', () => {
  const report = (overrides: Partial<WatchdogReportView> = {}): WatchdogReportView => ({
    schema_version: 1, watchdog: 'nightwatch', run_id: '20260731T115000Z',
    started_at: '2026-07-31T11:50:00Z', finished_at: '2026-07-31T11:51:12Z', status: 'anomalies',
    summary: { checked: 2, healthy: 1, idle: 0, anomalies: 1 },
    roles: [], alerts: [{ role: 'Alice', code: 'blocked', coordinator: 'FleetCoordinator', sent_at: '2026-07-31T11:51:10Z' }],
    error: null,
    ...overrides,
  });

  it('is empty for a healthy finding', () => {
    expect(alertNote({ role: 'Docs', status: 'healthy' }, report())).toBe('');
  });

  it('is empty for an idle finding', () => {
    expect(alertNote({ role: 'Docs', status: 'idle' }, report())).toBe('');
  });

  it('reports the coordinator and time when alerted with a matching alerts[] entry', () => {
    expect(alertNote({ role: 'Alice', status: 'blocked', reason: 'stuck', alerted: true }, report()))
      .toBe('alerted -> FleetCoordinator at 2026-07-31T11:51:10Z');
  });

  it('reports suppressed when a non-healthy finding was not alerted (cooldown)', () => {
    expect(alertNote({ role: 'Alice', status: 'blocked', reason: 'stuck', alerted: false }, report()))
      .toBe('suppressed (open finding within cooldown)');
  });

  it('reports suppressed when alerted is absent entirely', () => {
    expect(alertNote({ role: 'Alice', status: 'blocked', reason: 'stuck' }, report()))
      .toBe('suppressed (open finding within cooldown)');
  });

  it('degrades gracefully when alerted is true but no matching alerts[] entry exists', () => {
    expect(alertNote({ role: 'Bob', status: 'stale', reason: 'no heartbeat', alerted: true }, report()))
      .toBe('alerted -> unknown at unknown time');
  });
});
