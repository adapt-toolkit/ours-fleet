/**
 * Human mission keys (`MSN-1`) and the durable state that issues them.
 *
 * The canonical task ID stays the storage, lock and authorization identity.
 * A key is an immutable alias issued once from a per-prefix high-water mark;
 * numbers are never derived from current rows and never reissued.
 *
 * Durable files under `<state>/mission-keys/`, all written by atomic replace
 * while holding the synchronous mission-keys lock (innermost lock: callers may
 * already hold `task-lists.lock` and/or one task lock, never the reverse):
 *   registry.json            prefixes, owners, high-water marks
 *   receipts/<sha256>.json   create idempotency receipts, never removed
 *   keys/<KEY>.json          key ledger: key → canonical task ID, never removed
 *
 * Single ordering invariant for every issued key:
 *   high-water mark → receipt → ledger → keyed task row.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically, withSynchronousFileLock } from '../atomic-file.js';
import { stateRoot } from '../paths.js';

export const DEFAULT_MISSION_PREFIX = 'MSN';
/** Never accepted for a custom list; ROOM/LAYOUT case-fold onto legacy agent names. */
export const RESERVED_MISSION_PREFIXES: readonly string[] = ['MSN', 'ROOM', 'LAYOUT', 'TASK'];
export const MISSION_PREFIX_MAX = 6;
const PREFIX_RE = /^[A-Z][A-Z0-9]{0,5}$/;
/** Accepted reference form; canonical task IDs never contain '-'. */
export const MISSION_KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,5})-([1-9][0-9]{0,8})$/;
const MAX_MISSION_NUMBER = 999_999_999;

export type MissionKeyErrorCode =
  | 'invalid_prefix' | 'duplicate_prefix' | 'prefix_reserved' | 'default_prefix_frozen'
  | 'task_deleted' | 'idempotency_conflict' | 'key_space_exhausted' | 'invalid_state';

export class MissionKeyError extends Error {
  constructor(readonly code: MissionKeyErrorCode, message: string) {
    super(message); this.name = 'MissionKeyError';
  }
}

export interface PrefixRecord {
  list_id: string;
  last_issued: number;
  /** active: the list's current prefix; retired: an earlier prefix of the same list; tombstoned: its list was deleted. */
  state: 'active' | 'retired' | 'tombstoned';
}

export interface MissionKeyRegistry {
  version: 1;
  default_prefix: string;
  prefixes: Record<string, PrefixRecord>;
  /** Set only after every historical row, receipt and ledger entry is durable. */
  keys_migrated?: true;
}

export interface CreationReceipt {
  version: 1;
  task_id: string;
  /** Absent only on a tombstone seeded for a row that never had a key. */
  mission_key?: string;
  list_id: string;
  /** sha256 of the canonical original creation input; absent on receipts seeded for legacy rows. */
  fingerprint?: string;
  /** Complete original creation input, so a resumed create never uses retry input. */
  input?: Record<string, unknown>;
  creation_plan?: string;
  state: 'reserved' | 'created' | 'deleted';
}

export interface KeyLedgerEntry { version: 1; key: string; task_id: string; state: 'live' | 'deleted' }

const root = () => join(stateRoot(), 'mission-keys');
const registryPath = () => join(root(), 'registry.json');
const lockPath = () => join(root(), 'lock');
const receiptPath = (idempotencyKey: string) =>
  join(root(), 'receipts', `${createHash('sha256').update(idempotencyKey).digest('hex')}.json`);
const ledgerPath = (key: string) => join(root(), 'keys', `${key}.json`);

let lockDepth = 0;
/** Innermost cross-process lock for registry, receipts and ledger. Re-entrant within a process. */
export function withMissionKeysLock<T>(fn: () => T): T {
  if (lockDepth > 0) return fn();
  return withSynchronousFileLock(lockPath(), () => {
    lockDepth++;
    try { return fn(); } finally { lockDepth--; }
  });
}
const assertLocked = () => {
  if (lockDepth === 0) throw new MissionKeyError('invalid_state', 'mission-keys lock is not held');
};

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
const writeJson = (path: string, value: unknown) =>
  replaceFileAtomically(path, JSON.stringify(value, null, 2) + '\n', 0o600, {}, { durable: true });

// ── Prefix rules ─────────────────────────────────────────────────────────

