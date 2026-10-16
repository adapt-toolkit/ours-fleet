import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDir } from '../src/paths.js';
import { writeV2Fixture } from './v2-fixture.js';
import { waitForRoleDaemon, waitForTaskRoomManagement, STARTUP_WAIT_MS, STARTUP_RETRY_MS, ROOM_PROBE_TIMEOUT_MS } from '../src/startup-readiness.js';
import { CoworkProtocolError, CoworkUnavailableError } from '../src/rooms-tasks/cowork-adapter.js';
import { stringify } from 'yaml';
import type { DaemonGenerationProbe } from '../src/daemon-recovery.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-startup-'));
  process.env.OURS_FLEET_HOME = home;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(home, { recursive: true, force: true });
});
const ready: DaemonGenerationProbe = { state: 'ready', generation: {
  bootId: 'boot', pid: 123, startedAt: 1, stateDir: '/opaque/server/state',
} };
function setup() {
  const path = join(home, 'custom.yaml');
  writeV2Fixture(path, { roles: { A: {
    harness: 'codex', identity: 'A', env: { OURS_CONFIG: '/role/profile.json' },
  } } });
  const dir = agentDir('A');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.config-path'), path + '\n');
  writeFileSync(join(dir, '.restart-ledger.json'), '{"consecutiveImmediateFailures":2}\n');
  writeFileSync(join(dir, '.session-id'), 'retained-session\n');
  return dir;
}

