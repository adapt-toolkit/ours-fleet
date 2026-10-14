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

  it.each(['linux', 'darwin'])('launches task settle on %s with only allowlisted environment', async platform => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
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
      Object.defineProperty(process, 'platform', originalPlatform);
      if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
      else process.env.OURS_FLEET_HOME = previousHome;
      if (previousSecret === undefined) delete process.env.FLEET_TEST_UNRELATED_SECRET;
      else process.env.FLEET_TEST_UNRELATED_SECRET = previousSecret;
    }

    expect(child.execFile).toHaveBeenCalledOnce();
    const [executable, args] = child.execFile.mock.calls[0] as [string, string[]];
    expect(executable).toBe(platform === 'linux' ? 'systemd-run' : 'launchctl');
    expect(args).toEqual(expect.arrayContaining([
      ...(platform === 'linux'
        ? ['--user', '--quiet', '--collect', '--property=Type=exec', '--property=KillMode=control-group', '--setenv=OURS_FLEET_HOME=/tmp/fleet-test-home']
        : ['submit', '-l', '--', '/usr/bin/env', 'OURS_FLEET_HOME=/tmp/fleet-test-home']),
      process.execPath, process.argv[1], 'task', '_settle', 'task-123', '-c', '/tmp/fleet.yaml',
    ]));
    expect(args.some(value => value.includes('FLEET_TEST_UNRELATED_SECRET'))).toBe(false);
    expect(args.some(value => value.includes('OURS_FLEET_SUPERVISOR'))).toBe(false);
    expect(args.some(value => value.includes('CODEX_THREAD_ID'))).toBe(false);
  });

  it('routes Owner provisioning continuation through the durable provisioning worker', async () => {
    child.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
    await fleetCliOps('RetiringMember', '/tmp/fleet.yaml').provisionTask('task-123');
    const args = child.execFile.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      process.execPath, process.argv[1], 'task', '_provision', 'task-123', '-c', '/tmp/fleet.yaml',
    ]));
    expect(args).not.toContain('_recover');
  });
});
