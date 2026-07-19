import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { agentDir, home, stateRoot } from './paths.js';
import { loadConfig, findRole, type ResolvedRole } from './config.js';
import { getAdapter } from './harness/registry.js';
import type { Launch } from './harness/types.js';
import { Tmux } from './tmux.js';
import { createMonitor, type MonitorDeps, type MonitorHandle, type MonitorOpts, type FetchLike } from './monitor.js';
import { realExec, shq, type Exec } from './exec.js';
import { resolveIsolation } from './isolation/policy.js';
import { selectIsolationBackend } from './isolation/registry.js';
import { resourceArgs, cpuControllerDelegated } from './isolation/resources.js';
import type { WrapContext } from './isolation/types.js';

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
  const env = { PATH: process.env.PATH ?? '', ...launch.env, ...(roleEnv ?? {}) };
  const envPfx = 'env ' + Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  const cmd = paneArgv.map(shq).join(' ');
  return `${envPfx} ${cmd}; echo $? > ${shq(exitStatusPath)}`;
}

/** Adapt the runner's injected deps into the monitor's dependency surface. */
function monitorDeps(deps: RunnerDeps): MonitorDeps {
  return {
    fetch: deps.fetch,
    tmux: deps.tmux,
    isAlive: deps.isAlive,
    sleep: deps.sleep,
    now: deps.now,
    log: deps.log,
    env: process.env,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t) },
  };
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

/** One supervised session lifecycle. The supervisor re-invokes us after we return. */
export async function runOnce(
  name: string,
  opts: { temp?: boolean; configPath?: string } = {},
  partialDeps: Partial<RunnerDeps> = {},
): Promise<void> {
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
  const adapter = getAdapter(role.harness);
  mkdirSync(dir, { recursive: true });

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
  const launch = adapter.buildLaunch(role, mode, { sessionId }, prep);

  // Isolation is additive: only roles that declare `isolation:` are wrapped. The
  // env prefix + exit capture in buildPaneCommand stay host-side (see §5.3).
  let paneArgv = launch.argv;
  if (role.isolation) {
    const addDirs = role.harness === 'codex'
      ? ((role.harness_options as { add_dirs?: string[] } | undefined)?.add_dirs ?? [])
      : [];
    const ctx: WrapContext = {
      stateDir: dir, runCwd, home: home(), harness: role.harness, additionalWriteDirs: addDirs,
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
    paneArgv = sel.backend.wrap(launch.argv, policy, ctx);

    // Resource caps wrap the sandbox from OUTSIDE, at the pane's own cgroup scope
    // (§5.4). Applies even when the sandbox degraded to none.
    const { argv: rprefix, warnings } = resourceArgs(policy.resources, deps.cpuDelegated());
    for (const w of warnings) deps.log(`[${name}] WARNING ${w}`);
    if (rprefix.length) paneArgv = [...rprefix, ...paneArgv];
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
  // (backlog before the tip is the SessionStart hook's job). Disabled roles keep
  // the legacy in-session watch. Temp snapshots predating `monitor:` are treated
  // as disabled (monitor may be undefined on an old role.yaml).
  const monitor = role.monitor?.enabled ? deps.createMonitor({
    name, agentDir: dir, cfg: role.monitor,
    deps: monitorDeps(deps),
  }) : null;
  if (monitor) await monitor.prime();

  rmSync(exitFile, { force: true });
  await deps.tmux.kill(name);
  await deps.tmux.newSession(name, runCwd, buildPaneCommand(launch, role.env, exitFile, paneArgv));

  let pid: number | null = null;
  for (let i = 0; i < 40 && pid === null; i++) {
    pid = await deps.tmux.panePid(name);
    if (pid === null) await deps.sleep(250);
  }
  if (pid === null) throw new Error(`[${name}] could not resolve tmux pane pid`);
  deps.log(`[${name}] up; pid=${pid} cwd=${runCwd} harness=${role.harness} mode=${mode}`);

  // The monitor loop lives exactly as long as the session: it starts once the
  // pane pid is known and is stopped when that pid dies (task dies with runner).
  const monitorLoop = monitor?.run(pid);

  const start = deps.now();
  while (deps.isAlive(pid)) await deps.sleep(2000);
  if (monitor) { monitor.stop(); await monitorLoop; }
  const elapsed = (deps.now() - start) / 1000;
  const code = existsSync(exitFile) ? readFileSync(exitFile, 'utf8').trim() : 'crash';

  const rotate = (why: string) => {
    writeFileSync(sidFile, randomUUID() + '\n');
    rmSync(bootedFile, { force: true });
    deps.log(`[${name}] ${why} -> rotated session-id; next start is FRESH`);
  };
  if (code === '0' && adapter.exitPolicy.cleanExitIsFresh) rotate(`clean exit (code 0)`);
  else if (mode === 'resume' && elapsed < adapter.exitPolicy.fastFailSecs)
    rotate(`resume failed fast (${elapsed.toFixed(0)}s, code ${code})`);
  else deps.log(`[${name}] exited (code ${code}, ${elapsed.toFixed(0)}s) -> next start RESUMES context`);
}

/** Temp-agent entrypoint: run one session, then remove the temp dir. */
export async function runTemp(name: string, deps: Partial<RunnerDeps> = {}): Promise<void> {
  try {
    await runOnce(name, { temp: true }, deps);
  } finally {
    rmSync(agentDir(name, true), { recursive: true, force: true });
  }
}
