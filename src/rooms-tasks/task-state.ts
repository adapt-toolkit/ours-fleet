import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  TaskRecord, TaskState, TaskBlocked, TaskOrigin, TaskTemplateRef,
  TaskOutcome, TaskMemberRole, TaskTerminalIntent,
  TaskDeletionActor, TaskDeletionMemberPhase,
} from './types.js';
import { TASK_TERMINAL_STATES, TASK_CANCELLABLE_STATES } from './types.js';
import { DEFAULT_TASK_LIST_ID, readTaskLists } from './task-lists.js';

export const tasksDir = () => join(stateRoot(), 'tasks');

function taskPath(id: string): string { return join(tasksDir(), `${id}.json`); }
function taskLockPath(id: string): string { return join(tasksDir(), '.locks', id); }
const localTaskLocks = new Set<string>();

function withTaskLock<T>(id: string, fn: () => T): T {
  if (localTaskLocks.has(id)) return fn();
  const path = taskLockPath(id); const ownerPath = join(path, 'owner.json');
  const token = randomUUID(); mkdirSync(join(tasksDir(), '.locks'), { recursive: true });
  for (;;) {
    const claimPath = `${path}.claim.${process.pid}.${randomUUID()}`;
    try {
      mkdirSync(claimPath);
      writeFileSync(join(claimPath, 'owner.json'), JSON.stringify({ token, pid: process.pid }));
      renameSync(claimPath, path); break;
    } catch (error) {
      rmSync(claimPath, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      let alive = false;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number };
        if (typeof owner.pid === 'number') {
          try { process.kill(owner.pid, 0); alive = true; } catch { /* dead */ }
        }
      } catch { /* corrupt legacy lock */ }
      if (!alive) { rmSync(path, { recursive: true, force: true }); continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  localTaskLocks.add(id);
  try { return fn(); }
  finally {
    localTaskLocks.delete(id);
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
      if (owner.token === token) rmSync(path, { recursive: true, force: true });
    } catch { /* ownership cannot be proved */ }
  }
}

function generateTaskId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${ts}${rand}`;
}

const TASK_ID_PATTERN = /^[0-9a-z]{9}[0-9a-f]{8}$/;

export class TaskStateError extends Error {}
type StoredTaskRecord = Omit<TaskRecord, 'list_id' | 'list_name'> & { list_id?: string };

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
  return presentTask(JSON.parse(readFileSync(p, 'utf8')) as StoredTaskRecord);
}

function writeTask(record: TaskRecord | StoredTaskRecord): void {
  mkdirSync(tasksDir(), { recursive: true });
  const persisted = { ...record } as Record<string, unknown>;
  delete persisted.list_name;
  replaceFileAtomically(taskPath(record.task_id), JSON.stringify(persisted, null, 2) + '\n');
}

function presentTask(record: StoredTaskRecord): TaskRecord {
  const listId = record.list_id ?? DEFAULT_TASK_LIST_ID;
  const list = readTaskLists().find(item => item.list_id === listId);
  if (!list) throw new TaskStateError(`task ${record.task_id} references missing list ${listId}`);
  return { ...record, list_id: listId, list_name: list.name };
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

/**
 * Accepted deletion is the per-task epoch guard: once pending, every lifecycle
 * mutation, terminal settlement, and room publication must fail boundedly.
 */
export function assertNoPendingDeletion(task: TaskRecord): void {
  if (task.deletion?.status === 'pending') {
    throw new TaskStateError(
      `task ${task.task_id} is pending deletion; run 'ours-fleet task delete ${task.task_id} ${task.task_id}' to retry cleanup`,
    );
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  brief?: string;
  brief_file?: string;
  template?: TaskTemplateRef;
  execution_plan?: TaskRecord['execution_plan'];
  origin: TaskOrigin;
  idempotency_key?: string;
  start?: boolean;
  no_room?: boolean;
  room_id?: string;
  listId?: string;
}

export function createTask(input: CreateTaskInput): TaskRecord {
  const key = input.idempotency_key ?? randomUUID();
  const existing = findByIdempotencyKey(key);
  if (existing) {
    const existingPlan = existing.execution_plan?.plan_hash;
    const requestedPlan = input.execution_plan?.plan_hash;
    if (existingPlan !== requestedPlan)
      throw new TaskStateError(`idempotency key '${key}' was already used with a different execution plan`);
    return existing;
  }

  const state: TaskState = input.start === false ? 'backlog' : 'provisioning';
  const record: StoredTaskRecord = {
    task_id: generateTaskId(),
    list_id: input.listId ?? DEFAULT_TASK_LIST_ID,
    title: input.title,
    brief: input.brief,
    brief_file: input.brief_file,
    state,
    template: input.template,
    execution_plan: input.execution_plan,
    no_room: input.no_room || undefined,
    room_id: input.room_id,
    member_roles: [],
    origin: input.origin,
    idempotency_key: key,
    created_at: new Date().toISOString(),
    started_at: state === 'provisioning' ? new Date().toISOString() : undefined,
  };
  writeTask(record);
  return readTask(record.task_id);
}

export function getTask(id: string): TaskRecord { return withTaskLock(id, () => readTask(id)); }

export function updateTaskExecutionPlan(
  id: string, executionPlan: NonNullable<TaskRecord['execution_plan']>,
): TaskRecord {
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    if (task.execution_plan && task.execution_plan.plan_hash !== executionPlan.plan_hash)
      throw new TaskStateError(`task ${id} execution plan mismatch`);
    task.execution_plan = executionPlan;
    task.template = { name: executionPlan.snapshot.name, version: executionPlan.snapshot.version,
      content_hash: executionPlan.snapshot.content_hash };
    writeTask(task);
    return readTask(id);
  });
}

export function listTasks(filter?: {
  state?: TaskState | TaskState[]; listId?: string; includeDeleting?: boolean;
}): TaskRecord[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];
  const states = filter?.state
    ? (Array.isArray(filter.state) ? filter.state : [filter.state])
    : undefined;
  const tasks: TaskRecord[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const id = f.slice(0, -5);
      const t = withTaskLock(id, () => presentTask(JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredTaskRecord));
      if (t.deletion?.status === 'pending' && !filter?.includeDeleting) continue;
      if ((!states || states.includes(t.state)) && (!filter?.listId || t.list_id === filter.listId)) tasks.push(t);
    } catch { /* corrupt file, skip */ }
  }
  const order = new Map(readTaskLists().map((item, index) => [item.list_id, index]));
  return tasks.sort((a, b) => (order.get(a.list_id!)! - order.get(b.list_id!)!)
    || a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));
}

export function moveTaskToList(id: string, listId: string): TaskRecord {
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    task.list_id = listId; writeTask(task); return readTask(id);
  });
}

export function findByIdempotencyKey(key: string): TaskRecord | undefined {
  return listTasks().find(t => t.idempotency_key === key);
}

export function startTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'provisioning');
  t.state = 'provisioning';
  t.started_at = new Date().toISOString();
  writeTask(t);
  return t;
  });
}

export function activateTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'active');
  t.state = 'active';
  delete t.blocked;
  writeTask(t);
  return t;
  });
}

export function blockTask(id: string, reason: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  if (TASK_TERMINAL_STATES.includes(t.state))
    throw new TaskStateError(`cannot block a '${t.state}' task`);
  t.blocked = { reason, at: new Date().toISOString() };
  writeTask(t);
  return t;
  });
}

export function unblockTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  if (!t.blocked) throw new TaskStateError('task is not blocked');
  delete t.blocked;
  writeTask(t);
  return t;
  });
}

export function reviewTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'review');
  t.state = 'review';
  delete t.blocked;
  writeTask(t);
  return t;
  });
}

export function completeTask(id: string, outcome?: TaskOutcome): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'done');
  t.state = 'done';
  t.ended_at = new Date().toISOString();
  delete t.blocked;
  if (outcome) t.outcome = outcome;
  writeTask(t);
  return t;
  });
}

export function cancelTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  if (!TASK_CANCELLABLE_STATES.includes(t.state))
    throw new TaskStateError(`cannot cancel a '${t.state}' task`);
  t.state = 'cancelled';
  t.ended_at = new Date().toISOString();
  delete t.blocked;
  writeTask(t);
  return t;
  });
}

function sameOutcome(left: TaskOutcome | undefined, right: TaskOutcome | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Persist the first terminal request. Callers serialize this with the task-operation lock. */
export function beginTaskTerminalIntent(
  id: string,
  input: { kind: TaskTerminalIntent['kind']; roomId?: string; outcome?: TaskOutcome },
): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
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
  });
}

/** Record an actionable failure without claiming the requested terminal state. */
export function setTaskTerminalIntentError(
  id: string, error: string, recoveryHint: string,
): TaskRecord {
  return withTaskLock(id, () => {
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
  });
}

/** Atomically publish the task terminal state and settled audit cursor. */
export function finishTaskTerminalIntent(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
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
  });
}

export function failTask(id: string, error: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'failed');
  t.state = 'failed';
  t.ended_at = new Date().toISOString();
  t.outcome = { summary: error };
  delete t.blocked;
  writeTask(t);
  return t;
  });
}

export function updateTaskRoom(
  id: string,
  roomId: string,
  roomIdentityCid: string,
): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  t.room_id = roomId;
  t.room_identity_cid = roomIdentityCid;
  writeTask(t);
  return t;
  });
}

export function updateTaskTemplate(id: string, template: TaskTemplateRef): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  t.template = template;
  writeTask(t);
  return t;
  });
}

export function updateTaskMembers(id: string, members: TaskMemberRole[]): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingDeletion(t);
  assertNoPendingTerminalIntent(t);
  t.member_roles = members;
  writeTask(t);
  return t;
  });
}

function presentTaskLenient(record: StoredTaskRecord): TaskRecord {
  try { return presentTask(record); }
  catch {
    // A broken list reference must never make a task undeletable.
    const listId = record.list_id ?? DEFAULT_TASK_LIST_ID;
    return { ...record, list_id: listId, list_name: listId === DEFAULT_TASK_LIST_ID ? 'default' : listId };
  }
}

export type TaskDeletionAcceptance =
  | { status: 'accepted' | 'pending'; task: TaskRecord }
  | { status: 'already_absent' };

/**
 * Persist the first-wins durable deletion intent. Accepts every lifecycle
 * state, takes precedence over a pending terminal intent, and never touches
 * remote resources. Repeat requests while pending re-arm settlement; a request
 * for a missing record reports the idempotent already-absent outcome.
 *
 * Low-level record mutation only. Callers serialize acceptance with settlement
 * through deletion.ts, which holds the common task-operation lock.
 */
export function beginTaskDeletionIntent(id: string, actor: TaskDeletionActor): TaskDeletionAcceptance {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  let stored: StoredTaskRecord;
  try {
    stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  } catch (error) {
    if (isNotFoundError(error)) return { status: 'already_absent' };
    throw error;
  }
  if (stored.deletion?.status === 'pending')
    return { status: 'pending', task: presentTaskLenient(stored) };
  const now = new Date().toISOString();
  stored.deletion = {
    status: 'pending',
    accepted_at: now,
    actor,
    room_id: stored.room_id,
    members: (stored.member_roles ?? []).map(member => ({
      name: member.name, identity_cid: member.identity_cid, phase: 'pending', updated_at: now,
    })),
  };
  writeTask(stored);
  return { status: 'accepted', task: presentTaskLenient(stored) };
  });
}

/** Record an actionable settlement failure; the task stays hidden and recoverable. */
export function setTaskDeletionError(id: string, error: string, recoveryHint: string): TaskRecord {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  if (stored.deletion?.status !== 'pending')
    throw new TaskStateError(`task ${id} has no pending deletion`);
  stored.deletion.first_failure ??= error;
  stored.deletion.first_recovery_hint ??= recoveryHint;
  stored.deletion.error = error;
  const previousErrorAt = Date.parse(stored.deletion.error_at ?? '');
  stored.deletion.error_at = new Date(Math.max(
    Date.now(), Number.isFinite(previousErrorAt) ? previousErrorAt + 1 : 0,
  )).toISOString();
  stored.deletion.recovery_hint = recoveryHint;
  writeTask(stored);
  return presentTaskLenient(stored);
  });
}

const DELETION_MEMBER_PHASE_ORDER: Record<TaskDeletionMemberPhase, number> = {
  pending: 0, stop_requested: 1, liveness_absent: 2, archive_secured: 3, identity_absent: 4,
};

/** Marker proving a member never launched, mirroring close.ts's short path. */
export const DELETION_MEMBER_NEVER_LAUNCHED = 'never-launched';

/**
 * Advance a member retirement cursor carried by the deletion intent. Only
 * adjacent forward transitions are legal — plus the explicit
 * pending → identity_absent short path proved by the 'never-launched' marker —
 * so no managed agent can be claimed retired without the full evidence chain.
 * launch_id and archive_path are immutable once recorded; same-phase retries
 * are idempotent but must not change evidence.
 */
export function advanceTaskDeletionMember(
  id: string, name: string, phase: TaskDeletionMemberPhase,
  launchId?: string, archivePath?: string,
): TaskRecord {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  if (stored.deletion?.status !== 'pending')
    throw new TaskStateError(`task ${id} has no pending deletion`);
  const cursor = stored.deletion.members.find(member => member.name === name);
  if (!cursor) throw new TaskStateError(`task ${id} deletion has no member cursor '${name}'`);
  if (cursor.launch_id !== undefined && launchId !== undefined && launchId !== cursor.launch_id)
    throw new TaskStateError(
      `task ${id} deletion member '${name}' launch ownership proof is immutable`,
    );
  if (cursor.archive_path !== undefined && archivePath !== undefined && archivePath !== cursor.archive_path)
    throw new TaskStateError(
      `task ${id} deletion member '${name}' archive evidence is immutable`,
    );
  const step = DELETION_MEMBER_PHASE_ORDER[phase] - DELETION_MEMBER_PHASE_ORDER[cursor.phase];
  const launch = cursor.launch_id ?? launchId;
  if (step < 0)
    throw new TaskStateError(
      `task ${id} deletion member '${name}' cannot move back from '${cursor.phase}' to '${phase}'`,
    );
  if (step === 0) return presentTaskLenient(stored); // idempotent retry, evidence already verified
  const neverLaunched = cursor.phase === 'pending' && phase === 'identity_absent'
    && launch === DELETION_MEMBER_NEVER_LAUNCHED;
  if (step !== 1 && !neverLaunched)
    throw new TaskStateError(
      `task ${id} deletion member '${name}' cannot skip from '${cursor.phase}' to '${phase}' without evidence`,
    );
  if (launch === undefined)
    throw new TaskStateError(
      `task ${id} deletion member '${name}' cannot reach '${phase}' without a launch ownership proof`,
    );
  if (phase === 'archive_secured' && (cursor.archive_path ?? archivePath) === undefined)
    throw new TaskStateError(
      `task ${id} deletion member '${name}' cannot reach 'archive_secured' without archive evidence`,
    );
  cursor.phase = phase;
  cursor.launch_id = launch;
  if (archivePath !== undefined) cursor.archive_path = archivePath;
  cursor.updated_at = new Date().toISOString();
  writeTask(stored);
  return presentTaskLenient(stored);
  });
}

/**
 * Physically remove a deletion-pending task record. Settlement-only: callers
 * must have completed member retirement and room cleanup first. Missing
 * records are the idempotent already-settled outcome.
 */
export function unlinkDeletedTask(id: string): boolean {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  let stored: StoredTaskRecord;
  try {
    stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  if (stored.deletion?.status !== 'pending')
    throw new TaskStateError(`task ${id} has no pending deletion`);
  try {
    unlinkSync(taskPath(id));
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  return true;
  });
}

/** Remove a completed task from Fleet's backlog. Missing tasks are an idempotent no-op. */
export function deleteTask(id: string): boolean {
  return withTaskLock(id, () => {
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
  });
}
