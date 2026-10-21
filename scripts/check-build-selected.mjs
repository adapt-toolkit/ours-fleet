#!/usr/bin/env node
// Focused integration check; run in the build container with actual archives.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: node scripts/check-build-selected.mjs --sdk PATH --cli PATH');
assert.equal(args[0], '--sdk');
assert.equal(args[2], '--cli');
const temp = await mkdtemp(resolve(tmpdir(), 'ours-selected-check-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 2], maxBuffer: 16 * 1024 * 1024 });
async function snapshot(dir) {
  const result = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', '.code-review-graph'].includes(entry.name)) continue;
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result[relative(dir, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await walk(dir);
  return result;
}
try {
  const before = await snapshot(root);
  const inputs = [];
  for (const [kind, input] of [['sdk', args[1]], ['cli', args[3]]]) {
    const archive = resolve(temp, `${kind}.tgz`);
    await cp(resolve(input), archive);
    const extracted = resolve(temp, kind);
    await mkdir(extracted);
    run('tar', ['-xzf', archive, '-C', extracted], temp);
    inputs.push({ kind, archive, package: resolve(extracted, 'package') });
  }
  const source = resolve(temp, 'source');
  await cp(root, source, { recursive: true, filter: (p) => !relative(root, p).split(sep).some((x) => ['.git', 'node_modules', 'dist', '.code-review-graph'].includes(x)) });
  const sourceBefore = await snapshot(source);
  const out = resolve(temp, 'out');
  let packed;
  for (const pass of ['original', 'changed-same-name-version']) {
    if (pass !== 'original') {
      for (const input of inputs) {
        const manifestPath = resolve(input.package, 'package.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.oursSelectedBuildCheck = pass;
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        // Change executable bytes as well as manifest bytes without changing APIs.
        const entry = input.kind === 'sdk' ? 'dist/client.js' : 'dist/cli.js';
        await writeFile(resolve(input.package, entry), await readFile(resolve(input.package, entry), 'utf8') + '\n// selected-build-check changed bytes\n');
        const [{ filename }] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dirname(input.package)], input.package));
        await cp(resolve(dirname(input.package), filename), input.archive);
      }
    }
    const result = JSON.parse(run(process.execPath, [resolve(source, 'scripts/build-selected.mjs'), '--sdk', inputs[0].archive, '--cli', inputs[1].archive, '--out-dir', out], source));
    packed = resolve(out, result.filename);
    const manifest = JSON.parse(run('tar', ['-xOf', packed, 'package/package.json'], temp));
    assert.equal(result.filename, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
    for (const input of inputs) {
      const selected = JSON.parse(await readFile(resolve(input.package, 'package.json'), 'utf8'));
      const section = Object.hasOwn(manifest.dependencies, selected.name) ? 'dependencies' : 'devDependencies';
      assert.equal(manifest[section][selected.name], selected.version);
    }
    const install = resolve(temp, `install-${pass}`);
    await mkdir(install);
    await writeFile(resolve(install, 'package.json'), '{"private":true}\n');
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', ...inputs.map((x) => x.archive), packed], install);
    for (const input of inputs) {
      const selected = JSON.parse(await readFile(resolve(input.package, 'package.json'), 'utf8'));
      const installed = resolve(install, 'node_modules', selected.name);
      assert.deepEqual(await snapshot(installed), await snapshot(input.package), `${pass}: selected ${input.kind} manifest/package bytes`);
      const entry = input.kind === 'sdk' ? 'dist/client.js' : 'dist/cli.js';
      assert.deepEqual(await readFile(resolve(installed, entry)), await readFile(resolve(input.package, entry)), `${pass}: selected ${input.kind} executable bytes`);
    }
    assert.deepEqual(await snapshot(source), sourceBefore, 'invoked source preserved');
    assert.deepEqual(await snapshot(root), before, 'normal source preserved');
    console.log(`${pass}: build, portable install, exact selected bytes and source preservation passed`);
  }
  // Prove a missing staged vendor reference is rejected by the package manager.
  const bad = resolve(temp, 'bad');
  await mkdir(bad);
  run('tar', ['-xzf', packed, '-C', bad], temp);
  const path = resolve(bad, 'package/package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.dependencies['@ours.network/sdk'] = 'file:vendor/b1-missing-sdk.tgz';
  await writeFile(path, JSON.stringify(manifest));
  const [{ filename }] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', bad], resolve(bad, 'package')));
  const badInstall = resolve(temp, 'bad-install');
  await mkdir(badInstall);
  await writeFile(resolve(badInstall, 'package.json'), '{"private":true}\n');
  const failure = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', resolve(bad, filename)], { cwd: badInstall, encoding: 'utf8' });
  assert.notEqual(failure.status, 0, 'unresolved vendor path must fail installation');
  assert.match(failure.stderr, /b1-missing-sdk\.tgz/, 'failure identifies unresolved vendor input');
  console.log('unresolved vendor negative control passed');
} finally {
  await rm(temp, { recursive: true, force: true });
}
