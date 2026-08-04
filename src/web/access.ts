import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { FleetError } from '../application/errors.js';
import { stateRoot } from '../paths.js';

export type WebAccessMode = 'pairing' | 'password' | 'none';

export interface WebAccessConfig {
  version: 1;
  mode: WebAccessMode;
  password?: { salt: string; hash: string };
}

const DEFAULT: WebAccessConfig = { version: 1, mode: 'pairing' };
const b64 = /^[A-Za-z0-9_-]{20,128}$/;

export function passwordAccess(password: string): WebAccessConfig {
  if (password.length < 12 || Buffer.byteLength(password) > 1024)
    throw new FleetError('invalid_request', 'control-panel password must be 12–1024 bytes');
  const salt = randomBytes(16).toString('base64url');
  return { version: 1, mode: 'password', password: {
    salt, hash: scryptSync(password, salt, 32).toString('base64url'),
  } };
}

export function verifyPassword(config: WebAccessConfig, supplied: string): boolean {
  if (config.mode !== 'password' || !config.password || Buffer.byteLength(supplied) > 1024)
    return false;
  const actual = scryptSync(supplied, config.password.salt, 32);
  const expected = Buffer.from(config.password.hash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class WebAccessStore {
  readonly path: string;
  constructor(private readonly dir = join(stateRoot(), 'web')) {
    this.path = join(dir, 'access.json');
  }

  read(): WebAccessConfig {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
        throw new FleetError('forbidden', 'web access configuration is not a safe regular file');
      chmodSync(this.path, 0o600);
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<WebAccessConfig>;
      if (value.version !== 1 || !['pairing', 'password', 'none'].includes(value.mode ?? ''))
        throw new FleetError('forbidden', 'web access configuration is invalid');
      if (value.mode === 'password' && (!value.password || !b64.test(value.password.salt)
          || !b64.test(value.password.hash)))
        throw new FleetError('forbidden', 'web password configuration is invalid');
      return value as WebAccessConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT;
      throw error;
    }
  }

  write(config: WebAccessConfig): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    replaceFileAtomically(this.path, JSON.stringify(config, null, 2) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }
}

export function validatePublicOrigin(value: string): URL {
  let origin: URL;
  try { origin = new URL(value); }
  catch { throw new FleetError('invalid_request', 'public origin must be an absolute http(s) URL'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash)
    throw new FleetError('invalid_request', 'public origin must contain only scheme, host, and optional port');
  return origin;
}
