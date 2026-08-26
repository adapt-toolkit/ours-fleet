import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  loadConfigResourceSnapshot, loadConfigResourceSnapshotFromDocuments,
  resolveConfigResourceDirectory,
  type BrainValidationHook, type ConfigResourceDocument, type ConfigResourceSnapshot,
} from './config-resource-loader.js';
import {
  ConfigGraphLockError, probeProcessState, withConfigGraphLock, type ProcessState,
} from './config-graph-lock.js';

const TYPED_DIRECTORIES = [
  'roles.d', 'brains.d', 'agents.d', 'room-templates.d', 'rooms.d', 'tasks.d',
] as const;
type TypedDirectory = (typeof TYPED_DIRECTORIES)[number];
const JOURNAL_SCHEMA = 1;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1024;
const MAX_FILE_BYTES = 1024 * 1024;

export type ConfigGraphTarget =
  | { scope: 'bootstrap' }
  | { scope: 'resource'; directory: TypedDirectory; basename: string };

export interface ConfigGraphMutation {
  target: ConfigGraphTarget;
  /** null deletes; bytes create or replace. */
  contents: Buffer | null;
}

export interface ConfigGraphTransactionDeps {
  now?(): number;
  randomUUID?(): string;
  processId?(): number;
  processFingerprint?(pid: number): string;
  processState?(pid: number, fingerprint: string): ProcessState;
  checkpoint?(name: string): void;
}

export interface ConfigGraphTransactionOptions {
  bootstrapFile: string;
  expectedDigest: string;
  mutations: readonly ConfigGraphMutation[];
  validateBrain?: BrainValidationHook;
  deps?: ConfigGraphTransactionDeps;
}

interface Identity {
  dev: string; ino: string; size: number; mtimeNs: string;
}

interface FileTruth { exists: boolean; sha256?: string; size?: number; identity?: Identity }

interface LogicalTarget {
  scope: 'bootstrap' | 'resource'; directory?: TypedDirectory; basename?: string;
}

interface JournalEntry {
  target: LogicalTarget;
  parentExisted: boolean;
  operation: 'create' | 'replace' | 'delete';
  before: FileTruth;
  after: FileTruth;
  stageBasename?: string;
  backupBasename?: string;
}

interface OwnerRecord {
  schema: 1;
  token: string;
  pid: number;
  fingerprint: string;
  createdAt: number;
  entries: Array<Pick<JournalEntry, 'target' | 'parentExisted' | 'stageBasename' | 'backupBasename'>>;
}

interface Journal extends OwnerRecord {
  phase: 'prepared' | 'installing' | 'installed' | 'committed';
  direction: 'forward' | 'rollback' | null;
  expectedDigest: string;
  beforeDigest: string;
  afterDigest: string;
  entries: JournalEntry[];
}

export class ConfigGraphTransactionError extends Error {}
export class ConfigGraphTransactionCleanupError extends ConfigGraphTransactionError {
  constructor(
    readonly primaryError: unknown,
    readonly cleanupError: unknown,
    readonly retainedPaths: readonly string[],
  ) {
    super(`pre-journal cleanup failed after ${fsReason(primaryError)}; retained evidence: ${
      retainedPaths.length ? retainedPaths.join(', ') : '(none found)'}; cleanup failure: ${fsReason(cleanupError)}`);
  }
}
/** Test-only crash sentinel: skips best-effort private-temp cleanup to model process death. */
export class ConfigGraphSimulatedCrash extends Error {}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const journalPath = (bootstrap: string): string => `${bootstrap}.graph-journal.json`;
const ownerPrefix = (bootstrap: string): string => `.${basename(bootstrap)}.graph-owner.`;
const ownerPath = (bootstrap: string, token: string): string =>
  join(dirname(bootstrap), `${ownerPrefix(bootstrap)}${token}.json`);

function fsReason(error: unknown): string {
  const value = error as NodeJS.ErrnoException;
  return `${value.code ? `${value.code}: ` : ''}${value.message ?? String(error)}`;
}

function fingerprint(pid: number): string {
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const start = stat.slice(close + 2).split(' ')[19];
    if (!boot || !start) throw new Error('missing process identity');
    return `${boot}:${start}`;
  } catch { throw new ConfigGraphTransactionError('process birth fingerprint unavailable'); }
}

function identity(stat: BigIntStats): Identity {
  return {
    dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
  };
}

function sameIdentity(left: Identity | undefined, right: Identity): boolean {
  return !!left && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function secureRead(path: string, limit = MAX_FILE_BYTES, requiredMode?: number): { bytes: Buffer; identity: Identity } {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new ConfigGraphTransactionError('secure file open unavailable: O_NOFOLLOW is required');
  let beforePath: BigIntStats;
  try { beforePath = lstatSync(path, { bigint: true }); }
  catch (error) { throw new ConfigGraphTransactionError(`cannot inspect ${path}: ${fsReason(error)}`); }
  if (beforePath.isSymbolicLink() || !beforePath.isFile())
    throw new ConfigGraphTransactionError(`${path}: must be a regular non-symlink file`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new ConfigGraphTransactionError(`cannot open ${path}: ${fsReason(error)}`); }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit))
      throw new ConfigGraphTransactionError(`${path}: must be a bounded regular file`);
    if (requiredMode !== undefined && (Number(before.mode) & 0o777) !== requiredMode)
      throw new ConfigGraphTransactionError(`${path}: mode must be ${requiredMode.toString(8)}`);
    if (beforePath.dev !== before.dev || beforePath.ino !== before.ino
        || beforePath.size !== before.size || beforePath.mtimeNs !== before.mtimeNs)
      throw new ConfigGraphTransactionError(`${path}: identity changed before reading`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new ConfigGraphTransactionError(`${path}: truncated while reading`);
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    let afterPath: BigIntStats;
    try { afterPath = lstatSync(path, { bigint: true }); }
    catch (error) { throw new ConfigGraphTransactionError(`cannot re-inspect ${path}: ${fsReason(error)}`); }
    const left = identity(before);
    const right = identity(after);
    if (!sameIdentity(left, right) || afterPath.dev !== after.dev || afterPath.ino !== after.ino
        || afterPath.size !== after.size || afterPath.mtimeNs !== after.mtimeNs)
      throw new ConfigGraphTransactionError(`${path}: identity changed while reading`);
    return { bytes, identity: left };
  } finally { closeSync(fd); }
}

