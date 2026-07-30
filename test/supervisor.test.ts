import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSystemdBackend, makeLaunchdBackend, makeNoneBackend, pickBackend, unitFor, labelFor } from '../src/supervisor/index.js';
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
    expect(unit).toMatch(/^Restart=on-failure$/m);   // the runner owns the retry loop (3.2)
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
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(calls.some(c => c[0] === 'launchctl' && c[1] === 'bootstrap' && c[2] === 'gui/501')).toBe(true);
    expect(labelFor('A')).toBe('network.ours.fleet.A');
  });

  it('logsArgs tails the role log file', () => {
    const { cmd, args } = makeLaunchdBackend(undefined, 501).logsArgs('A', true);
    expect(cmd).toBe('tail');
    expect(args[1]).toContain('.ours-fleet/logs/A.log');
  });
});

describe('systemd liveness (1.1)', () => {
  const showing = (stdout: string, stderr = '', code = 0): Exec => async () => ({ stdout, stderr, code });

  it('probes the machine-readable properties, not the status prose', async () => {
    const { calls, exec } = recorder();
    await makeSystemdBackend(exec).liveness('A');
    expect(calls).toContainEqual([
      'systemctl', '--user', 'show', '-p', 'ActiveState', '-p', 'SubState', '--value',
      'ours-fleet-agent@A.service',
    ]);
  });

  it('classifies each native state and reports it verbatim', async () => {
    const cases: Array<[string, string, string]> = [
      ['active\nrunning\n', 'running', 'active (running)'],
      ['active\nexited\n', 'running', 'active (exited)'],
      ['activating\nauto-restart\n', 'running', 'activating (auto-restart)'],
      ['deactivating\nstop-sigterm\n', 'running', 'deactivating (stop-sigterm)'],
      ['inactive\ndead\n', 'stopped', 'inactive (dead)'],
      ['failed\nfailed\n', 'stopped', 'failed (failed)'],
      ['maintenance\nunknown\n', 'unknown', 'maintenance (unknown)'],
    ];
    for (const [stdout, state, detail] of cases) {
      expect(await makeSystemdBackend(showing(stdout)).liveness('A')).toEqual({ state, detail });
    }
  });

  it('an unanswered probe is unknown and carries the failure plus the bus hint', async () => {
    const l = await makeSystemdBackend(showing('', 'Failed to connect to user scope bus', 1)).liveness('A');
    expect(l.state).toBe('unknown');
    expect(l.detail).toContain('Failed to connect to user scope bus');
    expect(l.detail).toContain('enable-linger');
  });
});

describe('launchd liveness (1.1)', () => {
  const printing = (stdout: string, stderr = '', code = 0): Exec => async () => ({ stdout, stderr, code });

  it('a loaded service is running and reports its launchd state', async () => {
    const l = await makeLaunchdBackend(printing('network.ours.fleet.A = {\n\tstate = running\n}'), 501).liveness('A');
    expect(l).toEqual({ state: 'running', detail: 'loaded (state = running)' });
  });

  it('a loaded but waiting KeepAlive service still counts as running', async () => {
    const l = await makeLaunchdBackend(printing('\tstate = waiting\n'), 501).liveness('A');
    expect(l).toEqual({ state: 'running', detail: 'loaded (state = waiting)' });
  });

  it('an unknown service is a definite stop', async () => {
    const err = 'Could not find service "network.ours.fleet.A" in domain for gui/501';
    const l = await makeLaunchdBackend(printing('', err, 113), 501).liveness('A');
    expect(l).toEqual({ state: 'stopped', detail: 'not loaded (network.ours.fleet.A)' });
  });

  it('any other probe failure is unknown, not a stop', async () => {
    const l = await makeLaunchdBackend(printing('', 'Could not find domain for gui/501', 113), 501).liveness('A');
    expect(l.state).toBe('unknown');
    expect(l.detail).toContain('Could not find domain');
  });
});

describe('none backend liveness (1.1)', () => {
  const hasSession = (code: number, stderr = ''): Exec => async () => ({ stdout: '', stderr, code });

  it('reports the tmux probe directly', async () => {
    expect((await makeNoneBackend(hasSession(0)).liveness('A')).state).toBe('running');
    expect((await makeNoneBackend(hasSession(1, "can't find session: A")).liveness('A')).state).toBe('stopped');
  });

  it('a tmux that cannot run at all is unknown, not a stop', async () => {
    const l = await makeNoneBackend(hasSession(127)).liveness('A');
    expect(l.state).toBe('unknown');
    expect(l.detail).toContain('127');
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

describe('systemd bus-error hint (#9)', () => {
  const BUS_ERR = 'Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined';
  const failing = (stderr: string): Exec => async () => ({ stdout: '', stderr, code: 1 });

  it('install failure on the user-bus error carries the linger hint', async () => {
    await expect(makeSystemdBackend(failing(BUS_ERR)).install('A', '/b'))
      .rejects.toThrow(/enable-linger/);
    await expect(makeSystemdBackend(failing(BUS_ERR)).install('A', '/b'))
      .rejects.toThrow(/XDG_RUNTIME_DIR=\/run\/user/);
  });

  it('restart and stop failures carry it too', async () => {
    await expect(makeSystemdBackend(failing(BUS_ERR)).restart('A')).rejects.toThrow(/enable-linger/);
    await expect(makeSystemdBackend(failing(BUS_ERR)).stop('A')).rejects.toThrow(/enable-linger/);
  });

  it('unrelated failures stay unhinted', async () => {
    const e = await makeSystemdBackend(failing('Unit ours-fleet-agent@A.service not found.'))
      .restart('A').then(() => null, err => err as Error);
    expect(String(e)).toContain('not found');
    expect(String(e)).not.toContain('enable-linger');
  });
});

describe('service managers no longer run the child-session loop (3.2)', () => {
  it('systemd restarts the runner only when it FAILS, not on every exit', async () => {
    const { exec } = recorder();
    await makeSystemdBackend(exec).init('/usr/local/bin/ours-fleet');
    const unit = readFileSync(join(dir, '.config/systemd/user/ours-fleet-agent@.service'), 'utf8');
    // Restart=always would resume the uncounted two-second relaunch loop and
    // would restart a runner that is deliberately holding an agent down.
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toMatch(/^Restart=always$/m);
    expect(unit).not.toMatch(/^RestartSec=2$/m);
  });

  it('launchd keeps the runner alive only on unsuccessful exit', async () => {
    const { exec } = recorder();
    await makeLaunchdBackend(exec, 501).install('A', '/usr/local/bin/ours-fleet');
    const plist = readFileSync(join(dir, 'Library/LaunchAgents/network.ours.fleet.A.plist'), 'utf8');
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).not.toContain('<key>KeepAlive</key><true/>');
  });
});
