import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { FleetError } from '../application/errors.js';
import { stateRoot } from '../paths.js';

const VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_DEVICES = 32;
const MAX_STORE_BYTES = 128 * 1024;

interface StoredDevice {
  id: string;
  secretHash: string;
  pairedAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

interface DeviceFile { version: 1; devices: StoredDevice[] }

export interface TrustedDeviceIssue {
  token: string;
  id: string;
  expiresAt: number;
}

const opaque = (bytes: number) => randomBytes(bytes).toString('base64url');
const digest = (id: string, secret: string) =>
  createHash('sha256').update('ours-fleet-device-v1\0').update(id).update('\0').update(secret).digest('base64url');
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function parseToken(token: string): { id: string; secret: string } | undefined {
  const split = token.indexOf('.');
  if (split < 1) return undefined;
  const id = token.slice(0, split);
  const secret = token.slice(split + 1);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    return undefined;
  return { id, secret };
}

/** Persistent trusted-device registry. Raw device secrets never enter this store. */
export class TrustedDeviceStore {
  readonly dir: string;
  readonly path: string;
  private devices: StoredDevice[];

  constructor(
    dir = join(stateRoot(), 'web'),
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxDevices = DEFAULT_MAX_DEVICES,
  ) {
    this.dir = dir;
    this.path = join(dir, 'trusted-devices.json');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.devices = this.read();
    this.prune(true);
  }

  issue(): TrustedDeviceIssue {
    this.prune(false);
    const now = this.now();
    const id = opaque(16);
    const secret = opaque(32);
    const device = {
      id, secretHash: digest(id, secret), pairedAt: now,
      lastUsedAt: now, expiresAt: now + this.ttlMs,
    };
    this.devices.push(device);
    this.devices.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    this.devices = this.devices.slice(0, Math.max(1, Math.min(this.maxDevices, 128)));
    this.write();
    return { token: `${id}.${secret}`, id, expiresAt: device.expiresAt };
  }

  /** Validate and rotate on use. The old token is invalid as soon as this returns. */
  rotate(token: string): TrustedDeviceIssue | undefined {
    const parsed = parseToken(token);
    if (!parsed) return undefined;
    this.prune(false);
    const index = this.devices.findIndex(device => device.id === parsed.id);
    const existing = index >= 0 ? this.devices[index] : undefined;
    if (!existing || !safeEqual(existing.secretHash, digest(parsed.id, parsed.secret))) return undefined;
    const now = this.now();
    if (existing.expiresAt <= now) {
      this.devices.splice(index, 1);
      this.write();
      return undefined;
    }
    const secret = opaque(32);
    const replacement = {
      ...existing, secretHash: digest(existing.id, secret),
      lastUsedAt: now, expiresAt: now + this.ttlMs,
    };
    this.devices[index] = replacement;
    this.write();
    return { token: `${existing.id}.${secret}`, id: existing.id, expiresAt: replacement.expiresAt };
  }

  revoke(token: string): boolean {
    const parsed = parseToken(token);
    if (!parsed) return false;
    const index = this.devices.findIndex(device => device.id === parsed.id
      && safeEqual(device.secretHash, digest(parsed.id, parsed.secret)));
    if (index < 0) return false;
    this.devices.splice(index, 1);
    this.write();
    return true;
  }

  /** Revoke an already-authenticated device without retaining its raw secret in a session. */
  revokeId(id: string): boolean {
    const index = this.devices.findIndex(device => device.id === id);
    if (index < 0) return false;
    this.devices.splice(index, 1);
    this.write();
    return true;
  }

  revokeAll(): number {
    const count = this.devices.length;
    this.devices = [];
    this.write();
    return count;
  }

  count(): number { this.prune(true); return this.devices.length; }

  private read(): StoredDevice[] {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new FleetError('forbidden', 'trusted-device store is not a regular private file');
      if (stat.size > MAX_STORE_BYTES)
        throw new FleetError('forbidden', 'trusted-device store is oversized');
      chmodSync(this.path, 0o600);
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<DeviceFile>;
      if (parsed.version !== VERSION || !Array.isArray(parsed.devices)) return [];
      return parsed.devices.slice(0, 128).filter((device): device is StoredDevice => Boolean(
        device && typeof device.id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(device.id)
        && typeof device.secretHash === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(device.secretHash)
        && Number.isFinite(device.pairedAt) && Number.isFinite(device.lastUsedAt)
        && Number.isFinite(device.expiresAt),
      ));
    } catch (error) {
      if (error instanceof FleetError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Corrupt content fails closed. A later explicit pairing atomically
      // replaces it; no credential is recovered or guessed.
      return [];
    }
  }

  private prune(persist: boolean): void {
    const now = this.now();
    const before = this.devices.length;
    this.devices = this.devices.filter(device => device.expiresAt > now)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, Math.max(1, Math.min(this.maxDevices, 128)));
    if (persist && before !== this.devices.length) this.write();
  }

  private write(): void {
    replaceFileAtomically(
      this.path,
      JSON.stringify({ version: VERSION, devices: this.devices } satisfies DeviceFile, null, 2) + '\n',
      0o600,
    );
    chmodSync(this.path, 0o600);
  }
}

export const TRUSTED_DEVICE_MAX_AGE_SECONDS = DEFAULT_TTL_MS / 1000;
