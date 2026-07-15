import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { agentDir, home } from './paths.js';
import { loadConfig, findRole, type ResolvedRole } from './config.js';
import { getAdapter } from './harness/registry.js';
import type { Launch } from './harness/types.js';
import { Tmux } from './tmux.js';
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
}

const defaultDeps = (): RunnerDeps => ({
  tmux: new Tmux(),
  exec: realExec,
  cpuDelegated: () => cpuControllerDelegated(),
  isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  now: () => Date.now(),
  log: line => process.stderr.write(line + '\n'),
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

/** Read a temp role's config snapshot written by spawnTemp. */
export function loadTempRole(name: string): ResolvedRole {
  const p = join(agentDir(name, true), 'role.yaml');
  if (!existsSync(p)) throw new Error(`temp role '${name}' has no snapshot at ${p}`);
  const role = parse(readFileSync(p, 'utf8')) as ResolvedRole;
  (role as ResolvedRole & { __temp?: boolean }).__temp = true;
  return role;
}

/** One supervised session lifecycle. The supervisor re-invokes us after we return. */
export async function runOnce(
  name: string,
  opts: { temp?: boolean; configPath?: string } = {},
  partialDeps: Partial<RunnerDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps(), ...partialDeps };
  const temp = opts.temp === true;
  const role = temp ? loadTempRole(name) : findRole(loadConfig(opts.configPath), name);
  const adapter = getAdapter(role.harness);
  const dir = agentDir(name, temp);
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

  const start = deps.now();
  while (deps.isAlive(pid)) await deps.sleep(2000);
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
