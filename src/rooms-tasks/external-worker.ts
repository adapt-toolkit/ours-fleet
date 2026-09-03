import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV } from '../fleet-proxy.js';
import type { FleetAuditPresentation } from '../fleet-command-audit.js';
import { controlRequest } from '../session/control.js';
import { SessionControlError } from '../session/types.js';

/** Lifecycle-only return path for a trusted worker; never authorizes a fresh Fleet attempt. */
export const FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV = 'OURS_FLEET_WORKER_LIFECYCLE_STATE_DIR';

export function fleetWorkerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inheritedKeys = [
    'HOME', 'PATH', 'XDG_RUNTIME_DIR', 'OURS_FLEET_HOME', 'OURS_CONFIG',
    'OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN', 'OURS_COWORK_CONFIG',
  ];
  const env = Object.fromEntries(inheritedKeys.flatMap(key =>
    source[key] === undefined ? [] : [[key, source[key]!] as const]));
  const lifecycleStateDir = source[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV]
    ?? source[FLEET_PROXY_STATE_DIR_ENV];
  if (lifecycleStateDir) env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV] = lifecycleStateDir;
  // Explicit defense: trusted settle/recover/delete/close workers are effects
  // nested inside the outer audited command, never fresh agent attempts.
  delete env[FLEET_PROXY_STATE_DIR_ENV];
  delete env[FLEET_PROXY_CALLER_ENV];
  return env;
}

/** Present a detached worker's durable outcome through the authenticated Owner sink. */
export async function presentFleetWorkerLifecycle(
  presentations: FleetAuditPresentation[],
): Promise<void> {
  const stateDir = process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV];
  if (!stateDir || !presentations.length) return;
  const response = await controlRequest(stateDir, {
    command: 'fleet_audit_present', audit: { presentations },
  });
  if (!response.ok) throw new SessionControlError(
    response.kind ?? 'backend', response.error ?? 'detached Fleet lifecycle delivery failed');
}

/** Launch a Fleet CLI operation outside the caller's supervisor/session lifecycle. */
export function launchFleetWorker(
  args: string[], operation: string, configPath?: string,
): Promise<void> {
  const cli = [process.argv[1], ...args, ...(configPath ? ['-c', configPath] : [])];
  const env = fleetWorkerEnv();
  const inherited = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const suffix = randomUUID().slice(0, 8);
  const safeOperation = operation.replace(/[^A-Za-z0-9_.-]/g, '-');
  return new Promise((resolve, reject) => {
    if (process.env.OURS_FLEET_SUPERVISOR !== 'none' && process.platform === 'linux') {
      execFile('systemd-run', [
        '--user', '--quiet', '--collect',
        `--unit=ours-fleet-${safeOperation}-${suffix}`,
        '--property=Type=exec', '--property=KillMode=control-group',
        ...inherited.map(value => `--setenv=${value}`),
        process.execPath, ...cli,
      ], { timeout: 15_000 }, error => error ? reject(error) : resolve());
      return;
    }
    if (process.env.OURS_FLEET_SUPERVISOR !== 'none' && process.platform === 'darwin') {
      execFile('launchctl', [
        'submit', '-l', `network.ours.fleet.${safeOperation}.${suffix}`, '--',
        '/usr/bin/env', ...inherited, process.execPath, ...cli,
      ], { timeout: 15_000 }, error => error ? reject(error) : resolve());
      return;
    }
    const child = spawn(process.execPath, cli, { detached: true, stdio: 'ignore', env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
