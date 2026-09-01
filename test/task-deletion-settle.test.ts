import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTask, getTask, getDeletingTask, activateTask, reviewTask,
  beginTaskDeletionIntent, taskDeletionState, tasksDir, updateTaskRoom, updateTaskMembers,
  readTaskDeletionReceipt, unlinkDeletedTask,
} from '../src/rooms-tasks/task-state.js';
import { sealLaunchSnapshot } from '../src/rooms-tasks/launch-snapshot.js';
import { withFileLock } from '../src/atomic-file.js';
import { taskOperationLockPath } from '../src/rooms-tasks/terminal.js';
import { stateRoot } from '../src/paths.js';
import {
  acceptTaskDeletion, settleTaskDeletion, DELETION_MEMBER_ABSENT_VERIFIED,
  type TaskDeletionSettleDeps,
} from '../src/rooms-tasks/deletion.js';
import {
  advanceMemberRetirement, beginRoomClose, createRoomRecord, getRoomRecord, listRoomRecords,
  updateMemberSeats,
} from '../src/rooms-tasks/room-state.js';
import { CoworkProtocolError, CoworkUnavailableError } from '../src/rooms-tasks/cowork-adapter.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import type { TaskDeletionActor, TaskRecord } from '../src/rooms-tasks/types.js';

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-dset-'));
  origHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
  else delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const CLI_ACTOR: TaskDeletionActor = { kind: 'local_control', surface: 'cli' };
const CID = 'd'.repeat(64);

function taskFile(id: string): string { return join(tasksDir(), `${id}.json`); }

function coworkThatMustNotBeReached(): never {
  throw new Error('cowork must not be constructed for this settlement');
}

interface CoworkCalls { closed: string[]; deleted: string[] }
function recordingCowork(calls: CoworkCalls, opts?: {
  deleteNotFound?: boolean; closeNotFound?: boolean;
  failDeleteOnce?: { armed: boolean };
}) {
  return {
    closeRoom: async (roomId: string) => {
      calls.closed.push(roomId);
      if (opts?.closeNotFound) throw new CoworkProtocolError('room.close', 'missing', 'not_found');
    },
    deleteRoom: async (roomId: string) => {
      if (opts?.failDeleteOnce?.armed) {
        opts.failDeleteOnce.armed = false;
        throw new CoworkUnavailableError();
      }
      calls.deleted.push(roomId);
      if (opts?.deleteNotFound) throw new CoworkProtocolError('room.delete', 'missing', 'not_found');
    },
  };
}

/** Retirement deps proving the full evidence chain without real supervisors. */
function chainDeps(events: string[], opts?: { tempState?: Set<string>; cidPresent?: Set<string> }): TaskDeletionSettleDeps {
  return {
    hasTempState: name => opts?.tempState?.has(name) ?? false,
    identityCidPresent: async cid => opts?.cidPresent?.has(cid.toLowerCase()) ?? false,
    roomClose: {
      inspectMember: async seat => { events.push(`inspect:${seat.role_name}`); return { launchId: `launch-${seat.role_name}` }; },
      requestStop: async role => { events.push(`stop:${role}`); },
      waitForLivenessAbsent: async role => { events.push(`wait:${role}`); },
      secureArchive: async role => { events.push(`archive:${role}`); return `/archive/${role}`; },
      removeIdentity: async seat => { events.push(`remove:${seat.role_name}`); },
    },
  };
}

function makeNoRoomTask(): TaskRecord {
  return createTask({ title: 'no-room task', origin: { type: 'cli' }, start: false });
}

