import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  acknowledgeTaskProgress, acknowledgeTaskReview, beginTaskDeletionIntent, cancelTask, contributionUnread,
  convertRetiredTaskNotifications, createTask, getTask, pendingTaskNotifications, tasksDir, unlinkDeletedTask,
  updateTaskRoom,
} from '../src/rooms-tasks/task-state.js';
import { appendTaskProgress, setTaskReviewMarkdown, taskContributionSummary } from '../src/rooms-tasks/task-review.js';
import { missionCleanupDir, pendingMissionCleanups } from '../src/rooms-tasks/notification-manifest.js';

const ROOM = 'a'.repeat(64), LAYOUT = 'b'.repeat(64);
const author = { kind: 'agent', role: 'dev-1', surface: 'mcp' } as const;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OURS_FLEET_HOME;
  mkdirSync('.test-artifacts', { recursive: true });
  process.env.OURS_FLEET_HOME = mkdtempSync(join('.test-artifacts', 'mission-notifications-'));
});
afterEach(() => { if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; });
const create = () => createTask({ title: 'Mission', origin: { type: 'cli' }, start: false });
const events = (id: string) => pendingTaskNotifications().find(t => t.taskId === id)?.events ?? [];
const file = (id: string) => join(tasksDir(), `${id}.json`);
/** Write a stored record as an earlier release left it (no read state, optionally no review revision). */
function legacy(id: string, change: (record: any) => void) {
  const record = JSON.parse(readFileSync(file(id), 'utf8')); change(record);
  writeFileSync(file(id), JSON.stringify(record, null, 2));
}

it('state transitions are push-only events', () => {
  const task = create();
  expect(events(task.task_id).map(e => e.delivery)).toEqual(['push-only']);
});

it('deletion acceptance drops queued transitions, produces no deleting/deleted event and queues one merged cleanup intent', () => {
  const task = create();
  updateTaskRoom(task.task_id, 'room-1', ROOM);
  cancelTask(task.task_id);
  expect(events(task.task_id).length).toBeGreaterThan(0);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  expect(events(task.task_id)).toEqual([]);
  expect(getTask(task.task_id).notification_manifest?.room_cids).toEqual([ROOM.toUpperCase()]);
  expect(pendingMissionCleanups()).toEqual([{ schema: 1, taskId: task.task_id, contactIds: [ROOM.toUpperCase()] }]);
  // A retried acceptance heals a missing intent; unlink merges and emits nothing.
  const cleanupFile = join(missionCleanupDir(), `${task.task_id}.json`);
  expect(existsSync(cleanupFile)).toBe(true);
  rmSync(cleanupFile);
  expect(existsSync(cleanupFile)).toBe(false);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  expect(existsSync(cleanupFile)).toBe(true);
  expect(pendingMissionCleanups()).toHaveLength(1);
  expect(unlinkDeletedTask(task.task_id)).toBe(true);
  expect(events(task.task_id)).toEqual([]);
  expect(existsSync(join(tasksDir(), '.notification-retired', `${task.task_id}.json`))).toBe(false);
  expect(pendingMissionCleanups()[0].contactIds).toEqual([ROOM.toUpperCase()]);
});

it('a legacy retired-event file becomes a cleanup intent and is never delivered', () => {
  const task = create(); cancelTask(task.task_id);
  const retired = join(tasksDir(), '.notification-retired'); mkdirSync(retired, { recursive: true });
  writeFileSync(join(retired, `${task.task_id}.json`), JSON.stringify({ notification_events: events(task.task_id) }));
  expect(convertRetiredTaskNotifications()).toBe(0);              // the task still exists: no authority
  rmSync(file(task.task_id));
  expect(pendingTaskNotifications().find(t => t.taskId === task.task_id)).toBeUndefined();
  expect(convertRetiredTaskNotifications()).toBe(1);
  expect(existsSync(join(retired, `${task.task_id}.json`))).toBe(false);
  expect(pendingMissionCleanups().map(i => i.taskId)).toEqual([task.task_id]);
});

it('the manifest keeps every room it ever recorded', () => {
  const task = create();
  updateTaskRoom(task.task_id, 'room-1', ROOM);
  updateTaskRoom(task.task_id, 'room-2', LAYOUT);
  expect(getTask(task.task_id).notification_manifest).toEqual({ revision: 2, room_cids: [ROOM.toUpperCase(), LAYOUT.toUpperCase()] });
});

