import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { FleetError } from '../application/errors.js';
import { realExec, type Exec } from '../exec.js';
import { home, stateRoot } from '../paths.js';

const VERSION = 2;
export const WEB_SYSTEMD_UNIT = 'ours-fleet-web.service';
export const WEB_LAUNCHD_LABEL = 'network.ours.fleet.web';

interface ServiceMetadata {
  version: 2;
  platform: 'linux' | 'darwin';
  runtime: string;
  script: string;
  port: number;
  configuration?: string;
}

export interface WebServiceOptions {
  platform?: NodeJS.Platform;
  exec?: Exec;
  homeDir?: string;
  stateDir?: string;
  uid?: number;
  runtimeExecutable?: string;
}

export class WebServiceManager {
  private readonly platform: 'linux' | 'darwin';
  private readonly exec: Exec;
  private readonly homeDir: string;
  private readonly stateDir: string;
  private readonly uid: number;
  private readonly runtimeExecutable: string;

  constructor(options: WebServiceOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux' && platform !== 'darwin')
      throw new FleetError('capability_unavailable', `web service is unsupported on ${platform}`);
    this.platform = platform;
    this.exec = options.exec ?? realExec;
    this.homeDir = options.homeDir ?? home();
    this.stateDir = options.stateDir ?? join(stateRoot(), 'web');
    this.uid = options.uid ?? process.getuid?.() ?? 501;
    this.runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  }

  get metadataPath(): string { return join(this.stateDir, 'service.json'); }
  get definitionPath(): string {
    return this.platform === 'linux'
      ? join(this.homeDir, '.config', 'systemd', 'user', WEB_SYSTEMD_UNIT)
      : join(this.homeDir, 'Library', 'LaunchAgents', `${WEB_LAUNCHD_LABEL}.plist`);
  }

