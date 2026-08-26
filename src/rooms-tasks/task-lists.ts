import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type { TaskListRecord } from './types.js';

export const DEFAULT_TASK_LIST_ID = 'default';
export const TASK_LIST_NAME_MAX_CODE_POINTS = 64;
const CREATED_AT = '1970-01-01T00:00:00.000Z';

interface TaskListRegistry { version: 1; lists: TaskListRecord[] }

export class TaskListError extends Error {
  constructor(
    readonly code: 'invalid_name' | 'duplicate_name' | 'reserved_name' | 'list_not_found'
      | 'default_immutable' | 'destination_required' | 'same_destination',
    message: string,
  ) { super(message); this.name = 'TaskListError'; }
}

export const taskListsPath = () => join(stateRoot(), 'task-lists.json');
export const taskListsLockPath = () => join(stateRoot(), 'task-lists.lock');
export const withTaskListsLock = <T>(fn: () => T | Promise<T>): Promise<T> =>
  withFileLock(taskListsLockPath(), fn);

const defaultList = (): TaskListRecord => ({
  list_id: DEFAULT_TASK_LIST_ID, name: 'default', built_in: true, created_at: CREATED_AT,
});

const compareNames = (a: TaskListRecord, b: TaskListRecord): number => {
  if (a.list_id === DEFAULT_TASK_LIST_ID) return b.list_id === DEFAULT_TASK_LIST_ID ? 0 : -1;
  if (b.list_id === DEFAULT_TASK_LIST_ID) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.list_id.localeCompare(b.list_id);
};

export function normalizeTaskListName(input: string): string {
  if (typeof input !== 'string') throw new TaskListError('invalid_name', 'list name must be a string');
  const normalized = input.normalize('NFC');
  if (normalized.trim() !== normalized || normalized.length === 0)
    throw new TaskListError('invalid_name', 'list name must be non-empty with no leading or trailing whitespace');
  if ([...normalized].length > TASK_LIST_NAME_MAX_CODE_POINTS)
    throw new TaskListError('invalid_name', `list name must be at most ${TASK_LIST_NAME_MAX_CODE_POINTS} Unicode code points`);
  if (/[\p{Cc}\p{Cf}\/\\]/u.test(normalized))
    throw new TaskListError('invalid_name', 'list name contains a forbidden control, format, or path character');
  return normalized;
}

export function readTaskLists(): TaskListRecord[] {
  const path = taskListsPath();
  if (!existsSync(path)) return [defaultList()];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as TaskListRegistry;
  if (parsed.version !== 1 || !Array.isArray(parsed.lists)) throw new Error('invalid task list registry');
  const custom = parsed.lists.filter(item => item.list_id !== DEFAULT_TASK_LIST_ID);
  return [defaultList(), ...custom].sort(compareNames);
}

function writeTaskLists(lists: TaskListRecord[]): void {
  const custom = lists.filter(item => item.list_id !== DEFAULT_TASK_LIST_ID).sort(compareNames);
  replaceFileAtomically(taskListsPath(), JSON.stringify({ version: 1, lists: custom }, null, 2) + '\n');
}

export function resolveTaskList(name: string, lists = readTaskLists()): TaskListRecord {
  const normalized = normalizeTaskListName(name);
  const found = lists.find(item => item.name === normalized);
  if (!found) throw new TaskListError('list_not_found', `task list not found: ${normalized}`);
  return found;
}

/** Caller must hold withTaskListsLock. */
export function createTaskListLocked(name: string): TaskListRecord {
  const normalized = normalizeTaskListName(name);
  if (normalized === 'default') throw new TaskListError('reserved_name', "'default' is a reserved built-in list");
  const lists = readTaskLists();
  if (lists.some(item => item.name === normalized))
    throw new TaskListError('duplicate_name', `task list already exists: ${normalized}`);
  const record: TaskListRecord = {
    list_id: `list_${randomUUID().replace(/-/g, '')}`, name: normalized,
    built_in: false, created_at: new Date().toISOString(),
  };
  writeTaskLists([...lists, record]);
  return record;
}

/** Caller must hold withTaskListsLock. */
export function renameTaskListLocked(currentName: string, nextName: string): TaskListRecord {
  const lists = readTaskLists();
  const current = resolveTaskList(currentName, lists);
  if (current.built_in) throw new TaskListError('default_immutable', "the 'default' list cannot be renamed");
  const normalized = normalizeTaskListName(nextName);
  if (normalized === 'default') throw new TaskListError('reserved_name', "'default' is a reserved built-in list");
  if (lists.some(item => item.list_id !== current.list_id && item.name === normalized))
    throw new TaskListError('duplicate_name', `task list already exists: ${normalized}`);
  const renamed = { ...current, name: normalized };
  writeTaskLists(lists.map(item => item.list_id === current.list_id ? renamed : item));
  return renamed;
}

/** Caller must hold withTaskListsLock. */
export function deleteTaskListRecordLocked(listId: string): void {
  writeTaskLists(readTaskLists().filter(item => item.list_id !== listId));
}