it('pre-upgrade contributions stay read; the first later change snapshots them read and only new items are unread', () => {
  const task = create();
  appendTaskProgress(task.task_id, { text: 'old milestone', author });
  setTaskReviewMarkdown(task.task_id, { markdown: '# old', expectedMarkdown: '', author });
  legacy(task.task_id, record => { delete record.contribution_reads; delete record.review.revision; });
  // A read before any change records nothing and creates no unread.
  expect(acknowledgeTaskProgress(task.task_id, ['unknown'])).toEqual({ progress: 0, review: false });
  expect(taskContributionSummary(getTask(task.task_id))).toMatchObject({ progress_unread: 0, review_unread: false, review: { revision: 1 } });
  const fresh = appendTaskProgress(task.task_id, { text: 'new milestone', author }).entry;
  const concurrent = appendTaskProgress(task.task_id, { text: 'concurrent', author }).entry;
  expect(contributionUnread(getTask(task.task_id))).toEqual({ progress: 2, review: false });
  // Only the viewed entry is acknowledged; the concurrent one stays unread. Unknown IDs are ignored.
  expect(acknowledgeTaskProgress(task.task_id, [fresh.id, 'unknown'])).toEqual({ progress: 1, review: false });
  expect(acknowledgeTaskProgress(task.task_id, [fresh.id])).toEqual({ progress: 1, review: false });
  expect(acknowledgeTaskProgress(task.task_id, [concurrent.id]).progress).toBe(0);
  // The legacy package presented as revision 1; its next change is 2 and becomes unread.
  setTaskReviewMarkdown(task.task_id, { markdown: '# changed', expectedMarkdown: '# old', author });
  expect(getTask(task.task_id).review?.revision).toBe(2);
  expect(contributionUnread(getTask(task.task_id)).review).toBe(true);
  expect(() => acknowledgeTaskReview(task.task_id, 3)).toThrow();
  expect(acknowledgeTaskReview(task.task_id, 1).review).toBe(true);    // a stale render never acknowledges a newer revision
  expect(acknowledgeTaskReview(task.task_id, 2).review).toBe(false);
  expect(acknowledgeTaskReview(task.task_id, 1).review).toBe(false);   // never moves backwards
});

it('removing everything is a new review revision and unread once; a pristine task is never unread', () => {
  const pristine = create();
  expect(contributionUnread(getTask(pristine.task_id))).toEqual({ progress: 0, review: false });
  const task = create();
  appendTaskProgress(task.task_id, { text: 'start', author });
  setTaskReviewMarkdown(task.task_id, { markdown: 'package', expectedMarkdown: '', author });
  acknowledgeTaskReview(task.task_id, getTask(task.task_id).review!.revision!);
  setTaskReviewMarkdown(task.task_id, { markdown: '', expectedMarkdown: 'package', author });
  expect(contributionUnread(getTask(task.task_id)).review).toBe(true);
  acknowledgeTaskReview(task.task_id, getTask(task.task_id).review!.revision!);
  expect(contributionUnread(getTask(task.task_id)).review).toBe(false);
});

it('new Progress entries and review revisions push once each; reads and idempotent replays produce nothing', () => {
  const task = create();
  const before = events(task.task_id).length;
  const entry = appendTaskProgress(task.task_id, { text: 'milestone **one**', author, requestKey: 'k1' }).entry;
  appendTaskProgress(task.task_id, { text: 'milestone **one**', author, requestKey: 'k1' });
  setTaskReviewMarkdown(task.task_id, { markdown: 'r', expectedMarkdown: '', author });
  setTaskReviewMarkdown(task.task_id, { markdown: 'r', expectedMarkdown: '', author });
  const added = events(task.task_id).slice(before);
  expect(added.map(e => e.eventId)).toEqual([`task:${task.task_id}:progress:${entry.id}`, `task:${task.task_id}:review:1`]);
  expect(added.every(e => e.delivery === 'push-only' && e.target.kind === 'task')).toBe(true);
  expect(added[0].body).toBe('milestone **one**');
  acknowledgeTaskProgress(task.task_id, [entry.id]);
  acknowledgeTaskReview(task.task_id, 1);
  expect(events(task.task_id).slice(before)).toEqual(added);
});
