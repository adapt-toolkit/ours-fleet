import { withFileLock } from '../atomic-file.js';
import { TASK_OPERATION_LOCK_STALE_MS, taskOperationLockPath } from './terminal.js';
import {
  beginTaskDeletionIntent, setTaskDeletionError, type TaskDeletionAcceptance,
} from './task-state.js';
import type { TaskDeletionActor, TaskRecord } from './types.js';

/**
 * Accept a permanent task deletion under the common task-operation lock so it
 * serializes against terminal settlement and recovery. Acceptance is durable
 * before any side effect and never requires Cowork availability; settlement
 * runs separately and converges through retries.
 */
export function acceptTaskDeletion(
  taskId: string, actor: TaskDeletionActor,
): Promise<TaskDeletionAcceptance> {
  return withFileLock(
    taskOperationLockPath(taskId),
    () => beginTaskDeletionIntent(taskId, actor),
    {},
    TASK_OPERATION_LOCK_STALE_MS,
  );
}

/** Persist a settlement failure under the same task-operation lock. */
export function recordTaskDeletionError(
  taskId: string, error: string, recoveryHint: string,
): Promise<TaskRecord> {
  return withFileLock(
    taskOperationLockPath(taskId),
    () => setTaskDeletionError(taskId, error, recoveryHint),
    {},
    TASK_OPERATION_LOCK_STALE_MS,
  );
}
