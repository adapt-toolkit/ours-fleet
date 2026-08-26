import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve an ACP agent shipped as an ours-fleet dependency. Running the JS
 * entrypoint through this process's Node avoids depending on npm exposing a
 * transitive dependency's bin on the user's global PATH.
 */
export interface AcpAgentResolution {
  argv: string[];
  bundled: boolean;
  /** Package manifest used to resolve the adapter's own runtime dependencies. */
  manifestPath?: string;
  entrypointPath?: string;
  version?: string;
  identity?: AcpBundleIdentity;
}

export interface AcpFileIdentity {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  sha256: string;
}
export interface AcpBundleIdentity {
  manifest: Readonly<AcpFileIdentity>;
  entrypoint: Readonly<AcpFileIdentity>;
}

const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;

export interface AuthenticatedAcpResolutionDeps {
  /** Test-only race seam; the already-open fd remains the authenticated object. */
  afterOpen?(path: string, fd: number): void;
}

function fileSnapshot(
  path: string, deps: AuthenticatedAcpResolutionDeps = {},
): { identity: AcpFileIdentity; bytes: Buffer } {
  const fd = openSync(path, 'r');
  try {
    deps.afterOpen?.(path, fd);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BUNDLE_FILE_BYTES))
      throw new Error('ACP bundle file is invalid or too large');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('ACP bundle file ended while being identified');
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs)
      throw new Error('ACP bundle file changed while being identified');
    const identity = Object.freeze({
      path, dev: `${after.dev}`, ino: `${after.ino}`, size: Number(after.size),
      mtimeNs: `${after.mtimeNs}`,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    return { identity, bytes };
  } finally { closeSync(fd); }
}

const fileIdentity = (path: string): AcpFileIdentity => fileSnapshot(path).identity;

const sameIdentity = (left: AcpFileIdentity, right: AcpFileIdentity): boolean =>
  left.path === right.path && left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.sha256 === right.sha256;

/** Recheck immediately at the future spawn boundary; this function never launches. */
export function recheckBundledAcpAgent(resolution: AcpAgentResolution): boolean {
  if (!resolution.bundled || !resolution.identity) return false;
  try {
    return sameIdentity(fileIdentity(resolution.identity.manifest.path), resolution.identity.manifest)
      && sameIdentity(fileIdentity(resolution.identity.entrypoint.path), resolution.identity.entrypoint);
  } catch { return false; }
}

export function resolveBundledAcpAgent(
  packageName: string,
  binName: string,
  fallbackCommand: string,
): AcpAgentResolution {
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bin?: string | Record<string, string>;
      version?: string;
    };
    const declaredEntrypoint = typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin?.[binName];
    if (!declaredEntrypoint) return { argv: [fallbackCommand], bundled: false };
    const packageRoot = realpathSync(dirname(manifestPath));
    const entrypoint = realpathSync(resolve(packageRoot, declaredEntrypoint));
    const entrypointFromRoot = relative(packageRoot, entrypoint);
    if (
      entrypointFromRoot === '..'
      || entrypointFromRoot.startsWith(`..${sep}`)
      || isAbsolute(entrypointFromRoot)
      || !statSync(entrypoint).isFile()
    ) return { argv: [fallbackCommand], bundled: false };
    return {
      argv: [process.execPath, entrypoint], bundled: true, manifestPath,
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    };
  } catch {
    // Supports development installs that intentionally omit optional
    // dependencies and existing hosts with a globally installed adapter.
    return { argv: [fallbackCommand], bundled: false };
  }
}

/** Authenticated, bounded resolution used only by the new zero-launch preparation seam. */
export function resolveAuthenticatedBundledAcpAgent(
  packageName: string, binName: string, fallbackCommand: string,
  deps: AuthenticatedAcpResolutionDeps = {},
): AcpAgentResolution {
  try {
    const unresolvedManifest = require.resolve(`${packageName}/package.json`);
    const manifestPath = realpathSync(unresolvedManifest);
    const manifestSnapshot = fileSnapshot(manifestPath, deps);
    const manifest = JSON.parse(manifestSnapshot.bytes.toString('utf8')) as {
      bin?: string | Record<string, string>; version?: string;
    };
    const declaredEntrypoint = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
    if (!declaredEntrypoint) return { argv: [fallbackCommand], bundled: false };
    const packageRoot = realpathSync(dirname(manifestPath));
    const entrypoint = realpathSync(resolve(packageRoot, declaredEntrypoint));
    const fromRoot = relative(packageRoot, entrypoint);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
      return { argv: [fallbackCommand], bundled: false };
    const identity = Object.freeze({
      manifest: manifestSnapshot.identity, entrypoint: fileSnapshot(entrypoint, deps).identity,
    });
    return {
      argv: [process.execPath, entrypoint], bundled: true, manifestPath, entrypointPath: entrypoint,
      identity, ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    };
  } catch { return { argv: [fallbackCommand], bundled: false }; }
}

export function bundledAcpAgent(
  packageName: string,
  binName: string,
  fallbackCommand: string,
): string[] {
  return resolveBundledAcpAgent(packageName, binName, fallbackCommand).argv;
}
