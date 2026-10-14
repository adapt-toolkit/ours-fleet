import { fleetHostBackend } from '../src/supervisor/fleet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEMP_STOP_REQUEST_FILE, TEMP_SUPERVISOR_FILE, TEMP_TERMINATION_FILE,
  TEMP_LAUNCH_GRACE_MS, archiveTempState, makeTempSupervisorLauncher,
  markTempSupervisorActive, prepareTempSupervisor, readTempSupervisor,
  reclaimStaleTempState, secureStoppedTempArchive, stopTempSupervisor,
  tempArchiveForCreationAction, tempArchiveForLaunch, tempSupervisorLiveness, tempSystemdUnit,
} from '../src/temp-lifecycle.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { memberKey, readMember, registerMember } from '../src/supervisor/catalog.js';
import type { Exec } from '../src/exec.js';

let home: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ours-fleet-temp-life-'));
  process.env.OURS_FLEET_HOME = home;
  const setup = async () => ({ code: 0, stdout: '', stderr: '' });
  await fleetHostBackend(setup, 'linux').init('/fixture/fleet');
  await fleetHostBackend(setup, 'darwin').init('/fixture/fleet');
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.OURS_FLEET_HOME;
  rmSync(home, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = agentDir(name, true);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.yaml'), `name: ${name}\n`);
  prepareTempSupervisor(dir, name);
  return dir;
}

