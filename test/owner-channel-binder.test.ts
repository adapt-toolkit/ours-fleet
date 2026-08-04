import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireOwnerBinderLease, OwnerBinderConflictError, OwnerBinderHandoffTimeoutError,
  type OwnerBinderLease,
} from '../src/owner-channel/binder.js';

const dirs: string[] = [];
const makeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-owner-binder-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('owner-channel binder handoff', () => {
  it('waits for the exact live predecessor and acquires only after clean release', async () => {
    const dir = makeDir();
    let clock = 0;
    let first!: OwnerBinderLease;
    const deps = {
      now: () => clock,
      alive: () => true,
      processMarker: () => 'same-process-start',
      sleep: async (ms: number) => { clock += ms; if (clock >= 100) first.release(); },
    };
    first = await acquireOwnerBinderLease(dir, 'Coordinator', 'Coordinator-Channel', deps);
    const second = await acquireOwnerBinderLease(
      dir, 'Coordinator', 'Coordinator-Channel', deps, 500);

    expect(clock).toBe(100);
    expect(second.inherited).toBe(true);
    expect(existsSync(join(dir, '.owner-channel-binder.lock', 'owner.json'))).toBe(true);
    second.release();
    expect(existsSync(join(dir, '.owner-channel-binder.lock'))).toBe(false);
  });

  it('bounds overlap and leaves a live predecessor untouched', async () => {
    const dir = makeDir();
    let clock = 0;
    const deps = {
      now: () => clock,
      alive: () => true,
      processMarker: () => 'live',
      sleep: async (ms: number) => { clock += ms; },
    };
    const first = await acquireOwnerBinderLease(dir, 'Coordinator', 'Coordinator-Channel', deps);
    await expect(acquireOwnerBinderLease(
      dir, 'Coordinator', 'Coordinator-Channel', deps, 150))
      .rejects.toBeInstanceOf(OwnerBinderHandoffTimeoutError);
    expect(existsSync(join(dir, '.owner-channel-binder.lock'))).toBe(true);
    first.release();
  });

  it('reclaims a demonstrably stale predecessor without force binding', async () => {
    const dir = makeDir();
    const lock = join(dir, '.owner-channel-binder.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      version: 1, role: 'Coordinator', identity: 'Coordinator-Channel', pid: 424242,
      marker: 'old-start', instance: 'old-instance', acquiredAt: 1,
    }));
    const lease = await acquireOwnerBinderLease(dir, 'Coordinator', 'Coordinator-Channel', {
      alive: () => false, processMarker: () => undefined,
    });
    expect(lease.inherited).toBe(true);
    expect(readFileSync(join(lock, 'owner.json'), 'utf8')).not.toContain('old-instance');
    lease.release();
  });

  it('refuses a foreign holder and unverifiable ownership fail-closed', async () => {
    const foreignDir = makeDir();
    const foreignLock = join(foreignDir, '.owner-channel-binder.lock');
    mkdirSync(foreignLock);
    writeFileSync(join(foreignLock, 'owner.json'), JSON.stringify({
      version: 1, role: 'OtherRole', identity: 'Coordinator-Channel', pid: process.pid,
      instance: 'foreign', acquiredAt: 1,
    }));
    await expect(acquireOwnerBinderLease(
      foreignDir, 'Coordinator', 'Coordinator-Channel'))
      .rejects.toBeInstanceOf(OwnerBinderConflictError);

    const corruptDir = makeDir();
    mkdirSync(join(corruptDir, '.owner-channel-binder.lock'));
    writeFileSync(join(corruptDir, '.owner-channel-binder.lock', 'owner.json'), '{');
    let clock = 0;
    await expect(acquireOwnerBinderLease(corruptDir, 'Coordinator', 'Coordinator-Channel', {
      now: () => clock, sleep: async ms => { clock += ms; },
    })).rejects.toThrow(/cannot be verified safely/);
  });
});
