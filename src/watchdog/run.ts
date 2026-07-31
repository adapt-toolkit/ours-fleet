import { existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn as spawnChild, execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import type { ResolvedWatchdog } from './config.js';
import type { WatchdogReport } from './report.js';
import { errorReport, normalizeWatchdogReport, validateWatchdogReport } from './report.js';
import { formatRunId, pruneReports, writeReport } from './store.js';
import { generateWatchdogBriefing, type WatchManifest } from './briefing.js';
import { applyRole } from '../ops.js';
import {
  daemonIdentityProvisioner, ensureIdentity, type IdentityProvisioner,
} from '../creation.js';
import { runOnce } from '../runner.js';
import { agentDir, agentsRoot } from '../paths.js';
import {
  loadConfig, resolveMonitorConfig, resolveWorklogPolicy, type FleetConfig, type ResolvedRole,
} from '../config.js';
import { getAdapter } from '../harness/registry.js';
import { redactLogLine } from '../application/log-service.js';

const execFileAsync = promisify(execFile);

/** How often the deadline loop polls for a completed report or a dead child. */
const POLL_MS = 1000;
/** A `report.json` this old, with no further writes, is treated as finished. */
const WRITE_STABLE_MS = 2000;
/** Grace given to the agent after a stable report before the session is killed. */
const HARVEST_GRACE_MS = 5000;

/** A minimal handle over the launched child: kill it, or await its natural exit. */
export interface WatchdogChildHandle {
  kill(): void;
  exited: Promise<void>;
}

export interface WatchdogRunDeps {
  binPath: string;
  log(line: string): void;
  now?(): Date;
  sleep?(ms: number): Promise<void>;
  identityProvisioner?: IdentityProvisioner;
  /**
   * Injectable child launcher for tests. Default: spawn
   * `node <binPath> _run-watchdog <roleName>` detached:false, stdio to
   * `<runDir>/run.log`. Returns kill() and an exited promise.
   */
  launchChild?(binPath: string, roleName: string, runDir: string): WatchdogChildHandle;
  /** Pre-loaded config (defaults inheritance). Falls back to `loadConfig()`. */
  cfg?: FleetConfig;
}

export interface WatchdogRunOutcome { report: WatchdogReport; storedPath: string }

function defaultLaunchChild(binPath: string, roleName: string, runDir: string): WatchdogChildHandle {
  const out = openSync(join(runDir, 'run.log'), 'a');
  const child = spawnChild(process.execPath, [binPath, '_run-watchdog', roleName], {
    detached: false, stdio: ['ignore', out, out],
  });
  return {
    kill: () => { child.kill(); },
    exited: new Promise(resolve => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    }),
  };
}

/** Best-effort: the tmux session outlives the supervisor child (`runOnce` created it). */
async function killTmuxSession(roleName: string): Promise<void> {
  try { await execFileAsync('tmux', ['kill-session', '-t', roleName]); }
  catch { /* best effort */ }
}

/** Last 4096 chars of run.log, redacted — attached to error reports as diagnostic tail. */
function readTail(runDir: string): string | undefined {
  try {
    const raw = readFileSync(join(runDir, 'run.log'), 'utf8');
    return redactLogLine(raw.slice(-4096)).text;
  } catch { return undefined; }
}

/**
 * Run one watchdog agent end-to-end in a clean-context temp state dir: provision
 * identity, materialize the run's contract (briefing/manifest/role snapshot),
 * launch the child, enforce a deadline against report.json as the completion
 * sentinel, harvest whatever it wrote (or a synthetic error report if it
 * didn't), store the result, and always clean up the temp dir.
 *
 * The scheduler's run-lock guarantees only one run per watchdog at a time;
 * this function itself takes no lock (Task 8).
 */
