import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Exec } from '../src/exec.js';
import { makeSystemdBackend } from '../src/supervisor/systemd.js';
import { launchdPlist as webLaunchdPlist, systemdUnit as webSystemdUnit } from '../src/web/service.js';
import {
  describeRegistration, refreshServiceRegistrations, registrationDrift, releaseRoot,
} from '../src/supervisor/registration-refresh.js';

let root: string;
let homeDir: string;
let unitDir: string;
let oldRelease: string;
let newRelease: string;
const script = (release: string) => join(release, 'node_modules', '@ours.network', 'fleet', 'dist', 'cli.js');
const plugin = (release: string) => join(release, 'marketplaces', 'claude-code', 'plugins', 'ours', 'bin');
const supervisorPath = () => join(unitDir, 'ours-fleet.service');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-registration-'));
  homeDir = join(root, 'home');
  unitDir = join(homeDir, '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  oldRelease = join(homeDir, '.ours-client-install', '6e32ee72698100de');
  newRelease = join(homeDir, '.ours-client-install', '692be5c372d46920');
  for (const release of [oldRelease, newRelease]) {
    mkdirSync(join(release, 'node_modules', '@ours.network', 'fleet', 'dist'), { recursive: true });
    writeFileSync(script(release), '');
    mkdirSync(plugin(release), { recursive: true });
    // Same relative path in both trees: only the operator's selection may stay.
    writeFileSync(join(release, 'profile.json'), '{}');
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * The unit `ours-fleet init` writes from `release`, produced by the real
 * generator. The profile deliberately lives under the old release tree: it is
 * an operator selection, not a release path, and must survive a refresh.
 */
async function initUnit(release: string, profile = join(oldRelease, 'profile.json')): Promise<string> {
  const saved = { PATH: process.env.PATH, OURS_CONFIG: process.env.OURS_CONFIG, OURS_FLEET_HOME: process.env.OURS_FLEET_HOME };
  try {
    process.env.PATH = ['/usr/bin', join(homeDir, '.local', 'bin'), plugin(release)].join(':');
    process.env.OURS_CONFIG = profile;
    process.env.OURS_FLEET_HOME = homeDir;
    await makeSystemdBackend(async () => ({ stdout: '', stderr: '', code: 0 })).init(script(release));
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return readFileSync(supervisorPath(), 'utf8');
}

/** A fake user manager: MainPID per unit, an optional failing reload, and every call recorded. */
/** systemd's view: MainPID per unit, and units whose file changed since the last load. */
function systemd(mainPid: Record<string, number> = {}, reloadCode = 0, needsReload = new Set<string>()) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('NeedDaemonReload')) return { stdout: needsReload.has(args.at(-1)!) ? 'yes\n' : 'no\n', stderr: '', code: 0 };
    if (args.includes('show')) return { stdout: `${mainPid[args.at(-1)!] ?? 0}\n`, stderr: '', code: 0 };
    if (args.includes('daemon-reload') && reloadCode) return { stdout: '', stderr: 'Failed to connect to bus', code: reloadCode };
    if (args.includes('daemon-reload')) needsReload.clear();
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls, needsReload };
}
const argvOf = (table: Record<number, string[]>) => (pid: number) => table[pid];
const refresh = (write: boolean, exec: Exec, extra: Partial<Parameters<typeof refreshServiceRegistrations>[0]> = {}) =>
  refreshServiceRegistrations({ binPath: script(newRelease), write, platform: 'linux', homeDir, exec, ...extra });
const supervisor = (reports: Awaited<ReturnType<typeof refreshServiceRegistrations>>) =>
  reports.find(report => report.service === 'supervisor')!;