  async install(script: string, port = 49_271, configuration?: string): Promise<string[]> {
    validatePort(port);
    const resolvedScript = resolveExecutable(script, 'web CLI script');
    const runtime = resolveExecutable(this.runtimeExecutable, 'Node runtime');
    mkdirSync(dirname(this.definitionPath), { recursive: true, mode: 0o700 });
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.stateDir, 0o700);
    const config = configuration ? resolve(configuration) : undefined;
    const metadata: ServiceMetadata = {
      version: VERSION, platform: this.platform, runtime, script: resolvedScript, port,
      ...(config ? { configuration: config } : {}),
    };
    replaceFileAtomically(this.definitionPath,
      this.platform === 'linux'
        ? systemdUnit(runtime, resolvedScript, port, config)
        : launchdPlist(runtime, resolvedScript, port, config), 0o600);
    replaceFileAtomically(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 0o600);
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'daemon-reload']);
      await this.must('systemctl', ['--user', 'enable', WEB_SYSTEMD_UNIT]);
      const linger = await this.exec('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']);
      return [
        `installed ${this.definitionPath}`,
        linger.stdout.trim() === 'yes'
          ? 'login persistence available (linger enabled)'
          : `warning: login persistence requires linger; run: sudo loginctl enable-linger ${userInfo().username}`,
      ];
    }
    return [`installed ${this.definitionPath}`, 'launchd service starts at login'];
  }

  async start(): Promise<void> {
    this.requireInstalled();
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'start', WEB_SYSTEMD_UNIT]);
      return;
    }
    const domain = `gui/${this.uid}`;
    const loaded = await this.exec('launchctl', ['print', `${domain}/${WEB_LAUNCHD_LABEL}`]);
    if (loaded.code === 0) await this.must('launchctl', ['kickstart', `${domain}/${WEB_LAUNCHD_LABEL}`]);
    else await this.must('launchctl', ['bootstrap', domain, this.definitionPath]);
  }

  async stop(): Promise<void> {
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'stop', WEB_SYSTEMD_UNIT]);
      return;
    }
    const result = await this.exec('launchctl', ['bootout', `gui/${this.uid}/${WEB_LAUNCHD_LABEL}`]);
    if (result.code !== 0 && !/could not find service|no such process/i.test(`${result.stdout}\n${result.stderr}`))
      throw new FleetError('control_unavailable', `launchctl bootout failed: ${result.stderr.trim()}`);
  }

  async restart(): Promise<void> {
    this.requireInstalled();
    if (this.platform === 'linux') {
      await this.must('systemctl', ['--user', 'restart', WEB_SYSTEMD_UNIT]);
      return;
    }
    const result = await this.exec('launchctl', ['kickstart', '-k', `gui/${this.uid}/${WEB_LAUNCHD_LABEL}`]);
    if (result.code !== 0) { await this.stop(); await this.start(); }
  }

  async status(): Promise<string> {
    if (this.platform === 'linux') {
      const result = await this.exec('systemctl', [
        '--user', 'show', WEB_SYSTEMD_UNIT, '-p', 'LoadState', '-p', 'ActiveState',
        '-p', 'SubState', '-p', 'ExecMainPID', '--no-pager',
      ]);
      return result.stdout.trim() || result.stderr.trim() || `exit ${result.code}`;
    }
    const result = await this.exec('launchctl', ['print', `gui/${this.uid}/${WEB_LAUNCHD_LABEL}`]);
    return result.code === 0 ? result.stdout.trim() : `not loaded (${WEB_LAUNCHD_LABEL})`;
  }

  async uninstall(): Promise<string> {
    if (this.platform === 'linux') {
      await this.exec('systemctl', ['--user', 'disable', '--now', WEB_SYSTEMD_UNIT]);
      rmSync(this.definitionPath, { force: true });
      rmSync(this.metadataPath, { force: true });
      await this.exec('systemctl', ['--user', 'daemon-reload']);
    } else {
      await this.stop();
      rmSync(this.definitionPath, { force: true });
      rmSync(this.metadataPath, { force: true });
    }
    return `uninstalled ${this.platform === 'linux' ? WEB_SYSTEMD_UNIT : WEB_LAUNCHD_LABEL}`;
  }

  readMetadata(): ServiceMetadata | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.metadataPath, 'utf8')) as ServiceMetadata;
      return parsed.version === VERSION && parsed.platform === this.platform
        && typeof parsed.runtime === 'string' && typeof parsed.script === 'string'
        && Number.isInteger(parsed.port) ? parsed : undefined;
    } catch { return undefined; }
  }

  private requireInstalled(): void {
    if (!existsSync(this.definitionPath) || !this.readMetadata())
      throw new FleetError('prerequisite_unavailable', 'web service is not installed; run `ours-fleet web install`');
  }

  private async must(command: string, args: string[]): Promise<void> {
    const result = await this.exec(command, args);
    if (result.code !== 0)
      throw new FleetError('control_unavailable', `${command} ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

function resolveExecutable(executable: string, label: string): string {
  const absolute = isAbsolute(executable) ? executable : resolve(executable);
  try { return realpathSync(absolute); }
  catch { throw new FleetError('prerequisite_unavailable', `${label} does not exist: ${absolute}`); }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new FleetError('invalid_request', 'service port must be between 1 and 65535');
}

function systemdQuote(value: string): string {
  return `"${value.replace(/[%\\"]/g, char => char === '%' ? '%%' : `\\${char}`)}"`;
}

export function systemdUnit(
  runtime: string, script: string, port: number, configuration?: string,
): string {
  const config = configuration ? ` --configuration ${systemdQuote(configuration)}` : '';
  return `[Unit]\nDescription=ours-fleet localhost web console\nAfter=default.target\n\n`
    + `[Service]\nType=simple\nExecStart=${systemdQuote(runtime)} ${systemdQuote(script)} web serve --port ${port} --no-open${config}\n`
    + `Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\n\n`
    + `[Install]\nWantedBy=default.target\n`;
}

const xml = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[char]!));

export function launchdPlist(
  runtime: string, script: string, port: number, configuration?: string,
): string {
  const config = configuration
    ? `<string>--configuration</string><string>${xml(configuration)}</string>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0"><dict>\n<key>Label</key><string>${WEB_LAUNCHD_LABEL}</string>\n`
    + `<key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>${xml(script)}</string><string>web</string>`
    + `<string>serve</string><string>--port</string><string>${port}</string><string>--no-open</string>${config}</array>\n`
    + `<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n`
    + `<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
}
