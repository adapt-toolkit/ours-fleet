import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
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

/** Recover only owner access on a pinned, real entry. Never chmod a symlink
 * target or a hardlinked file through an alias outside the deletion tree.
 * Linux O_PATH can pin an entry even when a same-owner fixture removed every
 * permission; /proc/self/fd then addresses that inode rather than its old name.
 */
function withOwnerPermissions<T>(path: string, before: Stats, bits: number, work: (accessPath: string) => T, rollback = false): T {
  if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) fail(`unsafe permission repair ${path}`);
  const changed = (before.mode & bits) !== bits;
  const uid = process.geteuid?.();
  if (changed && (uid === undefined || before.uid !== uid)) fail(`cannot restore owner access to ${path}: owned by uid ${before.uid}`);
  if (changed && before.isFile() && before.nlink !== 1) fail(`cannot restore owner access to hardlinked Git metadata ${path}`);
  let descriptor: number, pathDescriptor = false;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (process.platform !== 'linux' || (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    // O_PATH is Linux-specific and is not exposed in Node's fs.constants.
    descriptor = openSync(path, 0x200000 | constants.O_NOFOLLOW);
    pathDescriptor = true;
  }
  const setMode = (mode: number) => pathDescriptor
    ? chmodSync(`/proc/self/fd/${descriptor}`, mode)
    : fchmodSync(descriptor, mode);
  try {
    const pinned = fstatSync(descriptor);
    if (pinned.dev !== before.dev || pinned.ino !== before.ino || pinned.uid !== before.uid
        || pinned.mode !== before.mode || pinned.nlink !== before.nlink)
      fail(`entry changed before permission repair ${path}`);
    if (changed) setMode((before.mode & 0o7777) | bits);
    try {
      const assertNamedEntry = () => {
        const named = lstatSync(path);
        if (named.dev !== before.dev || named.ino !== before.ino || named.uid !== before.uid
            || named.isSymbolicLink() || named.isDirectory() !== before.isDirectory())
          fail(`entry changed during permission repair ${path}`);
      };
      assertNamedEntry();
      const result = work(process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : path);
      assertNamedEntry();
      return result;
    } catch (error) { if (rollback && changed) setMode(before.mode & 0o7777); throw error; }
  } finally { closeSync(descriptor); }
}

/** Caller must first prove the exact workspace marker or retired archive
 * provenance, and hold its lifecycle lock with all managed writers retired.
 * Directories need owner rwx for recursive removal; ordinary files do not.
 */
export function prepareOwnedDeletionTree(path: string): void {
  assertSafeAncestors(path);
  const uid = process.geteuid?.();
  if (uid === undefined || lstatSync(path).uid !== uid) fail(`deletion root is not owned by the current uid: ${path}`);
  const device = lstatSync(dirname(path)).dev;
  const visit = (dir: string): void => {
    const entry = lstatSync(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`unsafe deletion directory ${dir}`);
    if (entry.dev !== device) fail(`foreign mounted directory ${dir}`);
    withOwnerPermissions(dir, entry, 0o700, accessDir => {
      for (const child of readdirSync(accessDir, { withFileTypes: true })) {
        if (process.platform !== 'linux') {
          const named = lstatSync(dir);
          if (named.dev !== entry.dev || named.ino !== entry.ino || named.isSymbolicLink())
            fail(`deletion directory changed during traversal ${dir}`);
        }
        if (child.isDirectory() && !child.isSymbolicLink()) visit(join(accessDir, child.name));
      }
    });
  };
  visit(path);
}

