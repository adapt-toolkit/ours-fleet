import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  TaskRecord, TaskState, TaskBlocked, TaskOrigin, TaskTemplateRef,
  TaskOutcome, TaskMemberRole,
} from './types.js';
import { TASK_TERMINAL_STATES, TASK_CANCELLABLE_STATES } from './types.js';

export const tasksDir = () => join(stateRoot(), 'tasks');

function taskPath(id: string): string { return join(tasksDir(), `${id}.json`); }

function generateTaskId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${ts}${rand}`;
}

export class TaskStateError extends Error {}

function readTask(id: string): TaskRecord {
  const p = taskPath(id);
  if (!existsSync(p)) throw new TaskStateError(`task not found: ${id}`);
  return JSON.parse(readFileSync(p, 'utf8')) as TaskRecord;
}

function writeTask(record: TaskRecord): void {
  mkdirSync(tasksDir(), { recursive: true });
  replaceFileAtomically(taskPath(record.task_id), JSON.stringify(record, null, 2) + '\n');
}

// ── Lifecycle transitions ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  backlog: ['provisioning', 'cancelled'],
  provisioning: ['active', 'failed', 'cancelled'],
  active: ['review', 'failed', 'cancelled'],
  review: ['done', 'failed', 'cancelled'],
  done: [],
  cancelled: [],
  failed: [],
};

function assertTransition(from: TaskState, to: TaskState): void {
  if (!VALID_TRANSITIONS[from].includes(to))
    throw new TaskStateError(`cannot transition from '${from}' to '${to}'`);
}

// ── CRUD ────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  brief?: string;
  brief_file?: string;
  template?: TaskTemplateRef;
  origin: TaskOrigin;
  idempotency_key?: string;
  start?: boolean;
  no_room?: boolean;
  room_id?: string;
}

export function createTask(input: CreateTaskInput): TaskRecord {
  const key = input.idempotency_key ?? randomUUID();
  const existing = findByIdempotencyKey(key);
  if (existing) return existing;

  const state: TaskState = input.start === false ? 'backlog' : 'provisioning';
  const record: TaskRecord = {
    task_id: generateTaskId(),
    title: input.title,
    brief: input.brief,
    brief_file: input.brief_file,
    state,
    template: input.template,
    no_room: input.no_room || undefined,
    room_id: input.room_id,
    member_roles: [],
    origin: input.origin,
    idempotency_key: key,
    created_at: new Date().toISOString(),
    started_at: state === 'provisioning' ? new Date().toISOString() : undefined,
  };
  writeTask(record);
  return record;
}

export function getTask(id: string): TaskRecord { return readTask(id); }

export function listTasks(filter?: { state?: TaskState | TaskState[] }): TaskRecord[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];
  const states = filter?.state
    ? (Array.isArray(filter.state) ? filter.state : [filter.state])
    : undefined;
  const tasks: TaskRecord[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as TaskRecord;
      if (!states || states.includes(t.state)) tasks.push(t);
    } catch { /* corrupt file, skip */ }
  }
  return tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function findByIdempotencyKey(key: string): TaskRecord | undefined {
  return listTasks().find(t => t.idempotency_key === key);
}

export function startTask(id: string): TaskRecord {
  const t = readTask(id);
  assertTransition(t.state, 'provisioning');
  t.state = 'provisioning';
  t.started_at = new Date().toISOString();
  writeTask(t);
  return t;
}

export function activateTask(id: string): TaskRecord {
  const t = readTask(id);
  assertTransition(t.state, 'active');
  t.state = 'active';
  delete t.blocked;
  writeTask(t);
  return t;
}

export function blockTask(id: string, reason: string): TaskRecord {
  const t = readTask(id);
  if (TASK_TERMINAL_STATES.includes(t.state))
    throw new TaskStateError(`cannot block a '${t.state}' task`);
  t.blocked = { reason, at: new Date().toISOString() };
  writeTask(t);
  return t;
}

export function unblockTask(id: string): TaskRecord {
  const t = readTask(id);
  if (!t.blocked) throw new TaskStateError('task is not blocked');
  delete t.blocked;
  writeTask(t);
  return t;
}

export function reviewTask(id: string): TaskRecord {
  const t = readTask(id);
  assertTransition(t.state, 'review');
  t.state = 'review';
  delete t.blocked;
  writeTask(t);
  return t;
}

export function completeTask(id: string, outcome?: TaskOutcome): TaskRecord {
  const t = readTask(id);
  assertTransition(t.state, 'done');
  t.state = 'done';
  t.ended_at = new Date().toISOString();
  delete t.blocked;
  if (outcome) t.outcome = outcome;
  writeTask(t);
  return t;
}

export function cancelTask(id: string): TaskRecord {
  const t = readTask(id);
  if (!TASK_CANCELLABLE_STATES.includes(t.state))
    throw new TaskStateError(`cannot cancel a '${t.state}' task`);
  t.state = 'cancelled';
  t.ended_at = new Date().toISOString();
  delete t.blocked;
  writeTask(t);
  return t;
}

export function failTask(id: string, error: string): TaskRecord {
  const t = readTask(id);
  assertTransition(t.state, 'failed');
  t.state = 'failed';
  t.ended_at = new Date().toISOString();
  t.outcome = { summary: error };
  delete t.blocked;
  writeTask(t);
  return t;
}

export function updateTaskRoom(
  id: string,
  roomId: string,
  roomIdentityCid: string,
): TaskRecord {
  const t = readTask(id);
  t.room_id = roomId;
  t.room_identity_cid = roomIdentityCid;
  writeTask(t);
  return t;
}

export function updateTaskMembers(id: string, members: TaskMemberRole[]): TaskRecord {
  const t = readTask(id);
  t.member_roles = members;
  writeTask(t);
  return t;
}

export function deleteTask(id: string): void {
  const p = taskPath(id);
  if (existsSync(p)) rmSync(p);
}
