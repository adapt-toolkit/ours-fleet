import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import { FleetError } from '../application/errors.js';

export interface WebServerLock {
  path: string;
  release(): void;
}

const processMarker = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return stat.slice(end + 2).split(/\s+/)[19];
  } catch { return undefined; }
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export function acquireWebServerLock(dir = join(stateRoot(), 'web')): WebServerLock {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'server.lock');
  const ours = { pid: process.pid, marker: processMarker(process.pid), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(ours) + '\n');
      closeSync(fd);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; marker?: string };
            if (current.pid === ours.pid && current.marker === ours.marker) rmSync(path, { force: true });
          } catch { /* do not remove a lock we cannot prove is ours */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const current = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; marker?: string };
        if (typeof current.pid === 'number' && alive(current.pid)) {
          const marker = processMarker(current.pid);
          if (!marker || !current.marker || marker === current.marker)
            throw new FleetError('conflict', `another ours-fleet web server is running (pid ${current.pid})`);
        }
        rmSync(path, { force: true });
      } catch (readError) {
        if (readError instanceof FleetError) throw readError;
        throw new FleetError('conflict', 'web server lock exists but cannot be verified safely');
      }
    }
  }
  throw new FleetError('conflict', 'could not acquire web server lock');
}
