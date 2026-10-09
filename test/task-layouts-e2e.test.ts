/** End-to-end over HTTP with the real web server, task service, Room Layout engine
 * and on-disk state. Only Cowork and the agent supervisor are in-memory fakes, so
 * no live rooms, agents, daemons or gateways are touched. Detached workers run
 * in-process through the same `task _layout` entry used by the CLI worker. */
import { it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeV2Fixture } from './v2-fixture.js';
import { WebAuth } from '../src/web/auth.js';
import { AuditSink } from '../src/web/audit.js';
import { TrustedDeviceStore } from '../src/web/device-store.js';
import { buildWebServer } from '../src/web/server.js';
import { RoomLayoutDefinitions } from '../src/application/room-layout-definitions.js';
import { TaskLayouts, taskBriefPath } from '../src/application/task-layouts.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { RoomLayoutService, layoutRunPath } from '../src/rooms-tasks/layout-service.js';
import { RoomLayout, type LayoutInstance, type LayoutSupervisor } from '../src/rooms-tasks/layout.js';
import type { CoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
import { stateRoot } from '../src/paths.js';
import { layoutOwnedMemberName } from '../src/rooms-tasks/layout-member-retirement.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
let root: string, previousHome: string | undefined, previousUmask: number;
beforeEach(() => {
  previousUmask = process.umask(0o022); previousHome = process.env.OURS_FLEET_HOME;
  root = mkdtempSync(join(tmpdir(), 'task-layouts-e2e-')); process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true }); process.umask(previousUmask);
});

function fakes() {
  const rooms = new Map<string, { seats: any[]; closed?: boolean; briefing: string; name: string }>();
  const running = new Map<string, LayoutInstance>();
  const events: string[] = [];
  let n = 0, runId = '';
  const supervisor: LayoutSupervisor = { id: stateRoot(),
    verify: async i => { if (JSON.stringify(running.get(i.launch)) !== JSON.stringify(i)) throw Error('stale instance'); },
    spawn: async (key, template) => { const i = { supervisor: stateRoot(), launch: `launch-${key}`, cid: `cid-${key}`, session: `s-${key}`, agent: layoutOwnedMemberName(runId, key), temporary: true };
      running.set(i.launch, i); events.push(`spawn ${key}:${template}`); return i; },
    join: async (i, invite) => { const [id, role] = invite.split('|'); rooms.get(id)!.seats.push({ identity_cid: i.cid, role, seat_state: 'active' }); events.push(`join ${i.cid}->${id}`); },
    assign: async (i, a) => { events.push(`assign ${a.id}`); expect(a.contract).toContain('Current task brief:'); },
    retire: async i => { running.delete(i.launch); events.push(`retire ${i.agent}`); },
  };
  const cowork = {
    createRoom: async (input: any) => { const id = `native-${++n}`; rooms.set(id, { seats: [], briefing: input.briefing, name: input.room_name }); events.push(`create ${input.room_name.split('-')[0]}`); return { room_id: id, identity_cid: `cid-room-${n}`, identity_name: id }; },
    issueInvite: async (id: string, o: any) => ({ invite: `${id}|${o.role}` }),
    getSeats: async (id: string) => rooms.get(id)!.seats,
    getRoom: async (id: string) => { const r = rooms.get(id); return r && { identity_cid: `cid-room-${id.split('-')[1]}`, state: r.closed ? 'closed' : 'active', seats: r.seats }; },
    closeRoom: async (id: string) => { rooms.get(id)!.closed = true; events.push(`close ${id}`); },
    deleteRoom: async (id: string) => { rooms.delete(id); events.push(`delete ${id}`); },
  } as unknown as CoworkAdapter;
  return { rooms, running, events, supervisor, cowork, setRunId: (id: string) => { runId = id; } };
}

