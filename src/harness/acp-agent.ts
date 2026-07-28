import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve an ACP agent shipped as an ours-fleet dependency. Running the JS
 * entrypoint through this process's Node avoids depending on npm exposing a
 * transitive dependency's bin on the user's global PATH.
 */
export interface AcpAgentResolution {
  argv: string[];
  bundled: boolean;
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
    };
    const relative = typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin?.[binName];
    if (!relative) return { argv: [fallbackCommand], bundled: false };
    const entrypoint = resolve(dirname(manifestPath), relative);
    if (!existsSync(entrypoint)) return { argv: [fallbackCommand], bundled: false };
    return { argv: [process.execPath, entrypoint], bundled: true };
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
