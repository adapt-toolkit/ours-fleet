import { readFileSync } from 'node:fs';

import { ConfigError, loadConfig, type FleetConfig } from '../config.js';
import {
  CoworkProtocolError, CoworkUnavailableError, createCoworkAdapter, type CoworkAdapter,
} from '../rooms-tasks/cowork-adapter.js';
import { getBinPath, provisionMembers } from '../rooms-tasks/provision.js';
import {
  activateRoom, advanceSaga, createRoomRecord, getRoomRecord, listRoomRecords, setOwnerSeat, setSagaError,
} from '../rooms-tasks/room-state.js';
import {
  activateTask, blockTask as persistBlockTask, createTask as persistTask,
  getDeletingTask, getTask as readTask, listTasks as readTasks, taskDeletionState,
  moveTaskToList,
  reviewTask as persistReviewTask, startTask as transitionTask,
  TaskStateError, unblockTask as persistUnblockTask, updateTaskRoom, updateTaskTemplate,
  updateTaskExecutionPlan,
} from '../rooms-tasks/task-state.js';
import {
  createTaskListLocked, DEFAULT_TASK_LIST_ID, deleteTaskListRecordLocked, readTaskLists,
  renameTaskListLocked, resolveTaskList, TaskListError, withTaskListsLock,
} from '../rooms-tasks/task-lists.js';
import { hashTemplate, listTemplates, resolveTemplate, sealTemplateSnapshot, snapshotTemplate } from '../rooms-tasks/templates.js';
import { acquireLaunchSnapshotLock, releaseLaunchSnapshot } from '../rooms-tasks/launch-snapshot.js';
import { hashMemberOverrides, prepareExecutionPlan, type MemberOverrides } from '../rooms-tasks/member-overrides.js';
import {
  checkpointFleetAuditPresentations, recordFleetAuditPresentation, recordFleetAuditResource,
} from '../fleet-command-audit.js';
import {
  acceptManagedRoomClose, deleteLegacyClosedRooms, deleteManagedRoom, recordManagedRoomCloseError,
} from '../rooms-tasks/close.js';
import {
  acceptTaskTerminalIntent, recordTaskTerminalIntentError, settleTaskTerminalIntent,
  TASK_OPERATION_LOCK_STALE_MS, taskOperationLockPath,
} from '../rooms-tasks/terminal.js';
import {
  acceptTaskDeletion, recordTaskDeletionError, settleTaskDeletion,
  type TaskDeletionSettleResult,
} from '../rooms-tasks/deletion.js';
import { withFileLock } from '../atomic-file.js';
import { launchFleetWorker } from '../rooms-tasks/external-worker.js';
import type {
  RoomLaunchPolicy, RoomOrchestrationRecord, TaskDeletionActor, TaskListRecord,
  TaskOrigin, TaskOutcome, TaskRecord, TaskState, TemplateSnapshot,
} from '../rooms-tasks/types.js';
import type { TaskDeletionAcceptance } from '../rooms-tasks/task-state.js';
import { storedRoomLaunchPolicy, TASK_CANCELLABLE_STATES, TASK_TERMINAL_STATES } from '../rooms-tasks/types.js';
import { deriveTaskRoomName } from '../rooms-tasks/task-room-name.js';

export type TaskRoomActor =
  | { kind: 'local_control'; surface: 'cli' | 'web' }
  | { kind: 'authenticated_owner'; surface: 'messenger'; cid: string }
  | { kind: 'internal_worker'; surface: 'cli' };

export interface TaskSettlementPlan {
  task: TaskRecord;
  settlementRequired: boolean;
}
export type TaskRecoveryIssue =
  | { code: 'terminal_pending' | 'waiting_cowork' | 'waiting_owner_invite' | 'owner_cid_mismatch' | 'waiting_seats' | 'provisioning_resumed' }
  | { code: 'member_failed'; stepIndex: number }
  | { code: 'resume_failed'; error: string };
export interface TaskRecoveryResult {
  kind: 'provisioning_resumed' | 'provisioning_resume_failed' | 'provisioning_non_resumable' | 'terminal' | 'no_op';
  task: TaskRecord;
  room: RoomOrchestrationRecord | undefined;
  issues: TaskRecoveryIssue[];
  reason?: 'missing_room' | 'missing_durable_template' | 'non_resumable_phase';
}
export interface TaskProvisioningOutcome {
  kind: 'ready' | 'in_progress' | 'failed';
  task: TaskRecord;
  room?: RoomOrchestrationRecord;
  handle: { command: string; task_id: string };
  launch: { template?: string; anonymous: boolean; owner_attached: boolean };
  members: { expected: number; active: number; launched: number };
  blocker?: string;
  next_action?: string;
}

function recordCanonicalRoomCreated(room: RoomOrchestrationRecord): void {
  recordFleetAuditPresentation({ kind: 'room', operation: 'create',
    eventId: `room-created:${room.created_at}`, id: room.room_id,
    name: room.room_name, previousState: 'none', newState: 'provisioning',
    revision: room.created_at, taskId: room.task_id,
    template: room.template_snapshot
      ? `${room.template_snapshot.name}@${room.template_snapshot.version}` : undefined,
    anonymous: storedRoomLaunchPolicy(room.room_policy).anonymous,
    memberCount: room.template_snapshot?.members.reduce((sum, member) => sum + member.count, 0) ?? 0,
    participants: [] });
}

/** Repairable terminal observation derived entirely from durable Task/Room state. */
export function recordTaskProvisioningOutcome(outcome: TaskProvisioningOutcome): void {
  const room = outcome.room;
  recordFleetAuditResource('task', outcome.task.task_id);
  if (room) {
    recordFleetAuditResource('room', room.room_id);
    // Always restate created before a later terminal transition. The stable
    // digest makes this a no-op when the original checkpoint was delivered,
    // and repairs a crash after Room persistence but before that checkpoint.
    recordCanonicalRoomCreated(room);
  }
  if (outcome.kind === 'ready' && room) recordFleetAuditPresentation({
    kind: 'room', operation: 'activate', eventId: `room-ready:${room.activated_at ?? room.created_at}`,
    id: room.room_id, name: room.room_name, previousState: 'provisioning', newState: 'active',
    revision: room.activated_at ?? room.created_at, taskId: room.task_id,
    template: outcome.launch.template, anonymous: outcome.launch.anonymous,
    memberCount: outcome.members.expected, ownerAttached: outcome.launch.owner_attached,
    participants: [],
  });
  if (outcome.kind === 'failed') recordFleetAuditPresentation({
    kind: 'lifecycle_failure', resource: 'Task', id: outcome.task.task_id,
    state: outcome.task.state, category: 'provision_failed',
    eventId: outcome.task.ended_at ?? room?.created_at ?? outcome.task.created_at,
  });
}
export type TaskRecoveryBegin =
  | { kind: 'terminal_worker_required'; taskId: string }
  | { kind: 'deletion_worker_required'; taskId: string }
  | { kind: 'final'; result: TaskRecoveryResult };