describe('settleTaskDeletion — no-room tasks', () => {
  it('settles without constructing Cowork or loading rooms config', async () => {
    const t = makeNoRoomTask();
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result).toMatchObject({ task_id: t.task_id, deleted: true, previous_state: 'backlog' });
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('service settles a no-room task even when configuration loading fails', async () => {
    const t = makeNoRoomTask();
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => { throw new Error('configuration must not load for a no-room deletion'); },
    });
    const result = await app.settleTaskDeletion({
      actor: { kind: 'internal_worker', surface: 'cli' }, taskId: t.task_id,
    });
    expect(result.deleted).toBe(true);
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('unlinks a task whose list reference is broken (end to end)', async () => {
    const t = makeNoRoomTask();
    const stored = JSON.parse(readFileSync(taskFile(t.task_id), 'utf8')) as Record<string, unknown>;
    stored.list_id = 'missing-list';
    writeFileSync(taskFile(t.task_id), JSON.stringify(stored));
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result.deleted).toBe(true);
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('repeat settlement after unlink reports already absent', async () => {
    const t = makeNoRoomTask();
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    const again = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(again).toEqual({ task_id: t.task_id, deleted: false });
  });
});

describe('settleTaskDeletion — room path', () => {
  function makeRoomTask(roomId: string): TaskRecord {
    let t = createTask({ title: 'room task', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, roomId, 'a'.repeat(64));
    createRoomRecord({ room_id: roomId, room_name: 'r', task_id: t.task_id });
    return getTask(t.task_id);
  }

  it('closes, checkpoints evidence, tolerantly deletes remote, removes record, unlinks last', async () => {
    const t = makeRoomTask('room-a');
    updateMemberSeats('room-a', [{
      role_name: 'dev-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer',
      seat_state: 'active',
      launch: { state: 'launched', attempt: 1, launch_id: 'launch-dev-1', updated_at: new Date().toISOString() },
    }]);
    updateTaskMembers(t.task_id, [{ name: 'dev-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer' }]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id,
      cowork: () => recordingCowork(calls, { deleteNotFound: true }),
      deps: chainDeps(events, { tempState: new Set(['dev-1']) }),
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual(['inspect:dev-1', 'stop:dev-1', 'wait:dev-1', 'archive:dev-1', 'remove:dev-1']);
    expect(calls.closed).toEqual(['room-a']);
    expect(calls.deleted).toEqual(['room-a']); // not_found tolerated
    expect(getRoomRecord('room-a')).toBeUndefined();
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('records a recoverable error when Cowork is unavailable, then converges on retry', async () => {
    const t = makeRoomTask('room-b');
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const failing = () => ({
      closeRoom: async () => { throw new CoworkUnavailableError(); },
      deleteRoom: async () => { throw new CoworkUnavailableError(); },
    });
    await expect(settleTaskDeletion({ taskId: t.task_id, cowork: failing }))
      .rejects.toThrow(/not reachable/);
    const hidden = getDeletingTask(t.task_id);
    expect(hidden.deletion?.error).toMatch(/not reachable/);
    expect(hidden.deletion?.recovery_hint).toMatch(/task delete/);
    expect(existsSync(taskFile(t.task_id))).toBe(true); // hidden, recoverable, not falsely settled

    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls),
    });
    expect(result.deleted).toBe(true);
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('converges after a crash between room-record deletion and task unlink', async () => {
    const t = makeRoomTask('room-c');
    updateMemberSeats('room-c', [{
      role_name: 'dev-2', identity_cid: CID, slot: 'dev', cowork_role: 'Developer',
      seat_state: 'active',
      launch: { state: 'launched', attempt: 1, launch_id: 'launch-dev-2', updated_at: new Date().toISOString() },
    }]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    // First run: complete room close + evidence checkpoint + record deletion,
    // then simulate the crash by re-arming from the durable state before unlink.
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    beginRoomClose('room-c');
    advanceMemberRetirement('room-c', 'dev-2', 'stop_requested', 'launch-dev-2');
    advanceMemberRetirement('room-c', 'dev-2', 'liveness_absent', 'launch-dev-2');
    advanceMemberRetirement('room-c', 'dev-2', 'archive_secured', 'launch-dev-2', '/archive/dev-2');
    advanceMemberRetirement('room-c', 'dev-2', 'identity_absent', 'launch-dev-2', '/archive/dev-2');
    // Import evidence + delete record, mirroring the settler up to the crash point.
    const { importTaskDeletionRetirementEvidence } = await import('../src/rooms-tasks/task-state.js');
    const { deleteRoomRecord } = await import('../src/rooms-tasks/room-state.js');
    importTaskDeletionRetirementEvidence(t.task_id, getRoomRecord('room-c')!.member_seats);
    deleteRoomRecord('room-c');
    // Retry: cursors already identity_absent — no supervisor work may run.
    const deps = chainDeps(events);
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls, { closeNotFound: true, deleteNotFound: true }),
      deps,
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual([]); // evidence consumed exactly once
    expect(calls.deleted).toContain('room-c'); // tolerant remote cleanup still attempted
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('retires never-launched members through the close saga short path', async () => {
    const t = makeRoomTask('room-d');
    updateMemberSeats('room-d', [{
      role_name: 'ghost-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer',
      seat_state: 'pending',
      launch: { state: 'pending', attempt: 0, updated_at: new Date().toISOString() },
    }]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls), deps: chainDeps(events),
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual(['remove:ghost-1']); // identity removal only; no stop/archive
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });
});

describe('settleTaskDeletion — missing local room record', () => {
  function makeOrphanTask(roomId: string, members: boolean): TaskRecord {
    let t = createTask({ title: 'orphan-room task', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, roomId, 'b'.repeat(64));
    if (members)
      updateTaskMembers(t.task_id, [{ name: 'lost-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer' }]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    return getDeletingTask(t.task_id);
  }

  it('verifies absence via temp state and CID-wide scan, then closes+deletes the remote room', async () => {
    const t = makeOrphanTask('room-x', true);
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id,
      cowork: () => recordingCowork(calls, { closeNotFound: true, deleteNotFound: true }),
      deps: chainDeps(events),
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual([]); // nothing live: no supervisor, no identity
    expect(calls.closed).toContain('room-x');
    expect(calls.deleted).toContain('room-x');
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('runs the full evidence chain when the member temp state is live', async () => {
    const t = makeOrphanTask('room-y', true);
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls),
      deps: chainDeps(events, { tempState: new Set(['lost-1']) }),
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual(['inspect:lost-1', 'stop:lost-1', 'wait:lost-1', 'archive:lost-1', 'remove:lost-1']);
  });

  it('removes a same-name exact-CID identity without temp state, then verifies absence', async () => {
    const t = makeOrphanTask('room-z', true);
    const events: string[] = [];
    const cidPresent = new Set([CID]);
    const deps = chainDeps(events, { cidPresent });
    deps.roomClose!.removeIdentity = async seat => {
      events.push(`remove:${seat.role_name}`);
      cidPresent.delete(CID); // removal proven
    };
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls), deps,
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual(['remove:lost-1']);
  });

  it('blocks settlement when the recorded CID survives under another name', async () => {
    const t = makeOrphanTask('room-w', true);
    const events: string[] = [];
    const deps = chainDeps(events, { cidPresent: new Set([CID]) });
    deps.roomClose!.removeIdentity = async () => { /* name slot empty: no-op */ };
    const calls: CoworkCalls = { closed: [], deleted: [] };
    await expect(settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls), deps,
    })).rejects.toThrow(/survives under another name/);
    const hidden = getDeletingTask(t.task_id);
    expect(hidden.deletion?.error).toMatch(/survives under another name/);
    expect(existsSync(taskFile(t.task_id))).toBe(true);
    // Cursor must still be pending — no false retirement claim.
    expect(hidden.deletion?.members[0].phase).toBe('pending');
  });

  it('marks absent-verified members with the dedicated proof marker', async () => {
    const t = makeOrphanTask('room-v', true);
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    // Capture the cursor state after member retirement by failing the remote
    // close step on the first attempt.
    const failDeleteOnce = { armed: true };
    const failing = () => ({
      closeRoom: async (roomId: string) => { calls.closed.push(roomId); },
      deleteRoom: async () => { throw new CoworkUnavailableError(); },
    });
    await expect(settleTaskDeletion({
      taskId: t.task_id, cowork: failing, deps: chainDeps(events),
    })).rejects.toThrow();
    void failDeleteOnce;
    const hidden = getDeletingTask(t.task_id);
    expect(hidden.deletion?.members[0]).toMatchObject({
      phase: 'identity_absent', launch_id: DELETION_MEMBER_ABSENT_VERIFIED,
    });
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls), deps: chainDeps(events),
    });
    expect(result.deleted).toBe(true);
  });
});

describe('deletion vs provisioning linearization', () => {
  it('aborts room publication with task_deleting before any remote creation', async () => {
    let t = createTask({ title: 'to-provision', origin: { type: 'cli' }, start: false });
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    let created = 0;
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => ({
        rooms: { owner: { provider: 'p', expected_cid: 'c'.repeat(64), role: 'Owner' }, defaults: { attach_owner: false } },
        roomTemplates: { solo: { name: 'solo', version: 1, description: 'solo', members: [] } },
      }) as never,
      cowork: () => ({
        createRoom: async () => { created += 1; return { room_id: 'r-new', identity_cid: 'e'.repeat(64) }; },
      }) as never,
    });
    await expect(app.startTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId: t.task_id, template: 'solo' }))
      .rejects.toThrow(/pending deletion|task_deleting|deleting/);
    expect(created).toBe(0);
    // The record remains deletable and settles cleanly.
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result.deleted).toBe(true);
    void t;
  });

  it('adopts a room published concurrently with acceptance (acceptance linearizes after)', async () => {
    let t = createTask({ title: 'race-provision', origin: { type: 'cli' }, start: false });
    let acceptance: Promise<unknown> | undefined;
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => ({
        rooms: { owner: { provider: 'p', expected_cid: 'c'.repeat(64), role: 'Owner' }, defaults: { attach_owner: false } },
        roomTemplates: { solo: { name: 'solo', version: 1, description: 'solo', members: [] } },
      }) as never,
      cowork: () => ({
        createRoom: async () => {
          // Deletion accepted mid-window: it must block on the operation lock
          // and land only after the room record + task link publish.
          acceptance = acceptTaskDeletion(t.task_id, CLI_ACTOR);
          await new Promise(resolve => setTimeout(resolve, 50));
          return { room_id: 'r-race', identity_cid: 'e'.repeat(64) };
        },
      }) as never,
    });
    await app.startTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId: t.task_id, template: 'solo' });
    expect(getTask(t.task_id).room_id).toBe('r-race'); // publication won the window
    await acceptance!;
    expect(taskDeletionState(t.task_id)).toBe('pending');
    // Settlement adopts the published record: no orphan survives.
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: () => recordingCowork(calls) });
    expect(result.deleted).toBe(true);
    expect(calls.deleted).toContain('r-race');
    expect(getRoomRecord('r-race')).toBeUndefined();
    expect(listRoomRecords().filter(room => room.task_id === t.task_id)).toEqual([]);
  });
});

