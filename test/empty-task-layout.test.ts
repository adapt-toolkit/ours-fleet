/** Real HTTP/task/layout persistence; only Cowork transport and agent runtime are faked. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeV2Fixture } from './v2-fixture.js';
import { WebAuth } from '../src/web/auth.js';
import { TrustedDeviceStore } from '../src/web/device-store.js';
import { AuditSink } from '../src/web/audit.js';
import { buildWebServer } from '../src/web/server.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { TaskLayouts } from '../src/application/task-layouts.js';
import { RoomLayoutDefinitions } from '../src/application/room-layout-definitions.js';
import { RoomLayoutService, layoutRunPath } from '../src/rooms-tasks/layout-service.js';
import { RoomLayout, type LayoutInstance, type LayoutSupervisor } from '../src/rooms-tasks/layout.js';
import type { CoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
import { EMPTY_TASK_LAYOUT, emptyTaskLayout } from '../src/rooms-tasks/empty-layout.js';
import { stateRoot } from '../src/paths.js';
import { layoutOwnedMemberName } from '../src/rooms-tasks/layout-member-retirement.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
const owner = { cid: 'a'.repeat(64), role: 'Owner', invite: 'fixture-owner-invite' };
let root: string, previous: string | undefined;
beforeEach(() => { previous = process.env.OURS_FLEET_HOME; root = mkdtempSync(join(tmpdir(), 'empty-layout-')); process.env.OURS_FLEET_HOME = root; });
afterEach(() => { if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const config = join(root, 'fleet.yaml');
  writeV2Fixture(config, { roles: {}, rooms: { owner: { expected_cid: owner.cid, public_invite: owner.invite } } });
  for (const [dir, name, body] of [['roles', 'Reviewer', 'mission: Review the mission\n'], ['brains', 'test', 'harness: claude-code\n']]) {
    mkdirSync(join(root, 'fleet', dir), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'fleet', dir, name + '.yaml'), body, { mode: 0o600 });
  }
  const rooms = new Map<string, { cid: string; seats: any[]; state: string }>();
  let count = 0, runId = '';
  const running = new Map<string, LayoutInstance>();
  const supervisor: LayoutSupervisor = {
    id: stateRoot(), verify: vi.fn(async i => { if (running.get(i.launch)?.cid !== i.cid) throw Error('stale instance'); }),
    spawn: vi.fn(async key => { const i = { supervisor: stateRoot(), launch: 'launch-' + key, cid: 'cid-' + key,
      session: 'session-' + key, agent: layoutOwnedMemberName(runId, key), temporary: true }; running.set(i.launch, i); return i; }),
    join: vi.fn(async (i, invite, _cid, membership) => { rooms.get(membership!.roomId)!.seats.push({ identity_cid: i.cid, role: membership!.role, seat_state: 'active' }); }),
    assign: vi.fn(async () => {}), retire: vi.fn(async i => { running.delete(i.launch); }),
  };
  const cowork = {
    createRoom: vi.fn(async () => { const id = 'room-' + ++count; rooms.set(id, { cid: 'room-cid-' + count, seats: [], state: 'active' }); return { room_id: id, identity_cid: 'room-cid-' + count, identity_name: id }; }),
    acceptInvite: vi.fn(async (id, _invite, options) => { rooms.get(id)!.seats.push({ identity_cid: options.expected_cid, role: options.role, seat_state: 'active' }); }),
    setRoleCommands: vi.fn(async () => {}), issueInvite: vi.fn(async () => ({ invite: 'fixture-member-invite' })),
    getSeats: vi.fn(async id => rooms.get(id)!.seats),
    getRoom: vi.fn(async id => { const r = rooms.get(id); return r && { identity_cid: r.cid, state: r.state, seats: r.seats }; }),
    closeRoom: vi.fn(async id => { rooms.get(id)!.state = 'closed'; }),
    deleteRoom: vi.fn(async id => { rooms.delete(id); }),
  } as unknown as CoworkAdapter;
  class BoundLayouts extends RoomLayoutService {
    override open(id: string, cleanup = false) { runId = id; return new RoomLayout(layoutRunPath(id), cowork, supervisor, cleanup ? undefined : owner); }
  }
  const workers: Array<() => Promise<unknown>> = [];
  let app!: TaskRoomApplicationService;
  const layouts = new TaskLayouts(config, { service: new BoundLayouts(config), launch: async args => {
    if (args[3] !== 'start') return;
    const operationId = args[args.indexOf('--operation-id') + 1];
    workers.push(() => app.runTaskLayoutOperation({ actor: { kind: 'internal_worker', surface: 'cli' },
      taskId: args[2], operation: 'start', operationId }).catch(error => error));
  } });
  app = new TaskRoomApplicationService(config, { taskLayouts: layouts });
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(join(root, 'web')));
  const server = await buildWebServer({ taskRooms: app, roomLayouts: new RoomLayoutDefinitions(config), audit: new AuditSink(join(root, 'audit')) } as any, boundary, { auth });
  const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: {
    host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
  const headers = { host: boundary.host, cookie, origin: boundary.origin, 'x-csrf-token': exchange.json().csrfToken as string };
  const settle = async () => { while (workers.length) await workers.shift()!(); };
  const call = async (method: string, url: string, payload?: unknown, extra = {}, wait = true) => {
    const r = await server.app.inject({ method: method as any, url, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { payload: payload as any }) });
    if (wait) await settle();
    return { status: r.statusCode, body: r.json() };
  };
  return { app, layouts, cowork, supervisor, rooms, running, call, settle, workers, server, config };
}

it('omitted layout creates exactly one Owner room and no agents, and idempotent retry/restart reuse it', async () => {
  const f = await fixture();
  try {
    const created = await f.call('POST', '/api/v1/tasks', { title: 'Plan', brief: 'Agree the plan' }, { 'idempotency-key': 'empty-once' });
    expect(created.status).toBe(201);
    const task = created.body.task;
    expect(task).toMatchObject({ layout: { name: EMPTY_TASK_LAYOUT }, member_roles: [] });
    expect(f.app.getTask(task.task_id).task.state).toBe('active');
    expect(task.no_room).toBeUndefined(); expect(task.room_id).toBeUndefined();
    const view = f.app.taskLayout(task.task_id);
    expect(view.rooms).toEqual([expect.objectContaining({ key: 'mission', state: 'active', members: [], goal: 'Agree the plan' })]);
    expect(view.participants).toEqual([]);
    expect(f.rooms.size).toBe(1);
    expect([...f.rooms.values()][0].seats).toEqual([{ identity_cid: owner.cid, role: 'Owner', seat_state: 'active' }]);
    expect(f.supervisor.spawn).not.toHaveBeenCalled();
    const again = await f.call('POST', '/api/v1/tasks', { title: 'Plan', brief: 'Agree the plan' }, { 'idempotency-key': 'empty-once' });
    expect(again.body.task.task_id).toBe(task.task_id);
    await f.layouts.ensureRun(task); await f.layouts.initializeRooms(task);
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(1);
    expect(f.cowork.acceptInvite).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(view)).not.toContain(owner.invite);
  } finally { await f.server.close(); }
});

it('backlog has no native side effects; Start creates the default room once', async () => {
  const f = await fixture();
  try {
    const created = await f.call('POST', '/api/v1/tasks', { title: 'Later', backlog: true });
    expect(created.status).toBe(201); expect(created.body.task.state).toBe('backlog');
    expect(f.app.taskLayout(created.body.task.task_id).created).toBe(false); expect(f.rooms.size).toBe(0);
    const start = await f.call('POST', `/api/v1/tasks/${created.body.task.task_id}/start`);
    expect([200, 202]).toContain(start.status); expect(f.app.getTask(created.body.task.task_id).task.state).toBe('active'); expect(f.rooms.size).toBe(1);
    await f.call('POST', `/api/v1/tasks/${created.body.task.task_id}/start`);
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(1); expect(f.supervisor.spawn).not.toHaveBeenCalled();
  } finally { await f.server.close(); }
});

it('refuses success without the exact active Owner seat and does not replay unknown creation', async () => {
  const f = await fixture();
  try {
    vi.mocked(f.cowork.acceptInvite).mockImplementationOnce(async () => ({} as any));
    const denied = await f.call('POST', '/api/v1/tasks', { title: 'Missing Owner' });
    expect(denied.status).toBe(201); expect(f.app.getTask(denied.body.task.task_id).task.blocked?.reason).toContain('owner membership not active');
    expect(f.supervisor.spawn).not.toHaveBeenCalled();
    vi.mocked(f.cowork.createRoom).mockImplementationOnce(async () => { throw Error('response lost'); });
    const backlog = await f.call('POST', '/api/v1/tasks', { title: 'Uncertain', backlog: true });
    const id = backlog.body.task.task_id;
    expect((await f.call('POST', `/api/v1/tasks/${id}/start`)).status).toBe(202);
    const count = vi.mocked(f.cowork.createRoom).mock.calls.length;
    expect((await f.call('POST', `/api/v1/tasks/${id}/start`)).status).toBe(202);
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(count);
    expect(f.app.taskLayout(id).uncertain).toBe('create:mission');
  } finally { await f.server.close(); }
});

it('adds an agent later through the existing receipt API, preserves provenance, and cleans up owned resources', async () => {
  const f = await fixture();
  try {
    const created = await f.call('POST', '/api/v1/tasks', { title: 'Manual agents' });
    const task = created.body.task, id = task.task_id;
    const request = { requestId: 'manual-request-123', slot: 'Reviewer', role: 'Reviewer', brain: 'test', agentTemplate: 'Agent' };
    const add = await f.call('POST', `/api/v1/tasks/${id}/members`, request);
    expect(add.status, JSON.stringify(add.body)).toBe(202);
    await expect.poll(async () => (await f.app.memberAddition(id, request.requestId)).state).toBe('succeeded');
    expect((await f.call('POST', `/api/v1/tasks/${id}/members`, request)).body.state).toBe('succeeded');
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(1); expect(f.supervisor.assign).toHaveBeenCalledTimes(1);
    expect(f.rooms.size).toBe(1); expect([...f.rooms.values()][0].seats).toHaveLength(2);
    expect(f.app.taskLayout(id).participants).toEqual([expect.objectContaining({ key: 'Reviewer', owned: true })]);
    await f.layouts.ensureRun(task); // source provenance is unchanged by additions
    expect((await f.call('POST', `/api/v1/tasks/${id}/members`, { ...request, requestId: 'other-request-123' })).status).toBe(409);
    await f.app.cancelTask({ actor: { kind: 'local_control', surface: 'web' }, taskId: id });
    await f.app.runTaskLayoutOperation({ actor: { kind: 'internal_worker', surface: 'cli' }, taskId: id, operation: 'close' });
    expect(f.running.size).toBe(0); expect(f.cowork.closeRoom).toHaveBeenCalledTimes(1);
    await f.layouts.closeAndForget(task); expect(f.rooms.size).toBe(0);
  } finally { await f.server.close(); }
});

it('requires an Owner for empty layouts and reserves the built-in source against edits', async () => {
  const f = await fixture();
  try {
    const engine = new RoomLayout(join(root, 'ownerless.json'), f.cowork, f.supervisor);
    await expect(engine.create(emptyTaskLayout(), 'operator')).rejects.toThrow('requires an attached room owner');
    expect(f.cowork.createRoom).not.toHaveBeenCalled();
    expect((await f.call('PUT', `/api/v1/room-layouts/${EMPTY_TASK_LAYOUT}`, { revision: 'absent', definition: emptyTaskLayout() })).status).toBe(400);
    for (const layout of ['', null, 1, false]) expect((await f.call('POST', '/api/v1/tasks', { title: 'Invalid', layout })).status).toBe(400);
  } finally { await f.server.close(); }
});

it.each([
  { identity_cid: 'b'.repeat(64), role: 'Owner', seat_state: 'active' },
  { identity_cid: owner.cid, role: 'Other', seat_state: 'active' },
  { identity_cid: owner.cid, role: 'Owner', seat_state: 'pending' },
])('rejects an incorrect or inactive Owner seat: %j', async seat => {
  const f = await fixture();
  try {
    vi.mocked(f.cowork.acceptInvite).mockImplementationOnce(async id => { f.rooms.get(id)!.seats.push(seat); return {} as any; });
    const created = await f.call('POST', '/api/v1/tasks', { title: 'Owner required' });
    expect(created.status).toBe(201);
    expect(f.app.getTask(created.body.task.task_id).task.blocked?.reason).toContain('owner membership not active');
    expect(f.supervisor.spawn).not.toHaveBeenCalled();
  } finally { await f.server.close(); }
});

it('does not replay a later agent launch with an unknown outcome', async () => {
  const f = await fixture();
  try {
    const created = await f.call('POST', '/api/v1/tasks', { title: 'Uncertain addition' });
    const id = created.body.task.task_id;
    vi.mocked(f.supervisor.spawn).mockRejectedValueOnce(Error('spawn response lost'));
    const request = { requestId: 'unknown-launch-123', slot: 'Reviewer', role: 'Reviewer', brain: 'test', agentTemplate: 'Agent' };
    expect((await f.call('POST', `/api/v1/tasks/${id}/members`, request)).status).toBe(202);
    await expect.poll(async () => (await f.app.memberAddition(id, request.requestId)).state).toBe('attention');
    await f.call('POST', `/api/v1/tasks/${id}/members`, request);
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(f.app.taskLayout(id).uncertain).toBe('spawn:Reviewer');
  } finally { await f.server.close(); }
});

it.each([false, true])('automatically starts every saved-layout room and shared agents (backlog=%s)', async backlog => {
  const f = await fixture();
  try {
    const definition = { version: 1, participants: { writer: { agent_template: 'Agent' }, reviewer: { agent_template: 'Agent' } },
      rooms: { design: { goal: 'Design', members: ['writer'] }, delivery: { goal: 'Deliver', members: ['writer', 'reviewer'] } } };
    expect((await f.call('PUT', '/api/v1/room-layouts/saved', { revision: 'absent', definition })).status).toBe(200);
    const created = await f.call('POST', '/api/v1/tasks', { title: 'Saved mission', layout: 'saved', backlog });
    expect(created.status).toBe(201);
    const id = created.body.task.task_id;
    if (backlog) {
      expect(f.rooms.size).toBe(0); expect(f.supervisor.spawn).not.toHaveBeenCalled();
      expect((await f.call('POST', `/api/v1/tasks/${id}/start`)).status).toBe(202);
    }
    expect(f.app.getTask(id).task.state).toBe('active');
    expect(f.app.taskLayout(id).rooms.map(r => [r.key, r.state])).toEqual([['design', 'active'], ['delivery', 'active']]);
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(2); // shared writer is not spawned twice
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(2);
    expect(f.cowork.acceptInvite).toHaveBeenCalledTimes(2);
    await f.call('POST', `/api/v1/tasks/${id}/start`);
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(2); expect(f.cowork.createRoom).toHaveBeenCalledTimes(2);
  } finally { await f.server.close(); }
});

it('accepts startup without waiting for a worker, deduplicates it, and cancellation wins before side effects', async () => {
  const f = await fixture();
  try {
    const body = { title: 'Queued mission' }, headers = { 'idempotency-key': 'queued-once' };
    const created = await f.call('POST', '/api/v1/tasks', body, headers, false);
    expect(created.status).toBe(201); expect(created.body.task.state).toBe('provisioning');
    expect(f.rooms.size).toBe(0); expect(f.workers).toHaveLength(1);
    await f.call('POST', '/api/v1/tasks', body, headers, false);
    expect(f.workers).toHaveLength(1);
    const id = created.body.task.task_id;
    await f.app.cancelTask({ actor: { kind: 'local_control', surface: 'web' }, taskId: id });
    await f.settle();
    expect(f.app.getTask(id).task.state).toBe('cancelled');
    expect(f.cowork.createRoom).not.toHaveBeenCalled(); expect(f.supervisor.spawn).not.toHaveBeenCalled();
  } finally { await f.server.close(); }
});