describe('Fleet-managed temporary process ownership', () => {
  it.each(['linux', 'darwin'] as const)('persists runtime and profile selection in the shared %s service', async platform => {
    for (const value of ['/fixture/native codex', '', undefined]) {
      vi.stubEnv('CODEX_PATH', value);
      vi.stubEnv('OURS_CONFIG', '/profile/client.json');
      await fleetHostBackend(async () => ({ code: 0, stdout: '', stderr: '' }), platform).init('/fixture/fleet');
      const dir = temp('Runtime');
      let bootstrapped = false;
      await makeTempSupervisorLauncher({ platform, supervisor: 'managed', exec: async (cmd, args) => {
        if (args[0] === 'bootstrap') bootstrapped = true;
        if (cmd === 'launchctl' && args[0] === 'print') return bootstrapped
          ? { stdout: 'state = running', stderr: '', code: 0 }
          : { stdout: '', stderr: 'Could not find service', code: 113 };
        return { stdout: 'active', stderr: '', code: 0 };
      } })('/fixture/fleet', ['_run-temp', 'Runtime'], dir);
      const path = platform === 'linux' ? join(home, '.config/systemd/user/ours-fleet.service')
        : join(home, 'Library/LaunchAgents/network.ours.fleet.plist');
      const content = readFileSync(path, 'utf8');
      expect(content).toContain('_run-fleet'); expect(content).toContain('/profile/client.json');
      if (value !== undefined) expect(content).toContain(platform === 'linux' ? `CODEX_PATH=${value}` : `<key>CODEX_PATH</key><string>${value}</string>`);
      else expect(content).not.toContain('CODEX_PATH');
      expect(readMember(memberKey('Runtime', 'temporary'))?.desired).toBe('running');
    }
  });
  it('adding a temporary member does not stop or restart the Fleet parent', async () => {
    const calls: string[][] = [], dir = temp('Worker');
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'active', stderr: '', code: 0 }; };
    await makeTempSupervisorLauncher({ exec, platform: 'linux', supervisor: 'managed' })('/fixture/fleet', ['_run-temp', 'Worker'], dir);
    expect(readTempSupervisor(dir)).toMatchObject({ kind: 'fleet-managed', target: 'temporary-Worker', phase: 'active' });
    expect(calls.some(call => call[0] === 'systemd-run' || call.includes('stop') || call.includes('restart') || call.includes('disable'))).toBe(false);
    expect(calls.some(call => call.includes('daemon-reload') || call[0] === 'loginctl' || call.includes('enable'))).toBe(false);
  });
  it('operator retirement removes the temporary catalog and private selection without stopping the parent', async () => {
    const dir = temp('Retired'), calls: string[][] = [];
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'active', stderr: '', code: 0 }; };
    await makeTempSupervisorLauncher({ exec, platform: 'linux', supervisor: 'managed' })('/fixture/fleet', ['_run-temp', 'Retired'], dir);
    await stopTempSupervisor('Retired', { exec });
    expect(readMember('temporary-Retired')).toBeUndefined();
    expect(existsSync(join(home, '.config/systemd/user/ours-fleet.service'))).toBe(true);
    expect(calls.some(call => call.includes('stop') || call.includes('disable'))).toBe(false);
  });
  it('retains exact launch state when the Fleet service cannot be started', async () => {
    const dir = temp('Broken'), launchId = readTempSupervisor(dir)!.launchId;
    await expect(makeTempSupervisorLauncher({ platform: 'linux', supervisor: 'managed',
      exec: async () => ({ stdout: '', stderr: 'user bus unavailable', code: 1 }),
    })('/fixture/fleet', ['_run-temp', 'Broken'], dir)).rejects.toThrow('FLEET_SERVICE_LIVENESS_UNKNOWN');
    expect(readTempSupervisor(dir)?.launchId).toBe(launchId);
  });
  it('reclamation preserves stopped children with retained running Fleet intent', async () => {
    const dir = temp('Restarting');
    await registerMember({ name: 'Restarting', kind: 'temporary', dir });
    writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...readTempSupervisor(dir), phase: 'active', kind: 'fleet-managed', target: 'temporary-Restarting' }));
    expect(await reclaimStaleTempState({ now: () => Date.now() + 100_000 })).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('exact operator targeting and evidence', () => {
  it('stops only the transient unit recorded for the exact temp role', async () => {
    const dir = temp('Exact');
    writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...readTempSupervisor(dir), kind: 'systemd-transient', target: tempSystemdUnit('Exact'), phase: 'active' }));
    const calls: Array<[string, string[]]> = [];

    const outcome = await stopTempSupervisor('Exact', {
      exec: async (command, args) => {
        calls.push([command, args]);
        return { stdout: '', stderr: '', code: 0 };
      },
    });

    expect(outcome).toBe('stopped');
    expect(calls).toEqual([['systemctl', ['--user', 'stop', tempSystemdUnit('Exact')]]]);
    expect(readFileSync(join(dir, TEMP_STOP_REQUEST_FILE), 'utf8')).toContain('operator-stop');
  });

  it('refuses legacy cleanup when the process table cannot prove ownership', async () => {
    const dir = agentDir('Legacy', true);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'role.yaml'), 'name: Legacy\n');
    await expect(stopTempSupervisor('Legacy', {
      exec: async () => ({ stdout: '', stderr: 'denied', code: 1 }),
    })).rejects.toThrow(/refusing an unverified process kill/);
  });

  it('adopts and stops exactly one legacy _run-temp process, never a name-only pid guess', async () => {
    const dir = agentDir('Legacy', true);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'role.yaml'), 'name: Legacy\n');
    const signals: Array<NodeJS.Signals | 0> = [];
    const outcome = await stopTempSupervisor('Legacy', {
      exec: async (_command, args) => args.includes('-ax')
        ? { stdout: '424242 node /opt/fleet.js _run-temp Legacy\n', stderr: '', code: 0 }
        : { stdout: 'node /opt/fleet.js _run-temp Legacy\n', stderr: '', code: 0 },
      kill: (_pid, signal) => { signals.push(signal); },
    });

    expect(outcome).toBe('stopped');
    expect(signals).toEqual([0, 'SIGTERM']);
    expect(readTempSupervisor(dir)).toMatchObject({ kind: 'detached', pid: 424242 });
  });

  it('settles incomplete metadata when no exact supervisor process remains', async () => {
    const dir = temp('Incomplete');

    await expect(stopTempSupervisor('Incomplete', {
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    })).resolves.toBe('already-stopped');

    expect(readFileSync(join(dir, TEMP_STOP_REQUEST_FILE), 'utf8')).toContain('operator-stop');
  });

  it('does not age a live no-kind supervisor pid into stopped state', async () => {
    const dir = temp('NoKind');
    await markTempSupervisorActive(dir, 424242);

    const live = await tempSupervisorLiveness(dir, {
      now: () => Date.now() + TEMP_LAUNCH_GRACE_MS + 1,
      kill: () => {},
      exec: async () => ({
        stdout: 'node /opt/fleet.js _run-temp NoKind\n', stderr: '', code: 0,
      }),
    });

    expect(live).toBe('running');
  });

  it('archives termination evidence idempotently and removes the live roster entry', () => {
    const dir = temp('Done');
    writeFileSync(join(dir, 'WORKLOG.md'), 'valuable evidence\n');

    const archived = archiveTempState(
      'Done', 'identity-closed', 'retired', 'identity disappeared after a confirmed bind',
      new Date('2026-08-13T10:00:00.000Z'),
    )!;

    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(archived, 'WORKLOG.md'), 'utf8')).toContain('valuable evidence');
    expect(readFileSync(join(archived, TEMP_TERMINATION_FILE), 'utf8'))
      .toContain('"reason":"identity-closed"');
    expect(readFileSync(join(stateRoot(), 'recovery', 'temporary', 'terminations.jsonl'), 'utf8'))
      .toContain('"outcome":"retired"');
    expect(archiveTempState('Done', 'identity-closed', 'retired', 'duplicate')).toBeUndefined();
  });

  it('preserves both archives when the same launch suffix already has a retiring directory', () => {
    const dir = temp('Role');
    writeFileSync(join(dir, 'WORKLOG.md'), 'new live evidence\n');
    const suffix = readTempSupervisor(dir)!.launchId.slice(0, 8);
    const recovery = join(stateRoot(), 'recovery', 'temporary');
    mkdirSync(recovery, { recursive: true });
    const stale = join(recovery, `.Role-${suffix}.retiring`);
    mkdirSync(stale);
    writeFileSync(join(stale, 'WORKLOG.md'), 'older interrupted evidence\n');

    const archived = archiveTempState(
      'Role', 'operator-stop', 'retired', 'same-suffix collision',
      new Date('2026-08-13T10:00:00.000Z'),
    )!;

    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(stale, 'WORKLOG.md'), 'utf8')).toContain('older interrupted evidence');
    expect(readFileSync(join(archived, 'WORKLOG.md'), 'utf8')).toContain('new live evidence');
    expect(archived).toMatch(/-Role-[0-9a-f]{8}-2$/);
  });

  it('secures only the exact stopped launch and preserves the archive allowlist', async () => {
    const dir = temp('RoomMember');
    writeFileSync(join(dir, 'WORKLOG.md'), 'room evidence\n');
    await markTempSupervisorActive(dir, 424242);
    const launchId = readTempSupervisor(dir)!.launchId;
    const archived = await secureStoppedTempArchive('RoomMember', launchId, {
      kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    });

    expect(existsSync(dir)).toBe(false);
    expect(tempArchiveForLaunch('RoomMember', launchId)).toBe(archived);
    expect(readdirSync(archived).sort()).toEqual([
      '.temp-supervisor.json', '.termination-globally-recorded',
      'WORKLOG.md', 'role.yaml', 'termination.jsonl',
    ]);
    expect(readFileSync(join(archived, 'WORKLOG.md'), 'utf8')).toBe('room evidence\n');
  });

  it('resolves a terminated archive by exact creation action provenance', async () => {
    const dir = temp('CrashWindow');
    writeFileSync(join(dir, 'creation.json'), JSON.stringify({
      role: 'CrashWindow', creationActionId: 'action-123',
    }));
    await markTempSupervisorActive(dir, 424242);
    const launchId = readTempSupervisor(dir)!.launchId;
    const archived = await secureStoppedTempArchive('CrashWindow', launchId, {
      kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    expect(tempArchiveForCreationAction('CrashWindow', 'action-123')).toEqual({
      path: archived, launchId,
    });
    expect(tempArchiveForCreationAction('CrashWindow', 'other')).toBeUndefined();
  });
});

