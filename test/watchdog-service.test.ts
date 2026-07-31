import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../src/exec.js';
import {
  WATCHDOG_LAUNCHD_LABEL, WATCHDOG_SYSTEMD_UNIT, WatchdogServiceManager,
} from '../src/watchdog/service.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ours-fleet-watchdog-service-'));
  process.env.OURS_FLEET_HOME = home;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  delete process.env.OURS_FLEET_SUPERVISOR;
});

function fixture(platform: 'linux' | 'darwin') {
  const calls: Array<[string, string[]]> = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, args]);
    if (command === 'launchctl' && args[0] === 'print')
      return { code: 1, stdout: '', stderr: 'could not find service' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const manager = new WatchdogServiceManager(exec, platform);
  return { calls, manager };
}

describe('WatchdogServiceManager', () => {
  it('installs a systemd user unit whose ExecStart runs the hidden scheduler command', async () => {
    const { calls, manager } = fixture('linux');
    const binPath = join(home, 'cli.js');
    writeFileSync(binPath, '');
    await manager.install(binPath, '/tmp/fleet.yaml');
    const unit = readFileSync(manager.definitionPath, 'utf8');
    expect(unit).toContain('_run-watchdogs');
    expect(unit).toContain('-c');
    expect(unit).toContain('/tmp/fleet.yaml');
    expect(calls).toContainEqual(['systemctl', ['--user', 'daemon-reload']]);
    expect(calls).toContainEqual(['systemctl', ['--user', 'enable', WATCHDOG_SYSTEMD_UNIT]]);
  });

  it('installs a launchd plist whose ProgramArguments run the hidden scheduler command', async () => {
    const { manager } = fixture('darwin');
    const binPath = join(home, 'cli.js');
    writeFileSync(binPath, '');
    await manager.install(binPath);
    const plist = readFileSync(manager.definitionPath, 'utf8');
    expect(plist).toContain('_run-watchdogs');
    expect(plist).toContain(WATCHDOG_LAUNCHD_LABEL);
  });

  it('start/stop invoke systemctl --user on linux', async () => {
    const { calls, manager } = fixture('linux');
    const binPath = join(home, 'cli.js');
    writeFileSync(binPath, '');
    await manager.install(binPath);
    await manager.start();
    await manager.stop();
    expect(calls).toContainEqual(['systemctl', ['--user', 'start', WATCHDOG_SYSTEMD_UNIT]]);
    expect(calls).toContainEqual(['systemctl', ['--user', 'stop', WATCHDOG_SYSTEMD_UNIT]]);
  });

  it('start/stop drive launchctl on darwin', async () => {
    const { calls, manager } = fixture('darwin');
    const binPath = join(home, 'cli.js');
    writeFileSync(binPath, '');
    await manager.install(binPath);
    await manager.start();
    await manager.stop();
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args[0] === 'bootstrap')).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'launchctl' && args[0] === 'bootout')).toBe(true);
  });

  it('uninstall removes the unit and disables it', async () => {
    const { calls, manager } = fixture('linux');
    const binPath = join(home, 'cli.js');
    writeFileSync(binPath, '');
    await manager.install(binPath);
    await manager.uninstall();
    expect(calls).toContainEqual(['systemctl', ['--user', 'disable', '--now', WATCHDOG_SYSTEMD_UNIT]]);
  });

  it('supervised() is true on a supported platform by default', () => {
    const { manager } = fixture('linux');
    expect(manager.supervised()).toBe(true);
  });

  it('supervised() is false when OURS_FLEET_SUPERVISOR=none', () => {
    process.env.OURS_FLEET_SUPERVISOR = 'none';
    const { manager } = fixture('linux');
    expect(manager.supervised()).toBe(false);
  });

  it('supervised() is false on an unsupported platform', () => {
    const { manager } = fixture('win32' as 'linux');
    expect(manager.supervised()).toBe(false);
  });
});
