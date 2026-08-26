import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const META_LIMIT = 4096;

export type ConfigGraphLockMode = 'shared' | 'exclusive';
export type ProcessState = 'same' | 'dead' | 'reused' | 'unknown';

export interface ConfigGraphLockDeps {
  now?(): number;
  randomUUID?(): string;
  sleep?(ms: number): Promise<void>;
  processFingerprint?(pid: number): string;
  processState?(pid: number, fingerprint: string): ProcessState;
  processId?(): number;
  beforePromote?(): void | Promise<void>;
  afterPromoteLink?(): void | Promise<void>;
  afterGateTempCreated?(path: string): void | Promise<void>;
  afterLeaseLink?(path: string): void;
  beforeReleaseQuarantine?(path: string): void;
}

export interface ConfigGraphLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  deps?: ConfigGraphLockDeps;
}

interface Owner { schema: 1; token: string; pid: number; fingerprint: string; createdAt: number }

export class ConfigGraphLockError extends Error {}
export class ConfigGraphLockCleanupError extends ConfigGraphLockError {
  constructor(readonly leasePaths: readonly string[], cause: unknown) {
    super(`graph lock cleanup failed; recoverable lease state retained at ${leasePaths.join(', ')}: ${String(cause)}`);
  }
}

export function configGraphLockPath(bootstrapFile: string): string {
  return `${resolve(bootstrapFile)}.graph-lock`;
}

function validOwner(value: unknown): value is Owner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'createdAt,fingerprint,pid,schema,token'
    && v.schema === 1 && typeof v.token === 'string' && /^[a-f0-9-]{8,}$/iu.test(v.token)
    && Number.isInteger(v.pid) && (v.pid as number) > 0
    && typeof v.fingerprint === 'string' && v.fingerprint.length > 0 && v.fingerprint.length <= 512
    && Number.isSafeInteger(v.createdAt) && (v.createdAt as number) >= 0;
}

function assertSecureComponents(path: string): void {
  const absolute = resolve(path);
  const root = absolute.startsWith(sep) ? sep : '';
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new ConfigGraphLockError(`symlink lock path component is forbidden: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof ConfigGraphLockError) throw error;
      throw new ConfigGraphLockError(`cannot inspect lock path component ${cursor}`);
    }
  }
}

function defaultFingerprint(pid: number): string {
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const start = stat.slice(close + 2).split(' ')[19];
    if (!boot || !start) throw new Error('missing process identity');
    return `${boot}:${start}`;
  } catch { throw new ConfigGraphLockError('process birth fingerprint unavailable'); }
}

export function probeProcessState(pid: number, expected: string): ProcessState {
  try { process.kill(pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'same';
    return 'unknown';
  }
  try { return defaultFingerprint(pid) === expected ? 'same' : 'reused'; }
  catch { return 'unknown'; }
}

function readOwner(path: string): Owner {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new ConfigGraphLockError('secure lock metadata open unavailable: O_NOFOLLOW is required');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new ConfigGraphLockError(`cannot securely open lock metadata: ${path}`); }
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > META_LIMIT || (stat.mode & 0o777) !== 0o600)
      throw new ConfigGraphLockError(`unsafe or oversized lock metadata: ${path}`);
    value = JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error instanceof ConfigGraphLockError) throw error;
    throw new ConfigGraphLockError(`malformed lock metadata: ${path}`);
  } finally { closeSync(fd); }
  if (!validOwner(value)) throw new ConfigGraphLockError(`invalid lock metadata schema: ${path}`);
  return value;
}

function writeOwnerFile(path: string, owner: Owner): void {
  if (typeof constants.O_NOFOLLOW !== 'number')
    throw new ConfigGraphLockError('secure lock metadata open unavailable: O_NOFOLLOW is required');
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new ConfigGraphLockError('lock metadata write made no progress');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

function publishLease(
  root: string, path: string, owner: Owner, onPublished: () => void, deps: ConfigGraphLockDeps,
): void {
  const claim = join(root, `.lease-tmp.${owner.token}`);
  try {
    writeOwnerFile(claim, owner);
    linkSync(claim, path);
    onPublished();
    deps.afterLeaseLink?.(path);
  }
  finally { rmSync(claim, { force: true }); }
}

function readGateOwner(path: string): Owner {
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new ConfigGraphLockError(`cannot inspect graph lock gate: ${path}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700)
    throw new ConfigGraphLockError(`unsafe graph lock gate: ${path}`);
  return readOwner(join(path, 'owner.json'));
}

class CallbackFailure { constructor(readonly error: unknown) {} }

export async function withConfigGraphLock<T>(
  bootstrapFile: string, mode: ConfigGraphLockMode, fn: () => T | Promise<T>,
  options: ConfigGraphLockOptions = {},
): Promise<T> {
  try { return await withConfigGraphLockInternal(bootstrapFile, mode, fn, options); }
  catch (error) {
    if (error instanceof CallbackFailure) throw error.error;
    if (error instanceof ConfigGraphLockError) throw error;
    const value = error as NodeJS.ErrnoException;
    throw new ConfigGraphLockError(
      `graph lock protocol failure${value.code ? ` (${value.code})` : ''}: ${String(error)}`);
  }
}

