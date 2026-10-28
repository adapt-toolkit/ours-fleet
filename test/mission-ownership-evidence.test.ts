import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { readSessionOwnership, recordSessionOwnership, SESSION_OWNERSHIP_FILE } from '../src/session/session-ownership.js';
import { TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';
import { FleetNotificationProducer } from '../src/notifications/fleet-producer.js';
import { TaskNotificationProducer } from '../src/notifications/task-producer.js';
import { associateRoomNotifications, bootstrapMissionRooms, drainMissionCleanup } from '../src/notifications/mission-ownership.js';
import {
  missionCleanupDir, pendingMissionCleanups, queueMissionCleanup, settleMissionCleanup, unavailableMissionCleanups,
} from '../src/rooms-tasks/notification-manifest.js';
import {
  beginTaskDeletionIntent, cancelTask, createTask, getTask, listTasks, pendingTaskNotifications, tasksDir, unlinkDeletedTask, updateTaskRoom,
} from '../src/rooms-tasks/task-state.js';

// Evidence-preservation fixtures: unavailable ownership, bootstrap, association and cleanup evidence is never read as
// absent, never overwritten, and never completes a barrier. Loopback fakes only; no provider or network.
const TASK = '0mvrpv4kt1f567911', ROOM = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const config = { origin: 'http://127.0.0.1:1', token: 'x'.repeat(40) };
let previous: string | undefined;
const cleanup: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  previous = process.env.OURS_FLEET_HOME; mkdirSync('.test-artifacts', { recursive: true });
  process.env.OURS_FLEET_HOME = mkdtempSync(join('.test-artifacts', 'mission-evidence-'));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous;
});
const create = () => createTask({ title: 'Mission', origin: { type: 'cli' }, start: false });
/** Fake mission service: records every request and answers from `answer` (default 2xx echoing full coverage). */
function service(answer: (path: string, body: any) => { status: number; body?: unknown } = (_path, body) => ({ status: 200, body })) {
  const calls: Array<{ path: string; body: any }> = [];
  const request = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body as string);
    calls.push({ path, body });
    const reply = answer(path, body);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as unknown as typeof fetch;
  return { calls, request };
}
const bootstrapFile = () => join(process.env.OURS_FLEET_HOME!, 'notifications', 'mission-bootstrap.json');

// #1 writer paths
it('a corrupt or unreadable sidecar is never reset by a writer: an owned start fails, a standalone start keeps its bytes', () => {
  for (const kind of ['corrupt', 'unreadable'] as const) {
    const dir = mkdtempSync(join('.test-artifacts', 'sidecar-writer-')), sidecar = join(dir, SESSION_OWNERSHIP_FILE);
    if (kind === 'corrupt') writeFileSync(sidecar, '{"schema":1,"generations":{"old":'); else mkdirSync(sidecar);   // EISDIR ≠ ENOENT
    const store = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'member' }); cleanup.push(() => store.close());
    const ownership = () => store.page({ limit: 100 }).events.filter(event => event.kind === 'session.ownership');
    // Standalone: the session starts, the sidecar is untouched, and the ledger still binds the generation.
    recordSessionOwnership(store, 'g1', dir);
    if (kind === 'corrupt') expect(readFileSync(sidecar, 'utf8')).toBe('{"schema":1,"generations":{"old":');
    else expect(readdirSync(sidecar)).toEqual([]);
    expect(ownership().map(event => event.payload)).toEqual([{ launchId: null, taskId: null }]);
    // Owned: the start is refused before any ledger binding, and the evidence is still untouched.
    writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ version: 1, role: 'member', launchId: 'l', taskOwner: { taskId: TASK, creationActionId: 'a' } }));
    expect(() => recordSessionOwnership(store, 'g2', dir)).toThrow();
    expect(ownership()).toHaveLength(1);
    if (kind === 'corrupt') expect(() => readSessionOwnership(dir)).toThrow();
  }
});