function writeDurable(path: string, bytes: Buffer, exclusive: boolean): void {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new ConfigGraphTransactionError('secure file open unavailable: O_NOFOLLOW is required');
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (exclusive ? constants.O_EXCL : constants.O_TRUNC);
  const fd = openSync(path, flags, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count <= 0) throw new ConfigGraphTransactionError(`${path}: write made no progress`);
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function targetKey(target: LogicalTarget): string {
  return target.scope === 'bootstrap' ? 'bootstrap' : `${target.directory}/${target.basename}`;
}

function validateTarget(target: ConfigGraphTarget): LogicalTarget {
  if (target.scope === 'bootstrap') {
    if (Object.keys(target).length !== 1) throw new ConfigGraphTransactionError('invalid bootstrap target');
    return { scope: 'bootstrap' };
  }
  if (target.scope !== 'resource' || !TYPED_DIRECTORIES.includes(target.directory)
      || typeof target.basename !== 'string' || !target.basename
      || target.basename.includes('/') || target.basename.includes('\\')
      || target.basename === '.' || target.basename === '..'
      || (!target.basename.endsWith('.yaml') && !target.basename.endsWith('.yml')))
    throw new ConfigGraphTransactionError('invalid typed resource target');
  return { scope: 'resource', directory: target.directory, basename: target.basename };
}

function targetPath(bootstrap: string, configDir: string, target: LogicalTarget): string {
  return target.scope === 'bootstrap' ? bootstrap : join(configDir, target.directory!, target.basename!);
}

function directoryExists(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new ConfigGraphTransactionError(`${path}: target parent must be a non-symlink directory`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function compareTargets(left: { target: LogicalTarget }, right: { target: LogicalTarget }): number {
  if (left.target.scope !== right.target.scope) return left.target.scope === 'bootstrap' ? -1 : 1;
  if (left.target.scope === 'bootstrap' || right.target.scope === 'bootstrap') return 0;
  const directoryOrder = TYPED_DIRECTORIES.indexOf(left.target.directory!)
    - TYPED_DIRECTORIES.indexOf(right.target.directory!);
  return directoryOrder || Buffer.compare(Buffer.from(left.target.basename!), Buffer.from(right.target.basename!));
}

function artifactBasename(target: LogicalTarget, token: string, index: number, kind: 'stage' | 'backup'): string {
  void target;
  return `.fleet-txn.${token}.${index}.${kind}`;
}

function restoreBasename(target: LogicalTarget, token: string, index: number): string {
  void target;
  return `.fleet-txn.${token}.${index}.restore`;
}

function isArtifactBasename(value: string): boolean {
  return /^\.fleet-txn\.[a-f0-9-]{8,}\.\d+\.(?:stage|backup|restore)$/iu.test(value);
}

function artifactPath(
  bootstrap: string, configDir: string, target: LogicalTarget, basenameValue: string,
): string { return join(dirname(targetPath(bootstrap, configDir, target)), basenameValue); }

function truth(path: string): FileTruth {
  try {
    const read = secureRead(path);
    return { exists: true, sha256: sha256(read.bytes), size: read.bytes.length, identity: read.identity };
  } catch (error) {
    if ((error as Error).message.includes('ENOENT')) return { exists: false };
    throw error;
  }
}

function artifactTruth(path: string): FileTruth {
  try {
    const read = secureRead(path, MAX_FILE_BYTES, 0o600);
    return { exists: true, sha256: sha256(read.bytes), size: read.bytes.length, identity: read.identity };
  } catch (error) {
    if ((error as Error).message.includes('ENOENT')) return { exists: false };
    throw error;
  }
}

function truthMatches(actual: FileTruth, expected: FileTruth, includeIdentity = false): boolean {
  if (actual.exists !== expected.exists) return false;
  if (!actual.exists) return true;
  return actual.sha256 === expected.sha256 && actual.size === expected.size
    && (!includeIdentity || sameIdentity(expected.identity, actual.identity!));
}

function serialize(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); }

function publishNoReplace(
  path: string, bytes: Buffer, token: string, deps: ConfigGraphTransactionDeps, label: string,
  onPublished?: () => void,
): void {
  if (bytes.length > MAX_JOURNAL_BYTES)
    throw new ConfigGraphTransactionError(`${path}: metadata exceeds ${MAX_JOURNAL_BYTES} bytes`);
  const temp = `${path}.publish.${token}`;
  let preserve = false;
  try {
    writeDurable(temp, bytes, true);
    checkpoint(deps, `${label}_publication_temp_fsynced`);
    // A directory rename cannot provide no-replace for files; hard-link does.
    linkSync(temp, path);
    onPublished?.();
    checkpoint(deps, `${label}_publication_linked`);
    unlinkSync(temp);
    fsyncDirectory(dirname(path));
    checkpoint(deps, `${label}_publication_directory_fsynced`);
  } catch (error) {
    preserve = error instanceof ConfigGraphSimulatedCrash;
    throw error;
  } finally { if (!preserve) rmSync(temp, { force: true }); }
}

function existingPath(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertPrivateRegular(path: string, limit = MAX_FILE_BYTES): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > limit)
    throw new ConfigGraphTransactionError(`${path}: unsafe transaction evidence`);
}

function ownedEvidencePaths(
  bootstrap: string, configDir: string, owner: OwnerRecord,
): string[] {
  const result = [
    ownerPath(bootstrap, owner.token),
    `${ownerPath(bootstrap, owner.token)}.publish.${owner.token}`,
    `${journalPath(bootstrap)}.publish.${owner.token}`,
  ];
  for (const entry of owner.entries) {
    for (const artifact of [entry.stageBasename, entry.backupBasename]) {
      if (artifact) result.push(artifactPath(bootstrap, configDir, entry.target, artifact));
    }
  }
  return result;
}

/** Undo only evidence authenticated by this transaction's published owner record. */
function cleanupOwnedPreJournal(
  bootstrap: string, configDir: string, expectedOwner: OwnerRecord, deps: ConfigGraphTransactionDeps,
): void {
  const publicOwnerPath = ownerPath(bootstrap, expectedOwner.token);
  const retainedCandidates = ownedEvidencePaths(bootstrap, configDir, expectedOwner);
  try {
    checkpoint(deps, 'prejournal_cleanup_start');
    const published = readJsonFile<OwnerRecord>(publicOwnerPath, MAX_JOURNAL_BYTES);
    if (!validateOwner(published) || published.token !== expectedOwner.token
        || !serialize(published).equals(serialize(expectedOwner)))
      throw new ConfigGraphTransactionError(`${publicOwnerPath}: owner token or contents changed`);
    if (existingPath(journalPath(bootstrap)))
      throw new ConfigGraphTransactionError(`${journalPath(bootstrap)}: journal unexpectedly exists`);

    const touchedDirectories = new Set<string>();
    for (const entry of expectedOwner.entries) {
      for (const artifact of [entry.stageBasename, entry.backupBasename]) {
        if (!artifact) continue;
        const path = artifactPath(bootstrap, configDir, entry.target, artifact);
        if (!existingPath(path)) continue;
        assertPrivateRegular(path);
        unlinkSync(path);
        touchedDirectories.add(dirname(path));
      }
    }
    for (const path of [
      `${publicOwnerPath}.publish.${expectedOwner.token}`,
      `${journalPath(bootstrap)}.publish.${expectedOwner.token}`,
    ]) {
      if (!existingPath(path)) continue;
      const record = readJsonFile<OwnerRecord | Journal>(path, MAX_JOURNAL_BYTES);
      if (!validToken(record.token) || record.token !== expectedOwner.token)
        throw new ConfigGraphTransactionError(`${path}: publication temp token changed`);
      unlinkSync(path);
      touchedDirectories.add(dirname(path));
    }
    for (const directory of touchedDirectories) fsyncDirectory(directory);
    for (const entry of expectedOwner.entries) {
      if (entry.parentExisted || entry.target.scope !== 'resource') continue;
      const parent = dirname(targetPath(bootstrap, configDir, entry.target));
      if (directoryExists(parent) && readdirSync(parent).length === 0) {
        rmdirSync(parent);
        fsyncDirectory(dirname(parent));
      }
    }
    unlinkSync(publicOwnerPath);
    fsyncDirectory(dirname(bootstrap));
  } catch (cleanupError) {
    const retainedPaths = retainedCandidates.filter(path => {
      try { return existingPath(path); } catch { return true; }
    });
    throw Object.assign(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)), {
      retainedPaths,
    });
  }
}