export class TaskRoomApplicationError extends Error {
  constructor(readonly code: 'template_not_found' | 'task_template_drift' | 'template_mismatch'
    | 'task_terminal' | 'task_terminal_already' | 'task_non_resumable' | 'task_deleting'
    | 'room_not_found' | 'room_record_not_found', message: string,
    readonly fields: Readonly<Record<string, string>> = {}) {
    super(message); this.name = 'TaskRoomApplicationError';
  }
}

export interface CreateTaskRequest {
  actor: TaskRoomActor;
  title: string;
  brief?: string;
  briefFile?: string;
  template?: string;
  backlog?: boolean;
  noRoom?: boolean;
  idempotencyKey?: string;
  origin: TaskOrigin;
  list?: string;
  members?: MemberOverrides;
  anonymous?: boolean;
}
export interface CreateRoomRequest {
  actor: TaskRoomActor;
  name: string;
  template?: string;
  goal?: string;
  brief?: string;
  briefFile?: string;
  members?: MemberOverrides;
  anonymous?: boolean;
}

export function resolveRoomLaunchPolicy(
  template: TemplateSnapshot | undefined, override: boolean | undefined,
): RoomLaunchPolicy {
  const anonymous = override ?? template?.room?.anonymous ?? false;
  return { anonymous };
}

export interface TaskRoomServiceDeps {
  loadConfiguration?(path?: string): FleetConfig;
  cowork?(config: FleetConfig): CoworkAdapter;
  binPath?(): string;
  provisionMembers?: typeof provisionMembers;
  moveTaskToList?: typeof moveTaskToList;
  launchDeletionWorker?(taskId: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** Exact extraction of the previously CLI-owned task create/start behavior. */
export class TaskRoomApplicationService {
  private recovery?: { taskId: string; config: FleetConfig };
  constructor(
    private readonly configurationPath?: string,
    private readonly deps: TaskRoomServiceDeps = {},
  ) {}

  async createTask(request: CreateTaskRequest): Promise<TaskRecord> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    let template = this.createTemplate(cfg, request.template, request.noRoom);
    if (request.noRoom && request.anonymous !== undefined)
      throw new ConfigError('--anonymous/--no-anonymous cannot be combined with --no-room');
    const roomPolicy = resolveRoomLaunchPolicy(template, request.anonymous);
    let launchDefinitions: Record<string, import('../config.js').AgentTemplateDefinition> | undefined;
    let executionPlan: TaskRecord['execution_plan'];
    let preparedPlan: ReturnType<typeof prepareExecutionPlan> | undefined;
    if (template) {
      const definition = resolveTemplate(template.name, cfg.roomTemplates ?? {})!;
      preparedPlan = prepareExecutionPlan(definition, cfg, request.members ?? {});
      launchDefinitions = preparedPlan.launchDefinitions;
    }
    const brief = request.briefFile ? readFileSync(request.briefFile, 'utf8') : request.brief;
    const unlock = preparedPlan ? acquireLaunchSnapshotLock() : undefined;
    let sealedHash: string | undefined;
    let task: TaskRecord;
    try {
      if (preparedPlan) {
        template = sealTemplateSnapshot(preparedPlan.snapshot, cfg.agentTemplates ?? {}, preparedPlan.launchDefinitions);
        sealedHash = template.launch_snapshot_hash;
        executionPlan = { schema_version: 1, snapshot: template, room_policy: roomPolicy,
          overrides: preparedPlan.overrides,
          overrides_hash: preparedPlan.overridesHash,
          plan_hash: preparedPlan.planHash };
      }
      const ref = template && { name: template.name, version: template.version, content_hash: template.content_hash };
      task = await withTaskListsLock(() => {
        const list = resolveTaskList(request.list ?? 'default');
        return persistTask({
          title: request.title, brief, brief_file: request.briefFile, template: ref,
          execution_plan: executionPlan,
          origin: request.origin, idempotency_key: request.idempotencyKey,
          start: !request.backlog, no_room: request.noRoom, listId: list.list_id,
        });
      });
    } catch (error) {
      unlock?.();
      if (sealedHash) releaseLaunchSnapshot(sealedHash);
      throw error;
    }
    unlock?.();
    const ref = template && { name: template.name, version: template.version, content_hash: template.content_hash };
    // A create-and-start launch is represented to the Owner solely by the
    // canonical Room created/ready events. Backlog and no-room tasks retain
    // their useful Task lifecycle notice.
    if (request.backlog || request.noRoom) recordFleetAuditPresentation({ kind: 'task', operation: 'create', id: task.task_id,
      title: task.title, previousState: 'none', newState: task.state, revision: task.created_at,
      list: task.list_name ?? 'default', roomId: task.room_id,
      template: task.template ? `${task.template.name}@${task.template.version}` : undefined,
      agents: [] });
    if (!request.backlog && !request.noRoom && ref && !task.room_id) {
      try {
        const room = await this.provisionRoom(cfg, task, template!, created => {
          task = updateTaskRoom(task.task_id, created.room_id, created.room_identity_cid!);
        }, launchDefinitions, roomPolicy);
        task = readTask(task.task_id);
        void room;
      } catch (error) {
        if (error instanceof CoworkUnavailableError)
          persistBlockTask(task.task_id, 'Cowork management socket is unavailable');
        // Once the durable Room exists, provisioning errors are resumable
        // saga state. Return that explicit state so the command can launch a
        // continuation and give the caller a stable await handle.
        const current = readTask(task.task_id);
        if (!current.room_id || !getRoomRecord(current.room_id)) throw error;
        task = current;
      }
    }
    return task;
  }

  async createRoom(request: CreateRoomRequest): Promise<RoomOrchestrationRecord> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const brief = request.briefFile ? readFileSync(request.briefFile, 'utf8') : request.brief;
    let template: TemplateSnapshot | undefined;
    if (request.template) {
      const definition = resolveTemplate(request.template, cfg.roomTemplates ?? {});
      if (!definition) throw new TaskRoomApplicationError(
        'template_not_found', `template not found: ${request.template}`, { template: request.template });
      if (request.members && Object.keys(request.members).length) {
        const prepared = prepareExecutionPlan(definition, cfg, request.members);
        template = prepared.snapshot;
        const roomPolicy = resolveRoomLaunchPolicy(template, request.anonymous);
        return this.provisionRoom(cfg, { title: request.name, brief, goal: request.goal },
          template, () => {}, prepared.launchDefinitions, roomPolicy);
      }
      template = snapshotTemplate(definition, cfg.agentTemplates);
    }
    const roomPolicy = resolveRoomLaunchPolicy(template, request.anonymous);
    return this.provisionRoom(cfg, {
      title: request.name, brief, goal: request.goal,
    }, template, () => {}, undefined, roomPolicy);
  }

