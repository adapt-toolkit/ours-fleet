import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Cross-process file protection: a lock, and a replace that cannot leave a
 * partial file behind.
 *
 * Shared state written with plain `readFileSync` → mutate → `writeFileSync` has
 * two failure modes that only appear under concurrency, which is exactly the
 * condition a fleet creates: two starts interleave and one silently discards
 * the other's entry, or a crash mid-write truncates the last good file.
 */

export interface LockDeps {
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

const DEFAULT_STALE_MS = 10_000;
const POLL_MS = 25;

/**
 * Run `fn` holding a cross-process lock. `mkdir` is atomic on every platform we
 * support, so the directory's existence IS the lock; the timestamp inside lets a
 * crashed holder's lock be broken rather than deadlocking the fleet forever.
 * Same strategy as the runner's launch gate, factored out so both use one.
 *
 * The lock is always released, including when `fn` throws.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  deps: LockDeps = {},
  staleMs: number = DEFAULT_STALE_MS,
): Promise<T> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => { setTimeout(r, ms); }));
  const stampPath = join(lockPath, 'ts');
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let waited = 0; ;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(stampPath, String(now()));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let held: number | null = null;
      try {
        const n = parseInt(readFileSync(stampPath, 'utf8').trim(), 10);
        held = Number.isFinite(n) ? n : null;
      } catch { /* holder died between mkdir and stamp */ }
      if ((held !== null && now() - held > staleMs) || waited > staleMs * 2) {
        rmSync(lockPath, { recursive: true, force: true });   // break a dead holder's lock
        continue;
      }
      await sleep(POLL_MS);
      waited += POLL_MS;
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Replace a file's contents atomically: write a temp file in the SAME directory
 * (so the rename cannot cross a filesystem boundary), fsync it, then rename over
 * the target. A reader either sees the old file or the new one — never a
 * half-written one — and an interrupted write leaves the previous contents
 * intact.
 */
export function replaceFileAtomically(path: string, contents: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);            // the bytes are on disk before anything points at them
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // Best-effort: make the rename itself durable. Not supported everywhere.
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* platform does not allow fsync on a directory */ }
}
