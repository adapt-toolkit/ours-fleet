import { describe, expect, it } from 'vitest';
import { buildWatchdogFindings } from '../src/watchdog/query.js';
import type { WatchdogReport } from '../src/watchdog/report.js';

function report(overrides: Partial<WatchdogReport> = {}): WatchdogReport {
  return {
    schema_version: 1, watchdog: 'nightwatch', run_id: '20260731T120000Z',
    started_at: '2026-07-31T12:00:00Z', finished_at: '2026-07-31T12:00:05Z',
    status: 'anomalies',
    summary: { checked: 1, healthy: 0, idle: 0, anomalies: 1 },
    roles: [], alerts: [], error: null,
    ...overrides,
  };
}

describe('buildWatchdogFindings', () => {
  it('skips error-status reports entirely', () => {
    const reports: Record<string, WatchdogReport | undefined> = {
      nightwatch: report({
        watchdog: 'nightwatch', status: 'error', error: 'timed out',
        roles: [{ role: 'Alice', status: 'blocked', reason: 'unreachable' }],
      }),
    };
    const findings = buildWatchdogFindings({ watchdogs: [{ name: 'nightwatch' }] }, name => reports[name]);
    expect(findings.size).toBe(0);
  });

  it('skips watchdogs with no stored report', () => {
    const findings = buildWatchdogFindings({ watchdogs: [{ name: 'ghost' }] }, () => undefined);
    expect(findings.size).toBe(0);
  });

  it('skips healthy and idle findings', () => {
    const reports: Record<string, WatchdogReport | undefined> = {
      nightwatch: report({
        watchdog: 'nightwatch', status: 'ok',
        roles: [{ role: 'Alice', status: 'healthy' }, { role: 'Bob', status: 'idle' }],
      }),
    };
    const findings = buildWatchdogFindings({ watchdogs: [{ name: 'nightwatch' }] }, name => reports[name]);
    expect(findings.size).toBe(0);
  });

  it('keeps the worst finding per role across multiple watchdogs, and skips an error-status watchdog entirely', () => {
    const reports: Record<string, WatchdogReport | undefined> = {
      dayshift: report({
        watchdog: 'dayshift', status: 'anomalies',
        roles: [{ role: 'Alice', status: 'stale', reason: 'no heartbeat in 20m' }],
      }),
      nightwatch: report({
        watchdog: 'nightwatch', status: 'anomalies',
        roles: [
          { role: 'Alice', status: 'blocked', reason: 'permission pending' },
          { role: 'Bob', status: 'healthy' },
        ],
      }),
      brokenwatch: report({
        watchdog: 'brokenwatch', status: 'error', error: 'agent crashed',
        roles: [{ role: 'Carol', status: 'unreachable', reason: 'never got here' }],
      }),
    };
    const findings = buildWatchdogFindings(
      { watchdogs: [{ name: 'dayshift' }, { name: 'nightwatch' }, { name: 'brokenwatch' }] },
      name => reports[name],
    );
    // stale (rank 2) < blocked (rank 3): nightwatch's finding wins.
    expect(findings.get('Alice')).toEqual({ watchdog: 'nightwatch', status: 'blocked', reason: 'permission pending' });
    expect(findings.has('Bob')).toBe(false);
    expect(findings.has('Carol')).toBe(false);
    expect(findings.size).toBe(1);
  });
});
