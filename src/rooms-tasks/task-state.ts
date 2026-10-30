import { publishFleetResourceCommit } from '../application/resource-observer.js';
import type { ArchivedMemberAbsence } from './types.js';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically, withSynchronousFileLock } from '../atomic-file.js';
import { incarnationEnded, processIncarnation, type ProcessIncarnation } from '../process-incarnation.js';
import { stateRoot } from '../paths.js';
import { planWorkspace, ensureWorkspace } from './workspace.js';
import type {
  TaskRecord, TaskState, TaskBlocked, TaskOrigin, TaskTemplateRef,
  TaskOutcome, TaskMemberRole, TaskTerminalIntent,
  TaskDeletionActor, TaskDeletionMemberPhase, TaskNotificationEvent,
} from './types.js';
import { storedRoomLaunchPolicy, TASK_TERMINAL_STATES, TASK_CANCELLABLE_STATES } from './types.js';
import { DEFAULT_TASK_LIST_ID, readTaskLists, resolveTaskList, writeTaskListPrefixesLocked } from './task-lists.js';
import {
  activePrefixFor, canonicalFingerprint, claimPrefix, ensureKeyLedger, ensureMissionKeyRegistry, issueNextKey,
  MissionKeyError, observeIssuedKey, parseMissionKeyRef, readCreationReceipt, readKeyLedger,
  readMissionKeyRegistry, suggestMissionPrefix, unavailablePrefixes, withMissionKeysLock, writeCreationReceipt,
  writeMissionKeyRegistry, type CreationReceipt,
} from './mission-keys.js';
import { allocateName, freezeLegacyMemberNaming, type LabelCandidate } from './member-naming.js';
import { queueMissionCleanup, withManifestRooms, type TaskNotificationManifest } from './notification-manifest.js';

export const tasksDir = () => join(stateRoot(), 'tasks');

function taskPath(id: string): string { return join(tasksDir(), `${id}.json`); }
function taskLockPath(id: string): string { return join(tasksDir(), '.locks', id); }
const localTaskLocks = new Set<string>();

/**
 * Remove a lock atomically: rename it to a unique name first, so no other
 * process ever observes a half-removed lock.
 */
