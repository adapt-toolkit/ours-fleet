import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTask, getTask, listTasks, findByIdempotencyKey,
  startTask, activateTask, blockTask, unblockTask,
  reviewTask, completeTask, cancelTask, failTask,
  beginTaskTerminalIntent, finishTaskTerminalIntent,
  beginTaskDeletionIntent, setTaskDeletionError, advanceTaskDeletionMember,
  unlinkDeletedTask, updateTaskRoom, updateTaskMembers, moveTaskToList,
  tasksDir, TaskStateError,
} from '../src/rooms-tasks/task-state.js';
import { acceptTaskDeletion, recordTaskDeletionError } from '../src/rooms-tasks/deletion.js';
import { acceptTaskTerminalIntent, settleTaskTerminalIntent } from '../src/rooms-tasks/terminal.js';
import { createRoomRecord } from '../src/rooms-tasks/room-state.js';
import type { TaskDeletionActor, TaskRecord, TaskState } from '../src/rooms-tasks/types.js';

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-del-'));
  origHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
  else delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const CLI_ACTOR: TaskDeletionActor = { kind: 'local_control', surface: 'cli' };

function makeTask(state: TaskState, opts?: { blocked?: boolean }): TaskRecord {
  let t = createTask({ title: `task in ${state}`, origin: { type: 'cli' }, start: state !== 'backlog' });
  if (state === 'backlog' || state === 'provisioning') {
    if (opts?.blocked) t = blockTask(t.task_id, 'test block');
    return t;
  }
  t = activateTask(t.task_id);
  if (state === 'active') {
    if (opts?.blocked) t = blockTask(t.task_id, 'test block');
    return t;
  }
  if (state === 'cancelled') return cancelTask(t.task_id);
  if (state === 'failed') return failTask(t.task_id, 'boom');
  t = reviewTask(t.task_id);
  if (state === 'review') {
    if (opts?.blocked) t = blockTask(t.task_id, 'test block');
    return t;
  }
  return completeTask(t.task_id);
}

const EVERY_STATE: TaskState[] = [
  'backlog', 'provisioning', 'active', 'review', 'done', 'cancelled', 'failed',
];