export async function executeWatchdogRun(
  wd: ResolvedWatchdog, deps: WatchdogRunDeps,
): Promise<WatchdogRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const start = now();
  const runId = formatRunId(start);
  const startedAt = start.toISOString();
  const roleName = wd.identity;
  const runDir = agentDir(roleName, true);

  // A crashed previous run can leave the temp dir behind; start clean.
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });

  let report: WatchdogReport;
  try {
    const guarantee = await ensureIdentity(
      wd.identity, {}, deps.identityProvisioner ?? daemonIdentityProvisioner(), deps.log);

    const cfg = deps.cfg ?? loadConfig();
    const role: ResolvedRole = {
      name: roleName, sourceFile: '(watchdog)',
      harness: wd.harness, session: wd.session,
      identity: wd.identity, model: wd.model,
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      permissionsDeclared: true,
      monitor: resolveMonitorConfig(cfg.defaults.monitor, undefined),
      worklog: resolveWorklogPolicy(cfg.defaults.worklog, undefined),
      // network: 'broker' keeps ours messaging; no write binds beyond stateDir/cwd,
      // which resolveIsolation adds itself. ~/fleet.yaml and fleet.d are
      // deliberately NOT bound — they're on the isolation blocklist, and
      // everything the run needs is in the manifest we write below.
      isolation: { fs: { read: [agentsRoot()] }, network: 'broker' },
    };

    const dir = applyRole(role, { temp: true, identityGuarantee: guarantee.state });
    const reportPath = join(dir, 'report.json');
    const manifestPath = join(dir, 'watch.json');

    const promptFocus = wd.promptFile ? readFileSync(wd.promptFile, 'utf8') : undefined;
    // applyRole wrote the generic role briefing; the watchdog contract replaces it.
    writeFileSync(join(dir, 'briefing.md'), generateWatchdogBriefing({
      wd, manifestPath, reportPath,
      vocabulary: getAdapter(wd.harness).vocabulary,
      identityGuarantee: guarantee.state,
      promptFocus,
    }));
    // loadTempRole (runner.ts) needs this to run the child via `_run-watchdog`.
    writeFileSync(join(dir, 'role.yaml'), stringify(role));
    const manifest: WatchManifest = {
      watchdog: wd.name, run_id: runId, coordinator: wd.coordinator, started_at: startedAt,
      roles: wd.watch.map(r => ({ name: r, stateDir: agentDir(r) })),
      digest: { cooldown_ms: wd.alertCooldownMs, open: [] },   // Phase 2 fills open[]
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const launch = deps.launchChild ?? defaultLaunchChild;
    const child = launch(deps.binPath, roleName, dir);
    let exited = false;
    // Attached now so a natural exit is observed even though the loop below
    // never awaits the promise itself (its resolution races real time in the
    // real launcher, and is driven purely by test fixtures in tests).
    child.exited.then(() => { exited = true; }).catch(() => { exited = true; });

    type BreakReason = 'stable' | 'exited' | 'timeout';
    let reason: BreakReason;
    for (;;) {
      if (exited) { reason = 'exited'; break; }
      if (existsSync(reportPath)) {
        const age = now().getTime() - statSync(reportPath).mtimeMs;
        if (age >= WRITE_STABLE_MS) { reason = 'stable'; break; }
      }
      if (now().getTime() - start.getTime() > wd.timeoutMs) { reason = 'timeout'; break; }
      await sleep(POLL_MS);
    }

    const timedOut = reason === 'timeout';
    if (reason === 'stable' || reason === 'timeout') {
      if (reason === 'stable') await sleep(HARVEST_GRACE_MS);
      child.kill();
      await killTmuxSession(roleName);
    }

    if (timedOut) {
      report = errorReport({
        watchdog: wd.name, run_id: runId, started_at: startedAt, finished_at: now().toISOString(),
        error: 'timeout', tail: readTail(dir),
      });
    } else {
      let parsed: unknown;
      let parseError: string | undefined;
      try { parsed = JSON.parse(readFileSync(reportPath, 'utf8')); }
      catch (e) { parseError = e instanceof Error ? e.message : String(e); }
      const validationErrors = parseError === undefined ? validateWatchdogReport(parsed) : [];
      if (parseError !== undefined || validationErrors.length) {
        const detail = parseError ?? validationErrors.slice(0, 3).join('; ');
        report = errorReport({
          watchdog: wd.name, run_id: runId, started_at: startedAt, finished_at: now().toISOString(),
          error: `invalid report: ${detail}`, tail: readTail(dir),
        });
      } else {
        report = normalizeWatchdogReport(parsed as WatchdogReport, { watchdog: wd.name, run_id: runId });
        // Scheduler clock truth overrides whatever the agent wrote.
        report.started_at = startedAt;
        report.finished_at = now().toISOString();
      }
    }

    // Isolation degradation (spec §7): a weaker guarantee must never look like
    // the strong one, so stamp it on every outcome, error reports included.
    if (existsSync(join(dir, '.isolation-degraded')))
      (report as WatchdogReport & { isolation?: string }).isolation = 'degraded';
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }

  const storedPath = writeReport(wd.name, report);
  pruneReports(wd.name, wd.keepReports);
  return { report, storedPath };
}

/** What `_run-watchdog` calls: one supervised session, no cleanup — the parent harvests. */
export async function runWatchdogAgent(name: string): Promise<void> {
  await runOnce(name, { temp: true });
}
