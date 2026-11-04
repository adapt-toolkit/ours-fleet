import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

import { withFileLock, withSynchronousFileLock } from '../atomic-file.js';
import { agentsRoot, stateRoot, tmpRoot } from '../paths.js';
import { listMembers } from '../supervisor/catalog.js';
import { readTempSupervisor, TEMP_SUPERVISOR_FILE } from '../temp-lifecycle.js';
import { validLayoutKey } from './layout-config.js';
import { roomsDir } from './room-state.js';
import { getTask, TaskStateError, updateTaskWorkspaceRemoval } from './task-state.js';
import { TASK_OPERATION_LOCK_STALE_MS, taskOperationLockPath } from './terminal.js';
import type { TaskDeletionActor, TaskRecord } from './types.js';
import { deleteWorkspace, validateWorkspace, workspaceEntriesPresent } from './workspace.js';

/**
 * Explicit Owner removal of a Done task's working folder. Only the exact
 * recorded task-owned folder is removed, through the guarded workspace
 * deletion (marker, Git registration, symlink and mount fences). The task
 * record, Progress, To review files (a separate store), agent archives and
 * rooms' history are never touched. Every precondition is re-read under the
 * task-operation lock that serializes terminal settlement, deletion and
 * recovery; anything that cannot be proven idle is refused, never stopped.
 */

export type WorkspaceRemovalResult = 'removed' | 'already_removed' | 'already_missing';

export interface WorkspaceRemovalOutcome {
  task: TaskRecord;
  result: WorkspaceRemovalResult;
  /** Retained text fields that mention the removed folder; those paths no longer resolve. */
  mentions: string[];
}

export interface WorkspaceRemovalDeps {
  /** Working directories of configured permanent agents; undefined when the configuration is unreadable. */
  permanentCwds?: readonly (string | undefined)[];
  /** Test seam: processes whose cwd, root or open files are inside `path`, or cannot be read. */
  processesUsing?(path: string, context: ProcessCheckContext): ProcessUse;
}

/** True when some directory on the way to `path` is ours and closed to group and others. */
function closedToOtherUsers(path: string): boolean {
  const uid = process.geteuid?.();
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat && stat.uid === uid && (stat.mode & 0o011) === 0) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Every process whose cwd, root or open file descriptor is inside `path`, or
 * whose use cannot be excluded. Only Linux exposes this without extra tools;
 * elsewhere removal is refused. When a process's entries are unreadable (for
 * example non-dumpable, or in a container), it is excluded only by evidence:
 * it is a zombie, its mount table cannot reach the folder's filesystem
 * location, it is the user's service manager (attested by the system manager)
 * whose own records name nothing in the folder, or it is that manager's PAM
 * helper started before the folder existed; otherwise it is reported.
 * Other users' unreadable processes are skipped when a private ancestor
 * closes the folder to them; a superuser process is outside this check.
 */
/** A same-user process whose cwd and descriptors cannot be read. */
export interface UnverifiedProcess { token: string; description: string }

export interface ProcessUse {
  /** Processes proven to use the folder. */
  users: string[];
  /** Processes whose use can be neither proven nor excluded. */
  unverified: UnverifiedProcess[];
}

export interface ProcessCheckContext {
  /** The folder's recorded path; configuration names it, not its tombstone. */
  original: string;
  /** When the folder came into existence (ms since the epoch). */
  createdAt: number;
}

