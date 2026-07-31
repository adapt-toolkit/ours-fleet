import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { FleetError } from '../application/errors.js';
import { realExec, type Exec } from '../exec.js';
import { home } from '../paths.js';

export const WATCHDOG_SYSTEMD_UNIT = 'ours-fleet-watchdogs.service';
export const WATCHDOG_LAUNCHD_LABEL = 'network.ours.fleet.watchdogs';

/**
 * Supervises the single long-running watchdog-scheduler process (the hidden
 * `_run-watchdogs` command, Task 9's `runScheduler`) the same way
 * `WebServiceManager` (src/web/service.ts) supervises the web console: a
 * private systemd --user unit on Linux, a launchd LaunchAgent on macOS.
 */
export class WatchdogServiceManager {
  constructor(
    private readonly exec: Exec = realExec,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get definitionPath(): string {
    return this.platform === 'linux'
      ? join(home(), '.config', 'systemd', 'user', WATCHDOG_SYSTEMD_UNIT)
      : join(home(), 'Library', 'LaunchAgents', `${WATCHDOG_LAUNCHD_LABEL}.plist`);
  }

  /** false when explicitly disabled (OURS_FLEET_SUPERVISOR=none) or on an unsupported platform. */
  supervised(): boolean {
    if (process.env.OURS_FLEET_SUPERVISOR === 'none') return false;
    return this.platform === 'linux' || this.platform === 'darwin';
  }

  async install(binPath: string, configPath?: string): Promise<void> {
    const resolvedScript = resolveExecutable(binPath, 'ours-fleet CLI script');
    const runtime = resolveExecutable(process.execPath, 'Node runtime');
    const config = configPath ? resolve(configPath) : undefined;
    mkdirSync(dirname(this.definitionPath), { recursive: true, mode: 0o700 });
    replaceFileAtomically(this.definitionPath,
      this.platform === 'linux'
        ? watchdogSystemdUnit(runtime, resolvedScript, config)
        : watchdogLaunchdPlist(runtime, resolvedScript, config), 0o600);
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'daemon-reload']);
      await this.must('systemctl', ['--user', 'enable', WATCHDOG_SYSTEMD_UNIT]);
    }
  }

  async start(): Promise<void> {
    this.requireInstalled();
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'start', WATCHDOG_SYSTEMD_UNIT]);
      return;
    }
    const domain = `gui/${uid()}`;
    const loaded = await this.exec('launchctl', ['print', `${domain}/${WATCHDOG_LAUNCHD_LABEL}`]);
    if (loaded.code === 0) await this.must('launchctl', ['kickstart', `${domain}/${WATCHDOG_LAUNCHD_LABEL}`]);
    else await this.must('launchctl', ['bootstrap', domain, this.definitionPath]);
  }

  async stop(): Promise<void> {
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'stop', WATCHDOG_SYSTEMD_UNIT]);
      return;
    }
    const result = await this.exec('launchctl', ['bootout', `gui/${uid()}/${WATCHDOG_LAUNCHD_LABEL}`]);
    if (result.code !== 0 && !/could not find service|no such process/i.test(`${result.stdout}\n${result.stderr}`))
      throw new FleetError('control_unavailable', `launchctl bootout failed: ${result.stderr.trim()}`);
  }

  async status(): Promise<string> {
    if (this.platform === 'linux') {
      const result = await this.exec('systemctl', [
        '--user', 'show', WATCHDOG_SYSTEMD_UNIT, '-p', 'LoadState', '-p', 'ActiveState',
        '-p', 'SubState', '-p', 'ExecMainPID', '--no-pager',
      ]);
      return result.stdout.trim() || result.stderr.trim() || `exit ${result.code}`;
    }
    const result = await this.exec('launchctl', ['print', `gui/${uid()}/${WATCHDOG_LAUNCHD_LABEL}`]);
    return result.code === 0 ? result.stdout.trim() : `not loaded (${WATCHDOG_LAUNCHD_LABEL})`;
  }

  async uninstall(): Promise<void> {
    if (this.platform === 'linux') {
      await this.exec('systemctl', ['--user', 'disable', '--now', WATCHDOG_SYSTEMD_UNIT]);
      rmSync(this.definitionPath, { force: true });
      await this.exec('systemctl', ['--user', 'daemon-reload']);
    } else {
      await this.stop();
      rmSync(this.definitionPath, { force: true });
    }
  }

  private requireInstalled(): void {
    if (!existsSync(this.definitionPath))
      throw new FleetError('prerequisite_unavailable', 'watchdog scheduler service is not installed');
  }

  private async must(command: string, args: string[]): Promise<void> {
    const result = await this.exec(command, args);
    if (result.code !== 0)
      throw new FleetError('control_unavailable', `${command} ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

function uid(): number { return process.getuid?.() ?? 501; }

function resolveExecutable(executable: string, label: string): string {
  const absolute = isAbsolute(executable) ? executable : resolve(executable);
  try { return realpathSync(absolute); }
  catch { throw new FleetError('prerequisite_unavailable', `${label} does not exist: ${absolute}`); }
}

function systemdQuote(value: string): string {
  return `"${value.replace(/[%\\"]/g, char => char === '%' ? '%%' : `\\${char}`)}"`;
}

function watchdogSystemdUnit(runtime: string, script: string, configuration?: string): string {
  const config = configuration ? ` -c ${systemdQuote(configuration)}` : '';
  return `[Unit]\nDescription=ours-fleet watchdog scheduler\nAfter=default.target\n\n`
    + `[Service]\nType=simple\nExecStart=${systemdQuote(runtime)} ${systemdQuote(script)} _run-watchdogs${config}\n`
    + `Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n\n`
    + `[Install]\nWantedBy=default.target\n`;
}

const xml = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[char]!));

function watchdogLaunchdPlist(runtime: string, script: string, configuration?: string): string {
  const config = configuration
    ? `<string>-c</string><string>${xml(configuration)}</string>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0"><dict>\n<key>Label</key><string>${WATCHDOG_LAUNCHD_LABEL}</string>\n`
    + `<key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>${xml(script)}</string>`
    + `<string>_run-watchdogs</string>${config}</array>\n`
    + `<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n`
    + `<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}