describe('bounded stale-state reclamation', () => {
  it('archives only recorded supervisors that are definitively stopped', async () => {
    const stopped = temp('Stopped');
    const live = temp('Live');
    const legacy = agentDir('Legacy', true);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'role.yaml'), 'name: Legacy\n');
    for (const [name, dir] of [['Stopped', stopped], ['Live', live]]) {
      writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({
        ...readTempSupervisor(dir), kind: 'systemd-transient', target: tempSystemdUnit(name), phase: 'active',
      }));
    }

    const archived = await reclaimStaleTempState({
      exec: async (_command, args) => ({
        stdout: args.at(-1) === tempSystemdUnit('Stopped') ? 'inactive\n' : 'active\n',
        stderr: '', code: 0,
      }),
      now: () => Date.parse('2026-08-13T10:01:00.000Z'),
    });

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain('-Stopped-');
    expect(existsSync(stopped)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(legacy, TEMP_SUPERVISOR_FILE))).toBe(false);
    expect(readdirSync(join(stateRoot(), 'recovery', 'temporary')).some(name => name.includes('-Stopped-')))
      .toBe(true);
  });

  it('finishes an interrupted archive and synthesizes missing audit evidence', async () => {
    const source = temp('Interrupted');
    const recovery = join(stateRoot(), 'recovery', 'temporary');
    mkdirSync(recovery, { recursive: true });
    const retiring = join(recovery, '.Interrupted-deadbeef.retiring');
    renameSync(source, retiring);

    const archived = await reclaimStaleTempState({
      now: () => Date.parse('2026-08-13T10:02:00.000Z'),
    });

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain('-recovered-Interrupted-deadbeef');
    expect(readFileSync(join(archived[0], TEMP_TERMINATION_FILE), 'utf8'))
      .toContain('interrupted before its termination journal was durable');
    expect(readFileSync(join(recovery, 'terminations.jsonl'), 'utf8'))
      .toContain('"outcome":"reclaimed"');
  });

  it('preserves a hyphenated role name when synthesizing interrupted evidence', async () => {
    const recovery = join(stateRoot(), 'recovery', 'temporary');
    const retiring = join(recovery, '.Tester-2-deadbeef.retiring');
    mkdirSync(retiring, { recursive: true });
    writeFileSync(join(retiring, 'WORKLOG.md'), 'hyphenated evidence\n');

    const archived = await reclaimStaleTempState({
      now: () => Date.parse('2026-08-13T10:03:00.000Z'),
    });

    expect(archived).toHaveLength(1);
    const line = readFileSync(join(recovery, 'terminations.jsonl'), 'utf8').trim();
    expect(JSON.parse(line).role).toBe('Tester-2');
  });

  it('reclaims aged incomplete metadata only after proving no exact process exists', async () => {
    const incomplete = temp('IncompleteStale');
    const createdAt = Date.parse(readTempSupervisor(incomplete)!.createdAt);

    const archived = await reclaimStaleTempState({
      now: () => createdAt + TEMP_LAUNCH_GRACE_MS,
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    });

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain('-IncompleteStale-');
    expect(existsSync(incomplete)).toBe(false);
  });
});