describe('beginTaskDeletionIntent', () => {
  for (const state of EVERY_STATE) {
    it(`accepts deletion for a '${state}' task`, () => {
      const t = makeTask(state);
      const result = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
      expect(result.status).toBe('accepted');
      if (result.status === 'already_absent') throw new Error('unreachable');
      expect(result.task.deletion?.status).toBe('pending');
      expect(result.task.deletion?.actor).toEqual(CLI_ACTOR);
      expect(result.task.state).toBe(state); // no false transition
    });
  }

  it('accepts deletion for a blocked task and keeps the overlay', () => {
    const t = makeTask('active', { blocked: true });
    const result = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    if (result.status === 'already_absent') throw new Error('unreachable');
    expect(result.status).toBe('accepted');
    expect(result.task.blocked?.reason).toBe('test block');
  });

  it('accepts deletion over a pending done terminal intent (partially settled)', async () => {
    const t = makeTask('review');
    updateTaskRoom(t.task_id, 'room-1', 'a'.repeat(64));
    createRoomRecord({ room_id: 'room-1', room_name: 'r', task_id: t.task_id });
    await acceptTaskTerminalIntent({ taskId: t.task_id, kind: 'done', roomId: 'room-1' });
    expect(getTask(t.task_id).terminal_intent?.status).toBe('pending');
    const result = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    if (result.status === 'already_absent') throw new Error('unreachable');
    expect(result.status).toBe('accepted');
    expect(result.task.terminal_intent?.status).toBe('pending'); // retained, superseded
    expect(result.task.deletion?.status).toBe('pending');
  });

  it('accepts deletion over a pending cancel terminal intent', async () => {
    const t = makeTask('active');
    updateTaskRoom(t.task_id, 'room-2', 'b'.repeat(64));
    createRoomRecord({ room_id: 'room-2', room_name: 'r', task_id: t.task_id });
    await acceptTaskTerminalIntent({ taskId: t.task_id, kind: 'cancelled', roomId: 'room-2' });
    const result = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    expect(result.status).toBe('accepted');
  });

  it('re-arms idempotently while pending and preserves the original acceptance', () => {
    const t = makeTask('done');
    const first = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    if (first.status === 'already_absent') throw new Error('unreachable');
    const owner: TaskDeletionActor = { kind: 'authenticated_owner', surface: 'messenger', cid: 'C'.repeat(64) };
    const second = beginTaskDeletionIntent(t.task_id, owner);
    if (second.status === 'already_absent') throw new Error('unreachable');
    expect(second.status).toBe('pending');
    expect(second.task.deletion?.actor).toEqual(CLI_ACTOR); // first-wins audit
    expect(second.task.deletion?.accepted_at).toBe(first.task.deletion?.accepted_at);
  });

  it('reports already_absent for a missing task', () => {
    expect(beginTaskDeletionIntent('0'.repeat(9) + 'a'.repeat(8), CLI_ACTOR))
      .toEqual({ status: 'already_absent' });
  });

  it('rejects non-canonical IDs before touching any path', () => {
    expect(() => beginTaskDeletionIntent('../outside', CLI_ACTOR)).toThrow(/invalid task ID/);
    expect(() => setTaskDeletionError('../outside', 'e', 'h')).toThrow(/invalid task ID/);
    expect(() => advanceTaskDeletionMember('../outside', 'm', 'pending')).toThrow(/invalid task ID/);
    expect(() => unlinkDeletedTask('../outside')).toThrow(/invalid task ID/);
  });

  it('snapshots managed members with identity CIDs at acceptance', () => {
    const t = makeTask('active');
    updateTaskMembers(t.task_id, [
      { name: 'dev-1', identity_cid: 'd'.repeat(64), slot: 'dev', cowork_role: 'Developer' },
    ]);
    const result = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    if (result.status === 'already_absent') throw new Error('unreachable');
    expect(result.task.deletion?.members).toEqual([expect.objectContaining({
      name: 'dev-1', identity_cid: 'd'.repeat(64), phase: 'pending',
    })]);
  });

  it('records the authenticated owner actor with its CID', () => {
    const t = makeTask('backlog');
    const owner: TaskDeletionActor = { kind: 'authenticated_owner', surface: 'messenger', cid: 'E'.repeat(64) };
    const result = beginTaskDeletionIntent(t.task_id, owner);
    if (result.status === 'already_absent') throw new Error('unreachable');
    expect(result.task.deletion?.actor).toEqual(owner);
  });

  it('accepts deletion even when the task references a missing list', () => {
    const t = makeTask('backlog');
    const p = join(tasksDir(), `${t.task_id}.json`);
    const stored = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    stored.list_id = 'missing-list';
    writeFileSync(p, JSON.stringify(stored));
    const result = beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    expect(result.status).toBe('accepted');
  });
});

