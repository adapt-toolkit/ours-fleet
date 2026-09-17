#!/usr/bin/env node
// PR-only dependency evidence. Release manifests and lockfiles are restored even on failure.
import { readFileSync, writeFileSync, realpathSync, existsSync, globSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Reviewed SDK installation requires GITHUB_EVENT_NAME=pull_request');
  const [consumer, sdkTar, cliTar, sdkCommit, ...extra] = process.argv.slice(2);
  if (!consumer || !sdkTar || !cliTar || extra.length || !/^[a-f0-9]{40}$/i.test(sdkCommit ?? '')) {
    throw new Error('Usage: review-sdk-install.mjs consumer-root sdk.tgz cli.tgz full-sdk-commit (40 hex characters)');
  }
  const root = realpathSync(consumer);
  const artifacts = new Map([['@ours.network/sdk', sdkTar], ['@ours.network/cli', cliTar]].map(([name, path]) => {
    const archive = realpathSync(path);
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    if (pkg.name !== name) throw new Error(`Artifact name mismatch: expected ${name}, got ${pkg.name}`);
    return [name, { archive, integrity, version: pkg.version }];
  }));
  console.log(JSON.stringify({ sdkCommit, artifacts: Object.fromEntries(artifacts) }, null, 2));
  const rootManifest = join(root, 'package.json');
  const rootPackage = JSON.parse(readFileSync(rootManifest, 'utf8'));
  const patterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : rootPackage.workspaces?.packages ?? [];
  const manifests = new Set([rootManifest]);
  for (const workspace of globSync(patterns, { cwd: root, exclude: ['**/node_modules/**', '**/.git/**'] })) {
    const path = realpathSync(join(root, workspace, 'package.json'));
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Workspace escapes consumer root: ${workspace}`);
    manifests.add(path);
  }
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(join(root, 'npm-shrinkwrap.json'))) throw new Error('npm-shrinkwrap.json is unsupported; refusing to change release resolution');
  const originals = new Map([...manifests, lockPath].map(path => [path, existsSync(path) ? readFileSync(path) : null]));
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const evidenceDir = mkdtempSync(join(tmpdir(), 'review-sdk-evidence-'));
  console.log(`Reviewed SDK evidence: ${evidenceDir}`);
  try {
    for (const path of manifests) {
      const pkg = JSON.parse(originals.get(path));
      for (const [name, artifact] of artifacts) {
        let found = false;
        for (const section of sections) {
          if (Object.hasOwn(pkg[section] ?? {}, name)) {
            pkg[section][name] = `file:${artifact.archive}`;
            if (section !== 'peerDependencies') found = true;
          }
        }
        if (path === rootManifest) {
          if (!found) (pkg.devDependencies ??= {})[name] = `file:${artifact.archive}`;
          (pkg.overrides ??= {})[name] = `$${name}`;
        }
      }
      writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    }
    // Discard pre-existing installed metadata so npm resolves the reviewed artifacts afresh.
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    const graph = [];
    for (const path of [lockPath, join(root, 'node_modules', '.package-lock.json')]) {
      const bytes = readFileSync(path);
      const lock = JSON.parse(bytes);
      if (!lock.packages) throw new Error(`Missing package graph: ${path}`);
      const counts = new Map([...artifacts.keys()].map(name => [name, 0]));
      for (const [location, entry] of Object.entries(lock.packages)) {
        for (const [name, artifact] of artifacts) {
          if (location !== `node_modules/${name}` && !location.endsWith(`/node_modules/${name}`)) continue;
          if (!entry.resolved?.startsWith('file:') || realpathSync(resolve(root, entry.resolved.slice(5))) !== artifact.archive || entry.integrity !== artifact.integrity || entry.version !== artifact.version) {
            throw new Error(`Reviewed dependency graph mismatch (archive/integrity/version): ${location} in ${path}`);
          }
          const installed = JSON.parse(readFileSync(join(root, location, 'package.json')));
          if (installed.name !== name || installed.version !== artifact.version) throw new Error(`Installed package mismatch: ${location}`);
          counts.set(name, counts.get(name) + 1);
          graph.push({ lock: relative(root, path), location, name, ...entry });
        }
      }
      for (const [name, count] of counts) if (!count) throw new Error(`Missing reviewed package ${name} in ${path}`);
      writeFileSync(join(evidenceDir, path === lockPath ? 'package-lock.json' : 'installed-package-lock.json'), bytes);
    }
    for (const [name, artifact] of artifacts) {
      const actual = 'sha512-' + createHash('sha512').update(readFileSync(artifact.archive)).digest('base64');
      if (actual !== artifact.integrity) throw new Error(`Artifact changed during installation: ${name}`);
    }
    const evidence = { sdkCommit, artifacts: Object.fromEntries(artifacts), graph };
    writeFileSync(join(evidenceDir, 'provenance.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    for (const [path, bytes] of originals) {
      if (bytes === null) rmSync(path, { force: true });
      else writeFileSync(path, bytes);
    }
  }
}
try { main(); } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
