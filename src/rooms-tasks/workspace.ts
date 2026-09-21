import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stateRoot } from '../paths.js';

/** Persisted before allocation. Never infer ownership from an Agent's cwd. */
export interface OwnedWorkspace {
  version: 1;
  owner: 'task' | 'room';
  id: string;
  path: string;
  token: string;
}
const MARKER = '.fleet-workspace.json';
export class WorkspaceError extends Error {}
function fail(message: string): never { throw new WorkspaceError(`workspace: ${message}`); }
function stat(path: string) {
  try { return lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
export function assertSafeAncestors(path: string): void {
  const absolute = resolve(path);
  let part = absolute;
  for (;;) {
    const s = stat(part);
    if (s && (s.isSymbolicLink() || !s.isDirectory())) fail(`unsafe directory ${part}`);
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
function root(owner: OwnedWorkspace['owner']): string {
  return resolve(stateRoot(), 'workspaces', owner === 'task' ? 'tasks' : 'rooms');
}
export function planWorkspace(owner: OwnedWorkspace['owner'], id: string): OwnedWorkspace {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail('invalid owner ID');
  return { version: 1, owner, id, path: join(root(owner), id), token: randomUUID() };
}
export function validateWorkspace(w: OwnedWorkspace, owner = w.owner, id = w.id): void {
  if (w.version !== 1 || !['task', 'room'].includes(w.owner) || w.owner !== owner || w.id !== id
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id)
      || !/^[a-f0-9-]{36}$/.test(w.token) || !isAbsolute(w.path)
      || w.path !== join(root(w.owner), w.id)) fail('invalid recorded ownership/path');
  assertSafeAncestors(dirname(w.path));
}
function marked(path: string, w: OwnedWorkspace): void {
  assertSafeAncestors(path);
  const marker = join(path, MARKER);
  if (!stat(marker)?.isFile() || stat(marker)?.isSymbolicLink()) fail('missing/unsafe ownership marker');
  const actual = JSON.parse(readFileSync(marker, 'utf8')) as OwnedWorkspace;
  if (JSON.stringify(actual) !== JSON.stringify(w)) fail('ownership marker mismatch');
}
function staging(w: OwnedWorkspace, phase: string): string {
  return join(dirname(w.path), `.${w.id}.${w.token}.${phase}`);
}
/** Atomic directory publication; retry uses the durable token, never adopts another folder. */
export function ensureWorkspace(w: OwnedWorkspace): string {
  validateWorkspace(w);
  if (stat(staging(w, 'deleting'))) fail('deletion already started');
  if (stat(w.path)) { marked(w.path, w); return w.path; }
  mkdirSync(dirname(w.path), { recursive: true, mode: 0o700 });
  assertSafeAncestors(dirname(w.path));
  const stage = staging(w, 'provisioning');
  if (!stat(stage)) mkdirSync(stage, { mode: 0o700 });
  assertSafeAncestors(stage);
  if (readdirSync(stage).length === 0)
    writeFileSync(join(stage, MARKER), JSON.stringify(w), { flag: 'wx', mode: 0o600 });
  marked(stage, w);
  try { renameSync(stage, w.path); } catch (error) {
    // Another allocator may have published this exact durable intent.
    if (!stat(w.path)) throw error;
    marked(w.path, w);
  }
  return w.path;
}
function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function ownedPointer(base: string, from: string, value: string): string {
  if (!value.trim() || /[\r\n]/.test(value.trim())) fail('malformed git pointer');
  const target = resolve(from, value.trim());
  if (!inside(base, target)) fail(`foreign git metadata ${target}`);
  assertSafeAncestors(dirname(target));
  if (stat(target)?.isSymbolicLink()) fail(`symlink git metadata ${target}`);
  return target;
}
/** Audit both directions of Git worktree registration, without executing repository config/hooks.
 * All registrations and common dirs must be inside this workspace. Removing the complete
 * workspace then removes their registries atomically with the owned repositories; never prune.
 */
export function auditWorkspaceGit(path: string): void {
  const device = lstatSync(path).dev;
  const visit = (dir: string, admin = false): void => {
    admin ||= Boolean(stat(join(dir, 'HEAD')) && (stat(join(dir, 'objects')) || stat(join(dir, 'commondir'))));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (admin || entry.name === '.git' || entry.name === 'commondir' || entry.name === 'gitdir')
          fail(`symlink git metadata ${p}`);
        continue; // rm unlinks ordinary artifact symlinks, never follows them.
      }
      if (entry.isDirectory()) {
        if (lstatSync(p).dev !== device) fail(`foreign mounted directory ${p}`);
        visit(p, admin || entry.name === '.git'); continue;
      }
      if (!entry.isFile()) continue; // sockets/FIFOs in retired runtime state are unlinked, never opened
      if (entry.name === '.git') {
        const value = readFileSync(p, 'utf8').trim();
        if (!value.startsWith('gitdir: ')) fail(`invalid git file ${p}`);
        const gitdir = ownedPointer(path, dir, value.slice(8));
        if (!stat(gitdir)?.isDirectory()) fail(`missing git directory ${gitdir}`);
      }
      // Git admin files, including bare repositories and submodules.
      if (entry.name === 'commondir' && (admin || stat(join(dir, 'HEAD')))) {
        const common = ownedPointer(path, dir, readFileSync(p, 'utf8'));
        if (!stat(common)?.isDirectory()) fail(`invalid git common directory ${common}`);
      }
      if (entry.name === 'gitdir' && (admin || stat(join(dir, 'commondir')))) {
        const target = ownedPointer(path, dir, readFileSync(p, 'utf8'));
        if (stat(target) && !stat(target)?.isFile()) fail(`invalid worktree backlink ${target}`);
      }
    }
  };
  visit(path);
}
/** Called only after all managed writers retire, under the owner's lifecycle lock.
 * The tombstone is derived from the durable unguessable token. A crash during rm
 * resumes that exact tombstone even if rm already removed its marker.
 */
export function assertWorkspaceDeletable(w: OwnedWorkspace, owner: OwnedWorkspace['owner'], id: string): void {
  validateWorkspace(w, owner, id);
  if (stat(w.path)) {
    if (stat(staging(w, 'deleting'))) fail('both live and deleting workspace exist');
    marked(w.path, w);
    auditWorkspaceGit(w.path);
  }
  const pending = staging(w, 'provisioning');
  if (stat(pending)) {
    assertSafeAncestors(pending);
    if (readdirSync(pending).length) marked(pending, w);
    if (readdirSync(pending).some(name => name !== MARKER)) fail('unexpected provisioning artifacts');
  }
  if (stat(staging(w, 'deleting'))) assertSafeAncestors(staging(w, 'deleting'));
}

export function deleteWorkspace(w: OwnedWorkspace, owner: OwnedWorkspace['owner'], id: string): void {
  assertWorkspaceDeletable(w, owner, id);
  const tomb = staging(w, 'deleting');
  const pending = staging(w, 'provisioning');
  if (stat(w.path)) {
    if (stat(tomb)) fail('both live and deleting workspace exist');
    marked(w.path, w);
    auditWorkspaceGit(w.path);
    renameSync(w.path, tomb);
  }
  if (stat(pending)) {
    if (readdirSync(pending).length) marked(pending, w);
    if (readdirSync(pending).some(name => name !== MARKER)) fail('unexpected provisioning artifacts');
    rmSync(pending, { recursive: true });
  }
  if (stat(tomb)) {
    assertSafeAncestors(tomb);
    rmSync(tomb, { recursive: true });
  }
}
