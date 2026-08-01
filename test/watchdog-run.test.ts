import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, writeFileSync, readFileSync, utimesSync, rmSync, mkdtempSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNotifierRun, executeWatchdogRun } from '../src/watchdog/run.js';
import { acquireRunLock, listRuns, releaseRunLock, writeReport } from '../src/watchdog/store.js';
import { errorReport } from '../src/watchdog/report.js';
import { readLedger, writeLedger } from '../src/watchdog/alerts.js';
import type { WatchManifest } from '../src/watchdog/briefing.js';
import { agentDir } from '../src/paths.js';
import { START_STAGGER_FILE } from '../src/runner.js';
import '../src/harness/claude-code.js';
import { parse } from 'yaml';
import { RoleControlServer } from '../src/session/control.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wdrun-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const wd = {
  name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
  intervalMs: 600_000, watch: ['Alice'], watchExplicit: false,
  harness: 'claude-code', session: 'tmux' as const,
  identity: 'Watchdog-nightwatch', timeoutMs: 300_000, keepReports: 50,
  alertCooldownMs: 3_600_000, sourceFile: 'f',
};

const provisioner = { exists: async () => true as const };

function fakeChild(behavior: (runDir: string) => Promise<void>) {
  let killed = false;
  return (_bin: string, _role: string, runDir: string) => ({
    kill: () => { killed = true; },
    exited: behavior(runDir),
    get killed() { return killed; },
  });
}

const baseDeps = (launchChild: ReturnType<typeof fakeChild>) => ({
  binPath: '/bin/false', log: () => {},
  identityProvisioner: provisioner, launchChild,
  sleep: async () => {},
  cfg: {
    roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
    watchdogs: [wd],
  },
});

/** Writes the fixture good report (Task 4's `good()`), with an mtime old enough
 *  to satisfy the write-complete heuristic. */
function writeGoodReport(runDir: string): void {
  const good = readFileSync('test/fixtures/watchdog-good-report.json', 'utf8')
    .replace('"run_id": "20260731T115000Z"', '"run_id": "x"');
  writeFileSync(join(runDir, 'report.json'), good);
  const old = new Date(Date.now() - 5_000);
  utimesSync(join(runDir, 'report.json'), old, old);
}

