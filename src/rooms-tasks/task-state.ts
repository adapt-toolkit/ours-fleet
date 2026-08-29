import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  TaskRecord, TaskState, TaskBlocked, TaskOrigin, TaskTemplateRef,
  TaskOutcome, TaskMemberRole, TaskTerminalIntent,
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
export interface TaskEffectReceipt {
  version: 1; keyHash: string; principalHash: string; requestHash: string;
  operation: 'task.start'|'task.block'|'task.unblock'|'task.review'; resourceId: string;
  beforeDigest: string; afterDigest: string; disposition: 'completed'; result: Partial<TaskRecord>;
  acknowledged?: boolean;
}
export interface TaskEffectContext extends Omit<TaskEffectReceipt, 'version'|'resourceId'|'afterDigest'|'disposition'|'result'> {
  beforePublish?(): void;
  afterPublish?(): void;
}
const RECEIPTS = Symbol('management-effect-receipts');
type ReceiptTaskRecord = TaskRecord & { [RECEIPTS]?: TaskEffectReceipt[] };
type StoredTaskRecord = Omit<TaskRecord, 'list_id' | 'list_name'> & {
  list_id?: string; _management_receipts?: TaskEffectReceipt[];
};
const MAX_EFFECT_RECEIPTS = 16;

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
  const receipts = (record as ReceiptTaskRecord)[RECEIPTS];
  if (receipts?.length) persisted._management_receipts = receipts;
  replaceFileAtomically(taskPath(record.task_id), JSON.stringify(persisted, null, 2) + '\n');
}

function presentTask(record: StoredTaskRecord): TaskRecord {
  const listId = record.list_id ?? DEFAULT_TASK_LIST_ID;
  const list = readTaskLists().find(item => item.list_id === listId);
  if (!list) throw new TaskStateError(`task ${record.task_id} references missing list ${listId}`);
  const { _management_receipts: receipts, ...visible } = record;
  const presented = { ...visible, list_id: listId, list_name: list.name } as ReceiptTaskRecord;
  if (receipts) Object.defineProperty(presented, RECEIPTS, { value: receipts, writable: true, configurable: true });
  return presented;
}

export function getTaskEffectReceipt(id: string, keyHash: string): TaskEffectReceipt | undefined {
  return withTaskLock(id, () => {
    const receipts = (readTask(id) as ReceiptTaskRecord)[RECEIPTS];
    if (!receipts) return undefined;
    if (!Array.isArray(receipts) || receipts.length > MAX_EFFECT_RECEIPTS) throw new TaskStateError('invalid task effect receipts');
    const receipt = receipts.find(item => item?.keyHash === keyHash);
    if (!receipt) return undefined;
    const hex = /^[a-f0-9]{64}$/u;
    if (receipt.version !== 1 || !hex.test(receipt.keyHash) || !hex.test(receipt.principalHash)
        || !hex.test(receipt.requestHash) || !hex.test(receipt.beforeDigest) || !hex.test(receipt.afterDigest)
        || receipt.resourceId !== id || !['task.start', 'task.block', 'task.unblock', 'task.review'].includes(receipt.operation)
        || receipt.disposition !== 'completed' || (receipt.acknowledged !== undefined && receipt.acknowledged !== true)
        || !receipt.result || typeof receipt.result !== 'object')
      throw new TaskStateError('invalid task effect receipt');
    const resultKeys = new Set(['task_id', 'title', 'state', 'room_id', 'list_id', 'list_name', 'blocked',
      'started_at', 'ended_at']);
    if (Object.keys(receipt.result).some(key => !resultKeys.has(key))
        || receipt.result.task_id !== id || typeof receipt.result.title !== 'string'
        || !VALID_TRANSITIONS[receipt.result.state as TaskState]
        || (receipt.result.blocked !== undefined && (typeof receipt.result.blocked !== 'object'
          || Object.keys(receipt.result.blocked).some(key => !['reason', 'at'].includes(key))))
        || digestTask(receipt.result) !== receipt.afterDigest)
      throw new TaskStateError('invalid task effect receipt result');
    return receipt;
  });
}

export function acknowledgeTaskEffectReceipt(id: string, keyHash: string, hooks: {
  beforePublish?(): void; afterPublish?(): void;
} = {}): void {
  withTaskLock(id, () => {
    const task = readTask(id) as ReceiptTaskRecord; const receipts = task[RECEIPTS] ?? [];
    const index = receipts.findIndex(item => item.keyHash === keyHash);
    if (index < 0 || receipts[index]!.acknowledged) return;
    hooks.beforePublish?.();
    const next = [...receipts]; next[index] = { ...next[index]!, acknowledged: true };
    Object.defineProperty(task, RECEIPTS, { value: next, writable: true, configurable: true });
    writeTask(task); hooks.afterPublish?.();
  });
}

