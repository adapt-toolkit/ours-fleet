import {
  accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface LaunchRuntime {
  /** Launch argv with a PATH-resolved command, so the mounted executable is the one invoked. */
  argv: string[];
  /** Exact executable and package roots required by the launch, mounted read-only. */
  readPaths: string[];
}

export interface LaunchRuntimeOptions {
  path?: string;
  nodeExecutable?: string;
}

const SYSTEM_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
const inside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root + sep);

function canonical(path: string): string {
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
}

function commandPath(command: string, pathValue: string): string | undefined {
  const candidates = isAbsolute(command) || command.includes(sep)
    ? [resolve(command)]
    : pathValue.split(delimiter).filter(Boolean).map(dir => resolve(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return canonical(candidate);
    } catch { /* keep searching PATH */ }
  }
  return undefined;
}

function packageRoot(path: string): string | undefined {
  let dir = existsSync(path) ? dirname(path) : path;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function dependencyManifest(manifestPath: string, name: string): string | undefined {
  const localRequire = createRequire(manifestPath);
  try { return localRequire.resolve(`${name}/package.json`); }
  catch {
    // Some packages do not export package.json. Their main entry still gives us
    // a point from which to find the owning package root.
    try {
      const entry = localRequire.resolve(name);
      const root = packageRoot(entry);
      return root ? join(root, 'package.json') : undefined;
    } catch { return undefined; }
  }
}

function addPackageClosure(root: string, paths: Set<string>, seen: Set<string>): void {
  const canonicalRoot = canonical(root);
  if (seen.has(canonicalRoot)) return;
  seen.add(canonicalRoot);
  paths.add(canonicalRoot);

  const manifestPath = join(canonicalRoot, 'package.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const dependency = dependencyManifest(manifestPath, name);
      if (dependency) addPackageClosure(dirname(dependency), paths, seen);
    }
  } catch { /* a malformed/unreadable manifest cannot contribute a closure */ }
}

function isNodeScript(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const bytes = Buffer.alloc(128);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return /^#!.*\bnode\b/.test(bytes.subarray(0, count).toString('utf8'));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Resolve the concrete runtime closure for an already-selected harness launch.
 * System roots are already present in every isolation policy; everything else
 * is returned as an exact read-only executable or npm package-root bind.
 */
export function resolveLaunchRuntime(
  argv: string[], options: LaunchRuntimeOptions = {},
): LaunchRuntime {
  if (!argv.length) return { argv: [], readPaths: [] };
  const nodeExecutable = canonical(options.nodeExecutable ?? process.execPath);
  const executable = commandPath(argv[0], options.path ?? process.env.PATH ?? '');
  const resolvedArgv = executable ? [executable, ...argv.slice(1)] : [...argv];
  const paths = new Set<string>();
  const packages = new Set<string>();

  const consider = (path: string): void => {
    if (!isAbsolute(path) || !existsSync(path)) return;
    const real = canonical(path);
    const root = packageRoot(real);
    if (root) addPackageClosure(root, paths, packages);
    else paths.add(real);
    if (real === nodeExecutable || isNodeScript(real)) paths.add(nodeExecutable);
  };

  if (executable) consider(executable);
  // A direct Node launch's first existing absolute non-option argument is its
  // module entrypoint. Other absolute arguments are harness inputs/settings,
  // not runtime code, and already follow the ordinary filesystem policy.
  if (executable === nodeExecutable) {
    const entrypointIndex = argv.findIndex(
      (arg, index) => index > 0 && !arg.startsWith('-') && isAbsolute(arg) && existsSync(arg));
    if (entrypointIndex !== -1) {
      resolvedArgv[entrypointIndex] = canonical(argv[entrypointIndex]);
      consider(resolvedArgv[entrypointIndex]);
    }
  }

  return {
    argv: resolvedArgv,
    readPaths: [...paths].filter(path => !SYSTEM_ROOTS.some(root => inside(path, root))),
  };
}