describe('launch snapshot finalization', () => {
  function taskWithSnapshot(hash: string): TaskRecord {
    const t = makeNoRoomTask();
    const stored = JSON.parse(readFileSync(taskFile(t.task_id), 'utf8')) as Record<string, unknown>;
    stored.execution_plan = {
      schema_version: 1,
      snapshot: { name: 'team', version: 1, description: '', members: [], content_hash: 'h', launch_snapshot_hash: hash },
      overrides: {}, overrides_hash: 'oh', plan_hash: 'ph',
    };
    writeFileSync(taskFile(t.task_id), JSON.stringify(stored));
    return getTask(t.task_id);
  }
  const snapshotPath = (hash: string) => join(stateRoot(), 'launch-snapshots', `${hash}.json`);

  it('deletes the owned snapshot before unlink and completes', async () => {
    const hash = sealLaunchSnapshot({});
    const t = taskWithSnapshot(hash);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    expect(existsSync(snapshotPath(hash))).toBe(true);
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result.deleted).toBe(true);
    expect(existsSync(snapshotPath(hash))).toBe(false);
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });

  it('retains a snapshot still referenced by another retained task', async () => {
    const hash = sealLaunchSnapshot({});
    const t = taskWithSnapshot(hash);
    const survivor = taskWithSnapshot(hash);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result.deleted).toBe(true);
    expect(existsSync(snapshotPath(hash))).toBe(true); // survivor still references it
    expect(existsSync(taskFile(survivor.task_id))).toBe(true);
  });

  it('recovers from a crash after snapshot deletion but before task unlink', async () => {
    const hash = sealLaunchSnapshot({});
    const t = taskWithSnapshot(hash);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    // Crash state: snapshot already gone, hidden deletion-pending task remains.
    rmSync(snapshotPath(hash));
    expect(getDeletingTask(t.task_id).deletion?.status).toBe('pending'); // recoverable
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result.deleted).toBe(true);
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });
});

