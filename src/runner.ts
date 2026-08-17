import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { agentDir, home, stateRoot } from './paths.js';
import {
  loadConfig, findRole, isolationContextFor, resolveMonitorConfig, resolvePermissions,
  type ResolvedRole,
} from './config.js';
import { getAdapter } from './harness/registry.js';
import type { AcpLaunch, Launch } from './harness/types.js';
import { Tmux } from './tmux.js';
import {
  createMonitor, probeIdentityPresence,
  type MonitorDeps, type MonitorHandle, type MonitorOpts, type FetchLike,
} from './monitor.js';
import { realExec, shq, type Exec } from './exec.js';
import { resolveIsolation } from './isolation/policy.js';
import { selectIsolationBackend } from './isolation/registry.js';
import { resourceArgs, cpuControllerDelegated } from './isolation/resources.js';
import type { WrapContext } from './isolation/types.js';
import { resolveLaunchRuntime } from './isolation/runtime.js';
import { AcpSession, type AcpSessionOptions } from './session/acp.js';
import { controlRequest, RoleControlServer } from './session/control.js';
import { TmuxSession } from './session/tmux.js';
import { ACP_CANCEL_DEADLINE_EXCEEDED, classifyShellStatus } from './session/types.js';
import type { ExitRecord, SessionHandle, TurnResult } from './session/types.js';
import {
  effectiveModelForRole, modelRecoveryHeld, reconcileModelRecovery, recordModelFailure,
  classifyFailureText,
} from './model-recovery.js';
import { rotateWorklog } from './worklog.js';
import { OwnerChannel, type OwnerChannelHandle, type OwnerChannelOptions } from './owner-channel/channel.js';
import {
  acquireOwnerBinderLease, OwnerBinderHandoffTimeoutError, type OwnerBinderLease,
} from './owner-channel/binder.js';
import { RoleTurnArbiter } from './session/arbiter.js';
import {
  ScheduledLoopManager, type ScheduledLoopManagerHandle,
} from './loops/manager.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV, inheritCallerSpawnDefaults,
  type ManagedFleetSpawnResult,
} from './fleet-proxy.js';
import type { SpawnOpts } from './spawn.js';
import { effectivePermissionMode } from './permissions.js';
import {
  archiveTempState, markTempSupervisorActive, requestedTempStopReason,
  type TempTerminationReason,
} from './temp-lifecycle.js';

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
  /** Construct trusted owner ingress (injectable for lifecycle tests). */
  createOwnerChannel(opts: OwnerChannelOptions): OwnerChannelHandle;
  /** Start the ACP transport (injectable for deterministic runner lifecycle tests). */
  startAcpSession(opts: AcpSessionOptions): Promise<SessionHandle>;
  /** Construct the authenticated role control route (injectable where sockets are unavailable). */
  createControlServer(
    stateDir: string, session: SessionHandle, log: (line: string) => void,
  ): Pick<RoleControlServer,
    'start' | 'close' | 'setFleetSpawner' | 'setOwnerChannel' | 'setConfigReloader' | 'setLoopManager'>;
  /** Acquire the cross-process owner-channel binder lease before replacing the control socket. */
  acquireOwnerBinder(stateDir: string, role: string, identity: string): Promise<OwnerBinderLease>;
  /** Ask the still-authenticated predecessor to emit the fixed recovery notice. */
  reportOwnerStartupFailure(stateDir: string): Promise<'delivered' | 'duplicate'>;
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
  createOwnerChannel: opts => new OwnerChannel(opts),
  startAcpSession: opts => AcpSession.start(opts),
  createControlServer: (stateDir, session, log) => new RoleControlServer(stateDir, session, log),
  acquireOwnerBinder: (stateDir, role, identity) => acquireOwnerBinderLease(
    stateDir, role, identity),
  reportOwnerStartupFailure: async stateDir => {
    const response = await controlRequest(stateDir, {
      command: 'owner_channel_manage', ownerChannel: { action: 'startup_failure' },
    }, 2_000);
    if (!response.ok) throw new Error(response.error ?? 'prior owner channel refused startup notice');
    const result = response.result as { action?: string; status?: string } | undefined;
    if (result?.action !== 'startup_failure'
        || (result.status !== 'delivered' && result.status !== 'duplicate'))
      throw new Error('prior owner channel returned an invalid startup notice result');
    return result.status;
  },
});

