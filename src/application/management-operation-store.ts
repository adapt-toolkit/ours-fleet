import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ManagementResponse } from './management-contract.js';
import { withConfigGraphLock, type ConfigGraphLockOptions } from '../config-graph-lock.js';

export type ManagementOperationPhase = 'prepared' | 'effecting' | 'completed' | 'failed';
export interface ManagementOperationRecord {
  version: 1; keyHash: string; requestHash: string; phase: ManagementOperationPhase;
  /** Exact authenticated principal binding; prevents cross-surface/key probing replay. */
  principalHash?: string;
  createdAt: string; updatedAt: string; response?: ManagementResponse;
  /** Exact durable lifecycle checkpoint; never inferred from mutable current state. */
  checkpoint?: Readonly<{ operation: string; resourceVersion?: string; priorGeneration?: number;
    targetGeneration?: number; actionId?: string; planDigest?: string; snapshotDigest?: string }>;
}

const HEX = /^[a-f0-9]{64}$/u;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
};
export const managementDigest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

export class ManagementOperationStore {
  readonly #dir: string;
  constructor(dir: string, private readonly lockOptions: ConfigGraphLockOptions = {}, private readonly hooks: {
    beforeWrite?(record: Readonly<ManagementOperationRecord>): void;
  } = {}) {
    this.#dir = resolve(dir); mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.#dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
      throw new Error('unsafe operation directory');
  }
  path(keyHash: string): string {
    if (!HEX.test(keyHash)) throw new TypeError('invalid operation key hash');
    return join(this.#dir, `${keyHash}.json`);
  }
  /** Cross-process admission and phase transaction for one idempotency key. */
  exclusive<T>(keyHash: string, transaction: () => T | Promise<T>): Promise<T> {
    this.path(keyHash);
    return withConfigGraphLock(join(this.#dir, `.lock-${keyHash}`), 'exclusive', transaction, this.lockOptions);
  }
  read(keyHash: string): Readonly<ManagementOperationRecord> | undefined {
    const path = this.path(keyHash);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024)
        throw new Error('unsafe operation record');
      const value = JSON.parse(readFileSync(path, 'utf8')) as ManagementOperationRecord;
      if (value.version !== 1 || value.keyHash !== keyHash || !HEX.test(value.requestHash)
          || (value.principalHash !== undefined && !HEX.test(value.principalHash))
          || !['prepared', 'effecting', 'completed', 'failed'].includes(value.phase))
        throw new Error('invalid operation record');
      return Object.freeze(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  write(record: ManagementOperationRecord): void {
    this.hooks.beforeWrite?.(record);
    const path = this.path(record.keyHash); const temp = join(this.#dir, `.${record.keyHash}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(`${canonical(record)}\n`); let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
      const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!fstatSync(dir).isDirectory()) throw new Error('unsafe operation directory'); fsyncSync(dir); }
      finally { closeSync(dir); }
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
  }
}
