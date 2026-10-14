import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDir } from '../src/paths.js';
import { writeV2Fixture } from './v2-fixture.js';
import { waitForRoleDaemon, STARTUP_WAIT_MS } from '../src/startup-readiness.js';
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
