import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { agentDir, home, stateRoot } from './paths.js';
import {
  loadConfig, findRole, isolationContextFor, resolveMonitorConfig, resolvePermissions,
  type ResolvedRole,
} from './config.js';
import { getAdapter } from './harness/registry.js';
import type { Launch } from './harness/types.js';
import { Tmux } from './tmux.js';
import { createMonitor, type MonitorDeps, type MonitorHandle, type MonitorOpts, type FetchLike } from './monitor.js';
import { realExec, shq, type Exec } from './exec.js';
import { resolveIsolation } from './isolation/policy.js';
import { selectIsolationBackend } from './isolation/registry.js';
import { resourceArgs, cpuControllerDelegated } from './isolation/resources.js';
import type { WrapContext } from './isolation/types.js';
import { resolveLaunchRuntime } from './isolation/runtime.js';
import { AcpSession } from './session/acp.js';
import { RoleControlServer } from './session/control.js';
import { TmuxSession } from './session/tmux.js';
import { classifyShellStatus } from './session/types.js';
import type { ExitRecord, SessionHandle } from './session/types.js';
import {
  effectiveModelForRole, modelRecoveryHeld, reconcileModelRecovery, recordModelFailure,
  classifyFailureText,
} from './model-recovery.js';
import { rotateWorklog } from './worklog.js';

export interface RunnerDeps {
  tmux: Tmux;
  exec: Exec;
  cpuDelegated(): boolean;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
  /** HTTP transport for the monitor's daemon long-poll (injectable for tests). */
  fetch: FetchLike;
  /** Construct the supervisor mail monitor (injectable so tests stub it out). */
  createMonitor(opts: MonitorOpts): MonitorHandle;
  /** Lets a test (or a shutdown path) end the supervised restart loop. */
  shouldStop?(): boolean;
}

const defaultDeps = (): RunnerDeps => ({
  tmux: new Tmux(),
  exec: realExec,
  cpuDelegated: () => cpuControllerDelegated(),
  isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  now: () => Date.now(),
  log: line => process.stderr.write(line + '\n'),
  fetch: (url, init) => globalThis.fetch(url, init) as unknown as ReturnType<FetchLike>,
  createMonitor: opts => createMonitor(opts),
});

const MONITOR_OWNER_FILE = '.monitor-owner';

/**
 * Record who owns wake delivery for this run. Returning true means a fleet
 * monitor is taking ownership back from a native harness and must start at the
 * current stream tip rather than replay notifications the native owner was
 * responsible for.
 */
export function recordMonitorOwner(dir: string, owner: 'fleet' | 'native'): boolean {
  let previous: string | null = null;
  try {
    const path = join(dir, MONITOR_OWNER_FILE);
    if (existsSync(path)) previous = readFileSync(path, 'utf8').trim();
    writeFileSync(path, `${owner}\n`);
  } catch { /* ownership diagnostics must never take the role down */ }
  return owner === 'fleet' && previous === 'native';
}

/**
 * Compose the tmux pane shell command: env prefix + argv + exit-status capture.
 * `paneArgv` defaults to `launch.argv`; when isolation is active the caller passes
 * the sandbox-wrapped argv (e.g. `bwrap … -- claude …`). The `env` prefix and the
 * `echo $? > exitfile` capture stay host-side, outside the sandbox, so the runner
 * still sees the real exit code.
 */
export function buildPaneCommand(
  launch: Launch, roleEnv: Record<string, string> | undefined, exitStatusPath: string,
  paneArgv: string[] = launch.argv,
): string {
  const env = {
    PATH: process.env.PATH ?? '', COLORTERM: 'truecolor', ...launch.env, ...(roleEnv ?? {}),
  };
  // Interactive panes should advertise colour even when the supervisor itself
  // was launched with NO_COLOR. A role may still deliberately opt back in to
  // NO_COLOR (or replace COLORTERM) through its explicit env block.
  const unsetNoColor = Object.prototype.hasOwnProperty.call(roleEnv ?? {}, 'NO_COLOR')
    ? '' : '-u NO_COLOR ';
  const envPfx = 'env ' + unsetNoColor
    + Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const cmd = paneArgv.map(shq).join(' ');
  // Write a structured record, not a bare number: the wait status alone cannot
  // say whether the file is missing because the program never exited or because
  // nothing ever wrote it. `printf` is POSIX; no shell branching is needed
  // because classification happens in one place, in TypeScript.
  const record = `'{"version":1,"backend":"tmux","status":'"$__ofs"'}'`;
  return `${envPfx} ${cmd}; __ofs=$?; printf %s ${record} > ${shq(exitStatusPath)}`;
}

