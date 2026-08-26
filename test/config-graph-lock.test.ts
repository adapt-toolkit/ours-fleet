import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigGraphLockCleanupError, ConfigGraphLockError, configGraphLockPath, probeProcessState,
  withConfigGraphLock,
  type ConfigGraphLockDeps,
} from '../src/config-graph-lock.js';

let directory: string;
let bootstrap: string;
let serial: number;
const alive = new Map<number, string>();

const deps = (pid: number): ConfigGraphLockDeps => {
  const fingerprint = `boot:${pid}:birth`;
  alive.set(pid, fingerprint);
  return {
    processId: () => pid,
    processFingerprint: () => fingerprint,
    processState: (candidate, expected) => {
      const actual = alive.get(candidate);
      return actual === undefined ? 'dead' : actual === expected ? 'same' : 'reused';
    },
    randomUUID: () => `${pid.toString(16).padStart(8, '0')}-${(++serial).toString(16).padStart(8, '0')}`,
  };
};

const options = (pid: number) => ({ timeoutMs: 500, staleMs: 20, pollMs: 1, deps: deps(pid) });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let count = 0; count < 200 && !predicate(); count++)
    await new Promise<void>(done => setTimeout(done, 1));
  expect(predicate()).toBe(true);
};
const owner = (pid: number, fingerprint: string, token = 'deadbeef', createdAt = 0) =>
  ({ schema: 1, token, pid, fingerprint, createdAt });