function retireLock(path: string): void {
  const retired = `${path}.retired.${process.pid}.${randomUUID()}`;
  try { renameSync(path, retired); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  rmSync(retired, { recursive: true, force: true });
}

/** A legacy lock directory without an owner file younger than this may still be releasing. */
const LEGACY_OWNERLESS_LOCK_GRACE_MS = 5_000;

/**
 * Hold a task's cross-process lock while `fn` runs.
 *
 * The lock is a file holding its owner record, published complete by hard-linking
 * a written temporary file: link never replaces an existing lock, and there is no
 * moment at which a live claimer has an ownerless lock that could look abandoned.
 * A lock is reclaimed only when its owner process has provably ended; reclaimers
 * take turns and remove only the lock they observed. Directory locks are left by
 * earlier versions; they are honored, and an ownerless one is reclaimed once it is
 * old enough, since this version never creates one.
 */
function withTaskLock<T>(id: string, fn: () => T): T {
  if (localTaskLocks.has(id)) return fn();
  const path = taskLockPath(id);
  const token = randomUUID(); mkdirSync(join(tasksDir(), '.locks'), { recursive: true });
  type Owner = { token?: string; pid?: number } & ProcessIncarnation;
  const readOwner = (): Owner | undefined => {
    try { return JSON.parse(readFileSync(path, 'utf8')) as Owner; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') return undefined;
      try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Owner; }
      catch { return undefined; }
    }
  };
  /** Who holds the lock now, and whether it can be proved abandoned. */
  const holder = () => {
    let stat;
    try { stat = lstatSync(path); } catch { return undefined; }
    const owner = readOwner();
    if (owner && typeof owner.pid === 'number') {
      let alive = false;
      try { process.kill(owner.pid, 0); alive = true; }
      catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      return { token: owner.token, stale: !alive || incarnationEnded(owner.pid, owner) };
    }
    return {
      token: undefined,
      stale: stat.isDirectory() && Date.now() - stat.mtimeMs > LEGACY_OWNERLESS_LOCK_GRACE_MS,
    };
  };
  const claimPath = `${path}.claim.${process.pid}.${randomUUID()}`;
  writeFileSync(claimPath, JSON.stringify({ token, pid: process.pid, ...processIncarnation(process.pid) }));
  try {
    for (;;) {
      try { linkSync(claimPath, path); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const observed = holder();
      if (observed?.stale) {
        try {
          withSynchronousFileLock(`${path}.reclaim`, () => {
            const current = holder();
            if (current?.stale && current.token === observed.token) retireLock(path);
          });
        } catch (error) {
          // A contender stalled inside the reclaim section: keep waiting like any other poll.
          if (!(error instanceof Error) || !/^Timed out acquiring synchronous/.test(error.message)) throw error;
        }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } finally {
    rmSync(claimPath, { force: true });
  }
  localTaskLocks.add(id);
  try { return fn(); }
  finally {
    localTaskLocks.delete(id);
    // Only this live owner removes its lock; reclaimers never take a live owner's lock.
    if (readOwner()?.token === token) retireLock(path);
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
  const path = taskPath(record.task_id);
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as StoredTaskRecord : undefined;
  const status = (task: StoredTaskRecord) => task.deletion?.status === 'pending' ? 'deleting' : task.blocked ? `${task.state} (blocked)` : task.state;
  // Read pending events under the same task lock as every mutation. Metadata edits
  // and retries preserve the queue; acknowledgement cannot be resurrected by stale input.
  let pending = [...(previous?.notification_events ?? [])];
  if (record.deletion?.status === 'pending') {
    // Deletion acceptance is the notification fence: queued transitions are obsolete and nothing new is produced.
    pending = [];
  } else {
    if (!previous || status(previous) !== status(record)) {
      const next = status(record), before = previous ? status(previous) : undefined;
      pending.push({ eventId: `task:${record.task_id}:${randomUUID()}`, taskId: record.task_id,
        title: `Task ${!previous ? 'created' : 'updated'}: ${taskLabel(record)}`.slice(0, 160),
        body: `Task ${record.task_id}: ${before ? `${before} → ` : 'created in '}${next}.`,
        target: { kind: 'task', taskId: record.task_id }, delivery: 'push-only' });
    }
    pending.push(...contributionEvents(previous, record));
  }
  if (previous && !previous.contribution_reads && contributionsChanged(previous, record))
    // First post-upgrade change: everything that existed before it counts as read, under this same lock.
    persisted.contribution_reads = { progress_read: (previous.progress ?? []).map(entry => entry.id), review_revision: reviewRevision(previous.review) };
  if (pending.length) persisted.notification_events = pending;
  else delete persisted.notification_events;
  replaceFileAtomically(taskPath(record.task_id), JSON.stringify(persisted, null, 2) + '\n');
  publishFleetResourceCommit(taskPath(record.task_id));
}

/** Human label for notification titles: the mission key, when issued, precedes the title. */
const taskLabel = (record: { key?: string; title: string }): string =>
  record.key ? `${record.key} · ${record.title}` : record.title;

/** Packages written before revisions existed count as revision 1; their next change becomes 2. No package is 0. */
export const reviewRevision = (review: { revision?: number } | undefined): number => review ? review.revision ?? 1 : 0;

const contributionsChanged = (previous: StoredTaskRecord, record: TaskRecord | StoredTaskRecord) =>
  (record.progress ?? []).some(entry => !(previous.progress ?? []).some(old => old.id === entry.id))
  || reviewRevision(record.review) !== reviewRevision(previous.review);

/** New Progress entries and new To review revisions push once each; reads and replays produce nothing. */
function contributionEvents(previous: StoredTaskRecord | undefined, record: TaskRecord | StoredTaskRecord): TaskNotificationEvent[] {
  if (!previous) return [];
  const id = record.task_id, events: TaskNotificationEvent[] = [];
  for (const entry of record.progress ?? []) {
    if ((previous.progress ?? []).some(old => old.id === entry.id)) continue;
    events.push({ eventId: `task:${id}:progress:${entry.id}`, taskId: id, title: `Progress: ${taskLabel(record)}`.slice(0, 160),
      body: (entry.text.trim() || 'New progress entry').slice(0, 512), target: { kind: 'task', taskId: id }, delivery: 'push-only' });
  }
  const revision = reviewRevision(record.review);
  if (revision > reviewRevision(previous.review))
    events.push({ eventId: `task:${id}:review:${revision}`, taskId: id, title: `To review updated: ${taskLabel(record)}`.slice(0, 160),
      body: `Task ${id}: the review package changed.`, target: { kind: 'task', taskId: id }, delivery: 'push-only' });
  return events;
}

/** Item-based Progress unread and revision-based To review unread. An absent read state means nothing is unread. */
export function contributionUnread(task: Pick<TaskRecord, 'progress' | 'review' | 'contribution_reads'>): { progress: number; review: boolean } {
  const reads = task.contribution_reads;
  if (!reads) return { progress: 0, review: false };
  const seen = new Set(reads.progress_read);
  return { progress: (task.progress ?? []).filter(entry => !seen.has(entry.id)).length, review: reviewRevision(task.review) > reads.review_revision };
}

/** Acknowledge Progress entries the user actually viewed; unknown IDs are ignored and the set only grows. */
export function acknowledgeTaskProgress(id: string, ids: string[]): { progress: number; review: boolean } {
  assertCanonicalTaskId(id);
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    // Without a read state everything present already counts as read: there is nothing to record.
    const reads = task.contribution_reads;
    if (!reads) return contributionUnread(task);
    const present = new Set((task.progress ?? []).map(entry => entry.id));
    const added = [...new Set(ids.filter(entryId => present.has(entryId) && !reads.progress_read.includes(entryId)))];
    if (added.length) {
      task.contribution_reads = { ...reads, progress_read: [...reads.progress_read, ...added] };
      writeTask(task);
    }
    return contributionUnread(task);
  });
}

/** Acknowledge the To review revision the user saw. Only moves forward; a revision newer than current is refused. */
export function acknowledgeTaskReview(id: string, revision: number): { progress: number; review: boolean } {
  assertCanonicalTaskId(id);
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    const current = reviewRevision(task.review);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > current) throw new TaskStateError('That review revision does not exist.');
    const reads = task.contribution_reads;
    if (reads && revision > reads.review_revision) {
      task.contribution_reads = { ...reads, review_revision: Math.max(reads.review_revision, revision) };
      writeTask(task);
    }
    return contributionUnread(task);
  });
}

const retiredNotificationsDir = () => join(tasksDir(), '.notification-retired');

function typedTaskNotification(value: TaskNotificationEvent, id: string): boolean {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['eventId', 'title', 'body', 'target', 'taskId', 'delivery'].includes(key))) return false;
  if (value.delivery !== undefined && value.delivery !== 'push-only') return false;
  const target = value.target;
  return typeof value.eventId === 'string' && value.eventId.startsWith(`task:${id}:`) && value.eventId.length <= 512
    && value.taskId === id && !!target && typeof target === 'object' && !Array.isArray(target)
    && Object.keys(target).every(key => ['kind', 'taskId'].includes(key)) && target.taskId === id
    && (target.kind === 'task' || (target.kind === 'task-deleted' && value.eventId === `task:${id}:deleted`))
    && typeof value.title === 'string' && !!value.title.trim() && value.title.length <= 160
    && typeof value.body === 'string' && !!value.body.trim() && value.body.length <= 512;
}

/** Atomic snapshots contain the events, including intermediate states between polls. */
/** `upgraded`: IDs of events queued by an earlier release without a delivery policy. They are sent push-only under the
 * same event ID (state transitions never count as unread); the queued record itself is not rewritten. A service that
 * already admitted one as an inbox row repairs that row to push-only itself, so the retry matches; any refusal keeps the
 * event queued. */