const MONITOR_OWNER_FILE = '.monitor-owner';
/** Fleet roles consume the operator-owned daemon; a role session never starts it. */
const FLEET_OURS_AUTOSTART = '0';

/** Environment injected only into the managed harness process. */
export function managedFleetProxyEnv(
  role: ResolvedRole, stateDir: string,
): Record<string, string> {
  return {
    ...(role.env ?? {}),
    // This must win over both inherited/configured auto-start. ACP agents run
    // directly rather than through ours-codex, so the runner owns this fence.
    OURS_AUTOSTART: FLEET_OURS_AUTOSTART,
    [FLEET_PROXY_STATE_DIR_ENV]: stateDir,
    [FLEET_PROXY_CALLER_ENV]: role.name,
  };
}

/**
 * Execute a typed proxy request in the caller's supervisor. Dynamic imports
 * avoid a runner↔spawn initialization cycle (spawn imports runner constants).
 */
async function executeManagedSpawn(
  caller: ResolvedRole, configPath: string | undefined, requested: SpawnOpts,
  log: (line: string) => void,
): Promise<ManagedFleetSpawnResult> {
  const { options, inherited } = inheritCallerSpawnDefaults(caller, requested, configPath);
  const creationActionId = randomUUID();
  options.creationActionId = creationActionId;
  const spawnModule = await import('./spawn.js');
  const preview = spawnModule.spawnDryRun(options).resolvedRole;
  const runtimeBinPath = (() => {
    try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; }
  })();
  let statePath: string;
  if (options.temp) {
    statePath = await spawnModule.spawnTemp(options, runtimeBinPath);
  } else {
    const { pickBackend } = await import('./supervisor/index.js');
    const { WatchdogServiceManager } = await import('./watchdog/service.js');
    statePath = await spawnModule.spawnPermanent(options, {
      backend: pickBackend(), binPath: runtimeBinPath, log,
      watchdogService: new WatchdogServiceManager(),
    });
  }
  const result: ManagedFleetSpawnResult = {
    caller: caller.name,
    role: options.name,
    lifetime: options.temp ? 'temporary' : 'permanent',
    statePath,
    harness: preview.harness,
    session: preview.session,
    ...(preview.model ? { model: preview.model } : {}),
    monitor: { mode: preview.monitor.mode, interrupt: preview.monitor.interrupt },
    permissionMode: effectivePermissionMode(preview),
    inherited,
    creationActionId,
  };
  log(`[${caller.name}] managed fleet proxy spawned ${result.lifetime} role ${result.role} `
    + `harness=${result.harness} session=${result.session} `
    + `permission=${result.permissionMode!.fleetMode} `
    + `native=${result.permissionMode!.nativeMode}`);
  return result;
}

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
    // Tmux roles have the same daemon-client boundary as ACP roles. Keep this
    // last so neither harness preparation nor a role env block can take over
    // the shared daemon lifecycle.
    OURS_AUTOSTART: FLEET_OURS_AUTOSTART,
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
  /** Present only when a temporary-role lifecycle signal ended the session. */
  retirementReason?: 'identity-closed' | 'operator-stop' | 'supervisor-signal';
}

/** Continuous authoritative absence required after an identity was observed. */
export const TEMP_IDENTITY_CLOSE_DEBOUNCE_MS = 5_000;
/** Lifecycle polling is deliberately slower than the 500ms stop-signal loop. */
export const TEMP_IDENTITY_POLL_MS = 2_000;