it('authors a layout, runs a multi-room task through its lifecycle over HTTP, and cleans up on finish and deletion', async () => {
  const config = join(root, 'fleet.yaml');
  writeV2Fixture(config, { roles: {}, rooms: { owner: { expected_cid: '0'.repeat(64) }, defaults: { attach_owner: false } } });
  mkdirSync(join(root, 'fleet', 'room_layouts'), { mode: 0o700 });
  const f = fakes();
  // The real #199 service, with the engine bound to the in-memory Cowork and supervisor.
  class FakeBoundLayouts extends RoomLayoutService {
    override open(id: string): RoomLayout { f.setRunId(id); return new RoomLayout(layoutRunPath(id), f.cowork, f.supervisor); }
  }
  const workers: Promise<unknown>[] = [];
  let app!: TaskRoomApplicationService;
  const layouts = new TaskLayouts(config, { service: new FakeBoundLayouts(config), launch: async args => {
    const [, , taskId, operation, maybeRoom] = args; const operationId = args[args.indexOf('--operation-id') + 1];
    const room = maybeRoom === '--operation-id' ? undefined : maybeRoom;
    workers.push(new Promise(resolve => setTimeout(resolve, 5)).then(() => app.runTaskLayoutOperation({
      actor: { kind: 'internal_worker', surface: 'cli' }, taskId, operation: operation as any, room, operationId })).catch(e => e));
  } });
  const deletions: Promise<unknown>[] = [];
  app = new TaskRoomApplicationService(config, { taskLayouts: layouts, launchDeletionWorker: async taskId => {
    deletions.push(app.settleTaskDeletion({ actor: { kind: 'internal_worker', surface: 'cli' }, taskId }).catch(e => e));
  } });
  const dir = mkdtempSync(join(tmpdir(), 'task-layouts-e2e-web-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const server = await buildWebServer({ taskRooms: app, roomLayouts: new RoomLayoutDefinitions(config), audit: new AuditSink(join(dir, 'audit')) } as any, boundary, { auth });
  try {
    const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange',
      headers: { host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
    const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
    const headers = { host: boundary.host, cookie, origin: boundary.origin, 'x-csrf-token': exchange.json().csrfToken as string };
    const call = async (method: string, url: string, payload?: unknown) => {
      const response = await server.app.inject({ method: method as any, url, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
      return { status: response.statusCode, body: response.json() };
    };
    const settle = async () => { while (workers.length) await workers.shift(); };
    const layoutOf = async (id: string) => (await call('GET', `/api/v1/tasks/${id}/layout`)).body.layout;

    // Author the layout through the editor API.
    const definition = { version: 1, participants: { dev: { agent_template: 'Agent' }, qa: { agent_template: 'Agent' } },
      rooms: { design: { goal: 'Agree the design', members: ['dev', 'qa'] }, delivery: { goal: 'Ship it', members: ['dev'] } } };
    expect((await call('PUT', '/api/v1/room-layouts/delivery', { revision: 'absent', definition })).status).toBe(200);
    expect((await call('GET', '/api/v1/room-layouts')).body.layouts[0]).toMatchObject({ name: 'delivery', issues: [] });

    // Create a started layout task: no legacy room, task-scoped snapshot, both rooms declared.
    const created = await call('POST', '/api/v1/tasks', { title: 'Ship', brief: 'Original brief', layout: 'delivery' });
    expect(created.status).toBe(201);
    const task = created.body.task; const id = task.task_id as string;
    expect(task).toMatchObject({ state: 'active', layout: { name: 'delivery', run_id: `task-${id}` } });
    expect(task.room_id).toBeUndefined(); expect(created.body.provisioning).toBeUndefined();
    expect((await layoutOf(id)).rooms.map((r: any) => [r.key, r.state])).toEqual([['design', 'declared'], ['delivery', 'declared']]);

    // Editing the source afterwards never changes this task's run.
    await call('PUT', '/api/v1/room-layouts/delivery', { revision: (await call('GET', '/api/v1/room-layouts')).body.layouts[0].revision,
      definition: { ...definition, rooms: { solo: { goal: 'Changed', members: ['dev'] } } } });

    // Open the design room: agents spawn, join and receive task-scoped assignments; the room becomes a task chat.
    expect((await call('POST', `/api/v1/tasks/${id}/layout/rooms/design/open`)).status).toBe(202);
    await settle();
    let view = await layoutOf(id);
    expect(view.rooms[0]).toMatchObject({ key: 'design', state: 'active', ready: ['dev', 'qa'], identity_cid: 'cid-room-1' });
    expect(view.operation).toMatchObject({ operation: 'open', room: 'design', status: 'succeeded' });
    expect(f.events.filter(e => e.startsWith('spawn'))).toEqual(['spawn dev:Agent', 'spawn qa:Agent']);
    expect(JSON.parse(f.rooms.get('native-1')!.briefing).contract).toContain(`Task ${id}: Ship`);
    const listed = (await call('GET', '/api/v1/tasks')).body.tasks.find((t: any) => t.task_id === id);
    expect(listed.layout_rooms).toEqual([{ key: 'design', state: 'active', room_id: 'native-1', identity_cid: 'cid-room-1' }, { key: 'delivery', state: 'declared' }]);

    // A brief edit reaches the room that opens later through the private brief file.
    await call('PATCH', `/api/v1/tasks/${id}/description`, { brief: 'Edited brief', expectedBrief: 'Original brief' });
    expect(readFileSync(taskBriefPath({ task_id: id }), 'utf8')).toContain('Edited brief');

    // The delivery room reuses dev's running session (shared participant), then the design room closes on its own.
    await call('POST', `/api/v1/tasks/${id}/layout/rooms/delivery/open`); await settle();
    expect(f.events.filter(e => e.startsWith('spawn'))).toHaveLength(2);
    expect((await layoutOf(id)).rooms.map((r: any) => r.state)).toEqual(['active', 'active']);
    await call('POST', `/api/v1/tasks/${id}/layout/rooms/design/close`); await settle();
    view = await layoutOf(id);
    expect(view.rooms.map((r: any) => r.state)).toEqual(['closed', 'active']);
    expect(f.running.size).toBe(2); // closing a room keeps agents for other rooms

    // Finish: rooms archived and only the layout's own agents retired.
    expect((await call('POST', `/api/v1/tasks/${id}/review`, {})).status).toBe(200);
    expect((await call('POST', `/api/v1/tasks/${id}/finish`, {})).body.task.state).toBe('done');
    await settle();
    view = await layoutOf(id);
    expect(view).toMatchObject({ closed: true, operation: { operation: 'close', status: 'succeeded' } });
    expect(f.running.size).toBe(0);
    expect(f.rooms.get('native-2')!.closed).toBe(true);
    expect((await call('POST', `/api/v1/tasks/${id}/layout/rooms/delivery/open`)).status).toBe(409);

    // Delete: the run, provenance, brief and op record are gone with the task.
    const deleted = await call('DELETE', `/api/v1/tasks/${id}?confirm=${id}`);
    expect(await Promise.all(deletions)).not.toEqual(expect.arrayContaining([expect.any(Error)]));
    expect(f.rooms.size).toBe(0);
    expect(f.running.size).toBe(0);
    expect(f.events.filter(e => e.startsWith('delete'))).toEqual(['delete native-1', 'delete native-2']);
    expect([200, 202]).toContain(deleted.status);
    expect((await call('GET', `/api/v1/tasks/${id}`)).status).toBe(404);
    for (const path of [layoutRunPath(`task-${id}`), layoutRunPath(`task-${id}`).replace(/\.json$/, '.provenance.json'), taskBriefPath({ task_id: id })])
      expect(existsSync(path)).toBe(false);

    // Nothing leaked to HTTP clients along the way.
    expect(JSON.stringify(view)).not.toMatch(/agent_templates|fingerprint|launch-|"session"/);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