export function pendingTaskNotifications(warn: (line: string) => void = () => {}): Array<{ taskId: string; events: TaskNotificationEvent[]; upgraded: string[] }> {
  const result: Array<{ taskId: string; events: TaskNotificationEvent[]; upgraded: string[] }> = [];
  for (const dir of [tasksDir()]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(file => TASK_ID_PATTERN.test(file.slice(0, -5)) && file.endsWith('.json'))) {
      try {
        const path = join(dir, file), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid notification source');
        const value = JSON.parse(readFileSync(path, 'utf8')) as StoredTaskRecord;
        const id = file.slice(0, -5);
        // A prepared deletion copy has no authority while the original still exists.
        if (dir === retiredNotificationsDir() && existsSync(taskPath(id))) continue;
        if (value.notification_events === undefined) continue;
        if (!Array.isArray(value.notification_events)) throw new Error('invalid notification events');
        // Only typed task events are delivered. Unsupported entries are never sent or converted,
        // and they do not block later lifecycle events.
        const typed = value.notification_events.filter(event => typedTaskNotification(event, id));
        const upgraded = typed.filter(event => event.delivery === undefined).map(event => event.eventId);
        const events = typed.map(event => event.delivery ? event : { ...event, delivery: 'push-only' as const });
        if (events.length) result.push({ taskId: id, events, upgraded });
      } catch (error) {
        if (!isNotFoundError(error)) warn('Task notification record unavailable; other task deliveries continue');
      }
    }
  }
  return result;
}

/** Earlier releases kept a deleted task's queued events in `.notification-retired`. They are obsolete: each
 * becomes a cleanup intent for its task and is never delivered. Returns the number converted. */
export function convertRetiredTaskNotifications(): number {
  const dir = retiredNotificationsDir();
  if (!existsSync(dir)) return 0;
  let converted = 0;
  for (const file of readdirSync(dir).filter(file => file.endsWith('.json') && TASK_ID_PATTERN.test(file.slice(0, -5)))) {
    const id = file.slice(0, -5);
    withTaskLock(id, () => {
      if (existsSync(taskPath(id))) return;            // a prepared copy has no authority while the task exists
      queueMissionCleanup(id, []);
      rmSync(join(dir, file), { force: true });
      converted++;
    });
  }
  return converted;
}

/** Service event-id dedupe covers acceptance followed by a crash before this acknowledgement. */
export function acknowledgeTaskNotification(id: string, eventId: string): void {
  assertCanonicalTaskId(id);
  withTaskLock(id, () => {
    for (const path of [taskPath(id), join(retiredNotificationsDir(), `${id}.json`)]) {
      if (!existsSync(path)) continue;
      const value = JSON.parse(readFileSync(path, 'utf8')) as StoredTaskRecord;
      if (!value.notification_events?.some(event => typedTaskNotification(event, id) && event.eventId === eventId)) continue;
      value.notification_events = value.notification_events.filter(event => !typedTaskNotification(event, id) || event.eventId !== eventId);
      replaceFileAtomically(path, JSON.stringify(value, null, 2) + '\n');
      if (path.startsWith(retiredNotificationsDir() + '/') && !value.notification_events.length) unlinkSync(path);
    }
  });
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
  layout?: { name: string; definition_hash: string };
  room_id?: string;
  listId?: string;
  /** Submitted list name; resolved only after receipt replay, so a renamed or deleted list cannot reallocate. */
  list?: string;
}

function creationPlan(plan: TaskRecord['execution_plan'], layout?: { name: string; definition_hash: string }): string {
  return JSON.stringify([plan?.plan_hash ?? null, storedRoomLaunchPolicy(plan?.room_policy) ?? null,
    layout ? `${layout.name}@${layout.definition_hash}` : null]);
}

type CreateOutcome = { kind: 'existing'; taskId: string } | { kind: 'created'; taskId: string };

/** Original creation input retained in the receipt; a resumed create uses only this. */
interface StoredCreationInput {
  title: string; brief?: string; brief_file?: string; template?: TaskTemplateRef;
  execution_plan?: TaskRecord['execution_plan']; origin: TaskOrigin; start: boolean; no_room?: boolean;
  layout?: { name: string; definition_hash: string }; room_id?: string; list: string; created_at: string;
  /** Planned once at reservation, so a resumed create keeps the same owned workspace and marker. */
  workspace?: TaskRecord['workspace'];
}

const creationFingerprint = (input: CreateTaskInput, plan: string): string => canonicalFingerprint({
  title: input.title, brief: input.brief, brief_file: input.brief_file, template: input.template,
  plan, origin: input.origin, start: input.start !== false, no_room: input.no_room || undefined,
  room_id: input.room_id, list: input.list ?? input.listId ?? DEFAULT_TASK_LIST_ID,
});

function recordFromReceipt(receipt: CreationReceipt, idempotencyKey: string): StoredTaskRecord {
  const input = receipt.input as unknown as StoredCreationInput;
  const listId = readTaskLists().some(item => item.list_id === receipt.list_id) ? receipt.list_id : DEFAULT_TASK_LIST_ID;
  const state: TaskState = input.start === false ? 'backlog' : 'provisioning';
  const record: StoredTaskRecord = {
    task_id: receipt.task_id, key: receipt.mission_key, list_id: listId,
    title: input.title, brief: input.brief, brief_file: input.brief_file, state,
    template: input.template, execution_plan: input.execution_plan, no_room: input.no_room || undefined,
    ...(input.layout ? { layout: { name: input.layout.name, run_id: `task-${receipt.task_id}`, definition_hash: input.layout.definition_hash } } : {}),
    room_id: input.room_id, member_roles: [], origin: input.origin,
    idempotency_key: idempotencyKey, creation_plan: receipt.creation_plan,
    created_at: input.created_at, started_at: state === 'provisioning' ? input.created_at : undefined,
  };
  record.workspace = input.workspace ?? planWorkspace('task', record.task_id);
  return record;
}

/**
 * Create a task, or replay an earlier create with the same idempotency key.
 * Production callers hold `task-lists.lock`; allocation itself is serialized
 * by the innermost mission-keys lock. Ordering: high-water mark → reserved
 * receipt → key ledger → task row → receipt `created`. Every crash cut leaves
 * a gap or a resumable receipt, never a duplicate or a resurrected task.
 */