describe('deletion receipts (durable audit evidence)', () => {
  it('writes the acceptance receipt durably with the intent', () => {
    let t = createTask({ title: 'audited task', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, 'room-r1', 'a'.repeat(64));
    const owner: TaskDeletionActor = { kind: 'authenticated_owner', surface: 'messenger', cid: 'E'.repeat(64) };
    beginTaskDeletionIntent(t.task_id, owner);
    const receipt = readTaskDeletionReceipt(t.task_id);
    expect(receipt).toMatchObject({
      schema_version: 1, task_id: t.task_id, title: 'audited task',
      actor: owner, original_state: 'active', room_id: 'room-r1',
    });
    expect(receipt?.settled_at).toBeUndefined();
  });

  it('completes the receipt on settlement and the receipt outlives the task', async () => {
    const t = makeNoRoomTask();
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(existsSync(taskFile(t.task_id))).toBe(false);
    expect(readTaskDeletionReceipt(t.task_id)).toMatchObject({ result: 'deleted' });
    expect(readTaskDeletionReceipt(t.task_id)?.settled_at).toBeDefined();
  });

  it('heals a crash between unlink and receipt completion on retry', async () => {
    const t = makeNoRoomTask();
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    unlinkDeletedTask(t.task_id); // crash state: task gone, receipt not completed
    expect(readTaskDeletionReceipt(t.task_id)?.settled_at).toBeUndefined();
    const result = await settleTaskDeletion({ taskId: t.task_id, cowork: coworkThatMustNotBeReached });
    expect(result).toEqual({ task_id: t.task_id, deleted: false });
    expect(readTaskDeletionReceipt(t.task_id)).toMatchObject({ result: 'deleted' });
  });
});

describe('gated concurrency and stranger safety', () => {
  it('acceptance blocks on the operation lock; launch evidence published inside the window is retired', async () => {
    let t = createTask({ title: 'gated', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, 'room-gate', 'a'.repeat(64));
    createRoomRecord({ room_id: 'room-gate', room_name: 'r', task_id: t.task_id });
    let acceptanceSettled = false;
    let acceptance: Promise<unknown>;
    await withFileLock(taskOperationLockPath(t.task_id), async () => {
      acceptance = acceptTaskDeletion(t.task_id, CLI_ACTOR)
        .then(result => { acceptanceSettled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(acceptanceSettled).toBe(false); // delete waits for the launch window
      updateMemberSeats('room-gate', [{
        role_name: 'late-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer',
        seat_state: 'active',
        launch: { state: 'launched', attempt: 1, launch_id: 'launch-late-1', updated_at: new Date().toISOString() },
      }]);
      updateTaskMembers(t.task_id, [{ name: 'late-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer' }]);
    });
    await acceptance!;
    expect(acceptanceSettled).toBe(true);
    const events: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls),
      deps: chainDeps(events, { tempState: new Set(['late-1']) }),
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual(['inspect:late-1', 'stop:late-1', 'wait:late-1', 'archive:late-1', 'remove:late-1']);
  });

  it('leaves a same-name different-CID stranger identity untouched', async () => {
    let t = createTask({ title: 'stranger-safe', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, 'room-s', 'b'.repeat(64));
    updateTaskMembers(t.task_id, [{ name: 'twin-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer' }]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const events: string[] = [];
    // A stranger named twin-1 exists with a DIFFERENT CID: our recorded CID is
    // absent from the CID-wide scan, so absence is verified without touching it.
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls, { closeNotFound: true, deleteNotFound: true }),
      deps: chainDeps(events, { cidPresent: new Set(['f'.repeat(64)]) }),
    });
    expect(result.deleted).toBe(true);
    expect(events).toEqual([]); // removeIdentity never called — stranger untouched
  });

  it('retries after evidence import without repeating retirement', async () => {
    let t = createTask({ title: 'retry-no-repeat', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, 'room-e', 'c'.repeat(64));
    createRoomRecord({ room_id: 'room-e', room_name: 'r', task_id: t.task_id });
    updateMemberSeats('room-e', [{
      role_name: 'once-1', identity_cid: CID, slot: 'dev', cowork_role: 'Developer',
      seat_state: 'active',
      launch: { state: 'launched', attempt: 1, launch_id: 'launch-once-1', updated_at: new Date().toISOString() },
    }]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const firstEvents: string[] = [];
    // First run: full retirement + evidence import succeed, remote delete fails.
    const failing = () => ({
      closeRoom: async () => {},
      deleteRoom: async () => { throw new CoworkUnavailableError(); },
    });
    await expect(settleTaskDeletion({
      taskId: t.task_id, cowork: failing,
      deps: chainDeps(firstEvents, { tempState: new Set(['once-1']) }),
    })).rejects.toThrow(/not reachable/);
    expect(firstEvents).toContain('remove:once-1'); // retirement completed
    expect(getDeletingTask(t.task_id).deletion?.members[0].phase).toBe('identity_absent');
    expect(getRoomRecord('room-e')).toBeDefined(); // crash point: record survives
    // Retry: no retirement work may repeat.
    const secondEvents: string[] = [];
    const calls: CoworkCalls = { closed: [], deleted: [] };
    const result = await settleTaskDeletion({
      taskId: t.task_id, cowork: () => recordingCowork(calls), deps: chainDeps(secondEvents),
    });
    expect(result.deleted).toBe(true);
    expect(secondEvents).toEqual([]);
    expect(getRoomRecord('room-e')).toBeUndefined();
    expect(existsSync(taskFile(t.task_id))).toBe(false);
  });
});

describe('recovery routing', () => {
  it('routes a deletion-pending task to the deletion worker without loading configuration', async () => {
    const t = makeNoRoomTask();
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => { throw new Error('configuration must not load for deletion routing'); },
    });
    const begin = await app.beginTaskRecovery({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: t.task_id,
    });
    expect(begin).toEqual({ kind: 'deletion_worker_required', taskId: t.task_id });
  });

  it('provisionMembers refuses a deletion-pending task before touching Cowork', async () => {
    let t = createTask({ title: 'member-guard', origin: { type: 'cli' } });
    t = activateTask(t.task_id);
    updateTaskRoom(t.task_id, 'room-guard', 'a'.repeat(64));
    createRoomRecord({ room_id: 'room-guard', room_name: 'r', task_id: t.task_id, room_identity_cid: 'f'.repeat(64) });
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const { provisionMembers } = await import('../src/rooms-tasks/provision.js');
    await expect(provisionMembers({
      cfg: {} as never,
      cowork: new Proxy({}, { get: () => () => { throw new Error('cowork must not be touched'); } }) as never,
      roomId: 'room-guard', taskId: t.task_id,
      template: { name: 'solo', version: 1, description: '', members: [], content_hash: 'h' },
      binPath: '/bin/true',
    })).rejects.toThrow(/pending deletion/);
  });
});