function replaceDurable(
  path: string, bytes: Buffer, token: string, deps: ConfigGraphTransactionDeps = {}, label = 'journal',
): void {
  if (bytes.length > MAX_JOURNAL_BYTES)
    throw new ConfigGraphTransactionError(`${path}: metadata exceeds ${MAX_JOURNAL_BYTES} bytes`);
  const temp = `${path}.replace.${token}`;
  let preserve = false;
  try {
    writeDurable(temp, bytes, true);
    checkpoint(deps, `${label}_replace_temp_fsynced`);
    renameSync(temp, path);
    checkpoint(deps, `${label}_replaced`);
    fsyncDirectory(dirname(path));
    checkpoint(deps, `${label}_replace_directory_fsynced`);
  } catch (error) {
    preserve = error instanceof ConfigGraphSimulatedCrash;
    throw error;
  } finally { if (!preserve) rmSync(temp, { force: true }); }
}

function readJsonFile<T>(path: string, maxBytes: number): T {
  const read = secureRead(path, maxBytes, 0o600);
  let value: unknown;
  try { value = JSON.parse(read.bytes.toString('utf8')); }
  catch { throw new ConfigGraphTransactionError(`${path}: malformed JSON`); }
  return value as T;
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[a-f0-9-]{8,}$/iu.test(value);
}