/** Adapt runner deps and the role's daemon-profile overrides for the monitor. */
function monitorDeps(deps: RunnerDeps, roleEnv?: Record<string, string>): MonitorDeps {
  return {
    fetch: deps.fetch,
    tmux: deps.tmux,
    isAlive: deps.isAlive,
    sleep: deps.sleep,
    now: deps.now,
    log: deps.log,
    // The agent pane receives role.env too. The supervisor monitor must select
    // the same ours daemon profile, with per-role values winning over service env.
    env: { ...process.env, ...(roleEnv ?? {}) },
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t) },
  };
}

/**
 * Read the pane's `.exit-status`. Three shapes are accepted: the structured
 * record written above, a bare number left by a pre-upgrade pane (so an
 * in-place upgrade does not misread a real exit), and anything else — which is
 * `unknown`, never an invented failure. A missing file returns null so the
 * caller can distinguish "no record" from "a record saying unknown".
 */
export function readExitRecord(path: string): ExitRecord | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return { version: 1, class: 'unknown', detail: 'the pane left an empty exit record' };
  if (/^-?\d+$/.test(raw)) return classifyShellStatus(Number(raw));   // legacy `echo $?`
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    if (typeof parsed.status === 'number') return classifyShellStatus(parsed.status);
  } catch { /* fall through to unknown */ }
  return { version: 1, class: 'unknown', detail: `unreadable exit record: ${raw.slice(0, 120)}` };
}

// ─── Restart-loop containment (3.2) ──────────────────────────────────────────
//
// The child-session restart loop used to BE the service manager: systemd's
// `Restart=always RestartSec=2` and launchd's `KeepAlive`. Neither can count,
// so a program that dies instantly was relaunched every two seconds forever,
// and each relaunch was a fresh process with no memory of the previous one.
// The count now lives with the role, in its state directory, so it survives the
// runner being restarted and is consistent across both service managers.

export const RESTART_LEDGER_FILE = '.restart-ledger.json';

/** Consecutive immediate failures tolerated before the agent is held down. */
export const RESTART_FAIL_THRESHOLD = 5;
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 60_000;
/** How often a held-down runner re-reads its ledger, so `up` can release it. */
const HELD_DOWN_POLL_MS = 5_000;

export interface RestartLedger {
  version: 1;
  consecutiveImmediateFailures: number;
  lastReason: string;
  nextDelayMs: number;
  /** Whether this failure sequence has already thrown away resume state. */
  resumeDiscarded: boolean;
  circuit: 'closed' | 'open';
  updatedAt: string;
  /** When the circuit opened, for the held-down status line. */
  openedAt?: string;
}

const emptyLedger = (): RestartLedger => ({
  version: 1,
  consecutiveImmediateFailures: 0,
  lastReason: '',
  nextDelayMs: 0,
  resumeDiscarded: false,
  circuit: 'closed',
  updatedAt: new Date(0).toISOString(),
});

/** Bounded exponential backoff for the nth consecutive immediate failure. */
export function backoffFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(
    RESTART_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), RESTART_BACKOFF_MAX_MS);
}

/** Read a role's restart ledger; a missing or corrupt one starts clean. */
export function readRestartLedger(dir: string): RestartLedger {
  try {
    const raw = JSON.parse(readFileSync(join(dir, RESTART_LEDGER_FILE), 'utf8')) as Partial<RestartLedger>;
    if (raw.version !== 1) return emptyLedger();
    return { ...emptyLedger(), ...raw, version: 1 };
  } catch { return emptyLedger(); }
}