it('an absent sidecar is initialized; earlier generations survive later writes', () => {
  const dir = mkdtempSync(join('.test-artifacts', 'sidecar-absent-'));
  writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ version: 1, role: 'member', launchId: 'l', taskOwner: { taskId: TASK, creationActionId: 'a' } }));
  const store = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'member' }); cleanup.push(() => store.close());
  recordSessionOwnership(store, 'g1', dir); recordSessionOwnership(store, 'g2', dir);
  expect(readSessionOwnership(dir)).toEqual({ g1: { launchId: 'l', taskId: TASK }, g2: { launchId: 'l', taskId: TASK } });
});

// #2 observer recovery
it('an unavailable sidecar holds a completion instead of emitting it unowned; repair then labels it from exact evidence', async () => {
  const dir = mkdtempSync(join('.test-artifacts', 'sidecar-observer-'));
  const accepted: any[] = [];
  const server = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; accepted.push(JSON.parse(raw)); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const root = join(dir, 'agents'), roleDir = join(root, 'member'), state = join(dir, 'outboxes'); mkdirSync(root);
  const live = { origin: `http://127.0.0.1:${(server.address() as any).port}`, token: 't'.repeat(40) };
  let producer = new FleetNotificationProducer([root], state, live); cleanup.push(() => producer.close());
  const store = new ConversationEventStore(join(roleDir, '.conversation'), { roleId: 'member' }); cleanup.push(() => store.close());
  // The generation's binding is not in the observed ledger range: only the sidecar can attribute it.
  writeFileSync(join(roleDir, SESSION_OWNERSHIP_FILE), '{"schema":1');
  store.append({ kind: 'prompt.admitted', promptId: 'p', source: 'browser', sessionGeneration: 'g', payload: {} });
  const done = store.append({ kind: 'turn.completed', promptId: 'p', sessionGeneration: 'g', payload: { outcome: 'completed' } });
  producer.poll(); await producer.drain(); producer.poll(); await producer.drain();
  expect(accepted).toEqual([]);
  expect(readFileSync(join(roleDir, SESSION_OWNERSHIP_FILE), 'utf8')).toBe('{"schema":1');
  await producer.close();
  // Repaired evidence, restarted observer: the held completion is emitted once, labelled with the exact task.
  writeFileSync(join(roleDir, SESSION_OWNERSHIP_FILE), JSON.stringify({ schema: 1, generations: { g: { launchId: 'l', taskId: TASK } } }));
  producer = new FleetNotificationProducer([root], state, live);
  await vi.waitFor(async () => { producer.poll(); await producer.drain(); expect(accepted).toHaveLength(1); });
  expect(accepted[0]).toMatchObject({ eventId: `member:g:${done.seq}`, taskId: TASK });
});

// #3 bootstrap generation
it('bootstrap generation: only a missing file starts at 1; corrupt, invalid or exhausted state is refused with its bytes kept', async () => {
  for (const contents of ['{', '7', '"1"', '[]', '{"generation":-1}', '{"generation":1.5}', '{"generation":"2"}', `{"generation":${Number.MAX_SAFE_INTEGER}}`]) {
    mkdirSync(join(process.env.OURS_FLEET_HOME!, 'notifications'), { recursive: true }); writeFileSync(bootstrapFile(), contents);
    const fake = service();
    await expect(bootstrapMissionRooms(config, () => [], () => [], fake.request)).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    expect(readFileSync(bootstrapFile(), 'utf8')).toBe(contents);
  }
  rmSync(bootstrapFile());
  const fake = service();
  await bootstrapMissionRooms(config, () => [], () => [], fake.request);
  await bootstrapMissionRooms(config, () => [], () => [], fake.request);    // a restart never reuses a generation
  expect(fake.calls.map(call => [call.path, call.body])).toEqual([
    ['/api/v1/missions/bootstrap', { generation: 1, complete: false }], ['/api/v1/missions/bootstrap', { generation: 1, complete: true }],
    ['/api/v1/missions/bootstrap', { generation: 2, complete: false }], ['/api/v1/missions/bootstrap', { generation: 2, complete: true }],
  ]);
});

