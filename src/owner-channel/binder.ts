import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { replaceFileAtomically } from '../atomic-file.js';

export const OWNER_BIND_HANDOFF_TIMEOUT_MS = 5_000;
const OWNER_BIND_POLL_MS = 50;
const LOCK_DIR = '.owner-channel-binder.lock';
const LAST_OWNER_FILE = '.owner-channel-binder.json';

interface BinderOwner {
  version: 1;
  role: string;
  identity: string;
  pid: number;
  marker?: string;
  instance: string;
  acquiredAt: number;
}

interface ReleasedBinder extends BinderOwner {
  releasedAt: number;
}

export interface OwnerBinderDeps {
  now?(): number;
  sleep?(ms: number): Promise<void>;
  alive?(pid: number): boolean;
  processMarker?(pid: number): string | undefined;
}

export interface OwnerBinderLease {
  /** True only when a prior binder for this exact role and identity was observed. */
  inherited: boolean;
  release(): void;
}

export class OwnerBinderConflictError extends Error {}
export class OwnerBinderHandoffTimeoutError extends Error {}

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Linux PID-reuse fence. Other platforms return undefined and stay conservative. */
const defaultProcessMarker = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return stat.slice(end + 2).split(/\s+/)[19];
  } catch { return undefined; }
};

function parseOwner(path: string): BinderOwner {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new OwnerBinderConflictError('owner-channel binder ownership cannot be verified safely'); }
  const owner = value as Partial<BinderOwner>;
  if (owner.version !== 1 || typeof owner.role !== 'string' || typeof owner.identity !== 'string'
      || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 2
      || typeof owner.instance !== 'string' || !owner.instance
      || !Number.isFinite(owner.acquiredAt))
    throw new OwnerBinderConflictError('owner-channel binder ownership cannot be verified safely');
  return owner as BinderOwner;
}

function sameOwner(a: BinderOwner, b: BinderOwner): boolean {
  return a.instance === b.instance && a.pid === b.pid && a.role === b.role
    && a.identity === b.identity;
}

/**
 * Serialize the one supervisor-owned binder for a role. A live matching holder
 * is an overlapping predecessor and gets a bounded handoff window. A holder
 * for any other role/identity, or unverifiable metadata, remains fail-closed.
 */
export async function acquireOwnerBinderLease(
  stateDir: string,
  role: string,
  identity: string,
  deps: OwnerBinderDeps = {},
  timeoutMs = OWNER_BIND_HANDOFF_TIMEOUT_MS,
): Promise<OwnerBinderLease> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const alive = deps.alive ?? defaultAlive;
  const processMarker = deps.processMarker ?? defaultProcessMarker;
  const lockDir = join(stateDir, LOCK_DIR);
  const ownerPath = join(lockDir, 'owner.json');
  const releasedPath = join(stateDir, LAST_OWNER_FILE);
  const startedAt = now();
  let inherited = false;
  const ours: BinderOwner = {
    version: 1, role, identity, pid: process.pid,
    ...(processMarker(process.pid) ? { marker: processMarker(process.pid) } : {}),
    instance: randomUUID(), acquiredAt: startedAt,
  };

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(ownerPath, JSON.stringify(ours) + '\n', { mode: 0o600 });
      try {
        const released = JSON.parse(readFileSync(releasedPath, 'utf8')) as Partial<ReleasedBinder>;
        if (released.version === 1 && released.role === role && released.identity === identity
            && Number.isFinite(released.releasedAt)
            && now() - Number(released.releasedAt) <= timeoutMs * 2)
          inherited = true;
      } catch { /* absence/corruption cannot grant recovery authority */ }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let current: BinderOwner;
      try { current = parseOwner(ownerPath); }
      catch (readError) {
        // The winning process may be between atomic mkdir and its tiny metadata write.
        if (now() - startedAt < OWNER_BIND_POLL_MS * 2) {
          await sleep(OWNER_BIND_POLL_MS);
          continue;
        }
        throw readError;
      }
      if (current.role !== role || current.identity !== identity)
        throw new OwnerBinderConflictError(
          `owner-channel identity '${identity}' is reserved by foreign binder `
          + `'${current.role}' for '${current.identity}'`);
      inherited = true;
      const currentMarker = processMarker(current.pid);
      const stale = !alive(current.pid)
        || Boolean(current.marker && currentMarker && current.marker !== currentMarker);
      if (stale) {
        // Re-read before removal so a just-replaced lock is never deleted.
        const check = parseOwner(ownerPath);
        if (sameOwner(current, check)) rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (now() - startedAt >= timeoutMs)
        throw new OwnerBinderHandoffTimeoutError(
          `previous '${role}' supervisor still owns owner-channel identity '${identity}' `
          + `after ${timeoutMs}ms bounded handoff`);
      await sleep(Math.min(OWNER_BIND_POLL_MS, Math.max(1, timeoutMs - (now() - startedAt))));
    }
  }

  let released = false;
  return {
    inherited,
    release() {
      if (released) return;
      released = true;
      try {
        const current = parseOwner(ownerPath);
        if (!sameOwner(current, ours)) return;
        replaceFileAtomically(releasedPath, JSON.stringify({
          ...ours, releasedAt: now(),
        } satisfies ReleasedBinder) + '\n', 0o600);
        rmSync(lockDir, { recursive: true, force: true });
      } catch { /* never remove ownership which cannot be proven to be ours */ }
    },
  };
}
