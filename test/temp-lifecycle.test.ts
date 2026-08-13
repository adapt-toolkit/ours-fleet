import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEMP_STOP_REQUEST_FILE, TEMP_SUPERVISOR_FILE, TEMP_TERMINATION_FILE,
  TEMP_LAUNCH_GRACE_MS, archiveTempState, makeTempSupervisorLauncher,
  markTempSupervisorActive, prepareTempSupervisor, readTempSupervisor,
  reclaimStaleTempState, stopTempSupervisor, tempSupervisorLiveness, tempSystemdUnit,
} from '../src/temp-lifecycle.js';
import { agentDir, stateRoot } from '../src/paths.js';
import type { Exec } from '../src/exec.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ours-fleet-temp-life-'));
  process.env.OURS_FLEET_HOME = home;
});
afterEach(() => {
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

describe('independent temporary supervisor ownership', () => {
  it('uses a collected transient systemd unit, outside the caller role unit', async () => {
    const dir = temp('Worker');
    const calls: Array<[string, string[]]> = [];
    const exec: Exec = async (command, args) => {
      calls.push([command, args]);
      return { stdout: '', stderr: '', code: 0 };
    };
    const launch = makeTempSupervisorLauncher({ exec, platform: 'linux', supervisor: 'systemd' });

    await launch('/opt/ours-fleet', ['_run-temp', 'Worker'], dir);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('systemd-run');
    expect(calls[0][1]).toContain(`--unit=${tempSystemdUnit('Worker')}`);
    expect(calls[0][1]).toContain('--collect');
    expect(calls[0][1].join(' ')).not.toContain('ours-fleet-agent@Coordinator');
    expect(readTempSupervisor(dir)).toMatchObject({
      phase: 'active', kind: 'systemd-transient', target: tempSystemdUnit('Worker'),
    });
  });

  it('records launch failure without pretending the transient unit started', async () => {
    const dir = temp('Broken');
    const launch = makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd',
      exec: async () => ({ stdout: '', stderr: 'user bus unavailable', code: 1 }),
    });
    await expect(launch('/opt/ours-fleet', ['_run-temp', 'Broken'], dir))
      .rejects.toThrow(/user bus unavailable/);
  });

  it('never archives a role while its transient unit is still being registered', async () => {
    const dir = temp('Racing');
    let entered!: () => void;
    let finish!: () => void;
    const registrationStarted = new Promise<void>(resolve => { entered = resolve; });
    const registrationGate = new Promise<void>(resolve => { finish = resolve; });
    const launch = makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd',
      exec: async () => {
        entered();
        await registrationGate;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const pending = launch('/opt/ours-fleet', ['_run-temp', 'Racing'], dir);
    await registrationStarted;
    const createdAt = Date.parse(readTempSupervisor(dir)!.createdAt);

    const archived = await reclaimStaleTempState({
      now: () => createdAt + TEMP_LAUNCH_GRACE_MS - 1,
      exec: async () => ({ stdout: 'inactive\n', stderr: '', code: 0 }),
    });

    expect(archived).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    finish();
    await pending;
  });

  it('propagates the daemon profile into a transient supervisor', async () => {
    const dir = temp('Profiled');
    const previous = Object.fromEntries([
      'OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN', 'OURS_CONFIG',
    ].map(key => [key, process.env[key]]));
    Object.assign(process.env, {
      OURS_PORT: '4567', OURS_STATE_DIR: '/profile/state',
      OURS_API_TOKEN: 'fixture-token', OURS_CONFIG: '/profile/config.json',
    });
    let args: string[] = [];
    try {
      await makeTempSupervisorLauncher({
        platform: 'linux', supervisor: 'systemd',
        exec: async (_command, actual) => {
          args = actual;
          return { stdout: '', stderr: '', code: 0 };
        },
      })('/opt/ours-fleet', ['_run-temp', 'Profiled'], dir);
    } finally {
      for (const [key, value] of Object.entries(previous))
        value === undefined ? delete process.env[key] : process.env[key] = value;
    }
    expect(args).toEqual(expect.arrayContaining([
      '--setenv=OURS_PORT=4567', '--setenv=OURS_STATE_DIR=/profile/state',
      '--setenv=OURS_API_TOKEN=fixture-token', '--setenv=OURS_CONFIG=/profile/config.json',
    ]));
  });
});

describe('exact operator targeting and evidence', () => {
  it('stops only the transient unit recorded for the exact temp role', async () => {
    const dir = temp('Exact');
    const setup = makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd',
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    await setup('/opt/ours-fleet', ['_run-temp', 'Exact'], dir);
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
});

describe('bounded stale-state reclamation', () => {
  it('archives only recorded supervisors that are definitively stopped', async () => {
    const stopped = temp('Stopped');
    const live = temp('Live');
    const legacy = agentDir('Legacy', true);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'role.yaml'), 'name: Legacy\n');
    const setupExec: Exec = async () => ({ stdout: '', stderr: '', code: 0 });
    const launch = makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd', exec: setupExec,
    });
    await launch('/opt/ours-fleet', ['_run-temp', 'Stopped'], stopped);
    await launch('/opt/ours-fleet', ['_run-temp', 'Live'], live);

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
