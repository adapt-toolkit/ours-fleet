/**
 * Vitest globalSetup: builds `dist/` exactly once, before any worker starts.
 *
 * Root cause: cli.test.ts and atomic-file.test.ts each ran `npm run build` in
 * their own beforeAll. `npm run build` starts with `clean`, which rmSync's
 * dist/. Under parallel vitest workers one file's clean can delete dist while
 * another file's spawned `node dist/cli.js` is mid-flight, producing an
 * instant MODULE_NOT_FOUND exit (or a server that never starts). Building
 * once here — before any test file runs — removes the race entirely.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { realExec } from '../src/exec.js';

const CLI = join('dist', 'cli.js');

/** Newest mtime (ms) of package.json and everything under src/ and web/src/. */
function newestSourceMtime(): number {
  let newest = 0;
  const consider = (path: string) => {
    const st = statSync(path);
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else consider(p);
    }
  };
  walk('src');
  if (existsSync('web/src')) walk('web/src');
  consider('package.json');
  return newest;
}

function distIsFresh(): boolean {
  if (!existsSync(CLI)) return false;
  try {
    const distMtime = statSync(CLI).mtimeMs;
    return distMtime > newestSourceMtime();
  } catch {
    return false;
  }
}

export default async function setup(): Promise<void> {
  if (distIsFresh()) {
    console.log('[global-setup] dist fresh — skipping build');
    return;
  }
  console.log('[global-setup] building…');
  const r = await realExec('npm', ['run', 'build']);
  if (r.code !== 0) throw new Error(`build failed: ${r.stderr}`);
}
