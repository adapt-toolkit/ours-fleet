import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { replaceFileAtomically } from './atomic-file.js';
import { home } from './paths.js';
import type { Exec } from './exec.js';
import { clientConfigPath } from './client-profile.js';

export const taskSystemdUnit = (role: string) => `ours-fleet-task-${role}.service`;
export const taskLaunchdLabel = (role: string) => `network.ours.fleet.task.${role}`;
const unitPath = (role: string) => join(home(), '.config', 'systemd', 'user', taskSystemdUnit(role));
const plistPath = (role: string) => join(home(), 'Library', 'LaunchAgents', `${taskLaunchdLabel(role)}.plist`);
const unitArg = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const envForService = (): Record<string, string> => Object.fromEntries([
  'HOME', 'PATH', 'XDG_RUNTIME_DIR', 'OURS_FLEET_HOME', 'OURS_FLEET_SOCKET_ROOT', 'CODEX_HOME', 'CODEX_PATH',
].flatMap(key => process.env[key] !== undefined ? [[key, process.env[key]!]] : []).concat([['OURS_CONFIG', clientConfigPath(process.env)]]));
async function checked(exec: Exec, command: string, args: string[]): Promise<void> {
  const result = await exec(command, args);
  if (result.code !== 0) throw Error(`${command} ${args[0]} failed (${result.code})`);
}

/** Separate task services never reuse the standalone-agent template or manifest. */
export async function installTaskSupervisorService(
  role: string, binPath: string, dir: string, platform: NodeJS.Platform, exec: Exec,
): Promise<{ kind: 'systemd-persistent' | 'launchd-persistent'; target: string }> {
  const env = envForService(), log = join(dir, 'supervisor.log');
  if (!/^[A-Za-z0-9_-]+$/.test(role) || [binPath, dir, ...Object.values(env)].some(value => /[\r\n\0]/.test(value)))
    throw Error('TASK_SERVICE_INVALID_INPUT');
  if (platform === 'linux') {
    const target = taskSystemdUnit(role), path = unitPath(role);
    mkdirSync(join(path, '..'), { recursive: true });
    const contents = `[Unit]\nDescription=ours-fleet task member ${role}\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\n${Object.entries(env).map(([key, value]) => `Environment=${unitArg(`${key}=${value}`)}`).join('\n')}\nExecStartPre=${unitArg(process.execPath)} ${unitArg(binPath)} _wait-temp-daemon ${unitArg(role)}\nTimeoutStartSec=270\nExecStart=${unitArg(process.execPath)} ${unitArg(binPath)} _run-temp ${unitArg(role)}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=15\nStandardOutput=append:${log.replaceAll('%', '%%')}\nStandardError=append:${log.replaceAll('%', '%%')}\n\n[Install]\nWantedBy=default.target\n`;
    if (existsSync(path) && readFileSync(path, 'utf8') !== contents)
      throw Error('TASK_SERVICE_COLLISION');
    replaceFileAtomically(path, contents);
    await checked(exec, 'systemctl', ['--user', 'daemon-reload']);
    await checked(exec, 'loginctl', ['enable-linger', userInfo().username]);
    await checked(exec, 'systemctl', ['--user', 'enable', '--now', target]);
    return { kind: 'systemd-persistent', target };
  }
  if (platform !== 'darwin') throw Error('TASK_DURABLE_SUPERVISOR_UNAVAILABLE');
  const target = taskLaunchdLabel(role), path = plistPath(role);
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${target}</string><key>ProgramArguments</key><array>${[process.execPath, binPath, '_run-temp', role].map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') !== contents) throw Error('TASK_SERVICE_COLLISION');
  replaceFileAtomically(path, contents);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const loaded = await exec('launchctl', ['print', `${domain}/${target}`]);
  if (loaded.code !== 0) {
    if (!/could not find service|no such process/i.test(`${loaded.stdout}\n${loaded.stderr}`))
      throw Error('TASK_SERVICE_LIVENESS_UNKNOWN');
    await checked(exec, 'launchctl', ['bootstrap', domain, path]);
  }
  return { kind: 'launchd-persistent', target };
}

/** A failed disable/bootout keeps the state and retirement cursor retryable. */
export async function uninstallTaskSupervisorService(
  role: string, kind: string, target: string, exec: Exec,
): Promise<void> {
  if (kind === 'systemd-persistent') {
    if (target !== taskSystemdUnit(role)) throw Error('TASK_SERVICE_TARGET_MISMATCH');
    const result = await exec('systemctl', ['--user', 'disable', '--now', target]);
    if (result.code !== 0 && !/not (?:be )?(?:found|loaded)|could not be found|does not exist/i.test(result.stderr))
      throw Error('TASK_SERVICE_DISABLE_FAILED');
    rmSync(unitPath(role), { force: true });
    await checked(exec, 'systemctl', ['--user', 'daemon-reload']);
  } else if (kind === 'launchd-persistent') {
    if (target !== taskLaunchdLabel(role)) throw Error('TASK_SERVICE_TARGET_MISMATCH');
    const result = await exec('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${target}`]);
    if (result.code !== 0 && !/could not find|no such process/i.test(`${result.stdout}\n${result.stderr}`))
      throw Error('TASK_SERVICE_BOOTOUT_FAILED');
    rmSync(plistPath(role), { force: true });
  } else throw Error('TASK_SERVICE_KIND_MISMATCH');
}
