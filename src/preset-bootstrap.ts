import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, chmodSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath } from './paths.js';
import { splitRootFor } from './config.js';

interface PresetManifest {
  schema_version: number;
  preset_revision: number;
  description: string;
}

export interface BootstrapResult {
  revision: number;
  sourceRoot: string;
  configPath: string;
  created: string[];
  preserved: string[];
}

export const packagedPresetRoot = (): string =>
  fileURLToPath(new URL('../presets', import.meta.url));

function assertSafeExisting(path: string, kind: 'file' | 'directory'): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`preset bootstrap refuses symlink target: ${path}`);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
    throw new Error(`preset bootstrap expected ${kind}: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error(`preset bootstrap refuses target owned by uid ${stat.uid}: ${path}`);
  if ((stat.mode & 0o022) !== 0)
    throw new Error(`preset bootstrap refuses group/world-writable target: ${path}`);
}

function ensureDirectory(path: string): void {
  const parent = dirname(path);
  if (parent !== path && !existsSync(parent)) ensureDirectory(parent);
  if (existsSync(path)) {
    assertSafeExisting(path, 'directory');
    return;
  }
  mkdirSync(path, { mode: 0o700 });
}

function seedFile(source: string, target: string, result: BootstrapResult): void {
  ensureDirectory(dirname(target));
  if (existsSync(target)) {
    assertSafeExisting(target, 'file');
    result.preserved.push(target);
    return;
  }
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    result.created.push(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assertSafeExisting(target, 'file');
    result.preserved.push(target);
  }
}

function presetFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

/** Seed packaged defaults without replacing a single existing byte. */
export function bootstrapPresets(configuration = defaultConfigPath()): BootstrapResult {
  const sourceRoot = packagedPresetRoot();
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8')) as PresetManifest;
  if (manifest.schema_version !== 1 || !Number.isInteger(manifest.preset_revision))
    throw new Error(`invalid packaged preset manifest: ${join(sourceRoot, 'manifest.json')}`);
  const configPath = resolve(configuration);
  const result: BootstrapResult = {
    revision: manifest.preset_revision, sourceRoot, configPath, created: [], preserved: [],
  };
  ensureDirectory(dirname(configPath));
  seedFile(join(sourceRoot, 'fleet.yaml'), configPath, result);
  const sourceSplit = join(sourceRoot, 'fleet');
  const targetSplit = splitRootFor(configPath);
  if (existsSync(targetSplit)) assertSafeExisting(targetSplit, 'directory');
  for (const source of presetFiles(sourceSplit)) {
    const rel = relative(sourceSplit, source);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error(`invalid packaged preset path: ${source}`);
    seedFile(source, join(targetSplit, rel), result);
  }
  return result;
}
