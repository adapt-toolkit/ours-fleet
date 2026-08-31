import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { canonicalJson } from '../canonical-json.js';
import type { AgentTemplateDefinition } from '../config.js';
import { randomUUID } from 'node:crypto';

interface SealedLaunchSnapshot {
  schema_version: 1;
  definitions: Record<string, AgentTemplateDefinition>;
}

const launchSnapshotDir = () => join(stateRoot(), 'launch-snapshots');
const launchSnapshotPath = (hash: string) => join(launchSnapshotDir(), `${hash}.json`);
const launchSnapshotLock = () => join(stateRoot(), '.launch-snapshot.lock');

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (uid !== undefined && stat.uid !== uid))
    throw new Error('launch snapshot directory has unsafe ownership or permissions');
}

/** Cross-process exclusion used from seal through durable Room publication. */
export function acquireLaunchSnapshotLock(options: {
  beforePublish?: (claimPath: string, lockPath: string) => void;
} = {}): () => void {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  const path = launchSnapshotLock();
  const token = randomUUID();
  let reclaimed = false;
  for (;;) {
    const claim = `${path}.claim.${process.pid}.${randomUUID()}`;
    try {
      mkdirSync(claim, { mode: 0o700 });
      writeFileSync(join(claim, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      options.beforePublish?.(claim, path);
      renameSync(claim, path);
      if (reclaimed) sweepUnreferencedSnapshotsLocked();
      return () => {
        try {
          const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { token?: string };
          if (owner.token === token) rmSync(path, { recursive: true, force: true });
        } catch { /* ownership cannot be proved; never remove a successor */ }
      };
    } catch (error) {
      rmSync(claim, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      let alive = true;
      try {
        const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { pid?: number };
        if (typeof owner.pid !== 'number') alive = false;
        else try { process.kill(owner.pid, 0); } catch { alive = false; }
      } catch { alive = false; }
      if (!alive) { rmSync(path, { recursive: true, force: true }); reclaimed = true; continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function referencedByRetainedState(hash: string): boolean {
  for (const directory of ['tasks', 'rooms']) {
    const root = join(stateRoot(), directory);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter(entry => entry.endsWith('.json'))) {
      try { if (readFileSync(join(root, name), 'utf8').includes(hash)) return true; }
      catch { return true; }
    }
  }
  return false;
}

function sweepUnreferencedSnapshotsLocked(): void {
  const dir = launchSnapshotDir();
  if (!existsSync(dir)) return;
  assertPrivateDirectory(dir);
  for (const name of readdirSync(dir).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))) {
    const hash = name.slice(0, -5);
    if (!referencedByRetainedState(hash)) unlinkSync(join(dir, name));
  }
}

export function redactLaunchDefinition(value: unknown, key = ''): unknown {
  if (['env', 'harness_options', 'session_options', 'owner_channel', 'auth_proxy'].includes(key))
    return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redactLaunchDefinition(item));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([child, item]) => [child, redactLaunchDefinition(item, child)]));
  return value;
}

export function sealLaunchSnapshot(
  definitions: Record<string, AgentTemplateDefinition>,
): string {
  const payload: SealedLaunchSnapshot = { schema_version: 1, definitions: structuredClone(definitions) };
  const bytes = `${canonicalJson(payload)}\n`;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const path = launchSnapshotPath(hash);
  const dir = launchSnapshotDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(dir);
  if (!existsSync(path)) replaceFileAtomically(path, bytes, 0o600);
  else readLaunchSnapshot(hash);
  return hash;
}

export function readLaunchSnapshot(hash: string): Record<string, AgentTemplateDefinition> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid launch snapshot hash');
  const dir = launchSnapshotDir();
  const path = launchSnapshotPath(hash);
  const dirStat = lstatSync(dir);
  const fileStat = lstatSync(path);
  const uid = process.getuid?.();
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0
      || (uid !== undefined && dirStat.uid !== uid))
    throw new Error('launch snapshot directory has unsafe ownership or permissions');
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0
      || (uid !== undefined && fileStat.uid !== uid))
    throw new Error(`launch snapshot ${hash} has unsafe ownership or permissions`);
  const bytes = readFileSync(path, 'utf8');
  if (createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new Error(`launch snapshot ${hash} failed integrity verification`);
  const parsed = JSON.parse(bytes) as SealedLaunchSnapshot;
  if (parsed.schema_version !== 1 || !parsed.definitions || typeof parsed.definitions !== 'object')
    throw new Error(`launch snapshot ${hash} has unsupported schema`);
  return parsed.definitions;
}

/** Delete a sealed snapshot only after no retained Task/Room record references it. */
export function releaseLaunchSnapshot(hash: string): void {
  const release = acquireLaunchSnapshotLock();
  try {
  if (referencedByRetainedState(hash)) return;
  const path = launchSnapshotPath(hash);
  if (existsSync(path)) unlinkSync(path);
  } finally { release(); }
}
