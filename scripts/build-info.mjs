#!/usr/bin/env node
/**
 * Stamp dist/build-info.json — the built artifact's identity.
 *
 * Runs last in `npm run build`, after tsc and vite, so it can hash the finished
 * dist/ tree. The id is content-derived rather than taken from git or the clock:
 * two builds of the same sources get the same id, and a build cut between two
 * release commits gets an id that differs from the release it shares a semver
 * with — which is exactly the case `--version` alone could not express.
 *
 * Capabilities are read back out of the compiled dist/capabilities.js, so the
 * stamp can never claim a capability the shipped code does not have.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repoRoot, 'dist');
const OUTPUT = join(dist, 'build-info.json');

/** Every file under dist/, relative and POSIX-separated, sorted, minus our own output. */
function distFiles() {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p !== OUTPUT) files.push(relative(dist, p).split(sep).join('/'));
    }
  };
  walk(dist);
  return files.sort();
}

/** sha256 over (path, size, bytes) of every dist file — order- and rename-sensitive. */
function contentDigest(files) {
  const hash = createHash('sha256');
  for (const rel of files) {
    const bytes = readFileSync(join(dist, rel));
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return undefined; }
}

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const { CAPABILITIES } = await import(pathToFileURL(join(dist, 'capabilities.js')).href);
const commit = git(['rev-parse', 'HEAD']);
const status = commit === undefined ? undefined : git(['status', '--porcelain']);

const info = {
  version,
  buildId: contentDigest(distFiles()).slice(0, 12),
  ...(commit ? { commit, dirty: status !== '' } : {}),
  builtAt: new Date().toISOString(),
  capabilities: [...CAPABILITIES],
};

writeFileSync(OUTPUT, `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: ${version}+${info.buildId}`
  + (commit ? ` (${commit.slice(0, 7)}${info.dirty ? '-dirty' : ''})` : ' (no git)'));