export function processesUsing(path: string, context: ProcessCheckContext): ProcessUse {
  if (process.platform !== 'linux')
    refuse('this platform cannot verify that no process is using the folder');
  const uid = process.geteuid?.();
  const othersClosed = closedToOtherUsers(path);
  const target = filesystemLocation(path);
  const manager = userManagerPid(uid);
  let managerUse: string | undefined | null = null; // computed once, only when needed
  const inside = (link: string) => contains(path, link.replace(/ \(deleted\)$/, ''));
  const gone = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
  const denied = (error: unknown) => ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
  const users: string[] = [];
  const unverified: UnverifiedProcess[] = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let unreadable = false;
    const read = (link: string): string | undefined => {
      try { return readlinkSync(link); }
      catch (error) {
        if (gone(error)) return undefined;
        if (denied(error)) { unreadable = true; return undefined; }
        throw error;
      }
    };
    const links = ['cwd', 'root'].map(name => read(`/proc/${pid}/${name}`));
    try { for (const fd of readdirSync(`/proc/${pid}/fd`)) links.push(read(`/proc/${pid}/fd/${fd}`)); }
    catch (error) {
      if (denied(error)) unreadable = true;
      else if (!gone(error)) throw error;
    }
    if (links.some(link => link !== undefined && isAbsolute(link) && inside(link))) { users.push(pid); continue; }
    if (!unreadable) continue;
    const owner = lstatSync(`/proc/${pid}`, { throwIfNoEntry: false })?.uid;
    if (owner === undefined) continue; // exited meanwhile
    if (owner !== uid && othersClosed) continue;
    const status = readProc(`/proc/${pid}/stat`);
    if (status === undefined || /^\d+ \(.*\) [ZX] /s.test(status)) continue; // exited or a zombie: no cwd or files
    // Nothing readable proves this process holds nothing in the folder: a retained cwd or
    // descriptor survives namespace and chroot changes. Read-only context only informs the Owner.
    // The short kernel name only: a command line may carry secrets.
    const name = /^\d+ \((.*)\) /s.exec(status)?.[1]?.replace(/[^\w .:@()-]/g, '?') ?? '?';
    const mounts = readProc(`/proc/${pid}/mountinfo`);
    let hint: string | undefined;
    if (manager && pid === manager) {
      if (managerUse === null) managerUse = userManagerUse(uid!, [path, context.original]);
      // A record naming the folder is positive evidence of use, not uncertainty.
      if (managerUse !== undefined && !/cannot be|unknown/.test(managerUse)) {
        users.push(`${pid} (user service manager: ${managerUse})`);
        continue;
      }
      hint = managerUse === undefined ? "user service manager; its records name nothing in the folder" : `user service manager; ${managerUse}`;
    } else if (manager && isPamHelper(pid, manager, context.createdAt)) hint = 'PAM helper of the user service manager, started before the folder existed';
    else if (mounts !== undefined && !reaches(mounts, target)) hint = 'own mount namespace without the folder';
    const started = status.slice(status.lastIndexOf(')') + 2).split(' ')[19];
    unverified.push({ token: `${pid}:${started}`, description: `${pid} ${name}${hint ? ` (${hint})` : ''}` });
  }
  return { users, unverified };
}

/**
 * The user's service manager as attested by the system manager (root-owned PID 1),
 * not by anything the process says about itself. Undefined when it cannot be asked.
 */