it.each(['managed', 'none'])('rejects unsupported launch metadata before execution in %s mode', async supervisor => {
  const dir = temp('UnsupportedLaunch');
  writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...readTempSupervisor(dir), kind: 'newer-kind' }));
  const exec = vi.fn(), spawnDetached = vi.fn();
  await expect(makeTempSupervisorLauncher({ exec, spawnDetached, supervisor })(
    '/fixture/fleet', ['_run-temp', 'UnsupportedLaunch'], dir)).rejects.toThrow('TEMP_SUPERVISOR_KIND_UNSUPPORTED');
  expect(exec).not.toHaveBeenCalled(); expect(spawnDetached).not.toHaveBeenCalled();
});

it('reclaims an unregistered temporary launch after missing parent installation and launch grace', async () => {
  const dir = temp('NoParent'), metadata = readTempSupervisor(dir)!;
  writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...metadata,
    createdAt: new Date(Date.now() - TEMP_LAUNCH_GRACE_MS - 1000).toISOString() }));
  rmSync(join(home, '.config/systemd/user/ours-fleet.service'));
  const exec = vi.fn();
  await expect(makeTempSupervisorLauncher({ exec, platform: 'linux', supervisor: 'managed' })(
    '/fixture/fleet', ['_run-temp', 'NoParent'], dir)).rejects.toThrow('FLEET_SERVICE_NOT_INSTALLED');
  expect(await tempSupervisorLiveness(dir, { exec })).toBe('stopped');
  const archives = await reclaimStaleTempState({ exec });
  expect(archives).toHaveLength(1); expect(existsSync(dir)).toBe(false);
  expect(readTempSupervisor(archives[0])?.role).toBe('NoParent'); expect(exec).not.toHaveBeenCalled();
});
