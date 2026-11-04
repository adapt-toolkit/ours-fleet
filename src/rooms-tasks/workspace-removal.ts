import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';

import { withFileLock } from '../atomic-file.js';
import { stateRoot, tmpRoot } from '../paths.js';
import { listMembers } from '../supervisor/catalog.js';
import { readTempSupervisor } from '../temp-lifecycle.js';
import { validLayoutKey } from './layout-config.js';
import { listRoomRecords } from './room-state.js';
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
}

function refuse(reason: string): never {
  throw new TaskStateError(`cannot remove working files: ${reason}`);
}

/** True when `path` is `root` itself or inside it. */
function within(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let role, owner;
    try { role = readRole(dir); owner = readTempSupervisor(dir)?.taskOwner; }
    catch (error) { refuse(`agent ${entry.name} has unreadable state, so its use of this folder is unknown (${String(error)})`); }
    const startup = role.roomMemberStartup;
    if (owner?.taskId === task.task_id || startup?.task_id === task.task_id)
      refuse(`agent ${entry.name} of this mission has not been retired`);
    if ((typeof role.cwd === 'string' && within(path, role.cwd))
        || (typeof startup?.workspace?.path === 'string' && within(path, startup.workspace.path)))
      refuse(`agent ${entry.name} works in this folder`);
  }

  if (!deps.permanentCwds) refuse('the Fleet configuration cannot be read to check permanent agents');
  for (const cwd of deps.permanentCwds)
    if (cwd && within(path, cwd)) refuse(`a permanent agent is configured to work in this folder (${cwd})`);
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
  for (const room of listRoomRecords())
    if (room.task_id === task.task_id || room.workspace?.path === task.workspace.path)
      refuse(`room ${room.room_id} of this task is still open; close it first`);
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
    const workspace = task.workspace!;
    // Only a first attempt that finds nothing on disk is "already missing";
    // a retry after a partial removal is a completed removal.
    const missing = !previous && !workspaceEntriesPresent(workspace);
    const now = () => new Date().toISOString();
    updateTaskWorkspaceRemoval(taskId, current => {
      const { error: _error, error_at: _errorAt, completed_at: _completed, ...rest } = current ?? { started_at: now(), actor };
      return rest;
    });
    try { deleteWorkspace(workspace, 'task', taskId); }
    catch (error) {
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