describe('executeWatchdogRun', () => {
  it('prepares the run dir with contract briefing, manifest, role.yaml before launch', async () => {
    let seen: Record<string, string> = {};
    const launch = fakeChild(async runDir => {
      seen = Object.fromEntries(['briefing.md', 'watch.json', 'role.yaml']
        .map(f => [f, readFileSync(join(runDir, f), 'utf8')]));
      writeGoodReport(runDir);
    });
    const { report } = await executeWatchdogRun(wd as never, baseDeps(launch) as never);
    expect(seen['briefing.md']).toContain('never restart, stop, spawn or remove a role');
    expect(JSON.parse(seen['watch.json']).roles[0]).toMatchObject({ name: 'Alice' });
    expect(report.status).toBe('anomalies');
    expect(report.watchdog).toBe('nightwatch');            // normalizer overrode agent value
    expect(listRuns('nightwatch')).toHaveLength(1);
    expect(existsSync(agentDir('Watchdog-nightwatch', true))).toBe(false);   // cleaned up
  });

  it('launches without isolation when the watchdog omits it', async () => {
    let roleYaml = '';
    const launch = fakeChild(async runDir => {
      roleYaml = readFileSync(join(runDir, 'role.yaml'), 'utf8');
      writeGoodReport(runDir);
    });
    await executeWatchdogRun(wd as never, baseDeps(launch) as never);
    const role = parse(roleYaml) as { isolation?: unknown; permissions?: unknown };
    expect(role.isolation).toBeUndefined();
    expect(role.permissions).toEqual({
      approval: 'deny', filesystem: 'unrestricted', unattended: 'deny',
    });
  });

  it('applies an explicitly configured watchdog isolation policy unchanged', async () => {
    let roleYaml = '';
    const launch = fakeChild(async runDir => {
      roleYaml = readFileSync(join(runDir, 'role.yaml'), 'utf8');
      writeGoodReport(runDir);
    });
    const isolated = {
      ...wd,
      isolation: { backend: 'bubblewrap', network: 'deny', fs: { read: ['/opt/tools'] } },
    };
    await executeWatchdogRun(isolated as never, baseDeps(launch) as never);
    const role = parse(roleYaml) as { isolation?: unknown };
    expect(role.isolation).toEqual(isolated.isolation);
  });

  it('adds a live temporary role to an omitted watch default and skips stale temp dirs', async () => {
    let manifest: WatchManifest | undefined;
    const liveDir = agentDir('Developer-1', true);
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(agentDir('Stale-temp', true), { recursive: true });
    const control = new RoleControlServer(liveDir, {
      snapshot: () => ({ backend: 'acp', alive: true, readiness: 'running' }),
    } as never, () => {});
    await control.start();
    const launch = fakeChild(async runDir => {
      manifest = JSON.parse(readFileSync(join(runDir, 'watch.json'), 'utf8'));
      writeGoodReport(runDir);
    });
    try {
      await executeWatchdogRun(wd as never, baseDeps(launch) as never);
      expect(manifest!.roles).toEqual([
        { name: 'Alice', stateDir: agentDir('Alice') },
        { name: 'Developer-1', stateDir: agentDir('Developer-1', true) },
      ]);
    } finally {
      await control.close();
    }
  });

  it('deduplicates implicit live roles and excludes the watchdog execution identity', async () => {
    let manifest: WatchManifest | undefined;
    const launch = fakeChild(async runDir => {
      manifest = JSON.parse(readFileSync(join(runDir, 'watch.json'), 'utf8'));
      writeGoodReport(runDir);
    });
    await executeWatchdogRun(wd as never, {
      ...baseDeps(launch),
      discoverLiveTemporaryRoles: async () => [
        'Developer-1', 'Alice', 'Watchdog-nightwatch', 'Developer-1',
      ],
    } as never);
    expect(manifest!.roles.map(role => role.name)).toEqual(['Alice', 'Developer-1']);
  });

  it('keeps an explicit watch list exact and skips live temporary-role discovery', async () => {
    let manifest: WatchManifest | undefined;
    const launch = fakeChild(async runDir => {
      manifest = JSON.parse(readFileSync(join(runDir, 'watch.json'), 'utf8'));
      writeGoodReport(runDir);
    });
    const explicit = { ...wd, watchExplicit: true };
    const deps = {
      ...baseDeps(launch),
      discoverLiveTemporaryRoles: async (): Promise<string[]> => {
        throw new Error('explicit watch must not discover temporary roles');
      },
    };
    await executeWatchdogRun(explicit as never, deps as never);
    expect(manifest!.roles).toEqual([{ name: 'Alice', stateDir: agentDir('Alice') }]);
  });

  it('stores status error with tail when the agent writes invalid JSON (acceptance 9)', async () => {
    const launch = fakeChild(async runDir => {
      writeFileSync(join(runDir, 'run.log'), 'boom secret=hunter2');
      writeFileSync(join(runDir, 'report.json'), '{nope');
      const old = new Date(Date.now() - 5_000);
      utimesSync(join(runDir, 'report.json'), old, old);
    });
    const { report } = await executeWatchdogRun(wd as never, baseDeps(launch) as never);
    expect(report.status).toBe('error');
    expect(report.error).toMatch(/invalid report/);
    // The tail attached to the error report must be redacted, not raw run.log —
    // confirmed redactLogLine's actual replacement text ('boom secret=hunter2' ->
    // 'boom secret=[REDACTED]') before asserting on it.
    expect((report as { tail?: string }).tail).not.toContain('hunter2');
    expect((report as { tail?: string }).tail).toContain('[REDACTED]');
  });

  it('kills and stores error:timeout when the deadline passes (acceptance 9)', async () => {
    let t = 0;
    const launch = fakeChild(() => new Promise(() => {}));   // never exits, never writes
    const deps = { ...baseDeps(launch), now: () => new Date(t += 120_000) };  // clock jumps past 5m
    const { report } = await executeWatchdogRun(wd as never, deps as never);
    expect(report.status).toBe('error');
    expect(report.error).toBe('timeout');
  });

  it('prunes to keep_reports after storing', async () => {
    const small = { ...wd, keepReports: 3 };
    for (let i = 0; i < 3; i++)
      writeReport('nightwatch', errorReport({
        watchdog: 'nightwatch', run_id: `2026073${i}T000000Z`,
        started_at: 'a', finished_at: 'b', error: 'x',
      }));
    const launch = fakeChild(async runDir => { writeGoodReport(runDir); });
    await executeWatchdogRun(small as never, baseDeps(launch) as never);
    expect(listRuns('nightwatch')).toHaveLength(3);   // newest 3 kept, oldest pruned
  });

  it('marks the report isolation: degraded when the run dir carries the marker (spec §7)', async () => {
    const launch = fakeChild(async runDir => {
      writeFileSync(join(runDir, '.isolation-degraded'), '2026-07-31T11:50:00Z no bwrap\n');
      writeGoodReport(runDir);
    });
    const { report } = await executeWatchdogRun(wd as never, baseDeps(launch) as never);
    expect((report as { isolation?: string }).isolation).toBe('degraded');
  });

  it('snapshots start_stagger_ms into the run dir before launch (spec §3)', async () => {
    let seen = '';
    const launch = fakeChild(async runDir => {
      seen = readFileSync(join(runDir, START_STAGGER_FILE), 'utf8');
      writeGoodReport(runDir);
    });
    const deps = baseDeps(launch);
    deps.cfg = { ...deps.cfg, startStaggerMs: 1234 };
    await executeWatchdogRun(wd as never, deps as never);
    expect(seen).toBe('1234');
  });

  it('injects the suppression digest into watch.json and reconciles the ledger after the run (acceptance 5/6)', async () => {
    writeLedger('nightwatch', {
      version: 1, heldDownAlerted: false,
      open: { Alice: { role: 'Alice', status: 'stale', since: '2026-07-31T10:00:00Z', lastAlertedAt: '2026-07-31T10:00:00Z' } },
    });
    let manifest: WatchManifest | undefined;
    const launch = fakeChild(async runDir => {
      manifest = JSON.parse(readFileSync(join(runDir, 'watch.json'), 'utf8'));
      writeGoodReport(runDir);   // Alice blocked, alerted:true, alerts:[Alice] (Task 7 fixture)
    });
    // Freeze the run's clock to one deterministic instant (still close enough to real
    // wall-clock time that the write-stable heuristic against report.json's real mtime
    // still holds) so the reconcile-time re-stamp can be asserted exactly, not just
    // "truthy" — a frozen seeded value would make that assertion pass vacuously.
    const runNow = new Date();
    const deps = { ...baseDeps(launch), now: () => runNow };
    await executeWatchdogRun(wd as never, deps as never);
    expect(manifest!.digest.open[0]).toMatchObject({ role: 'Alice', status: 'stale' });
    expect(manifest!.digest.open[0].realert_after).toBe('2026-07-31T11:00:00.000Z');
    const ledger = readLedger('nightwatch');
    expect(ledger.open.Alice.status).toBe('blocked');       // escalated, since preserved
    expect(ledger.open.Alice.since).toBe('2026-07-31T10:00:00Z');
    // report.alerts named Alice, so reconcile re-stamps lastAlertedAt to the run's
    // finished_at instant — must have moved off the seeded 10:00:00Z value.
    expect(ledger.open.Alice.lastAlertedAt).toBe(runNow.toISOString());
  });

  it('a healthy report closes the open finding (resolved path, acceptance 6)', async () => {
    writeLedger('nightwatch', {
      version: 1, heldDownAlerted: false,
      open: { Alice: { role: 'Alice', status: 'blocked', since: '2026-07-31T10:00:00Z', lastAlertedAt: '2026-07-31T10:00:00Z' } },
    });
    const launch = fakeChild(async runDir => {
      const healthy = {
        ...JSON.parse(readFileSync('test/fixtures/watchdog-good-report.json', 'utf8')),
        status: 'ok', roles: [{ role: 'Alice', status: 'healthy' }], alerts: [],
        summary: { checked: 1, healthy: 1, idle: 0, anomalies: 0 },
      };
      writeFileSync(join(runDir, 'report.json'), JSON.stringify(healthy));
      const old = new Date(Date.now() - 5_000);
      utimesSync(join(runDir, 'report.json'), old, old);
    });
    await executeWatchdogRun(wd as never, baseDeps(launch) as never);
    expect(readLedger('nightwatch').open).toEqual({});
  });
});