export function createTask(input: CreateTaskInput): TaskRecord {
  const key = input.idempotency_key ?? randomUUID();
  const requestedPlan = creationPlan(input.execution_plan, input.layout);
  if (input.layout && (input.execution_plan || input.no_room || input.room_id))
    throw new TaskStateError('a layout task cannot also use a room template, no-room mode or a room');
  migrateMissionKeysLocked();
  const fingerprint = creationFingerprint(input, requestedPlan);
  const outcome = withMissionKeysLock((): CreateOutcome => {
    const receipt = readCreationReceipt(key);
    if (receipt) {
      // Stable policy, unchanged from earlier releases: first write wins and only a different room
      // plan conflicts. A resumed create uses the stored original input, never the retry's fields.
      if (receipt.creation_plan !== undefined && receipt.creation_plan !== requestedPlan)
        throw new TaskStateError(`idempotency key '${key}' was already used with a different execution plan`);
      const present = existsSync(taskPath(receipt.task_id));
      if (receipt.mission_key && (present || receipt.state === 'reserved'))
        ensureKeyLedger(receipt.mission_key, receipt.task_id);
      if (present) {
        if (receipt.state === 'reserved') writeCreationReceipt(key, { ...receipt, state: 'created' });
        return { kind: 'existing', taskId: receipt.task_id };
      }
      if (receipt.state !== 'reserved' || readTaskDeletionReceipt(receipt.task_id) || !receipt.input)
        throw new MissionKeyError('task_deleted',
          `task ${receipt.mission_key ?? receipt.task_id} created with idempotency key '${key}' was deleted`);
      writeTask(recordFromReceipt(receipt, key));
      writeCreationReceipt(key, { ...receipt, state: 'created' });
      return { kind: 'created', taskId: receipt.task_id };
    }
    // Rows written by an earlier release before migration completed.
    const legacy = listTasks({ includeDeleting: true }).find(task => task.idempotency_key === key);
    if (legacy) {
      if ((legacy.creation_plan ?? creationPlan(legacy.execution_plan, legacy.layout)) !== requestedPlan)
        throw new TaskStateError(`idempotency key '${key}' was already used with a different execution plan`);
      return { kind: 'existing', taskId: legacy.task_id };
    }
    const listId = input.listId ?? resolveTaskList(input.list ?? 'default').list_id;
    const registry = ensureMissionKeyRegistry();
    const missionKey = issueNextKey(registry, listId);
    writeMissionKeyRegistry(registry);
    const taskId = generateTaskId();
    const stored: StoredCreationInput = {
      title: input.title, brief: input.brief, brief_file: input.brief_file, template: input.template,
      execution_plan: input.execution_plan, origin: input.origin, start: input.start !== false,
      no_room: input.no_room || undefined, layout: input.layout, room_id: input.room_id,
      list: input.list ?? listId, created_at: new Date().toISOString(),
      workspace: planWorkspace('task', taskId),
    };
    const reserved: CreationReceipt = { version: 1, task_id: taskId, mission_key: missionKey, list_id: listId,
      fingerprint, input: stored as unknown as Record<string, unknown>, creation_plan: requestedPlan, state: 'reserved' };
    writeCreationReceipt(key, reserved);
    ensureKeyLedger(missionKey, taskId);
    writeTask(recordFromReceipt(reserved, key));
    writeCreationReceipt(key, { ...reserved, state: 'created' });
    return { kind: 'created', taskId };
  });
  return withTaskLock(outcome.taskId, () => {
    const fresh = readTask(outcome.taskId);
    if (outcome.kind === 'existing') assertNoPendingDeletion(fresh);
    if (fresh.workspace) ensureWorkspace(fresh.workspace);
    return fresh;
  });
}

/**
 * Resolve a canonical task ID or a mission key (any case) to the canonical
 * ID. Callers authenticate before resolving. A deleted key resolves to its
 * canonical ID only with `allowDeleted` (idempotent DELETE replay); every
 * other use gets a stable `task_deleted` error and never another task.
 */
export function resolveTaskRef(ref: string, options: { allowDeleted?: boolean } = {}): string {
  if (typeof ref !== 'string') throw new TaskStateError('invalid task reference');
  if (TASK_ID_PATTERN.test(ref)) return ref;
  const key = parseMissionKeyRef(ref);
  // Not a key: hand the reference on unchanged so existing not-found/validation errors stay exact.
  if (!key) return ref;
  const entry = readKeyLedger(key);
  if (!entry) throw new TaskStateError(`task not found: ${key}`);
  if (!options.allowDeleted && entry.state === 'deleted' && !existsSync(taskPath(entry.task_id)))
    throw new MissionKeyError('task_deleted', `task ${key} was deleted`);
  return entry.task_id;
}

/**
 * Durable role-scoped names for members of a keyed task. Returns undefined
 * for a task without a mission key (legacy derivation applies). Existing
 * allocations are returned unchanged; new ones are persisted under the task
 * lock before the caller launches anything. `assertAvailable` runs for new
 * names only; a conflict persists nothing and fails safely.
 */
export function allocateTaskMemberNames(
  id: string, requests: Array<{ allocationKey: string; candidates: LabelCandidate[] }>,
  assertAvailable: (name: string) => void = () => {},
): string[] | undefined {
  assertCanonicalTaskId(id);
  return withTaskLock(id, () => {
    const task = readTask(id);
    if (!task.key) return undefined;
    let naming = task.member_naming;
    const names: string[] = [];
    const fresh: string[] = [];
    for (const request of requests) {
      const result = allocateName(naming, task.key, request.allocationKey, request.candidates);
      naming = result.naming;
      names.push(result.allocation.name);
      if (result.created) fresh.push(result.allocation.name);
    }
    for (const name of fresh) assertAvailable(name);
    if (fresh.length) {
      assertNoPendingDeletion(task);
      task.member_naming = naming;
      writeTask(task);
    }
    return names;
  });
}

/** Recorded allocation name for `allocationKey`, without allocating. */
export function recordedMemberName(id: string, allocationKey: string): string | undefined {
  assertCanonicalTaskId(id);
  if (!existsSync(taskPath(id))) return undefined;
  const row = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  return row.member_naming?.allocations[allocationKey]?.name;
}