const lease = (path: string, value: ReturnType<typeof owner>): void => {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fleet-graph-lock-'));
  bootstrap = join(directory, 'fleet.yaml');
  writeFileSync(bootstrap, 'schema_version: 2\n');
  serial = 0;
  alive.clear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('config graph shared/exclusive lock', () => {
  it('places the lock beside the canonical bootstrap', () => {
    expect(configGraphLockPath(join(directory, '.', 'fleet.yaml'))).toBe(`${bootstrap}.graph-lock`);
  });

  it('rejects invalid modes, timing, and injected owner identities', async () => {
    await expect(withConfigGraphLock(bootstrap, 'bad' as 'shared', () => undefined, options(1)))
      .rejects.toThrow(/invalid graph lock mode/u);
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, { ...options(2), pollMs: 0 }))
      .rejects.toThrow(/positive integers/u);
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, {
      ...options(3), deps: { ...deps(3), randomUUID: () => '../escape' },
    })).rejects.toThrow(/invalid local graph lock owner/u);
  });

  it('clamps retry sleeps to the remaining acquisition deadline', async () => {
    const root = configGraphLockPath(bootstrap);
    mkdirSync(join(root, 'gate'), { recursive: true, mode: 0o700 });
    chmodSync(join(root, 'gate'), 0o700);
    lease(join(root, 'gate', 'owner.json'), owner(50, 'live'));
    let clock = 0;
    const waits: number[] = [];
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, {
      timeoutMs: 10, staleMs: 20, pollMs: 60_000,
      deps: {
        ...deps(51), now: () => clock, processState: () => 'same',
        sleep: async ms => { waits.push(ms); clock += ms; },
      },
    })).rejects.toThrow(/timed out/u);
    expect(waits).toEqual([10]);
  });

  it('allows overlapping readers', async () => {
    const release = deferred();
    const entered: number[] = [];
    const first = withConfigGraphLock(bootstrap, 'shared', async () => {
      entered.push(1); await release.promise;
    }, options(101));
    const second = withConfigGraphLock(bootstrap, 'shared', async () => {
      entered.push(2); await release.promise;
    }, options(102));
    await waitFor(() => entered.length === 2);
    release.resolve();
    await Promise.all([first, second]);
  });

  it('keeps incomplete private gate initialization invisible to another owner', async () => {
    const resumeFirst = deferred();
    let tempVisible = false;
    let secondEntered = false;
    const firstOptions = options(111);
    firstOptions.deps.afterGateTempCreated = async () => {
      tempVisible = true;
      await resumeFirst.promise;
    };
    const first = withConfigGraphLock(bootstrap, 'shared', () => undefined, firstOptions);
    await waitFor(() => tempVisible);
    await withConfigGraphLock(bootstrap, 'shared', () => { secondEntered = true; }, options(112));
    expect(secondEntered).toBe(true);
    resumeFirst.resolve();
    await first;
  });

  it('publishes writer intent, drains readers, and blocks later readers', async () => {
    const releaseReader = deferred();
    const releaseWriter = deferred();
    const order: string[] = [];
    const first = withConfigGraphLock(bootstrap, 'shared', async () => {
      order.push('reader-1'); await releaseReader.promise;
    }, options(201));
    await waitFor(() => order.length === 1);
    const writer = withConfigGraphLock(bootstrap, 'exclusive', async () => {
      order.push('writer'); await releaseWriter.promise;
    }, options(202));
    await waitFor(() => readdirSync(configGraphLockPath(bootstrap)).includes('writer-intent.json'));
    const late = withConfigGraphLock(bootstrap, 'shared', () => { order.push('reader-2'); }, options(203));
    await new Promise<void>(done => setTimeout(done, 10));
    expect(order).toEqual(['reader-1']);
    releaseReader.resolve();
    await waitFor(() => order.includes('writer'));
    expect(order).toEqual(['reader-1', 'writer']);
    releaseWriter.resolve();
    await Promise.all([first, writer, late]);
    expect(order).toEqual(['reader-1', 'writer', 'reader-2']);
  });

  it('removes its writer intent when aborted during reader drain', async () => {
    const release = deferred();
    const reader = withConfigGraphLock(bootstrap, 'shared', () => release.promise, options(301));
    await waitFor(() => readdirSync(join(configGraphLockPath(bootstrap), 'readers')).length === 1);
    const controller = new AbortController();
    const writer = withConfigGraphLock(bootstrap, 'exclusive', () => undefined, {
      ...options(302), signal: controller.signal,
    });
    await waitFor(() => readdirSync(configGraphLockPath(bootstrap)).includes('writer-intent.json'));
    controller.abort();
    await expect(writer).rejects.toThrow(/aborted/u);
    expect(readdirSync(configGraphLockPath(bootstrap))).not.toContain('writer-intent.json');
    release.resolve();
    await reader;
  });

  it('settles abort cleanup without waiting for an unrelated live gate', async () => {
    const release = deferred();
    const reader = withConfigGraphLock(bootstrap, 'shared', () => release.promise, options(305));
    await waitFor(() => readdirSync(join(configGraphLockPath(bootstrap), 'readers')).length === 1);
    const controller = new AbortController();
    const writer = withConfigGraphLock(bootstrap, 'exclusive', () => undefined, {
      ...options(306), signal: controller.signal,
    });
    const root = configGraphLockPath(bootstrap);
    await waitFor(() => readdirSync(root).includes('writer-intent.json'));
    mkdirSync(join(root, 'gate'), { mode: 0o700 });
    chmodSync(join(root, 'gate'), 0o700);
    lease(join(root, 'gate', 'owner.json'), owner(999, 'live', 'feedface', Date.now()));
    alive.set(999, 'live');
    controller.abort();
    await expect(Promise.race([
      writer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup hung')), 100)),
    ])).rejects.toThrow(/aborted/u);
    expect(readdirSync(root)).not.toContain('writer-intent.json');
    release.resolve();
    await reader;
  });

  it('removes its writer intent on timeout and lets a competing writer proceed', async () => {
    const releaseReader = deferred();
    const reader = withConfigGraphLock(bootstrap, 'shared', () => releaseReader.promise, options(311));
    await waitFor(() => readdirSync(join(configGraphLockPath(bootstrap), 'readers')).length === 1);
    const timed = withConfigGraphLock(bootstrap, 'exclusive', () => undefined, {
      ...options(312), timeoutMs: 15,
    });
    await expect(timed).rejects.toThrow(/timed out/u);
    expect(readdirSync(configGraphLockPath(bootstrap))).not.toContain('writer-intent.json');
    const entered = deferred();
    const next = withConfigGraphLock(bootstrap, 'exclusive', () => { entered.resolve(); }, options(313));
    releaseReader.resolve();
    await reader;
    await entered.promise;
    await next;
  });

  it('serializes competing writers by their distinct owner leases', async () => {
    const release = deferred();
    const order: number[] = [];
    const first = withConfigGraphLock(bootstrap, 'exclusive', async () => {
      order.push(1); await release.promise;
    }, options(321));
    await waitFor(() => order.length === 1);
    const second = withConfigGraphLock(bootstrap, 'exclusive', () => { order.push(2); }, options(322));
    await new Promise<void>(done => setTimeout(done, 10));
    expect(order).toEqual([1]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('cleans caller-owned intent when promotion fails', async () => {
    await expect(withConfigGraphLock(bootstrap, 'exclusive', () => undefined, {
      ...options(331), deps: { ...deps(331), beforePromote: () => { throw new Error('promotion fault'); } },
    })).rejects.toThrow(/promotion fault/u);
    expect(readdirSync(configGraphLockPath(bootstrap))).not.toContain('writer-intent.json');
    await expect(withConfigGraphLock(bootstrap, 'exclusive', () => undefined, {
      ...options(332), deps: { ...deps(332), afterPromoteLink: () => { throw new Error('unlink fault'); } },
    })).rejects.toThrow(/unlink fault/u);
    expect(readdirSync(configGraphLockPath(bootstrap))).not.toContain('writer-intent.json');
    expect(readdirSync(configGraphLockPath(bootstrap))).not.toContain('writer-active.json');
  });

  it('records ownership before post-link faults and normalizes release faults', async () => {
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, {
      ...options(335), deps: { ...deps(335), afterLeaseLink: () => { throw new Error('post-link fault'); } },
    })).rejects.toBeInstanceOf(ConfigGraphLockError);
    expect(readdirSync(join(configGraphLockPath(bootstrap), 'readers'))).toEqual([]);

    const failedRelease = withConfigGraphLock(bootstrap, 'shared', () => undefined, {
      ...options(336), deps: { ...deps(336), beforeReleaseQuarantine: () => { throw new Error('release I/O fault'); } },
    });
    await expect(failedRelease).rejects.toBeInstanceOf(ConfigGraphLockCleanupError);
    expect(readdirSync(join(configGraphLockPath(bootstrap), 'readers'))).toHaveLength(1);
  });

  it('preserves callback errors unchanged', async () => {
    const failure = new Error('caller failure');
    await expect(withConfigGraphLock(bootstrap, 'shared', () => { throw failure; }, options(337)))
      .rejects.toBe(failure);
  });

  it('makes own-absent release idempotent and refuses mismatched ownership', async () => {
    await withConfigGraphLock(bootstrap, 'shared', () => {
      const readers = join(configGraphLockPath(bootstrap), 'readers');
      rmSync(join(readers, readdirSync(readers)[0]));
    }, options(341));

    await expect(withConfigGraphLock(bootstrap, 'shared', () => {
      const readers = join(configGraphLockPath(bootstrap), 'readers');
      const path = join(readers, readdirSync(readers)[0]);
      writeFileSync(path, `${JSON.stringify(owner(999, 'other', 'cafebabe', Date.now()))}\n`);
      chmodSync(path, 0o600);
    }, options(342))).rejects.toThrow(/release ownership mismatch/u);
  });

  it('reclaims stale dead and PID-reused gate owners but never live owners', async () => {
    const root = configGraphLockPath(bootstrap);
    const gateLease = (value: ReturnType<typeof owner>) => {
      mkdirSync(join(root, 'gate'), { mode: 0o700, recursive: true });
      chmodSync(join(root, 'gate'), 0o700);
      lease(join(root, 'gate', 'owner.json'), value);
    };
    gateLease(owner(900, 'old-birth'));
    await withConfigGraphLock(bootstrap, 'shared', () => undefined, options(501));

    gateLease(owner(901, 'old-birth'));
    alive.set(901, 'new-birth');
    await withConfigGraphLock(bootstrap, 'shared', () => undefined, options(502));

    gateLease(owner(902, 'live-birth', 'feedface', Date.now()));
    alive.set(902, 'live-birth');
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, {
      ...options(503), timeoutMs: 15,
    })).rejects.toThrow(/timed out/u);
    expect(readdirSync(root)).toContain('gate');
  });

  it('recovers an abandoned private gate initialization only after the stale threshold', async () => {
    const root = configGraphLockPath(bootstrap);
    mkdirSync(root, { recursive: true });
    const claim = join(root, '.gate-tmp.abandoned');
    mkdirSync(claim, { mode: 0o700 });
    chmodSync(claim, 0o700);
    utimesSync(claim, new Date(0), new Date(0));
    await withConfigGraphLock(bootstrap, 'shared', () => undefined, options(511));
    expect(readdirSync(root)).not.toContain('.gate-tmp.abandoned');
  });

  it('never age-reaps valid live gate, lease, or release private temps', async () => {
    const root = configGraphLockPath(bootstrap);
    const gateTemp = join(root, '.gate-tmp.liveowner');
    mkdirSync(gateTemp, { recursive: true, mode: 0o700 });
    chmodSync(gateTemp, 0o700);
    lease(join(gateTemp, 'owner.json'), owner(810, 'live-birth'));
    const leaseTemp = join(root, '.lease-tmp.liveowner');
    const releaseTemp = join(root, '.release-tmp.liveowner.1');
    lease(leaseTemp, owner(810, 'live-birth'));
    lease(releaseTemp, owner(810, 'live-birth'));
    for (const path of [gateTemp, leaseTemp, releaseTemp]) utimesSync(path, new Date(0), new Date(0));
    alive.set(810, 'live-birth');
    await withConfigGraphLock(bootstrap, 'shared', () => undefined, options(811));
    expect(readdirSync(root)).toEqual(expect.arrayContaining([
      '.gate-tmp.liveowner', '.lease-tmp.liveowner', '.release-tmp.liveowner.1',
    ]));
  });

  it('reclaims stale reader and active-writer leases with reused process identities', async () => {
    const root = configGraphLockPath(bootstrap);
    lease(join(root, 'readers', 'deadbeef.json'), owner(930, 'old'));
    lease(join(root, 'writer-active.json'), owner(931, 'old', 'facefeed'));
    alive.set(930, 'new');
    alive.set(931, 'new');
    await withConfigGraphLock(bootstrap, 'shared', () => undefined, options(532));
    expect(readdirSync(join(root, 'readers'))).toEqual([]);
    expect(readdirSync(root)).not.toContain('writer-active.json');
  });

  it('fails closed when owner liveness is unknown and treats EPERM as alive', async () => {
    const root = configGraphLockPath(bootstrap);
    mkdirSync(join(root, 'gate'), { mode: 0o700, recursive: true });
    lease(join(root, 'gate', 'owner.json'), owner(920, 'birth'));
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, {
      ...options(521), deps: { ...deps(521), processState: () => 'unknown' },
    })).rejects.toThrow(/liveness cannot be proven/u);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error;
    });
    expect(probeProcessState(920, 'birth')).toBe('same');
    kill.mockRestore();
  });

  it('rejects symlinked lock parents and malformed or oversized leases', async () => {
    const real = join(directory, 'real');
    mkdirSync(real);
    const linked = join(directory, 'linked');
    symlinkSync(real, linked);
    await expect(withConfigGraphLock(join(linked, 'fleet.yaml'), 'shared', () => undefined, options(401)))
      .rejects.toThrow(/symlink lock path component/u);

    const root = configGraphLockPath(bootstrap);
    mkdirSync(join(root, 'readers'), { recursive: true });
    writeFileSync(join(root, 'readers', 'deadbeef.json'), '{}', { mode: 0o600 });
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, options(402)))
      .rejects.toBeInstanceOf(ConfigGraphLockError);
  });

  it('rejects symlinked, oversized, and permissively-mode metadata', async () => {
    const root = configGraphLockPath(bootstrap);
    mkdirSync(join(root, 'readers'), { recursive: true });
    const outside = join(directory, 'outside.json');
    writeFileSync(outside, `${JSON.stringify(owner(700, 'birth'))}\n`, { mode: 0o600 });
    symlinkSync(outside, join(root, 'readers', 'deadbeef.json'));
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, options(701)))
      .rejects.toThrow(/securely open lock metadata/u);
    rmSync(join(root, 'readers', 'deadbeef.json'));

    writeFileSync(join(root, 'readers', 'deadbeef.json'), 'x'.repeat(4097), { mode: 0o600 });
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, options(702)))
      .rejects.toThrow(/oversized lock metadata/u);
    rmSync(join(root, 'readers', 'deadbeef.json'));

    writeFileSync(join(root, 'readers', 'deadbeef.json'), `${JSON.stringify(owner(703, 'birth'))}\n`, { mode: 0o644 });
    chmodSync(join(root, 'readers', 'deadbeef.json'), 0o644);
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, options(703)))
      .rejects.toThrow(/unsafe or oversized lock metadata/u);
  });

  it('rejects a symlink substituted for the gate', async () => {
    const root = configGraphLockPath(bootstrap);
    mkdirSync(root, { recursive: true });
    const outside = join(directory, 'outside-gate');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'gate'));
    await expect(withConfigGraphLock(bootstrap, 'shared', () => undefined, options(711)))
      .rejects.toThrow(/unsafe graph lock gate/u);
  });
});
