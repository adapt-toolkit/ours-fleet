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
  /** Rewritten, but the service manager did not reload it; it still starts the old release. */
  | 'reload-failed'
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
  /** Description (systemd) or Label (launchd) the Fleet generator writes. */
  marker: string;
}

function definitions(platform: NodeJS.Platform, homeDir: string): Definition[] {
  if (platform === 'linux') {
    const dir = join(homeDir, '.config', 'systemd', 'user');
    return [
      { service: 'supervisor', unit: UNIT_TEMPLATE, path: join(dir, UNIT_TEMPLATE), entry: '_run-fleet',
        marker: 'ours-fleet process manager' },
      { service: 'web', unit: WEB_SYSTEMD_UNIT, path: join(dir, WEB_SYSTEMD_UNIT), entry: 'web',
        marker: 'ours-fleet localhost web console' },
      { service: 'watchdogs', unit: WATCHDOG_SYSTEMD_UNIT, path: join(dir, WATCHDOG_SYSTEMD_UNIT), entry: '_run-watchdogs',
        marker: 'ours-fleet watchdog scheduler' },
    ];
  }
  if (platform === 'darwin') {
    const dir = join(homeDir, 'Library', 'LaunchAgents');
    return [
      { service: 'supervisor', path: join(dir, `${labelFor('fleet')}.plist`), entry: '_run-fleet', marker: labelFor('fleet') },
      { service: 'web', path: join(dir, `${WEB_LAUNCHD_LABEL}.plist`), entry: 'web', marker: WEB_LAUNCHD_LABEL },
      { service: 'watchdogs', path: join(dir, `${WATCHDOG_LAUNCHD_LABEL}.plist`), entry: '_run-watchdogs',
        marker: WATCHDOG_LAUNCHD_LABEL },
    ];
  }
  return [];
}

const NODE_RUNTIME = /^node(js)?[0-9.]*$/;
const systemdQuote = (value: string): string => `"${value.replace(/[%\\"]/g, char => char === '%' ? '%%' : `\\${char}`)}"`;
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[char]!));
const unxml = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/**
 * A definition Fleet generated, reduced to the parts refresh may change: the
 * launched script argument and the pinned PATH. Anything that does not have the
 * generator's shape (its Description or Label, a simple service, a Node runtime
 * and the entry argument) is not Fleet's to rewrite.
 */
interface Generated {
  script: string;
  /** Replace the script argument and pinned PATH entries; nothing else. */
  rewrite(script: string, path: (entry: string) => string): string;
}

function parseGenerated(text: string, platform: NodeJS.Platform, definition: Definition): Generated | undefined {
  if (platform === 'linux') {
    const lines = text.split('\n');
    const only = (pattern: RegExp) => {
      const found = lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
      return found.length === 1 ? found[0] : undefined;
    };
    if (lines[only(/^Description=/) ?? -1] !== `Description=${definition.marker}`) return undefined;
    if (lines[only(/^Type=/) ?? -1] !== 'Type=simple') return undefined;
    const exec = only(/^\s*ExecStart\s*=/);
    if (exec === undefined || !lines[exec].startsWith('ExecStart="')) return undefined;
    const args = [...lines[exec].slice('ExecStart='.length).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)]
      .map(match => match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1').replaceAll('%%', '%') : match[2]);
    const [runtime, script, entry] = args;
    if (!runtime?.startsWith('/') || !NODE_RUNTIME.test(runtime.split('/').at(-1)!) || entry !== definition.entry || !script)
      return undefined;
    const quoted = `${systemdQuote(runtime)} ${systemdQuote(script)} `;
    if (!lines[exec].startsWith(`ExecStart=${quoted}`)) return undefined;
    const pathLine = only(/^Environment="PATH=/);
    return {
      script,
      rewrite(next, path) {
        const out = [...lines];
        out[exec] = `ExecStart=${systemdQuote(runtime)} ${systemdQuote(next)} ${lines[exec].slice(`ExecStart=${quoted}`.length)}`;
        if (pathLine !== undefined) {
          const value = /^Environment="PATH=((?:[^"\\]|\\.)*)"$/.exec(lines[pathLine])?.[1];
          if (value !== undefined && !/[\\%]/.test(value))
            out[pathLine] = `Environment="PATH=${value.split(':').map(path).join(':')}"`;
        }
        return out.join('\n');
      },
    };
  }
  if (!new RegExp(`<key>Label</key>\\s*<string>${definition.marker.replaceAll('.', '\\.')}</string>`).test(text)) return undefined;
  const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>/.exec(text);
  if (!program) return undefined;
  const [, runtime, script, entry] = program.map(unxml);
  if (!runtime.startsWith('/') || !NODE_RUNTIME.test(runtime.split('/').at(-1)!) || entry !== definition.entry) return undefined;
  return {
    script,
    rewrite(next, path) {
      const head = program[0];
      const moved = head.replace(`<string>${program[2]}</string>`, `<string>${xml(next)}</string>`);
      let out = text.replace(head, moved);
      out = out.replace(/(<key>PATH<\/key>\s*<string>)([^<]*)(<\/string>)/, (_all, open: string, value: string, close: string) =>
        `${open}${xml(unxml(value).split(':').map(path).join(':'))}${close}`);
      return out;
    },
  };
}

/** A systemd drop-in that sets ExecStart owns the command line; Fleet must not fight it. */
function overriddenByDropIn(path: string): boolean {
  const dir = `${path}.d`;
  try {
    return readdirSync(dir).some(name => name.endsWith('.conf')
      && /^\s*ExecStart\s*=/m.test(readFileSync(join(dir, name), 'utf8')));
  } catch { return false; }
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
    const generated = parseGenerated(text, platform, definition);
    if (!generated) {
      reports.push({ ...base, state: 'unrecognized', running,
        detail: 'not the definition Fleet generates for this service; left untouched' });
      continue;
    }
    const from = releaseRoot(generated.script);
    if (!from || generated.script === options.binPath) {
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
    // Only bundled tool directories on PATH follow the release; every other
    // setting, including a profile or home stored under a release tree, stays.
    const kept: string[] = [];
    const next = generated.rewrite(options.binPath, entry => {
      if (!entry.startsWith(from + '/')) return entry;
      const moved = target + entry.slice(from.length);
      if (exists(moved)) return moved;
      kept.push(entry);
      return entry;
    });
    if (parseGenerated(next, platform, definition)?.script !== options.binPath) {
      reports.push({ ...base, state: 'unrecognized', running, from,
        detail: 'the rewritten definition would not launch the invoking release; left untouched' });
      continue;
    }
    replaceFileAtomically(definition.path, next, statSync(definition.path).mode & 0o777);
    rewrote = true;
    reports.push({ ...base, state: 'refreshed', running, from, to: target,
      ...(kept.length ? { detail: `kept PATH entries absent from the new release: ${kept.join(', ')}` } : {}) });
  }
  if (rewrote && platform === 'linux') {
    const reload = await (options.exec ?? realExec)('systemctl', ['--user', 'daemon-reload']);
    // The file is rewritten, but systemd keeps the loaded unit until a reload,
    // so a failed reload is not a refresh.
    if (reload.code !== 0) for (const report of reports) if (report.state === 'refreshed') {
      report.state = 'reload-failed';
      report.detail = [report.detail, `systemctl --user daemon-reload failed: ${reload.stderr.trim() || `exit ${reload.code}`}; `
        + 'run it, then restart the service when convenient'].filter(Boolean).join('; ');
    }
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
  reports.filter(report => report.state === 'stale' || report.state === 'reload-failed' || report.running === 'stale');

