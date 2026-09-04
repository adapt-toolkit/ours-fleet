import { existsSync } from 'node:fs';

import { withFileLock } from '../atomic-file.js';
import { agentDir } from '../paths.js';
import { secureStoppedTempArchive, stopTempSupervisor } from '../temp-lifecycle.js';
import {
  closeManagedRoom, identityCidPresent, inspectMember, removeExactMemberIdentity,
  waitForLivenessAbsent, type RoomCloseDeps,
} from './close.js';
import { CoworkProtocolError, type CoworkAdapter } from './cowork-adapter.js';
import { deleteRoomRecord, getRoomRecord, listRoomRecords } from './room-state.js';
import { acquireLaunchSnapshotLock, releaseLaunchSnapshotForDeletingTask } from './launch-snapshot.js';
import { TASK_OPERATION_LOCK_STALE_MS, taskOperationLockPath } from './terminal.js';
import {
  advanceTaskDeletionMember, beginTaskDeletionIntent, completeTaskDeletionReceipt,
  ensureTaskDeletionReceipt, getDeletingTask, importTaskDeletionRetirementEvidence,
  setTaskDeletionError, TaskStateError,
  unlinkDeletedTask, upsertTaskDeletionMembersFromSeats,
  type TaskDeletionAcceptance,
} from './task-state.js';
import type {
  RoomMemberSeat, TaskDeletionActor, TaskDeletionMemberCursor, TaskRecord,
} from './types.js';

export { DELETION_MEMBER_ABSENT_VERIFIED } from './task-state.js';
import { DELETION_MEMBER_ABSENT_VERIFIED } from './task-state.js';

type DeletionCowork = Pick<CoworkAdapter, 'closeRoom' | 'deleteRoom'>;

export interface TaskDeletionSettleDeps {
  roomClose?: RoomCloseDeps;
  /** Test seam for the temp-state existence proof. */
  hasTempState?(name: string): boolean;
  /** Test seam for the CID-wide daemon identity scan. */
  identityCidPresent?(cid: string): Promise<boolean>;
}

export interface TaskDeletionSettleResult {
  task_id: string;
  deleted: boolean;
  /** Lifecycle state observed before unlink, for completion audit. */
  previous_state?: TaskRecord['state'];
  /** Title observed before unlink, for completion audit. */
  title?: string;
}

/**
 * Accept a permanent task deletion under the common task-operation lock so it
 * serializes against terminal settlement, recovery, and the room-publication
 * window. Acceptance is durable before any side effect and never requires
 * Cowork availability; settlement runs separately and converges through
 * retries.
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Already-missing remote rooms are a settled outcome, not a failure. */
function tolerantCowork(cowork: DeletionCowork): DeletionCowork {
  const tolerate = async (work: () => Promise<void>): Promise<void> => {
    try { await work(); } catch (error) {
      if (error instanceof CoworkProtocolError && error.code === 'not_found') return;
      throw error;
    }
  };
  return {
    closeRoom: roomId => tolerate(() => cowork.closeRoom(roomId)),
    deleteRoom: roomId => tolerate(() => cowork.deleteRoom(roomId)),
  };
}

function cursorSeat(cursor: TaskDeletionMemberCursor): RoomMemberSeat {
  return {
    role_name: cursor.name, identity_cid: cursor.identity_cid,
    slot: cursor.name, cowork_role: 'member', seat_state: 'active',
  };
}

/**
 * Retire one member from its durable deletion cursor when no room record
 * carries the seat: the same evidence chain as close.ts, resumed at the
 * recorded phase. A member with no temp state is verified absent through the
 * CID-wide identity scan; a same-name stranger identity is never touched, and
 * the recorded CID surviving under any name blocks settlement.
 */