function publishEffect(task: ReceiptTaskRecord, context: TaskEffectContext | undefined): void {
  if (!context) { writeTask(task); return; }
  const prior = (task[RECEIPTS] ?? []).filter(item => !item.acknowledged);
  if (!prior.some(item => item.keyHash === context.keyHash) && prior.length >= MAX_EFFECT_RECEIPTS)
    throw new TaskStateError('task effect receipt capacity reached');
  context.beforePublish?.();
  const visible = { ...task } as Record<string, unknown>; delete visible.list_name;
  const safeResult: Partial<TaskRecord> = { task_id: task.task_id, title: task.title, state: task.state,
    ...(task.room_id ? { room_id: task.room_id } : {}), ...(task.list_id ? { list_id: task.list_id } : {}),
    ...(task.list_name ? { list_name: task.list_name } : {}), ...(task.blocked ? { blocked: task.blocked } : {}),
    ...(task.started_at ? { started_at: task.started_at } : {}), ...(task.ended_at ? { ended_at: task.ended_at } : {}) };
  const receipt: TaskEffectReceipt = { version: 1, keyHash: context.keyHash,
    principalHash: context.principalHash, requestHash: context.requestHash,
    operation: context.operation, resourceId: task.task_id, beforeDigest: context.beforeDigest,
    afterDigest: digestTask(safeResult), disposition: 'completed', result: safeResult };
  Object.defineProperty(task, RECEIPTS, { value: [...prior.filter(item => item.keyHash !== receipt.keyHash), receipt]
    , writable: true, configurable: true });
  writeTask(task); context.afterPublish?.();
}

function digestTask(value: unknown): string {
  const canonical = (child: unknown): string => Array.isArray(child) ? `[${child.map(canonical).join(',')}]`
    : child && typeof child === 'object' ? `{${Object.entries(child as Record<string, unknown>)
      .filter(([key, item]) => key !== '_management_receipts' && item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
      : JSON.stringify(child);
  return createHash('sha256').update(canonical(value)).digest('hex');
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
  listId?: string;
}

export function createTask(input: CreateTaskInput): TaskRecord {
  const key = input.idempotency_key ?? randomUUID();
  const existing = findByIdempotencyKey(key);
  if (existing) return existing;

  const state: TaskState = input.start === false ? 'backlog' : 'provisioning';
  const record: StoredTaskRecord = {
    task_id: generateTaskId(),
    list_id: input.listId ?? DEFAULT_TASK_LIST_ID,
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
  return readTask(record.task_id);
}

export function getTask(id: string): TaskRecord { return withTaskLock(id, () => readTask(id)); }

export function listTasks(filter?: { state?: TaskState | TaskState[]; listId?: string }): TaskRecord[] {
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
      if ((!states || states.includes(t.state)) && (!filter?.listId || t.list_id === filter.listId)) tasks.push(t);
    } catch { /* corrupt file, skip */ }
  }
  const order = new Map(readTaskLists().map((item, index) => [item.list_id, index]));
  return tasks.sort((a, b) => (order.get(a.list_id!)! - order.get(b.list_id!)!)
    || a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));
}

export function moveTaskToList(id: string, listId: string): TaskRecord {
  return withTaskLock(id, () => {
    const task = readTask(id); task.list_id = listId; writeTask(task); return readTask(id);
  });
}

export function findByIdempotencyKey(key: string): TaskRecord | undefined {
  return listTasks().find(t => t.idempotency_key === key);
}

export function startTask(id: string, effect?: TaskEffectContext): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'provisioning');
  t.state = 'provisioning';
  t.started_at = new Date().toISOString();
  publishEffect(t, effect);
  return t;
  });
}

export function activateTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'active');
  t.state = 'active';
  delete t.blocked;
  writeTask(t);
  return t;
  });
}

export function blockTask(id: string, reason: string, effect?: TaskEffectContext): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  if (TASK_TERMINAL_STATES.includes(t.state))
    throw new TaskStateError(`cannot block a '${t.state}' task`);
  t.blocked = { reason, at: new Date().toISOString() };
  publishEffect(t, effect);
  return t;
  });
}

export function unblockTask(id: string, effect?: TaskEffectContext): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  if (!t.blocked) throw new TaskStateError('task is not blocked');
  delete t.blocked;
  publishEffect(t, effect);
  return t;
  });
}

export function reviewTask(id: string, effect?: TaskEffectContext): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  assertTransition(t.state, 'review');
  t.state = 'review';
  delete t.blocked;
  publishEffect(t, effect);
  return t;
  });
}

export function completeTask(id: string, outcome?: TaskOutcome): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
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
  assertNoPendingTerminalIntent(t);
  t.template = template;
  writeTask(t);
  return t;
  });
}

export function updateTaskMembers(id: string, members: TaskMemberRole[]): TaskRecord {
  return withTaskLock(id, () => {
  const t = readTask(id);
  assertNoPendingTerminalIntent(t);
  t.member_roles = members;
  writeTask(t);
  return t;
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