/** Trim and uppercase ASCII letters; every other deviation is an explicit error. */
export function normalizeMissionPrefix(input: unknown): string {
  if (typeof input !== 'string') throw new MissionKeyError('invalid_prefix', 'prefix must be a string');
  const value = input.trim().replace(/[a-z]/g, c => c.toUpperCase());
  if (!PREFIX_RE.test(value))
    throw new MissionKeyError('invalid_prefix',
      `prefix must be 1-${MISSION_PREFIX_MAX} Latin letters or digits starting with a letter, e.g. OPS`);
  return value;
}

/** Latin words of a list name; diacritics are folded, other scripts are dropped. */
function latinWords(name: string): string[] {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    .split(/[^A-Z0-9]+/).filter(Boolean);
}

/**
 * Deterministic convenience suggestion; never authoritative and never a
 * tombstoned, retired, reserved or active prefix.
 */
export function suggestMissionPrefix(name: string, taken: ReadonlySet<string>): string {
  const words = latinWords(name).filter(word => /^[A-Z]/.test(word));
  let base = words.length > 1
    ? words.map(word => word[0]).join('').slice(0, MISSION_PREFIX_MAX)
    : words.length === 1 ? words[0].slice(0, 4) : '';
  if (!PREFIX_RE.test(base)) base = 'L';
  const free = (candidate: string) => !taken.has(candidate) && !RESERVED_MISSION_PREFIXES.includes(candidate);
  if (base !== 'L' && free(base)) return base;
  for (let n = base === 'L' ? 1 : 2; n < 1_000_000; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, MISSION_PREFIX_MAX - suffix.length) + suffix;
    if (PREFIX_RE.test(candidate) && free(candidate)) return candidate;
  }
  throw new MissionKeyError('key_space_exhausted', 'no free prefix suggestion');
}

// ── Registry ─────────────────────────────────────────────────────────────

export function readMissionKeyRegistry(): MissionKeyRegistry | undefined {
  const value = readJson<MissionKeyRegistry>(registryPath());
  if (value && (value.version !== 1 || typeof value.default_prefix !== 'string' || typeof value.prefixes !== 'object'))
    throw new MissionKeyError('invalid_state', 'invalid mission key registry');
  return value;
}

export function writeMissionKeyRegistry(registry: MissionKeyRegistry): void {
  assertLocked();
  writeJson(registryPath(), registry);
}

/**
 * Create the registry on first use. A configured default prefix may change the
 * default list's prefix only until it has issued its first key.
 */
export function ensureMissionKeyRegistry(configuredDefault?: string): MissionKeyRegistry {
  return withMissionKeysLock(() => {
    const desired = configuredDefault === undefined ? undefined : normalizeMissionPrefix(configuredDefault);
    let registry = readMissionKeyRegistry();
    if (!registry) {
      const prefix = desired ?? DEFAULT_MISSION_PREFIX;
      registry = { version: 1, default_prefix: prefix,
        prefixes: { [prefix]: { list_id: 'default', last_issued: 0, state: 'active' } } };
      writeMissionKeyRegistry(registry);
      return registry;
    }
    if (desired === undefined || desired === registry.default_prefix) return registry;
    const current = registry.prefixes[registry.default_prefix];
    if (current && current.last_issued > 0)
      throw new MissionKeyError('default_prefix_frozen',
        `default list prefix is ${registry.default_prefix}; tasks.default_prefix=${desired} can only change before the first mission key`);
    if (registry.prefixes[desired])
      throw new MissionKeyError('prefix_reserved', `prefix ${desired} is already used by another list`);
    delete registry.prefixes[registry.default_prefix];
    registry.default_prefix = desired;
    registry.prefixes[desired] = { list_id: 'default', last_issued: 0, state: 'active' };
    writeMissionKeyRegistry(registry);
    return registry;
  });
}

/** Every prefix a custom list may not take: reserved names, the default, and any ever-issued prefix. */
export function unavailablePrefixes(registry: MissionKeyRegistry): Set<string> {
  return new Set([...RESERVED_MISSION_PREFIXES, registry.default_prefix, ...Object.keys(registry.prefixes)]);
}

export function activePrefixFor(registry: MissionKeyRegistry, listId: string): string | undefined {
  return Object.entries(registry.prefixes).find(([, record]) =>
    record.list_id === listId && record.state === 'active')?.[0];
}

/**
 * Claim `prefix` as the active prefix of `listId`. `explicit` is false for a
 * server suggestion, which never adopts a tombstone. Caller holds the lock and
 * writes the registry.
 */