// ── One-time mission key migration ──────────────────────────────────────

function listLedgerKeys(): Set<string> {
  const dir = join(stateRoot(), 'mission-keys', 'keys');
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)));
}

/**
 * Assign prefixes and keys to historical lists and tasks, then seed or repair
 * receipts, ledger entries and frozen agent names for every row. Caller holds
 * `task-lists.lock` (every production path does); per row the lock order is
 * task lock → mission-keys lock, the same as deletion acceptance. Re-runnable:
 * every step is idempotent, and `keys_migrated` is written only at the end.
 */
export function migrateMissionKeysLocked(configuredDefault?: string): void {
  // Lock-free fast path: a completed migration with a matching default prefix needs no writes.
  const current = readMissionKeyRegistry();
  if (current?.keys_migrated && (configuredDefault === undefined || current.default_prefix === configuredDefault)) return;
  const initial = ensureMissionKeyRegistry(configuredDefault);
  if (initial.keys_migrated) return;
  // 1. Prefixes for lists that predate mission keys.
  const assigned = withMissionKeysLock(() => {
    const registry = readMissionKeyRegistry()!;
    const prefixes = new Map<string, string>();
    for (const list of readTaskLists()) {
      if (list.built_in) continue;
      const existing = activePrefixFor(registry, list.list_id);
      const prefix = list.prefix ?? existing ?? suggestMissionPrefix(list.name, unavailablePrefixes(registry));
      if (!existing) claimPrefix(registry, list.list_id, prefix, false);
      prefixes.set(list.list_id, prefix);
    }
    writeMissionKeyRegistry(registry);
    return prefixes;
  });
  writeTaskListPrefixesLocked(assigned);
  // 2. Reconcile every issued key before anything new is issued.
  const rows = (existsSync(tasksDir()) ? readdirSync(tasksDir()) : [])
    .filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
    .filter(id => TASK_ID_PATTERN.test(id))
    .map(id => ({ id, row: JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord }))
    .sort((a, b) => (a.row.list_id ?? DEFAULT_TASK_LIST_ID).localeCompare(b.row.list_id ?? DEFAULT_TASK_LIST_ID)
      || a.row.created_at.localeCompare(b.row.created_at) || a.id.localeCompare(b.id));
  withMissionKeysLock(() => {
    const registry = readMissionKeyRegistry()!;
    for (const { row } of rows) {
      if (row.key) observeIssuedKey(registry, row.key, row.list_id ?? DEFAULT_TASK_LIST_ID);
      const receipt = readCreationReceipt(row.idempotency_key);
      if (receipt?.mission_key) observeIssuedKey(registry, receipt.mission_key, receipt.list_id);
    }
    for (const key of listLedgerKeys()) observeIssuedKey(registry, key, DEFAULT_TASK_LIST_ID);
    writeMissionKeyRegistry(registry);
  });
  // 3 + 4. Per row: reserve → receipt → ledger → keyed row, and repair every row.
  for (const { id } of rows) {
    withTaskLock(id, () => withMissionKeysLock(() => {
      if (!existsSync(taskPath(id))) return;
      const row = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
      const listId = row.list_id ?? DEFAULT_TASK_LIST_ID;
      const deleting = row.deletion?.status === 'pending';
      const prior = readCreationReceipt(row.idempotency_key);
      let missionKey = row.key ?? prior?.mission_key;
      if (!missionKey) {
        const registry = readMissionKeyRegistry()!;
        const effectiveList = activePrefixFor(registry, listId) ? listId : DEFAULT_TASK_LIST_ID;
        missionKey = issueNextKey(registry, effectiveList);
        writeMissionKeyRegistry(registry);
      }
      if (prior?.state !== 'deleted')
        writeCreationReceipt(row.idempotency_key, {
          version: 1, task_id: id, mission_key: missionKey, list_id: listId,
          ...(prior?.fingerprint ? { fingerprint: prior.fingerprint, input: prior.input } : {}),
          creation_plan: row.creation_plan ?? creationPlan(row.execution_plan, row.layout),
          state: deleting ? 'deleted' : 'created',
        });
      ensureKeyLedger(missionKey, id, deleting ? 'deleted' : 'live');
      const naming = freezeLegacyMemberNaming(row);
      if (row.key !== missionKey || naming !== row.member_naming) {
        if (row.key !== missionKey) { row.key = missionKey; row.key_from_migration = true; }
        if (naming) row.member_naming = naming;
        writeTask(row);
      }
    }));
  }
  withMissionKeysLock(() => {
    const registry = readMissionKeyRegistry()!;
    registry.keys_migrated = true;
    writeMissionKeyRegistry(registry);
  });
}

export function getTask(id: string): TaskRecord { return withTaskLock(id, () => readTask(id)); }

export function updateTaskExecutionPlan(
  id: string, executionPlan: NonNullable<TaskRecord['execution_plan']>,
): TaskRecord {
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    if (task.execution_plan) {
      if (task.execution_plan.plan_hash !== executionPlan.plan_hash)
        throw new TaskStateError(`task ${id} execution plan mismatch`);
      const before = storedRoomLaunchPolicy(task.execution_plan.room_policy);
      const after = storedRoomLaunchPolicy(executionPlan.room_policy);
      if (task.room_id && JSON.stringify(before) !== JSON.stringify(after))
        throw new TaskStateError(`task ${id} Room launch policy cannot change after Room creation`);
    }
    task.execution_plan = executionPlan;
    task.template = { name: executionPlan.snapshot.name, version: executionPlan.snapshot.version,
      content_hash: executionPlan.snapshot.content_hash };
    writeTask(task);
    return readTask(id);
  });
}

export function listTasks(filter?: {
  state?: TaskState | TaskState[]; listId?: string; includeDeleting?: boolean; strict?: boolean;
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
    } catch (error) { if(filter?.strict)throw error; /* legacy CLI inventory tolerates corrupt files */ }
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
  t.notification_manifest = withManifestRooms(t.notification_manifest, [roomIdentityCid]);
  writeTask(t);
  return t;
  });
}

