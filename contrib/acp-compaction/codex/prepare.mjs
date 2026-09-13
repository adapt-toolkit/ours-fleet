#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Standalone intentionally: each adapter directory is independently portable.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
    throw new Error('Usage: node prepare.mjs /path/to/new-or-empty-isolated-target');
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!((major === 22 && minor >= 12) || major === 24 || major >= 26)) {
    throw new Error('Use Node 22.12+, 24.x, or 26+ (the pinned test runner requirement).');
  }
  if (process.platform === 'win32') throw new Error('This package requires a POSIX shell; use WSL on Windows.');
  const target = resolve(process.argv[2]);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || readdirSync(target).length)) {
    throw new Error('Target must be a new or empty non-symlink directory; existing contents are never overwritten.');
  }
  const patchPath = join(packageDir, 'adapter.patch');
  if (digest(readFileSync(patchPath)) !== manifest.patchSha256) throw new Error('Packaged patch SHA256 mismatch.');
  mkdirSync(target, { recursive: true });
  const source = join(target, 'source');
  mkdirSync(source);
  const logPath = join(target, 'validation.log');
  const completedChecks = [];
  const say = (message) => {
    process.stdout.write(`${message}\n`);
    appendFileSync(logPath, `${message}\n`);
  };
  async function run(command, args, cwd = source) {
    say(`> ${JSON.stringify([command, ...args])}`);
    await new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_cache: join(target, 'npm-cache'), GIT_CEILING_DIRECTORIES: target },
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => { process.stdout.write(chunk); appendFileSync(logPath, chunk); });
      }
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? accept() : reject(new Error(`${command} failed (${signal ?? code}); see validation.log`)));
    });
    completedChecks.push([command, ...args]);
  }
  async function download(url, expectedHash, path) {
    say(`Fetching pinned source: ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== expectedHash) throw new Error(`SHA256 mismatch for ${url}; do not apply unverified source.`);
    writeFileSync(path, bytes);
  }
  const archive = join(target, 'upstream.tar.gz');
  await download(manifest.archiveUrl, manifest.archiveSha256, archive);
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', source], target);
  if (digest(readFileSync(join(source, 'package-lock.json'))) !== manifest.lockfileSha256) throw new Error('Upstream lockfile SHA256 mismatch.');
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.package || pkg.version !== manifest.packageVersion) throw new Error('Upstream package pin mismatch.');
  await run('git', ['apply', '--check', patchPath]);
  await run('git', ['apply', patchPath]);
  // Never installs globally, edits a git index, invokes release hooks, or launches a model.
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const installed = JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`Dependency pin mismatch: ${name}`);
  }
  for (const evidence of manifest.outcomeEvidence ?? []) {
    const evidenceDir = join(target, 'outcome-evidence');
    mkdirSync(evidenceDir, { recursive: true });
    await download(evidence.url, evidence.sha256, join(evidenceDir, evidence.filename));
  }
  for (const [command, ...args] of manifest.checks) await run(command, args);
  const prologue = '#!/bin/sh\nset -eu\nadapter_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\n';
  let adapterEnvironment = '';
  if (manifest.adapter === 'codex') {
    const runtime = join(target, 'codex-runtime.sh');
    writeFileSync(runtime, prologue + 'exec node "$adapter_dir/source/node_modules/@openai/codex/bin/codex.js" "$@"\n', { mode: 0o755 });
    // Expose the pinned native executable for direct version diagnostics as well.
    await run(runtime, ['--version'], target);
    adapterEnvironment = 'export CODEX_PATH="$adapter_dir/codex-runtime.sh"\n';
  }
  const launcher = join(target, 'run-adapter.sh');
  writeFileSync(launcher, prologue + adapterEnvironment + 'exec node "$adapter_dir/source/dist/index.js" "$@"\n', { mode: 0o755 });
  writeFileSync(join(target, 'validation.json'), JSON.stringify({
    status: 'passed', adapter: manifest.adapter, upstreamCommit: manifest.upstreamCommit,
    reviewedCommit: manifest.reviewedCommit, archiveSha256: manifest.archiveSha256,
    patchSha256: manifest.patchSha256, node: process.version, checks: completedChecks,
    coverage: manifest.coverage, launcher,
  }, null, 2) + '\n');
  say(`Validated adapter launcher: ${launcher}`);
  if (manifest.adapter === 'codex') say(`Optional explicit native probe: CODEX_PATH=${join(target, 'codex-runtime.sh')}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
