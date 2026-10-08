import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, readFileSync, readdirSync, lstatSync, openSync, fstatSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import { openDirectory, MAX_FILE_BYTES } from './reader.js';
import type { DeliveredFile, FileDeliveryBinding } from './types.js';

export function artifactDirectory(stateDir: string): string {
  const incarnation = readFileSync(join(stateDir, '.session-id'), 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(incarnation)) throw Error('INVALID_ROLE_INCARNATION');
  const key = createHash('sha256').update(JSON.stringify([stateDir, incarnation])).digest('hex');
  return join(stateRoot(), 'private-file-delivery', key);
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw Error('INVALID_ARTIFACT_DIRECTORY');
}
export class ArtifactStore {
  constructor(private readonly stateDir: string) {}
  async copy(source: { size: number; body: ReadableStream<Uint8Array>; close(): Promise<void> }, name: string, mimeType: string, binding: FileDeliveryBinding, signal: AbortSignal): Promise<DeliveredFile> {
    if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_FILE_BYTES) throw Error('FILE_EXCEEDS_20_MIB');
    const path = artifactDirectory(this.stateDir);
    privateDirectory(join(stateRoot(), 'private-file-delivery')); privateDirectory(path);
    const root = await openDirectory(path);
    const id = randomUUID(), base = `/proc/self/fd/${root.fd}/`, partial = base + id + '.part';
    let file: Awaited<ReturnType<typeof open>> | undefined;
    const reader = source.body.getReader();
    try {
      // Orphans count toward the same bounded quota. They are never republished.
      const entries = readdirSync(base).filter(p => /\.(data|part)$/.test(p));
      const bytes = entries.reduce((sum, p) => sum + lstatSync(base + p).size, 0);
      if (entries.length >= 100 || bytes + source.size > 200 * 1024 * 1024) throw Error('ARTIFACT_QUOTA_EXCEEDED');
      file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256'); let size = 0;
      for (;;) {
        signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > source.size || size > MAX_FILE_BYTES) throw Error('SOURCE_SIZE_CHANGED');
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.length) {
          const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.length - offset);
          if (!bytesWritten) throw Error('SHORT_ARTIFACT_WRITE'); offset += bytesWritten;
        }
      }
      if (size !== source.size) throw Error('SOURCE_SIZE_CHANGED');
      signal.throwIfAborted(); await file.chmod(0o400); await file.sync(); await file.close(); file = undefined;
      const record: DeliveredFile = { id, name, mimeType, size, sha256: hash.digest('hex'), ...binding };
      renameSync(partial, base + id + '.data');
      writeFileSync(base + id + '.json', JSON.stringify(record), { flag: 'wx', mode: 0o400, flush: true });
      // No pending-send record or recovery: a later failure leaves only unreferenced stored bytes.
      await root.sync(); return record;
    } finally {
      await file?.close(); await reader.cancel().catch(() => {}); await source.close();
      await unlink(partial).catch(() => {}); await root.close();
    }
  }
}
export async function readDeliveredFile(stateDir: string, id: string): Promise<{ record: DeliveredFile; bytes: Buffer }> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('ARTIFACT_NOT_FOUND');
  const root = await openDirectory(artifactDirectory(stateDir));
  const read = (suffix: string, max: number) => {
    const fd = openSync(`/proc/self/fd/${root.fd}/${id}.${suffix}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > max) throw Error('INVALID_STORED_ARTIFACT');
      const bytes = readFileSync(fd); if (bytes.length > max) throw Error('ARTIFACT_TOO_LARGE'); return bytes;
    } finally { closeSync(fd); }
  };
  try {
    const record = JSON.parse(read('json', 4096).toString()) as DeliveredFile;
    const bytes = read('data', MAX_FILE_BYTES);
    if (record.id !== id || record.size !== bytes.length || record.sha256 !== createHash('sha256').update(bytes).digest('hex') || typeof record.name !== 'string') throw Error('ARTIFACT_INTEGRITY_FAILED');
    return { record, bytes };
  } finally { await root.close(); }
}
