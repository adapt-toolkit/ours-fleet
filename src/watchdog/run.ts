import {
  closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ResolvedWatchdog } from './config.js';
import type { WatchdogReport } from './report.js';
import { errorReport, normalizeWatchdogReport, validateWatchdogReport } from './report.js';
import { acquireRunLock, formatRunId, pruneReports, releaseRunLock, writeReport } from './store.js';
import { generateNotifierBriefing, generateWatchdogBriefing, type WatchManifest } from './briefing.js';
import { computeDigest, reconcileLedger, readLedger, writeLedger } from './alerts.js';
import { applyRole } from '../ops.js';
import {
  daemonIdentityInventoryProvisioner, ensureIdentity, type IdentityProvisioner,
} from '../creation.js';
import { runOnce, START_STAGGER_FILE } from '../runner.js';
import { agentDir, tmpRoot } from '../paths.js';
import {
  loadConfig, resolveMonitorConfig, resolveWorklogPolicy, ROLE_NAME_RE,
  type FleetConfig, type ResolvedRole,
} from '../config.js';
import { getAdapter } from '../harness/registry.js';
import { redactLogLine } from '../application/log-service.js';
import { controlRequest, controlSocketPath } from '../session/control.js';


/** How often the deadline loop polls for a completed report or a dead child. */
const POLL_MS = 1000;
/** A `report.json` this old, with no further writes, is treated as finished. */
const WRITE_STABLE_MS = 2000;
/** Grace given to the agent after a stable report before the session is killed. */
const HARVEST_GRACE_MS = 5000;
/** Fixed deadline for a one-shot notifier run — always 2 minutes, never wd.timeoutMs. */
const NOTIFIER_TIMEOUT_MS = 120_000;

type SentinelBreakReason = 'stable' | 'exited' | 'timeout';

/**
 * Poll for a completion sentinel file (report.json for an inspection run, sent.json for a
 * notifier run) going write-stable, or the child exiting first, or the deadline passing —
 * whichever comes first. Shared by executeWatchdogRun and executeNotifierRun so the two run
 * flavors' wait loops can never drift apart.
 */
async function waitForSentinel(
  sentinelPath: string, child: WatchdogChildHandle, deadlineMs: number, start: Date,
  now: () => Date, sleep: (ms: number) => Promise<void>,
): Promise<SentinelBreakReason> {
  let exited = false;
  // Attached now so a natural exit is observed even though the loop below never
  // awaits the promise itself (its resolution races real time in the real
  // launcher, and is driven purely by test fixtures in tests).
  child.exited.then(() => { exited = true; }).catch(() => { exited = true; });

  for (;;) {
    if (exited) return 'exited';
    if (existsSync(sentinelPath)) {
      const age = now().getTime() - statSync(sentinelPath).mtimeMs;
      if (age >= WRITE_STABLE_MS) return 'stable';
    }
    if (now().getTime() - start.getTime() > deadlineMs) return 'timeout';
    await sleep(POLL_MS);
  }
}

/** After waitForSentinel settles, harvest the grace period (if stable) then kill the child+session. */
async function killIfNeeded(
  reason: SentinelBreakReason, child: WatchdogChildHandle, roleName: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (reason === 'stable' || reason === 'timeout') {
    if (reason === 'stable') await sleep(HARVEST_GRACE_MS);
    child.kill();
  }
}

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
  /** Live temporary-role discovery override for focused tests. */
  discoverLiveTemporaryRoles?(): Promise<string[]>;
}

export interface WatchdogRunOutcome { report: WatchdogReport; storedPath: string }

function defaultLaunchChild(binPath: string, roleName: string, runDir: string): WatchdogChildHandle {
  const out = openSync(join(runDir, 'run.log'), 'a');
  const child = spawnChild(process.execPath, [binPath, '_run-watchdog', roleName], {
    detached: false, stdio: ['ignore', out, out],
  });
  // spawn() dup's the fd into the child; Node never closes our copy on its own,
  // so a long-running scheduler launching many watchdog runs would leak one fd
  // per run and eventually hit EMFILE. Safe to close immediately — the child
  // keeps writing to its own dup'd descriptor.
  closeSync(out);
  return {
    kill: () => { child.kill(); },
    exited: new Promise(resolve => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    }),
  };
}

/** Last 4096 chars of run.log, redacted — attached to error reports as diagnostic tail. */
function readTail(runDir: string): string | undefined {
  try {
    const raw = readFileSync(join(runDir, 'run.log'), 'utf8');
    return redactLogLine(raw.slice(-4096)).text;
  } catch { return undefined; }
}

