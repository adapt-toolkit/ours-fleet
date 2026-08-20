import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync,
  openSync, readdirSync, readFileSync, unlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';
import type { WorklogPolicy } from './config.js';

const ARCHIVE_RE = /^WORKLOG\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)(?:\.(\d+))?\.md$/;
export const WORKLOG_ARCHIVE_DIR = 'WORKLOG.archives';

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

type FileStat = Stats;

const entryStat = (path: string): FileStat | undefined => {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const requireRegularFile = (path: string, label: string): FileStat => {
  const stat = entryStat(path);
  if (!stat) throw new Error(`${label} disappeared before it could be preserved`);
  if (!stat.isFile()) {
    const kind = stat.isSymbolicLink() ? 'symbolic link' : 'non-regular file';
    throw new Error(`refusing worklog rotation: ${label} is a ${kind}`);
  }
  return stat;
};

const sameInode = (left: FileStat, right: FileStat): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameSnapshot = (left: FileStat, right: FileStat): boolean =>
  sameInode(left, right) && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const validateArchiveBoundary = (path: string): FileStat | undefined => {
  const archiveDir = join(dirname(path), WORKLOG_ARCHIVE_DIR);
  const stat = entryStat(archiveDir);
  if (stat && !stat.isDirectory()) {
    const kind = stat.isSymbolicLink() ? 'symbolic link' : 'non-directory';
    throw new Error(`refusing worklog retention: ${WORKLOG_ARCHIVE_DIR} is a ${kind}`);
  }
  return stat;
};

export function inspectWorklog(path: string, policy?: WorklogPolicy): WorklogInspection {
  const stat = entryStat(path);
  if (policy && stat && !stat.isFile()) {
    const kind = stat.isSymbolicLink() ? 'symbolic link' : 'non-regular file';
    throw new Error(`refusing worklog rotation: WORKLOG.md is a ${kind}`);
  }
  const bytes = stat?.isFile() ? stat.size : 0;
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

/**
 * Keep a bounded set of recent archives beside WORKLOG.md without deleting
 * history. Older archives move atomically-by-link into WORKLOG.archives/.
 * The legacy name remains exported for source compatibility.
 */
export function pruneWorklogArchives(path: string, maxArchives: number): void {
  const dir = dirname(path);
  const archives = readdirSync(dir).filter(name => ARCHIVE_RE.test(name)).sort((a, b) => {
    const left = ARCHIVE_RE.exec(a)!;
    const right = ARCHIVE_RE.exec(b)!;
    return left[1].localeCompare(right[1])
      || Number(left[2] ?? 0) - Number(right[2] ?? 0);
  }).reverse();
  const older = archives.slice(maxArchives);
  if (!older.length) return;
  const archiveDir = join(dir, WORKLOG_ARCHIVE_DIR);
  let boundary = validateArchiveBoundary(path);
  if (!boundary) {
    try { mkdirSync(archiveDir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    boundary = validateArchiveBoundary(path);
  }
  if (!boundary) throw new Error(`refusing worklog retention: ${WORKLOG_ARCHIVE_DIR} is unavailable`);
  for (const old of older) {
    const source = join(dir, old);
    const sourceBefore = requireRegularFile(source, `archive ${old}`);
    let collision = 0;
    for (;;) {
      const name = collision === 0 ? old : old.replace(/\.md$/, `.${collision}.md`);
      const target = join(archiveDir, name);
      try {
        const currentBoundary = validateArchiveBoundary(path);
        if (!currentBoundary || !sameInode(boundary, currentBoundary))
          throw new Error(`refusing worklog retention: ${WORKLOG_ARCHIVE_DIR} changed`);
        // Link then unlink: a crash can leave a duplicate, never lose the only
        // archive. EEXIST chooses a new name rather than overwriting history.
        linkSync(source, target);
        const published = requireRegularFile(target, `cold archive ${name}`);
        const sourceCurrent = requireRegularFile(source, `archive ${old}`);
        const finalBoundary = validateArchiveBoundary(path);
        if (!sameInode(sourceBefore, published) || !sameInode(sourceBefore, sourceCurrent)
            || !finalBoundary || !sameInode(boundary, finalBoundary)) {
          throw new Error(`refusing worklog retention: archive boundary changed during move`);
        }
        unlinkSync(source);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          collision++;
          continue;
        }
        throw error;
      }
    }
  }
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
    /** Deterministic test hook after the full archive is published. */
    afterArchiveRename?: () => void;
  } = {},
): WorklogRotation {
  const inspection = inspectWorklog(path, policy);
  if (!policy || !inspection.overLimit)
    return { rotated: false, beforeBytes: inspection.bytes, afterBytes: inspection.bytes };
  // Refuse a pre-existing symlink/non-directory even before publishing an
  // archive or replacing the live path. Cold retention must remain inside the
  // role's state boundary.
  validateArchiveBoundary(path);
  const pathBeforeOpen = requireRegularFile(path, 'WORKLOG.md');
  let fd: number | undefined;
  let before: FileStat;
  let content: Buffer;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    before = fstatSync(fd);
    if (!before.isFile() || !sameInode(pathBeforeOpen, before))
      throw new Error('refusing worklog rotation: WORKLOG.md changed while opening');
    content = readFileSync(fd);
    const afterRead = fstatSync(fd);
    if (!sameSnapshot(before, afterRead))
      return {
        rotated: false, deferred: true,
        beforeBytes: before.size, afterBytes: afterRead.size,
      };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const start = safeTailStart(content, policy.keep_tail_kb * 1024);
  const tail = content.subarray(start);
  const tailStartsMidLine = start > 0 && content[start - 1] !== 0x0a;
  deps.beforeCommit?.();
  const current = requireRegularFile(path, 'WORKLOG.md');
  if (!sameSnapshot(current, before)) {
    return {
      rotated: false, deferred: true,
      beforeBytes: before.size, afterBytes: current.size,
    };
  }
  const rotatedAt = deps.now?.() ?? new Date();
  let archivePath = '';
  // Publish the complete original inode under a collision-safe archive name.
  // link(2) is create-without-overwrite; concurrent appenders holding the old
  // inode continue into the archive after the live path is replaced.
  for (let collision = 0; ; collision++) {
    archivePath = archiveName(path, rotatedAt, collision);
    try {
      linkSync(path, archivePath);
      const published = requireRegularFile(archivePath, `archive ${basename(archivePath)}`);
      if (!sameInode(before, published)) {
        try { unlinkSync(archivePath); } catch { /* keep the primary safety failure */ }
        throw new Error('refusing worklog rotation: published archive is not the inspected file');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  deps.afterArchiveRename?.();
  const liveBeforeReplace = requireRegularFile(path, 'WORKLOG.md');
  if (!sameInode(before, liveBeforeReplace))
    throw new Error('refusing worklog rotation: WORKLOG.md changed after archive publication');
  // The helper writes and fsyncs a same-directory temp, atomically renames it
  // over the live path, then fsyncs the directory. WORKLOG.md is never absent.
  replaceFileAtomically(path, tail.toString('utf8'), before.mode & 0o777);
  const liveBytes = existsSync(path) ? requireRegularFile(path, 'WORKLOG.md').size : 0;
  const status = {
    schemaVersion: 1,
    rotatedAt: rotatedAt.toISOString(),
    beforeBytes: before.size,
    afterBytes: liveBytes,
    archive: basename(archivePath),
    archiveContainsFullSnapshot: true,
    tailOmittedPrefixBytes: start,
    ...(tailStartsMidLine ? { tailStartsMidLine: true } : {}),
    olderArchives: WORKLOG_ARCHIVE_DIR,
    recentArchiveLimit: policy.max_archives,
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