function markedForDeletion(w: OwnedWorkspace): void {
  assertSafeAncestors(w.path);
  const before = lstatSync(w.path);
  if (process.geteuid?.() !== before.uid) fail(`workspace root is not owned by the current uid: ${w.path}`);
  if (before.dev !== lstatSync(dirname(w.path)).dev) fail(`foreign mounted directory ${w.path}`);
  // The durable exact path plus current-UID real root permit temporary owner
  // access to read the marker, but never substitute for the marker itself.
  withOwnerPermissions(w.path, before, 0o700, () => marked(w.path, w), true);
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
export function auditWorkspaceGit(path: string, options: { forDeletion?: boolean } = {}): void {
  const rootEntry = lstatSync(path);
  if (options.forDeletion) prepareOwnedDeletionTree(path);
  const device = lstatSync(path).dev;
  if (options.forDeletion && (lstatSync(path).ino !== rootEntry.ino || device !== rootEntry.dev || lstatSync(path).isSymbolicLink()))
    fail(`workspace changed before Git audit ${path}`);
  const readPointer = (file: string): string => {
    if (!options.forDeletion) return readFileSync(file, 'utf8');
    const before = lstatSync(file);
    if (before.dev !== device) fail(`foreign mounted Git metadata ${file}`);
    return withOwnerPermissions(file, before, 0o400, accessFile => readFileSync(accessFile, 'utf8'));
  };
  const visit = (dir: string, accessDir = dir, admin = false): void => {
    const before = lstatSync(accessDir);
    const inspect = (pinnedDir: string): void => {
      admin ||= Boolean(stat(join(pinnedDir, 'HEAD')) && (stat(join(pinnedDir, 'objects')) || stat(join(pinnedDir, 'commondir'))));
      for (const entry of readdirSync(pinnedDir, { withFileTypes: true })) {
        if (options.forDeletion && process.platform !== 'linux') {
          const named = lstatSync(accessDir);
          if (named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink())
            fail(`directory changed during Git audit ${dir}`);
        }
        const p = join(pinnedDir, entry.name);
        if (entry.isSymbolicLink()) {
          if (admin || entry.name === '.git' || entry.name === 'commondir' || entry.name === 'gitdir')
            fail(`symlink git metadata ${p}`);
          continue; // rm unlinks ordinary artifact symlinks, never follows them.
        }
        if (entry.isDirectory()) {
          if (lstatSync(p).dev !== device) fail(`foreign mounted directory ${p}`);
          visit(join(dir, entry.name), p, admin || entry.name === '.git'); continue;
        }
        if (!entry.isFile()) continue; // sockets/FIFOs in retired runtime state are unlinked, never opened
        if (entry.name === '.git') {
          const value = readPointer(p).trim();
          if (!value.startsWith('gitdir: ')) fail(`invalid git file ${p}`);
          const gitdir = ownedPointer(path, dir, value.slice(8));
          if (!stat(gitdir)?.isDirectory()) fail(`missing git directory ${gitdir}`);
        }
        // Git admin files, including bare repositories and submodules.
        if (entry.name === 'commondir' && (admin || stat(join(pinnedDir, 'HEAD')))) {
          const common = ownedPointer(path, dir, readPointer(p));
          if (!stat(common)?.isDirectory()) fail(`invalid git common directory ${common}`);
        }
        if (entry.name === 'gitdir' && (admin || stat(join(pinnedDir, 'commondir')))) {
          const target = ownedPointer(path, dir, readPointer(p));
          if (stat(target) && !stat(target)?.isFile()) fail(`invalid worktree backlink ${target}`);
        }
      }
    };
    if (options.forDeletion) withOwnerPermissions(accessDir, before, 0o700, inspect);
    else inspect(accessDir);
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
    markedForDeletion(w);
    auditWorkspaceGit(w.path, { forDeletion: true });
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
    markedForDeletion(w);
    auditWorkspaceGit(w.path, { forDeletion: true });
    renameSync(w.path, tomb);
  }
  if (stat(pending)) {
    if (readdirSync(pending).length) marked(pending, w);
    if (readdirSync(pending).some(name => name !== MARKER)) fail('unexpected provisioning artifacts');
    rmSync(pending, { recursive: true });
  }
  if (stat(tomb)) {
    // This exact token-derived tombstone has already passed the marker and
    // Git audit; partial removal may have consumed those proofs on disk.
    prepareOwnedDeletionTree(tomb);
    rmSync(tomb, { recursive: true });
  }
}