describe('service daemon readiness', () => {
  it('waits through more than five unavailable probes, then starts with the saved role selection', async () => {
    const dir = setup();
    let clock = 0;
    const envs: NodeJS.ProcessEnv[] = [];
    const probe = vi.fn(async (env: NodeJS.ProcessEnv): Promise<DaemonGenerationProbe> => {
      envs.push(env);
      return envs.length <= 8 ? { state: 'unavailable', reason: 'DAEMON_SELECTED_PROBE_UNAVAILABLE' } : ready;
    });
    const log = vi.fn();
    await waitForRoleDaemon('A', undefined, {
      probe, env: { OURS_CONFIG: '/service/profile.json' }, now: () => clock,
      sleep: async ms => { clock += ms; }, log,
    });
    expect(probe).toHaveBeenCalledTimes(9);
    expect(envs.every(env => env.OURS_CONFIG === '/role/profile.json')).toBe(true);
    expect(clock).toBe(40_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(dir, '.restart-ledger.json'), 'utf8')).toBe('{"consecutiveImmediateFailures":2}\n');
    expect(readFileSync(join(dir, '.session-id'), 'utf8')).toBe('retained-session\n');
  });

  it('times out for a service-manager retry without resetting agent state', async () => {
    const dir = setup();
    let clock = 0;
    await expect(waitForRoleDaemon('A', undefined, {
      probe: async () => ({ state: 'unavailable', reason: 'DAEMON_INFO_UNAUTHORIZED' }),
      now: () => clock, sleep: async ms => { clock += ms; }, log: () => {},
    })).rejects.toThrow('service manager will retry startup');
    expect(clock).toBe(STARTUP_WAIT_MS);
    expect(readFileSync(join(dir, '.session-id'), 'utf8')).toBe('retained-session\n');
  });

  it('honors an explicit manifest over the saved path and reports invalid configuration', async () => {
    setup();
    const path = join(home, 'explicit.yaml');
    writeV2Fixture(path, { roles: { A: { harness: 'codex', identity: 'A' } } });
    const probe = vi.fn(async () => ready);
    await waitForRoleDaemon('A', path, { env: { OURS_CONFIG: '/service/profile.json' }, probe, log: () => {} });
    expect(probe).toHaveBeenCalledWith({ OURS_CONFIG: '/service/profile.json' });
    await expect(waitForRoleDaemon('Missing', path, { probe })).rejects.toThrow();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('task room management readiness', () => {
  const room = '01m4r67ed38q3wkj2452nebadb';
  function member(withRoom = true) {
    const dir = agentDir('M', true);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'role.yaml'), stringify({
      name: 'M', harness: 'codex', identity: 'M', env: { OURS_CONFIG: '/role/profile.json' },
      ...(withRoom ? { roomMemberStartup: { room_id: room, room_identity_cid: 'C'.repeat(64), invite_id: 'seat', role: 'Developer' } } : {}),
    }));
    writeFileSync(join(dir, '.restart-ledger.json'), '{"consecutiveImmediateFailures":4}\n');
    return dir;
  }
  const unavailable = () => new CoworkUnavailableError(
    'Cowork HTTP room.show failed: gateway answered HTTP 502, text/html without an RPC response', { retryable: true });
  const clockDeps = () => {
    let clock = 0;
    return { now: () => clock, sleep: async (ms: number) => { clock += ms; }, get clock() { return clock; } };
  };

  it('waits read-only through a Cowork upstream still starting, then lets the attempt run', async () => {
    const dir = member();
    const c = clockDeps();
    const calls: Array<[string, string | undefined]> = [];
    const log = vi.fn();
    const result = await waitForTaskRoomManagement('M', {
      showRoom: async (id, env) => { calls.push([id, env.OURS_CONFIG]); if (calls.length <= 6) throw unavailable(); return {}; },
      now: c.now, sleep: c.sleep, log, env: { OURS_CONFIG: '/service/profile.json' },
    });
    expect(result).toBe('ready');
    expect(calls).toHaveLength(7);
    expect(calls.every(([id, cfg]) => id === room && cfg === '/role/profile.json')).toBe(true);
    expect(c.clock).toBe(6 * STARTUP_RETRY_MS);
    expect(log).toHaveBeenCalledTimes(2);   // one wait line, one ready line
    expect(readFileSync(join(dir, '.restart-ledger.json'), 'utf8')).toBe('{"consecutiveImmediateFailures":4}\n');
  });

  it('bounds persistent unavailability so the restart budget still applies', async () => {
    member();
    const c = clockDeps();
    const showRoom = vi.fn(async () => { throw unavailable(); });
    const log = vi.fn();
    expect(await waitForTaskRoomManagement('M', { showRoom, now: c.now, sleep: c.sleep, log })).toBe('unavailable');
    expect(c.clock).toBeLessThanOrEqual(STARTUP_WAIT_MS);
    expect(c.clock).toBeGreaterThan(STARTUP_WAIT_MS - 2 * STARTUP_RETRY_MS);
    expect(log.mock.calls.at(-1)?.[0]).toContain('starting the attempt so the restart budget applies');
  });

  it.each([
    ['malformed 200', new CoworkProtocolError('room.show', 'server returned malformed JSON (HTTP 200, text/html)')],
    ['credential rejected', new CoworkProtocolError('room.show', 'server credential was rejected', 'unauthorized')],
    ['selection mismatch', new CoworkUnavailableError('Cowork HTTP room.show failed during server verification (transport_error)')],
  ])('does not wait on a terminal or invalid response: %s', async (_label, error) => {
    member();
    const c = clockDeps();
    const showRoom = vi.fn(async () => { throw error; });
    expect(await waitForTaskRoomManagement('M', { showRoom, now: c.now, sleep: c.sleep, log: () => {} })).toBe('deferred');
    expect(showRoom).toHaveBeenCalledTimes(1);
    expect(c.clock).toBe(0);
  });

  it('stops waiting when the supervisor is asked to stop', async () => {
    member();
    const c = clockDeps();
    let polls = 0;
    expect(await waitForTaskRoomManagement('M', {
      showRoom: async () => { throw unavailable(); }, now: c.now, sleep: c.sleep, log: () => {},
      shouldStop: () => ++polls > 2,
    })).toBe('unavailable');
    expect(c.clock).toBe(STARTUP_RETRY_MS);   // checked after the failure and after the sleep
  });

  it('caps each probe to the remaining budget so slow timeouts cannot extend the wait', async () => {
    member();
    const c = clockDeps();
    const timeouts: number[] = [];
    // Every probe hangs until its own timeout, as a half-started gateway can.
    const showRoom = vi.fn(async (_id: string, _env: NodeJS.ProcessEnv, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      await c.sleep(timeoutMs);
      throw new CoworkUnavailableError('Cowork HTTP room.show failed during management response (timeout)', { retryable: true });
    });
    expect(await waitForTaskRoomManagement('M', { showRoom, now: c.now, sleep: c.sleep, log: () => {} })).toBe('unavailable');
    expect(c.clock).toBeLessThanOrEqual(STARTUP_WAIT_MS);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(ROOM_PROBE_TIMEOUT_MS);
  });

  it('a member without a room has nothing to wait for', async () => {
    member(false);
    const showRoom = vi.fn();
    expect(await waitForTaskRoomManagement('M', { showRoom })).toBe('not-required');
    expect(showRoom).not.toHaveBeenCalled();
  });
});