describe('deletion guards', () => {
  it('rejects every lifecycle mutation once deletion is pending, with deletion guidance', () => {
    const t = makeTask('backlog');
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const pendingDeletion = /pending deletion/;
    expect(() => startTask(t.task_id)).toThrow(pendingDeletion);
    expect(() => activateTask(t.task_id)).toThrow(pendingDeletion);
    expect(() => blockTask(t.task_id, 'x')).toThrow(pendingDeletion);
    expect(() => unblockTask(t.task_id)).toThrow(pendingDeletion);
    expect(() => reviewTask(t.task_id)).toThrow(pendingDeletion);
    expect(() => completeTask(t.task_id)).toThrow(pendingDeletion);
    expect(() => cancelTask(t.task_id)).toThrow(pendingDeletion);
    expect(() => failTask(t.task_id, 'x')).toThrow(pendingDeletion);
    expect(() => updateTaskRoom(t.task_id, 'r', 'f'.repeat(64))).toThrow(pendingDeletion);
    expect(() => updateTaskMembers(t.task_id, [])).toThrow(pendingDeletion);
    expect(() => moveTaskToList(t.task_id, 'other')).toThrow(pendingDeletion);
    expect(() => beginTaskTerminalIntent(t.task_id, { kind: 'cancelled' })).toThrow(pendingDeletion);
  });

  it('reports deletion guidance, not the stale terminal-intent error, when both are pending', async () => {
    const t = makeTask('review');
    updateTaskRoom(t.task_id, 'room-3', 'a'.repeat(64));
    createRoomRecord({ room_id: 'room-3', room_name: 'r', task_id: t.task_id });
    await acceptTaskTerminalIntent({ taskId: t.task_id, kind: 'done', roomId: 'room-3' });
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    expect(() => blockTask(t.task_id, 'x')).toThrow(/pending deletion/);
    expect(() => finishTaskTerminalIntent(t.task_id)).toThrow(/pending deletion/);
  });

  it('aborts terminal settlement before any room side effect once deletion wins', async () => {
    const t = makeTask('review');
    updateTaskRoom(t.task_id, 'room-4', 'a'.repeat(64));
    createRoomRecord({ room_id: 'room-4', room_name: 'r', task_id: t.task_id });
    await acceptTaskTerminalIntent({ taskId: t.task_id, kind: 'done', roomId: 'room-4' });
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    let touched = 0;
    const cowork = {
      closeRoom: async () => { touched += 1; },
      deleteRoom: async () => { touched += 1; },
    };
    await expect(settleTaskTerminalIntent({ taskId: t.task_id, cowork }))
      .rejects.toThrow(/pending deletion/);
    expect(touched).toBe(0);
    // The bounded failure must not corrupt the retained terminal intent.
    expect(getTask(t.task_id).terminal_intent?.status).toBe('pending');
  });
});

describe('deletion visibility', () => {
  it('hides deletion-pending tasks from listTasks by default and exposes them on demand', () => {
    const kept = makeTask('active');
    const doomed = makeTask('active');
    beginTaskDeletionIntent(doomed.task_id, CLI_ACTOR);
    const visible = listTasks().map(task => task.task_id);
    expect(visible).toContain(kept.task_id);
    expect(visible).not.toContain(doomed.task_id);
    const admin = listTasks({ includeDeleting: true }).map(task => task.task_id);
    expect(admin).toContain(doomed.task_id);
  });

  it('excludes deletion-pending tasks from idempotency lookup', () => {
    const t = createTask({ title: 'keyed', origin: { type: 'cli' }, idempotency_key: 'key-1', start: false });
    expect(findByIdempotencyKey('key-1')?.task_id).toBe(t.task_id);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    expect(findByIdempotencyKey('key-1')).toBeUndefined();
  });

  it('getTask stays precise for admin/status surfaces', () => {
    const t = makeTask('active');
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const shown = getTask(t.task_id);
    expect(shown.deletion?.status).toBe('pending');
    expect(shown.state).toBe('active');
  });
});

describe('setTaskDeletionError', () => {
  it('records first and latest failures with monotonic timestamps', () => {
    const t = makeTask('done');
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    const first = setTaskDeletionError(t.task_id, 'first boom', 'retry once');
    const second = setTaskDeletionError(t.task_id, 'second boom', 'retry twice');
    expect(second.deletion?.first_failure).toBe('first boom');
    expect(second.deletion?.first_recovery_hint).toBe('retry once');
    expect(second.deletion?.error).toBe('second boom');
    expect(second.deletion?.recovery_hint).toBe('retry twice');
    expect(Date.parse(second.deletion!.error_at!)).toBeGreaterThan(Date.parse(first.deletion!.error_at!));
  });

  it('rejects when no deletion is pending', () => {
    const t = makeTask('done');
    expect(() => setTaskDeletionError(t.task_id, 'e', 'h')).toThrow(/no pending deletion/);
  });
});

