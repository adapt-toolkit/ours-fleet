import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeSystemdBackend, makeLaunchdBackend, makeNoneBackend, pickBackend, unitFor, labelFor } from '../src/supervisor/index.js';
import { classifyStart } from '../src/supervisor/launchd.js';
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
    // Anchored: this file now carries `#` comments, and a substring match can be
    // satisfied by one of them rather than by the directive itself.
    expect(unit).toContain(`ExecStart="${process.execPath}" "/usr/local/bin/ours-fleet" _run %i`);
    expect(unit).toContain(`Environment="PATH=${dirname(process.execPath)}`);
    expect(unit).toContain('/usr/local/bin');
    expect(unit).toMatch(/^Restart=on-failure$/m);   // the runner owns the retry loop
    expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
    expect(calls.some(c => c[0] === 'loginctl' && c[1] === 'enable-linger')).toBe(true);
    expect(msgs.join('\n')).toContain('linger');
  });

  // A lingering user unit inherits nothing from the shell that ran `init`, which is
  // why PATH is baked. The daemon SELECTION is the other thing it cannot inherit:
  // ours-fleet resolves its daemon from OURS_CONFIG/OURS_PORT/OURS_STATE_DIR and
  // otherwise falls back to ~/.ours and 3050, so a fleet set up against a non-default
  // daemon used to resolve the DEFAULT one in every runner systemd started at boot.
  it('init persists the daemon selection it was given, so boot-started runners keep it', async () => {
    const { exec } = recorder();
    const configPath = join(dir, '.ours-work', 'config.json');
    process.env.OURS_CONFIG = configPath;
    try {
      await makeSystemdBackend(exec).init('/usr/local/bin/ours-fleet');
      const unit = readFileSync(join(dir, '.config/systemd/user/ours-fleet-agent@.service'), 'utf8');
      expect(unit).toContain(`Environment="OURS_CONFIG=${configPath}"`);
      // The port and state directory are deliberately NOT frozen into the unit: the
      // selected daemon's own config file stays authoritative for those, so editing
      // it later still works. Baking them would outrank that file for ever after.
      expect(unit).not.toContain('OURS_PORT');
      expect(unit).not.toContain('OURS_STATE_DIR');
    } finally {
      delete process.env.OURS_CONFIG;
    }
  });

  // Backwards compatibility, and it is the whole safety argument: an init with no
  // daemon selection writes exactly the unit it always wrote.
  it('init with no daemon selection writes no OURS_ line at all', async () => {
    const { exec } = recorder();
    const before = process.env.OURS_CONFIG;
    delete process.env.OURS_CONFIG;
    try {
      await makeSystemdBackend(exec).init('/usr/local/bin/ours-fleet');
      const unit = readFileSync(join(dir, '.config/systemd/user/ours-fleet-agent@.service'), 'utf8');
      expect(unit).not.toContain('OURS_');
      expect(unit).toContain(`Environment="PATH=${dirname(process.execPath)}`);
    } finally {
      if (before !== undefined) process.env.OURS_CONFIG = before;
    }
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
    expect(plist).toMatch(/^\s*<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>$/m);
    expect(calls.some(c => c[0] === 'launchctl' && c[1] === 'bootstrap' && c[2] === 'gui/501')).toBe(true);
    expect(labelFor('A')).toBe('network.ours.fleet.A');
  });

  it('logsArgs tails the role log file', () => {
    const { cmd, args } = makeLaunchdBackend(undefined, 501).logsArgs('A', true);
    expect(cmd).toBe('tail');
    expect(args[1]).toContain('.ours-fleet/logs/A.log');
  });
});

