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
  /** Test hook after a complete private claim is prepared, before atomic publication. */
  beforePublish?(): void | Promise<void>;
}

/** The syscalls a replace depends on, injectable so faults can be forced deterministically. */
export interface WriteDeps {
  writeSync?(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync?(fd: number): void;
  closeSync?(fd: number): void;
}

const DEFAULT_STALE_MS = 10_000;
const POLL_MS = 25;

/**
 * Run `fn` holding a cross-process lock. A fully populated private claim directory
 * is atomically renamed to the canonical path, so contenders never observe partial
 * ownership metadata; its timestamp lets a crashed holder be reclaimed safely.
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
  const ownerPath = join(lockPath, 'owner.json');
  const token = randomUUID();
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let waited = 0; ;) {
    const claimPath = `${lockPath}.claim.${process.pid}.${randomUUID()}`;
    try {
      mkdirSync(claimPath);
      writeFileSync(join(claimPath, 'ts'), String(now()));
      writeFileSync(join(claimPath, 'owner.json'), JSON.stringify({ token, pid: process.pid }));
      await deps.beforePublish?.();
      renameSync(claimPath, lockPath);
      break;
    } catch (e) {
      rmSync(claimPath, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      let held: number | null = null;
      try {
        const n = parseInt(readFileSync(stampPath, 'utf8').trim(), 10);
        held = Number.isFinite(n) ? n : null;
      } catch { /* holder died between mkdir and stamp */ }
      let ownerAlive = false;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number };
        if (typeof owner.pid === 'number') {
          try { process.kill(owner.pid, 0); ownerAlive = true; } catch { /* dead owner */ }
        }
      } catch { /* legacy or incomplete lock */ }
      if (!ownerAlive && ((held !== null && now() - held > staleMs) || waited > staleMs * 2)) {
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
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
      if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
    } catch { /* never remove a lock whose ownership cannot be proved */ }
  }
}

/**
 * Replace a file's contents atomically: write a temp file in the SAME directory
 * (so the rename cannot cross a filesystem boundary), fsync it, then rename over
 * the target. A reader either sees the old file or the new one — never a
 * half-written one — and an interrupted write leaves the previous contents
 * intact.
 */
export function replaceFileAtomically(path: string, contents: string, mode = 0o600, deps: WriteDeps = {}): void {
  const write = deps.writeSync ?? writeSync;
  const fsync = deps.fsyncSync ?? fsyncSync;
  const close = deps.closeSync ?? closeSync;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  let closed = false;
  try {
    const buffer = Buffer.from(contents, 'utf8');
    // A single writeSync is not a guarantee: the kernel may stop short, and a
    // truncated temp renamed over the target is silent data loss.
    for (let written = 0; written < buffer.length;) {
      const advanced = write(fd, buffer, written, buffer.length - written);
      // A write that accepts nothing would spin forever; fail instead.
      if (advanced <= 0) throw new Error(`write made no progress at byte ${written} of ${buffer.length}`);
      written += advanced;
    }
    fsync(fd);                // the bytes are on disk before anything points at them
    close(fd);                // a temp we could not close cleanly is not publishable
    closed = true;
  } catch (e) {
    // Cleanup must not mask why we are here: the original failure is what the
    // caller needs, and a temp we could not finish must never be renamed over
    // the last good file nor left occupying space on a disk that may be full.
    if (!closed) { try { close(fd); } catch { /* already failing */ } }
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
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
