import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  TaskRecord, TaskState, TaskBlocked, TaskOrigin, TaskTemplateRef,
  TaskOutcome, TaskMemberRole, TaskTerminalIntent,
} from './types.js';
import { TASK_TERMINAL_STATES, TASK_CANCELLABLE_STATES } from './types.js';

export const tasksDir = () => join(stateRoot(), 'tasks');

function taskPath(id: string): string { return join(tasksDir(), `${id}.json`); }

function generateTaskId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${ts}${rand}`;
}

const TASK_ID_PATTERN = /^[0-9a-z]{9}[0-9a-f]{8}$/;

export class TaskStateError extends Error {}

function assertCanonicalTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new TaskStateError(
      'invalid task ID: expected the canonical 17-character lowercase ID',
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

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

function assertNoPendingTerminalIntent(task: TaskRecord): void {
  if (task.terminal_intent?.status === 'pending') {
    throw new TaskStateError(
      `task ${task.task_id} has a pending '${task.terminal_intent.kind}' terminal intent`,
    );
  }
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
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'provisioning');
  t.state = 'provisioning';
  t.started_at = new Date().toISOString();
  writeTask(t);
  return t;
}

export function activateTask(id: string): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'active');
  t.state = 'active';
  delete t.blocked;
  writeTask(t);
  return t;
}

export function blockTask(id: string, reason: string): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  if (TASK_TERMINAL_STATES.includes(t.state))
    throw new TaskStateError(`cannot block a '${t.state}' task`);
  t.blocked = { reason, at: new Date().toISOString() };
  writeTask(t);
  return t;
}

export function unblockTask(id: string): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  if (!t.blocked) throw new TaskStateError('task is not blocked');
  delete t.blocked;
  writeTask(t);
  return t;
}

export function reviewTask(id: string): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'review');
  t.state = 'review';
  delete t.blocked;
  writeTask(t);
  return t;
}

export function completeTask(id: string, outcome?: TaskOutcome): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
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
  assertNoPendingTerminalIntent(t);
  if (!TASK_CANCELLABLE_STATES.includes(t.state))
    throw new TaskStateError(`cannot cancel a '${t.state}' task`);
  t.state = 'cancelled';
  t.ended_at = new Date().toISOString();
  delete t.blocked;
  writeTask(t);
  return t;
}

function sameOutcome(left: TaskOutcome | undefined, right: TaskOutcome | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Persist the first terminal request. Callers serialize this with the task-operation lock. */
export function beginTaskTerminalIntent(
  id: string,
  input: { kind: TaskTerminalIntent['kind']; roomId?: string; outcome?: TaskOutcome },
): TaskRecord {
  const t = readTask(id);
  const existing = t.terminal_intent;
  if (existing) {
    if (existing.kind !== input.kind || existing.room_id !== input.roomId
      || !sameOutcome(existing.outcome, input.outcome)) {
      throw new TaskStateError(
        `task ${id} already has a conflicting '${existing.kind}' terminal intent`,
      );
    }
    return t;
  }
  if (TASK_TERMINAL_STATES.includes(t.state)) {
    throw new TaskStateError(`task ${id} is already in terminal state '${t.state}'`);
  }
  if (input.kind === 'done' && t.state !== 'review') {
    throw new TaskStateError(`cannot transition from '${t.state}' to 'done'`);
  }
  if (input.kind === 'cancelled' && !TASK_CANCELLABLE_STATES.includes(t.state)) {
    throw new TaskStateError(`cannot cancel a '${t.state}' task`);
  }
  if (input.roomId !== undefined && t.room_id !== input.roomId) {
    throw new TaskStateError(`task ${id} is not tied to room ${input.roomId}`);
  }
  t.terminal_intent = {
    kind: input.kind,
    status: 'pending',
    room_id: input.roomId,
    outcome: input.outcome,
    accepted_at: new Date().toISOString(),
  };
  writeTask(t);
  return t;
}

/** Record an actionable failure without claiming the requested terminal state. */
export function setTaskTerminalIntentError(
  id: string, error: string, recoveryHint: string,
): TaskRecord {
  const t = readTask(id);
  if (!t.terminal_intent) throw new TaskStateError(`task ${id} has no terminal intent`);
  if (t.terminal_intent.status === 'settled') return t;
  t.terminal_intent.first_failure ??= error;
  t.terminal_intent.first_recovery_hint ??= recoveryHint;
  t.terminal_intent.error = error;
  const previousErrorAt = Date.parse(t.terminal_intent.error_at ?? '');
  t.terminal_intent.error_at = new Date(Math.max(
    Date.now(), Number.isFinite(previousErrorAt) ? previousErrorAt + 1 : 0,
  )).toISOString();
  t.terminal_intent.recovery_hint = recoveryHint;
  writeTask(t);
  return t;
}

/** Atomically publish the task terminal state and settled audit cursor. */
export function finishTaskTerminalIntent(id: string): TaskRecord {
  const t = readTask(id);
  const intent = t.terminal_intent;
  if (!intent) throw new TaskStateError(`task ${id} has no terminal intent`);
  if (intent.status === 'settled') return t;
  if (TASK_TERMINAL_STATES.includes(t.state)) {
    throw new TaskStateError(`task ${id} reached terminal state '${t.state}' outside its intent`);
  }
  if (intent.kind === 'done') assertTransition(t.state, 'done');
  else if (!TASK_CANCELLABLE_STATES.includes(t.state)) {
    throw new TaskStateError(`cannot cancel a '${t.state}' task`);
  }
  t.state = intent.kind;
  t.ended_at = new Date().toISOString();
  delete t.blocked;
  if (intent.outcome) t.outcome = intent.outcome;
  intent.status = 'settled';
  intent.settled_at = t.ended_at;
  delete intent.error;
  delete intent.error_at;
  delete intent.recovery_hint;
  writeTask(t);
  return t;
}

export function failTask(id: string, error: string): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
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
  assertNoPendingTerminalIntent(t);
  t.room_id = roomId;
  t.room_identity_cid = roomIdentityCid;
  writeTask(t);
  return t;
}

export function updateTaskTemplate(id: string, template: TaskTemplateRef): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  t.template = template;
  writeTask(t);
  return t;
}

export function updateTaskMembers(id: string, members: TaskMemberRole[]): TaskRecord {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  t.member_roles = members;
  writeTask(t);
  return t;
}

/** Remove a completed task from Fleet's backlog. Missing tasks are an idempotent no-op. */
export function deleteTask(id: string): boolean {
  assertCanonicalTaskId(id);
  const p = taskPath(id);
  let task: TaskRecord;
  try {
    task = JSON.parse(readFileSync(p, 'utf8')) as TaskRecord;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  if (task.state !== 'done') {
    throw new TaskStateError(
      `cannot delete a '${task.state}' task; only 'done' tasks can be deleted`,
    );
  }
  try {
    unlinkSync(p);
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  return true;
}
