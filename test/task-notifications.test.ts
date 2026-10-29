import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  for (const e of pending) { expect(e.taskId).toBe(task.task_id); expect(e.target).toEqual({kind:'task',taskId:task.task_id});expect(e).not.toHaveProperty('url'); }
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

it('deletion acceptance retires queued events and removal produces no deletion event', () => {
  const task = create(); cancelTask(task.task_id);
  expect(events(task.task_id).length).toBeGreaterThan(0);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  expect(events(task.task_id)).toEqual([]);
  expect(unlinkDeletedTask(task.task_id)).toBe(true);
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

it.each([403, 503, 'unreachable'] as const)('attempts startup registration once after %s, while task event delivery continues without registration retries', async status => {
  const task = create(), warnings: string[] = [], calls: string[] = [];
  const request = (async (url) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    if (path.endsWith('/bootstrap') && status === 'unreachable') throw Error('unreachable');
    return new Response('{}', { status: path.endsWith('/bootstrap') && typeof status === 'number' ? status : 200 });
  }) as typeof fetch;
  vi.useFakeTimers();
  const producer = new TaskNotificationProducer({ origin: 'http://127.0.0.1:1', token: 'x'.repeat(40) },
    line => warnings.push(line), request, { tasks: () => [getTask(task.task_id)], layoutRooms: () => [] });
  try {
    await producer.drain();
    expect(events(task.task_id)).toEqual([]);
    expect(calls.filter(path => path.endsWith('/bootstrap'))).toHaveLength(1);
    expect(calls).toContain('/api/v1/send');
    expect(warnings).toContain('Mission room registration failed; own-room message preference may be unavailable');
    // Existing task delivery timers and fresh task commits must not retry association.
    await vi.advanceTimersByTimeAsync(60_000);
    create(); await producer.drain();
    expect(calls.filter(path => path.endsWith('/bootstrap'))).toHaveLength(1);
    expect(calls.filter(path => path.endsWith('/send'))).toHaveLength(2);
  } finally { await producer.close(); vi.useRealTimers(); }
});

it('retains unsupported task journal entries across typed delivery and acknowledgement, and deletion retires them',async()=>{
 const task=create(),file=join(tasksDir(),task.task_id+'.json'),stored=JSON.parse(readFileSync(file,'utf8'));
 const legacy=Array.from({length:40},(_,i)=>({eventId:`task:${task.task_id}:old-${i}`,title:'Old',body:'Retain',taskId:task.task_id,url:`/fleet/tasks/${task.task_id}`}));
 stored.notification_events=[...legacy,...stored.notification_events];writeFileSync(file,JSON.stringify(stored));
 const sent:any[]=[];const sender=new TaskNotificationProducer({origin:'https://service.invalid',token:'t'.repeat(40)},undefined,(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return new Response('{}');})as typeof fetch);
 await sender.drain();await sender.close();expect(sent).toHaveLength(1);expect(sent[0].target).toEqual({kind:'task',taskId:task.task_id});
 acknowledgeTaskNotification(task.task_id,legacy[0].eventId);expect(JSON.parse(readFileSync(file,'utf8')).notification_events).toEqual(legacy);
 cancelTask(task.task_id);beginTaskDeletionIntent(task.task_id,{kind:'local_control',surface:'cli'});unlinkDeletedTask(task.task_id);
 for(const event of events(task.task_id))acknowledgeTaskNotification(task.task_id,event.eventId);
 // Deletion retires the whole journal, including entries this release never sends.
 expect(existsSync(join(tasksDir(),'.notification-retired',task.task_id+'.json'))).toBe(false);
 expect(pendingTaskNotifications()).toEqual([]);
});