  async startTask(input: {
    actor: TaskRoomActor; taskId: string; template?: string; members?: MemberOverrides; anonymous?: boolean;
  }): Promise<TaskRecord> {
    return (await this.ensureTaskWork(input)).task;
  }

  listTasks(filter?: {
    state?: TaskState | TaskState[]; list?: string; includeDeleting?: boolean;
  }): TaskRecord[] {
    const listId = filter?.list === undefined ? undefined : resolveTaskList(filter.list).list_id;
    return readTasks({ state: filter?.state, listId, includeDeleting: filter?.includeDeleting });
  }

  listTaskLists(): TaskListRecord[] { return readTaskLists(); }

  groupedTasks(filter?: {
    state?: TaskState | TaskState[]; list?: string; includeDeleting?: boolean;
  }): Array<{
    list: TaskListRecord; tasks: TaskRecord[];
  }> {
    const tasks = this.listTasks(filter);
    const lists = filter?.list ? [resolveTaskList(filter.list)] : readTaskLists();
    return lists.map(list => ({ list, tasks: tasks.filter(task => task.list_id === list.list_id) }));
  }

  async createTaskList(input: { actor: TaskRoomActor; name: string }): Promise<TaskListRecord> {
    return withTaskListsLock(() => createTaskListLocked(input.name));
  }

  async renameTaskList(input: {
    actor: TaskRoomActor; name: string; newName: string;
  }): Promise<TaskListRecord> {
    return withTaskListsLock(() => renameTaskListLocked(input.name, input.newName));
  }

  async moveTask(input: {
    actor: TaskRoomActor; taskId: string; list: string;
  }): Promise<TaskRecord> {
    return withTaskListsLock(() => {
      const destination = resolveTaskList(input.list);
      return (this.deps.moveTaskToList ?? moveTaskToList)(input.taskId, destination.list_id);
    });
  }

  async deleteTaskList(input: {
    actor: TaskRoomActor; name: string; destination?: string;
  }): Promise<{ deleted: TaskListRecord; moved: number; destination?: TaskListRecord }> {
    return withTaskListsLock(() => {
      const source = resolveTaskList(input.name);
      if (source.list_id === DEFAULT_TASK_LIST_ID)
        throw new TaskListError('default_immutable', "the 'default' list cannot be deleted");
      const assigned = readTasks({ listId: source.list_id });
      let destination: TaskListRecord | undefined;
      if (assigned.length) {
        if (!input.destination)
          throw new TaskListError('destination_required', `task list '${source.name}' is not empty; destination is required`);
        destination = resolveTaskList(input.destination);
        if (destination.list_id === source.list_id)
          throw new TaskListError('same_destination', 'deletion destination must differ from the source list');
        for (const task of assigned)
          (this.deps.moveTaskToList ?? moveTaskToList)(task.task_id, destination.list_id);
      }
      deleteTaskListRecordLocked(source.list_id);
      return { deleted: source, moved: assigned.length, destination };
    });
  }

  getTask(taskId: string): {
    task: TaskRecord; orchestration: RoomOrchestrationRecord | undefined;
  } {
    const task = readTask(taskId);
    return { task, orchestration: task.room_id ? getRoomRecord(task.room_id) : undefined };
  }

  taskProvisioningOutcome(taskId: string): TaskProvisioningOutcome {
    const task = readTask(taskId);
    const room = task.room_id ? getRoomRecord(task.room_id) : undefined;
    const expected = room?.template_snapshot?.members.reduce((sum, member) => sum + member.count, 0)
      ?? task.execution_plan?.snapshot.members.reduce((sum, member) => sum + member.count, 0) ?? 0;
    const active = room?.member_seats.filter(seat => seat.seat_state === 'active').length ?? 0;
    const launched = room?.member_seats.filter(seat => seat.launch?.state === 'launched').length ?? 0;
    const failed = task.state === 'failed' || room?.saga.phase === 'failed';
    const ready = task.state === 'active' && room?.state === 'active'
      && active === expected && launched === expected;
    const blocker = task.outcome?.summary ?? task.blocked?.reason ?? room?.saga.error;
    const nextAction = room?.provisioning_detail === 'waiting_owner_invite'
      ? 'Rotate rooms.owner.public_invite, then await the same task.'
      : room?.provisioning_detail === 'owner_cid_mismatch'
        ? 'Verify rooms.owner.expected_cid, rotate the Owner invite, then await the same task.'
        : room?.provisioning_detail === 'waiting_cowork'
          ? 'Restore ours-cowork, then await the same task.'
          : failed
            ? `Correct the blocker, then run ours-fleet task recover ${task.task_id}.`
            : undefined;
    return {
      kind: failed ? 'failed' : ready ? 'ready' : 'in_progress', task, room,
      handle: { command: `ours-fleet task await ${task.task_id}`, task_id: task.task_id },
      launch: {
        ...(room?.template_snapshot
          ? { template: `${room.template_snapshot.name}@${room.template_snapshot.version}` }
          : task.template ? { template: `${task.template.name}@${task.template.version}` } : {}),
        anonymous: storedRoomLaunchPolicy(room?.room_policy ?? task.execution_plan?.room_policy).anonymous,
        owner_attached: Boolean(room?.owner_seat_cid),
      },
      members: { expected, active, launched },
      ...(blocker ? { blocker } : {}),
      ...(nextAction ? { next_action: nextAction } : {}),
    };
  }