function validateLogicalTarget(value: unknown): value is LogicalTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (target.scope === 'bootstrap') return Object.keys(target).length === 1;
  return target.scope === 'resource' && Object.keys(target).sort().join(',') === 'basename,directory,scope'
    && TYPED_DIRECTORIES.includes(target.directory as TypedDirectory)
    && typeof target.basename === 'string' && !target.basename.includes('/')
    && !target.basename.includes('\\') && target.basename !== '.' && target.basename !== '..'
    && (target.basename.endsWith('.yaml') || target.basename.endsWith('.yml'));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateOwnerEntry(
  entry: unknown, token: string, index: number,
): entry is Pick<JournalEntry, 'target' | 'parentExisted' | 'stageBasename' | 'backupBasename'> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const item = entry as Pick<JournalEntry, 'target' | 'parentExisted' | 'stageBasename' | 'backupBasename'>;
  const keys = ['target', 'parentExisted', ...(item.stageBasename === undefined ? [] : ['stageBasename']),
    ...(item.backupBasename === undefined ? [] : ['backupBasename'])];
  return exactKeys(entry, keys) && validateLogicalTarget(item.target) && typeof item.parentExisted === 'boolean'
    && (item.stageBasename === undefined
      || item.stageBasename === artifactBasename(item.target, token, index, 'stage'))
    && (item.backupBasename === undefined
      || item.backupBasename === artifactBasename(item.target, token, index, 'backup'));
}

function validateOwner(value: unknown): value is OwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as OwnerRecord;
  return exactKeys(value, ['schema', 'token', 'pid', 'fingerprint', 'createdAt', 'entries'])
    && owner.schema === 1 && validToken(owner.token) && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.fingerprint === 'string' && owner.fingerprint.length > 0 && owner.fingerprint.length <= 512
    && Number.isSafeInteger(owner.createdAt) && owner.createdAt >= 0
    && Array.isArray(owner.entries) && owner.entries.length > 0 && owner.entries.length <= MAX_ENTRIES
    && owner.entries.every((entry, index) => validateOwnerEntry(entry, owner.token, index));
}

function validateTruth(value: unknown): value is FileTruth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as FileTruth;
  if (item.exists === false) return Object.keys(item).length === 1;
  const keys = ['exists', 'sha256', 'size', ...(item.identity === undefined ? [] : ['identity'])];
  return exactKeys(value, keys) && item.exists === true
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)
    && Number.isSafeInteger(item.size) && item.size! >= 0 && item.size! <= MAX_FILE_BYTES
    && (item.identity === undefined || (exactKeys(item.identity, ['dev', 'ino', 'size', 'mtimeNs'])
      && /^\d+$/u.test(item.identity.dev) && /^\d+$/u.test(item.identity.ino)
      && Number.isSafeInteger(item.identity.size) && item.identity.size === item.size
      && /^\d+$/u.test(item.identity.mtimeNs)));
}

function validateJournal(value: unknown): value is Journal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Journal;
  if (!exactKeys(value, [
    'schema', 'token', 'pid', 'fingerprint', 'createdAt', 'entries', 'phase', 'direction',
    'expectedDigest', 'beforeDigest', 'afterDigest',
  ])) return false;
  const ownerShape = {
    schema: journal.schema, token: journal.token, pid: journal.pid,
    fingerprint: journal.fingerprint, createdAt: journal.createdAt,
    entries: journal.entries.map(({ target, parentExisted, stageBasename, backupBasename }) =>
      ({ target, parentExisted, ...(stageBasename === undefined ? {} : { stageBasename }),
        ...(backupBasename === undefined ? {} : { backupBasename }) })),
  };
  const phaseDirection = journal.phase === 'prepared' ? journal.direction === null
    : journal.phase === 'installed' ? journal.direction === 'forward'
      : journal.direction === 'forward' || journal.direction === 'rollback';
  const keys = journal.entries.map(entry => targetKey(entry.target));
  const sorted = [...journal.entries].sort(compareTargets).map(entry => targetKey(entry.target));
  return validateOwner(ownerShape) && phaseDirection
    && new Set(keys).size === keys.length && keys.join('\0') === sorted.join('\0')
    && journal.expectedDigest === journal.beforeDigest
    && ['prepared', 'installing', 'installed', 'committed'].includes(journal.phase)
    && [null, 'forward', 'rollback'].includes(journal.direction)
    && [journal.expectedDigest, journal.beforeDigest, journal.afterDigest]
      .every(digest => typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(digest))
    && journal.entries.every((entry, index) => {
      const optional = [entry.stageBasename === undefined ? null : 'stageBasename',
        entry.backupBasename === undefined ? null : 'backupBasename'].filter(Boolean) as string[];
      const summary = { target: entry.target, parentExisted: entry.parentExisted,
        ...(entry.stageBasename === undefined ? {} : { stageBasename: entry.stageBasename }),
        ...(entry.backupBasename === undefined ? {} : { backupBasename: entry.backupBasename }) };
      if (!exactKeys(entry, ['target', 'parentExisted', 'operation', 'before', 'after', ...optional])
          || !validateOwnerEntry(summary, journal.token, index)
          || !validateTruth(entry.before) || !validateTruth(entry.after)
          || (entry.before.exists && !entry.before.identity)) return false;
      return entry.operation === 'create'
        ? !entry.before.exists && entry.after.exists && !!entry.stageBasename && !entry.backupBasename
        : entry.operation === 'replace'
          ? entry.before.exists && entry.after.exists && !!entry.stageBasename && !!entry.backupBasename
          : entry.operation === 'delete' && entry.before.exists && !entry.after.exists
            && !entry.stageBasename && !!entry.backupBasename;
    });
}

function collectDocuments(snapshot: ConfigResourceSnapshot): Map<string, Buffer> {
  const documents = new Map<string, Buffer>();
  for (const source of snapshot.sources) {
    const read = secureRead(source.sourceFile);
    if (sha256(read.bytes) !== source.sha256)
      throw new ConfigGraphTransactionError(`${source.sourceFile}: changed after snapshot load`);
    documents.set(source.relativePath, read.bytes);
  }
  return documents;
}

