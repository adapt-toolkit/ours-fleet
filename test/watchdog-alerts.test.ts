import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLedger, writeLedger, reconcileLedger, computeDigest, WATCHDOG_STATUS_RANK,
} from '../src/watchdog/alerts.js';
import { errorReport } from '../src/watchdog/report.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-')); process.env.OURS_FLEET_HOME = dir; });
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-07-31T12:00:00Z');
const empty = () => ({ version: 1 as const, open: {}, heldDownAlerted: false });
const reportWith = (roles: unknown[], alerts: unknown[] = []) => ({
  schema_version: 1, watchdog: 'w', run_id: '20260731T120000Z',
  started_at: 'a', finished_at: 'b', status: 'anomalies',
  summary: { checked: roles.length, healthy: 0, idle: 0, anomalies: roles.length },
  roles, alerts, error: null,
});

describe('watchdog alerts', () => {
  it('ranks: healthy/idle 0, unknown 1, stale 2, blocked/unreachable 3, off_briefing 4', () => {
    expect(WATCHDOG_STATUS_RANK.healthy).toBe(0);
    expect(WATCHDOG_STATUS_RANK.off_briefing).toBeGreaterThan(WATCHDOG_STATUS_RANK.blocked - 1);
    expect(WATCHDOG_STATUS_RANK.blocked).toBeGreaterThan(WATCHDOG_STATUS_RANK.stale);
  });
  it('opens a new finding with since=now', () => {
    const l = reconcileLedger(empty(), reportWith([{ role: 'A', status: 'stale', reason: 'r' }]) as never, NOW);
    expect(l.open.A).toMatchObject({ status: 'stale', since: NOW.toISOString(), lastAlertedAt: null });
  });
  it('escalation updates status but keeps since; healthy closes', () => {
    let l = reconcileLedger(empty(), reportWith([{ role: 'A', status: 'stale', reason: 'r' }]) as never, NOW);
    const later = new Date('2026-07-31T13:00:00Z');
    l = reconcileLedger(l, reportWith([{ role: 'A', status: 'blocked', reason: 'r' }]) as never, later);
    expect(l.open.A.status).toBe('blocked');
    expect(l.open.A.since).toBe(NOW.toISOString());
    l = reconcileLedger(l, reportWith([{ role: 'A', status: 'healthy' }]) as never, later);
    expect(l.open.A).toBeUndefined();
  });
  it('report.alerts stamps lastAlertedAt; absent roles keep their entries', () => {
    let l = reconcileLedger(empty(), reportWith(
      [{ role: 'A', status: 'blocked', reason: 'r' }],
      [{ role: 'A', code: 'blocked', coordinator: 'C', sent_at: 'x' }]) as never, NOW);
    expect(l.open.A.lastAlertedAt).toBe(NOW.toISOString());
    l = reconcileLedger(l, reportWith([{ role: 'B', status: 'healthy' }]) as never, NOW);
    expect(l.open.A).toBeDefined();
  });
  it('an error report leaves the ledger untouched', () => {
    const seeded = reconcileLedger(empty(), reportWith([{ role: 'A', status: 'stale', reason: 'r' }]) as never, NOW);
    const after = reconcileLedger(seeded,
      errorReport({ watchdog: 'w', run_id: '20260731T130000Z', started_at: 'a', finished_at: 'b', error: 'timeout' }), NOW);
    expect(after).toEqual(seeded);
  });
  it('computeDigest emits realert_after = lastAlertedAt + cooldown, null when never alerted', () => {
    const l = { ...empty(), open: {
      A: { role: 'A', status: 'blocked' as const, since: '2026-07-31T10:00:00Z', lastAlertedAt: '2026-07-31T10:00:00Z' },
      B: { role: 'B', status: 'stale' as const, since: '2026-07-31T10:00:00Z', lastAlertedAt: null },
    } };
    const d = computeDigest(l, 3_600_000, NOW);
    expect(d.open.find(o => o.role === 'A')!.realert_after).toBe('2026-07-31T11:00:00.000Z');
    expect(d.open.find(o => o.role === 'B')!.realert_after).toBeNull();
    expect(d.cooldown_ms).toBe(3_600_000);
  });
  it('round-trips through disk and tolerates a corrupt file', () => {
    writeLedger('w', { ...empty(), heldDownAlerted: true });
    expect(readLedger('w').heldDownAlerted).toBe(true);
    writeFileSync(join(dir, '.ours-fleet', 'watchdogs', 'w', 'alerts.json'), '{nope');
    expect(readLedger('w')).toEqual(empty());
  });
});
