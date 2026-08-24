import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Launch a Fleet CLI operation outside the caller's supervisor/session lifecycle. */
export function launchFleetWorker(
  args: string[], operation: string, configPath?: string,
): Promise<void> {
  const cli = [process.argv[1], ...args, ...(configPath ? ['-c', configPath] : [])];
  const inheritedKeys = [
    'HOME', 'PATH', 'XDG_RUNTIME_DIR', 'OURS_FLEET_HOME', 'OURS_CONFIG',
    'OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN', 'OURS_COWORK_CONFIG',
  ];
  const inherited = inheritedKeys
    .flatMap(key => process.env[key] === undefined ? [] : [`${key}=${process.env[key]}`]);
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
    const env = Object.fromEntries(inherited.map(value => {
      const split = value.indexOf('=');
      return [value.slice(0, split), value.slice(split + 1)];
    }));
    const child = spawn(process.execPath, cli, { detached: true, stdio: 'ignore', env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