function documentsArray(value: Map<string, Buffer>): ConfigResourceDocument[] {
  return [...value].map(([relativePath, bytes]) => ({ relativePath, bytes }));
}

function checkpoint(deps: ConfigGraphTransactionDeps, name: string): void { deps.checkpoint?.(name); }

export async function applyConfigGraphTransaction(
  options: ConfigGraphTransactionOptions,
): Promise<ConfigResourceSnapshot> {
  const bootstrap = resolve(options.bootstrapFile);
  try {
    return await withConfigGraphLock(bootstrap, 'exclusive', async () => {
      await recoverConfigGraphTransactionLocked(bootstrap, options.validateBrain, options.deps);
      return applyLocked({ ...options, bootstrapFile: bootstrap });
    });
  } catch (error) {
    if (error instanceof ConfigGraphTransactionError || error instanceof ConfigGraphLockError) throw error;
    throw new ConfigGraphTransactionError(`configuration graph transaction failed: ${fsReason(error)}`);
  }
}

async function applyLocked(options: ConfigGraphTransactionOptions): Promise<ConfigResourceSnapshot> {
  const deps = options.deps ?? {};
  if (!options.mutations.length || options.mutations.length > MAX_ENTRIES)
    throw new ConfigGraphTransactionError(`mutation count must be between 1 and ${MAX_ENTRIES}`);
  const current = loadConfigResourceSnapshot({
    bootstrapFile: options.bootstrapFile, validateBrain: options.validateBrain,
  });
  if (current.digest !== options.expectedDigest)
    throw new ConfigGraphTransactionError(
      `stale configuration digest: expected ${options.expectedDigest}, current ${current.digest}`);
  const bootstrapRead = secureRead(options.bootstrapFile);
  const documents = collectDocuments(current);
  const reread = loadConfigResourceSnapshotFromDocuments({
    bootstrapFile: options.bootstrapFile, bootstrapBytes: bootstrapRead.bytes,
    configDir: current.configDir, documents: documentsArray(documents), validateBrain: options.validateBrain,
  });
  if (reread.digest !== current.digest)
    throw new ConfigGraphTransactionError('configuration changed while constructing transaction baseline');
  let proposedBootstrap = Buffer.from(bootstrapRead.bytes);
  const normalized = options.mutations.map(mutation => ({
    target: validateTarget(mutation.target), contents: mutation.contents === null ? null : Buffer.from(mutation.contents),
  })).sort(compareTargets);
  const keys = new Set<string>();
  for (const mutation of normalized) {
    const key = targetKey(mutation.target);
    if (keys.has(key)) throw new ConfigGraphTransactionError(`duplicate mutation target '${key}'`);
    keys.add(key);
    if (mutation.contents && mutation.contents.length > MAX_FILE_BYTES)
      throw new ConfigGraphTransactionError(`${key}: exceeds ${MAX_FILE_BYTES} byte limit`);
    if (mutation.target.scope === 'bootstrap') {
      if (mutation.contents === null) throw new ConfigGraphTransactionError('bootstrap cannot be deleted');
      proposedBootstrap = mutation.contents;
    } else if (mutation.contents === null) documents.delete(key);
    else documents.set(key, mutation.contents);
  }
  const proposed = loadConfigResourceSnapshotFromDocuments({
    bootstrapFile: options.bootstrapFile, bootstrapBytes: proposedBootstrap,
    configDir: current.configDir, documents: documentsArray(documents), validateBrain: options.validateBrain,
  });
  const finalPreflight = loadConfigResourceSnapshot({
    bootstrapFile: options.bootstrapFile, validateBrain: options.validateBrain,
  });
  if (finalPreflight.digest !== current.digest)
    throw new ConfigGraphTransactionError('configuration changed before transaction artifact publication');
  const token = (deps.randomUUID ?? randomUUID)();
  const pid = (deps.processId ?? (() => process.pid))();
  const owner: OwnerRecord = {
    schema: 1, token, pid,
    fingerprint: (deps.processFingerprint ?? fingerprint)(pid),
    createdAt: (deps.now ?? Date.now)(), entries: [],
  };
  if (!validToken(token)) throw new ConfigGraphTransactionError('invalid transaction token');
  const entries: JournalEntry[] = normalized.map((mutation, index) => {
    const path = targetPath(options.bootstrapFile, current.configDir, mutation.target);
    const parentExisted = directoryExists(dirname(path));
    const before = truth(path);
    const after = mutation.contents === null
      ? { exists: false } satisfies FileTruth
      : { exists: true, sha256: sha256(mutation.contents), size: mutation.contents.length } satisfies FileTruth;
    const operation = !before.exists ? 'create' : mutation.contents === null ? 'delete' : 'replace';
    if (operation === 'create' && mutation.contents === null)
      throw new ConfigGraphTransactionError(`${targetKey(mutation.target)}: cannot delete an absent target`);
    return {
      target: mutation.target, parentExisted, operation, before, after,
      ...(mutation.contents === null ? {} : {
        stageBasename: artifactBasename(mutation.target, token, index, 'stage'),
      }),
      ...(before.exists ? {
        backupBasename: artifactBasename(mutation.target, token, index, 'backup'),
      } : {}),
    };
  });
  owner.entries = entries.map(({ target, parentExisted, stageBasename, backupBasename }) =>
    ({ target, parentExisted, ...(stageBasename === undefined ? {} : { stageBasename }),
      ...(backupBasename === undefined ? {} : { backupBasename }) }));
  if (!validateOwner(owner)) throw new ConfigGraphTransactionError('invalid generated transaction owner record');
  let ownerPublished = false;
  let journalPublished = false;
  try {
    publishNoReplace(ownerPath(options.bootstrapFile, token), serialize(owner), token, deps, 'owner',
      () => { ownerPublished = true; });
    checkpoint(deps, 'owner_published');

    for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const mutation = normalized[index];
    const target = targetPath(options.bootstrapFile, current.configDir, entry.target);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.stageBasename) {
      writeDurable(artifactPath(options.bootstrapFile, current.configDir, entry.target, entry.stageBasename),
        mutation.contents!, true);
      checkpoint(deps, `stage_file_fsynced:${index}`);
      fsyncDirectory(dirname(target));
      checkpoint(deps, `stage_fsynced:${index}`);
    }
    if (entry.backupBasename) {
      const live = secureRead(target);
      if (!truthMatches({ exists: true, sha256: sha256(live.bytes), size: live.bytes.length, identity: live.identity },
        entry.before, true))
        throw new ConfigGraphTransactionError(`${target}: changed before backup copy`);
      writeDurable(artifactPath(options.bootstrapFile, current.configDir, entry.target, entry.backupBasename),
        live.bytes, true);
      checkpoint(deps, `backup_file_fsynced:${index}`);
      fsyncDirectory(dirname(target));
      checkpoint(deps, `backup_fsynced:${index}`);
    }
    }
    const journal: Journal = {
    ...owner, phase: 'prepared', direction: null,
    expectedDigest: options.expectedDigest, beforeDigest: current.digest, afterDigest: proposed.digest, entries,
    };
    if (!validateJournal(journal)) throw new ConfigGraphTransactionError('invalid generated transaction journal');
    publishNoReplace(journalPath(options.bootstrapFile), serialize(journal), token, deps, 'journal',
      () => { journalPublished = true; });
    checkpoint(deps, 'journal_prepared');
    journal.phase = 'installing'; journal.direction = 'forward';
    replaceDurable(journalPath(options.bootstrapFile), serialize(journal), token, deps, 'journal_installing');
    checkpoint(deps, 'journal_installing');
    installForward(options.bootstrapFile, current.configDir, journal, deps, true);
    journal.phase = 'installed';
    replaceDurable(journalPath(options.bootstrapFile), serialize(journal), token, deps, 'journal_installed');
    const visible = loadConfigResourceSnapshot({
      bootstrapFile: options.bootstrapFile, validateBrain: options.validateBrain,
    });
    if (visible.digest !== proposed.digest)
      throw new ConfigGraphTransactionError(
        `visible graph digest ${visible.digest} does not match proposed ${proposed.digest}`);
    journal.phase = 'committed';
    replaceDurable(journalPath(options.bootstrapFile), serialize(journal), token, deps, 'journal_committed');
    checkpoint(deps, 'journal_committed');
    cleanupCommitted(options.bootstrapFile, current.configDir, journal, deps);
    return visible;
  } catch (primaryError) {
    if (ownerPublished && !journalPublished && !(primaryError instanceof ConfigGraphSimulatedCrash)) {
      try { cleanupOwnedPreJournal(options.bootstrapFile, current.configDir, owner, deps); }
      catch (cleanupError) {
        const retainedPaths = (cleanupError as Error & { retainedPaths?: string[] }).retainedPaths ?? [];
        throw new ConfigGraphTransactionCleanupError(primaryError, cleanupError, retainedPaths);
      }
    }
    throw primaryError;
  }
}