/** Record room CIDs as this task's notification-owned rooms (union only). Returns the manifest to register. */
export function recordNotificationRooms(id: string, cids: string[]): TaskNotificationManifest {
  assertCanonicalTaskId(id);
  return withTaskLock(id, () => {
    const t = readTask(id);
    assertNoPendingDeletion(t);
    const next = withManifestRooms(t.notification_manifest, cids);
    if (next !== t.notification_manifest) { t.notification_manifest = next; writeTask(t); }
    return next;
  });
}

/** After a refused registration (409), move the manifest revision past the refused one; rooms are unchanged. A retry
 * then registers the full union under a newer revision. Nothing happens if the manifest already moved on. */
export function advanceNotificationRevision(id: string, refused: number): void {
  assertCanonicalTaskId(id);
  withTaskLock(id, () => {
    const t = readTask(id);
    if (t.deletion?.status === 'pending' || t.notification_manifest?.revision !== refused) return;
    t.notification_manifest = { ...t.notification_manifest, revision: refused + 1 };
    writeTask(t);
  });
}

/** Every room this task ever recorded, including the current one from records written before manifests existed. */
export function notificationRoomCids(task: Pick<TaskRecord, 'notification_manifest' | 'room_identity_cid'>): string[] {
  return withManifestRooms(task.notification_manifest, task.room_identity_cid ? [task.room_identity_cid] : []).room_cids;
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

/**
 * Lenient read for deletion settlement and status surfaces: a broken list
 * reference must never make a task unreadable or undeletable. Missing records
 * throw the canonical task-not-found error; other read failures propagate.
 */
export function getDeletingTask(id: string): TaskRecord {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  try {
    return presentTaskLenient(JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord);
  } catch (error) {
    if (isNotFoundError(error)) throw new TaskStateError(`task not found: ${id}`);
    throw error;
  }
  });
}

/** Cheap durable deletion-epoch probe for room/member publication guards. */
export function taskDeletionState(id: string): 'none' | 'pending' | 'absent' {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  try {
    const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
    return stored.deletion?.status === 'pending' ? 'pending' : 'none';
  } catch (error) {
    if (isNotFoundError(error)) return 'absent';
    throw error;
  }
  });
}

/**
 * Durable, surface-independent audit evidence for a permanent deletion. The
 * receipt supports in-flight recovery only: written with acceptance intent,
 * then erased before settlement is reported. It may contain a bounded title.
 */
export interface TaskDeletionReceipt {
  schema_version: 1;
  task_id: string;
  title: string;
  accepted_at: string;
  actor: TaskDeletionActor;
  original_state: TaskState;
  room_id?: string;
  member_count: number;
  archived_absences?: ArchivedMemberAbsence[];
  settled_at?: string;
  result?: 'deleted';
}

export const deletionReceiptsDir = () => join(stateRoot(), 'deletion-receipts');
function deletionReceiptPath(id: string): string {
  return join(deletionReceiptsDir(), `${id}.json`);
}

export function readTaskDeletionReceipt(id: string): TaskDeletionReceipt | undefined {
  assertCanonicalTaskId(id);
  try {
    return JSON.parse(readFileSync(deletionReceiptPath(id), 'utf8')) as TaskDeletionReceipt;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function writeDeletionReceiptForIntent(stored: StoredTaskRecord): void {
  const deletion = stored.deletion!;
  mkdirSync(deletionReceiptsDir(), { recursive: true });
  const receipt: TaskDeletionReceipt = {
    schema_version: 1,
    task_id: stored.task_id,
    title: stored.title.slice(0, 256),
    accepted_at: deletion.accepted_at,
    actor: deletion.actor,
    original_state: stored.state,
    room_id: deletion.room_id,
    member_count: deletion.members.length + (deletion.archived_absences?.length ?? 0),
    ...(deletion.archived_absences?.length ? { archived_absences: deletion.archived_absences } : {}),
  };
  replaceFileAtomically(deletionReceiptPath(stored.task_id), JSON.stringify(receipt, null, 2) + '\n');
}

/**
 * Ensure the acceptance receipt exists before any cleanup side effect,
 * backfilling it from the durable intent (heals a crash between the intent
 * write and the receipt write). Fails closed: a receipt write error aborts
 * settlement rather than deleting resources without audit evidence.
 */
export function ensureTaskDeletionReceipt(id: string): void {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  if (stored.deletion?.status !== 'pending')
    throw new TaskStateError(`task ${id} has no pending deletion`);
  if (!readTaskDeletionReceipt(id)) writeDeletionReceiptForIntent(stored);
  });
}

/** Erase the in-flight receipt; also heals a crash after task unlink. */
export function completeTaskDeletionReceipt(id: string): void {
  assertCanonicalTaskId(id);
  rmSync(deletionReceiptPath(id), { force: true });
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
    if (isNotFoundError(error)) {
      completeTaskDeletionReceipt(id);
      return { status: 'already_absent' };
    }
    throw error;
  }
  if (stored.deletion?.status === 'pending') {
    // Heal a crash between the intent write and the receipt write.
    tombstoneCreation(stored);
    if (!readTaskDeletionReceipt(id)) writeDeletionReceiptForIntent(stored);
    queueMissionCleanup(id, notificationRoomCids(stored));
    return { status: 'pending', task: presentTaskLenient(stored) };
  }
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
  // Tombstone the create receipt and key first, so no create retry can resurrect this task.
  tombstoneCreation(stored);
  // The task write drops queued transitions; the cleanup intent then retires everything already delivered.
  writeTask(stored);
  queueMissionCleanup(id, notificationRoomCids(stored));
  writeDeletionReceiptForIntent(stored);
  return { status: 'accepted', task: presentTaskLenient(stored) };
  });
}

