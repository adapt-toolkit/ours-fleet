import {
  existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from './atomic-file.js';
import type { WorklogPolicy } from './config.js';

const ARCHIVE_RE = /^WORKLOG\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:\.\d+)?\.md$/;

export interface WorklogInspection {
  enabled: boolean;
  bytes: number;
  overLimit: boolean;
}

export interface WorklogRotation {
  rotated: boolean;
  deferred?: boolean;
  beforeBytes: number;
  afterBytes: number;
  archivePath?: string;
}

export function inspectWorklog(path: string, policy?: WorklogPolicy): WorklogInspection {
  const bytes = existsSync(path) ? statSync(path).size : 0;
  return {
    enabled: policy !== undefined,
    bytes,
    overLimit: policy !== undefined && bytes > policy.max_kb * 1024,
  };
}

const safeTailStart = (buffer: Buffer, wanted: number): number => {
  let start = Math.max(0, buffer.length - wanted);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  const newline = buffer.indexOf(0x0a, start);
  return newline >= 0 && newline + 1 < buffer.length ? newline + 1 : start;
};

const archiveName = (path: string, now: Date, collision: number): string => {
  const stamp = now.toISOString().replace(/:/g, '-');
  return join(dirname(path), `WORKLOG.${stamp}${collision ? `.${collision}` : ''}.md`);
};

export function pruneWorklogArchives(path: string, maxArchives: number): void {
  const dir = dirname(path);
  const archives = readdirSync(dir).filter(name => ARCHIVE_RE.test(name)).sort().reverse();
  for (const old of archives.slice(maxArchives)) rmSync(join(dir, old), { force: true });
}

/**
 * Conservatively rotate a stable snapshot. A changed size/mtime/inode aborts
 * before replacement; callers retry at the next fleet-owned lifecycle point.
 */
export function rotateWorklog(
  path: string,
  policy?: WorklogPolicy,
  deps: {
    now?: () => Date;
    beforeCommit?: () => void;
    /** Deterministic test hook for the rename→link commit window. */
    afterArchiveRename?: () => void;
  } = {},
): WorklogRotation {
  const inspection = inspectWorklog(path, policy);
  if (!policy || !inspection.overLimit)
    return { rotated: false, beforeBytes: inspection.bytes, afterBytes: inspection.bytes };
  const before = statSync(path);
  const content = readFileSync(path);
  const start = safeTailStart(content, policy.keep_tail_kb * 1024);
  const tail = content.subarray(start);
  deps.beforeCommit?.();
  const current = statSync(path);
  if (current.ino !== before.ino || current.size !== before.size
      || current.mtimeMs !== before.mtimeMs) {
    return {
      rotated: false, deferred: true,
      beforeBytes: before.size, afterBytes: current.size,
    };
  }
  let collision = 0;
  let archivePath = archiveName(path, deps.now?.() ?? new Date(), collision);
  while (existsSync(archivePath)) archivePath = archiveName(path, deps.now?.() ?? new Date(), ++collision);
  // Prepare the intended tail before moving the live inode. replaceFileAtomically
  // gives us a fully written/fsynced inode; hard-linking it below publishes that
  // inode without ever overwriting a path a concurrent appender may create.
  const preparedTail = join(dirname(path), `.${basename(path)}.${randomUUID()}.rotate`);
  replaceFileAtomically(preparedTail, tail.toString('utf8'), before.mode & 0o777);
  try {
    // Linearization point: the complete original inode becomes the archive.
    // Writers that opened before this rename keep appending to that inode, so
    // their acknowledged bytes remain in the archive even after the move.
    renameSync(path, archivePath);
    deps.afterArchiveRename?.();
    try {
      // Atomic create-without-overwrite. If a writer opened the missing path in
      // the rename→link window, it created the new live file; EEXIST means leave
      // that file untouched. The intended tail remains recoverable in the full
      // archive, and every concurrent suffix remains in the writer-created live.
      linkSync(preparedTail, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  } finally {
    rmSync(preparedTail, { force: true });
  }
  const liveBytes = existsSync(path) ? statSync(path).size : 0;
  const status = {
    schemaVersion: 1,
    rotatedAt: (deps.now?.() ?? new Date()).toISOString(),
    beforeBytes: before.size,
    afterBytes: liveBytes,
    archive: basename(archivePath),
    archiveContainsFullSnapshot: true,
  };
  replaceFileAtomically(join(dirname(path), '.worklog-rotation.json'), `${JSON.stringify(status, null, 2)}\n`);
  pruneWorklogArchives(path, policy.max_archives);
  return {
    rotated: true,
    beforeBytes: before.size,
    afterBytes: liveBytes,
    archivePath,
  };
}