/** The temp role every watchdog-family run launches under. Isolation is opt-in. */
function buildWatchdogRole(wd: ResolvedWatchdog, cfg: FleetConfig): ResolvedRole {
  return {
    name: wd.identity, sourceFile: '(watchdog)',
    harness: wd.harness, session: wd.session,
    identity: wd.identity, model: wd.model,
    // Watchdogs are observe-only by contract, but their sanctioned status commands
    // must reach host control sockets. Keep approvals/unattended escalation denied
    // while disabling the harness's native filesystem/network sandbox.
    permissions: { approval: 'deny', filesystem: 'unrestricted', unattended: 'deny' },
    permissionsDeclared: true,
    monitor: resolveMonitorConfig(cfg.defaults.monitor, undefined),
    worklog: resolveWorklogPolicy(cfg.defaults.worklog, undefined),
    isolation: wd.isolation,
  };
}

/** Discover temporary sessions that are live now, not merely stale dirs on disk. */
async function discoverLiveTemporaryRoles(): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(tmpRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && ROLE_NAME_RE.test(entry.name))
      .map(entry => entry.name);
  } catch { return []; }
  const live = await Promise.all(names.map(async name => {
    const dir = agentDir(name, true);
    const alive = existsSync(controlSocketPath(dir))
      ? await controlRequest(dir, { command: 'status' }, 2_000)
          .then(response => response.ok
            && (response.result as { alive?: boolean } | undefined)?.alive === true)
          .catch(() => false)
      : false;
    return alive ? name : undefined;
  }));
  return live.filter((name): name is string => name !== undefined);
}

/**
 * Run one watchdog agent end-to-end in a clean-context temp state dir: provision
 * identity, materialize the run's contract (briefing/manifest/role snapshot),
 * launch the child, enforce a deadline against report.json as the completion
 * sentinel, harvest whatever it wrote (or a synthetic error report if it
 * didn't), store the result, and always clean up the temp dir.
 *
 * The scheduler's run-lock guarantees only one run per watchdog at a time;
 * this function itself takes no lock.
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
  // Read once, before the manifest is written: the same snapshot both seeds the
  // digest the agent sees and is the base the post-run reconcile folds into.
  const ledger = readLedger(wd.name);

  // A crashed previous run can leave the temp dir behind; start clean.
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });

  let report: WatchdogReport;
  try {
    const guarantee = await ensureIdentity(
      wd.identity, {}, deps.identityProvisioner ?? daemonIdentityInventoryProvisioner(), deps.log);

    const cfg = deps.cfg ?? loadConfig();
    const discovered = wd.watchExplicit
      ? []
      : await (deps.discoverLiveTemporaryRoles ?? discoverLiveTemporaryRoles)();
    const watch = [...new Set([...wd.watch, ...discovered])]
      .filter(name => name !== wd.identity);
    const runWd = { ...wd, watch };
    const role = buildWatchdogRole(runWd, cfg);

    const dir = applyRole(role, { temp: true, identityGuarantee: guarantee.state });
    const reportPath = join(dir, 'report.json');
    const manifestPath = join(dir, 'watch.json');

    const promptFocus = wd.promptFile ? readFileSync(wd.promptFile, 'utf8') : undefined;
    // applyRole wrote the generic role briefing; the watchdog contract replaces it.
    writeFileSync(join(dir, 'briefing.md'), generateWatchdogBriefing({
      wd: runWd, manifestPath, reportPath,
      vocabulary: getAdapter(wd.harness).vocabulary,
      identityGuarantee: guarantee.state,
      promptFocus,
    }));
    // loadTempRole (runner.ts) needs this to run the child via `_run-watchdog`.
    writeFileSync(join(dir, 'role.yaml'), stringify(role));
    const manifest: WatchManifest = {
      watchdog: wd.name, run_id: runId, coordinator: wd.coordinator, started_at: startedAt,
      roles: runWd.watch.map(r => ({
        name: r,
        stateDir: wd.watch.includes(r) ? agentDir(r) : agentDir(r, true),
      })),
      digest: computeDigest(ledger, wd.alertCooldownMs, now()),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    // Snapshot the fleet start-stagger so the detached run (no config path
    // threaded through `_run-watchdog`) honors the same host-wide launch gate
    // as every other role — mirrors the spawn path.
    if (cfg.startStaggerMs > 0)
      writeFileSync(join(dir, START_STAGGER_FILE), String(cfg.startStaggerMs));

    const launch = deps.launchChild ?? defaultLaunchChild;
    const child = launch(deps.binPath, roleName, dir);

    const reason = await waitForSentinel(reportPath, child, wd.timeoutMs, start, now, sleep);
    await killIfNeeded(reason, child, roleName, sleep);

    const timedOut = reason === 'timeout';
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

    // A weaker isolation guarantee must never look like
    // the strong one, so stamp it on every outcome, error reports included.
    if (existsSync(join(dir, '.isolation-degraded')))
      (report as WatchdogReport & { isolation?: string }).isolation = 'degraded';
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }

  const storedPath = writeReport(wd.name, report);
  // Reconciles against the FINAL stored report (normalized or error) — reconcileLedger
  // itself no-ops on error-status reports, so a timeout/invalid run leaves the ledger
  // byte-for-byte unchanged.
  writeLedger(wd.name, reconcileLedger(ledger, report, now()));
  pruneReports(wd.name, wd.keepReports);
  return { report, storedPath };
}

/**
 * Deliver one scheduler-level alert (e.g. held-down) by launching a minimal one-shot temp agent
 * under the watchdog's own identity whose entire mission is: bind identity, send `text` to
 * `wd.coordinator`, write `sent.json`, exit. The fleet process itself cannot send ours messages
 * (owner-approved deviation 4), so this is how a scheduler tick that can't reach an operator any
 * other way still gets a message out.
 *
 * Reuses the ordinary run machinery (temp-dir prep, ensureIdentity, ResolvedRole shape, child
 * launch, kill mechanics) but stores no report, touches no ledger findings, and writes no
 * watch.json manifest — `sent.json` is this run's only completion sentinel. A fixed 2-minute
 * deadline applies regardless of `wd.timeoutMs`.
 *
 * Unlike executeWatchdogRun (which relies on the scheduler's run lock), this function acquires
 * and releases the run lock itself — a notifier run shares the same temp dir name
 * (`agentDir(wd.identity, true)`) as a regular run, and nothing else serializes the two. Refusal
 * to acquire is logged and treated as a no-op: the held-down state already means no regular runs
 * are in flight, so a collision is rare. Any other failure (including a timeout) is logged as a
 * warning and swallowed — a notifier failure must never throw into the scheduler loop.
 */
