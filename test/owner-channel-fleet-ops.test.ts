import { afterEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => child);

import { fleetCliOps } from '../src/owner-channel/commands.js';

describe('supervisor-independent owner close workers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    child.execFile.mockReset();
    child.spawn.mockReset();
  });

  it('launches task settle in a transient unit with only allowlisted environment', async () => {
    const previousHome = process.env.OURS_FLEET_HOME;
    const previousSecret = process.env.FLEET_TEST_UNRELATED_SECRET;
    process.env.OURS_FLEET_HOME = '/tmp/fleet-test-home';
    process.env.FLEET_TEST_UNRELATED_SECRET = 'must-not-be-inherited';
    child.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
    try {
      await fleetCliOps('RetiringMember', '/tmp/fleet.yaml').settleTask('task-123');
    } finally {
      if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
      else process.env.OURS_FLEET_HOME = previousHome;
      if (previousSecret === undefined) delete process.env.FLEET_TEST_UNRELATED_SECRET;
      else process.env.FLEET_TEST_UNRELATED_SECRET = previousSecret;
    }

    expect(child.execFile).toHaveBeenCalledOnce();
    const [executable, args] = child.execFile.mock.calls[0] as [string, string[]];
    expect(executable).toBe('systemd-run');
    expect(args).toEqual(expect.arrayContaining([
      '--user', '--quiet', '--collect', '--property=Type=exec',
      '--property=KillMode=control-group', process.execPath, process.argv[1],
      'task', '_settle', 'task-123', '-c', '/tmp/fleet.yaml',
      '--setenv=OURS_FLEET_HOME=/tmp/fleet-test-home',
    ]));
    expect(args.some(value => value.includes('FLEET_TEST_UNRELATED_SECRET'))).toBe(false);
    expect(args.some(value => value.includes('OURS_FLEET_SUPERVISOR'))).toBe(false);
    expect(args.some(value => value.includes('CODEX_THREAD_ID'))).toBe(false);
  });
});
