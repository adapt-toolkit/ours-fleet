import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  incarnationEnded, procIncarnationProbe, processIncarnation, type IncarnationProbe, type ProcessIncarnation,
} from './process-incarnation.js';

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
  /** Test seam for PID liveness; defaults to signal 0. */
  alive?(pid: number): boolean;
  /** Test seam for boot id and process start markers. */
  incarnation?: IncarnationProbe;
  /** Test hook inside the reclaim section, before the dead holder is re-read. */
  beforeReclaim?(): void;
}

/**
 * A live holder recorded without process-incarnation markers by a release that
 * predates them. Its PID may be reused, so the lock can be neither trusted nor
 * removed; the caller fails with the path instead of waiting forever.
 */
export class FileLockOwnerUnverifiableError extends Error {
  constructor(readonly lockPath: string, readonly pid: number) {
    super(`lock ${lockPath} is held by PID ${pid}, recorded without a boot or start marker by an older `
      + 'release, so it can be neither trusted nor proved stale; it was left in place. Inspect PID '
      + `${pid}: the lock may be removed only once that process is proved not to be the Fleet process `
      + 'that wrote it.');
  }
}

/** The syscalls a replace depends on, injectable so faults can be forced deterministically. */
export interface WriteDeps {
  writeSync?(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync?(fd: number): void;
  closeSync?(fd: number): void;
  /** Directory fsync used by `durable` replaces; injectable for fault tests. */
  fsyncDirectory?(dir: string): void;
}

export interface ReplaceOptions {
  /**
   * Fail closed unless the rename itself is known durable. Callers whose
   * recovery treats the previous contents as proof that something did NOT
   * happen need this: a host crash that rolls the rename back would otherwise
   * resurrect a state the process had already moved past.
   */
  durable?: boolean;
}

function fsyncDirectory(dir: string): void {
  const dirFd = openSync(dir, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

const DEFAULT_STALE_MS = 10_000;
const SYNCHRONOUS_LOCK_TIMEOUT = 'Timed out acquiring synchronous journal lock';
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
  const probe = deps.incarnation ?? procIncarnationProbe;
  const alive = deps.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const stampPath = join(lockPath, 'ts');
  const ownerPath = join(lockPath, 'owner.json');
  const reclaimPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  mkdirSync(dirname(lockPath), { recursive: true });
  /** The exact bytes that identify one holder, so a reclaim never removes its successor. */
  const holder = (): string | null => {
    let owner = '', stamp = '';
    try { owner = readFileSync(ownerPath, 'utf8'); } catch { /* legacy or incomplete lock */ }
    try { stamp = readFileSync(stampPath, 'utf8'); } catch { /* holder died between mkdir and stamp */ }
    return owner || stamp ? `${stamp}\0${owner}` : null;
  };

  for (let waited = 0; ;) {
    const claimPath = `${lockPath}.claim.${process.pid}.${randomUUID()}`;
    try {
      mkdirSync(claimPath);
      writeFileSync(join(claimPath, 'ts'), String(now()));
      writeFileSync(join(claimPath, 'owner.json'), JSON.stringify({
        token, pid: process.pid, ...processIncarnation(process.pid, probe),
      }));
      await deps.beforePublish?.();
      renameSync(claimPath, lockPath);
      break;
    } catch (e) {
      rmSync(claimPath, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      const observed = holder();
      let held: number | null = null;
      try {
        const n = parseInt(readFileSync(stampPath, 'utf8').trim(), 10);
        held = Number.isFinite(n) ? n : null;
      } catch { /* holder died between mkdir and stamp */ }
      let ownerAlive = false;
      let unverifiable: number | undefined;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number } & ProcessIncarnation;
        // A reused PID is not the holder: a lock written before a reboot, or by
        // a process that has since exited, must not block every later caller.
        if (typeof owner.pid === 'number') {
          ownerAlive = alive(owner.pid) && !incarnationEnded(owner.pid, owner, probe);
          if (ownerAlive && owner.boot === undefined && owner.start === undefined && probe.bootId())
            unverifiable = owner.pid;
        }
      } catch { /* legacy or incomplete lock */ }
      const expired = (held !== null && now() - held > staleMs) || waited > staleMs * 2;
      if (!ownerAlive && expired && reclaimDeadHolder(reclaimPath, lockPath, observed, holder, deps)) continue;
      if (unverifiable !== undefined && expired && waited > staleMs * 2)
        throw new FileLockOwnerUnverifiableError(lockPath, unverifiable);
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
 * Remove a dead holder's lock only while it is still that holder's. Contenders
 * that observed the same dead holder serialize through a bakery lock, whose
 * claims are per-process files removed only when their process is provably
 * gone, never by age. Inside it the holder is re-read, so a reclaimer that was
 * descheduled after observing the dead holder cannot delete the lock a faster
 * contender has since claimed.
 */
function reclaimDeadHolder(
  reclaimPath: string, lockPath: string, observed: string | null,
  holder: () => string | null, deps: LockDeps,
): boolean {
  try {
    withSynchronousFileLock(reclaimPath, () => {
      deps.beforeReclaim?.();
      if (holder() === observed) rmSync(lockPath, { recursive: true, force: true });
    });
    return true;
  } catch (error) {
    // A live contender stalled inside the section: wait like any other poll.
    if (!(error instanceof Error) || error.message !== SYNCHRONOUS_LOCK_TIMEOUT) throw error;
    return false;
  }
}

/**
 * Replace a file's contents atomically: write a temp file in the SAME directory
 * (so the rename cannot cross a filesystem boundary), fsync it, then rename over
 * the target. A reader either sees the old file or the new one — never a
 * half-written one — and an interrupted write leaves the previous contents
 * intact.
 */
export function replaceFileAtomically(
  path: string, contents: string, mode = 0o600, deps: WriteDeps = {}, options: ReplaceOptions = {},
): void {
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
  // Make the rename itself durable. Best-effort by default because not every
  // platform allows fsync on a directory; a durable replace refuses instead.
  try { (deps.fsyncDirectory ?? fsyncDirectory)(dir); }
  catch (e) { if (options.durable) throw e; }
}

/** Synchronous Lamport bakery lock: unique claims are never reused, so stale
 * reclamation cannot remove a successor's lock. Atomic claim replacement keeps
 * choosing/ticket reads complete. Dead claims can be removed by any contender.
 */
export function withSynchronousFileLock<T>(path: string, work: () => T): T {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}.json`;
  const own = join(path, token);
  const deadline = Date.now() + 10_000;
  type Claim = { pid: number; choosing: boolean; ticket: number } & ProcessIncarnation;
  const incarnation = processIncarnation(process.pid);
  const claims = (): Array<{ name: string; value: Claim }> => {
    const result: Array<{ name: string; value: Claim }> = [];
    for (const name of readdirSync(path).filter(name => /^[0-9]+-[a-f0-9-]{36}\.json$/.test(name))) {
      const file = join(path, name);
      let value: Claim;
      try { value = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.ticket) || value.ticket < 0)
        throw new Error('Invalid synchronous lock claim');
      if (name !== token) {
        let dead = false;
        try { process.kill(value.pid, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        // A claim from before a reboot, or whose PID now names a later process,
        // is as dead as an exited one.
        if (dead || incarnationEnded(value.pid, value)) {
          // This dead contender alone owned this UUID path. Never remove
          // the namespace or a successor's differently named claim.
          rmSync(file, { force: true }); continue;
        }
      }
      result.push({ name, value });
    }
    return result;
  };
  replaceFileAtomically(own, JSON.stringify({ pid: process.pid, choosing: true, ticket: 0, ...incarnation }));
  try {
    const ticket = Math.max(0, ...claims().map(claim => claim.value.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Synchronous lock ticket overflow');
    replaceFileAtomically(own, JSON.stringify({ pid: process.pid, choosing: false, ticket, ...incarnation }));
    for (;;) {
      const preceding = claims().some(claim => claim.name !== token && (claim.value.choosing
        || claim.value.ticket < ticket || (claim.value.ticket === ticket && claim.name < token)));
      if (!preceding) return work();
      if (Date.now() >= deadline) throw new Error(SYNCHRONOUS_LOCK_TIMEOUT);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } finally { rmSync(own, { force: true }); }
}