function installForward(
  bootstrap: string, configDir: string, journal: Journal, deps: ConfigGraphTransactionDeps,
  requireBeforeIdentity = false,
): void {
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index];
    const target = targetPath(bootstrap, configDir, entry.target);
    const visible = truth(target);
    if (truthMatches(visible, entry.after)) continue;
    if (!truthMatches(visible, entry.before, requireBeforeIdentity))
      throw new ConfigGraphTransactionError(`${target}: changed before visible mutation`);
    if (entry.operation === 'delete') unlinkSync(target);
    else {
      const stage = artifactPath(bootstrap, configDir, entry.target, entry.stageBasename!);
      if (!truthMatches(artifactTruth(stage), entry.after))
        throw new ConfigGraphTransactionError(`${stage}: staged bytes do not match journal`);
      renameSync(stage, target);
    }
    checkpoint(deps, `visible_renamed:${index}`);
    fsyncDirectory(dirname(target));
    checkpoint(deps, `visible_installed:${index}`);
  }
}

function cleanupCommitted(
  bootstrap: string, configDir: string, journal: Journal, deps: ConfigGraphTransactionDeps = {},
): void {
  const dirs = new Set<string>();
  for (const entry of journal.entries) {
    const target = targetPath(bootstrap, configDir, entry.target);
    dirs.add(dirname(target));
    for (const artifact of [entry.stageBasename, entry.backupBasename]) {
      if (artifact) rmSync(artifactPath(bootstrap, configDir, entry.target, artifact), { force: true });
    }
    rmSync(artifactPath(bootstrap, configDir, entry.target,
      restoreBasename(entry.target, journal.token, journal.entries.indexOf(entry))), { force: true });
    checkpoint(deps, `cleanup_entry:${targetKey(entry.target)}`);
  }
  rmSync(ownerPath(bootstrap, journal.token), { force: true });
  checkpoint(deps, 'cleanup_owner');
  for (const dir of dirs) fsyncDirectory(dir);
  checkpoint(deps, 'cleanup_directories_fsynced');
  rmSync(journalPath(bootstrap));
  checkpoint(deps, 'cleanup_journal_removed');
  fsyncDirectory(dirname(bootstrap));
}