function userManagerPid(uid: number | undefined): string | undefined {
  if (uid === undefined) return undefined;
  try {
    const pid = execFileSync('systemctl', ['show', `user@${uid}.service`, '--property=MainPID', '--value'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[1-9]\d*$/.test(pid) ? pid : undefined;
  } catch { return undefined; }
}

const run = (command: string, args: string[]) => {
  // The user manager's bus lives in the user's runtime directory, which a Fleet service may not inherit.
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.geteuid?.()}` };
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], env }); }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0];
    throw Error(stderr || (error as Error).message);
  }
};

/**
 * Whether the user service manager may use the folder, from its own read-only
 * records: its attested working directory, socket units' paths and every
 * file descriptor store (systemd 254+). Undefined when none names the folder;
 * otherwise the reason, including any record that cannot be read.
 */
export function userManagerUse(uid: number, roots: string[], exec: typeof run = run): string | undefined {
  const hits = (candidate: string) => isAbsolute(candidate) && roots.some(root => within(root, candidate));
  try {
    let cwd = exec('systemctl', ['show', `user@${uid}.service`, '--property=WorkingDirectory', '--value']).trim().replace(/^[-!]+/, '');
    if (cwd === '~') cwd = process.env.HOME ?? '';
    if (!cwd) cwd = '/';
    if (hits(cwd)) return `works in ${cwd}`;
    const units = exec('systemctl', ['--user', 'show', '*', '--property=Id', '--property=NFileDescriptorStore', '--property=Listen'])
      .split(/\n\s*\n/).map(block => {
        const unit: Record<string, string[]> = {};
        for (const line of block.split('\n').filter(Boolean)) (unit[line.slice(0, line.indexOf('='))] ??= []).push(line);
        return unit;
      });
    if (!units.some(unit => unit.Id)) return 'its units cannot be listed';
    for (const unit of units) {
      const id = unit.Id?.[0]?.slice(3);
      for (const line of unit.Listen ?? []) {
        const listen = line.slice(7).replace(/ \([^)]*\)$/, '');
        if (hits(listen)) return `${id} listens on ${listen}`;
      }
      const stored = Number(unit.NFileDescriptorStore?.[0]?.slice(21) ?? 0);
      if (!id || !Number.isSafeInteger(stored) || stored < 0) return `unit ${id ?? '?'} cannot be read`;
      if (stored === 0) continue;
      const entries = JSON.parse(exec('systemd-analyze', ['--user', 'fdstore', id, '--json=short'])) as Array<{ path?: string; type?: string }>;
      if (!Array.isArray(entries)) return `the file descriptor store of ${id} cannot be read`;
      for (const entry of entries) {
        if (typeof entry.path === 'string' && entry.path && hits(entry.path.replace(/ \(deleted\)$/, '')))
          return `${id} stores ${entry.path}`;
        if (!entry.path && ['directory', 'regular'].includes(entry.type ?? ''))
          return `${id} stores a file whose path is unknown`;
      }
    }
    return undefined;
  } catch (error) {
    return `its records cannot be read (${String((error as Error).message ?? error).split('\n')[0]})`;
  }
}

/**
 * The manager's PAM session helper: a direct child named `(sd-pam)` in the
 * manager's cgroup that started before the folder existed. It is forked when
 * the session opens and then only waits, so it can hold nothing created later.
 */
function isPamHelper(pid: string, manager: string, folderCreatedAt: number): boolean {
  const stat = readProc(`/proc/${pid}/stat`);
  if (!stat) return false;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const cgroup = (id: string) => readProc(`/proc/${id}/cgroup`);
  if (fields[1] !== manager || readProc(`/proc/${pid}/cmdline`)?.replace(/\0+$/, '') !== '(sd-pam)'
      || cgroup(pid) === undefined || cgroup(pid) !== cgroup(manager)) return false;
  const boot = Number(/^btime (\d+)$/m.exec(readProc('/proc/stat') ?? '')?.[1]);
  let ticks = 100;
  try { ticks = Number(run('getconf', ['CLK_TCK']).trim()) || 100; } catch { /* Linux default */ }
  const started = (boot + Number(fields[19]) / ticks) * 1000;
  return Number.isFinite(started) && Number.isFinite(folderCreatedAt) && started < folderCreatedAt;
}

function readProc(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ESRCH', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}


/** Where `path` lives: its device and its path within that filesystem, from our own mount table. */
function filesystemLocation(path: string): { device: string; inside: string } {
  const dev = lstatSync(path).dev;
  // glibc dev_t encoding, as Node reports it on Linux.
  const major = (Math.floor(dev / 256) & 0xfff) | (Math.floor(dev / 2 ** 32) & ~0xfff);
  const minor = (dev & 0xff) | (Math.floor(dev / 4096) & ~0xff & 0xfffff);
  const device = `${major}:${minor}`;
  let best: { point: string; root: string } | undefined;
  for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
    const fields = line.split(' ');
    if (fields[2] !== device) continue;
    const point = unescapeMount(fields[4]);
    if (contains(point, path) && (!best || point.length > best.point.length)) best = { point, root: unescapeMount(fields[3]) };
  }
  if (!best) throw Error(`no mount of device ${device} contains ${path}`);
  return { device, inside: join(best.root, relative(best.point, path)) };
}

function unescapeMount(value = ''): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** True when some mount in the table exposes the filesystem location, or anything under it. */
export function reaches(mountinfo: string, target: { device: string; inside: string }): boolean {
  return mountinfo.split('\n').some(line => {
    const fields = line.split(' ');
    if (fields[2] !== target.device) return false;
    const root = unescapeMount(fields[3]);
    return contains(root, target.inside) || contains(target.inside, root);
  });
}

/** A use of the folder found after its rename; `restore` exists only for a freshly renamed intact folder. */
class InUse extends Error {
  constructor(message: string, readonly restore?: () => void) { super(message); }
}

function refuse(reason: string): never {
  throw new TaskStateError(`cannot remove working files: ${reason}`);
}

/** Component containment: `root` itself or a descendant (`..name` is a descendant). */
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve symlinks through the deepest existing ancestor, following dangling
 * links too: a link to a removed folder still names that folder.
 */
function canonical(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (let links = 0; ;) {
    try { return join(realpathSync(existing), ...rest); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
        if (++links > 40) throw Error(`too many symlinks in ${path}`);
        existing = resolve(dirname(existing), readlinkSync(existing));
        continue;
      }
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** True when `path`, literally or through symlinks, names the folder or a descendant. */
function within(root: string, path: string): boolean {
  return contains(root, resolve(path)) || contains(root, canonical(path));
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/**
 * Every room record, strictly: the general listing skips corrupt records,
 * which here would turn unknown room ownership into a claim that none remains.
 */
function assertNoRoomRecord(task: TaskRecord): void {
  let names: string[];
  try { names = readdirSync(roomsDir()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    refuse(`room records cannot be read (${String(error)})`);
  }
  for (const name of names.filter(name => name.endsWith('.json'))) {
    let room: { room_id?: unknown; task_id?: unknown; workspace?: { path?: unknown } };
    try { room = JSON.parse(readFileSync(join(roomsDir(), name), 'utf8')); }
    catch (error) { refuse(`room record ${name} cannot be read, so its owner is unknown (${String(error)})`); }
    if (!room || typeof room !== 'object' || typeof room.room_id !== 'string')
      refuse(`room record ${name} is invalid, so its owner is unknown`);
    if (room.task_id === task.task_id || room.workspace?.path === task.workspace!.path)
      refuse(`room ${room.room_id} of this task is still open; close it first`);
  }
}

function readRole(dir: string): { cwd?: unknown; roomMemberStartup?: { task_id?: unknown; workspace?: { path?: unknown } } } {
  const file = join(dir, 'role.yaml');
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw Error('unsafe role.yaml');
  const role = parse(readFileSync(file, 'utf8'));
  if (!role || typeof role !== 'object') throw Error('invalid role.yaml');
  return role;
}

/** Agent state that is not archived may still run in, or return to, this folder. */
function assertNoAgentUsesFolder(task: TaskRecord, path: string, deps: WorkspaceRemovalDeps): void {
  let members;
  try { members = listMembers(); }
  catch (error) { refuse(`the Fleet supervisor catalog cannot be read (${String(error)})`); }
  for (const member of members)
    if (member.taskOwner?.taskId === task.task_id)
      refuse(`agent ${member.name} of this mission is still registered with the Fleet supervisor`);

  let entries: Dirent[];
  try { entries = readdirSync(tmpRoot(), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuse(`agent state cannot be read (${String(error)})`);
    entries = [];
  }
  for (const entry of entries) {
    const dir = join(tmpRoot(), entry.name);
    if (entry.isSymbolicLink()) refuse(`agent state ${entry.name} is a symlink, so its use of this folder is unknown`);
    if (!entry.isDirectory()) continue;
    let role, owner, uses;
    try {
      role = readRole(dir);
      // A supervisor record that exists but does not parse proves nothing about its owner.
      const supervisor = readTempSupervisor(dir);
      if (!supervisor) throw Error(`${exists(join(dir, TEMP_SUPERVISOR_FILE)) ? 'invalid' : 'missing'} ${TEMP_SUPERVISOR_FILE}`);
      owner = supervisor?.taskOwner;
      const startup = role.roomMemberStartup;
      if (owner?.taskId === task.task_id || startup?.task_id === task.task_id)
        refuse(`agent ${entry.name} of this mission has not been retired`);
      uses = (typeof role.cwd === 'string' && within(path, role.cwd))
        || (typeof startup?.workspace?.path === 'string' && within(path, startup.workspace.path));
    } catch (error) {
      if (error instanceof TaskStateError) throw error;
      refuse(`agent ${entry.name} has unreadable state, so its use of this folder is unknown (${String(error)})`);
    }
    if (uses) refuse(`agent ${entry.name} works in this folder`);
  }

  // A permanent agent's state records the cwd it was last started with, whatever configuration started it.
  let permanent: Dirent[];
  try { permanent = readdirSync(agentsRoot(), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuse(`permanent agent state cannot be read (${String(error)})`);
    permanent = [];
  }
  for (const entry of permanent) {
    if (entry.isSymbolicLink()) refuse(`permanent agent state ${entry.name} is a symlink, so its use of this folder is unknown`);
    if (!entry.isDirectory()) continue;
    let uses;
    try {
      const file = join(agentsRoot(), entry.name, '.cwd');
      if (!exists(file)) continue;
      const stat = lstatSync(file);
      if (!stat.isFile()) throw Error('unsafe .cwd');
      const cwd = readFileSync(file, 'utf8').trim();
      uses = !!cwd && within(path, cwd);
    } catch (error) { refuse(`permanent agent ${entry.name} has unreadable state, so its use of this folder is unknown (${String(error)})`); }
    if (uses) refuse(`permanent agent ${entry.name} works in this folder`);
  }

  if (!deps.permanentCwds) refuse('the Fleet configuration cannot be read to check permanent agents');
  for (const cwd of deps.permanentCwds) {
    let uses;
    try { uses = !!cwd && within(path, cwd); }
    catch (error) { refuse(`a permanent agent's working directory ${cwd} cannot be resolved (${String(error)})`); }
    if (uses) refuse(`a permanent agent is configured to work in this folder (${cwd})`);
  }
}

