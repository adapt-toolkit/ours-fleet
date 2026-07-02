import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSystemdBackend, makeLaunchdBackend, pickBackend, unitFor, labelFor } from '../src/supervisor/index.js';
import type { Exec, ExecResult } from '../src/exec.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-sup-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  delete process.env.OURS_FLEET_SUPERVISOR;
  rmSync(dir, { recursive: true, force: true });
});

function recorder(code = 0) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    return { stdout: '', stderr: '', code };
  };
  return { calls, exec };
}

describe('systemd backend', () => {
  it('init writes the unit template with the bin path and reloads', async () => {
    const { calls, exec } = recorder();
    const msgs = await makeSystemdBackend(exec).init('/usr/local/bin/ours-fleet');
    const unit = readFileSync(join(dir, '.config/systemd/user/ours-fleet-agent@.service'), 'utf8');
    expect(unit).toContain('ExecStart=/usr/local/bin/ours-fleet _run %i');
    expect(unit).toContain('Restart=always');
    expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
    expect(calls.some(c => c[0] === 'loginctl' && c[1] === 'enable-linger')).toBe(true);
    expect(msgs.join('\n')).toContain('linger');
  });

  it('install enables the instance unit', async () => {
    const { calls, exec } = recorder();
    await makeSystemdBackend(exec).install('A', '/b');
    expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'ours-fleet-agent@A.service']);
    expect(unitFor('A')).toBe('ours-fleet-agent@A.service');
  });

  it('logsArgs targets journalctl', () => {
    const { args, cmd } = makeSystemdBackend().logsArgs('A', true);
    expect(cmd).toBe('journalctl');
    expect(args).toEqual(['--user', '-u', 'ours-fleet-agent@A.service', '-f']);
  });
});

describe('launchd backend', () => {
  it('install writes plist and bootstraps into gui domain', async () => {
    const { calls, exec } = recorder();
    await makeLaunchdBackend(exec, 501).install('A', '/usr/local/bin/ours-fleet');
    const plist = readFileSync(join(dir, 'Library/LaunchAgents/network.ours.fleet.A.plist'), 'utf8');
    expect(plist).toContain('<string>network.ours.fleet.A</string>');
    expect(plist).toContain('<string>/usr/local/bin/ours-fleet</string>');
    expect(plist).toContain('<string>_run</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(calls.some(c => c[0] === 'launchctl' && c[1] === 'bootstrap' && c[2] === 'gui/501')).toBe(true);
    expect(labelFor('A')).toBe('network.ours.fleet.A');
  });

  it('logsArgs tails the role log file', () => {
    const { cmd, args } = makeLaunchdBackend(undefined, 501).logsArgs('A', true);
    expect(cmd).toBe('tail');
    expect(args[1]).toContain('.ours-fleet/logs/A.log');
  });
});

describe('pickBackend', () => {
  it('selects by platform', () => {
    expect(pickBackend(undefined, 'linux').id).toBe('systemd');
    expect(pickBackend(undefined, 'darwin').id).toBe('launchd');
  });
  it('env override wins', () => {
    process.env.OURS_FLEET_SUPERVISOR = 'none';
    expect(pickBackend(undefined, 'linux').id).toBe('none');
  });
  it('rejects unsupported platforms', () => {
    expect(() => pickBackend(undefined, 'win32')).toThrowError(/unsupported platform/);
  });
});