describe('systemd liveness', () => {
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

describe('launchd liveness', () => {
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

describe('none backend liveness', () => {
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

/**
 * #32 — the none backend is where `stop` and `uninstall` actually kill a pane.
 * If any of its tmux calls omits the socket it talks to the shared default
 * server, and stopping one role takes the whole fleet's panes with it.
 */
describe('none backend addresses one server per role (#32)', () => {
  it('install, stop, uninstall, status and liveness all carry the role own socket', async () => {
    const { calls, exec } = recorder();
    const backend = makeNoneBackend(exec);
    await backend.install('A', '/b');
    await backend.stop('A');
    await backend.uninstall('A');
    await backend.status('A');
    await backend.liveness('A');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.slice(0, 3)).toEqual(['tmux', '-L', 'ours-fleet-A']);
  });

  it('logsArgs reads the role own server', () => {
    const { cmd, args } = makeNoneBackend().logsArgs('A', false);
    expect(cmd).toBe('tmux');
    expect(args).toEqual(['-L', 'ours-fleet-A', 'capture-pane', '-t', 'A', '-p']);
  });

  it('stopping one role issues no command against another role server', async () => {
    const { calls, exec } = recorder();
    await makeNoneBackend(exec).stop('Alpha');
    expect(calls.every(c => c[2] === 'ours-fleet-Alpha')).toBe(true);
    expect(calls.some(c => c.includes('ours-fleet-Beta'))).toBe(false);
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

describe('service managers no longer run the child-session loop', () => {
  it('systemd restarts the runner only when it FAILS, not on every exit', async () => {
    const { exec } = recorder();
    await makeSystemdBackend(exec).init('/usr/local/bin/ours-fleet');
    const unit = readFileSync(join(dir, '.config/systemd/user/ours-fleet-agent@.service'), 'utf8');
    // Restart=always would resume the uncounted two-second relaunch loop and
    // would restart a runner that is deliberately holding an agent down.
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).not.toMatch(/^Restart=always$/m);
    expect(unit).not.toMatch(/^RestartSec=2$/m);
  });

  it('launchd keeps the runner alive only on unsuccessful exit', async () => {
    const { exec } = recorder();
    await makeLaunchdBackend(exec, 501).install('A', '/usr/local/bin/ours-fleet');
    const plist = readFileSync(join(dir, 'Library/LaunchAgents/network.ours.fleet.A.plist'), 'utf8');
    expect(plist).toMatch(/^\s*<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>$/m);
    expect(plist).not.toMatch(/^\s*<key>KeepAlive<\/key><true\/>$/m);
  });
});

describe('install/uninstall outcomes are explicit and idempotent', () => {
  const answering = (table: Record<string, ExecResult>): Exec =>
    async (cmd, args) => table[[cmd, ...args].join(' ')] ?? { stdout: '', stderr: '', code: 0 };

  it('systemd reports whether it created the registration', async () => {
    const enabled = answering({
      'systemctl --user is-enabled ours-fleet-agent@A.service':
        { stdout: 'enabled\n', stderr: '', code: 0 },
    });
    const fresh = answering({
      'systemctl --user is-enabled ours-fleet-agent@A.service':
        { stdout: '', stderr: 'not found', code: 1 },
    });
    expect(await makeSystemdBackend(fresh).install('A', '/b')).toMatchObject({ created: true });
    expect(await makeSystemdBackend(enabled).install('A', '/b')).toMatchObject({ created: false });
  });

  it('systemd uninstall is idempotent and says whether anything was there', async () => {
    const enabled = answering({
      'systemctl --user is-enabled ours-fleet-agent@A.service':
        { stdout: 'enabled\n', stderr: '', code: 0 },
    });
    const absent = answering({
      'systemctl --user is-enabled ours-fleet-agent@A.service':
        { stdout: '', stderr: '', code: 1 },
    });
    expect(await makeSystemdBackend(enabled).uninstall('A')).toMatchObject({ removed: true });
    expect(await makeSystemdBackend(absent).uninstall('A')).toMatchObject({ removed: false });
  });

  it('launchd reports creation from the plist it had to write', async () => {
    const { exec } = recorder();
    const first = await makeLaunchdBackend(exec, 501).install('A', '/b');
    expect(first).toMatchObject({ created: true });
    const second = await makeLaunchdBackend(exec, 501).install('A', '/b');
    expect(second).toMatchObject({ created: false });          // idempotent
    expect(await makeLaunchdBackend(exec, 501).uninstall('A')).toMatchObject({ removed: true });
    expect(await makeLaunchdBackend(exec, 501).uninstall('A')).toMatchObject({ removed: false });
  });

  it('the none backend reports whether a session was already there', async () => {
    const noSession: Exec = async (_c, args) =>
      ({ stdout: '', stderr: '', code: args.includes('kill-session') ? 1 : 0 });
    const hadSession: Exec = async () => ({ stdout: '', stderr: '', code: 0 });
    expect(await makeNoneBackend(noSession).install('A', '/b')).toMatchObject({ created: true });
    expect(await makeNoneBackend(hadSession).install('A', '/b')).toMatchObject({ created: false });
    expect(await makeNoneBackend(hadSession).uninstall('A')).toMatchObject({ removed: true });
    expect(await makeNoneBackend(noSession).uninstall('A')).toMatchObject({ removed: false });
  });
});

/**
 * A failing `install` throws, so it never returns `{created: true}` and the
 * creation transaction records nothing to roll back. Whatever the install had
 * already written therefore has to be cleaned up by the install itself, or a
 * failed spawn leaves a live launch artifact behind.
 */
describe('a failed registration leaves no artifact', () => {
  const launchAgent = () => join(dir, 'Library/LaunchAgents/network.ours.fleet.A.plist');

  /** bootstrap fails; everything else succeeds. */
  const bootstrapFails = () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args): Promise<ExecResult> => {
      calls.push([cmd, ...args]);
      return args[0] === 'bootstrap'
        ? { stdout: '', stderr: 'Bootstrap failed: 5: Input/output error', code: 5 }
        : { stdout: '', stderr: '', code: 0 };
    };
    return { calls, exec };
  };

  it('launchd removes the plist it just wrote when bootstrap fails', async () => {
    const { calls, exec } = bootstrapFails();
    await expect(makeLaunchdBackend(exec, 501).install('A', '/b')).rejects.toThrow(/bootstrap/);
    // The plist carries RunAtLoad: leaving it is leaving a service that starts
    // at the next login, for a role whose spawn failed.
    expect(existsSync(launchAgent())).toBe(false);
    // and it was booted out of the domain, not merely deleted from disk.
    expect(calls.filter(c => c[1] === 'bootout').length).toBeGreaterThanOrEqual(2);
  });

  it('launchd does NOT delete a plist that was already there', async () => {
    const ok = recorder();
    await makeLaunchdBackend(ok.exec, 501).install('A', '/b');   // pre-existing registration
    expect(existsSync(launchAgent())).toBe(true);
    const { exec } = bootstrapFails();
    await expect(makeLaunchdBackend(exec, 501).install('A', '/b')).rejects.toThrow(/bootstrap/);
    expect(existsSync(launchAgent())).toBe(true);                // not ours to remove
  });

  it('systemd disables a unit it enabled when enable --now fails', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args): Promise<ExecResult> => {
      calls.push([cmd, ...args]);
      if (args[1] === 'is-enabled') return { stdout: 'disabled\n', stderr: '', code: 1 };
      if (args[1] === 'enable') return { stdout: '', stderr: 'Job failed', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await expect(makeSystemdBackend(exec).install('A', '/b')).rejects.toThrow(/enable --now/);
    expect(calls).toContainEqual(
      ['systemctl', '--user', 'disable', '--now', 'ours-fleet-agent@A.service']);
  });

  /**
   * MEASURED on real systemd 255, not reasoned about:
   *   `systemctl --user enable --now <unit>` whose START half fails returns
   *   exit 0, leaves the unit enabled, and reports the failed job only as
   *   prose on stderr. A bare `start` of the same unit returns 1.
   *   With Type=simple and a missing ExecStart binary the unit settles at
   *   ActiveState=failed SubState=failed.
   * Trusting the exit code there makes `spawn` report success while the role's
   * unit sits enabled and dead — this release's own disease, inside the command
   * that creates the role.
   */
  describe('the exit code is not the signal: the start is verified (systemd)', () => {
    /** exit code, then whatever `show` should report. */
    const systemctl = (enableCode: number, activeState: string, subState = ''): {
      calls: string[][]; exec: Exec;
    } => {
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args): Promise<ExecResult> => {
        calls.push([cmd, ...args]);
        if (args[1] === 'is-enabled') return { stdout: 'disabled\n', stderr: '', code: 1 };
        if (args[1] === 'enable') return { stdout: '', stderr: '', code: enableCode };
        if (args[1] === 'show') return { stdout: `${activeState}\n${subState}\n`, stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      };
      return { calls, exec };
    };

    it('a unit left FAILED by a zero-exit `enable --now` is a failed install', async () => {
      const { calls, exec } = systemctl(0, 'failed', 'failed');
      const err = await makeSystemdBackend(exec).install('A', '/b').then(() => null, e => e as Error);
      expect(err, 'install resolved on a dead unit').not.toBeNull();
      expect(err!.message).toContain('reported success but the unit is not running');
      expect(err!.message).toContain('failed (failed)');
      // and it entered the same rollback path as any other failed registration.
      expect(calls).toContainEqual(
        ['systemctl', '--user', 'disable', '--now', 'ours-fleet-agent@A.service']);
    });

    it('an INACTIVE unit is a failed install too', async () => {
      const { exec } = systemctl(0, 'inactive', 'dead');
      await expect(makeSystemdBackend(exec).install('A', '/b'))
        .rejects.toThrow(/not running/);
    });

    it('a unit that really started installs normally, and says what state it is in', async () => {
      const { calls, exec } = systemctl(0, 'active', 'running');
      expect(await makeSystemdBackend(exec).install('A', '/b'))
        .toMatchObject({ created: true, detail: 'enabled ours-fleet-agent@A.service (active (running))' });
      expect(calls.filter(c => c[2] === 'disable')).toEqual([]);
    });

    it('an `activating` unit is not a failed start — systemd is still working on it', async () => {
      const { exec } = systemctl(0, 'activating', 'auto-restart');
      await expect(makeSystemdBackend(exec).install('A', '/b')).resolves.toMatchObject({ created: true });
    });

    it('an UNANSWERABLE probe is never read as a failed start', async () => {
      // The unit may be perfectly fine and the bus merely unreachable. Refusing
      // the install here would take down a healthy role for a failed probe.
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args): Promise<ExecResult> => {
        calls.push([cmd, ...args]);
        if (args[1] === 'is-enabled') return { stdout: 'disabled\n', stderr: '', code: 1 };
        if (args[1] === 'show') return { stdout: '', stderr: 'Failed to connect to bus', code: 1 };
        return { stdout: '', stderr: '', code: 0 };
      };
      await expect(makeSystemdBackend(exec).install('A', '/b')).resolves.toMatchObject({ created: true });
      expect(calls.filter(c => c[2] === 'disable')).toEqual([]);
    });

    it('a unit that was ALREADY enabled is not disabled by the verification', async () => {
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args): Promise<ExecResult> => {
        calls.push([cmd, ...args]);
        if (args[1] === 'is-enabled') return { stdout: 'enabled\n', stderr: '', code: 0 };
        if (args[1] === 'show') return { stdout: 'failed\nfailed\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      };
      await expect(makeSystemdBackend(exec).install('A', '/b')).rejects.toThrow(/not running/);
      expect(calls.filter(c => c[2] === 'disable')).toEqual([]);
    });

    it('works on a systemd that DOES propagate the failure into the exit code', async () => {
      // Version-independence is the point: the check asks the unit its own
      // state, so it is correct whether or not this systemd sets the code.
      const { calls, exec } = systemctl(1, 'failed', 'failed');
      await expect(makeSystemdBackend(exec).install('A', '/b')).rejects.toThrow(/enable --now/);
      expect(calls).toContainEqual(
        ['systemctl', '--user', 'disable', '--now', 'ours-fleet-agent@A.service']);
    });
  });

  /**
   * The launchd half of the same fix.
   *
   * `launchctl bootstrap` exits 0 once the job is LOADED; `RunAtLoad` then
   * starts the program asynchronously, so the exit code is a statement about the
   * load and not about the program. NOT VERIFIED against a real launchctl —
   * there is no macOS host here, so these tests drive the parser and the
   * decision, not macOS itself. What IS verified is that the decision is the
   * same one systemd's makes from the same kind of evidence.
   */
  describe('the exit code is not the signal: the start is verified (launchd)', () => {
    /** bootstrap exit code, then whatever `launchctl print` should report. */
    const launchctl = (bootstrapCode: number, print: { stdout?: string; stderr?: string; code?: number }): {
      calls: string[][]; exec: Exec;
    } => {
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args): Promise<ExecResult> => {
        calls.push([cmd, ...args]);
        if (args[0] === 'bootstrap') return { stdout: '', stderr: '', code: bootstrapCode };
        if (args[0] === 'print')
          return { stdout: print.stdout ?? '', stderr: print.stderr ?? '', code: print.code ?? 0 };
        return { stdout: '', stderr: '', code: 0 };
      };
      return { calls, exec };
    };
    const launchAgent = () => join(dir, 'Library/LaunchAgents/network.ours.fleet.A.plist');

    it('a job left DEAD by a zero-exit bootstrap is a failed install', async () => {
      const { calls, exec } = launchctl(0, {
        stdout: 'network.ours.fleet.A = {\n\tstate = not running\n\tlast exit code = 1\n}',
      });
      const err = await makeLaunchdBackend(exec, 501).install('A', '/b').then(() => null, e => e as Error);
      expect(err, 'install resolved on a dead job').not.toBeNull();
      expect(err!.message).toContain('reported success but the job is not running');
      expect(err!.message).toContain('last exit = 1');
      // and it entered the SAME rollback path as a failed bootstrap: nothing
      // is left behind, on disk or in the domain.
      expect(existsSync(launchAgent())).toBe(false);
      expect(calls.filter(c => c[1] === 'bootout').length).toBeGreaterThanOrEqual(2);
    });

    it('a job that bootstrap loaded but the domain does not have is a failed install', async () => {
      const { exec } = launchctl(0, {
        stderr: 'Could not find service "network.ours.fleet.A" in domain for gui/501', code: 113,
      });
      await expect(makeLaunchdBackend(exec, 501).install('A', '/b'))
        .rejects.toThrow(/not running.*not loaded in the domain/s);
      expect(existsSync(launchAgent())).toBe(false);
    });

    it('a job that really started installs normally, and says what state it is in', async () => {
      const { calls, exec } = launchctl(0, { stdout: '\tstate = running\n\tpid = 4242\n' });
      expect(await makeLaunchdBackend(exec, 501).install('A', '/b'))
        .toMatchObject({ created: true, detail: 'installed network.ours.fleet.A (state = running)' });
      expect(existsSync(launchAgent())).toBe(true);
      expect(calls.filter(c => c[1] === 'bootout').length).toBe(1);   // the pre-bootstrap refresh only
    });

    it('a job WAITING for a KeepAlive restart is not a failed start', async () => {
      // launchd is still working on it — the launchd analogue of `activating`.
      const { exec } = launchctl(0, { stdout: '\tstate = waiting\n\tlast exit code = 1\n' });
      await expect(makeLaunchdBackend(exec, 501).install('A', '/b'))
        .resolves.toMatchObject({ created: true });
    });

    it('not running with NOTHING exited yet is not a failed start — RunAtLoad is async', async () => {
      // The program has not been spawned yet. Reading this as a failure would
      // roll back healthy roles on a slow host, which is the asynchrony trap.
      const { exec } = launchctl(0, { stdout: '\tstate = not running\n' });
      await expect(makeLaunchdBackend(exec, 501).install('A', '/b'))
        .resolves.toMatchObject({ created: true });
    });

    it('an UNANSWERABLE probe is never read as a failed start', async () => {
      // launchd may be perfectly fine and launchctl merely unable to answer.
      const { exec } = launchctl(0, { stderr: 'Bootstrap failed: 5: Input/output error', code: 5 });
      await expect(makeLaunchdBackend(exec, 501).install('A', '/b'))
        .resolves.toMatchObject({ created: true });
      expect(existsSync(launchAgent())).toBe(true);
    });

    it('a plist that was ALREADY there is not deleted by the verification', async () => {
      await makeLaunchdBackend(recorder().exec, 501).install('A', '/b');   // pre-existing
      const { exec } = launchctl(0, { stdout: '\tstate = not running\n\tlast exit code = 78\n' });
      await expect(makeLaunchdBackend(exec, 501).install('A', '/b')).rejects.toThrow(/not running/);
      expect(existsSync(launchAgent())).toBe(true);                        // not ours to remove
    });

    it('reads every spelling launchd uses for the last-exit line', async () => {
      for (const line of ['last exit code = 1', 'last exit status = 256', 'last exit reason = Killed']) {
        const { exec } = launchctl(0, { stdout: `\tstate = not running\n\t${line}\n` });
        await expect(makeLaunchdBackend(exec, 501).install('A', '/b'), line).rejects.toThrow(/not running/);
        expect(existsSync(launchAgent()), line).toBe(false);   // rolled back each time
      }
    });

    it('an unrecognised last-exit spelling yields unknown, never a false failure', async () => {
      // The spelling is not stable across macOS releases and cannot be checked
      // from here, so a line this does not recognise must not fail the install.
      const { exec } = launchctl(0, { stdout: '\tstate = not running\n\tlast termination = 9\n' });
      await expect(makeLaunchdBackend(exec, 501).install('A', '/b'))
        .resolves.toMatchObject({ created: true });
    });

    it('classifyStart keeps liveness distinct: a loaded dead job is still LIVE for 1.1', async () => {
      // The two questions differ. `install` asks whether the job started;
      // `liveness` asks whether the role's context still exists, and a loaded
      // job — even one between KeepAlive restarts — answers yes.
      const dead = '\tstate = not running\n\tlast exit code = 1\n';
      expect(classifyStart({ loaded: true, notFound: false, state: 'not running', lastExit: '1' }).started)
        .toBe('no');
      const l = await makeLaunchdBackend(launchctl(0, { stdout: dead }).exec, 501).liveness('A');
      expect(l).toEqual({ state: 'running', detail: 'loaded (state = not running)' });
    });
  });

  it('systemd does NOT disable a unit that was already enabled', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args): Promise<ExecResult> => {
      calls.push([cmd, ...args]);
      if (args[1] === 'is-enabled') return { stdout: 'enabled\n', stderr: '', code: 0 };
      if (args[1] === 'enable') return { stdout: '', stderr: 'Job failed', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    await expect(makeSystemdBackend(exec).install('A', '/b')).rejects.toThrow(/enable --now/);
    expect(calls.filter(c => c[2] === 'disable')).toEqual([]);
  });
});
