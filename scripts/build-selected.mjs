#!/usr/bin/env node
// Build a portable consumer package from the caller's actual SDK/CLI archives.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--sdk', '--cli', '--out-dir'].includes(key) || !value || value.startsWith('--') || options.has(key)) {
    throw new Error('Usage: node scripts/build-selected.mjs --sdk PATH --cli PATH --out-dir PATH');
  }
  options.set(key, resolve(value));
}
if (options.size !== 3) throw new Error('Required: --sdk PATH --cli PATH --out-dir PATH');
const out = options.get('--out-dir');
if (out === root || relative(out, root).split(sep)[0] !== '..' && !relative(out, root).startsWith(sep)) {
  throw new Error('Output directory must not contain the source repository');
}
const selected = [
  { name: '@ours.network/sdk', path: options.get('--sdk'), vendor: 'ours.network-sdk.tgz' },
  { name: '@ours.network/cli', path: options.get('--cli'), vendor: 'ours.network-cli.tgz' },
];
for (const item of selected) {
  item.manifest = JSON.parse(execFileSync('tar', ['-xOf', item.path, 'package/package.json'], { encoding: 'utf8' }));
  if (item.manifest.name !== item.name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(item.manifest.version)) {
    throw new Error(`Expected ${item.name} archive with a package version: ${item.path}`);
  }
}
const buildEnv = { ...process.env };

const stage = await mkdtemp(resolve(tmpdir(), 'ours-selected-'));
function npm(args, capture = false) {
  return execFileSync('npm', args, {
    cwd: stage, env: buildEnv, encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 2, 2], maxBuffer: 16 * 1024 * 1024,
  });
}
try {
  await cp(root, stage, {
    recursive: true,
    filter: (path) => path !== out && !relative(root, path).split(sep).some((part) => ['.git', 'node_modules', 'dist'].includes(part)),
  });
  const manifestPath = resolve(stage, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await mkdir(resolve(stage, 'vendor'), { recursive: true });
  for (const item of selected) {
    await cp(item.path, resolve(stage, 'vendor', item.vendor));
    item.section = ['dependencies', 'devDependencies'].find((key) => Object.hasOwn(manifest[key] ?? {}, item.name));
    if (!item.section) throw new Error(`Missing direct dependency ${item.name}`);
  }
  // Native removal invalidates cached lock metadata even for unchanged filenames
  // and versions. Restore the original dependency classifications immediately.
  npm(['uninstall', '--package-lock-only', '--ignore-scripts', ...selected.map((item) => item.name)]);
  for (const item of selected) manifest[item.section][item.name] = `file:vendor/${item.vendor}`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  npm(['install', '--package-lock-only', '--ignore-scripts']);
  npm(['ci', '--include=dev']);
  for (const item of selected) {
    const installed = JSON.parse(await readFile(resolve(stage, 'node_modules', item.name, 'package.json'), 'utf8'));
    if (JSON.stringify(installed) !== JSON.stringify(item.manifest)) throw new Error(`Installed archive differs: ${item.name}`);
  }
  npm(['run', 'build']);
  // The installer supplies these exact versions alongside the consumer archive.
  for (const item of selected) manifest[item.section][item.name] = item.manifest.version;
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (/^(file:|link:|\.\.?\/|\/)/.test(spec)) throw new Error(`Nonportable ${section} reference: ${name}=${spec}`);
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await mkdir(out, { recursive: true });
  const packages = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], true));
  if (packages.length !== 1) throw new Error('Expected exactly one consumer archive');
  process.stdout.write(JSON.stringify({ filename: packages[0].filename }) + '\n');
} finally {
  await rm(stage, { recursive: true, force: true });
}