async function retireCursorMember(
  taskId: string, cursor: TaskDeletionMemberCursor, deps: TaskDeletionSettleDeps,
): Promise<void> {
  let phase = cursor.phase;
  let launchId = cursor.launch_id;
  if (phase === 'identity_absent') return;
  const seat = cursorSeat(cursor);
  const roomClose = deps.roomClose ?? {};

  if (phase === 'pending') {
    const hasState = (deps.hasTempState ?? (name => existsSync(agentDir(name, true))))(cursor.name);
    if (!hasState) {
      const present = await (deps.identityCidPresent ?? identityCidPresent)(cursor.identity_cid);
      if (present) {
        // Remove only an exact name+CID match; a stranger under the same name
        // stays untouched and removeExactMemberIdentity refuses the mismatch.
        // The recorded CID surviving under a different name throws below on
        // its post-removal verification and blocks settlement.
        await (roomClose.removeIdentity ?? removeExactMemberIdentity)(seat);
        if (await (deps.identityCidPresent ?? identityCidPresent)(cursor.identity_cid))
          throw new TaskStateError(
            `deletion member '${cursor.name}' identity CID survives under another name; refusing to claim retirement`,
          );
      }
      advanceTaskDeletionMember(taskId, cursor.name, 'identity_absent', DELETION_MEMBER_ABSENT_VERIFIED);
      return;
    }
    const ownership = await (roomClose.inspectMember ?? inspectMember)(seat);
    advanceTaskDeletionMember(taskId, cursor.name, 'stop_requested', ownership.launchId);
    phase = 'stop_requested'; launchId = ownership.launchId;
  }

  if (phase === 'stop_requested') {
    await (roomClose.requestStop
      ?? (async (role: string) => { await stopTempSupervisor(role); }))(cursor.name);
    await (roomClose.waitForLivenessAbsent ?? waitForLivenessAbsent)(cursor.name, launchId!);
    advanceTaskDeletionMember(taskId, cursor.name, 'liveness_absent');
    phase = 'liveness_absent';
  }

  if (phase === 'liveness_absent') {
    const archivePath = await (roomClose.secureArchive ?? secureStoppedTempArchive)(
      cursor.name, launchId!,
    );
    advanceTaskDeletionMember(taskId, cursor.name, 'archive_secured', undefined, archivePath);
    phase = 'archive_secured';
  }

  if (phase === 'archive_secured') {
    await (roomClose.removeIdentity ?? removeExactMemberIdentity)(seat);
    advanceTaskDeletionMember(taskId, cursor.name, 'identity_absent');
  }
}

interface CleanupOutcome {
  kind: 'cleaned';
  snapshotHash?: string;
  previousState: TaskRecord['state'];
  title: string;
}

/**
 * Converge an accepted deletion to physical absence in two lock-ordered
 * stages. Cleanup stage (task-operation lock): per surviving room record,
 * register late seats → close saga (retires members) → durable evidence
 * checkpoint → tolerant remote delete → local record delete; then
 * cursor-based retirement for members with no room record and tolerant remote
 * close+delete of a recorded room whose local record is gone. Finalization
 * stage (launch-snapshot lock → task-operation lock, matching the global
 * provisioning order): re-verify quiescence, delete the owned launch snapshot
 * while excluding only this deleting task from the reference scan, and unlink
 * the task record LAST — every crash seam leaves the hidden intent
 * recoverable. Failures are recorded on the intent; the task stays hidden and
 * recoverable, never falsely settled.
 */
