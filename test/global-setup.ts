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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
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

export default async function setup(): Promise<() => void> {
  // Keep socket paths short and fixtures outside this package's ESM/module tree.
  // A private home also prevents tests from reading the operator's credentials.
  const root = mkdtempSync(join(realpathSync('/tmp'), 'fleet-'));
  const original = { ...process.env };
  for (const [key, name] of Object.entries({ TMPDIR: 't', TMP: 't', TEMP: 't', HOME: 'h',
    XDG_CONFIG_HOME: 'c', XDG_CACHE_HOME: 'c', XDG_RUNTIME_DIR: 'r' })) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    process.env[key] = path;
  }
  for (const key of ['OURS_FLEET_HOME', 'OURS_CONFIG', 'OURS_STATE_DIR', 'OURS_PORT', 'OURS_API_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OURS_FLEET_SOCKET_ROOT']) delete process.env[key];
  const cleanup = () => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  };
  // The test runner itself may be launched from a managed Agent. Child CLI
  // fixtures exercise direct/operator behavior unless a test explicitly sets
  // the proxy pair, so do not accidentally audit the test harness as commands.
  delete process.env.OURS_FLEET_PROXY_STATE_DIR;
  delete process.env.OURS_FLEET_PROXY_CALLER;
  if (distIsFresh()) {
    console.log('[global-setup] dist fresh — skipping build');
    return cleanup;
  }
  console.log('[global-setup] building…');
  const r = await realExec('npm', ['run', 'build']);
  if (r.code !== 0) { cleanup(); throw new Error(`build failed: ${r.stdout}\n${r.stderr}`); }
  return cleanup;
}
