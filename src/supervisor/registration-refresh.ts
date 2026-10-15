import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { replaceFileAtomically } from '../atomic-file.js';
import { realExec, type Exec } from '../exec.js';
import { home } from '../paths.js';
import { WATCHDOG_LAUNCHD_LABEL, WATCHDOG_SYSTEMD_UNIT } from '../watchdog/service.js';
import { WEB_LAUNCHD_LABEL, WEB_SYSTEMD_UNIT } from '../web/service.js';
import { labelFor } from './launchd.js';
import { UNIT_TEMPLATE } from './systemd.js';

/**
 * Service definitions written by `init`, `web install` and the watchdog
 * installer pin the realpath of the CLI that wrote them: an immutable,
 * per-release package tree. An update installs a new tree and moves the
 * `ours-fleet` command, but a definition is only rewritten when that command
 * runs again, so after the next reboot the OS starts the previous release's
 * supervisor while agents, web and CLI run the new one.
 *
 * Refresh re-points an existing Fleet-generated definition at the invoking
 * release and changes nothing else: environment, profile, ports and drop-ins
 * are kept byte for byte, and no unit is created, enabled, started, stopped
 * or restarted. A running process keeps its old code until its operator
 * restarts it, which the report states rather than doing.
 */

const PACKAGE_SCRIPT = ['node_modules', '@ours.network', 'fleet', 'dist', 'cli.js'].join(sep);

/** The release tree that owns a Fleet CLI script, if it is a packaged one. */
export function releaseRoot(script: string): string | undefined {
  const suffix = sep + PACKAGE_SCRIPT;
  return script.endsWith(suffix) ? script.slice(0, -suffix.length) : undefined;
}

export type RegistrationState =
  /** No definition installed; refresh never creates one. */
  | 'absent'
  /** Already runs the invoking release, or a stable launcher outside any release tree. */
  | 'current'
  /** Pins another release tree. */
  | 'stale'
  /** Rewritten to the invoking release by this refresh. */
  | 'refreshed'
  /** Not a definition Fleet generated, or overridden; left untouched. */
  | 'unrecognized';

export type RunningState = 'current' | 'stale' | 'stopped' | 'unknown';

export interface RegistrationReport {
  service: 'supervisor' | 'web' | 'watchdogs';
  path: string;
  state: RegistrationState;
  /** Release tree the definition pinned before this call. */
  from?: string;
  to?: string;
  /** What the live process runs, which a definition rewrite does not change. */
  running: RunningState;
  detail?: string;
}

interface Definition {
  service: RegistrationReport['service'];
  path: string;
  unit?: string;
  /** Argument that identifies the Fleet entry point in this definition. */
  entry: string;
}

function definitions(platform: NodeJS.Platform, homeDir: string): Definition[] {
  if (platform === 'linux') {
    const dir = join(homeDir, '.config', 'systemd', 'user');
    return [
      { service: 'supervisor', unit: UNIT_TEMPLATE, path: join(dir, UNIT_TEMPLATE), entry: '_run-fleet' },
      { service: 'web', unit: WEB_SYSTEMD_UNIT, path: join(dir, WEB_SYSTEMD_UNIT), entry: 'web' },
      { service: 'watchdogs', unit: WATCHDOG_SYSTEMD_UNIT, path: join(dir, WATCHDOG_SYSTEMD_UNIT), entry: '_run-watchdogs' },
    ];
  }
  if (platform === 'darwin') {
    const dir = join(homeDir, 'Library', 'LaunchAgents');
    return [
      { service: 'supervisor', path: join(dir, `${labelFor('fleet')}.plist`), entry: '_run-fleet' },
      { service: 'web', path: join(dir, `${WEB_LAUNCHD_LABEL}.plist`), entry: 'web' },
      { service: 'watchdogs', path: join(dir, `${WATCHDOG_LAUNCHD_LABEL}.plist`), entry: '_run-watchdogs' },
    ];
  }
  return [];
}

/** The Fleet script a definition launches, from its single command line. */
function launchedScript(text: string, platform: NodeJS.Platform, entry: string): string | undefined {
  if (platform === 'linux') {
    const lines = text.split('\n').filter(line => /^\s*ExecStart\s*=/.test(line));
    if (lines.length !== 1) return undefined;
    const args = [...lines[0].replace(/^\s*ExecStart\s*=\s*/, '').matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)]
      .map(match => match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]);
    return args.length >= 3 && args[2] === entry ? args[1] : undefined;
  }
  const program = /<key>ProgramArguments<\/key>\s*<array>((?:\s*<string>[^<]*<\/string>)+)\s*<\/array>/.exec(text);
  if (!program) return undefined;
  const args = [...program[1].matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  return args.length >= 3 && args[2] === entry ? args[1] : undefined;
}

/** A systemd drop-in that sets ExecStart owns the command line; Fleet must not fight it. */
function overriddenByDropIn(path: string): boolean {
  const dir = `${path}.d`;
  try {
    return readdirSync(dir).some(name => name.endsWith('.conf')
      && /^\s*ExecStart\s*=/m.test(readFileSync(join(dir, name), 'utf8')));
  } catch { return false; }
}

