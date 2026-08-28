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
  deleteTask as persistDeleteTask, getTask as readTask, listTasks as readTasks,
  moveTaskToList,
  reviewTask as persistReviewTask, startTask as transitionTask,
  TaskStateError, unblockTask as persistUnblockTask, updateTaskRoom, updateTaskTemplate,
} from '../rooms-tasks/task-state.js';
import {
  createTaskListLocked, DEFAULT_TASK_LIST_ID, deleteTaskListRecordLocked, readTaskLists,
  renameTaskListLocked, resolveTaskList, TaskListError, withTaskListsLock,
} from '../rooms-tasks/task-lists.js';
import { hashTemplate, listTemplates, resolveTemplate, snapshotTemplate } from '../rooms-tasks/templates.js';
import {
  acceptManagedRoomClose, deleteLegacyClosedRooms, deleteManagedRoom, recordManagedRoomCloseError,
} from '../rooms-tasks/close.js';
import {
  acceptTaskTerminalIntent, recordTaskTerminalIntentError, settleTaskTerminalIntent,
} from '../rooms-tasks/terminal.js';
import type {
  RoomOrchestrationRecord, TaskListRecord, TaskOrigin, TaskOutcome, TaskRecord, TaskState, TemplateSnapshot,
} from '../rooms-tasks/types.js';
import { TASK_CANCELLABLE_STATES, TASK_TERMINAL_STATES } from '../rooms-tasks/types.js';
import { loadConfigResourceSnapshot, type ConfigResourceSnapshot } from '../config-resource-loader.js';
import { defaultConfigPath } from '../paths.js';
import { previewRoomMemberComposition } from '../rooms-tasks/member-composition.js';
import type { ExplicitBrainRoomTemplateMemberSpec, RoomTemplateResource } from '../config-resources.js';

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
export type TaskRecoveryBegin =
  | { kind: 'terminal_worker_required'; taskId: string }
  | { kind: 'final'; result: TaskRecoveryResult };

export class TaskRoomApplicationError extends Error {
  constructor(readonly code: 'template_not_found' | 'task_template_drift' | 'template_mismatch'
    | 'task_terminal' | 'task_terminal_already' | 'task_non_resumable' | 'room_not_found'
    | 'room_record_not_found', message: string,
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
}
export interface CreateRoomRequest {
  actor: TaskRoomActor;
  name: string;
  template?: string;
  goal?: string;
  brief?: string;
  briefFile?: string;
}

export interface TaskRoomServiceDeps {
  loadConfiguration?(path?: string): FleetConfig;
  loadResourceSnapshot?(path: string): ConfigResourceSnapshot;
  cowork?(config: FleetConfig): CoworkAdapter;
  binPath?(): string;
  provisionMembers?: typeof provisionMembers;
  moveTaskToList?: typeof moveTaskToList;
}

/** Exact extraction of the previously CLI-owned task create/start behavior. */
export class TaskRoomApplicationService {
  private recovery?: { taskId: string; config: FleetConfig };
  private readonly canonicalTemplates = new WeakMap<TemplateSnapshot, Readonly<{
    snapshot: ConfigResourceSnapshot; templateId: string;
    members: readonly Readonly<ExplicitBrainRoomTemplateMemberSpec>[];
  }>>();
  constructor(
    private readonly configurationPath?: string,
    private readonly deps: TaskRoomServiceDeps = {},
  ) {}

  async createTask(request: CreateTaskRequest): Promise<TaskRecord> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const template = this.createTemplate(cfg, request.template, request.noRoom);
    const ref = template && {
      name: template.name, version: template.version, content_hash: template.content_hash,
    };
    const brief = request.briefFile ? readFileSync(request.briefFile, 'utf8') : request.brief;
    let task = await withTaskListsLock(() => {
      const list = resolveTaskList(request.list ?? 'default');
      return persistTask({
        title: request.title, brief, brief_file: request.briefFile, template: ref,
        origin: request.origin, idempotency_key: request.idempotencyKey,
        start: !request.backlog, no_room: request.noRoom, listId: list.list_id,
      });
    });
    if (!request.backlog && !request.noRoom && ref && !task.room_id) {
      try {
        await this.provisionRoom(cfg, task, template!, room => {
          task = updateTaskRoom(task.task_id, room.room_id, room.room_identity_cid!);
        });
        task = readTask(task.task_id);
      } catch (error) {
        if (error instanceof CoworkUnavailableError)
          persistBlockTask(task.task_id, 'Cowork management socket is unavailable');
        throw error;
      }
    }
    return task;
  }

