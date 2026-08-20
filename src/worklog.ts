import {
  existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync,
  unlinkSync,
} from 'node:fs';
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
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  for (const old of older) {
    const source = join(dir, old);
    let collision = 0;
    for (;;) {
      const name = collision === 0 ? old : old.replace(/\.md$/, `.${collision}.md`);
      const target = join(archiveDir, name);
      try {
        // Link then unlink: a crash can leave a duplicate, never lose the only
        // archive. EEXIST chooses a new name rather than overwriting history.
        linkSync(source, target);
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
  const rotatedAt = deps.now?.() ?? new Date();
  let archivePath = '';
  // Publish the complete original inode under a collision-safe archive name.
  // link(2) is create-without-overwrite; concurrent appenders holding the old
  // inode continue into the archive after the live path is replaced.
  for (let collision = 0; ; collision++) {
    archivePath = archiveName(path, rotatedAt, collision);
    try {
      linkSync(path, archivePath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  deps.afterArchiveRename?.();
  // The helper writes and fsyncs a same-directory temp, atomically renames it
  // over the live path, then fsyncs the directory. WORKLOG.md is never absent.
  replaceFileAtomically(path, tail.toString('utf8'), before.mode & 0o777);
  const liveBytes = existsSync(path) ? statSync(path).size : 0;
  const status = {
    schemaVersion: 1,
    rotatedAt: rotatedAt.toISOString(),
    beforeBytes: before.size,
    afterBytes: liveBytes,
    archive: basename(archivePath),
    archiveContainsFullSnapshot: true,
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