  async awaitTaskProvisioning(input: {
    actor: TaskRoomActor; taskId: string; waitMs?: number;
  }): Promise<TaskProvisioningOutcome> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = now() + (input.waitMs ?? 60_000);
    for (;;) {
      const outcome = this.taskProvisioningOutcome(input.taskId);
      if (outcome.kind !== 'in_progress' || now() >= deadline) {
        recordTaskProvisioningOutcome(outcome);
        return outcome;
      }
      await sleep(100);
    }
  }

  blockTask(input: { actor: TaskRoomActor; taskId: string; reason: string }): TaskRecord {
    return persistBlockTask(input.taskId, input.reason);
  }

  unblockTask(input: { actor: TaskRoomActor; taskId: string }): TaskRecord {
    return persistUnblockTask(input.taskId);
  }

  reviewTask(input: { actor: TaskRoomActor; taskId: string }): TaskRecord {
    return persistReviewTask(input.taskId);
  }

  private deletionActor(actor: TaskRoomActor): TaskDeletionActor {
    if (actor.kind === 'local_control') return { kind: 'local_control', surface: actor.surface };
    if (actor.kind === 'authenticated_owner')
      return { kind: 'authenticated_owner', surface: 'messenger', cid: actor.cid };
    throw new Error('internal workers cannot originate a task deletion acceptance');
  }

  /** Accept a permanent deletion in any lifecycle state; audit at acceptance. */
  async requestTaskDeletion(input: {
    actor: TaskRoomActor; taskId: string;
  }): Promise<TaskDeletionAcceptance> {
    const result = await acceptTaskDeletion(input.taskId, this.deletionActor(input.actor));
    if (result.status === 'accepted') {
      const task = result.task;
      recordFleetAuditPresentation({ kind: 'task', operation: 'delete', id: task.task_id,
        title: task.title, previousState: task.state, newState: 'deleting',
        revision: task.deletion?.accepted_at ?? task.created_at, list: task.list_name ?? 'default',
        roomId: task.room_id,
        template: task.template ? `${task.template.name}@${task.template.version}` : undefined,
        agents: [] });
    }
    return result;
  }

  /** Worker entry: converge an accepted deletion; Cowork is resolved lazily. */
  async settleTaskDeletion(input: {
    actor: { kind: 'internal_worker'; surface: 'cli' }; taskId: string;
  }): Promise<TaskDeletionSettleResult> {
    const result = await settleTaskDeletion({
      taskId: input.taskId,
      cowork: () => {
        // Config resolves only when room work exists: a no-room deletion must
        // settle even with missing or invalid rooms configuration.
        const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
        if (!cfg.rooms)
          throw new ConfigError('rooms: configuration is required before deleting task rooms');
        return this.deps.cowork ? this.deps.cowork(cfg)
          : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
      },
    });
    if (result.deleted && result.previous_state) {
      recordFleetAuditPresentation({ kind: 'task', operation: 'delete', id: result.task_id,
        title: result.title, previousState: result.previous_state, newState: 'deleted',
        revision: new Date().toISOString(), list: 'default', roomId: undefined,
        template: undefined, agents: [] });
    }
    return result;
  }

  /**
   * Launch the external deletion worker outside the caller's lifecycle and
   * wait boundedly for physical absence. Timeouts and launch failures report
   * a pending, recoverable state — never success. A concurrent worker that
   * already removed the record reads as settled.
   */
  async launchTaskDeletionWorker(input: {
    taskId: string; waitMs?: number;
  }): Promise<{ deleted: boolean; pending: boolean; error?: string }> {
    const launch = this.deps.launchDeletionWorker
      ?? ((taskId: string) => launchFleetWorker(
        ['task', '_settle_delete', taskId], `task-delete-${taskId}`, this.configurationPath));
    const errorAtBefore = (() => {
      try { return getDeletingTask(input.taskId).deletion?.error_at; } catch { return undefined; }
    })();
    try { await launch(input.taskId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordTaskDeletionError(input.taskId, message,
        `External delete worker failed to start. Repeat the delete request for ${input.taskId}.`,
      ).catch(() => {});
      return { deleted: false, pending: true, error: message };
    }
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep
      ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
    const deadline = now() + (input.waitMs ?? 10_000);
    while (now() < deadline) {
      if (taskDeletionState(input.taskId) === 'absent') return { deleted: true, pending: false };
      try {
        const current = getDeletingTask(input.taskId).deletion;
        if (current?.error_at !== errorAtBefore && current?.error)
          return { deleted: false, pending: true, error: current.error };
      } catch { /* re-checked as absence on the next iteration */ }
      await sleep(100);
    }
    return { deleted: false, pending: true };
  }

  recordDeletionError(input: {
    actor: TaskRoomActor; taskId: string; error: string; recoveryHint: string;
  }): Promise<TaskRecord> {
    return recordTaskDeletionError(input.taskId, input.error, input.recoveryHint);
  }

  async completeTask(input: {
    actor: TaskRoomActor; taskId: string; outcome?: TaskOutcome;
  }): Promise<TaskSettlementPlan> {
    const task = readTask(input.taskId);
    if (TASK_TERMINAL_STATES.includes(task.state))
      throw new TaskStateError(`task ${input.taskId} is already in terminal state '${task.state}'`);
    if (task.state !== 'review')
      throw new TaskStateError(`cannot transition from '${task.state}' to 'done'`);
    let roomId: string | undefined;
    if (task.room_id) {
      const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
      const shouldClose = cfg.tasks?.close_room_on_done
        ?? cfg.rooms?.defaults?.close_when_task_done ?? false;
      if (shouldClose) roomId = task.room_id;
    }
    return this.acceptTerminal(input.taskId, 'done', roomId, input.outcome);
  }

  async cancelTask(input: {
    actor: TaskRoomActor; taskId: string;
  }): Promise<TaskSettlementPlan> {
    const task = readTask(input.taskId);
    if (!TASK_CANCELLABLE_STATES.includes(task.state))
      throw new TaskStateError(`cannot cancel a '${task.state}' task`);
    if (task.room_id)
      (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    return this.acceptTerminal(input.taskId, 'cancelled', task.room_id);
  }

  async settleTask(input: {
    actor: { kind: 'internal_worker'; surface: 'cli' }; taskId: string;
  }): Promise<TaskRecord> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    if (!cfg.rooms)
      throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    const cowork = this.deps.cowork ? this.deps.cowork(cfg) : createCoworkAdapter({
      configPath: cfg.rooms.cowork?.config,
    });
    return settleTaskTerminalIntent({ taskId: input.taskId, cowork });
  }

  recordSettlementError(input: {
    actor: TaskRoomActor; taskId: string; error: string; recoveryHint: string;
  }): Promise<TaskRecord> {
    return recordTaskTerminalIntentError(input.taskId, input.error, input.recoveryHint);
  }

  async beginTaskRecovery(input: { actor: TaskRoomActor; taskId: string }): Promise<TaskRecoveryBegin> {
    // The deletion-vs-terminal routing decision serializes on the common
    // task-operation lock and must not require configuration: recovery of a
    // deletion-pending task continues the deletion and never resurrects.
    const routed = await withFileLock(
      taskOperationLockPath(input.taskId),
      () => {
        const task = readTask(input.taskId);
        if (task.deletion?.status === 'pending') return 'deletion' as const;
        if (task.terminal_intent?.status === 'pending') return 'terminal' as const;
        return 'none' as const;
      },
      {},
      TASK_OPERATION_LOCK_STALE_MS,
    );
    if (routed === 'deletion') return { kind: 'deletion_worker_required', taskId: input.taskId };
    const config = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    this.recovery = { taskId: input.taskId, config };
    if (routed === 'terminal')
      return { kind: 'terminal_worker_required', taskId: input.taskId };
    return { kind: 'final', result: await this.continueTaskRecovery({
      actor: input.actor, taskId: input.taskId, terminalTimedOut: false,
    }) };
  }

  async continueTaskRecovery(input: {
    actor: TaskRoomActor; taskId: string; terminalTimedOut: boolean;
  }): Promise<TaskRecoveryResult> {
    if (!this.recovery || this.recovery.taskId !== input.taskId)
      throw new Error('task recovery continuation requires a matching begin');
    const recovery = this.recovery;
    this.recovery = undefined;
    const cfg = recovery.config;
    let task = readTask(input.taskId);
    let room = task.room_id ? getRoomRecord(task.room_id) : undefined;
    const issues: TaskRecoveryIssue[] = input.terminalTimedOut ? [{ code: 'terminal_pending' }] : [];
    if (task.state !== 'provisioning') return {
      kind: TASK_TERMINAL_STATES.includes(task.state) ? 'terminal' : 'no_op', task, room, issues,
    };
    if (!room) {
      if (!task.template) return {
        kind: 'provisioning_non_resumable', task, room, issues, reason: 'missing_room',
      };
      try {
        const template = task.execution_plan?.snapshot ?? this.existingTemplate(cfg, task);
        const roomPolicy = task.execution_plan
          ? storedRoomLaunchPolicy(task.execution_plan.room_policy)
          : resolveRoomLaunchPolicy(template, undefined);
        await this.provisionRoom(cfg, task, template, created => {
          task = updateTaskRoom(task.task_id, created.room_id, created.room_identity_cid!);
        }, undefined, roomPolicy);
        task = readTask(task.task_id);
        room = task.room_id ? getRoomRecord(task.room_id) : undefined;
        return { kind: 'provisioning_resumed', task, room, issues: [{ code: 'provisioning_resumed' }] };
      } catch (error) {
        issues.push({ code: 'resume_failed', error: error instanceof Error ? error.message : String(error) });
        return { kind: 'provisioning_resume_failed', task, room, issues };
      }
    }
    if (room.provisioning_detail === 'waiting_owner_invite'
        || room.provisioning_detail === 'owner_cid_mismatch') {
      try {
        await this.recoverRoom({ actor: input.actor, roomId: room.room_id });
        task = readTask(task.task_id);
        room = getRoomRecord(room.room_id);
        if (task.state === 'active' && room?.state === 'active') return {
          kind: 'provisioning_resumed', task, room, issues: [{ code: 'provisioning_resumed' }],
        };
      } catch (error) {
        issues.push({ code: 'resume_failed', error: error instanceof Error ? error.message : String(error) });
        return { kind: 'provisioning_resume_failed', task, room, issues };
      }
    }
    if (!room) return {
      kind: 'provisioning_non_resumable', task, room, issues, reason: 'missing_room',
    };
    if (room.provisioning_detail === 'waiting_cowork') issues.push({ code: 'waiting_cowork' });
    if (room.provisioning_detail === 'waiting_owner_invite') issues.push({ code: 'waiting_owner_invite' });
    if (room.provisioning_detail === 'owner_cid_mismatch') issues.push({ code: 'owner_cid_mismatch' });
    if (room.provisioning_detail === 'member_failed') issues.push({ code: 'member_failed', stepIndex: room.saga.step_index });
    if (room.provisioning_detail === 'waiting_seats') issues.push({ code: 'waiting_seats' });
    const resumable = ['create_members', 'join_role_groups', 'wait_seats', 'launch_work', 'activate'];
    if (!resumable.includes(room.saga.phase)) return {
      kind: 'provisioning_non_resumable', task, room, issues, reason: 'non_resumable_phase',
    };
    const template = room.template_snapshot;
    if (!template) throw new Error(`room ${room.room_id} has no durable template snapshot`);
    if (!task.template || task.template.name !== template.name
        || task.template.version !== template.version || task.template.content_hash !== template.content_hash)
      throw new Error(`task ${task.task_id} template reference does not match room ${room.room_id}'s durable snapshot`);
    try {
      if (!cfg.rooms)
        throw new ConfigError('rooms: configuration is required before creating or querying rooms');
      const cowork = this.deps.cowork ? this.deps.cowork(cfg) : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
      await (this.deps.provisionMembers ?? provisionMembers)({
        cfg, cowork, roomId: room.room_id, taskId: task.task_id, template,
        binPath: (this.deps.binPath ?? getBinPath)(), brief: task.brief, goal: task.title,
      });
      task = readTask(task.task_id); room = getRoomRecord(room.room_id);
      return { kind: 'provisioning_resumed', task, room, issues: [{ code: 'provisioning_resumed' }] };
    } catch (error) {
      issues.push({ code: 'resume_failed', error: error instanceof Error ? error.message : String(error) });
      return { kind: 'provisioning_resume_failed', task, room, issues };
    }
  }

  private async acceptTerminal(
    taskId: string, kind: 'done' | 'cancelled', roomId?: string, outcome?: TaskOutcome,
  ): Promise<TaskSettlementPlan> {
    const task = await acceptTaskTerminalIntent({ taskId, kind, roomId, outcome });
    return { task, settlementRequired: task.terminal_intent?.status === 'pending' && !!roomId };
  }

  listTemplates() {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    return listTemplates(cfg.roomTemplates ?? {});
  }

  getTemplate(name: string) {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const template = resolveTemplate(name, cfg.roomTemplates ?? {});
    if (!template) throw new TaskRoomApplicationError('template_not_found', 'template not found', { template: name });
    return { ...template, content_hash: hashTemplate(template) };
  }

  validateTemplates(): { template: string; issues: string[] }[] {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    return listTemplates(cfg.roomTemplates ?? {}).flatMap(template => {
      const issues = template.members.flatMap(member => {
        const ref = member.agent_template;
        return cfg.agentTemplates?.[ref]
          ? [] : [`member ${member.slot}: Agent Template '${ref}' not found`];
      });
      return issues.length ? [{ template: `${template.name}@${template.version}`, issues }] : [];
    });
  }

  async listRooms(filter?: { state?: 'active' | 'provisioning' }) {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    if (!cfg.rooms) throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    const cowork = this.deps.cowork ? this.deps.cowork(cfg) : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    await deleteLegacyClosedRooms({ cowork });
    const local = new Map(listRoomRecords().map(room => [room.room_id, room]));
    return (await cowork.listRooms()).filter(room => room.state === 'active' || room.state === 'provisioning')
      .filter(room => { const tracked = local.get(room.room_id);
        return !tracked || tracked.state === 'active' || tracked.state === 'provisioning'; })
      .filter(room => !filter?.state || room.state === filter.state)
      .map(room => ({ ...room, orchestration: local.get(room.room_id) ?? null }));
  }

  async getRoomDetail(id: string) {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const orchestration = getRoomRecord(id);
    if (orchestration?.state === 'closing' || orchestration?.state === 'closed')
      throw new TaskRoomApplicationError('room_not_found', 'room not found', { room: id });
    if (!cfg.rooms) throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    const adapter = this.deps.cowork ? this.deps.cowork(cfg) : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    const room = await adapter.getRoom(id);
    if (!room || room.state === 'closing' || room.state === 'closed')
      throw new TaskRoomApplicationError('room_not_found', 'room not found', { room: id });
    return { room, orchestration };
  }

  async getRoomMembers(id: string) {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const orchestration = getRoomRecord(id);
    if (orchestration?.state === 'closing' || orchestration?.state === 'closed')
      throw new TaskRoomApplicationError('room_not_found', 'room not found', { room: id });
    if (!cfg.rooms) throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    const adapter = this.deps.cowork ? this.deps.cowork(cfg) : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    const room = await adapter.getRoom(id);
    if (!room || room.state === 'closing' || room.state === 'closed')
      throw new TaskRoomApplicationError('room_not_found', 'room not found', { room: id });
    return { room, orchestration, members: await adapter.getSeats(id) };
  }

  async requestRoomDeletion(input: { actor: TaskRoomActor; roomId: string }) {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    if (!cfg.rooms) throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    if (this.deps.cowork) this.deps.cowork(cfg);
    else createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    const room = getRoomRecord(input.roomId);
    if (!room) {
      throw new TaskRoomApplicationError(
        'room_record_not_found', 'room record not found', { room: input.roomId },
      );
    }
    return { room: await acceptManagedRoomClose(input.roomId), settlementRequired: true as const };
  }

  async settleRoomDeletion(input: {
    actor: { kind: 'internal_worker'; surface: 'cli' }; roomId: string;
  }) {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    if (!cfg.rooms) throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    const cowork = this.deps.cowork ? this.deps.cowork(cfg)
      : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    return deleteManagedRoom({ roomId: input.roomId, cowork });
  }

  recordRoomSettlementError(input: {
    actor: TaskRoomActor; roomId: string; error: string; recoveryHint: string;
  }) {
    return recordManagedRoomCloseError(input.roomId, input.error, input.recoveryHint);
  }

  async finishTask(input: {
    actor: TaskRoomActor; taskId: string; outcome?: TaskOutcome;
  }): Promise<TaskSettlementPlan> {
    let task = readTask(input.taskId);
    if (TASK_TERMINAL_STATES.includes(task.state)) throw new TaskRoomApplicationError(
      'task_terminal_already', 'task already terminal', { task: input.taskId, state: task.state });
    if (task.state === 'active') task = persistReviewTask(task.task_id);
    if (task.room_id) (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    return this.acceptTerminal(task.task_id, 'done', task.room_id, input.outcome);
  }

  async ensureTaskWork(input: {
    actor: TaskRoomActor; taskId: string; template?: string; members?: MemberOverrides; anonymous?: boolean;
  }): Promise<{ task: TaskRecord; status: 'ready' | 'already_active' | 'in_progress' }> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    let task = readTask(input.taskId);
    const recordedRoom = task.room_id ? getRoomRecord(task.room_id) : undefined;
    const recordedPolicy = storedRoomLaunchPolicy(
      recordedRoom?.room_policy ?? task.execution_plan?.room_policy);
    if (task.room_id && input.anonymous !== undefined && input.anonymous !== recordedPolicy.anonymous)
      throw new TaskRoomApplicationError('template_mismatch',
        'anonymous override does not match the existing Room launch policy', { room: task.room_id });
    if (TASK_TERMINAL_STATES.includes(task.state)) throw new TaskRoomApplicationError(
      'task_terminal', 'task terminal', { task: input.taskId, state: task.state });
    const durableTemplate = task.room_id
      ? getRoomRecord(task.room_id)?.template_snapshot ?? task.execution_plan?.snapshot
      : task.execution_plan?.snapshot;
    const templateRequestMatches = !input.template || (durableTemplate !== undefined
      && (input.template === durableTemplate.name
        || input.template === `${durableTemplate.name}@${durableTemplate.version}`));
    const memberRequestMatches = input.members === undefined || (task.execution_plan !== undefined
      && task.execution_plan.overrides_hash === hashMemberOverrides(input.members));
    const durableRequestMatches = durableTemplate !== undefined
      && templateRequestMatches && memberRequestMatches;
    if (task.state === 'active' && task.room_id) {
      if (input.template || input.members) {
        const pinned = durableTemplate;
        if (!pinned) throw new TaskRoomApplicationError('template_mismatch',
          'active task has no durable execution plan', { room: task.room_id });
        if (durableRequestMatches) return { task, status: 'already_active' };
        const templateName = input.template ?? pinned.name;
        const definition = resolveTemplate(templateName, cfg.roomTemplates ?? {});
        if (!definition) throw new TaskRoomApplicationError('template_not_found',
          'template not found', { template: templateName });
        const requested = prepareExecutionPlan(definition, cfg, input.members ?? {});
        const pinnedPlanHash = task.execution_plan?.plan_hash ?? pinned.content_hash;
        if (pinned.name !== requested.snapshot.name || pinnedPlanHash !== requested.planHash)
          throw new TaskRoomApplicationError('template_mismatch', 'template mismatch', {
            requested: `${requested.snapshot.name}@${requested.snapshot.version}`, room: task.room_id,
            provisioned: `${pinned.name}@${pinned.version}` });
      }
      return { task, status: 'already_active' };
    }
    const room = task.room_id ? getRoomRecord(task.room_id) : undefined;
    const durable = room?.template_snapshot ?? task.execution_plan?.snapshot;
    if (durable && (!task.template || task.template.name !== durable.name
      || task.template.version !== durable.version || task.template.content_hash !== durable.content_hash))
      throw new Error(`task ${task.task_id} template reference does not match its durable execution snapshot`);
    const templateName = input.template ?? durable?.name ?? task.template?.name
      ?? cfg.tasks?.default_room_template ?? cfg.rooms?.defaults?.template ?? 'single';
    const storedOverridesMatch = !!(durable && memberRequestMatches);
    const definition = durable && durableRequestMatches ? undefined
      : resolveTemplate(templateName, cfg.roomTemplates ?? {});
    if (input.template && !definition && !durableRequestMatches) throw new TaskRoomApplicationError(
      'template_not_found', 'template not found', { template: templateName });
    if (!durable && !definition) throw new TaskRoomApplicationError(
      'template_not_found', 'template not found', { template: templateName });
    let launchDefinitions: Record<string, import('../config.js').AgentTemplateDefinition> | undefined;
    let preparedPlan = !durable && definition
      ? prepareExecutionPlan(definition, cfg, input.members ?? {}) : undefined;
    let snapshot = durable ?? preparedPlan!.snapshot;
    const roomPolicy = input.anonymous !== undefined
      ? resolveRoomLaunchPolicy(snapshot, input.anonymous)
      : task.execution_plan
        ? storedRoomLaunchPolicy(task.execution_plan.room_policy)
        : resolveRoomLaunchPolicy(snapshot, undefined);
    if (preparedPlan) launchDefinitions = preparedPlan.launchDefinitions;
    if (input.members && Object.keys(input.members).length && !storedOverridesMatch) {
      if (!definition) throw new TaskRoomApplicationError('template_mismatch',
        'member overrides cannot change an existing Room execution plan');
      const prepared = preparedPlan ?? prepareExecutionPlan(definition, cfg, input.members);
      preparedPlan = prepared;
      if (durable && prepared.planHash !== durable.content_hash) throw new TaskRoomApplicationError(
        'template_mismatch', 'member overrides do not match existing execution plan');
      snapshot = prepared.snapshot;
      launchDefinitions = prepared.launchDefinitions;
    }
    if (durable && input.template && definition) {
      const requested = snapshotTemplate(definition, cfg.agentTemplates);
      if (requested.name !== durable.name || requested.content_hash !== durable.content_hash)
        throw new TaskRoomApplicationError('template_mismatch', 'template mismatch', {
          requested: `${requested.name}@${requested.version}`, room: room!.room_id,
          provisioned: `${durable.name}@${durable.version}` });
    }
    if (!input.template && task.template && snapshot.content_hash !== task.template.content_hash) {
      // Pre-execution-plan backlog records used the template-only hash. Accept
      // that exact legacy pin once, then upgrade it to the complete sealed plan.
      const legacyHash = definition
        ? snapshotTemplate(definition, cfg.agentTemplates).content_hash : undefined;
      if (task.template.content_hash !== legacyHash)
        throw new TaskRoomApplicationError('task_template_drift', 'task template drift', {
          template: `${task.template.name}@${task.template.version}` });
    }
    if (task.room_id && room?.template_snapshot
      && (room.template_snapshot.name !== snapshot.name || room.template_snapshot.content_hash !== snapshot.content_hash))
      throw new TaskRoomApplicationError('template_mismatch', 'template mismatch', {
        requested: `${snapshot.name}@${snapshot.version}`, room: task.room_id,
        provisioned: `${room.template_snapshot.name}@${room.template_snapshot.version}` });
    if (preparedPlan && !task.room_id) {
      const unlock = acquireLaunchSnapshotLock();
      let sealed: TemplateSnapshot | undefined;
      try {
        sealed = sealTemplateSnapshot(snapshot, cfg.agentTemplates ?? {}, launchDefinitions);
        task = updateTaskExecutionPlan(task.task_id, { schema_version: 1, snapshot: sealed,
          room_policy: roomPolicy,
          overrides: preparedPlan.overrides, overrides_hash: preparedPlan.overridesHash,
          plan_hash: preparedPlan.planHash });
        snapshot = sealed;
      } catch (error) {
        unlock();
        if (sealed?.launch_snapshot_hash) releaseLaunchSnapshot(sealed.launch_snapshot_hash);
        throw error;
      }
      unlock();
    } else if (!task.room_id && task.execution_plan && input.anonymous !== undefined) {
      task = updateTaskExecutionPlan(task.task_id, { ...task.execution_plan, room_policy: roomPolicy });
    } else if (!task.template || task.template.name !== snapshot.name || task.template.content_hash !== snapshot.content_hash)
      task = updateTaskTemplate(task.task_id, { name: snapshot.name, version: snapshot.version, content_hash: snapshot.content_hash });
    if (task.state === 'backlog') {
      task = transitionTask(task.task_id);
    }
    if (!task.room_id) {
      try {
        await this.provisionRoom(cfg, task, snapshot, created => {
          task = updateTaskRoom(task.task_id, created.room_id, created.room_identity_cid!);
        }, launchDefinitions, roomPolicy);
        task = readTask(task.task_id);
      } catch (error) {
        if (error instanceof CoworkUnavailableError)
          persistBlockTask(task.task_id, 'Cowork management socket is unavailable');
        const current = readTask(task.task_id);
        if (!current.room_id || !getRoomRecord(current.room_id)) throw error;
        task = current;
      }
    } else if (task.state === 'provisioning') {
      if (!room || !['create_members','join_role_groups','wait_seats','launch_work','activate'].includes(room.saga.phase))
        throw new TaskRoomApplicationError('task_non_resumable', 'task non-resumable', { task: task.task_id, room: task.room_id });
      try {
        if (!cfg.rooms)
          throw new ConfigError('rooms: configuration is required before creating or querying rooms');
        const cowork = this.deps.cowork ? this.deps.cowork(cfg) : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
        await (this.deps.provisionMembers ?? provisionMembers)({ cfg, cowork, roomId: room.room_id,
          taskId: task.task_id, template: snapshot, binPath: (this.deps.binPath ?? getBinPath)(),
          brief: task.brief, goal: task.title });
        task = readTask(task.task_id);
      } catch (error) {
        if (error instanceof CoworkUnavailableError) persistBlockTask(task.task_id, 'Cowork management socket is unavailable');
        task = readTask(task.task_id);
      }
    }
    const resultingRoom = getRoomRecord(task.room_id!);
    return { task, status: task.state === 'active' && resultingRoom?.state === 'active' ? 'ready' : 'in_progress' };
  }

  private createTemplate(
    cfg: FleetConfig, requested: string | undefined, noRoom: boolean | undefined,
  ): TemplateSnapshot | undefined {
    if (noRoom) return undefined;
    const name = requested
      ?? cfg.tasks?.default_room_template ?? cfg.rooms?.defaults?.template ?? 'team';
    const definition = resolveTemplate(name, cfg.roomTemplates ?? {});
    if (!definition) {
      if (requested) throw new TaskRoomApplicationError(
        'template_not_found', `template not found: ${requested}`,
      );
      return undefined;
    }
  return snapshotTemplate(definition, cfg.agentTemplates);
  }

  private existingTemplate(cfg: FleetConfig, task: TaskRecord): TemplateSnapshot {
    const ref = task.template!;
    const definition = resolveTemplate(ref.name, cfg.roomTemplates ?? {});
  const snapshot = definition ? snapshotTemplate(definition, cfg.agentTemplates) : undefined;
    if (!snapshot || snapshot.content_hash !== ref.content_hash)
      throw new TaskRoomApplicationError(
        'task_template_drift', `task template snapshot no longer matches ${ref.name}@${ref.version}`,
      );
    return snapshot;
  }

  private async provisionRoom(
    cfg: FleetConfig,
    task: Pick<TaskRecord, 'title' | 'brief'> & { task_id?: string; goal?: string },
    template: TemplateSnapshot | undefined,
    onCreated: (room: RoomOrchestrationRecord) => void,
    launchDefinitions?: Record<string, import('../config.js').AgentTemplateDefinition>,
    policy: RoomLaunchPolicy = resolveRoomLaunchPolicy(template, undefined),
  ): Promise<RoomOrchestrationRecord> {
    const rooms = cfg.rooms;
    if (!rooms) throw new ConfigError('rooms: configuration is required');
    const attachOwner = rooms.defaults?.attach_owner !== false;
    if (attachOwner && !cfg.ownerInvite)
      throw new ConfigError('rooms.owner: public_invite or public_invite_file is required when attach_owner is enabled');
    const cowork = this.deps.cowork ? this.deps.cowork(cfg) : (() => {
      if (!cfg.rooms)
        throw new ConfigError('rooms: configuration is required before creating or querying rooms');
      return createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    })();
    const roomName = task.task_id ? deriveTaskRoomName(task.title, task.task_id) : task.title;
    const unlockSnapshot = template ? acquireLaunchSnapshotLock() : undefined;
    let launchTemplate: TemplateSnapshot | undefined;
    let room: RoomOrchestrationRecord;
    try {
      launchTemplate = template ? (template.launch_snapshot_hash ? template
        : sealTemplateSnapshot(template, cfg.agentTemplates ?? {}, launchDefinitions)) : undefined;
      // Room publication window: for a task-bound room, hold the common
      // task-operation lock across remote creation, local record creation, and
      // the task link, so an accepted deletion linearizes strictly before
      // (bounded task_deleting abort) or strictly after (record visible to the
      // deletion scan). Lock order stays launch-snapshot → task-operation.
      const publishRoom = async (): Promise<RoomOrchestrationRecord> => {
        if (task.task_id) {
          const fresh = readTask(task.task_id);
          if (fresh.deletion?.status === 'pending')
            throw new TaskRoomApplicationError('task_deleting',
              `task ${task.task_id} is pending deletion`, { task: task.task_id });
        }
        const created = await cowork.createRoom({
          room_name: roomName, goal: task.goal?.trim() || task.title,
          briefing: task.brief?.trim() || launchTemplate?.contract?.trim() || task.goal?.trim() || task.title,
          quiet_membership: launchTemplate?.room?.quiet_membership,
          anonymous: policy.anonymous,
        });
        const record = createRoomRecord({
          room_id: created.room_id, room_name: roomName, room_identity_cid: created.identity_cid,
          task_id: task.task_id, template_snapshot: launchTemplate, room_policy: policy,
        });
        onCreated(record);
        return record;
      };
      room = task.task_id
        ? await withFileLock(taskOperationLockPath(task.task_id), publishRoom, {}, TASK_OPERATION_LOCK_STALE_MS)
        : await publishRoom();
    } catch (error) {
      unlockSnapshot?.();
      if (launchTemplate?.launch_snapshot_hash) releaseLaunchSnapshot(launchTemplate.launch_snapshot_hash);
      throw error;
    }
    unlockSnapshot?.();
    recordCanonicalRoomCreated(room);
    // The created notice is observable while member admission is still in
    // progress; it is not delayed behind task-start command completion.
    await checkpointFleetAuditPresentations();
    room = advanceSaga(room.room_id, 'create_room', 1);
    if (attachOwner) {
      try {
        room = advanceSaga(room.room_id, 'attach_owner', 2);
        const accepted = await cowork.acceptInvite(room.room_id, cfg.ownerInvite!, {
          role: rooms.owner.role, expected_cid: rooms.owner.expected_cid,
        });
        room = setOwnerSeat(room.room_id, accepted.seat_cid, cfg.ownerInviteFingerprint ?? '');
      } catch (error) {
        const mismatch = error instanceof CoworkProtocolError && /CID|expected/i.test(error.message);
        setSagaError(room.room_id, error instanceof Error ? error.message : String(error),
          mismatch ? 'Verify rooms.owner.expected_cid and rotate the configured invite if necessary.'
            : 'Rotate rooms.owner.public_invite or public_invite_file, then retry the originating task or room create command.',
          mismatch ? 'owner_cid_mismatch' : 'waiting_owner_invite');
        throw error;
      }
    }
    room = advanceSaga(room.room_id, 'create_members', 3);
    if (launchTemplate && (launchTemplate.members.length > 0 || attachOwner)) try {
      room = await (this.deps.provisionMembers ?? provisionMembers)({
        cfg, cowork, roomId: room.room_id, taskId: task.task_id, template: launchTemplate,
        binPath: (this.deps.binPath ?? getBinPath)(), brief: task.brief,
        goal: task.task_id ? task.title : task.goal,
      });
    } catch (error) {
      throw error;
    }
    else if (attachOwner) {
      const now = this.deps.now ?? Date.now;
      const sleep = this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const deadline = now() + 60_000;
      for (;;) {
        const seats = await cowork.getSeats(room.room_id);
        if (room.owner_seat_cid && seats.some(seat =>
          seat.identity_cid.toLowerCase() === room.owner_seat_cid!.toLowerCase()
            && seat.seat_state === 'active')) {
          room = activateRoom(room.room_id);
          break;
        }
        if (now() >= deadline) {
          room = advanceSaga(room.room_id, 'wait_seats', 5, 'waiting_seats');
          break;
        }
        await sleep(250);
      }
    } else room = activateRoom(room.room_id);
    if (room.state === 'active') recordFleetAuditPresentation({ kind: 'room', operation: 'activate',
      eventId: `room-ready:${room.activated_at ?? room.created_at}`, id: room.room_id,
      name: room.room_name, previousState: 'provisioning', newState: 'active',
      revision: room.activated_at ?? room.created_at, taskId: room.task_id,
      template: room.template_snapshot ? `${room.template_snapshot.name}@${room.template_snapshot.version}` : undefined,
      anonymous: policy.anonymous, memberCount: room.member_seats.length, ownerAttached: attachOwner,
      participants: [] });
    if (task.task_id && !launchTemplate?.members.length) activateTask(task.task_id);
    return room;
  }
}
