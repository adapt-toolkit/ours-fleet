import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptTaskTerminalIntent, settleTaskTerminalIntent,
} from '../src/rooms-tasks/terminal.js';
import {
  activateTask, completeTask, createTask, getTask, reviewTask, startTask,
} from '../src/rooms-tasks/task-state.js';
import { activateRoom, createRoomRecord, getRoomRecord } from '../src/rooms-tasks/room-state.js';

const ROOM_ID = '01hzyk8m0000000000000000bb';

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-task-terminal-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function reviewTaskWithRoom() {
  const task = createTask({
    title: 'Terminal saga', origin: { type: 'owner_channel' }, start: false, room_id: ROOM_ID,
  });
  startTask(task.task_id);
  activateTask(task.task_id);
  reviewTask(task.task_id);
  createRoomRecord({ room_id: ROOM_ID, room_name: 'Terminal room', task_id: task.task_id });
  activateRoom(ROOM_ID);
  return getTask(task.task_id);
}

describe('durable task terminal intent', () => {
  it('persists first-wins intent and makes an identical acceptance idempotent', async () => {
    const task = reviewTaskWithRoom();
    const input = {
      taskId: task.task_id, kind: 'done' as const, roomId: ROOM_ID,
      outcome: { summary: 'ship it' },
    };
    const first = await acceptTaskTerminalIntent(input);
    const identical = await acceptTaskTerminalIntent(input);
    expect(identical.terminal_intent).toEqual(first.terminal_intent);
    await expect(acceptTaskTerminalIntent({
      taskId: task.task_id, kind: 'cancelled', roomId: ROOM_ID,
    })).rejects.toThrow(/conflicting 'done' terminal intent/);
    await expect(acceptTaskTerminalIntent({
      taskId: task.task_id, kind: 'done', roomId: ROOM_ID,
      outcome: { summary: 'different' },
    })).rejects.toThrow(/conflicting 'done' terminal intent/);
    await expect(acceptTaskTerminalIntent({
      taskId: task.task_id, kind: 'done', roomId: 'different-room',
      outcome: { summary: 'ship it' },
    })).rejects.toThrow(/conflicting 'done' terminal intent/);
    expect(() => completeTask(task.task_id)).toThrow(/pending 'done' terminal intent/);
    expect(getRoomRecord(ROOM_ID)?.state).toBe('active');
  });

  it('leaves close failure visible and the task nonterminal', async () => {
    const task = reviewTaskWithRoom();
    await acceptTaskTerminalIntent({ taskId: task.task_id, kind: 'done', roomId: ROOM_ID });
    const cowork = { closeRoom: vi.fn(async () => { throw new Error('cowork unavailable'); }) };
    await expect(settleTaskTerminalIntent({ taskId: task.task_id, cowork }))
      .rejects.toThrow('cowork unavailable');
    expect(getTask(task.task_id)).toMatchObject({
      state: 'review',
      terminal_intent: {
        status: 'pending', error: 'cowork unavailable', first_failure: 'cowork unavailable',
        first_recovery_hint: `Retry 'ours-fleet task recover ${task.task_id}'.`,
      },
    });
  });

  it('recovers acceptance before launch and converges without a second intent', async () => {
    const task = reviewTaskWithRoom();
    const accepted = await acceptTaskTerminalIntent({
      taskId: task.task_id, kind: 'done', roomId: ROOM_ID,
    });
    expect(accepted).toMatchObject({ state: 'review', terminal_intent: { status: 'pending' } });

    const cowork = { closeRoom: vi.fn(async () => undefined) };
    const settled = await settleTaskTerminalIntent({ taskId: task.task_id, cowork });
    expect(settled).toMatchObject({
      state: 'done', terminal_intent: { status: 'settled', room_id: ROOM_ID },
    });
    expect(settled.terminal_intent?.settled_at).toBeTruthy();
  });

  it('recovers a crash after room close before the task write without repeating effects', async () => {
    const task = reviewTaskWithRoom();
    await acceptTaskTerminalIntent({ taskId: task.task_id, kind: 'done', roomId: ROOM_ID });
    const cowork = { closeRoom: vi.fn(async () => undefined) };
    await expect(settleTaskTerminalIntent({
      taskId: task.task_id,
      cowork,
      deps: { afterRoomClosed: () => { throw new Error('crash seam'); } },
    })).rejects.toThrow('crash seam');
    expect(getRoomRecord(ROOM_ID)?.state).toBe('closed');
    expect(getTask(task.task_id)).toMatchObject({
      state: 'review', terminal_intent: { status: 'pending', error: 'crash seam' },
    });

    const settled = await settleTaskTerminalIntent({ taskId: task.task_id, cowork });
    expect(settled.state).toBe('done');
    expect(settled.terminal_intent).toMatchObject({
      status: 'settled', first_failure: 'crash seam',
      first_recovery_hint: `Retry 'ours-fleet task recover ${task.task_id}'.`,
    });
    expect(settled.terminal_intent?.error).toBeUndefined();
    expect(cowork.closeRoom).toHaveBeenCalledTimes(1);

    await settleTaskTerminalIntent({ taskId: task.task_id, cowork });
    expect(cowork.closeRoom).toHaveBeenCalledTimes(1);
  });

  it('settles a roomless task immediately', async () => {
    const task = createTask({
      title: 'No room', origin: { type: 'owner_channel' }, start: false, no_room: true,
    });
    const settled = await acceptTaskTerminalIntent({
      taskId: task.task_id, kind: 'cancelled',
    });
    expect(settled).toMatchObject({
      state: 'cancelled', terminal_intent: { kind: 'cancelled', status: 'settled' },
    });
  });
});
