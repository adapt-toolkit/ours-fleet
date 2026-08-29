import type { TaskRoomApplicationService, TaskRoomActor } from './task-room-service.js';
import type { ManagementPrincipal, ManagementRequest, ManagementResult } from './management-contract.js';
import type { TaskRoomManagementPort, TaskRoomOperationContext } from './management-kernel.js';
import { acknowledgeTaskEffectReceipt, getTaskEffectReceipt, type TaskEffectContext } from '../rooms-tasks/task-state.js';
import { acknowledgeCheckpointedRoomRecovery, getRoomRecoveryReceipt } from '../rooms-tasks/room-state.js';
import type { RoomEffectContext, RoomRecoveryContext } from '../rooms-tasks/room-state.js';
import { acknowledgeManagedRoomCloseReceipt, getManagedRoomCloseReceipt } from '../rooms-tasks/close.js';
import { managementDigest } from './management-operation-store.js';
import { FleetError } from './errors.js';
import { TaskListError } from '../rooms-tasks/task-lists.js';

type Command = Extract<ManagementRequest['command'], { operation: `task.${string}`|`room.${string}` }>;

function actor(principal: ManagementPrincipal): TaskRoomActor {
  if (principal.surface === 'owner' && principal.cid)
    return { kind: 'authenticated_owner', surface: 'messenger', cid: principal.cid };
  if ((principal.surface === 'cli' || principal.surface === 'web') && principal.local)
    return { kind: 'local_control', surface: principal.surface };
  throw new FleetError('forbidden', 'task and room operation requires authenticated local or owner authority');
}

const result = (type: Extract<ManagementResult, { value: unknown }>['type'], value: unknown): ManagementResult =>
  ({ type, value });

/** Canonical safe member projection. Identity CIDs, invites and launch evidence never enter the shared journal. */
function safeMembers(value: Awaited<ReturnType<TaskRoomApplicationService['getRoomMembers']>>) {
  return { room: value.room, orchestration: value.orchestration && {
    room_id: value.orchestration.room_id, room_name: value.orchestration.room_name,
    state: value.orchestration.state, saga: value.orchestration.saga,
  }, members: value.members.map(member => ({ role: member.role, seat_state: member.seat_state })) };
}

export class TaskRoomManagementService implements TaskRoomManagementPort {
  constructor(private readonly service: TaskRoomApplicationService, private readonly hooks: {
    beforeTaskEffectPublish?(operation: TaskEffectContext['operation']): void;
    afterTaskEffectPublish?(operation: TaskEffectContext['operation']): void;
    beforeTaskEffectFinalize?(operation: TaskEffectContext['operation']): void;
    afterTaskEffectFinalize?(operation: TaskEffectContext['operation']): void;
  } = {}) {}

