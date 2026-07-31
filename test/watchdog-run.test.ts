import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, writeFileSync, readFileSync, utimesSync, rmSync, mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWatchdogRun } from '../src/watchdog/run.js';
import { listRuns, writeReport } from '../src/watchdog/store.js';
import { errorReport } from '../src/watchdog/report.js';
import { agentDir } from '../src/paths.js';
import { START_STAGGER_FILE } from '../src/runner.js';
import '../src/harness/claude-code.js';

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
  intervalMs: 600_000, watch: ['Alice'], harness: 'claude-code', session: 'tmux' as const,
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
});