/** Terminal `deleted` receipt and ledger state; seeds a receipt for rows that predate receipts. */
function tombstoneCreation(stored: StoredTaskRecord): void {
  withMissionKeysLock(() => {
    const receipt = readCreationReceipt(stored.idempotency_key);
    const key = stored.key ?? receipt?.mission_key;
    writeCreationReceipt(stored.idempotency_key, {
      ...(receipt ?? { version: 1 as const, task_id: stored.task_id, list_id: stored.list_id ?? DEFAULT_TASK_LIST_ID,
        creation_plan: stored.creation_plan ?? creationPlan(stored.execution_plan, stored.layout) }),
      mission_key: key as string, state: 'deleted',
    });
    if (key) ensureKeyLedger(key, stored.task_id, 'deleted');
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
/** Marker proving absence verified against temp state AND the CID-wide identity scan. */
export const DELETION_MEMBER_ABSENT_VERIFIED = 'absent-verified';

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
    && (launch === DELETION_MEMBER_NEVER_LAUNCHED || launch === DELETION_MEMBER_ABSENT_VERIFIED);
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

interface SeatEvidence {
  role_name: string;
  identity_cid?: string;
  launch?: { launch_id?: string; action_id?: string; task_supervised?: boolean };
  retirement?: { absence_verified?: boolean; phase: TaskDeletionMemberPhase; launch_id: string; archive_path?: string };
}

function findCursorForSeat(
  id: string, stored: StoredTaskRecord, seat: SeatEvidence,
): import('./types.js').TaskDeletionMemberCursor | undefined {
  const cursor = stored.deletion!.members.find(member => member.name === seat.role_name);
  if (cursor && seat.identity_cid
    && cursor.identity_cid.toLowerCase() !== seat.identity_cid.toLowerCase())
    throw new TaskStateError(
      `task ${id} deletion member '${seat.role_name}' identity CID mismatch between cursor and room seat`,
    );
  if (cursor?.action_id && seat.launch?.action_id && cursor.action_id !== seat.launch.action_id)
    throw new TaskStateError(`task ${id} deletion member '${seat.role_name}' creation ownership proof changed`);
  return cursor;
}

/**
 * Durably register cursors for late-provisioned members before retirement
 * begins: provisioning publishes room seats before updateTaskMembers, so the
 * acceptance snapshot can be empty while live seats exist. Seats without a
 * recorded identity CID are not registered here — until a CID is recorded
 * there is no managed identity to orphan, and the room record still carries
 * those seats through the close saga that follows.
 */
export function upsertTaskDeletionMembersFromSeats(
  id: string, seats: ReadonlyArray<SeatEvidence>,
): TaskRecord {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  if (stored.deletion?.status !== 'pending')
    throw new TaskStateError(`task ${id} has no pending deletion`);
  const now = new Date().toISOString();
  for (const seat of seats) {
    if (!seat.identity_cid) continue;
    const cursor = findCursorForSeat(id, stored, seat);
    if (!cursor) {
      stored.deletion.members.push({
        name: seat.role_name, identity_cid: seat.identity_cid, phase: 'pending', updated_at: now,
        ...(seat.launch?.action_id ? { action_id: seat.launch.action_id } : {}),
        ...(seat.launch?.task_supervised ? { task_supervised: true } : {}),
      });
    } else {
      if (seat.launch?.action_id) cursor.action_id ??= seat.launch.action_id;
      if (seat.launch?.task_supervised) cursor.task_supervised = true;
    }
  }
  writeTask(stored);
  return presentTaskLenient(stored);
  });
}

/**
 * The pre-room-delete checkpoint: import completed retirement evidence from
 * room seats into the deletion cursors, so a crash between room-record
 * deletion and task unlink retries from durable cursors instead of
 * reconstructing consumed evidence. Call ONLY after closeManagedRoom has
 * completed retirement and BEFORE cowork.deleteRoom/deleteRoomRecord.
 *
 * The room saga is trusted for phase jumps, but partial or corrupt retained
 * records must not become false success: every seat must be identity_absent;
 * a real launch requires archive evidence; an identity-less seat requires
 * never-launched proof or a freshly verified archived-absence checkpoint.
 */
export function importTaskDeletionRetirementEvidence(
  id: string, seats: ReadonlyArray<SeatEvidence>, proofs: ReadonlyArray<ArchivedMemberAbsence> = [],
): TaskRecord {
  return withTaskLock(id, () => {
  assertCanonicalTaskId(id);
  const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
  if (stored.deletion?.status !== 'pending')
    throw new TaskStateError(`task ${id} has no pending deletion`);
  const now = new Date().toISOString();
  for (const seat of seats) {
    const evidence = seat.retirement;
    if (evidence?.phase !== 'identity_absent')
      throw new TaskStateError(
        `task ${id} deletion cannot checkpoint member '${seat.role_name}' before completed retirement`,
      );
    const neverLaunched = evidence.launch_id === DELETION_MEMBER_NEVER_LAUNCHED
      || evidence.launch_id === DELETION_MEMBER_ABSENT_VERIFIED || evidence.absence_verified === true;
    if (!neverLaunched && evidence.archive_path === undefined)
      throw new TaskStateError(
        `task ${id} deletion member '${seat.role_name}' retirement evidence lacks its archive`,
      );
    if (!seat.identity_cid) {
      if (neverLaunched) {
        stored.deletion.absent_members ??= [];
        if (!stored.deletion.absent_members.includes(seat.role_name)) stored.deletion.absent_members.push(seat.role_name);
        continue;
      }
      const proof = proofs.find(value => value.name === seat.role_name);
      if (proof && proof.launch_id === evidence.launch_id && proof.archive_path === evidence.archive_path
          && proof.launch_id === seat.launch?.launch_id && proof.action_id === seat.launch?.action_id) {
        const existing = stored.deletion.archived_absences?.find(value => value.name === proof.name);
        if (existing && (existing.launch_id !== proof.launch_id || existing.action_id !== proof.action_id
            || existing.archive_path !== proof.archive_path))
          throw new TaskStateError('Archived absence checkpoint ownership is immutable');
        stored.deletion.archived_absences ??= [];
        if (!existing) stored.deletion.archived_absences.push({ ...proof });
        continue;
      }
      throw new TaskStateError(
        `task ${id} deletion member '${seat.role_name}' has retirement evidence but no identity CID`,
      );
    }
    let cursor = findCursorForSeat(id, stored, seat);
    if (!cursor) {
      cursor = { name: seat.role_name, identity_cid: seat.identity_cid, phase: 'pending', updated_at: now };
      stored.deletion.members.push(cursor);
    }
    if (seat.launch?.action_id) cursor.action_id ??= seat.launch.action_id;
    if (seat.launch?.task_supervised) cursor.task_supervised = true;
    if (DELETION_MEMBER_PHASE_ORDER[evidence.phase] < DELETION_MEMBER_PHASE_ORDER[cursor.phase]) continue;
    if (cursor.launch_id !== undefined && cursor.launch_id !== evidence.launch_id)
      throw new TaskStateError(
        `task ${id} deletion member '${seat.role_name}' launch ownership proof is immutable`,
      );
    if (cursor.archive_path !== undefined && evidence.archive_path !== undefined
      && cursor.archive_path !== evidence.archive_path)
      throw new TaskStateError(
        `task ${id} deletion member '${seat.role_name}' archive evidence is immutable`,
      );
    cursor.phase = evidence.phase;
    cursor.launch_id = evidence.launch_id;
    if (evidence.archive_path !== undefined) cursor.archive_path = evidence.archive_path;
    cursor.updated_at = now;
  }
  writeTask(stored);
  writeDeletionReceiptForIntent(stored);
  return presentTaskLenient(stored);
  });
}

/** Settlement-only checkpoint, under the task-operation lock after fresh archive verification.
 * From here retries still verify live absence, but owned archives may be consumed.
 */
export function beginTaskWorkspaceCleanup(id: string): void {
  withTaskLock(id, () => {
    const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
    if (stored.deletion?.status !== 'pending'
        || stored.deletion.members.some(member => member.phase !== 'identity_absent'))
      throw new TaskStateError('Task is not ready for workspace cleanup');
    stored.deletion.workspace_cleanup_started_at ??= new Date().toISOString();
    writeTask(stored);
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
  // Merge rooms proven since acceptance into the durable cleanup intent before the record disappears.
  // No deletion notification is produced: deleting retires the task's notifications instead.
  queueMissionCleanup(id, notificationRoomCids(stored));
  try {
    unlinkSync(taskPath(id));
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  return true;
  });
}

/** Called only after current temp and exact identity absence have been checked. */
export function settleAbsentTaskDeletionMember(id: string, name: string): void {
  withTaskLock(id, () => {
    const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
    if (stored.deletion?.status !== 'pending') throw new TaskStateError('Task is not deleting');
    const member = stored.deletion.members.find(value => value.name === name);
    if (!member) throw new TaskStateError('Unknown deletion member');
    member.phase = 'identity_absent';
    member.launch_id ??= DELETION_MEMBER_ABSENT_VERIFIED;
    member.updated_at = new Date().toISOString();
    writeTask(stored);
  });
}

/** Room-only erasure keeps the parent Task but removes its dead room/member links. */
export function detachDeletedRoom(taskId: string, roomId: string): void {
  withTaskLock(taskId, () => {
    if (!existsSync(taskPath(taskId))) return;
    const stored = JSON.parse(readFileSync(taskPath(taskId), 'utf8')) as StoredTaskRecord;
    if (stored.room_id !== roomId || stored.deletion?.status === 'pending') return;
    delete stored.room_id;
    delete stored.room_identity_cid;
    stored.member_roles = [];
    writeTask(stored);
  });
}

/** A completed room may consume its archives while other task members still retire. */
export function beginTaskArchiveCleanup(id: string): void {
  withTaskLock(id, () => {
    const stored = JSON.parse(readFileSync(taskPath(id), 'utf8')) as StoredTaskRecord;
    if (stored.deletion?.status !== 'pending') throw new TaskStateError('Task is not deleting');
    stored.deletion.workspace_cleanup_started_at ??= new Date().toISOString();
    writeTask(stored);
  });
}

/** Metadata-only edit; compare under the task lock to prevent lost updates. */
/**
 * Choose, change or clear a Backlog task's Room Layout before it starts.
 * `expected` is the layout name the caller saw (null = none); a different
 * current choice is a stale edit. Choosing a layout drops the sealed room
 * template plan; the caller releases the returned launch snapshot hash.
 */
export function updateTaskLayout(
  id: string, expected: string | null, next: { name: string; definition_hash: string } | null,
): { task: TaskRecord; releasedSnapshot?: string } {
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    assertNoPendingTerminalIntent(task);
    if (task.state !== 'backlog' || task.room_id)
      throw new TaskStateError(`task ${id} has started; its room layout is fixed (state '${task.state}')`);
    const current = task.layout?.name ?? null;
    // A replay of the same choice is idempotent (and refreshes the pinned source hash).
    if (current !== expected && current !== (next?.name ?? null))
      throw new TaskStateError(`task ${id} room layout changed to '${current ?? 'one room'}'; reload before changing it`);
    const releasedSnapshot = next ? task.execution_plan?.snapshot.launch_snapshot_hash : undefined;
    if (next) {
      task.layout = { name: next.name, run_id: `task-${task.task_id}`, definition_hash: next.definition_hash };
      delete task.execution_plan; delete task.template; delete task.no_room;
    } else delete task.layout;
    task.room_plan_changed_at = new Date().toISOString();
    writeTask(task);
    return { task: readTask(id), ...(releasedSnapshot ? { releasedSnapshot } : {}) };
  });
}

/**
 * Progress and To review edits: one read-modify-write under the task lock, so
 * concurrent writers never lose each other's changes. Lifecycle state is untouched.
 */
export function updateTaskContribution<T>(id: string, change: (task: TaskRecord) => { value: T; changed: boolean }): T {
  assertCanonicalTaskId(id);
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    assertNoPendingTerminalIntent(task);
    const { value, changed } = change(task);
    if (changed) writeTask(task);
    return value;
  });
}

export function updateTaskBrief(id: string, brief: string, expectedBrief: string): TaskRecord {
  assertCanonicalTaskId(id);
  return withTaskLock(id, () => {
    const task = readTask(id);
    assertNoPendingDeletion(task);
    assertNoPendingTerminalIntent(task);
    if ((task.brief ?? '') !== expectedBrief && task.brief !== brief)
      throw new TaskStateError('Description changed elsewhere. Reload the task before saving.');
    task.brief = brief;
    writeTask(task);
    return task;
  });
}
