import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fault = vi.hoisted(() => ({ unlink: '', rename: '' }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual,
    unlinkSync(path: string) { if (path === fault.unlink) throw Object.assign(Error('injected unlink failure'), { code: 'EACCES' }); return actual.unlinkSync(path); },
    renameSync(from: string, to: string) { if (to === fault.rename) throw Object.assign(Error('injected rename failure'), { code: 'EIO' }); return actual.renameSync(from, to); },
  };
});
import { createTask, startTask, cancelTask, tasksDir, getTask, pendingTaskNotifications,
  beginTaskDeletionIntent, unlinkDeletedTask, acknowledgeTaskNotification } from '../src/rooms-tasks/task-state.js';
import { TaskNotificationProducer } from '../src/notifications/task-producer.js';
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OURS_FLEET_HOME; mkdirSync('.test-artifacts', {recursive:true});
  process.env.OURS_FLEET_HOME = mkdtempSync(join('.test-artifacts', 'task-notification-fault-'));
});
afterEach(() => { fault.unlink = fault.rename = ''; if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; });
const create = () => createTask({ title: 'Fault fixture', origin: {type:'cli'}, start:false });
it('failed atomic state rename leaves both status and event unchanged', () => {
  const task = create(), before = pendingTaskNotifications();
  fault.rename = join(tasksDir(), task.task_id + '.json');
  expect(() => startTask(task.task_id)).toThrow('injected rename failure');
  expect(getTask(task.task_id).state).toBe('backlog'); expect(pendingTaskNotifications()).toEqual(before);
});
it('failed unlink never admits the prepared deleted event; retry preserves acknowledgement and stable final event', () => {
  const task = create(); cancelTask(task.task_id); beginTaskDeletionIntent(task.task_id, {kind:'local_control',surface:'cli'});
  fault.unlink = join(tasksDir(), task.task_id + '.json');
  expect(() => unlinkDeletedTask(task.task_id)).toThrow('injected unlink failure');
  const prepared = JSON.parse(readFileSync(join(tasksDir(), '.notification-retired', task.task_id + '.json'), 'utf8')).notification_events;
  expect(prepared.at(-1).body).toContain('deleting → deleted');
  expect(pendingTaskNotifications().flatMap(t => t.events).some(e => e.eventId.endsWith(':deleted'))).toBe(false);
  for (const e of pendingTaskNotifications().flatMap(t => t.events)) acknowledgeTaskNotification(task.task_id, e.eventId);
  fault.unlink = ''; expect(unlinkDeletedTask(task.task_id)).toBe(true);
  expect(pendingTaskNotifications().flatMap(t => t.events)).toEqual([prepared.at(-1)]);
});
it('acceptance then failed acknowledgement replays identical event after producer restart', async () => {
  const task = create(); fault.rename = join(tasksDir(), task.task_id + '.json');
  let sends = 0; const accepted = new Map<string, unknown>();
  const request = (async (_url, options) => {
    sends++; const payload = JSON.parse(options!.body as string);
    if (accepted.has(payload.eventId)) expect(payload).toEqual(accepted.get(payload.eventId));
    accepted.set(payload.eventId, payload); return new Response('{}');
  }) as typeof fetch;
  const config = {origin:'http://127.0.0.1:1',token:'x'.repeat(40)};
  let sender = new TaskNotificationProducer(config, undefined, request);
  await sender.drain(); await sender.close(); expect(pendingTaskNotifications()).toHaveLength(1);
  fault.rename = ''; sender = new TaskNotificationProducer(config, undefined, request);
  await sender.drain(); await sender.close();
  expect(sends).toBe(2); expect(accepted.size).toBe(1); expect(pendingTaskNotifications()).toEqual([]);
});
