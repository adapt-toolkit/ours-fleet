import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import type { FleetConfig } from '../src/config.js';
import { buildWebServer } from '../src/web/server.js';
import { WebAuth } from '../src/web/auth.js';
import { TrustedDeviceStore } from '../src/web/device-store.js';
import { writeV2Fixture } from './v2-fixture.js';

let root: string;
let previousHome: string | undefined;
const config = (): FleetConfig => ({
  roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
  watchdogs: [], loops: [], roomTemplates: {},
} as FleetConfig);
const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mission-keys-web-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  writeV2Fixture(join(root, 'fleet.yaml'), {});
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

async function server(deleteWorker?: () => Promise<{ deleted: boolean }>) {
  const service = new TaskRoomApplicationService(undefined, { loadConfiguration: config });
  if (deleteWorker) (service as unknown as { launchTaskDeletionWorker: typeof deleteWorker }).launchTaskDeletionWorker = deleteWorker;
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(join(root, 'web-auth')));
  const built = await buildWebServer({ taskRooms: service } as never, boundary, { auth });
  const exchange = await built.app.inject({ method: 'POST', url: '/api/v1/auth/exchange',
    headers: { host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${built.auth.bootstrapSecret}` } });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
  const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': exchange.json().csrfToken as string };
  return { app: built.app, headers, service };
}

describe('mission keys over the authenticated web API', () => {
  it('creates lists with explicit or suggested prefixes and returns typed prefix errors', async () => {
    const { app, headers } = await server();
    const suggested = await app.inject({ method: 'GET', url: '/api/v1/task-lists/prefix-suggestion?name=Ops%20Board', headers });
    expect(suggested.json()).toEqual({ prefix: 'OB' });
    const created = await app.inject({ method: 'POST', url: '/api/v1/task-lists', headers, payload: { name: 'Ops Board' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().list).toMatchObject({ name: 'Ops Board', prefix: 'OB' });
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/task-lists', headers, payload: { name: 'Bad', prefix: '1-x' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toMatch(/1-6 Latin letters or digits/);
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/task-lists', headers, payload: { name: 'Other', prefix: 'ob' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toMatch(/already used by another list/);
    const reserved = await app.inject({ method: 'POST', url: '/api/v1/task-lists', headers, payload: { name: 'Other', prefix: 'MSN' } });
    expect(reserved.statusCode).toBe(409);
    const edited = await app.inject({ method: 'PATCH', url: '/api/v1/task-lists/Ops%20Board', headers, payload: { prefix: 'ops' } });
    expect(edited.json().list).toMatchObject({ name: 'Ops Board', prefix: 'OPS' });
    const lists = await app.inject({ method: 'GET', url: '/api/v1/task-lists', headers });
    expect(JSON.stringify(lists.json())).toContain('"prefix":"MSN"');
  });

  it('resolves a key only after authentication and keeps opaque IDs working', async () => {
    const { app, headers } = await server();
    const created = (await app.inject({ method: 'POST', url: '/api/v1/tasks', headers,
      payload: { title: 'Keyed', backlog: true } })).json().task;
    expect(created.key).toBe('MSN-1');
    expect(created).not.toHaveProperty('member_naming');
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/tasks/MSN-1', headers: { host: boundary.host } });
    const anonymousUnknown = await app.inject({ method: 'GET', url: '/api/v1/tasks/MSN-404', headers: { host: boundary.host } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymousUnknown.statusCode).toBe(401);
    // Identical outcome for known and unknown keys: no existence oracle before authentication.
    const shape = (body: string) => { const { error } = JSON.parse(body); return { code: error.code, message: error.message }; };
    expect(shape(anonymousUnknown.body)).toEqual(shape(anonymous.body));
    for (const ref of ['MSN-1', 'msn-1', created.task_id]) {
      const read = await app.inject({ method: 'GET', url: `/api/v1/tasks/${ref}`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.json().task).toMatchObject({ task_id: created.task_id, key: 'MSN-1' });
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/tasks/MSN-1/progress', headers })).statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/tasks/MSN-9', headers });
    expect(missing.statusCode).toBe(404);
  });

  it('requires the exact raw ref twice for DELETE and keeps a deleted key idempotent', async () => {
    const { app, headers } = await server(async () => ({ deleted: false }));
    const created = (await app.inject({ method: 'POST', url: '/api/v1/tasks', headers,
      payload: { title: 'Doomed', backlog: true } })).json().task;
    for (const confirm of ['msn-1', created.task_id])
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/tasks/MSN-1?confirm=${confirm}`, headers })).statusCode).toBe(400);
    const accepted = await app.inject({ method: 'DELETE', url: '/api/v1/tasks/MSN-1?confirm=MSN-1', headers });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ task_id: created.task_id, recovery: 'Repeat DELETE /api/v1/tasks/MSN-1?confirm=MSN-1.' });
    rmSync(join(root, '.ours-fleet', 'tasks', `${created.task_id}.json`)); // settlement unlinks the row
    const replay = await app.inject({ method: 'DELETE', url: '/api/v1/tasks/MSN-1?confirm=MSN-1', headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ task_id: created.task_id, already_absent: true });
    const read = await app.inject({ method: 'GET', url: '/api/v1/tasks/MSN-1', headers });
    expect(read.statusCode).toBe(404);
    expect(read.json().error.message).toMatch(/MSN-1 was deleted/);
    const next = (await app.inject({ method: 'POST', url: '/api/v1/tasks', headers, payload: { title: 'Next', backlog: true } })).json().task;
    expect(next.key).toBe('MSN-2');
  });
});