  async createRoom(request: CreateRoomRequest): Promise<RoomOrchestrationRecord> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const brief = request.briefFile ? readFileSync(request.briefFile, 'utf8') : request.brief;
    let template: TemplateSnapshot | undefined;
    if (request.template) {
      template = this.selectTemplate(cfg, request.template);
    }
    return this.provisionRoom(cfg, {
      title: request.name, brief, goal: request.goal,
    }, template, () => {});
  }

  async startTask(input: { actor: TaskRoomActor; taskId: string }): Promise<TaskRecord> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    const before = readTask(input.taskId);
    const selected = before.template && !before.room_id ? this.existingTemplate(cfg, before) : undefined;
    let task = transitionTask(input.taskId);
    if (task.template && !task.room_id) {
      await this.provisionRoom(cfg, task, selected!, room => {
        task = updateTaskRoom(task.task_id, room.room_id, room.room_identity_cid!);
      });
      task = readTask(task.task_id);
    }
    return task;
  }

  listTasks(filter?: { state?: TaskState | TaskState[]; list?: string }): TaskRecord[] {
    const listId = filter?.list === undefined ? undefined : resolveTaskList(filter.list).list_id;
    return readTasks({ state: filter?.state, listId });
  }

  listTaskLists(): TaskListRecord[] { return readTaskLists(); }

  groupedTasks(filter?: { state?: TaskState | TaskState[]; list?: string }): Array<{
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

  blockTask(input: { actor: TaskRoomActor; taskId: string; reason: string }): TaskRecord {
    return persistBlockTask(input.taskId, input.reason);
  }

  unblockTask(input: { actor: TaskRoomActor; taskId: string }): TaskRecord {
    return persistUnblockTask(input.taskId);
  }

  reviewTask(input: { actor: TaskRoomActor; taskId: string }): TaskRecord {
    return persistReviewTask(input.taskId);
  }

  deleteTask(input: { actor: TaskRoomActor; taskId: string }): boolean {
    return persistDeleteTask(input.taskId);
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
    const config = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    this.recovery = { taskId: input.taskId, config };
    const task = readTask(input.taskId);
    if (task.terminal_intent?.status === 'pending')
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
    if (!room) return { kind: 'provisioning_non_resumable', task, room, issues, reason: 'missing_room' };
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
      const issues = template.members.flatMap(member => cfg.roles.some(role => role.name === member.role_ref)
        ? [] : [`member ${member.slot}: role_ref '${member.role_ref}' not found in fleet roles`]);
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

  async recoverRoom(input: { actor: TaskRoomActor; roomId: string }): Promise<
    | { kind: 'deletion_worker_required'; roomId: string }
    | { kind: 'recovered' | 'provisioning_resumed' | 'provisioning_resume_failed'; room: Awaited<ReturnType<CoworkAdapter['recoverRoom']>>; orchestration: RoomOrchestrationRecord | undefined; issues: string[] }
  > {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    if (!cfg.rooms) throw new ConfigError('rooms: configuration is required before creating or querying rooms');
    const adapter = this.deps.cowork ? this.deps.cowork(cfg)
      : createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
    let orchestration = getRoomRecord(input.roomId);
    if (orchestration?.state === 'closing' || orchestration?.state === 'closed')
      return { kind: 'deletion_worker_required', roomId: input.roomId };
    const room = await adapter.recoverRoom(input.roomId);
    orchestration = getRoomRecord(input.roomId);
    if (orchestration && !orchestration.owner_seat_cid
      && (orchestration.provisioning_detail === 'waiting_owner_invite'
        || orchestration.provisioning_detail === 'owner_cid_mismatch')) {
      const expected = cfg.rooms.owner.expected_cid.toLowerCase();
      const existing = (await adapter.getSeats(input.roomId))
        .find(seat => seat.identity_cid.toLowerCase() === expected && seat.seat_state !== 'removed');
      if (!existing && !cfg.ownerInvite)
        throw new ConfigError('rooms.owner: configure public_invite or public_invite_file before recovery');
      let acceptedCid = existing?.identity_cid;
      if (!acceptedCid) acceptedCid = (await adapter.acceptInvite(input.roomId, cfg.ownerInvite!, {
        role: cfg.rooms.owner.role, expected_cid: cfg.rooms.owner.expected_cid,
      })).seat_cid;
      setOwnerSeat(input.roomId, acceptedCid, cfg.ownerInviteFingerprint ?? '');
      orchestration = advanceSaga(input.roomId, 'create_members', 3);
    }
    const issues: string[] = [];
    if (orchestration?.saga.error) issues.push('A provisioning failure is recorded; inspect role logs for diagnostics.');
    if (orchestration?.saga.recovery_hint) issues.push('Recovery guidance is recorded; inspect role logs for diagnostics.');
    if (orchestration?.provisioning_detail === 'waiting_cowork') issues.push('Check ours-cowork service status');
    if (orchestration?.provisioning_detail === 'waiting_owner_invite') issues.push('Rotate rooms.owner.public_invite in config, then re-run recover');
    if (orchestration?.provisioning_detail === 'waiting_seats') issues.push('Inspect temporary member logs for invite acceptance, then re-run recover');
    if (orchestration?.state === 'provisioning'
      && ['create_members', 'join_role_groups', 'wait_seats', 'launch_work', 'activate'].includes(orchestration.saga.phase)
      && orchestration.template_snapshot) {
      try {
        let template = orchestration.template_snapshot;
        let brief: string | undefined;
        let goal = orchestration.room_name;
        if (orchestration.task_id) {
          const task = readTask(orchestration.task_id);
          if (!task.template || task.template.name !== template.name || task.template.version !== template.version
            || task.template.content_hash !== template.content_hash)
            throw new Error(`task ${task.task_id} template reference does not match room ${orchestration.room_id}'s durable snapshot`);
          brief = task.brief; goal = task.title;
        }
        await (this.deps.provisionMembers ?? provisionMembers)({ cfg, cowork: adapter,
          roomId: orchestration.room_id, taskId: orchestration.task_id, template,
          binPath: (this.deps.binPath ?? getBinPath)(), brief, goal });
        orchestration = getRoomRecord(input.roomId);
        return { kind: 'provisioning_resumed', room, orchestration,
          issues: ['Provisioning resumed successfully'] };
      } catch (error) {
        issues.push(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: 'provisioning_resume_failed', room, orchestration, issues };
      }
    }
    return { kind: 'recovered', room, orchestration, issues };
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
    actor: TaskRoomActor; taskId: string; template?: string;
  }): Promise<{ task: TaskRecord; status: 'ready' | 'already_active' }> {
    const cfg = (this.deps.loadConfiguration ?? loadConfig)(this.configurationPath);
    let task = readTask(input.taskId);
    if (TASK_TERMINAL_STATES.includes(task.state)) throw new TaskRoomApplicationError(
      'task_terminal', 'task terminal', { task: input.taskId, state: task.state });
    const linkedRoom = task.room_id ? getRoomRecord(task.room_id) : undefined;
    if (task.room_id && !linkedRoom)
      throw new TaskRoomApplicationError('task_non_resumable',
        `task ${task.task_id} references missing room ${task.room_id}`,
        { task: task.task_id, room: task.room_id });
    if (linkedRoom && linkedRoom.template_snapshot?.canonical?.kind !== 'canonical_room_template')
      throw new TaskRoomApplicationError('task_non_resumable',
        `legacy room ${linkedRoom.room_id} is recovery/close-only; create a new room from a schema-v2 RoomTemplate`,
        { task: task.task_id, room: linkedRoom.room_id });
    if (task.state === 'active' && task.room_id) {
      if (input.template) {
        const requested = this.selectTemplate(cfg, input.template);
        const pinned = getRoomRecord(task.room_id)?.template_snapshot ?? task.template;
        if (pinned && (pinned.name !== requested.name || pinned.content_hash !== requested.content_hash))
          throw new TaskRoomApplicationError('template_mismatch', 'template mismatch', {
            requested: `${requested.name}@${requested.version}`, room: task.room_id,
            provisioned: `${pinned.name}@${pinned.version}` });
      }
      return { task, status: 'already_active' };
    }
    const room = linkedRoom;
    const durable = room?.template_snapshot;
    if (durable && (!task.template || task.template.name !== durable.name
      || task.template.version !== durable.version || task.template.content_hash !== durable.content_hash))
      throw new Error(`task ${task.task_id} template reference does not match room ${room!.room_id}'s durable snapshot`);
    const templateName = input.template ?? durable?.name ?? task.template?.name
      ?? cfg.tasks?.default_room_template ?? cfg.rooms?.defaults?.template ?? 'single';
    const requested = this.selectTemplate(cfg, templateName);
    const snapshot = durable ?? requested;
    if (durable?.canonical) {
      const current = this.canonicalTemplates.get(requested)!;
      this.canonicalTemplates.set(snapshot, { ...current, templateId: durable.canonical.template_id,
        members: durable.canonical.members });
    }
    if (durable && input.template) {
      if (requested.name !== durable.name || requested.content_hash !== durable.content_hash)
        throw new TaskRoomApplicationError('template_mismatch', 'template mismatch', {
          requested: `${requested.name}@${requested.version}`, room: room!.room_id,
          provisioned: `${durable.name}@${durable.version}` });
    }
    if (!input.template && task.template && snapshot.content_hash !== task.template.content_hash)
      throw new TaskRoomApplicationError('task_template_drift', 'task template drift', {
        template: `${task.template.name}@${task.template.version}` });
    if (task.room_id && room?.template_snapshot
      && (room.template_snapshot.name !== snapshot.name || room.template_snapshot.content_hash !== snapshot.content_hash))
      throw new TaskRoomApplicationError('template_mismatch', 'template mismatch', {
        requested: `${snapshot.name}@${snapshot.version}`, room: task.room_id,
        provisioned: `${room.template_snapshot.name}@${room.template_snapshot.version}` });
    if (!task.template || task.template.name !== snapshot.name || task.template.content_hash !== snapshot.content_hash)
      task = updateTaskTemplate(task.task_id, { name: snapshot.name, version: snapshot.version, content_hash: snapshot.content_hash });
    if (task.state === 'backlog') task = transitionTask(task.task_id);
    if (!task.room_id) {
      try {
        await this.provisionRoom(cfg, task, snapshot, created => {
          task = updateTaskRoom(task.task_id, created.room_id, created.room_identity_cid!);
        });
        task = readTask(task.task_id);
      } catch (error) {
        if (error instanceof CoworkUnavailableError)
          persistBlockTask(task.task_id, 'Cowork management socket is unavailable');
        throw error;
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
          brief: task.brief, goal: task.title,
          ...(this.canonicalTemplates.get(snapshot)
            ? { canonical: this.canonicalTemplates.get(snapshot)! } : {}) });
        task = readTask(task.task_id);
      } catch (error) {
        if (error instanceof CoworkUnavailableError) persistBlockTask(task.task_id, 'Cowork management socket is unavailable');
        throw error;
      }
    }
    return { task, status: 'ready' };
  }

  private createTemplate(
    cfg: FleetConfig, requested: string | undefined, noRoom: boolean | undefined,
  ): TemplateSnapshot | undefined {
    if (noRoom) return undefined;
    const name = requested
      ?? cfg.tasks?.default_room_template ?? cfg.rooms?.defaults?.template ?? 'team';
    return this.selectTemplate(cfg, name);
  }

  private existingTemplate(cfg: FleetConfig, task: TaskRecord): TemplateSnapshot {
    const ref = task.template!;
    const snapshot = this.selectTemplate(cfg, ref.name);
    if (snapshot.content_hash !== ref.content_hash)
      throw new TaskRoomApplicationError(
        'task_template_drift', `task template snapshot no longer matches ${ref.name}@${ref.version}`,
      );
    return snapshot;
  }

  private selectTemplate(cfg: FleetConfig, name: string): TemplateSnapshot {
    let snapshot: ConfigResourceSnapshot;
    try {
      const path = this.configurationPath ?? defaultConfigPath();
      snapshot = this.deps.loadResourceSnapshot
        ? this.deps.loadResourceSnapshot(path)
        : loadConfigResourceSnapshot({ bootstrapFile: path });
    } catch (error) {
      throw new TaskRoomApplicationError('template_not_found',
        `legacy room templates cannot provision new members; migrate '${name}' to a schema-v2 RoomTemplate with explicit Brain and complete permissions`,
        { template: name, migration: 'schema-v2 RoomTemplate + Role + Brain' });
    }
    const resource = snapshot.resources.RoomTemplate?.[name] as RoomTemplateResource | undefined;
    if (!resource || resource.kind !== 'RoomTemplate') throw new TaskRoomApplicationError(
      'template_not_found', `canonical RoomTemplate not found: ${name}`, { template: name });
    const source = snapshot.sources.find(candidate => candidate.kind === 'RoomTemplate' && candidate.id === name);
    if (!source) throw new Error(`canonical RoomTemplate '${name}' has no source evidence`);
    const members = resource.spec.members.map((member, index) => {
      const preview = previewRoomMemberComposition(snapshot, member,
        `RoomTemplate/${name}`, `$.spec.members[${index}]`);
      if (!member.permissions || member.permissions.approval === undefined
          || member.permissions.filesystem === undefined || member.permissions.unattended === undefined)
        throw new Error(`RoomTemplate/${name}: member ${index} requires complete permissions`);
      return preview.member;
    });
    const durable: TemplateSnapshot = {
      name, version: resource.spec.version, description: resource.spec.description,
      ...(resource.spec.contract === undefined ? {} : { contract: resource.spec.contract }),
      ...(resource.spec.room === undefined ? {} : { room: resource.spec.room }),
      content_hash: source.sha256,
      members: members.map(member => ({ slot: member.slot, role: member.role,
        count: member.count, role_ref: member.role })),
      canonical: { kind: 'canonical_room_template', template_id: name,
        snapshot_digest: snapshot.digest, members },
    };
    this.canonicalTemplates.set(durable, { snapshot, templateId: name, members });
    return durable;
  }

  private async provisionRoom(
    cfg: FleetConfig,
    task: Pick<TaskRecord, 'title' | 'brief'> & { task_id?: string; goal?: string },
    template: TemplateSnapshot | undefined,
    onCreated: (room: RoomOrchestrationRecord) => void,
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
    const created = await cowork.createRoom({
      room_name: task.title, goal: task.goal?.trim() || task.title,
      briefing: task.brief?.trim() || template?.contract?.trim() || task.goal?.trim() || task.title,
      quiet_membership: template?.room?.quiet_membership,
      anonymous: template?.room?.anonymous,
    });
    let room = createRoomRecord({
      room_id: created.room_id, room_name: task.title, room_identity_cid: created.identity_cid,
      task_id: task.task_id, template_snapshot: template,
    });
    onCreated(room);
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
            : 'Rotate rooms.owner.public_invite or public_invite_file, then run room recover.',
          mismatch ? 'owner_cid_mismatch' : 'waiting_owner_invite');
        throw error;
      }
    }
    room = advanceSaga(room.room_id, 'create_members', 3);
    if (template?.members.length) return (this.deps.provisionMembers ?? provisionMembers)({
      cfg, cowork, roomId: room.room_id, taskId: task.task_id, template,
      binPath: (this.deps.binPath ?? getBinPath)(), brief: task.brief,
      goal: task.task_id ? task.title : task.goal,
      ...(this.canonicalTemplates.get(template)
        ? { canonical: this.canonicalTemplates.get(template)! } : {}),
    });
    room = activateRoom(room.room_id);
    if (task.task_id) activateTask(task.task_id);
    return room;
  }
}
