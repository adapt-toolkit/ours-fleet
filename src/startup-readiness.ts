import { agentDir } from './paths.js';
import { findRole, loadConfig } from './config.js';
import { resolveConfigPath, loadTempRole } from './runner.js';
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
  name: string, configPath?: string, partial: Partial<ReadinessDeps> = {}, temp = false,
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
  const role = temp ? loadTempRole(name) : findRole(loadConfig(path), name);
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

interface RoomManagementDeps {
  /** Read-only room observation; production uses Cowork `room.show`. */
  showRoom(roomId: string, env: NodeJS.ProcessEnv): Promise<unknown>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  env: NodeJS.ProcessEnv;
  shouldStop(): boolean;
}

/**
 * Read-only preflight for a room member: wait while Cowork management is still
 * starting behind the gateway. Only a retryable `CoworkUnavailableError` waits;
 * success, any other error and the deadline all return so the real attempt
 * decides, fails closed and counts. Never redeems invites, binds identities or
 * judges room/seat identity — that remains the attempt's admission check.
 */
export async function waitForTaskRoomManagement(
  name: string, partial: Partial<RoomManagementDeps> = {},
): Promise<'ready' | 'not-required' | 'unavailable' | 'deferred'> {
  let role: ReturnType<typeof loadTempRole>;
  // An unreadable snapshot is the attempt's failure to report, not this wait's.
  try { role = loadTempRole(name); } catch { return 'deferred'; }
  const startup = role.roomMemberStartup;
  if (!startup) return 'not-required';
  const { createCoworkAdapter, CoworkUnavailableError } = await import('./rooms-tasks/cowork-adapter.js');
  const deps: RoomManagementDeps = {
    showRoom: (roomId, env) => createCoworkAdapter({ env }).getRoom(roomId),
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: message => process.stderr.write(message + '\n'),
    env: process.env,
    shouldStop: () => false,
    ...partial,
  };
  const env = { ...deps.env, ...role.env };
  const started = deps.now();
  const deadline = started + STARTUP_WAIT_MS;
  let waited = false;
  for (;;) {
    try {
      await deps.showRoom(startup.room_id, env);
      if (waited) deps.log(`[${name}] cowork room management ready after ${deps.now() - started}ms`);
      return 'ready';
    } catch (error) {
      if (!(error instanceof CoworkUnavailableError) || !error.retryable) return 'deferred';
      if (!waited) deps.log(`[${name}] waiting for cowork room management: ${error.message}`);
      waited = true;
      if (deps.shouldStop()) return 'unavailable';
      if (deps.now() >= deadline) {
        deps.log(`[${name}] cowork room management still unavailable after ${STARTUP_WAIT_MS}ms: `
          + `${error.message}; starting the attempt so the restart budget applies`);
        return 'unavailable';
      }
      await deps.sleep(Math.min(STARTUP_RETRY_MS, Math.max(0, deadline - deps.now())));
    }
  }
}