export function claimPrefix(registry: MissionKeyRegistry, listId: string, prefix: string, explicit: boolean): void {
  assertLocked();
  if (listId !== 'default' && (RESERVED_MISSION_PREFIXES.includes(prefix) || prefix === registry.default_prefix))
    throw new MissionKeyError('prefix_reserved', `prefix ${prefix} is reserved`);
  const existing = registry.prefixes[prefix];
  if (existing) {
    const ownRetired = existing.list_id === listId && existing.state !== 'tombstoned';
    const reclaim = existing.state === 'tombstoned' && explicit;
    if (existing.list_id === listId && existing.state === 'active') return;
    if (!ownRetired && !reclaim)
      throw new MissionKeyError(existing.state === 'active' ? 'duplicate_prefix' : 'prefix_reserved',
        existing.state === 'active'
          ? `prefix ${prefix} is already used by another list`
          : `prefix ${prefix} was used by an earlier list and is reserved`);
  }
  for (const record of Object.values(registry.prefixes))
    if (record.list_id === listId && record.state === 'active') record.state = 'retired';
  registry.prefixes[prefix] = { list_id: listId, last_issued: existing?.last_issued ?? 0, state: 'active' };
}

/** Deleting a list keeps its prefixes and high-water marks as tombstones. */
export function tombstoneListPrefixes(registry: MissionKeyRegistry, listId: string): void {
  assertLocked();
  for (const record of Object.values(registry.prefixes))
    if (record.list_id === listId) record.state = 'tombstoned';
}

/** Raise a prefix's high-water mark; the caller persists the registry before publishing the key. */
export function issueNextKey(registry: MissionKeyRegistry, listId: string): string {
  assertLocked();
  const prefix = activePrefixFor(registry, listId);
  if (!prefix) throw new MissionKeyError('invalid_state', `list ${listId} has no active prefix`);
  const record = registry.prefixes[prefix];
  if (record.last_issued >= MAX_MISSION_NUMBER)
    throw new MissionKeyError('key_space_exhausted', `prefix ${prefix} has issued its last key`);
  record.last_issued += 1;
  return `${prefix}-${record.last_issued}`;
}

/** Monotonically account for an already-issued key. */
export function observeIssuedKey(registry: MissionKeyRegistry, key: string, listId: string): void {
  const match = MISSION_KEY_RE.exec(key);
  if (!match) return;
  const prefix = match[1].toUpperCase(), n = Number(match[2]);
  const record = registry.prefixes[prefix]
    ?? (registry.prefixes[prefix] = { list_id: listId, last_issued: 0, state: 'tombstoned' });
  record.last_issued = Math.max(record.last_issued, n);
}

// ── Receipts and ledger ──────────────────────────────────────────────────

export const readCreationReceipt = (idempotencyKey: string) =>
  readJson<CreationReceipt>(receiptPath(idempotencyKey));

export function writeCreationReceipt(idempotencyKey: string, receipt: CreationReceipt): void {
  assertLocked();
  const previous = readCreationReceipt(idempotencyKey);
  // A deletion tombstone is terminal: nothing may revive the receipt.
  if (previous?.state === 'deleted' && receipt.state !== 'deleted')
    throw new MissionKeyError('task_deleted', `mission ${previous.mission_key} was deleted`);
  writeJson(receiptPath(idempotencyKey), receipt);
}

export function readKeyLedger(key: string): KeyLedgerEntry | undefined {
  if (!/^[A-Z][A-Z0-9]{0,5}-[1-9][0-9]*$/.test(key)) return undefined;
  return readJson<KeyLedgerEntry>(ledgerPath(key));
}

/** Create or confirm the ledger entry; a key never moves to another task. */
export function ensureKeyLedger(key: string, taskId: string, state: KeyLedgerEntry['state'] = 'live'): void {
  assertLocked();
  const previous = readKeyLedger(key);
  if (previous && previous.task_id !== taskId)
    throw new MissionKeyError('invalid_state', `mission key ${key} already belongs to another task`);
  if (previous && (previous.state === state || previous.state === 'deleted')) return;
  writeJson(ledgerPath(key), { version: 1, key, task_id: taskId, state } satisfies KeyLedgerEntry);
}

export function canonicalFingerprint(input: Record<string, unknown>): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, sorted((value as Record<string, unknown>)[key])]))
      : value;
  return createHash('sha256').update(JSON.stringify(sorted(input))).digest('hex');
}

/** Parse a user reference; returns the normalized key, or undefined for non-key input. */
export function parseMissionKeyRef(ref: string): string | undefined {
  const match = MISSION_KEY_RE.exec(ref);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : undefined;
}

export const missionKeysExist = () => existsSync(registryPath());
