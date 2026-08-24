import { describe, expect, it, vi } from 'vitest';
import { buildWatchdogFindings, cachedWatchdogFindingsProvider } from '../src/watchdog/query.js';
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
    const findings = buildWatchdogFindings({ watchdogs: [{ name: 'nightwatch', enabled: true }] }, name => reports[name]);
    expect(findings.size).toBe(0);
  });

  it('skips watchdogs with no stored report', () => {
    const findings = buildWatchdogFindings({ watchdogs: [{ name: 'ghost', enabled: true }] }, () => undefined);
    expect(findings.size).toBe(0);
  });

  it('skips healthy and idle findings', () => {
    const reports: Record<string, WatchdogReport | undefined> = {
      nightwatch: report({
        watchdog: 'nightwatch', status: 'ok',
        roles: [{ role: 'Alice', status: 'healthy' }, { role: 'Bob', status: 'idle' }],
      }),
    };
    const findings = buildWatchdogFindings({ watchdogs: [{ name: 'nightwatch', enabled: true }] }, name => reports[name]);
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
      { watchdogs: [
        { name: 'dayshift', enabled: true }, { name: 'nightwatch', enabled: true }, { name: 'brokenwatch', enabled: true },
      ] },
      name => reports[name],
    );
    // stale (rank 2) < blocked (rank 3): nightwatch's finding wins.
    expect(findings.get('Alice')).toEqual({ watchdog: 'nightwatch', status: 'blocked', reason: 'permission pending' });
    expect(findings.has('Bob')).toBe(false);
    expect(findings.has('Carol')).toBe(false);
    expect(findings.size).toBe(1);
  });

  it('skips a disabled watchdog entirely even when its last stored report has a blocked finding', () => {
    const reports: Record<string, WatchdogReport | undefined> = {
      nightwatch: report({
        watchdog: 'nightwatch', status: 'anomalies',
        roles: [{ role: 'Alice', status: 'blocked', reason: 'permission pending' }],
      }),
    };
    const disabled = buildWatchdogFindings(
      { watchdogs: [{ name: 'nightwatch', enabled: false }] }, name => reports[name],
    );
    expect(disabled.size).toBe(0);

    const enabled = buildWatchdogFindings(
      { watchdogs: [{ name: 'nightwatch', enabled: true }] }, name => reports[name],
    );
    expect(enabled.get('Alice')).toEqual({ watchdog: 'nightwatch', status: 'blocked', reason: 'permission pending' });
  });
});

describe('cachedWatchdogFindingsProvider', () => {
  it('memoizes build() within the TTL and rebuilds once the TTL elapses', () => {
    let clock = 0;
    const build = vi.fn(() => new Map([['Alice', { watchdog: 'nightwatch', status: 'blocked' as const, reason: 'x' }]]));
    const provider = cachedWatchdogFindingsProvider(build, 5_000, () => clock);

    provider();
    provider();
    expect(build).toHaveBeenCalledTimes(1);

    clock += 4_999;
    provider();
    expect(build).toHaveBeenCalledTimes(1);

    clock += 1;
    const findings = provider();
    expect(build).toHaveBeenCalledTimes(2);
    expect(findings.get('Alice')).toEqual({ watchdog: 'nightwatch', status: 'blocked', reason: 'x' });
  });

  it('rebuilds on every call when ttlMs is 0', () => {
    const build = vi.fn(() => new Map());
    const provider = cachedWatchdogFindingsProvider(build, 0, () => 0);
    provider();
    provider();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