describe('executeNotifierRun', () => {
  it('writes a minimal briefing (text + coordinator + sendTool), no watch.json, waits for sent.json, stores no report', async () => {
    const seen: { briefing?: string; hasManifest?: boolean } = {};
    const launch = fakeChild(async runDir => {
      seen.briefing = readFileSync(join(runDir, 'briefing.md'), 'utf8');
      seen.hasManifest = existsSync(join(runDir, 'watch.json'));
      writeFileSync(join(runDir, 'sent.json'), JSON.stringify({ sent: true }));
      const old = new Date(Date.now() - 5_000);
      utimesSync(join(runDir, 'sent.json'), old, old);
    });
    await executeNotifierRun(wd as never, 'Alice is stale', baseDeps(launch) as never);
    expect(seen.briefing).toContain('Alice is stale');
    expect(seen.briefing).toContain('FleetCoordinator');
    expect(seen.briefing).toContain('send_message');   // claude-code adapter's sendTool
    expect(seen.briefing).toContain('sent.json');
    expect(seen.hasManifest).toBe(false);
    expect(listRuns('nightwatch')).toHaveLength(0);      // no report stored
    expect(existsSync(agentDir('Watchdog-nightwatch', true))).toBe(false);   // cleaned up
  });

  it('logs a warning and does not throw when the 2-minute deadline passes', async () => {
    let t = 0;
    const launch = fakeChild(() => new Promise(() => {}));   // never exits, never writes
    const logs: string[] = [];
    const deps = { ...baseDeps(launch), log: (l: string) => logs.push(l), now: () => new Date(t += 130_000) };
    await expect(executeNotifierRun(wd as never, 'hi', deps as never)).resolves.toBeUndefined();
    expect(logs.some(l => l.includes(`notifier run for 'nightwatch' timed out`))).toBe(true);
    expect(listRuns('nightwatch')).toHaveLength(0);
  });

  it('logs a warning and does not throw when the child launch throws', async () => {
    const logs: string[] = [];
    const launch = () => { throw new Error('spawn EMFILE'); };
    const deps = { ...baseDeps(launch as never), log: (l: string) => logs.push(l) };
    await expect(executeNotifierRun(wd as never, 'hi', deps as never)).resolves.toBeUndefined();
    expect(logs.some(l => l.includes(`notifier run for 'nightwatch' failed: spawn EMFILE`))).toBe(true);
  });

  it('skips and logs when the run lock is already held, without throwing', async () => {
    acquireRunLock('nightwatch');
    const logs: string[] = [];
    const launch = fakeChild(async () => {});
    const deps = { ...baseDeps(launch), log: (l: string) => logs.push(l) };
    await expect(executeNotifierRun(wd as never, 'hi', deps as never)).resolves.toBeUndefined();
    releaseRunLock('nightwatch');
    expect(logs.some(l => l.includes(`notifier run for 'nightwatch' skipped: run lock held`))).toBe(true);
  });
});