// #4 association proof
it('a 409 (deleted, stale or conflicting) or an unconfirmed 2xx never admits a room; a retry under a newer revision does', async () => {
  const task = create();
  for (const reply of [{ status: 409, body: { error: { message: 'conflicting association' } } }, { status: 409, body: { error: { message: 'stale association' } } },
    { status: 409, body: { error: { message: 'mission deleted' } } }, { status: 200, body: { contactIds: [OTHER.toUpperCase()], revision: 1 } }, { status: 200, body: {} }]) {
    const before = getTask(task.task_id).notification_manifest?.revision ?? 0;
    const fake = service(() => reply);
    await expect(associateRoomNotifications(task.task_id, ROOM, { config, request: fake.request })).rejects.toThrow(/Waiting for notification service/);
    // Only a 409 moves the revision past the refused one; the room set never shrinks.
    expect(getTask(task.task_id).notification_manifest).toEqual({ revision: Math.max(before, 1) + (reply.status === 409 ? 1 : 0), room_cids: [ROOM.toUpperCase()] });
  }
  const fake = service();
  await associateRoomNotifications(task.task_id, ROOM, { config, request: fake.request });
  expect(fake.calls.at(-1)?.body).toEqual({ taskId: task.task_id, revision: getTask(task.task_id).notification_manifest!.revision, contactIds: [ROOM.toUpperCase()] });
});

it('bootstrap never completes on a refused or unconfirmed registration', async () => {
  const task = create(); updateTaskRoom(task.task_id, 'room-1', ROOM);
  for (const reply of [{ status: 409 }, { status: 200, body: { contactIds: [] } }]) {
    const fake = service((path, body) => path.endsWith('/associate') ? reply : { status: 200, body });
    await expect(bootstrapMissionRooms(config, () => listTasks({ strict: true }), () => [], fake.request)).rejects.toThrow();
    expect(fake.calls.some(call => call.body.complete === true)).toBe(false);
  }
  const fake = service();
  await bootstrapMissionRooms(config, () => listTasks({ strict: true }), () => [], fake.request);
  expect(fake.calls.at(-1)?.body).toMatchObject({ complete: true });
});

// #7 inventory
it('unavailable task or layout inventory leaves the bootstrap run unstarted; repair permits one complete run', async () => {
  const valid = create(); updateTaskRoom(valid.task_id, 'room-1', ROOM);
  const broken = join(tasksDir(), '1aaaaaaaa00000000.json'); writeFileSync(broken, '{');
  const fake = service();
  await expect(bootstrapMissionRooms(config, () => listTasks({ strict: true }), () => [], fake.request)).rejects.toThrow();
  rmSync(broken);
  // A layout that cannot be read is not an empty layout.
  await expect(bootstrapMissionRooms(config, () => listTasks({ strict: true }), () => { throw new Error('layout unavailable'); }, fake.request)).rejects.toThrow('layout unavailable');
  expect(fake.calls).toEqual([]);
  await bootstrapMissionRooms(config, () => listTasks({ strict: true }), () => [OTHER], fake.request);
  expect(fake.calls.map(call => call.path)).toEqual(['/api/v1/missions/bootstrap', '/api/v1/missions/associate', '/api/v1/missions/bootstrap']);
  expect(fake.calls[1].body.contactIds).toEqual([ROOM.toUpperCase(), OTHER.toUpperCase()]);
});

