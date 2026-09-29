import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Optional private socket directory for deeply nested, isolated Fleet homes. */
export function socketPath(logicalPath: string): string {
  const root = process.env.OURS_FLEET_SOCKET_ROOT;
  if (!root) {
    if (Buffer.byteLength(logicalPath) > 103) throw new Error('Unix socket path is too long; configure a short private OURS_FLEET_SOCKET_ROOT');
    return logicalPath;
  }
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('OURS_FLEET_SOCKET_ROOT must be an absolute normalized path');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('OURS_FLEET_SOCKET_ROOT must be an owner-only 0700 directory');
  const path = join(root, createHash('sha256').update(resolve(logicalPath)).digest('hex').slice(0, 24) + '.sock');
  if (Buffer.byteLength(path) > 103) throw new Error('OURS_FLEET_SOCKET_ROOT is too long');
  return path;
}