/** Only authenticated wake interrupts may turn a temp startup cancellation into readiness. */
export function isRecoverableTempStartupCancellation(
  temp: boolean, result: TurnResult,
): boolean {
  return temp && result.accepted && result.outcome === 'cancelled'
    && (result.cancellationSource === 'local-console'
      || result.cancellationSource === 'fleet-monitor');
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
  let acpSession: SessionHandle | undefined;
  let control: ReturnType<RunnerDeps['createControlServer']> | undefined;
  let unsubscribeRecovery: (() => void) | undefined;
  let monitorLoop: Promise<void> | undefined;
  let acpStartupComplete = false;
  let sessionClosed = false;
  let ownerChannel: OwnerChannelHandle | undefined;
  let ownerBinder: OwnerBinderLease | undefined;
  const pendingFleetSpawnNotices: ManagedFleetSpawnResult[] = [];
  let loopManager: ScheduledLoopManagerHandle | undefined;
  let arbiter: RoleTurnArbiter | undefined;
  let reloadLoopConfig: (() => Promise<{ changed: boolean; loops: number }>) | undefined;
  let loopGeneration = JSON.stringify((role.loops ?? []).map(loop => [
    loop.name, loop.definitionHash, loop.promptHash,
  ]));
  if (sessionBackend === 'acp') {
    const perms = role.permissions ?? resolvePermissions(undefined, undefined);
    // Say once, at startup, that this role will decide permission requests by
    // itself. Without it the only trace of an auto-denied tool call is a turn
    // that quietly did less than it was asked to.
    if (perms.unattended === 'deny')
      deps.log(`[${name}] permission policy: unattended=deny — with no console attached, ` +
        `permission requests are automatically denied once each (reject_once) and the turn continues`);
    acpSession = await deps.startAcpSession({
      name,
      argv: wrappedArgv,
      cwd: runCwd,
      env: { ...launch.env, ...managedFleetProxyEnv(role, dir) },
      stateDir: dir,
      mode,
      permissions: perms,
      modeId: adapter.acpPermissionModeId?.(role),
      permissionMode: effectivePermissionMode(role),
      // Provenance travels with the exact ACP launch. Keeping it out of a
      // role-only adapter hook prevents a PATH fallback or resolver skew from
      // claiming metadata trust for an argv it did not authenticate.
      permissionMetadataSource: (launch as AcpLaunch).permissionMetadataSource,
      log: deps.log,
    });
    pid = acpSession.pid;
    arbiter = new RoleTurnArbiter(acpSession);
    sessionHandle = arbiter;
    unsubscribeRecovery = acpSession.subscribe(event => {
      if (event.kind !== 'error' || !event.text) return;
      const evidence = classifyFailureText(
        event.text, 'acp', new Date(deps.now()).toISOString());
      if (evidence) resolvedMonitorDeps.onFailureEvidence?.(evidence);
    });
    if (role.owner_channel) {
      try {
        ownerBinder = await deps.acquireOwnerBinder(
          dir, name, role.owner_channel.identity);
      } catch (error) {
        if (error instanceof OwnerBinderHandoffTimeoutError) {
          try {
            const status = await deps.reportOwnerStartupFailure(dir);
            deps.log(`[${name}] owner channel startup recovery notice ${status} by authenticated predecessor`);
          } catch (notifyError) {
            deps.log(`[${name}] owner channel startup recovery notice unavailable: `
              + `${(notifyError as Error)?.message ?? String(notifyError)}`);
          }
        }
        await acpSession.close();
        unsubscribeRecovery?.();
        throw new Error(`[${name}] owner channel failed to start: `
          + `${(error as Error)?.message ?? String(error)}`);
      }
    }
    control = deps.createControlServer(dir, arbiter, deps.log);
    try { await control.start(); }
    catch (error) {
      ownerBinder?.release();
      await acpSession.close();
      unsubscribeRecovery?.();
      throw error;
    }
    control.setFleetSpawner(async requested => {
      const event = await executeManagedSpawn(role, configPath, requested, deps.log);
      if (!role.owner_channel) return event;
      if (ownerChannel?.notifyFleetSpawn) {
        try { await ownerChannel.notifyFleetSpawn(event); }
        catch (error) {
          deps.log(`[${name}] spawned-agent owner notice failed: `
            + `${(error as Error)?.message ?? String(error)}`);
        }
      } else pendingFleetSpawnNotices.push(event);
      return event;
    });
    resolvedMonitorDeps.delivery = {
      // A wake is only delivered when its turn TERMINATES successfully. A
      // refusal or a cancellation reached the agent and was not acted on, so
      // the monitor must keep its cursor and try again.
      submit: async (text, options) => {
        // Cancelling the runner-owned startup prompt makes startup look failed
        // and closes the session before the wake turn can run. During startup,
        // steer into the live turn instead; after it completes, honor the
        // configured interrupt policy normally.
        const policy = options?.interrupt;
        const interrupt = policy === true && acpStartupComplete;
        const promptOptions = {
          interrupt, steer: true,
          ...(interrupt ? { interruptSource: 'fleet-monitor' as const } : {}),
          origin: { kind: 'fleet-monitor' as const },
        };
        // Startup is already a protected boundary: as with immediate mode,
        // steer rather than waiting on/cancelling the runner-owned first turn.
        const result = policy === 'after_tool' && acpStartupComplete
          ? await arbiter!.submitPromptAfterTool(text, promptOptions)
          : await arbiter!.submitPrompt(text, promptOptions);
        const steered = result.accepted
          && (result.detail === 'injected' || result.detail === 'startedNewTurn');
        const boundary = result.safeBoundary;
        const queuedAfterSteeringFailure = result.detail?.startsWith('steering rejected;') === true;
        const boundaryDetail = boundary && queuedAfterSteeringFailure
          ? boundary.state === 'timeout'
            ? `after_tool timed out after ${boundary.waitedMs}ms; steering rejected, queued without cancellation`
            : `after_tool ${boundary.state} boundary after ${boundary.waitedMs}ms; steering rejected, queued without cancellation`
          : boundary
          ? boundary.state === 'timeout'
            ? `after_tool timed out after ${boundary.waitedMs}ms; steered without cancellation`
            : boundary.state === 'unsupported'
              ? 'after_tool unsupported; used non-cancelling queued delivery'
              : `after_tool ${boundary.state} delivery after ${boundary.waitedMs}ms`
          : result.detail;
        return {
          succeeded: result.succeeded || steered,
          outcome: steered ? result.detail! : result.outcome,
          detail: result.succeeded || steered || !boundary
            ? boundaryDetail
            : [result.detail, boundaryDetail].filter(Boolean).join('; '),
          ...(boundary ? { safeBoundary: boundary.state } : {}),
        };
      },
    };
    const firstPrompt = mode === 'fresh'
      ? `Read and follow ${join(dir, 'briefing.md')} now.`
      : adapter.vocabulary.restartPrompt(role.identity, join(dir, 'WORKLOG.md'), role);
    // Wait for the first turn's TERMINAL result. An agent that accepts the
    // startup prompt and then refuses it has not started; logging the role as
    // up would hide a role that never read its briefing.
    const starting = arbiter.submitPrompt(firstPrompt, { origin: { kind: 'startup' } });
    // Monitoring starts immediately. The delivery adapter above downgrades
    // interruption to steering until this startup turn reaches a terminal
    // success, so there is neither a deaf gap nor a boot-cancellation loop.
    monitorLoop = monitor?.run(pid);
    const started = await starting;
    // A temporary role's first turn can be the active turn when an ours wake
    // needs immediate attention. A typed console/monitor cancellation ends
    // only that turn: the already-live ACP session and any queued wake remain
    // valid. Keep every unproven cancellation, refusal, shutdown, and genuine
    // failure terminal so a role that never accepted its briefing is not
    // silently reported as healthy.
    const interruptedForWake = isRecoverableTempStartupCancellation(temp, started);
    if (!started.succeeded && !interruptedForWake) {
      monitor?.stop();
      await control.close();
      ownerBinder?.release();
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
    if (interruptedForWake)
      deps.log(`[${name}] ACP startup prompt cancelled by ${started.cancellationSource}; `
        + 'keeping temporary supervisor alive');
    acpStartupComplete = true;
    if (role.owner_channel) {
      ownerChannel = deps.createOwnerChannel({
        role: name,
        harness: role.harness,
        config: role.owner_channel,
        session: arbiter,
        stateDir: dir,
        env: role.env,
        log: deps.log,
        ...(ownerBinder ? { binderLease: ownerBinder } : {}),
        ...(configPath ? { configPath } : {}),
      });
      try { await ownerChannel.start(); }
      catch (error) {
        monitor?.stop();
        if (monitorLoop) await monitorLoop;
        await ownerChannel.close().catch(() => undefined);
        await control.close();
        ownerBinder?.release();
        await acpSession.close();
        unsubscribeRecovery?.();
        throw new Error(`[${name}] owner channel failed to start: `
          + `${(error as Error)?.message ?? String(error)}`);
      }
      for (const event of pendingFleetSpawnNotices.splice(0)) {
        try { await ownerChannel.notifyFleetSpawn?.(event); }
        catch (error) {
          deps.log(`[${name}] deferred spawned-agent owner notice failed: `
            + `${(error as Error)?.message ?? String(error)}`);
        }
      }
    }
    if (ownerChannel) control.setOwnerChannel(ownerChannel);
    reloadLoopConfig = async (): Promise<{ changed: boolean; loops: number }> => {
      const nextRole = findRole(loadConfig(configPath), name);
      const definitions = nextRole.loops ?? [];
      const generation = JSON.stringify(definitions.map(loop => [
        loop.name, loop.definitionHash, loop.promptHash,
      ]));
      if (generation === loopGeneration && (loopManager || !definitions.length))
        return { changed: false, loops: definitions.length };
      if (!loopManager && definitions.length) {
        loopManager = new ScheduledLoopManager(name, definitions, dir, arbiter!, {
          now: deps.now,
          setTimer: (callback, ms) => setTimeout(callback, ms),
          clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
          log: deps.log,
        });
        control!.setLoopManager(loopManager);
        loopManager.start();
      } else {
        loopManager?.reconcile(definitions);
      }
      loopGeneration = generation;
      deps.log(`[${name}] scheduled loops reloaded (${definitions.length} definitions)`);
      return { changed: true, loops: definitions.length };
    };
    control.setConfigReloader(reloadLoopConfig);
    if (role.loops?.length) {
      try {
        loopManager = new ScheduledLoopManager(name, role.loops, dir, arbiter, {
          now: deps.now,
          setTimer: (callback, ms) => setTimeout(callback, ms),
          clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
          log: deps.log,
        });
        control.setLoopManager(loopManager);
        loopManager.start();
      } catch (error) {
        deps.log(`[${name}] scheduled loop manager unavailable: ${(error as Error)?.name ?? 'Error'}`);
      }
    }
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
  let nextLoopReloadAt = deps.now() + 30_000;
  let nextIdentityPollAt = deps.now();
  let lastReloadError = '';
  let identityObserved = false;
  let identityAbsentSince: number | undefined;
  let retirementReason: AttemptResult['retirementReason'];
  while (sessionHandle.isAlive()) {
    await deps.sleep(temp ? 500 : 2000);
    const now = deps.now();
    if (temp && deps.shouldStop?.()) {
      retirementReason = requestedTempStopReason(dir) ?? 'supervisor-signal';
      deps.log(`[${name}] temporary supervisor retirement requested (${retirementReason})`);
      await sessionHandle.close();
      sessionClosed = true;
      break;
    }
    if (temp && now >= nextIdentityPollAt) {
      nextIdentityPollAt = now + TEMP_IDENTITY_POLL_MS;
      const presence = await probeIdentityPresence(
        role.identity, deps.fetch, resolvedMonitorDeps.env);
      if (presence.state === 'present') {
        identityObserved = true;
        identityAbsentSince = undefined;
      } else if (presence.state === 'absent' && identityObserved) {
        identityAbsentSince ??= now;
        // Require a continuous, time-bounded run of authoritative absence.
        // The first positive observation is the readiness gate: cold tmux
        // starts may spend minutes loading the harness and briefing before the
        // agent creates/binds its identity, and absence before then is not a
        // close event. After readiness, debounce a real disappearance.
        if (now - identityAbsentSince >= TEMP_IDENTITY_CLOSE_DEBOUNCE_MS) {
          retirementReason = 'identity-closed';
          deps.log(`[${name}] temporary identity '${role.identity}' closed; retiring session and supervisor`);
          await sessionHandle.close();
          sessionClosed = true;
          break;
        }
      } else if (presence.state === 'unknown') identityAbsentSince = undefined;
    }
    if (reloadLoopConfig && now >= nextLoopReloadAt) {
      nextLoopReloadAt = now + 30_000;
      try {
        await reloadLoopConfig();
        lastReloadError = '';
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        if (message !== lastReloadError)
          deps.log(`[${name}] scheduled loop config reload rejected: ${message}`);
        lastReloadError = message;
      }
    }
  }
  if (loopManager) {
    control?.setLoopManager(undefined);
    await loopManager.stop();
  }
  control?.setConfigReloader(undefined);
  // Close the authenticated control route before releasing the binder lease;
  // otherwise the predecessor can unlink the replacement's new socket.
  if (control) {
    control.setOwnerChannel(undefined);
    await control.close();
    control = undefined;
  }
  if (ownerChannel) await ownerChannel.close();
  ownerBinder?.release();
  if (monitor) { monitor.stop(); await monitorLoop; }
  unsubscribeRecovery?.();
  if (acpSession && !sessionClosed) await acpSession.close();
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
  if (exitRecord.detail.includes(ACP_CANCEL_DEADLINE_EXCEEDED))
    // This is a deliberate adapter reclamation, not evidence that resume state
    // is poisoned. Preserve the context even when the resumed generation hits
    // the same bound immediately; runSupervised still counts the fast exit and
    // opens its circuit after the configured number of consecutive failures.
    deps.log(`[${name}] forced cancellation recovery (${elapsed.toFixed(0)}s, ${exitRecord.detail}) ` +
      `-> next start RESUMES context`);
  else if (exitRecord.class === 'clean' && adapter.exitPolicy.cleanExitIsFresh)
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

  return {
    elapsedSecs: elapsed, exit: exitRecord, rotated, mode, modelRecovery,
    ...(retirementReason ? { retirementReason } : {}),
  };
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
    // The fast-fail boundary starts a recovery episode; it must not also be
    // the boundary that declares recovery successful. Otherwise alternating
    // 19s and 20s deaths erase one another forever. Require the configured
    // number of fast-fail windows to survive before closing an active streak.
    // This hysteresis stays adapter-relative (100s for the current 20s/5-attempt
    // policy) and still lets a genuinely sustained session reset the breaker.
    const stableRecoverySecs = fastFailSecs * RESTART_FAIL_THRESHOLD;
    const recoveryFailed = result.elapsedSecs < fastFailSecs
      || (ledger.consecutiveImmediateFailures > 0 && result.elapsedSecs < stableRecoverySecs);

    if (!recoveryFailed) {
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

/** Temp-agent entrypoint: run once, journal why it ended, then archive its evidence. */
export async function runTemp(name: string, deps: Partial<RunnerDeps> = {}): Promise<void> {
  const dir = agentDir(name, true);
  await markTempSupervisorActive(dir);
  let signal: NodeJS.Signals | undefined;
  const onTerm = () => { signal = 'SIGTERM'; };
  const onInt = () => { signal = 'SIGINT'; };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  let result: AttemptResult | undefined;
  let failure: unknown;
  try {
    result = await runOnce(name, { temp: true }, {
      ...deps,
      shouldStop: () => Boolean(signal) || (deps.shouldStop?.() ?? false),
    });
  } catch (error) {
    failure = error;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    const requested = requestedTempStopReason(dir);
    const reason: TempTerminationReason = requested
      ?? result?.retirementReason
      ?? (signal ? 'supervisor-signal' : failure ? 'startup-failure' : 'session-ended');
    // A service-manager stop can make the child connection close before the
    // runner reaches its normal loop. That is still a successful requested
    // retirement, not a startup failure.
    const outcome = failure && !requested && !signal ? 'failed' : 'retired';
    const detail = failure
      ? (failure instanceof Error ? failure.message : String(failure))
      : result
        ? `${result.exit.detail}; elapsed=${result.elapsedSecs.toFixed(1)}s`
        : 'temporary supervisor ended without an attempt result';
    const archived = archiveTempState(name, reason, outcome, detail);
    deps.log?.(`[${name}] temporary lifecycle ${outcome}: ${reason}`
      + `${archived ? `; evidence archived at ${archived}` : '; state already archived'}`);
  }
  if (failure) throw failure;
}
