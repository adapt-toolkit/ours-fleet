import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Exec } from '../src/exec.js';
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
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The exact shape `ours-fleet init` writes, pinned to one release. */
const supervisorUnit = (release: string) => `[Unit]
Description=ours-fleet process manager
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment="PATH=/usr/bin:${join(homeDir, '.local', 'bin')}:${plugin(release)}"
Environment="OURS_CONFIG=${join(homeDir, '.ours-client', 'profile.json')}"
Environment="OURS_FLEET_HOME=${join(homeDir, '.ours-fleet')}"
ExecStart="/usr/bin/node" "${script(release)}" _run-fleet
# Fleet owns agent startup and restart; the OS recovers only the Fleet parent.
KillMode=control-group
Restart=on-failure
RestartSec=5
TimeoutStopSec=25

[Install]
WantedBy=default.target
`;

/** A fake user manager: MainPID per unit, and every call recorded. */
function systemd(mainPid: Record<string, number>) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('show')) return { stdout: `${mainPid[args.at(-1)!] ?? 0}\n`, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}
const argvOf = (table: Record<number, string[]>) => (pid: number) => table[pid];

describe('service registration refresh', () => {
  it('identifies the release tree that owns a packaged CLI script', () => {
    expect(releaseRoot(script(newRelease))).toBe(newRelease);
    expect(releaseRoot(join(homeDir, '.local', 'bin', 'ours-fleet'))).toBeUndefined();
  });

  it('reports, without writing, a supervisor pinned to the previous release after an update', async () => {
    const unit = join(unitDir, 'ours-fleet.service');
    writeFileSync(unit, supervisorUnit(oldRelease));
    const { exec, calls } = systemd({ 'ours-fleet.service': 4321 });
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: false, platform: 'linux', homeDir, exec,
      processArgv: argvOf({ 4321: ['/usr/bin/node', script(oldRelease), '_run-fleet'] }),
    });
    expect(reports.find(report => report.service === 'supervisor')).toMatchObject({
      state: 'stale', running: 'stale', from: oldRelease, to: newRelease,
    });
    expect(registrationDrift(reports)).toHaveLength(1);
    expect(readFileSync(unit, 'utf8')).toBe(supervisorUnit(oldRelease));
    expect(calls.every(call => call.includes('show'))).toBe(true);
  });

  it('re-points only the release paths, keeps every other byte and mode, and never starts or restarts', async () => {
    const unit = join(unitDir, 'ours-fleet.service');
    writeFileSync(unit, supervisorUnit(oldRelease));
    chmodSync(unit, 0o644);
    const { exec, calls } = systemd({ 'ours-fleet.service': 4321 });
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'linux', homeDir, exec,
      processArgv: argvOf({ 4321: ['/usr/bin/node', script(oldRelease), '_run-fleet'] }),
    });
    const supervisor = reports.find(report => report.service === 'supervisor')!;
    expect(supervisor).toMatchObject({ state: 'refreshed', running: 'stale', from: oldRelease, to: newRelease });
    expect(readFileSync(unit, 'utf8')).toBe(supervisorUnit(newRelease));
    expect(statSync(unit).mode & 0o777).toBe(0o644);
    // daemon-reload only: the running process keeps its code until restarted.
    expect(calls.filter(call => !call.includes('show'))).toEqual([['systemctl', '--user', 'daemon-reload']]);
    expect(describeRegistration(supervisor)).toContain('still uses the previous release until restarted');
  });

  it('models the reboot after a refresh: the unit and the process both run the new release', async () => {
    const unit = join(unitDir, 'ours-fleet.service');
    writeFileSync(unit, supervisorUnit(oldRelease));
    await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'linux', homeDir, exec: systemd({}).exec,
    });
    // After reboot the user manager starts exactly what the unit names.
    const execStart = /^ExecStart="([^"]+)" "([^"]+)" (\S+)$/m.exec(readFileSync(unit, 'utf8'))!;
    const booted = [execStart[1], execStart[2], execStart[3]];
    expect(booted[1]).toBe(script(newRelease));
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: false, platform: 'linux', homeDir,
      exec: systemd({ 'ours-fleet.service': 99 }).exec, processArgv: argvOf({ 99: booted }),
    });
    expect(reports.find(report => report.service === 'supervisor'))
      .toMatchObject({ state: 'current', running: 'current' });
    expect(registrationDrift(reports)).toEqual([]);
  });

  it('reports a current definition whose process still runs the previous release', async () => {
    writeFileSync(join(unitDir, 'ours-fleet.service'), supervisorUnit(newRelease));
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'linux', homeDir,
      exec: systemd({ 'ours-fleet.service': 7 }).exec,
      processArgv: argvOf({ 7: ['/usr/bin/node', script(oldRelease), '_run-fleet'] }),
    });
    expect(reports.find(report => report.service === 'supervisor'))
      .toMatchObject({ state: 'current', running: 'stale' });
    expect(registrationDrift(reports)).toHaveLength(1);
  });

  it('leaves a stable launcher, an overriding drop-in and a foreign unit untouched', async () => {
    const stable = join(homeDir, '.local', 'bin', 'ours-fleet');
    const web = `[Service]\nType=simple\nExecStart="/usr/bin/node" "${stable}" web serve --port 49271 --no-open\n`;
    writeFileSync(join(unitDir, 'ours-fleet-web.service'), web);
    writeFileSync(join(unitDir, 'ours-fleet.service'), supervisorUnit(oldRelease));
    mkdirSync(join(unitDir, 'ours-fleet.service.d'));
    writeFileSync(join(unitDir, 'ours-fleet.service.d', 'override.conf'), '[Service]\nExecStart=\nExecStart=/opt/fleet _run-fleet\n');
    const foreign = '[Service]\nExecStart=/usr/bin/true\n';
    writeFileSync(join(unitDir, 'ours-fleet-watchdogs.service'), foreign);
    const { exec, calls } = systemd({});
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'linux', homeDir, exec,
    });
    expect(reports.map(report => [report.service, report.state])).toEqual([
      ['supervisor', 'unrecognized'], ['web', 'current'], ['watchdogs', 'unrecognized'],
    ]);
    expect(readFileSync(join(unitDir, 'ours-fleet.service'), 'utf8')).toBe(supervisorUnit(oldRelease));
    expect(readFileSync(join(unitDir, 'ours-fleet-web.service'), 'utf8')).toBe(web);
    expect(readFileSync(join(unitDir, 'ours-fleet-watchdogs.service'), 'utf8')).toBe(foreign);
    expect(calls.some(call => call.includes('daemon-reload'))).toBe(false);
  });

  it('never creates a definition that is not installed', async () => {
    const { exec, calls } = systemd({});
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'linux', homeDir, exec,
    });
    expect(reports.every(report => report.state === 'absent')).toBe(true);
    expect(existsSync(join(unitDir, 'ours-fleet.service'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps and reports a pinned path the new release does not ship', async () => {
    rmSync(plugin(newRelease), { recursive: true });
    writeFileSync(join(unitDir, 'ours-fleet.service'), supervisorUnit(oldRelease));
    const reports = await refreshServiceRegistrations({
      binPath: script(newRelease), write: true, platform: 'linux', homeDir, exec: systemd({}).exec,
    });
    const supervisor = reports.find(report => report.service === 'supervisor')!;
    expect(supervisor.state).toBe('refreshed');
    expect(supervisor.detail).toContain(plugin(oldRelease));
    const text = readFileSync(join(unitDir, 'ours-fleet.service'), 'utf8');
    expect(text).toContain(`"${script(newRelease)}" _run-fleet`);
    expect(text).toContain(plugin(oldRelease));
  });

  it('refuses to point a definition at a CLI outside any release tree', async () => {
    writeFileSync(join(unitDir, 'ours-fleet.service'), supervisorUnit(oldRelease));
    const reports = await refreshServiceRegistrations({
      binPath: join(root, 'checkout', 'dist', 'cli.js'), write: true, platform: 'linux', homeDir,
      exec: systemd({}).exec,
    });
    expect(reports.find(report => report.service === 'supervisor')?.state).toBe('stale');
    expect(readFileSync(join(unitDir, 'ours-fleet.service'), 'utf8')).toBe(supervisorUnit(oldRelease));
  });
});
