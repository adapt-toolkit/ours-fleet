import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatRunId, writeReport, listRuns, readReport, latestReport, pruneReports,
  watchdogDir, reportsDir, acquireRunLock, releaseRunLock, readRunLockOwner, reclaimStaleRunLock,
  RUN_LOCK_OWNER_GRACE_MS,
} from '../src/watchdog/store.js';
import { errorReport } from '../src/watchdog/report.js';

/** A pid that is guaranteed dead: spawnSync blocks until the child has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-')); process.env.OURS_FLEET_HOME = dir; });
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(dir, { recursive: true, force: true }); });

const rpt = (runId: string) => errorReport({
  watchdog: 'w', run_id: runId, started_at: runId, finished_at: runId, error: 'x',
});

describe('watchdog store', () => {
  it('formats run ids in lexical-chronological UTC form', () => {
    expect(formatRunId(new Date('2026-07-31T11:50:00Z'))).toBe('20260731T115000Z');
  });
  it('writes 0600 files in 0700 dirs and round-trips', () => {
    const p = writeReport('w', rpt('20260731T115000Z'));
    expect((statSync(p).mode & 0o777)).toBe(0o600);
    expect((statSync(watchdogDir('w')).mode & 0o777)).toBe(0o700);
    expect((statSync(reportsDir('w')).mode & 0o777)).toBe(0o700);
    expect(readReport('w', '20260731T115000Z')!.run_id).toBe('20260731T115000Z');
  });
  it('lists newest first and latestReport picks the newest', () => {
    for (const id of ['20260731T115000Z', '20260731T120000Z', '20260731T110000Z'])
      writeReport('w', rpt(id));
    expect(listRuns('w').map(r => r.runId))
      .toEqual(['20260731T120000Z', '20260731T115000Z', '20260731T110000Z']);
    expect(latestReport('w')!.run_id).toBe('20260731T120000Z');
  });
  it('prunes to keep_reports, oldest first (acceptance 8)', () => {
    for (let i = 0; i < 6; i++) writeReport('w', rpt(`20260731T11000${i}Z`));
    expect(pruneReports('w', 4)).toBe(2);
    expect(listRuns('w')).toHaveLength(4);
    expect(listRuns('w').at(-1)!.runId).toBe('20260731T110002Z');
  });
  it('tolerates a corrupt report file in listing (status error, no throw)', () => {
    writeFileSync(join(reportsDir('w'), '20260731T110009Z.json'), '{nope');
    const entry = listRuns('w').find(r => r.runId === '20260731T110009Z')!;
    expect(entry.status).toBe('error');
    expect(readReport('w', '20260731T110009Z')).toBeUndefined();
  });
  it('readReport refuses path traversal in runId', () => {
    expect(readReport('w', '../../../etc/passwd')).toBeUndefined();
  });
  it('acquireRunLock is a mutex: second acquire fails until released', () => {
    expect(acquireRunLock('w')).toBe(true);
    expect(acquireRunLock('w')).toBe(false);
    releaseRunLock('w');
    expect(acquireRunLock('w')).toBe(true);
    releaseRunLock('w');
  });
  it('releaseRunLock tolerates a missing lock', () => {
    expect(() => releaseRunLock('w')).not.toThrow();
  });
  it('releaseRunLock rethrows a non-ENOENT failure instead of masking it as "already gone"', () => {
    // Recursive rm now happily deletes a non-empty lock dir (it must, to clear
    // owner.json alongside the mkdir mutex — finding #2), so ENOTEMPTY can no
    // longer be forced this way. Force a real permission failure instead: no
    // write permission on the lock dir means its child (owner.json) can't be
    // unlinked.
    acquireRunLock('w');
    const lockDir = join(watchdogDir('w'), '.run-lock');
    chmodSync(lockDir, 0o500);
    try {
      expect(() => releaseRunLock('w')).toThrow();
    } finally {
      chmodSync(lockDir, 0o700);   // restore so afterEach's recursive cleanup can proceed
    }
  });

  describe('run lock ownership (finding #2)', () => {
    it('acquireRunLock stamps owner.json with our own pid', () => {
      acquireRunLock('w');
      expect(readRunLockOwner('w')).toMatchObject({ pid: process.pid });
      releaseRunLock('w');
    });

    it('reclaimStaleRunLock leaves a lock held by a live pid (this process) alone', () => {
      acquireRunLock('w');
      expect(reclaimStaleRunLock('w')).toBe(false);
      expect(readRunLockOwner('w')).toMatchObject({ pid: process.pid });   // still there
      releaseRunLock('w');
    });

    it('reclaimStaleRunLock removes a lock whose owner pid is dead', () => {
      const lockDir = join(watchdogDir('w'), '.run-lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));
      expect(reclaimStaleRunLock('w')).toBe(true);
      expect(acquireRunLock('w')).toBe(true);   // lock dir is gone; re-acquirable
      releaseRunLock('w');
    });

    it('reclaimStaleRunLock leaves a fresh ownerless lock alone during the acquisition grace window', () => {
      mkdirSync(join(watchdogDir('w'), '.run-lock'));
      expect(reclaimStaleRunLock('w')).toBe(false);
      expect(acquireRunLock('w')).toBe(false);
      releaseRunLock('w');
    });

    it('reclaimStaleRunLock removes an old legacy lock dir with no owner.json', () => {
      const lockDir = join(watchdogDir('w'), '.run-lock');
      mkdirSync(lockDir);
      const old = new Date(Date.now() - RUN_LOCK_OWNER_GRACE_MS - 1_000);
      utimesSync(lockDir, old, old);
      expect(reclaimStaleRunLock('w')).toBe(true);
      expect(acquireRunLock('w')).toBe(true);
      releaseRunLock('w');
    });

    it('reclaimStaleRunLock is a no-op (returns true) when no lock is held', () => {
      expect(reclaimStaleRunLock('w')).toBe(true);
    });

    it('owner.json is present the instant acquire returns, with no leaked temp file (TOCTOU close, review polish)', () => {
      // The narrow race this closes (a reclaimStaleRunLock landing between mkdir
      // and the owner.json write) isn't directly triggerable from a synchronous
      // unit test — acquireRunLock is one synchronous call, so there's no seam to
      // interleave another call into. What IS directly assertable: the moment
      // acquireRunLock returns, owner.json already exists (never a later, separate
      // write the caller has to wait for), and the per-pid temp file used to close
      // the window is gone rather than left behind.
      expect(acquireRunLock('w')).toBe(true);
      expect(readRunLockOwner('w')).toMatchObject({ pid: process.pid });
      expect(readdirSync(join(watchdogDir('w'), '.run-lock'))).toEqual(['owner.json']);
      expect(readdirSync(watchdogDir('w')).some(f => f.startsWith('.owner.'))).toBe(false);
      releaseRunLock('w');
    });

    it('cleans up its temp owner file when it loses the mkdir race (EEXIST)', () => {
      acquireRunLock('w');   // holds the real lock
      expect(acquireRunLock('w')).toBe(false);   // loses the race: EEXIST path
      // No stray .owner.<pid>.tmp left in watchdogDir('w') from the failed attempt.
      expect(readdirSync(watchdogDir('w')).some(f => f.startsWith('.owner.'))).toBe(false);
      releaseRunLock('w');
    });
  });

  describe('watchdogDir path traversal (finding #1)', () => {
    it('rejects a traversal-shaped name before any fs effect', () => {
      expect(() => watchdogDir('../x')).toThrow();
    });
    it('rejects other non-conforming names (path separator, empty)', () => {
      expect(() => watchdogDir('a/b')).toThrow();
      expect(() => watchdogDir('')).toThrow();
    });
  });
});