/**
 * Move every path under the old release tree to the same path under the new
 * one, so the pinned PATH entries (bundled plugin bins) follow the entry point.
 * A path the new release does not ship is kept and reported.
 */
function reroot(text: string, from: string, to: string, exists: (path: string) => boolean): { text: string; kept: string[] } {
  const kept = new Set<string>();
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = text.replace(new RegExp(`${escaped}/[^\\s"':<]*`, 'g'), path => {
    const moved = to + path.slice(from.length);
    if (exists(moved)) return moved;
    kept.add(path);
    return path;
  });
  return { text: next, kept: [...kept] };
}

export interface RefreshOptions {
  /** realpath of the invoking CLI script. */
  binPath: string;
  /** Rewrite stale definitions; false only reports. */
  write: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  exec?: Exec;
  exists?(path: string): boolean;
  /** argv of a live process, for comparing what it runs with its definition. */
  processArgv?(pid: number): string[] | undefined;
}

const procArgv = (pid: number): string[] | undefined => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); }
  catch { return undefined; }
};

async function runningState(definition: Definition, options: RefreshOptions, platform: NodeJS.Platform): Promise<RunningState> {
  if (platform !== 'linux' || !definition.unit) return 'unknown';
  const exec = options.exec ?? realExec;
  const shown = await exec('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', definition.unit]);
  if (shown.code !== 0) return 'unknown';
  const pid = Number(shown.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid < 0) return 'unknown';
  if (pid === 0) return 'stopped';
  const argv = (options.processArgv ?? procArgv)(pid);
  const script = argv?.[1];
  if (!script) return 'unknown';
  // A stable launcher resolves to whichever release it pointed at when started.
  if (!releaseRoot(script)) return 'unknown';
  return script === options.binPath ? 'current' : 'stale';
}

/** Report, and with `write` refresh, each installed Fleet service definition. */
export async function refreshServiceRegistrations(options: RefreshOptions): Promise<RegistrationReport[]> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? home();
  const exists = options.exists ?? existsSync;
  const target = releaseRoot(options.binPath);
  const reports: RegistrationReport[] = [];
  let rewrote = false;
  for (const definition of definitions(platform, homeDir)) {
    const base = { service: definition.service, path: definition.path };
    if (!exists(definition.path)) {
      reports.push({ ...base, state: 'absent', running: 'stopped' });
      continue;
    }
    const running = await runningState(definition, options, platform);
    const text = readFileSync(definition.path, 'utf8');
    const script = launchedScript(text, platform, definition.entry);
    if (!script) {
      reports.push({ ...base, state: 'unrecognized', running, detail: 'no single Fleet entry point in this definition' });
      continue;
    }
    const from = releaseRoot(script);
    if (!from || script === options.binPath) {
      reports.push({ ...base, state: 'current', running, ...(from ? { from } : {}) });
      continue;
    }
    if (!target) {
      reports.push({ ...base, state: 'stale', running, from,
        detail: 'the invoking CLI is not a packaged release; nothing to point the definition at' });
      continue;
    }
    if (platform === 'linux' && overriddenByDropIn(definition.path)) {
      reports.push({ ...base, state: 'unrecognized', running, from,
        detail: `a drop-in in ${definition.path}.d sets ExecStart; left untouched` });
      continue;
    }
    if (!options.write) {
      reports.push({ ...base, state: 'stale', running, from, to: target });
      continue;
    }
    const moved = reroot(text, from, target, exists);
    if (launchedScript(moved.text, platform, definition.entry) !== options.binPath) {
      reports.push({ ...base, state: 'unrecognized', running, from,
        detail: 'the rewritten definition would not launch the invoking release; left untouched' });
      continue;
    }
    replaceFileAtomically(definition.path, moved.text, statSync(definition.path).mode & 0o777);
    rewrote = true;
    reports.push({ ...base, state: 'refreshed', running, from, to: target,
      ...(moved.kept.length ? { detail: `kept paths absent from the new release: ${moved.kept.join(', ')}` } : {}) });
  }
  if (rewrote && platform === 'linux') {
    const reload = await (options.exec ?? realExec)('systemctl', ['--user', 'daemon-reload']);
    if (reload.code !== 0) for (const report of reports) if (report.state === 'refreshed')
      report.detail = [report.detail, `systemctl --user daemon-reload failed: ${reload.stderr.trim() || `exit ${reload.code}`}`]
        .filter(Boolean).join('; ');
  }
  return reports;
}

/** One operator line per definition, including the restart a refresh cannot do. */
export function describeRegistration(report: RegistrationReport): string {
  const what = `${report.service.padEnd(10)} ${report.state}`;
  const pins = report.from ? ` ${report.from}${report.to ? ` -> ${report.to}` : ''}` : '';
  const restart = report.running === 'stale'
    ? `; the running process still uses ${report.state === 'refreshed' ? 'the previous' : 'another'} release until restarted`
    : '';
  return `${what}${pins}${restart}${report.detail ? ` (${report.detail})` : ''}`;
}

export const registrationDrift = (reports: RegistrationReport[]): RegistrationReport[] =>
  reports.filter(report => report.state === 'stale' || report.running === 'stale');