describe('advanceTaskDeletionMember', () => {
  function deletionWithMember(): string {
    const t = makeTask('active');
    updateTaskMembers(t.task_id, [
      { name: 'dev-1', identity_cid: 'd'.repeat(64), slot: 'dev', cowork_role: 'Developer' },
    ]);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    return t.task_id;
  }

  it('advances forward with evidence and rejects regression', () => {
    const id = deletionWithMember();
    advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-1');
    advanceTaskDeletionMember(id, 'dev-1', 'liveness_absent');
    advanceTaskDeletionMember(id, 'dev-1', 'archive_secured', undefined, '/archive/dev-1');
    const done = advanceTaskDeletionMember(id, 'dev-1', 'identity_absent');
    expect(done.deletion?.members[0]).toMatchObject({
      phase: 'identity_absent', launch_id: 'launch-1', archive_path: '/archive/dev-1',
    });
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'stop_requested'))
      .toThrow(/cannot move back/);
  });

  it('requires launch ownership proof for launched phases', () => {
    const id = deletionWithMember();
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'stop_requested'))
      .toThrow(/launch ownership proof/);
  });

  it('keeps launch_id immutable once recorded', () => {
    const id = deletionWithMember();
    advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-1');
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'liveness_absent', 'launch-2'))
      .toThrow(/immutable/);
  });

  it('requires archive evidence for archive_secured', () => {
    const id = deletionWithMember();
    advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-1');
    advanceTaskDeletionMember(id, 'dev-1', 'liveness_absent');
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'archive_secured'))
      .toThrow(/archive evidence/);
  });

  it('rejects skipping phases even with a real launch proof', () => {
    const id = deletionWithMember();
    advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-1');
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'identity_absent'))
      .toThrow(/cannot skip/);
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'archive_secured', undefined, '/a'))
      .toThrow(/cannot skip/);
  });

  it('same-phase retries are idempotent but cannot rewrite evidence', () => {
    const id = deletionWithMember();
    advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-1');
    const retry = advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-1');
    expect(retry.deletion?.members[0].phase).toBe('stop_requested');
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'stop_requested', 'launch-2'))
      .toThrow(/immutable/);
  });

  it('restricts the short path to the never-launched proof marker', () => {
    const id = deletionWithMember();
    expect(() => advanceTaskDeletionMember(id, 'dev-1', 'identity_absent', 'launch-1'))
      .toThrow(/cannot skip/);
  });

  it('allows the never-launched short path with an explicit proof marker', () => {
    const id = deletionWithMember();
    const t = advanceTaskDeletionMember(id, 'dev-1', 'identity_absent', 'never-launched');
    expect(t.deletion?.members[0].phase).toBe('identity_absent');
  });

  it('rejects unknown member cursors', () => {
    const id = deletionWithMember();
    expect(() => advanceTaskDeletionMember(id, 'ghost', 'stop_requested', 'l'))
      .toThrow(/no member cursor/);
  });
});

describe('unlinkDeletedTask', () => {
  it('removes only deletion-pending records and is idempotent afterwards', () => {
    const t = makeTask('cancelled');
    expect(() => unlinkDeletedTask(t.task_id)).toThrow(/no pending deletion/);
    beginTaskDeletionIntent(t.task_id, CLI_ACTOR);
    expect(unlinkDeletedTask(t.task_id)).toBe(true);
    expect(existsSync(join(tasksDir(), `${t.task_id}.json`))).toBe(false);
    expect(unlinkDeletedTask(t.task_id)).toBe(false);
    expect(beginTaskDeletionIntent(t.task_id, CLI_ACTOR)).toEqual({ status: 'already_absent' });
  });
});

describe('acceptTaskDeletion (operation-lock wrapper)', () => {
  it('accepts under the task-operation lock and records errors through the same lock', async () => {
    const t = makeTask('failed');
    const result = await acceptTaskDeletion(t.task_id, CLI_ACTOR);
    expect(result.status).toBe('accepted');
    const errored = await recordTaskDeletionError(t.task_id, 'worker died', 'retry');
    expect(errored.deletion?.error).toBe('worker died');
  });
});