/** A layout task's rooms and agents must have finished closing. */
function assertLayoutClosed(task: TaskRecord): void {
  if (!task.layout) return;
  const runId = task.layout.run_id;
  if (!validLayoutKey(runId)) refuse('the mission layout run is invalid');
  let state;
  try { state = JSON.parse(readFileSync(join(stateRoot(), 'layouts', `${runId}.json`), 'utf8')); }
  catch (error) {
    // A Done layout task started its run; missing state cannot prove its agents were retired.
    refuse(`the mission layout state cannot be read, so its rooms and agents cannot be proven closed (${String(error)})`);
  }
  if (!state?.closed || state.closing || state.uncertain)
    refuse('the mission rooms and agents are still being closed; retry after the close finishes');
  for (const [key, participant] of Object.entries<{ owned?: boolean; instance?: unknown; retired?: boolean }>(state.participants ?? {}))
    if (participant.owned && participant.instance && !participant.retired)
      refuse(`mission agent ${key} has not been retired`);
}

export function assertTaskWorkspaceRemovable(task: TaskRecord, deps: WorkspaceRemovalDeps): void {
  if (task.deletion) refuse('the task is being deleted');
  if (task.state !== 'done') refuse(`only a Done task's working files can be removed; this task is ${task.state}`);
  if (task.terminal_intent && task.terminal_intent.status !== 'settled')
    refuse('completion of the task is still being settled');
  if (!task.workspace) refuse('this task has no Fleet-owned working folder');
  try { validateWorkspace(task.workspace, 'task', task.task_id); }
  catch (error) { refuse(`the recorded folder is not this task's Fleet-owned folder (${(error as Error).message})`); }
  assertNoRoomRecord(task);
  assertLayoutClosed(task);
  assertNoAgentUsesFolder(task, task.workspace.path, deps);
  for (const artifact of task.outcome?.artifacts ?? [])
    if (within(task.workspace.path, resolve(task.workspace.path, artifact)))
      refuse(`the task outcome lists ${artifact}, which is inside the folder`);
}

