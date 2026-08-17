import { createRequire } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
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
  version?: string;
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

export function bundledAcpAgent(
  packageName: string,
  binName: string,
  fallbackCommand: string,
): string[] {
  return resolveBundledAcpAgent(packageName, binName, fallbackCommand).argv;
}