export async function recoverConfigGraphTransaction(options: {
  bootstrapFile: string;
  validateBrain?: BrainValidationHook;
  deps?: ConfigGraphTransactionDeps;
}): Promise<void> {
  const bootstrap = resolve(options.bootstrapFile);
  try {
    await withConfigGraphLock(bootstrap, 'exclusive', () =>
      recoverConfigGraphTransactionLocked(bootstrap, options.validateBrain, options.deps));
  } catch (error) {
    if (error instanceof ConfigGraphTransactionError || error instanceof ConfigGraphLockError) throw error;
    throw new ConfigGraphTransactionError(`configuration graph recovery failed: ${fsReason(error)}`);
  }
}

/** Recover first, then take a shared lease for one immutable graph read. */
export async function loadConsistentConfigResourceSnapshot(options: {
  bootstrapFile: string;
  validateBrain?: BrainValidationHook;
  deps?: ConfigGraphTransactionDeps;
}): Promise<ConfigResourceSnapshot> {
  const bootstrap = resolve(options.bootstrapFile);
  await recoverConfigGraphTransaction(options);
  try {
    return await withConfigGraphLock(bootstrap, 'shared', () => loadConfigResourceSnapshot({
      bootstrapFile: bootstrap, validateBrain: options.validateBrain,
    }));
  } catch (error) {
    if (error instanceof ConfigGraphLockError) throw error;
    throw new ConfigGraphTransactionError(`consistent graph read failed: ${fsReason(error)}`);
  }
}

async function recoverConfigGraphTransactionLocked(
  bootstrap: string, validateBrain?: BrainValidationHook, deps: ConfigGraphTransactionDeps = {},
): Promise<void> {
  const path = journalPath(bootstrap);
  let journal: Journal;
  try { journal = readJsonFile<Journal>(path, MAX_JOURNAL_BYTES); }
  catch (error) {
    if ((error as Error).message.includes('ENOENT')) {
      cleanupPreJournalOrphans(bootstrap, deps);
      return;
    }
    throw error;
  }
  if (!validateJournal(journal)) throw new ConfigGraphTransactionError(`${path}: invalid journal schema`);
  cleanupJournalTemps(bootstrap, journal.token);
  const configDir = resolveConfigResourceDirectory(bootstrap, secureRead(bootstrap).bytes);
  if (journal.phase === 'committed') {
    cleanupCommitted(bootstrap, configDir, journal, deps);
    return;
  }
  const direction = journal.direction ?? chooseRecoveryDirection(bootstrap, configDir, journal);
  journal.direction = direction;
  journal.phase = 'installing';
  replaceDurable(path, serialize(journal), journal.token, deps, 'recovery_direction');
  if (direction === 'forward') installForward(bootstrap, configDir, journal, deps);
  else installRollback(bootstrap, configDir, journal, deps);
  if (direction === 'forward') {
    const visible = loadConfigResourceSnapshot({ bootstrapFile: bootstrap, validateBrain });
    if (visible.digest !== journal.afterDigest)
      throw new ConfigGraphTransactionError('recovered forward graph digest mismatch');
    journal.phase = 'committed';
    replaceDurable(path, serialize(journal), journal.token, deps, 'recovery_committed');
    cleanupCommitted(bootstrap, visible.configDir, journal, deps);
  } else {
    const visible = loadConfigResourceSnapshot({ bootstrapFile: bootstrap, validateBrain });
    if (visible.digest !== journal.beforeDigest)
      throw new ConfigGraphTransactionError('recovered rollback graph digest mismatch');
    journal.phase = 'committed';
    replaceDurable(path, serialize(journal), journal.token, deps, 'recovery_committed');
    cleanupCommitted(bootstrap, visible.configDir, journal, deps);
  }
}

function cleanupJournalTemps(bootstrap: string, token: string): void {
  const directory = dirname(bootstrap);
  const base = basename(journalPath(bootstrap));
  for (const name of readdirSync(directory)) {
    if (name !== `${base}.publish.${token}` && name !== `${base}.replace.${token}`) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600
        || stat.size > MAX_JOURNAL_BYTES)
      throw new ConfigGraphTransactionError(`${path}: unsafe journal temp evidence`);
    rmSync(path);
  }
  fsyncDirectory(directory);
}

function chooseRecoveryDirection(bootstrap: string, configDir: string, journal: Journal): 'forward' | 'rollback' {
  const forward = journal.entries.every(entry => {
    const target = targetPath(bootstrap, configDir, entry.target);
    const visible = truth(target);
    if (truthMatches(visible, entry.after)) return true;
    if (!truthMatches(visible, entry.before)) return false;
    if (entry.operation === 'delete') return !!entry.backupBasename
      && truthMatches(artifactTruth(artifactPath(bootstrap, configDir, entry.target, entry.backupBasename)), entry.before);
    return !!entry.stageBasename
      && truthMatches(artifactTruth(artifactPath(bootstrap, configDir, entry.target, entry.stageBasename)), entry.after)
      && (!entry.before.exists || (!!entry.backupBasename
        && truthMatches(artifactTruth(artifactPath(bootstrap, configDir, entry.target, entry.backupBasename)), entry.before)));
  });
  if (forward) return 'forward';
  const rollback = journal.entries.every(entry => {
    const visible = truth(targetPath(bootstrap, configDir, entry.target));
    if (!truthMatches(visible, entry.before) && !truthMatches(visible, entry.after)) return false;
    if (!entry.before.exists) return true;
    return !!entry.backupBasename
      && truthMatches(artifactTruth(artifactPath(bootstrap, configDir, entry.target, entry.backupBasename)), entry.before);
  });
  if (rollback) return 'rollback';
  throw new ConfigGraphTransactionError('journal evidence proves neither complete forward nor complete rollback');
}

