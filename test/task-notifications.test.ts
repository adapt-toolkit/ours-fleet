import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createTask, startTask, activateTask, blockTask, unblockTask, reviewTask, completeTask,
  cancelTask, failTask, updateTaskBrief, getTask, beginTaskTerminalIntent, finishTaskTerminalIntent,
  pendingTaskNotifications, acknowledgeTaskNotification, tasksDir, beginTaskDeletionIntent, unlinkDeletedTask,
} from '../src/rooms-tasks/task-state.js';
import { TaskNotificationProducer } from '../src/notifications/task-producer.js';

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OURS_FLEET_HOME;
  mkdirSync('.test-artifacts', { recursive: true });
  process.env.OURS_FLEET_HOME = mkdtempSync(join('.test-artifacts', 'task-notifications-'));
});
afterEach(() => { if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; });
const create = (extra = {}) => createTask({ title: 'Notification task', origin: { type: 'cli' }, start: false, ...extra });
const events = (id: string) => pendingTaskNotifications().find(t => t.taskId === id)?.events ?? [];

it('commits creation and every effective state atomically, including block/unblock without reason-only duplicates', () => {
  const task = create({ idempotency_key: 'retry' });
  expect(create({ idempotency_key: 'retry' }).task_id).toBe(task.task_id);
  expect(task.list_id).toBe('default'); expect(task.list_name).toBe('default');
  updateTaskBrief(task.task_id, 'description', '');
  startTask(task.task_id); activateTask(task.task_id); blockTask(task.task_id, 'first');
  blockTask(task.task_id, 'reason edit'); unblockTask(task.task_id); blockTask(task.task_id, 'again');
  reviewTask(task.task_id); completeTask(task.task_id);
  const pending = events(task.task_id);
  expect(pending.map(e => e.body.split(': ')[1])).toEqual([
    'created in backlog.', 'backlog → provisioning.', 'provisioning → active.',
    'active → active (blocked).', 'active (blocked) → active.', 'active → active (blocked).',
    'active (blocked) → review.', 'review → done.',
  ]);
  expect(new Set(pending.map(e => e.eventId)).size).toBe(pending.length);
  for (const e of pending) { expect(e.taskId).toBe(task.task_id); expect(e.url).toBe(`/fleet/tasks/${task.task_id}`); }
  expect(() => reviewTask(task.task_id)).toThrow(); expect(events(task.task_id)).toEqual(pending);
});

it('covers failed, cancelled and idempotent terminal intent settlement without announcing pending intent', () => {
  const failed = create({ start: true }); failTask(failed.task_id, 'failure');
  expect(events(failed.task_id).map(e => e.body.split(': ')[1])).toEqual(['created in provisioning.', 'provisioning → failed.']);
  const cancelled = create(); cancelTask(cancelled.task_id);
  expect(events(cancelled.task_id).at(-1)?.body).toContain('backlog → cancelled');
  const done = create({ start: true }); activateTask(done.task_id); reviewTask(done.task_id);
  const before = events(done.task_id).length;
  beginTaskTerminalIntent(done.task_id, { kind: 'done' }); expect(events(done.task_id)).toHaveLength(before);
  finishTaskTerminalIntent(done.task_id); finishTaskTerminalIntent(done.task_id);
  expect(events(done.task_id)).toHaveLength(before + 1);
});

it('acknowledges under task lock without losing a newer state or reviving delivered events on metadata edit', () => {
  const task = create(); const first = events(task.task_id)[0]; startTask(task.task_id);
  acknowledgeTaskNotification(task.task_id, first.eventId);
  updateTaskBrief(task.task_id, 'edited', '');
  expect(events(task.task_id)).toHaveLength(1); expect(events(task.task_id)[0].body).toContain('provisioning');
  acknowledgeTaskNotification(task.task_id, first.eventId); expect(events(task.task_id)).toHaveLength(1);
});

it('keeps events across removal and acknowledges duplicate pre-unlink copies', () => {
  const task = create(); cancelTask(task.task_id);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  const pending = events(task.task_id);
  expect(unlinkDeletedTask(task.task_id)).toBe(true);
  expect(events(task.task_id).slice(0, -1)).toEqual(pending);
  expect(events(task.task_id).at(-1)?.body).toContain('deleting → deleted');
  expect(events(task.task_id).at(-1)?.url).toBe(`/fleet/tasks?deletedTask=${task.task_id}`);
  for (const e of events(task.task_id)) acknowledgeTaskNotification(task.task_id, e.eventId);
  expect(events(task.task_id)).toEqual([]);
});

it('does not send an event whose task atomic write never committed', () => {
  const task = create(); const file = join(tasksDir(), task.task_id + '.json');
  const before = readFileSync(file, 'utf8');
  // A prepared temp snapshot has no authority until rename publishes it.
  writeFileSync(file + '.uncommitted.tmp', JSON.stringify({ ...getTask(task.task_id), state: 'review' }));
  expect(events(task.task_id)).toHaveLength(1); expect(readFileSync(file, 'utf8')).toBe(before);
});

it('retries canonical payload after acceptance-before-ack crash and isolates another task from HTTP rejection', async () => {
  const a = create(), b = create(); const seen = new Map<string, unknown>(); let fail = true;
  const config = { origin: 'http://127.0.0.1:1', token: 'x'.repeat(40) };
  const request = (async (_url, options) => {
    const e = JSON.parse(options!.body as string);
    if (e.taskId === a.task_id && fail) { seen.set(e.eventId, e); return new Response('', { status: 503 }); }
    // The service has already seen A's identical payload, as after response loss.
    if (seen.has(e.eventId)) expect(e).toEqual(seen.get(e.eventId));
    seen.set(e.eventId, e); return new Response('{}');
  }) as typeof fetch;
  const producer = new TaskNotificationProducer(config, undefined, request);
  await producer.drain(); await producer.close();
  expect(events(a.task_id)).toHaveLength(1); expect(events(b.task_id)).toHaveLength(0);
  fail = false;
  const restarted = new TaskNotificationProducer(config, undefined, request);
  await restarted.drain(); await restarted.close();
  expect(events(a.task_id)).toHaveLength(0); expect(seen.size).toBe(2);
});

it('continues admitted task deliveries when another task record is corrupt', async () => {
  const valid = create(), corrupt = create();
  writeFileSync(join(tasksDir(), corrupt.task_id + '.json'), '{invalid');
  const warnings: string[] = [], sent: unknown[] = [];
  const producer = new TaskNotificationProducer({ origin: 'http://127.0.0.1:1', token: 'x'.repeat(40) },
    line => warnings.push(line), (async (_url, options) => {
      sent.push(JSON.parse(options!.body as string)); return new Response('{}');
    }) as typeof fetch);
  await producer.drain(); await producer.close();
  expect(sent).toHaveLength(1); expect(events(valid.task_id)).toEqual([]);
  expect(warnings.some(line => line.includes('other task deliveries continue'))).toBe(true);
});