export function writeRestartLedger(dir: string, ledger: RestartLedger): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RESTART_LEDGER_FILE), JSON.stringify(ledger, null, 2) + '\n');
  } catch { /* diagnostics must never take the role down */ }
}

/**
 * Close the circuit and forget the failure streak. Called by an explicit
 * operator `up`/`restart`, which is the only thing that may release a held-down
 * role — a held-down runner polls this file, so a role can be released without
 * bouncing its unit.
 */
export function resetRestartLedger(dir: string): void {
  if (!existsSync(dir)) return;
  writeRestartLedger(dir, { ...emptyLedger(), updatedAt: new Date().toISOString() });
}

/** Filename spawnTemp writes into a temp agent dir to carry the fleet start-stagger. */
export const START_STAGGER_FILE = '.start-stagger-ms';

/** Read the start-stagger a temp agent was spawned with (0 if none / unreadable). */
function readStartStagger(dir: string): number {
  try {
    const n = parseInt(readFileSync(join(dir, START_STAGGER_FILE), 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/**
 * Reserve this process's launch slot on the host-wide start gate and return the
 * wall-clock time it may launch at. A tiny atomic mutex (mkdir is atomic across
 * processes) guards a single `.last-launch` timestamp: each launcher takes the
 * next slot = max(now, last + staggerMs), so concurrent boots serialize and spread
 * out by staggerMs while a lone/idle start returns `now` (zero wait). A crashed
 * launcher's stale lock is broken so the gate can never deadlock the fleet.
 */
export async function reserveLaunchSlot(
  root: string, staggerMs: number, deps: Pick<RunnerDeps, 'now' | 'sleep' | 'log'>,
): Promise<number> {
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, '.launch-gate.lock');
  const lockTsFile = join(lockDir, 'ts');
  const tsFile = join(root, '.last-launch');
  const staleMs = Math.max(staggerMs * 4, 10_000);
  const POLL_MS = 50;

  const readTs = (p: string): number | null => {
    try { const n = parseInt(readFileSync(p, 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; }
    catch { return null; }
  };

  for (let waited = 0; ;) {
    try { mkdirSync(lockDir); writeFileSync(lockTsFile, String(deps.now())); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const lockTs = readTs(lockTsFile);
      const stale = lockTs !== null && deps.now() - lockTs > staleMs;
      if (stale || waited > staleMs * 2) {   // break a crashed launcher's lock; never deadlock
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await deps.sleep(POLL_MS);
      waited += POLL_MS;
    }
  }

  try {
    const now = deps.now();
    const last = readTs(tsFile);
    const target = last === null ? now : Math.max(now, last + staggerMs);
    writeFileSync(tsFile, String(target));
    return target;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Read a temp role's config snapshot written by spawnTemp. */
export function loadTempRole(name: string): ResolvedRole {
  const p = join(agentDir(name, true), 'role.yaml');
  if (!existsSync(p)) throw new Error(`temp role '${name}' has no snapshot at ${p}`);
  const role = parse(readFileSync(p, 'utf8')) as ResolvedRole;
  // Upgrade snapshots written before monitor.mode/interrupt existed. A snapshot
  // with no monitor block keeps the historical native/no-supervisor behavior.
  if (role.monitor) role.monitor = resolveMonitorConfig(undefined, role.monitor);
  (role as ResolvedRole & { __temp?: boolean }).__temp = true;
  return role;
}

/**
 * Fall back to the config path applyRole() recorded at the last up/restart/spawn
 * for this role. systemd's shared unit template (`ours-fleet-agent@.service`)
 * execs `_run <name>` with no -c on every restart, so a role brought up from a
 * non-default config (`ours-fleet up -c custom.yaml`) would otherwise silently
 * resolve against the default ~/fleet.yaml on its very first restart and fail
 * with "no such role". An empty/missing marker means "use the default", same as
 * no -c was ever given.
 */
function resolveConfigPath(dir: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const marker = join(dir, '.config-path');
  if (!existsSync(marker)) return undefined;
  return readFileSync(marker, 'utf8').trim() || undefined;
}

/** What one child session did, so the supervising loop can decide what follows. */
export interface AttemptResult {
  elapsedSecs: number;
  exit: ExitRecord;
  /** Whether this attempt threw away resume state to start fresh. */
  rotated: boolean;
  mode: 'fresh' | 'resume';
  modelRecovery?: 'advance' | 'hold';
}

/** One session lifecycle. `runSupervised` (or a one-shot caller) drives it. */
export async function runOnce(
  name: string,
  opts: { temp?: boolean; configPath?: string; allowResumeRotation?: boolean } = {},
  partialDeps: Partial<RunnerDeps> = {},
): Promise<AttemptResult> {
  const deps = { ...defaultDeps(), ...partialDeps };
  const temp = opts.temp === true;
  const dir = agentDir(name, temp);
  const configPath = temp ? opts.configPath : resolveConfigPath(dir, opts.configPath);
  // Resolve the role and the fleet-wide start-stagger. Permanent roles read the
  // live config; temp/detached agents read the value spawnTemp snapshotted into
  // their dir (they have no config path threaded through the detached supervisor).
  let role: ResolvedRole;
  let staggerMs: number;
  if (temp) {
    role = loadTempRole(name);
    staggerMs = readStartStagger(dir);
  } else {
    const cfg = loadConfig(configPath);
    role = findRole(cfg, name);
    staggerMs = cfg.startStaggerMs;
  }
  const effectiveModel = effectiveModelForRole(dir, role);
  if (effectiveModel !== role.model) {
    deps.log(`[${name}] model recovery drift: declared=${role.model ?? '(none)'} effective=${effectiveModel}`);
    role = { ...role, model: effectiveModel };
  }
  if (modelRecoveryHeld(dir))
    throw new Error(`[${name}] model chain exhausted — held down until config changes or recovery reset`);
  const adapter = getAdapter(role.harness);
  mkdirSync(dir, { recursive: true });
  const rotation = rotateWorklog(join(dir, 'WORKLOG.md'), role.worklog);
  if (rotation.deferred)
    deps.log(`[${name}] worklog rotation deferred: concurrent modification detected`);
  else if (rotation.rotated)
    deps.log(`[${name}] worklog rotated: ${rotation.beforeBytes} -> ${rotation.afterBytes} bytes`);

  const sidFile = join(dir, '.session-id');
  if (!existsSync(sidFile)) writeFileSync(sidFile, randomUUID() + '\n');
  const sessionId = readFileSync(sidFile, 'utf8').trim();
  const bootedFile = join(dir, '.booted');
  const exitFile = join(dir, '.exit-status');
  const booted = existsSync(bootedFile);
  const mode: 'fresh' | 'resume' = booted && adapter.supportsResume ? 'resume' : 'fresh';
  if (mode === 'fresh') writeFileSync(bootedFile, '');

  const runCwd = role.cwd && existsSync(role.cwd) ? role.cwd : dir;
  const prep = await adapter.prepareSession(role, { stateDir: dir, runCwd });
  const sessionBackend = role.session ?? 'tmux';
  let launch = sessionBackend === 'acp'
    ? (() => {
        if (!adapter.buildAcpLaunch)
          throw new Error(`harness '${role.harness}' does not support the ACP session backend`);
        return adapter.buildAcpLaunch(role, prep);
      })()
    : adapter.buildLaunch(role, mode, { sessionId }, prep);

  // Isolation is additive: only roles that declare `isolation:` are wrapped. The
  // env prefix + exit capture in buildPaneCommand stay host-side (see §5.3).
  let wrappedArgv = launch.argv;
  if (role.isolation) {
    // Start with the SAME durable context config validation and doctor judged
    // (5.2), then add the selected launch's exact runtime closure. Those paths
    // still pass through resolveIsolation's canonical blocklist enforcement.
    const runtime = resolveLaunchRuntime(launch.argv);
    launch = { ...launch, argv: runtime.argv };
    const ctx: WrapContext = {
      ...isolationContextFor(role), stateDir: dir, runCwd,
      runtimeReadPaths: runtime.readPaths,
    };
    const policy = resolveIsolation(role.isolation, ctx);
    const sel = await selectIsolationBackend(policy, deps.exec);  // throws on strict + unavailable
    const degradedMarker = join(dir, '.isolation-degraded');
    if (sel.degraded) {
      deps.log(`[${name}] WARNING isolation requested but unavailable -> running UN-ISOLATED: ${sel.detail}`);
      writeFileSync(degradedMarker, `${new Date().toISOString()} ${sel.detail}\n`);
    } else {
      deps.log(`[${name}] isolation: ${sel.backend.id} (net=${policy.network}) ${sel.detail}`);
      rmSync(degradedMarker, { force: true });
    }
    wrappedArgv = sel.backend.wrap(launch.argv, policy, ctx);

    // Resource caps wrap the sandbox from OUTSIDE, at the pane's own cgroup scope
    // (§5.4). Applies even when the sandbox degraded to none.
    const { argv: rprefix, warnings } = resourceArgs(policy.resources, deps.cpuDelegated());
    for (const w of warnings) deps.log(`[${name}] WARNING ${w}`);
    if (rprefix.length) wrappedArgv = [...rprefix, ...wrappedArgv];
  }

  // Start-stagger: space this launch at least start_stagger_ms after the previous
  // agent launch across the whole host, so a burst of boots (systemd starts every
  // user unit concurrently on boot; `ours-fleet up`/restart-all bulk-start) does not
  // hit the harness/API rate limit at once. Time-based via a shared launch gate, so
  // a lone start or a solo crash-restart waits zero. Applied right before the harness
  // launch (tmux.newSession); the cheap monitor prime still runs immediately after.
  if (staggerMs > 0) {
    const slot = await reserveLaunchSlot(stateRoot(), staggerMs, deps);
    const wait = slot - deps.now();
    if (wait > 0) {
      deps.log(`[${name}] start-stagger: holding ${wait}ms before launch`);
      await deps.sleep(wait);
    }
  }

  // Supervisor mail monitor (design §1): prime the notification cursor at the
  // stream tip BEFORE the session launches so no arrival is missed during boot
  // (backlog before the tip is the SessionStart hook's job). Native-mode roles
  // leave wake ownership to the harness. Temp snapshots predating `monitor:` are
  // treated as native (monitor may be undefined on an old role.yaml).
  let sessionHandle: SessionHandle | undefined;
  let modelRecovery: 'advance' | 'hold' | undefined;
  const resolvedMonitorDeps = monitorDeps(deps, role.env);
  resolvedMonitorDeps.onFailureEvidence = evidence => {
    if (!role.model_chain) return false;
    const action = recordModelFailure(
      dir,
      role,
      { ...evidence, model: evidence.model ?? role.model },
      role.monitor.turn_fail_threshold ?? 3,
    );
    if (action.kind === 'advance') {
      modelRecovery = 'advance';
      deps.log(`[${name}] MODEL DOWN-SHIFT ${action.from} -> ${action.to}; restarting with resume`);
      void sessionHandle?.close();
      return true;
    } else if (action.kind === 'hold') {
      modelRecovery = 'hold';
      deps.log(`[${name}] MODEL CHAIN EXHAUSTED at ${action.model}; held down`);
      void sessionHandle?.close();
      return true;
    }
    return false;
  };
  const monitorOwner = role.monitor?.mode === 'fleet' ? 'fleet' : 'native';
  const resetMonitorCursor = recordMonitorOwner(dir, monitorOwner);
  const monitor = monitorOwner === 'fleet' ? deps.createMonitor({
    name, identity: role.identity, agentDir: dir, cfg: role.monitor,
    deps: resolvedMonitorDeps,
  }) : null;
  if (monitor) await monitor.prime({ resetCursor: resetMonitorCursor });

  rmSync(exitFile, { force: true });
  let pid: number;
  let acpSession: AcpSession | undefined;
  let control: RoleControlServer | undefined;
  let unsubscribeRecovery: (() => void) | undefined;
  let monitorLoop: Promise<void> | undefined;
  let acpStartupComplete = false;
  if (sessionBackend === 'acp') {
    const perms = role.permissions ?? resolvePermissions(undefined, undefined);
    // Say once, at startup, that this role will decide permission requests by
    // itself. Without it the only trace of an auto-denied tool call is a turn
    // that quietly did less than it was asked to.
    if (perms.unattended === 'deny')
      deps.log(`[${name}] permission policy: unattended=deny — with no console attached, ` +
        `permission requests are automatically denied once each (reject_once) and the turn continues`);
    acpSession = await AcpSession.start({
      name,
      argv: wrappedArgv,
      cwd: runCwd,
      env: { ...launch.env, ...(role.env ?? {}) },
      stateDir: dir,
      mode,
      permissions: perms,
      log: deps.log,
    });
    pid = acpSession.pid;
    sessionHandle = acpSession;
    unsubscribeRecovery = acpSession.subscribe(event => {
      if (event.kind !== 'error' || !event.text) return;
      const evidence = classifyFailureText(
        event.text, 'acp', new Date(deps.now()).toISOString());
      if (evidence) resolvedMonitorDeps.onFailureEvidence?.(evidence);
    });
    control = new RoleControlServer(dir, acpSession, deps.log);
    await control.start();
    resolvedMonitorDeps.delivery = {
      // A wake is only delivered when its turn TERMINATES successfully. A
      // refusal or a cancellation reached the agent and was not acted on, so
      // the monitor must keep its cursor and try again.
      submit: async (text, options) => {
        // Cancelling the runner-owned startup prompt makes startup look failed
        // and closes the session before the wake turn can run. During startup,
        // steer into the live turn instead; after it completes, honor the
        // configured interrupt policy normally.
        const interrupt = options?.interrupt === true && acpStartupComplete;
        const result = await acpSession!.submitPrompt(text, { ...options, interrupt, steer: true });
        const steered = result.accepted
          && (result.detail === 'injected' || result.detail === 'startedNewTurn');
        return {
          succeeded: result.succeeded || steered,
          outcome: steered ? result.detail! : result.outcome,
          detail: result.detail,
        };
      },
    };
    const firstPrompt = mode === 'fresh'
      ? `Read and follow ${join(dir, 'briefing.md')} now.`
      : adapter.vocabulary.restartPrompt(role.identity, join(dir, 'WORKLOG.md'), role);
    // Wait for the first turn's TERMINAL result. An agent that accepts the
    // startup prompt and then refuses it has not started; logging the role as
    // up would hide a role that never read its briefing.
    const starting = acpSession.submitPrompt(firstPrompt);
    // Monitoring starts immediately. The delivery adapter above downgrades
    // interruption to steering until this startup turn reaches a terminal
    // success, so there is neither a deaf gap nor a boot-cancellation loop.
    monitorLoop = monitor?.run(pid);
    const started = await starting;
    if (!started.succeeded) {
      monitor?.stop();
      await control.close();
      await acpSession.close();
      unsubscribeRecovery?.();
      if (modelRecovery) {
        if (monitorLoop) await monitorLoop;
        return {
          elapsedSecs: 0,
          exit: {
            version: 1,
            class: 'program-exit',
            detail: `ACP startup triggered model recovery (${modelRecovery})`,
          },
          rotated: false,
          mode,
          modelRecovery,
        };
      }
      throw new Error(`[${name}] ACP startup prompt ${started.outcome}` +
        `${started.detail ? `: ${started.detail}` : ''}`);
    }
    acpStartupComplete = true;
  } else {
    await deps.tmux.kill(name);
    await deps.tmux.newSession(
      name, runCwd, buildPaneCommand(launch, role.env, exitFile, wrappedArgv));
    let panePid: number | null = null;
    for (let i = 0; i < 40 && panePid === null; i++) {
      panePid = await deps.tmux.panePid(name);
      if (panePid === null) await deps.sleep(250);
    }
    if (panePid === null) throw new Error(`[${name}] could not resolve tmux pane pid`);
    pid = panePid;
    sessionHandle = new TmuxSession(name, pid, deps.tmux, deps.isAlive);
  }
  deps.log(
    `[${name}] up; pid=${pid} cwd=${runCwd} harness=${role.harness} session=${sessionBackend} mode=${mode}`);

  // The monitor loop lives exactly as long as the session: it starts once the
  // pane pid is known and is stopped when that pid dies (task dies with runner).
  monitorLoop ??= monitor?.run(pid);

  const start = deps.now();
  while (sessionHandle.isAlive()) await deps.sleep(2000);
  if (monitor) { monitor.stop(); await monitorLoop; }
  unsubscribeRecovery?.();
  if (control) await control.close();
  if (acpSession) await acpSession.close();
  const elapsed = (deps.now() - start) / 1000;
  // Establish what actually happened before deciding anything. Absence of a
  // record is `unknown` — except when the console itself is gone, which is a
  // different event with a different consequence.
  const exitRecord: ExitRecord = acpSession
    ? acpSession.exitResult()
      ?? { version: 1, class: 'unknown', detail: 'the ACP agent stopped without reporting an exit' }
    : readExitRecord(exitFile)
      ?? (await deps.tmux.has(name)
        ? { version: 1, class: 'unknown', detail: 'the pane process ended without writing an exit record' }
        : { version: 1, class: 'session-destroyed', detail: `the tmux session '${name}' no longer exists` });
  writeFileSync(exitFile, JSON.stringify({
    ...exitRecord, at: new Date(deps.now()).toISOString(), elapsedSecs: Number(elapsed.toFixed(1)),
  }) + '\n');

  let rotated = false;
  const rotate = (why: string) => {
    writeFileSync(sidFile, randomUUID() + '\n');
    rmSync(bootedFile, { force: true });
    rotated = true;
    deps.log(`[${name}] ${why} -> rotated session-id; next start is FRESH`);
  };
  if (exitRecord.class === 'clean' && adapter.exitPolicy.cleanExitIsFresh)
    rotate(`clean exit (code 0)`);
  else if (exitRecord.class === 'session-destroyed')
    // Someone tore the console down; the agent did not fail. Rotating here
    // would discard a live conversation for an operator action.
    deps.log(`[${name}] ${exitRecord.detail} (${elapsed.toFixed(0)}s) -> next start RESUMES context`);
  else if (mode === 'resume' && elapsed < adapter.exitPolicy.fastFailSecs) {
    // Self-heal a poisoned resume — but only once per failure sequence. Rotating
    // on every attempt would discard the conversation again and again while the
    // real cause (a broken command, a missing binary) went unaddressed.
    if (opts.allowResumeRotation === false)
      deps.log(`[${name}] resume failed fast again (${elapsed.toFixed(0)}s, ${exitRecord.detail}) ` +
        `-> resume state was already discarded once; keeping it`);
    else rotate(`resume failed fast (${elapsed.toFixed(0)}s, ${exitRecord.detail})`);
  } else deps.log(
    `[${name}] ${exitRecord.detail} (${elapsed.toFixed(0)}s) -> next start RESUMES context`);

  return { elapsedSecs: elapsed, exit: exitRecord, rotated, mode, modelRecovery };
}

/**
 * The persistent supervisor for one permanent role: run child sessions in a
 * loop, count consecutive immediate failures across them, back off between
 * attempts, and after `RESTART_FAIL_THRESHOLD` hold the agent down while
 * staying alive — so the service manager has nothing to restart and cannot
 * resume the two-second loop behind our back.
 *
 * `attempt` is injectable so the policy can be tested against a fake clock and
 * fake child instead of real sessions.
 */
export async function runSupervised(
  name: string,
  opts: { configPath?: string } = {},
  partialDeps: Partial<RunnerDeps> = {},
  attempt: (
    n: string, o: { configPath?: string; allowResumeRotation?: boolean }, d: Partial<RunnerDeps>,
  ) => Promise<AttemptResult> = runOnce,
): Promise<RestartLedger> {
  const deps = { ...defaultDeps(), ...partialDeps };
  const dir = agentDir(name);
  mkdirSync(dir, { recursive: true });
  const shouldStop = deps.shouldStop ?? (() => false);
  const stamp = () => new Date(deps.now()).toISOString();

  while (!shouldStop()) {
    let ledger = readRestartLedger(dir);
    try {
      const configPath = resolveConfigPath(dir, opts.configPath);
      const role = findRole(loadConfig(configPath), name);
      reconcileModelRecovery(dir, role, stamp());
      if (modelRecoveryHeld(dir)) {
        await deps.sleep(HELD_DOWN_POLL_MS);
        continue;
      }
    } catch {
      // Normal attempt path reports config errors through the restart circuit.
    }

    if (ledger.circuit === 'open') {
      // Held down. Stay alive — exiting would hand the role straight back to
      // the service manager — and watch for an operator reset.
      await deps.sleep(HELD_DOWN_POLL_MS);
      continue;
    }

    let result: AttemptResult;
    try {
      result = await attempt(
        name, { configPath: opts.configPath, allowResumeRotation: !ledger.resumeDiscarded }, deps);
    } catch (e) {
      // A session that could not even start is an immediate failure like any
      // other; it must count, or an unstartable role loops forever.
      result = {
        elapsedSecs: 0,
        exit: { version: 1, class: 'unknown', detail: e instanceof Error ? e.message : String(e) },
        rotated: false,
        mode: 'fresh',
      };
    }

    // Re-read: the attempt itself may have taken minutes, and an operator may
    // have reset the ledger meanwhile.
    ledger = readRestartLedger(dir);
    if (result.modelRecovery === 'advance') {
      writeRestartLedger(dir, {
        ...emptyLedger(),
        lastReason: 'approved model-chain transition',
        updatedAt: stamp(),
      });
      continue;
    }
    if (result.modelRecovery === 'hold') {
      await deps.sleep(HELD_DOWN_POLL_MS);
      continue;
    }
    const fastFailSecs = fastFailSecsFor(name, opts.configPath);
    const immediate = result.elapsedSecs < fastFailSecs;

    if (!immediate) {
      // A session that ran for a while is not a restart loop, whatever ended it.
      writeRestartLedger(dir, {
        ...emptyLedger(),
        lastReason: result.exit.detail,
        updatedAt: stamp(),
      });
      continue;
    }

    const failures = ledger.consecutiveImmediateFailures + 1;
    const reason = `${result.exit.detail} after ${result.elapsedSecs.toFixed(1)}s`;
    const next: RestartLedger = {
      version: 1,
      consecutiveImmediateFailures: failures,
      lastReason: reason,
      nextDelayMs: backoffFor(failures),
      resumeDiscarded: ledger.resumeDiscarded || result.rotated,
      circuit: failures >= RESTART_FAIL_THRESHOLD ? 'open' : 'closed',
      updatedAt: stamp(),
    };
    if (next.circuit === 'open') {
      next.openedAt = stamp();
      next.nextDelayMs = 0;
      writeRestartLedger(dir, next);
      deps.log(`[${name}] HELD DOWN after ${failures} immediate failures at ${next.openedAt} — ` +
        `${reason}; the agent will not be restarted until: ours-fleet restart ${name}`);
      continue;
    }
    writeRestartLedger(dir, next);
    deps.log(`[${name}] immediate failure ${failures}/${RESTART_FAIL_THRESHOLD} (${reason}) ` +
      `-> backing off ${next.nextDelayMs}ms`);
    await deps.sleep(next.nextDelayMs);
  }
  return readRestartLedger(dir);
}

/**
 * How short an attempt has to be to count as immediate. The role's harness
 * decides; an unreadable config falls back to the common 20s so a broken config
 * cannot disable the breaker.
 */
function fastFailSecsFor(name: string, configPath?: string): number {
  try {
    const role = findRole(loadConfig(configPath), name);
    return getAdapter(role.harness).exitPolicy.fastFailSecs;
  } catch { return 20; }
}

/** Temp-agent entrypoint: run one session, then remove the temp dir. */
export async function runTemp(name: string, deps: Partial<RunnerDeps> = {}): Promise<void> {
  try {
    await runOnce(name, { temp: true }, deps);
  } finally {
    rmSync(agentDir(name, true), { recursive: true, force: true });
  }
}