async function withConfigGraphLockInternal<T>(
  bootstrapFile: string, mode: ConfigGraphLockMode, fn: () => T | Promise<T>,
  options: ConfigGraphLockOptions,
): Promise<T> {
  const deps = options.deps ?? {};
  const now = deps.now ?? Date.now;
  const uuid = deps.randomUUID ?? randomUUID;
  const sleep = deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const fingerprint = deps.processFingerprint ?? defaultFingerprint;
  const state = deps.processState ?? probeProcessState;
  const timeout = options.timeoutMs ?? 10_000;
  const stale = options.staleMs ?? 30_000;
  const poll = options.pollMs ?? 25;
  if (mode !== 'shared' && mode !== 'exclusive')
    throw new ConfigGraphLockError(`invalid graph lock mode: ${String(mode)}`);
  if (![timeout, stale, poll].every(value => Number.isSafeInteger(value) && value > 0))
    throw new ConfigGraphLockError('graph lock timeout, stale threshold, and poll interval must be positive integers');
  const started = now();
  const root = configGraphLockPath(bootstrapFile);
  const gate = join(root, 'gate');
  const readers = join(root, 'readers');
  const intent = join(root, 'writer-intent.json');
  const active = join(root, 'writer-active.json');
  const pid = (deps.processId ?? (() => process.pid))();
  const owner: Owner = { schema: 1, token: uuid(), pid, fingerprint: fingerprint(pid), createdAt: now() };
  if (!validOwner(owner)) throw new ConfigGraphLockError('invalid local graph lock owner identity');
  const reader = join(readers, `${owner.token}.json`);
  assertSecureComponents(dirname(root));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertSecureComponents(root);
  chmodSync(root, 0o700);
  mkdirSync(readers, { mode: 0o700, recursive: true });
  assertSecureComponents(readers);
  chmodSync(readers, 0o700);

  const checkStop = (): void => {
    if (options.signal?.aborted) throw new ConfigGraphLockError('graph lock acquisition aborted');
    if (now() - started >= timeout) throw new ConfigGraphLockError('graph lock acquisition timed out');
  };
  const waitForRetry = async (): Promise<void> => {
    checkStop();
    const remaining = Math.max(1, timeout - (now() - started));
    await sleep(Math.min(poll, remaining));
  };
  const cleanPrivateTemps = (): void => {
    for (const name of readdirSync(root).filter(name =>
      name.startsWith('.gate-tmp.') || name.startsWith('.lease-tmp.') || name.startsWith('.release-tmp.'))) {
      const path = join(root, name);
      const stat = lstatSync(path);
      const gateTemp = name.startsWith('.gate-tmp.');
      if (stat.isSymbolicLink()
          || (gateTemp ? !stat.isDirectory() || (stat.mode & 0o777) !== 0o700
            : !stat.isFile() || (stat.mode & 0o777) !== 0o600))
        throw new ConfigGraphLockError(`unsafe private gate temp: ${path}`);
      const metadata = gateTemp ? join(path, 'owner.json') : path;
      let held: Owner | undefined;
      try { held = readOwner(metadata); }
      catch (error) {
        // A private temp can be between creation and metadata publication. It
        // is non-authoritative; retain it for the full initialization window.
        if (now() - stat.mtimeMs < stale) continue;
        if (!(error instanceof ConfigGraphLockError)) throw error;
      }
      if (held) {
        const liveness = state(held.pid, held.fingerprint);
        if (liveness === 'unknown')
          throw new ConfigGraphLockError(`private temp owner liveness cannot be proven: ${path}`);
        if (liveness === 'same' || now() - held.createdAt < stale) continue;
      }
      rmSync(path, { recursive: gateTemp, force: true });
    }
  };
  const acquireGate = async (): Promise<void> => {
    for (;;) {
      checkStop();
      cleanPrivateTemps();
      if (existsSafe(gate)) {
        const held = readGateOwner(gate);
        const liveness = state(held.pid, held.fingerprint);
        if (now() - held.createdAt >= stale && (liveness === 'dead' || liveness === 'reused')) {
          const quarantine = `${gate}.reap.${owner.token}.${held.token}`;
          try { renameSync(gate, quarantine); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new ConfigGraphLockError(`cannot quarantine stale graph lock gate: ${String(error)}`);
          }
          const quarantined = readGateOwner(quarantine);
          if (quarantined.token !== held.token)
            throw new ConfigGraphLockError('stale graph lock gate identity changed during reclaim');
          rmSync(quarantine, { recursive: true });
          continue;
        }
        if (liveness === 'unknown') throw new ConfigGraphLockError('gate owner liveness cannot be proven');
        await waitForRetry();
        continue;
      }
      const claim = join(root, `.gate-tmp.${owner.token}`);
      try {
        mkdirSync(claim, { mode: 0o700 });
        await deps.afterGateTempCreated?.(claim);
        writeOwnerFile(join(claim, 'owner.json'), owner);
        renameSync(claim, gate);
        return;
      } catch (error) {
        rmSync(claim, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw new ConfigGraphLockError(`cannot acquire graph lock gate: ${String(error)}`);
        const held = readGateOwner(gate);
        const liveness = state(held.pid, held.fingerprint);
        if (now() - held.createdAt >= stale && (liveness === 'dead' || liveness === 'reused')) {
          const quarantine = `${gate}.reap.${owner.token}.${held.token}`;
          try { renameSync(gate, quarantine); }
          catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new ConfigGraphLockError(`cannot quarantine stale graph lock gate: ${String(renameError)}`);
          }
          const quarantined = readGateOwner(quarantine);
          if (quarantined.token !== held.token)
            throw new ConfigGraphLockError('stale graph lock gate identity changed during reclaim');
          rmSync(quarantine, { recursive: true });
          continue;
        }
        if (liveness === 'unknown') throw new ConfigGraphLockError('gate owner liveness cannot be proven');
        await waitForRetry();
      }
    }
  };
  const releaseGate = (): void => {
    const held = readGateOwner(gate);
    if (held.token !== owner.token) throw new ConfigGraphLockError('graph lock gate ownership mismatch');
    rmSync(gate, { recursive: true });
  };
  const staleLease = (path: string): boolean => {
    const held = readOwner(path);
    const liveness = state(held.pid, held.fingerprint);
    if (liveness === 'unknown') throw new ConfigGraphLockError(`lease owner liveness cannot be proven: ${path}`);
    return now() - held.createdAt >= stale && (liveness === 'dead' || liveness === 'reused');
  };
  const cleanReaders = (): string[] => {
    const names = readFileNames(readers);
    for (const name of names) {
      const path = join(readers, name);
      if (staleLease(path)) rmSync(path);
    }
    return readFileNames(readers);
  };
  const cleanWriterLease = (path: string): void => {
    if (existsSafe(path) && staleLease(path)) rmSync(path);
  };
  const ownedPaths = new Set<string>();
  let releaseSequence = 0;
  const releaseOwned = (path: string): void => {
    if (!existsSafe(path)) return;
    const held = readOwner(path);
    if (held.token !== owner.token)
      throw new ConfigGraphLockError('graph lock release ownership mismatch');
    deps.beforeReleaseQuarantine?.(path);
    const quarantine = join(root, `.release-tmp.${owner.token}.${++releaseSequence}`);
    try { renameSync(path, quarantine); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const moved = readOwner(quarantine);
    if (moved.token !== owner.token) {
      try { linkSync(quarantine, path); } catch { /* fail closed with quarantine retained */ }
      throw new ConfigGraphLockError('graph lock identity changed during release');
    }
    rmSync(quarantine);
  };
  try {
    if (mode === 'shared') {
      for (;;) {
        await acquireGate();
        try {
          cleanReaders();
          cleanWriterLease(intent);
          cleanWriterLease(active);
          if (!existsSafe(intent) && !existsSafe(active)) {
            publishLease(root, reader, owner, () => ownedPaths.add(reader), deps); break;
          }
        } finally { releaseGate(); }
        await waitForRetry();
      }
    } else {
      for (;;) {
        await acquireGate();
        try {
          cleanWriterLease(intent);
          cleanWriterLease(active);
          if (!existsSafe(intent) && !existsSafe(active)) {
            publishLease(root, intent, owner, () => ownedPaths.add(intent), deps); break;
          }
        } finally { releaseGate(); }
        await waitForRetry();
      }
      for (;;) {
        checkStop();
        await acquireGate();
        try {
          const held = readOwner(intent);
          if (held.token !== owner.token) throw new ConfigGraphLockError('writer intent ownership mismatch');
          if (cleanReaders().length === 0 && !existsSafe(active)) {
            await deps.beforePromote?.();
            linkSync(intent, active);
            ownedPaths.add(active);
            await deps.afterPromoteLink?.();
            unlinkSync(intent);
            ownedPaths.delete(intent);
            break;
          }
        } finally { releaseGate(); }
        await waitForRetry();
      }
    }
    try { return await fn(); }
    catch (error) { throw new CallbackFailure(error); }
  } finally {
    try {
      for (const ownedPath of ownedPaths) releaseOwned(ownedPath);
    } catch (error) {
      const retained = [...ownedPaths].filter(existsSafe);
      throw new ConfigGraphLockCleanupError(retained, error);
    }
  }
}

function existsSafe(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function readFileNames(directory: string): string[] {
  return requireDirectoryNames(directory);
}

function requireDirectoryNames(directory: string): string[] {
  return readdirSync(directory).sort().map(name => {
    if (!/^[a-f0-9-]{8,}\.json$/iu.test(name))
      throw new ConfigGraphLockError(`unexpected reader lease entry: ${name}`);
    return name;
  });
}
