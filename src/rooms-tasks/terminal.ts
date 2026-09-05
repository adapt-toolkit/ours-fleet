import { join } from 'node:path';

import { withFileLock } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { deleteManagedRoom, type RoomCloseDeps } from './close.js';
import type { CoworkAdapter } from './cowork-adapter.js';
import {
  assertNoPendingDeletion, beginTaskTerminalIntent, finishTaskTerminalIntent, getTask,
  setTaskTerminalIntentError,
} from './task-state.js';
import { getRoomRecord } from './room-state.js';
import type { TaskOutcome, TaskRecord, TaskTerminalIntent } from './types.js';

export const TASK_OPERATION_LOCK_STALE_MS = 10 * 60_000;

/** Common per-task operation lock serializing terminal, deletion, and recovery acceptance. */
export function taskOperationLockPath(taskId: string): string {
  return join(stateRoot(), 'locks', 'task-terminal', encodeURIComponent(taskId));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TaskTerminalInput {
  taskId: string;
  kind: TaskTerminalIntent['kind'];
  roomId?: string;
  outcome?: TaskOutcome;
}

/** Persist first-wins terminal intent before any acknowledgement or close effect. */
export function acceptTaskTerminalIntent(input: TaskTerminalInput): Promise<TaskRecord> {
  return withFileLock(taskOperationLockPath(input.taskId), () => {
    const accepted = beginTaskTerminalIntent(input.taskId, input);
    if (!input.roomId) return finishTaskTerminalIntent(input.taskId);
    return accepted;
  }, {}, TASK_OPERATION_LOCK_STALE_MS);
}

export interface SettleTaskTerminalDeps {
  roomClose?: RoomCloseDeps;
  afterRoomClosed?(): void | Promise<void>;
}

/** Delete the recorded room, then atomically settle the persisted task intent. */
export function settleTaskTerminalIntent(input: {
  taskId: string;
  cowork: Pick<CoworkAdapter, 'closeRoom' | 'deleteRoom'>;
  deps?: SettleTaskTerminalDeps;
}): Promise<TaskRecord> {
  return withFileLock(taskOperationLockPath(input.taskId), async () => {
    const current = getTask(input.taskId);
    // Deletion supersedes a pending terminal intent: fail boundedly before any
    // room side effect so the deletion worker owns all remaining cleanup.
    assertNoPendingDeletion(current);
    const intent = current.terminal_intent;
    if (!intent) throw new Error(`task ${input.taskId} has no accepted terminal intent`);
    if (intent.status === 'settled') return current;
    try {
      if (intent.room_id) {
        if (getRoomRecord(intent.room_id)) {
          const deleted = await deleteManagedRoom({
            roomId: intent.room_id,
            cowork: input.cowork,
            deps: input.deps?.roomClose,
          });
          if (!deleted.deleted) throw new Error(`room ${intent.room_id} was not deleted`);
        }
        await input.deps?.afterRoomClosed?.();
      }
      return finishTaskTerminalIntent(input.taskId);
    } catch (error) {
      setTaskTerminalIntentError(input.taskId, errorText(error), intent.kind === 'cancelled'
        ? `Retry 'ours-fleet task cancel ${input.taskId} ${input.taskId}'.`
        : `Retry 'ours-fleet task done ${input.taskId}'.`);
      throw error;
    }
  }, {}, TASK_OPERATION_LOCK_STALE_MS);
}

/** Persist failure to launch an external settle worker under the same task lock. */
export function recordTaskTerminalIntentError(
  taskId: string, error: string, recoveryHint: string,
): Promise<TaskRecord> {
  return withFileLock(
    taskOperationLockPath(taskId),
    () => setTaskTerminalIntentError(taskId, error, recoveryHint),
    {},
    TASK_OPERATION_LOCK_STALE_MS,
  );
}