// #6 legacy queued lifecycle events
it('a queued lifecycle event from an earlier release is sent push-only under its own ID; a reused-ID refusal acknowledges it', async () => {
  for (const status of [200, 409]) {
    const task = create(), path = join(tasksDir(), `${task.task_id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    for (const event of record.notification_events) delete event.delivery;     // as an earlier release queued it
    writeFileSync(path, JSON.stringify(record, null, 2));
    const queued = pendingTaskNotifications().find(t => t.taskId === task.task_id)!;
    expect(queued.events.every(event => event.delivery === 'push-only')).toBe(true);
    expect(queued.upgraded).toEqual(record.notification_events.map((event: any) => event.eventId));
    const sent: any[] = [];
    const request = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response('{}', { status }); }) as unknown as typeof fetch;
    const producer = new TaskNotificationProducer(config, undefined, request); await producer.drain(); await producer.close();
    expect(sent.map(event => [event.eventId, event.delivery])).toEqual(record.notification_events.map((event: any) => [event.eventId, 'push-only']));
    expect(pendingTaskNotifications().find(t => t.taskId === task.task_id)).toBeUndefined();
  }
});

// #8 cleanup intents
it('an unreadable prior intent refuses a partial merge and keeps its bytes; restored, the full union remains', () => {
  const task = create();
  queueMissionCleanup(task.task_id, [ROOM, OTHER]);
  const path = join(missionCleanupDir(), `${task.task_id}.json`), bytes = readFileSync(path, 'utf8');
  rmSync(path); mkdirSync(path);                                                  // unreadable (EISDIR), not absent
  expect(() => queueMissionCleanup(task.task_id, [OTHER])).toThrow(/unreadable; file retained/);
  rmSync(path, { recursive: true }); writeFileSync(path, bytes);
  queueMissionCleanup(task.task_id, [OTHER]);
  expect(pendingMissionCleanups()[0].contactIds).toEqual([ROOM.toUpperCase(), OTHER.toUpperCase()]);
});

it('a malformed intent stays visible as unavailable, is never settled, and does not hide valid work', async () => {
  const a = create(), b = create();
  queueMissionCleanup(a.task_id, [ROOM]);
  const bad = join(missionCleanupDir(), `${b.task_id}.json`); writeFileSync(bad, '{"schema":1,"taskId":"');
  expect(pendingMissionCleanups().map(intent => intent.taskId)).toEqual([a.task_id]);
  expect(unavailableMissionCleanups()).toEqual([b.task_id]);
  expect(settleMissionCleanup({ schema: 1, taskId: b.task_id, contactIds: [] })).toBe(false);
  const fake = service(() => ({ status: 200, body: { removed: 0 } })), warnings: string[] = [];
  expect(await drainMissionCleanup(config, line => warnings.push(line), fake.request)).toBe(true);   // valid work progressed; overall still pending
  expect(fake.calls.map(call => call.body.taskId)).toEqual([a.task_id]);
  expect(existsSync(join(missionCleanupDir(), `${a.task_id}.json`))).toBe(false);
  expect(readFileSync(bad, 'utf8')).toBe('{"schema":1,"taskId":"');
  expect(warnings.some(line => /unreadable intent/.test(line))).toBe(true);
});

it('after unlink the durable intent stays authoritative through a read failure and restart; only a confirmed delete settles it', async () => {
  const task = create(); updateTaskRoom(task.task_id, 'room-1', ROOM); cancelTask(task.task_id);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  expect(unlinkDeletedTask(task.task_id)).toBe(true);
  const path = join(missionCleanupDir(), `${task.task_id}.json`), bytes = readFileSync(path, 'utf8');
  rmSync(path); mkdirSync(path);
  const failing = service(() => ({ status: 200 }));
  expect(await drainMissionCleanup(config, () => {}, failing.request)).toBe(true);
  expect(failing.calls).toEqual([]);                                              // nothing to send, nothing forgotten
  rmSync(path, { recursive: true }); writeFileSync(path, bytes);                  // repaired; a new process reads it again
  const fake = service(() => ({ status: 503 }));
  expect(await drainMissionCleanup(config, () => {}, fake.request)).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  const ok = service(() => ({ status: 200, body: { removed: 1 } }));
  expect(await drainMissionCleanup(config, () => {}, ok.request)).toBe(false);
  expect(ok.calls[0].body).toEqual({ taskId: task.task_id, contactIds: [ROOM.toUpperCase()] });
  expect(existsSync(path)).toBe(false);
});

it('an unreadable intent blocks the unlink, so the task record is kept', () => {
  const task = create(); updateTaskRoom(task.task_id, 'room-1', ROOM); cancelTask(task.task_id);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  const path = join(missionCleanupDir(), `${task.task_id}.json`); rmSync(path); mkdirSync(path);
  expect(() => unlinkDeletedTask(task.task_id)).toThrow(/unreadable/);
  expect(existsSync(join(tasksDir(), `${task.task_id}.json`))).toBe(true);
});