describe('service registration refresh', () => {
  it('identifies the release tree that owns a packaged CLI script', () => {
    expect(releaseRoot(script(newRelease))).toBe(newRelease);
    expect(releaseRoot(join(homeDir, '.local', 'bin', 'ours-fleet'))).toBeUndefined();
  });

  it('reports, without writing, a supervisor pinned to the previous release after an update', async () => {
    const original = await initUnit(oldRelease);
    const { exec, calls } = systemd({ 'ours-fleet.service': 4321 });
    const reports = await refresh(false, exec, {
      processArgv: argvOf({ 4321: [process.execPath, script(oldRelease), '_run-fleet'] }),
    });
    expect(supervisor(reports)).toMatchObject({ state: 'stale', running: 'stale', from: oldRelease, to: newRelease });
    expect(registrationDrift(reports)).toHaveLength(1);
    expect(readFileSync(supervisorPath(), 'utf8')).toBe(original);
    expect(calls.every(call => call.includes('show'))).toBe(true);
  });

  it('changes only the launched script and bundled PATH entries of a generated unit', async () => {
    const original = await initUnit(oldRelease);
    chmodSync(supervisorPath(), 0o644);
    const { exec, calls } = systemd({ 'ours-fleet.service': 4321 });
    const reports = await refresh(true, exec, {
      processArgv: argvOf({ 4321: [process.execPath, script(oldRelease), '_run-fleet'] }),
    });
    expect(supervisor(reports)).toMatchObject({ state: 'refreshed', running: 'stale', from: oldRelease, to: newRelease });
    const expected = original
      .replace(`"${script(oldRelease)}" _run-fleet`, `"${script(newRelease)}" _run-fleet`)
      .replace(`:${plugin(oldRelease)}`, `:${plugin(newRelease)}`);
    expect(readFileSync(supervisorPath(), 'utf8')).toBe(expected);
    // The operator's profile stays selected even though it lives under the old tree.
    expect(readFileSync(supervisorPath(), 'utf8')).toContain(`OURS_CONFIG=${join(oldRelease, 'profile.json')}`);
    expect(statSync(supervisorPath()).mode & 0o777).toBe(0o644);
    expect(calls.filter(call => !call.includes('show'))).toEqual([['systemctl', '--user', 'daemon-reload']]);
    expect(describeRegistration(supervisor(reports))).toContain('still uses the previous release until restarted');
  });

  it('re-points a generated web unit and keeps its port, bind, origin and configuration', async () => {
    const unit = join(unitDir, 'ours-fleet-web.service');
    const options = [49_271, join(homeDir, 'fleet.yaml'), { bind: '127.0.0.1', publicOrigin: 'https://example.test' }] as const;
    writeFileSync(unit, webSystemdUnit(process.execPath, script(oldRelease), ...options));
    const reports = await refresh(true, systemd().exec);
    expect(reports.find(report => report.service === 'web')?.state).toBe('refreshed');
    expect(readFileSync(unit, 'utf8')).toBe(webSystemdUnit(process.execPath, script(newRelease), ...options));
  });

  it('re-points a generated LaunchAgent and keeps its environment', async () => {
    const agents = join(homeDir, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    const plist = join(agents, 'network.ours.fleet.web.plist');
    const environment = { PATH: `/usr/bin:${plugin(oldRelease)}`, OURS_CONFIG: join(oldRelease, 'profile.json') };
    writeFileSync(plist, webLaunchdPlist(process.execPath, script(oldRelease), 49_271, undefined, {}, environment));
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'darwin', homeDir, exec: systemd().exec,
    });
    expect(reports.find(report => report.service === 'web')).toMatchObject({ state: 'refreshed', running: 'unknown' });
    expect(readFileSync(plist, 'utf8')).toBe(webLaunchdPlist(process.execPath, script(newRelease), 49_271, undefined, {},
      { ...environment, PATH: `/usr/bin:${plugin(newRelease)}` }));
  });

  it('reports a rewritten unit whose reload failed instead of calling it refreshed', async () => {
    await initUnit(oldRelease);
    const reports = await refresh(true, systemd({}, 1).exec);
    expect(supervisor(reports)).toMatchObject({ state: 'reload-failed' });
    expect(supervisor(reports).detail).toMatch(/daemon-reload failed: Failed to connect to bus; run it/);
    expect(registrationDrift(reports)).toHaveLength(1);
  });

  it('keeps a failed daemon-reload pending across refreshes until a reload succeeds', async () => {
    await initUnit(oldRelease);
    // The rewrite lands but the reload fails: systemd now flags the unit as changed on disk.
    expect(supervisor(await refresh(true, systemd({}, 1).exec)).state).toBe('reload-failed');
    const pending = new Set(['ours-fleet.service']);

    // A read-only check must still report drift although the file is current.
    const check = await refresh(false, systemd({}, 0, new Set(pending)).exec);
    expect(supervisor(check).state).toBe('reload-failed');
    expect(registrationDrift(check).map(r => r.service)).toContain('supervisor');

    // A second failed attempt keeps it pending; a successful one clears it.
    expect(supervisor(await refresh(true, systemd({}, 1, new Set(pending)).exec)).state).toBe('reload-failed');
    const retry = systemd({}, 0, new Set(pending));
    const reports = await refresh(true, retry.exec);
    expect(retry.calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
    expect(supervisor(reports).state).toBe('refreshed');
    expect(retry.needsReload.size).toBe(0);
    // And afterwards it is simply current, with no further reload.
    const after = systemd();
    expect(supervisor(await refresh(true, after.exec)).state).toBe('current');
    expect(after.calls).not.toContainEqual(['systemctl', '--user', 'daemon-reload']);
  });

  it('models the reboot after a refresh: the unit and the process both run the new release', async () => {
    await initUnit(oldRelease);
    await refresh(true, systemd().exec);
    // After reboot the user manager starts exactly what the unit names.
    const execStart = /^ExecStart="([^"]+)" "([^"]+)" (\S+)$/m.exec(readFileSync(supervisorPath(), 'utf8'))!;
    const booted = [execStart[1], execStart[2], execStart[3]];
    expect(booted[1]).toBe(script(newRelease));
    const reports = await refresh(false, systemd({ 'ours-fleet.service': 99 }).exec, { processArgv: argvOf({ 99: booted }) });
    expect(supervisor(reports)).toMatchObject({ state: 'current', running: 'current' });
    expect(registrationDrift(reports)).toEqual([]);
  });

  it('reports a current definition whose process still runs the previous release', async () => {
    await initUnit(newRelease);
    const reports = await refresh(true, systemd({ 'ours-fleet.service': 7 }).exec, {
      processArgv: argvOf({ 7: [process.execPath, script(oldRelease), '_run-fleet'] }),
    });
    expect(supervisor(reports)).toMatchObject({ state: 'current', running: 'stale' });
    expect(registrationDrift(reports)).toHaveLength(1);
  });

  it('refuses a foreign definition that launches the same script and entry', async () => {
    const foreign = '[Unit]\nDescription=ours-fleet process manager\n\n[Service]\nType=oneshot\n'
      + `ExecStart="/usr/bin/python3" "${script(oldRelease)}" _run-fleet\n`;
    writeFileSync(supervisorPath(), foreign);
    const custom = '[Unit]\nDescription=my fleet\n\n[Service]\nType=simple\n'
      + `ExecStart="${process.execPath}" "${script(oldRelease)}" _run-watchdogs\n`;
    writeFileSync(join(unitDir, 'ours-fleet-watchdogs.service'), custom);
    const { exec, calls } = systemd();
    const reports = await refresh(true, exec);
    expect(reports.map(report => [report.service, report.state])).toEqual([
      ['supervisor', 'unrecognized'], ['web', 'absent'], ['watchdogs', 'unrecognized'],
    ]);
    expect(readFileSync(supervisorPath(), 'utf8')).toBe(foreign);
    expect(readFileSync(join(unitDir, 'ours-fleet-watchdogs.service'), 'utf8')).toBe(custom);
    expect(calls.some(call => call.includes('daemon-reload'))).toBe(false);
  });

  it('leaves a stable launcher and an overriding drop-in untouched', async () => {
    const stable = join(homeDir, '.local', 'bin', 'ours-fleet');
    const web = webSystemdUnit(process.execPath, stable, 49_271);
    writeFileSync(join(unitDir, 'ours-fleet-web.service'), web);
    const original = await initUnit(oldRelease);
    mkdirSync(join(unitDir, 'ours-fleet.service.d'));
    writeFileSync(join(unitDir, 'ours-fleet.service.d', 'override.conf'), '[Service]\nExecStart=\nExecStart=/opt/fleet _run-fleet\n');
    const { exec, calls } = systemd();
    const reports = await refresh(true, exec);
    expect(reports.map(report => [report.service, report.state])).toEqual([
      ['supervisor', 'unrecognized'], ['web', 'current'], ['watchdogs', 'absent'],
    ]);
    expect(readFileSync(supervisorPath(), 'utf8')).toBe(original);
    expect(readFileSync(join(unitDir, 'ours-fleet-web.service'), 'utf8')).toBe(web);
    expect(calls.some(call => call.includes('daemon-reload'))).toBe(false);
  });

  it('never creates a definition that is not installed', async () => {
    const { exec, calls } = systemd();
    const reports = await refresh(true, exec);
    expect(reports.every(report => report.state === 'absent')).toBe(true);
    expect(existsSync(supervisorPath())).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps and reports a PATH entry the new release does not ship', async () => {
    rmSync(plugin(newRelease), { recursive: true });
    await initUnit(oldRelease);
    const reports = await refresh(true, systemd().exec);
    expect(supervisor(reports).state).toBe('refreshed');
    expect(supervisor(reports).detail).toContain(plugin(oldRelease));
    const text = readFileSync(supervisorPath(), 'utf8');
    expect(text).toContain(`"${script(newRelease)}" _run-fleet`);
    expect(text).toContain(plugin(oldRelease));
  });

  it('refuses to point a definition at a CLI outside any release tree', async () => {
    const original = await initUnit(oldRelease);
    const reports = await refresh(true, systemd().exec, { binPath: join(root, 'checkout', 'dist', 'cli.js') });
    expect(supervisor(reports).state).toBe('stale');
    expect(readFileSync(supervisorPath(), 'utf8')).toBe(original);
  });
});