  async execute(command: Command, principal: ManagementPrincipal, context?: TaskRoomOperationContext): Promise<ManagementResult> {
    const authority = actor(principal);
    if (command.operation === 'task.create') return result('task', await this.service.createTask({
      actor: authority, title: command.title, origin: { type: command.origin },
      ...(command.brief === undefined ? {} : { brief: command.brief }),
      ...(command.template === undefined ? {} : { template: command.template }),
      ...(command.backlog === undefined ? {} : { backlog: command.backlog }),
      ...(command.noRoom === undefined ? {} : { noRoom: command.noRoom }),
      ...(command.list === undefined ? {} : { list: command.list }),
    }));
    if (command.operation === 'task.list') {
      try { return result('tasks', command.groupByList
        ? this.service.groupedTasks({ ...(command.state ? { state: command.state as never } : {}),
            ...(command.list ? { list: command.list } : {}) })
        : this.service.listTasks({ ...(command.state ? { state: command.state as never } : {}),
            ...(command.list ? { list: command.list } : {}) })); }
      catch (error) {
        if (error instanceof TaskListError && error.code === 'list_not_found')
          throw new FleetError('resource_not_found', error.message);
        throw error;
      }
    }
    if (command.operation === 'task.get') return result('task-detail', this.service.getTask(command.id));
    if (command.operation.startsWith('task.')) {
      const task = command as Exclude<Extract<Command, { operation: `task.${string}` }>,
        { operation: 'task.create'|'task.list'|'task.get' }>;
      const before = this.service.getTask(task.id);
      this.assertState(task.expectedStateDigest, before, task.id);
      const effect = context && ['task.start', 'task.block', 'task.unblock', 'task.review'].includes(task.operation)
        ? { ...context, operation: task.operation, beforeDigest: task.expectedStateDigest,
          beforePublish: () => this.hooks.beforeTaskEffectPublish?.(task.operation as TaskEffectContext['operation']),
          afterPublish: () => this.hooks.afterTaskEffectPublish?.(task.operation as TaskEffectContext['operation'])
        } as TaskEffectContext : undefined;
      if (task.operation === 'task.start') return result('task', await this.service.startTask({ actor: authority, taskId: task.id, effect }));
      if (task.operation === 'task.block') return result('task', this.service.blockTask({ actor: authority, taskId: task.id, reason: task.reason, effect }));
      if (task.operation === 'task.unblock') return result('task', this.service.unblockTask({ actor: authority, taskId: task.id, effect }));
      if (task.operation === 'task.review') return result('task', this.service.reviewTask({ actor: authority, taskId: task.id, effect }));
      if (task.operation === 'task.delete') return result('task', { id: task.id,
        deleted: this.service.deleteTask({ actor: authority, taskId: task.id }) });
      if (task.operation === 'task.complete') return result('task-settlement', await this.service.finishTask({
        actor: authority, taskId: task.id, ...(task.outcome === undefined ? {} : { outcome: task.outcome as never }) }));
      if (task.operation === 'task.cancel') return result('task-settlement', await this.service.cancelTask({ actor: authority, taskId: task.id }));
      return result('task-recovery', await this.service.beginTaskRecovery({ actor: authority, taskId: task.id }));
    }
    if (command.operation === 'room.create') return result('room', await this.service.createRoom({
      actor: authority, name: command.name, ...(command.template ? { template: command.template } : {}),
      ...(command.goal ? { goal: command.goal } : {}), ...(command.brief ? { brief: command.brief } : {}),
    }));
    if (command.operation === 'room.list') return result('room', await this.service.listRooms(
      command.state ? { state: command.state } : undefined));
    if (command.operation === 'room.get') return result('room-detail', await this.service.getRoomDetail(command.id));
    if (command.operation === 'room.members.list') return result('room-members',
      safeMembers(await this.service.getRoomMembers(command.id)));
    const room = command as Extract<Command, { operation: 'room.delete'|'room.recover' }>;
    const before = room.operation === 'room.recover'
      ? this.service.getRoomRecoveryDetail(room.id) : await this.service.getRoomDetail(room.id);
    this.assertState(room.expectedStateDigest, before, room.id);
    if (room.operation === 'room.delete') return result('room-close',
      await this.service.requestRoomDeletion({ actor: authority, roomId: room.id,
        ...(context ? { effect: { ...context, operation: 'room.delete',
          beforeDigest: room.expectedStateDigest } satisfies RoomEffectContext } : {}) }));
    if (!context) throw new FleetError('invalid_request', 'room recovery requires an operation context');
    const recoveryEffect: RoomRecoveryContext = { ...context, operation: 'room.recover',
      beforeDigest: room.expectedStateDigest };
    return result('room-recovery', this.service.acceptRoomRecovery({ actor: authority, roomId: room.id,
      effect: recoveryEffect }));
  }

  async reconcile(command: Command, principal: ManagementPrincipal,
    context: TaskRoomOperationContext): Promise<ManagementResult | undefined> {
    actor(principal);
    if (command.operation === 'room.delete' && 'id' in command) {
      const receipt = await getManagedRoomCloseReceipt(command.id, context.keyHash);
      if (!receipt) return undefined;
      if (receipt.principalHash !== context.principalHash || receipt.requestHash !== context.requestHash)
        throw new FleetError('idempotency_conflict', 'room effect receipt is unavailable');
      return result('room-close', receipt.result);
    }
    if (command.operation === 'room.recover' && 'id' in command) {
      const receipt = getRoomRecoveryReceipt(command.id, context.keyHash);
      if (!receipt) return undefined;
      if (receipt.principalHash !== context.principalHash || receipt.requestHash !== context.requestHash)
        throw new FleetError('idempotency_conflict', 'room recovery receipt is unavailable');
      return result('room-recovery', receipt.result);
    }
    if (!['task.start', 'task.block', 'task.unblock', 'task.review'].includes(command.operation)
        || !('id' in command)) return undefined;
    const receipt = getTaskEffectReceipt(command.id, context.keyHash);
    if (!receipt) return undefined;
    if (receipt.principalHash !== context.principalHash || receipt.requestHash !== context.requestHash
        || receipt.operation !== command.operation || receipt.resourceId !== command.id)
      throw new FleetError('idempotency_conflict', 'task effect receipt is unavailable');
    return result('task', receipt.result);
  }

  async finalize(command: Command, context: TaskRoomOperationContext): Promise<void> {
    if (command.operation === 'room.delete' && 'id' in command) {
      await acknowledgeManagedRoomCloseReceipt(command.id, context.keyHash); return;
    }
    if (command.operation === 'room.recover' && 'id' in command) {
      acknowledgeCheckpointedRoomRecovery(command.id, context.keyHash); return;
    }
    if (!['task.start', 'task.block', 'task.unblock', 'task.review'].includes(command.operation)
        || !('id' in command)) return;
    const operation = command.operation as TaskEffectContext['operation'];
    acknowledgeTaskEffectReceipt(command.id, context.keyHash, {
      beforePublish: () => this.hooks.beforeTaskEffectFinalize?.(operation),
      afterPublish: () => this.hooks.afterTaskEffectFinalize?.(operation),
    });
  }

  private assertState(expected: string, value: unknown, id: string): void {
    if (managementDigest(value) !== expected) throw new FleetError('stale_state',
      `resource '${id}' changed since the request was prepared`, { retryable: true });
  }
}
