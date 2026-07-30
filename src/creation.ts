import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically, withFileLock, type LockDeps } from './atomic-file.js';
import { stateRoot } from './paths.js';

/**
 * One creation transaction: role name and ours identity reserved together,
 * every artifact journalled, and everything undone in reverse on failure.
 *
 * The problem this replaces is a check followed by a create. `assertNameFree()`
 * read the config and the agent dirs, returned, and only then did the caller
 * start writing — so two concurrent spawns of the same name both passed the
 * check, both wrote, and the second silently overwrote the first's fleet.d file
 * while inheriting its half-built state. Nothing was atomic and nothing was
 * undone.
 */

/** Where host-wide creation state lives. One directory, so it is easy to inspect. */
const creationRoot = () => join(stateRoot(), 'creation');
const creationLock = () => join(creationRoot(), '.lock');
const reservationsDir = () => join(creationRoot(), 'reservations');

/** A reservation is one file; its existence IS the claim. */
const reservationPath = (kind: ReservationKind, name: string) =>
  join(reservationsDir(), `${kind}-${encodeURIComponent(name)}`);

export type ReservationKind = 'role' | 'identity';

export interface Reservation {
  kind: ReservationKind;
  name: string;
}

export class CreationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreationConflictError';
  }
}

/**
 * Artifacts a transaction created, newest last. Rollback walks this in reverse,
 * and may only delete what THIS transaction made — an object that already
 * existed is never touched.
 */
export interface JournalEntry {
  stage: string;
  undo(): void | Promise<void>;
}

export interface CreationDeps {
  lock?: LockDeps;
  log?(line: string): void;
  /** Reserve the ours identity name. Injectable so tests need no daemon. */
  identityRegistry?: IdentityRegistry;
}

/**
 * The contract the ours daemon must satisfy for identity names to be reserved
 * atomically across ALL of its clients, not just across fleet processes.
 *
 * `check-then-create` is not atomic across processes, which is the whole point:
 * two spawns can both observe a free identity name and both create it. The
 * daemon is the only component that sees every client, so only the daemon can
 * make the reservation authoritative.
 */
export interface IdentityRegistry {
  /** Claim `name`. Returns false if it is already taken or reserved. */
  reserve(name: string): Promise<boolean>;
  /** Give the claim back (rollback). Must be safe to call on an unheld name. */
  release(name: string): Promise<void>;
}

/**
 * Host-local identity reservation: atomic across every ours-fleet process on
 * this host, because it is taken under the same host-wide creation lock as the
 * role name.
 *
 * It is NOT atomic against other clients of the same ours daemon — another tool
 * creating the identity between our reservation and our creation would still
 * win. Closing that needs a reserve/commit/release operation in the daemon
 * itself; see the release notes.
 */
export const hostLocalIdentityRegistry: IdentityRegistry = {
  async reserve(name: string) {
    const p = reservationPath('identity', name);
    if (existsSync(p)) return false;
    mkdirSync(reservationsDir(), { recursive: true });
    writeFileSync(p, `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  },
  async release(name: string) {
    rmSync(reservationPath('identity', name), { force: true });
  },
};

/** Is this role name already reserved by an in-flight transaction? */
const roleReserved = (name: string) => existsSync(reservationPath('role', name));

export interface CreationTransaction {
  /** Record an artifact this transaction created, with how to undo it. */
  record(entry: JournalEntry): void;
  /** Stages recorded so far, in order. */
  readonly stages: string[];
}

/**
 * Run `body` inside a creation transaction.
 *
 * Under one host-wide lock: both names are reserved, then `body` builds the
 * role. If anything throws, every recorded stage is undone in reverse order and
 * both reservations are released, so the names can be reused immediately. On
 * success the reservations are released too — the role's own config and state
 * are the durable record from then on.
 *
 * Rollback errors are collected and reported, never allowed to hide the failure
 * that caused the rollback.
 */
export async function withCreationTransaction<T>(
  names: { role: string; identity: string },
  body: (tx: CreationTransaction) => Promise<T>,
  deps: CreationDeps = {},
): Promise<T> {
  const log = deps.log ?? (() => {});
  const registry = deps.identityRegistry ?? hostLocalIdentityRegistry;
  mkdirSync(creationRoot(), { recursive: true });

  const journal: JournalEntry[] = [];
  const tx: CreationTransaction = {
    record: entry => { journal.push(entry); },
    get stages() { return journal.map(e => e.stage); },
  };

  // Both names, one boundary. Reserving the role and then the identity without
  // a shared lock would let two spawns each win one.
  const held = await withFileLock(creationLock(), async () => {
    if (roleReserved(names.role))
      throw new CreationConflictError(
        `role '${names.role}' is being created by another process right now`);
    if (!await registry.reserve(names.identity))
      throw new CreationConflictError(
        `ours identity '${names.identity}' is already taken or being created right now`);
    mkdirSync(reservationsDir(), { recursive: true });
    writeFileSync(reservationPath('role', names.role), `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  }, deps.lock);

  if (!held) throw new CreationConflictError('could not take the creation lock');

  const releaseAll = async () => {
    rmSync(reservationPath('role', names.role), { force: true });
    await registry.release(names.identity).catch(() => undefined);
  };

  try {
    const result = await body(tx);
    await releaseAll();
    return result;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of [...journal].reverse()) {
      try { await entry.undo(); }
      catch (e) { rollbackFailures.push(`${entry.stage}: ${(e as Error).message}`); }
    }
    await releaseAll();
    const original = error instanceof Error ? error : new Error(String(error));
    if (rollbackFailures.length) {
      log(`creation rollback incomplete: ${rollbackFailures.join('; ')}`);
      original.message += ` (rollback also failed: ${rollbackFailures.join('; ')})`;
    }
    throw original;
  }
}

/** Forget reservations left behind by a process that died mid-transaction. */
export function clearStaleReservations(olderThanMs = 60_000, now = Date.now()): number {
  const dir = reservationsDir();
  if (!existsSync(dir)) return 0;
  let cleared = 0;
  for (const f of readdirSyncSafe(dir)) {
    const p = join(dir, f);
    try {
      const stamp = Date.parse(readFileSync(p, 'utf8').trim().split(/\s+/)[1] ?? '');
      if (Number.isFinite(stamp) && now - stamp > olderThanMs) { rmSync(p, { force: true }); cleared++; }
    } catch { /* unreadable: leave it for a human */ }
  }
  return cleared;
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); }
  catch { return []; }
}

/** Atomically write a role's fleet.d file, journalling it for rollback. */
export function writeRoleFile(tx: CreationTransaction, file: string, contents: string): void {
  const existed = existsSync(file);
  replaceFileAtomically(file, contents, 0o644);
  tx.record({
    stage: `fleet.d file ${file}`,
    // Only remove what THIS transaction created; never delete a file the
    // operator already had.
    undo: () => { if (!existed) rmSync(file, { force: true }); },
  });
}
