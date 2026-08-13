/**
 * Materialize the divergent-install fixtures (test/fixtures/installs) as real
 * npm prefixes inside a temp dir, so provenance discovery can walk actual
 * bin symlinks. Nothing outside `root` is touched.
 */
import { cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'installs');

export const pkgRoot = (prefix: string) =>
  join(prefix, 'lib', 'node_modules', '@ours.network', 'fleet');
export const cliPath = (prefix: string) => join(pkgRoot(prefix), 'dist', 'cli.js');
export const binPath = (prefix: string) => join(prefix, 'bin', 'ours-fleet');

/** Copy `fixture` into `<root>/<fixture>` with a bin/ours-fleet symlink; returns the prefix. */
export function installPrefix(root: string, fixture: 'legacy' | 'current'): string {
  const prefix = join(root, fixture);
  mkdirSync(pkgRoot(prefix), { recursive: true });
  cpSync(join(FIXTURES, fixture), pkgRoot(prefix), { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync('../lib/node_modules/@ours.network/fleet/dist/cli.js', binPath(prefix));
  return prefix;
}