function installRollback(
  bootstrap: string, configDir: string, journal: Journal, deps: ConfigGraphTransactionDeps,
): void {
  for (let index = 0; index < journal.entries.length; index++) {
    const entry = journal.entries[index];
    const target = targetPath(bootstrap, configDir, entry.target);
    const visible = truth(target);
    if (truthMatches(visible, entry.before)) continue;
    if (!truthMatches(visible, entry.after))
      throw new ConfigGraphTransactionError(`${target}: changed before rollback mutation`);
    if (!entry.before.exists) rmSync(target, { force: true });
    else {
      const backup = artifactPath(bootstrap, configDir, entry.target, entry.backupBasename!);
      if (!truthMatches(artifactTruth(backup), entry.before))
        throw new ConfigGraphTransactionError(`${backup}: rollback backup mismatch`);
      const restore = artifactPath(bootstrap, configDir, entry.target,
        restoreBasename(entry.target, journal.token, index));
      if (artifactTruth(restore).exists) {
        if (!truthMatches(artifactTruth(restore), entry.before))
          throw new ConfigGraphTransactionError(`${restore}: rollback restore mismatch`);
      } else {
        writeDurable(restore, secureRead(backup, MAX_FILE_BYTES, 0o600).bytes, true);
      }
      checkpoint(deps, `rollback_restore_fsynced:${index}`);
      renameSync(restore, target);
      checkpoint(deps, `rollback_renamed:${index}`);
    }
    fsyncDirectory(dirname(target));
    checkpoint(deps, `rollback_installed:${index}`);
  }
}

function cleanupPreJournalOrphans(bootstrap: string, deps: ConfigGraphTransactionDeps): void {
  const directory = dirname(bootstrap);
  const prefix = ownerPrefix(bootstrap);
  const now = deps.now ?? Date.now;
  const state = deps.processState ?? probeProcessState;
  const journalBase = basename(journalPath(bootstrap));
  for (const name of readdirSync(directory).filter(name => name.startsWith(`${journalBase}.publish.`))) {
    const path = join(directory, name);
    const token = name.slice(`${journalBase}.publish.`.length);
    if (!validToken(token)) throw new ConfigGraphTransactionError(`${path}: invalid journal publication temp name`);
    let candidate: Journal;
    try { candidate = readJsonFile<Journal>(path, MAX_JOURNAL_BYTES); }
    catch (error) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600
          || stat.size > MAX_JOURNAL_BYTES) throw error;
      if (now() - stat.mtimeMs >= 30_000) { rmSync(path); continue; }
      throw error;
    }
    if (!validateJournal(candidate) || candidate.token !== token)
      throw new ConfigGraphTransactionError(`${path}: invalid journal publication temp`);
    const liveness = state(candidate.pid, candidate.fingerprint);
    if (liveness === 'unknown') throw new ConfigGraphTransactionError(`${path}: owner liveness unknown`);
    if (liveness !== 'same' && now() - candidate.createdAt >= 30_000) rmSync(path);
  }
  const configDir = resolveConfigResourceDirectory(bootstrap, secureRead(bootstrap).bytes);
  const owners = readdirSync(directory).filter(name => name.startsWith(prefix)).flatMap(name => {
    const path = join(directory, name);
    const publication = name.includes('.json.publish.');
    let owner: OwnerRecord;
    try { owner = readJsonFile<OwnerRecord>(path, MAX_JOURNAL_BYTES); }
    catch (error) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600
          || stat.size > MAX_JOURNAL_BYTES) throw error;
      if (publication && now() - stat.mtimeMs >= 30_000) { rmSync(path); return []; }
      throw error;
    }
    const publicName = `${prefix}${owner.token}.json`;
    if (!validateOwner(owner)
        || (name !== publicName && name !== `${publicName}.publish.${owner.token}`))
      throw new ConfigGraphTransactionError(`${path}: invalid owner schema or private name`);
    return [{ path, owner }];
  });
  const knownArtifacts = new Set<string>();
  for (const { owner } of owners) {
    for (const entry of owner.entries) {
      for (const artifact of [entry.stageBasename, entry.backupBasename]) {
        if (artifact) knownArtifacts.add(artifactPath(bootstrap, configDir, entry.target, artifact));
      }
    }
  }
  for (const { path, owner } of owners) {
    const liveness = state(owner.pid, owner.fingerprint);
    if (liveness === 'unknown') throw new ConfigGraphTransactionError(`${path}: owner liveness unknown`);
    if (liveness === 'same' || now() - owner.createdAt < 30_000) continue;
    // The owner record restricts every artifact to a logical allowlisted target.
    for (const entry of owner.entries) {
      for (const artifact of [entry.stageBasename, entry.backupBasename]) {
        if (artifact) rmSync(artifactPath(bootstrap, configDir, entry.target, artifact), { force: true });
      }
      if (!entry.parentExisted && entry.target.scope === 'resource') {
        const parent = dirname(targetPath(bootstrap, configDir, entry.target));
        if (directoryExists(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
      }
    }
    rmSync(path);
    fsyncDirectory(directory);
  }
  const artifactDirectories = [directory, ...TYPED_DIRECTORIES.map(name => join(configDir, name))];
  for (const artifactDirectory of artifactDirectories) {
    if (!directoryExists(artifactDirectory)) continue;
    for (const name of readdirSync(artifactDirectory).filter(isArtifactBasename)) {
      const path = join(artifactDirectory, name);
      if (!knownArtifacts.has(path))
        throw new ConfigGraphTransactionError(`${path}: unmatched transaction artifact requires manual repair`);
    }
  }
}
