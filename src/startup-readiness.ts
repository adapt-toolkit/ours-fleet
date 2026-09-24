import { agentDir } from './paths.js';
import { findRole, loadConfig } from './config.js';
import { resolveConfigPath } from './runner.js';
import { probeDaemonGeneration, type DaemonGenerationProbe } from './daemon-recovery.js';
import type { FetchLike } from './monitor.js';

export const STARTUP_WAIT_MS = 240_000;
export const STARTUP_RETRY_MS = 5_000;
interface ReadinessDeps {
  probe(env: NodeJS.ProcessEnv): Promise<DaemonGenerationProbe>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  env: NodeJS.ProcessEnv;
}

/** Read-only preflight: never binds identities, starts a harness or edits its ledger. */
export async function waitForRoleDaemon(
  name: string, configPath?: string, partial: Partial<ReadinessDeps> = {},
): Promise<void> {
  const deps: ReadinessDeps = {
    probe: env => probeDaemonGeneration(
      ((url, init) => globalThis.fetch(url, {
        ...init, signal: AbortSignal.timeout(10_000),
      })) as FetchLike, env),
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: message => process.stderr.write(message + '\n'),
    env: process.env,
    ...partial,
  };
  const path = resolveConfigPath(agentDir(name), configPath);
  const role = findRole(loadConfig(path), name);
  const env = { ...deps.env, ...role.env };
  const deadline = deps.now() + STARTUP_WAIT_MS;
  let lastReason = '';
  while (deps.now() < deadline) {
    const result = await deps.probe(env);
    if (result.state === 'ready') {
      deps.log(`[${name}] daemon ready; starting supervised agent`);
      return;
    }
    // Only structured diagnostic codes, never endpoint responses or credentials.
    const reason = /^[A-Z][A-Z0-9_]*$/.test(result.reason) ? result.reason : 'DAEMON_UNAVAILABLE';
    if (reason !== lastReason) deps.log(`[${name}] waiting for configured daemon: ${reason}`);
    lastReason = reason;
    await deps.sleep(Math.min(STARTUP_RETRY_MS, Math.max(0, deadline - deps.now())));
  }
  throw new Error(`Daemon not ready (${lastReason}); service manager will retry startup`);
}