export async function executeNotifierRun(
  wd: ResolvedWatchdog, text: string, deps: WatchdogRunDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const fail = (e: unknown): void => {
    deps.log(`notifier run for '${wd.name}' failed: ${e instanceof Error ? e.message : String(e)}`);
  };

  // acquireRunLock can itself throw (EACCES/EIO, not just EEXIST — store.ts) — guarded
  // separately from the try/finally below so a throw here never reaches the caller either;
  // nothing was acquired, so there is nothing to release.
  let acquired = false;
  try {
    acquired = acquireRunLock(wd.name);
  } catch (e) {
    fail(e);
    return;
  }
  if (!acquired) {
    deps.log(`notifier run for '${wd.name}' skipped: run lock held`);
    return;
  }

  const roleName = wd.identity;
  const runDir = agentDir(roleName, true);

  try {
    // A crashed previous run can leave the temp dir behind; start clean.
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });

    const guarantee = await ensureIdentity(
      wd.identity, {}, deps.identityProvisioner ?? daemonIdentityInventoryProvisioner(), deps.log);

    const cfg = deps.cfg ?? loadConfig();
    const role = buildWatchdogRole(wd, cfg);

    const dir = applyRole(role, { temp: true, identityGuarantee: guarantee.state });
    const sentinelPath = join(dir, 'sent.json');

    // applyRole wrote the generic role briefing; the notifier contract replaces it.
    writeFileSync(join(dir, 'briefing.md'), generateNotifierBriefing({
      wd, vocabulary: getAdapter(wd.harness).vocabulary,
      identityGuarantee: guarantee.state, text,
    }));
    // loadTempRole (runner.ts) needs this to run the child via `_run-watchdog`.
    writeFileSync(join(dir, 'role.yaml'), stringify(role));
    // Use the same host-wide launch-gate snapshot executeWatchdogRun writes.
    if (cfg.startStaggerMs > 0)
      writeFileSync(join(dir, START_STAGGER_FILE), String(cfg.startStaggerMs));

    const launch = deps.launchChild ?? defaultLaunchChild;
    const start = now();
    const child = launch(deps.binPath, roleName, dir);

    const reason = await waitForSentinel(sentinelPath, child, NOTIFIER_TIMEOUT_MS, start, now, sleep);
    await killIfNeeded(reason, child, roleName, sleep);

    if (reason === 'timeout') deps.log(`notifier run for '${wd.name}' timed out`);
  } catch (e) {
    fail(e);
  } finally {
    // Same "never escape" rule as the lock acquire above: cleanup and release are each
    // guarded individually so neither can turn a handled failure into an unhandled one.
    try { rmSync(runDir, { recursive: true, force: true }); } catch (e) { fail(e); }
    try { releaseRunLock(wd.name); } catch (e) { fail(e); }
  }
}

/** What `_run-watchdog` calls: one supervised session, no cleanup — the parent harvests. */
export async function runWatchdogAgent(name: string): Promise<void> {
  await runOnce(name, { temp: true });
}