export async function settleTaskDeletion(input: {
  taskId: string;
  /** Lazy: resolved only when room work exists, so no-room tasks settle without Cowork config. */
  cowork: () => DeletionCowork;
  deps?: TaskDeletionSettleDeps;
}): Promise<TaskDeletionSettleResult> {
  const { taskId } = input;
  const deps = input.deps ?? {};
  const recoveryHint = `Re-run 'ours-fleet task delete ${taskId} ${taskId}'.`;

  const cleanup = await withFileLock(taskOperationLockPath(taskId), async () => {
    let task: TaskRecord;
    try { task = getDeletingTask(taskId); }
    catch (error) {
      if (error instanceof TaskStateError && /task not found/.test(error.message))
        return { kind: 'already_absent' } as const;
      throw error;
    }
    if (task.deletion?.status !== 'pending')
      throw new TaskStateError(`task ${taskId} has no pending deletion`);
    try {
      // Audit evidence precedes every side effect; a receipt write failure
      // aborts settlement (fail closed).
      ensureTaskDeletionReceipt(taskId);
      const records = listRoomRecords().filter(room => room.task_id === taskId);
      const recordIds = new Set(records.map(room => room.room_id));
      const recordedRoomId = task.deletion.room_id ?? task.room_id;
      const needsCowork = records.length > 0 || recordedRoomId !== undefined;
      const cowork = needsCowork ? tolerantCowork(input.cowork()) : undefined;

      for (const record of records) {
        upsertTaskDeletionMembersFromSeats(taskId, record.member_seats);
        await closeManagedRoom({ roomId: record.room_id, cowork: cowork!, deps: deps.roomClose });
        const closed = getRoomRecord(record.room_id);
        importTaskDeletionRetirementEvidence(taskId, closed?.member_seats ?? record.member_seats);
        await cowork!.deleteRoom(record.room_id);
        deleteRoomRecord(record.room_id);
      }

      // Members whose room record is gone (crash after record deletion, or
      // legacy state): resume from the durable cursors.
      for (const cursor of getDeletingTask(taskId).deletion!.members) {
        await retireCursorMember(taskId, cursor, deps);
      }
      // A recorded room without a local record may still be live remotely.
      if (recordedRoomId && !recordIds.has(recordedRoomId) && !getRoomRecord(recordedRoomId)) {
        await cowork!.closeRoom(recordedRoomId);
        await cowork!.deleteRoom(recordedRoomId);
      }

      return {
        kind: 'cleaned',
        snapshotHash: task.execution_plan?.snapshot.launch_snapshot_hash,
        previousState: task.state,
        title: task.title,
      } satisfies CleanupOutcome;
    } catch (error) {
      setTaskDeletionError(taskId, errorText(error), recoveryHint);
      throw error;
    }
  }, {}, TASK_OPERATION_LOCK_STALE_MS);
  if (cleanup.kind === 'already_absent') {
    // Heal a crash between unlink and receipt completion.
    completeTaskDeletionReceipt(taskId);
    return { task_id: taskId, deleted: false };
  }

  const finalize = (): Promise<void> => withFileLock(taskOperationLockPath(taskId), () => {
    try {
      const task = getDeletingTask(taskId);
      if (task.deletion?.status !== 'pending')
        throw new TaskStateError(`task ${taskId} has no pending deletion`);
      if (listRoomRecords().some(room => room.task_id === taskId))
        throw new TaskStateError(`task ${taskId} room records reappeared during deletion finalization`);
      if (task.deletion.members.some(member => member.phase !== 'identity_absent'))
        throw new TaskStateError(`task ${taskId} has unretired members at deletion finalization`);
      if (cleanup.snapshotHash)
        releaseLaunchSnapshotForDeletingTask(cleanup.snapshotHash, taskId);
      unlinkDeletedTask(taskId);
    } catch (error) {
      setTaskDeletionError(taskId, errorText(error), recoveryHint);
      throw error;
    }
    // After unlink the task can no longer carry errors; receipt completion is
    // idempotent and the already-absent retry path heals a crash here.
    completeTaskDeletionReceipt(taskId);
  }, {}, TASK_OPERATION_LOCK_STALE_MS);

  if (cleanup.snapshotHash) {
    // Global lock order: launch-snapshot lock → task-operation lock.
    const releaseSnapshotLock = acquireLaunchSnapshotLock();
    try { await finalize(); } finally { releaseSnapshotLock(); }
  } else {
    await finalize();
  }
  return {
    task_id: taskId, deleted: true,
    previous_state: cleanup.previousState, title: cleanup.title,
  };
}