/** Retained text that names the folder: shown to the Owner, never used as a link target. */
function folderMentions(task: TaskRecord): string[] {
  const path = task.workspace?.path;
  if (!path) return [];
  const fields: Array<[string, string | undefined]> = [
    ['description', task.brief], ['outcome', task.outcome?.summary], ['to_review', task.review?.markdown],
    ...(task.progress ?? []).map((entry): [string, string] => [`progress:${entry.id}`, entry.text]),
  ];
  return fields.filter(([, text]) => text?.includes(path)).map(([name]) => name);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function removeTaskWorkspace(
  taskId: string, actor: TaskDeletionActor, deps: WorkspaceRemovalDeps = {},
): Promise<WorkspaceRemovalOutcome> {
  return withFileLock(taskOperationLockPath(taskId), () => {
    const task = getTask(taskId);
    const previous = task.workspace_removal;
    if (previous?.completed_at && task.workspace && !task.deletion) {
      validateWorkspace(task.workspace, 'task', taskId);
      if (!workspaceEntriesPresent(task.workspace))
        return { task, result: 'already_removed' as const, mentions: folderMentions(task) };
    }
    assertTaskWorkspaceRemovable(task, deps);
    if (process.platform !== 'linux' && !deps.processesUsing)
      refuse('this platform cannot verify that no process is using the folder');
    const workspace = task.workspace!;
    // Only a first attempt that finds nothing on disk is "already missing";
    // a retry after a partial removal is a completed removal.
    const missing = !previous && !workspaceEntriesPresent(workspace);
    const now = () => new Date().toISOString();
    // Mark the intent first: a launch fenced after this point refuses the folder,
    // and one fenced before it is visible to the scan below.
    updateTaskWorkspaceRemoval(taskId, current => {
      const { error: _error, error_at: _errorAt, completed_at: _completed, ...rest } = current ?? { started_at: now(), actor };
      return rest;
    });
    try { withSynchronousFileLock(taskFolderUseLockPath(taskId), () => assertNoAgentUsesFolder(task, workspace.path, deps)); }
    catch (error) {
      updateTaskWorkspaceRemoval(taskId, () => previous);
      throw error;
    }
    try {
      deleteWorkspace(workspace, 'task', taskId, {
        // A process that entered the folder before the rename keeps it as its cwd or open file;
        // after the rename no new one can find it. Restore the folder rather than pull it away.
        beforeRemove: (tomb, restore) => {
          let use: ProcessUse;
          try { use = (deps.processesUsing ?? processesUsing)(tomb, { original: workspace.path, createdAt: Date.parse(task.created_at) }); }
          catch (error) {
            throw new InUse(`processes using the folder cannot be checked (${errorText(error)})`, restore);
          }
          if (use.users.length) throw new InUse(`process ${use.users.join(', ')} is using the folder; stop it and retry`, restore);
          // Use that can be neither proven nor excluded is refused, never assumed absent.
          if (use.unverified.length)
            throw new InUse(`${use.unverified.length} process(es) of this user cannot be checked for use of the folder: `
              + use.unverified.map(entry => entry.description).join('; '), restore);
        },
      });
    }
    catch (error) {
      if (error instanceof InUse) {
        let message = `cannot remove working files: ${error.message}`;
        if (error.restore) {
          // A freshly renamed, intact folder goes back: a refusal, not a failed removal.
          error.restore();
          updateTaskWorkspaceRemoval(taskId, () => previous);
        } else {
          // A partial tombstone keeps its token provenance so a later retry can resume it.
          updateTaskWorkspaceRemoval(taskId, current => ({ ...current!, error: error.message, error_at: now() }));
          message += '; the partly removed folder is kept for retry';
        }
        throw new TaskStateError(message);
      }
      const message = errorText(error);
      updateTaskWorkspaceRemoval(taskId, current => ({ ...current!, error: message, error_at: now() }));
      refuse(`${message}. Nothing outside the folder was touched; fix the cause and retry`);
    }
    const removed = updateTaskWorkspaceRemoval(taskId, current => ({
      ...current!, completed_at: now(), ...(missing ? { already_missing: true as const } : {}),
    }));
    return { task: removed, result: missing ? 'already_missing' as const : 'removed' as const, mentions: folderMentions(removed) };
  }, {}, TASK_OPERATION_LOCK_STALE_MS);
}

export interface WorkingFilesSummary {
  /** `removing`: removal began and is not confirmed — still running or interrupted; retry resumes it. */
  state: 'none' | 'present' | 'removing' | 'failed' | 'removed';
  started_at?: string;
  removed_at?: string;
  error?: string;
}

/** Record-only readback for task payloads; never touches the filesystem. */
export function workingFilesSummary(task: TaskRecord): WorkingFilesSummary {
  const removal = task.workspace_removal;
  if (!task.workspace) return { state: 'none' };
  if (!removal) return { state: 'present' };
  if (removal.completed_at) return { state: 'removed', started_at: removal.started_at, removed_at: removal.completed_at };
  if (removal.error) return { state: 'failed', started_at: removal.started_at, error: removal.error };
  return { state: 'removing', started_at: removal.started_at };
}

/** Serializes agent state creation in a task folder with the removal's in-use scan. */
function taskFolderUseLockPath(taskId: string): string {
  return join(stateRoot(), 'locks', 'task-folder-use', encodeURIComponent(taskId));
}

/** Task IDs whose folder `cwd` names, literally or through symlinks. */
function taskFoldersOf(cwd: string): string[] {
  const base = join(stateRoot(), 'workspaces', 'tasks');
  const ids = new Set<string>();
  for (const path of [resolve(cwd), canonical(cwd)]) {
    const rel = relative(base, path);
    if (rel && contains(base, path)) ids.add(rel.split(sep)[0]);
  }
  return [...ids].filter(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id)).sort();
}

export function assertCwdNotInRemovedTaskFolder(cwd: string | undefined): void {
  if (!cwd) return;
  for (const taskId of taskFoldersOf(cwd)) {
    let task: TaskRecord;
    try { task = getTask(taskId); } catch { continue; }
    if (task.workspace_removal)
      throw new TaskStateError(`the working files of task ${taskId} were removed; choose another working directory`);
  }
}

/**
 * Launch fence: an agent never starts in, and so never recreates, the folder
 * of a task whose working files were removed. Creating its state under the
 * folder's use lock makes it visible to a concurrent removal's scan.
 */
export function withTaskFolderUseFence<T>(cwd: string | undefined, work: () => T): T {
  const ids = cwd ? taskFoldersOf(cwd) : [];
  const fenced = (index: number): T => {
    if (index === ids.length) { assertCwdNotInRemovedTaskFolder(cwd); return work(); }
    return withSynchronousFileLock(taskFolderUseLockPath(ids[index]), () => fenced(index + 1));
  };
  return fenced(0);
}
