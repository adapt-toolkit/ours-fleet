import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically, withSynchronousFileLock } from './atomic-file.js';
import { stateRoot } from './paths.js';

const registryPath = () => join(stateRoot(), 'erased-resources.json');
const lockPath = () => join(stateRoot(), 'locks', 'audit-erasure');
const ledgerNames = ['.fleet-command-audit.json', '.owner-channel-command-audit.json', '.owner-channel-lifecycle-outbox.json'];
export const erasedArg = (value: string): string => `[erased:${createHash('sha256').update(value).digest('hex')}]`;
function registry(): Set<string> {
  if (!existsSync(registryPath())) return new Set();
  const value = JSON.parse(readFileSync(registryPath(), 'utf8'));
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Invalid erasure registry');
  return new Set(value);
}
/** Preserve delivery/deduplication metadata while removing owned presentation content. */
function redact(value: any, erased: Set<string>): any {
  if (Array.isArray(value)) return value.map(item => redact(item, erased));
  if (!value || typeof value !== 'object') return value;
  const next = { ...value };
  const kind = value.kind === 'lifecycle_failure' ? value.resource?.toLowerCase() : value.kind === 'agent_started' ? 'agent' : value.kind;
  if (typeof value.id === 'string' && erased.has(`${kind}:${value.id}`)) {
    for (const key of ['title', 'reason', 'roomName', 'label', 'template', 'configuration', 'model', 'permissions']) delete next[key];
    if (kind === 'task') next.agents = [];
    if (kind === 'room') { delete next.name; next.participants = []; }
    if (kind === 'agent') { next.name = 'erased'; next.brain = '[erased]'; next.role = '[erased]'; next.inherited = []; }
  }
  if (typeof value.roomId === 'string' && erased.has(`room:${value.roomId}`)) {
    delete next.roomName;
    if (kind === 'task') next.agents = [];
  }
  const resources = value.outcome?.resourceIds;
  const ownsAttempt = resources && Object.entries(resources).some(([key, id]) => erased.has(`${key}:${id}`));
  const ownsPresentation = value.outcome?.presentations?.some((p: any) => erased.has(`${p.kind === 'agent_started' ? 'agent' : p.kind}:${p.id}`));
  if ((ownsAttempt || ownsPresentation) && Array.isArray(value.argv) && !value.erased) {
    next.argv = value.argv.map(erasedArg); next.erased = true;
  }
  for (const key of Object.keys(next)) if (typeof next[key] === 'object') next[key] = redact(next[key], erased);
  return next;
}
export function redactErasedContent<T>(value: T): T { return redact(value, registry()); }
/** Every cooperative writer filters stale in-memory snapshots under the same lock as erasure. */
export function writePrivacyFilteredLedger(path: string, value: unknown): void {
  withSynchronousFileLock(lockPath(), () => replaceFileAtomically(path, JSON.stringify(redact(value, registry())) + '\n'));
}
/** Content-free resource IDs persist to prevent active writers resurrecting erased labels. */
export function eraseResourcePresentations(resources: ReadonlyArray<{ kind: 'task' | 'room' | 'agent'; id: string }>): void {
  withSynchronousFileLock(lockPath(), () => {
    const erased = registry();
    for (const resource of resources) erased.add(`${resource.kind}:${resource.id}`);
    replaceFileAtomically(registryPath(), JSON.stringify([...erased]));
    for (const root of [join(stateRoot(), 'agents'), join(stateRoot(), 'tmp'), join(stateRoot(), 'recovery', 'temporary')]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        for (const name of ledgerNames) {
          const path = join(root, entry.name, name);
          if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
          const old = JSON.parse(readFileSync(path, 'utf8'));
          replaceFileAtomically(path, JSON.stringify(redact(old, erased)) + '\n');
        }
      }
    }
  });
}
