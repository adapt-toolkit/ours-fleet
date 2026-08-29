import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { WatchdogQueryService } from '../../src/watchdog/query.js';
import { writeReport } from '../../src/watchdog/store.js';
import { writeSchedulerState } from '../../src/watchdog/scheduler.js';
import type { WatchdogReport } from '../../src/watchdog/report.js';
import type { FleetConfig } from '../../src/config.js';
import type { ResolvedWatchdog } from '../../src/watchdog/config.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };

async function testServer(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-web-server-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const isolatedServices = { ...services(), ...overrides };
  isolatedServices.audit = new AuditSink(join(dir, 'audit'));
  return buildWebServer(isolatedServices, boundary, { auth });
}

function services() {
  const role = {
    id: 'Alpha', lifetime: 'permanent', configured: true, stateHealth: 'present',
    configuredBackend: 'tmux', detectedBackend: 'tmux',
    compatibility: { compatible: true }, problems: [],
  };
  const status = {
    roleId: 'Alpha', observedAt: new Date().toISOString(), overall: 'ready',
    supervisor: { backend: 'none', liveness: 'running', detail: 'running' },
    session: { backend: 'tmux', reachability: 'online', readiness: 'idle', evidence: 'inferred' },
    restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
    monitor: { mode: 'unknown', health: 'unknown', stale: true },
    isolation: { degraded: false }, problems: [],
  };
  return {
    query: {
      async list() { return [{ role, status, capabilities: {} }]; },
      async detail() { return { role, status, capabilities: {} }; },
    },
    repository: { async get() { return role; } },
    async session() {
      return {
        async describe() { return { backend: 'tmux', protocolVersion: 1, features: [] }; },
        async snapshot() { return { backend: 'tmux', alive: true, readiness: 'idle' }; },
        async recentOutput() { return { events: [], text: 'safe', truncated: false }; },
        async sendText() {
          return {
            accepted: true, promptId: 'p', queuedBehind: 0,
            terminalOutcomeKnown: false, detail: 'sent',
          };
        },
      };
    },
    logs: { source: () => ({ tail: async () => ({ records: [], truncated: false }) }) },
    commands: {
      async execute() { return { actionId: 'a', state: 'accepted' }; },
      get() { return undefined; },
    },
    creation: {
      async capabilities() {
        return {
          available: false, reasons: ['fixture'], harnesses: [], lifetimes: [],
          identityBootstrap: {
            mode: 'current-fleet-first-boot', existingIdentity: 'unknown',
            bindingEvidence: 'not-structured', warnings: [],
          },
          safePermissionSchemaVersion: 1,
        };
      },
      async preview(body: unknown) { return { request: body, previewHash: 'hash' }; },
      async create() { return { actionId: 'c', roleId: 'A', state: 'validating' }; },
      get() { return undefined; },
    },
  } as any;
}

async function authenticated(overrides: Record<string, unknown> = {}) {
  const server = await testServer(overrides);
  const exchange = await server.app.inject({
    method: 'POST', url: '/api/v1/auth/exchange',
    headers: {
      host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
      authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
    },
  });
  const cookies = ([] as string[]).concat(exchange.headers['set-cookie'] ?? [])
    .map(value => value.split(';')[0]);
  const cookie = cookies.join('; ');
  const csrf = exchange.json().csrfToken as string;
  return { server, cookie, cookies, csrf };
}

describe('secure local web host', () => {
  it('routes authenticated typed management through the shared kernel envelope', async () => {
    const execute = vi.fn(async (_principal, request) => ({ version: 1, requestId: request.requestId,
      ok: true, result: { type: 'resources', digest: 'sha256:test', resources: [] } }));
    const { server, cookie, csrf } = await authenticated({ management: { execute } });
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/management',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf,
        'idempotency-key': 'web-key' },
      payload: { version: 1, requestId: 'untrusted-browser-id', command: { operation: 'resource.list' } } });
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith({ surface: 'web', local: true }, expect.objectContaining({
      requestId: expect.not.stringMatching('untrusted-browser-id'), idempotencyKey: 'web-key',
    }));
    const denied = await server.app.inject({ method: 'POST', url: '/api/v1/management',
      headers: { host: boundary.host, origin: boundary.origin, cookie },
      payload: { version: 1, command: { operation: 'resource.list' } } });
    expect(denied.statusCode).toBe(403);
    await server.close();
  });
  it('exposes authenticated task-list and assignment routes through the shared service', async () => {
    const task = { task_id: 'task-id', list_id: 'default', list_name: 'default' };
    const taskRooms = {
      listTaskLists: vi.fn(() => [{ list_id: 'default', name: 'default', built_in: true }]),
      createTaskList: vi.fn(async ({ name }) => ({ list_id: 'list-id', name, built_in: false })),
      renameTaskList: vi.fn(async ({ newName }) => ({ list_id: 'list-id', name: newName, built_in: false })),
      deleteTaskList: vi.fn(async () => ({ deleted: { name: 'Work' }, moved: 1 })),
      listTasks: vi.fn(() => [task]), groupedTasks: vi.fn(() => [{ list: { name: 'default' }, tasks: [task] }]),
      createTask: vi.fn(async () => task), moveTask: vi.fn(async () => task),
    };
    const management = { execute: vi.fn(async (_principal, request) => ({ version: 1,
      requestId: request.requestId, ok: true, result: request.command.operation === 'task.list'
        ? { type: 'tasks', value: request.command.groupByList
          ? [{ list: { name: 'default' }, tasks: [task] }] : [task] }
        : { type: 'task', value: task } })) };
    const { server, cookie, csrf } = await authenticated({ taskRooms, management });
    const readHeaders = { host: boundary.host, cookie };
    const writeHeaders = { ...readHeaders, origin: boundary.origin, 'x-csrf-token': csrf };
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/task-lists', headers: readHeaders })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/task-lists', headers: writeHeaders,
      payload: { name: 'Work' } })).statusCode).toBe(201);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/v1/task-lists/Work', headers: writeHeaders,
      payload: { name: 'Renamed' } })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'DELETE', url: '/api/v1/task-lists/Renamed?destination=default',
      headers: writeHeaders })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/tasks?list=default&groupByList=true',
      headers: readHeaders })).json()).toHaveProperty('groups');
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/tasks',
      headers: { ...writeHeaders, 'idempotency-key': 'create-task' },
      payload: { title: 'Task', backlog: true, list: 'default' } })).statusCode).toBe(201);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/v1/tasks/task-id/list', headers: writeHeaders,
      payload: { list: 'default' } })).statusCode).toBe(200);
    const rejected = await server.app.inject({ method: 'POST', url: '/api/v1/task-lists',
      headers: readHeaders, payload: { name: 'No CSRF' } });
    expect(rejected.statusCode).toBe(403);
    expect(taskRooms.moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-id', list: 'default' }));
    expect(management.execute).toHaveBeenCalledWith({ surface: 'web', local: true },
      expect.objectContaining({ command: expect.objectContaining({ operation: 'task.create' }),
        idempotencyKey: 'create-task' }));
    await server.close();
  });
  it('does not bridge browser device trust into owner-channel authorization management', async () => {
    const { server, cookie } = await authenticated();
    const response = await server.app.inject({
      method: 'GET', url: '/api/v1/owner-channel/owners',
      headers: { host: boundary.host, cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('delegates restart-resume target and mode through the REST action adapter', async () => {
    const execute = vi.fn(async () => ({ actionId: 'restart-action', roleId: 'Alpha',
      action: 'restart_resume', state: 'accepted' }));
    const { server, cookie, csrf } = await authenticated({ commands: { execute,
      get: vi.fn() } });
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/roles/Alpha/actions',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { action: 'restart_resume', actionId: 'restart-action' } });
    expect(response.statusCode).toBe(202);
    expect(execute).toHaveBeenCalledWith({ roleId: 'Alpha', action: 'restart_resume',
      actionId: 'restart-action', confirmation: undefined });
    await server.close();
  });
  it('does not register room or template query routes', async () => {
    const { server, cookie } = await authenticated();
    for (const url of ['/api/v1/rooms', '/api/v1/rooms/room-id', '/api/v1/templates']) {
      const response = await server.app.inject({ method: 'GET', url,
        headers: { cookie, host: boundary.host } });
      expect(response.statusCode).toBe(404);
    }
    const create = await server.app.inject({ method: 'POST', url: '/api/v1/rooms',
      headers: { cookie, host: boundary.host } });
    expect(create.statusCode).toBe(404);
    for (const url of ['/api/v1/rooms/room-id/delete', '/api/v1/rooms/room-id/recover']) {
      const response = await server.app.inject({ method: 'POST', url,
        headers: { cookie, host: boundary.host } });
      expect(response.statusCode).toBe(404);
    }
    await server.app.close();
  });
  it('accepts localhost and explains an unconfigured browser host as HTML', async () => {
    const server = await testServer();
    server.auth.setBoundary(boundary.origin, boundary.host, {
      hosts: ['localhost:49271'], origins: ['http://localhost:49271'],
    });
    const localhost = await server.app.inject({ method: 'GET', url: '/api/v1/auth/mode',
      headers: { host: 'localhost:49271' } });
    expect(localhost.statusCode).toBe(200);
    const wrong = await server.app.inject({ method: 'GET', url: '/',
      headers: { host: 'vps.invalid' } });
    expect(wrong.statusCode).toBe(421);
    expect(wrong.headers['content-type']).toContain('text/html');
    expect(wrong.body).toContain('not configured');
    expect(wrong.body).not.toContain('invalid Host header');
    await server.close();
  });

  it('requires exact Host and Origin for bootstrap and consumes the secret once', async () => {
    const server = await testServer();
    const wrong = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: {
        host: 'localhost:49271', origin: 'http://evil.invalid',
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    expect(wrong.statusCode).toBe(403);
    const good = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    expect(good.statusCode).toBe(200);
    const replay = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    expect(replay.statusCode).toBe(401);
    await server.close();
  });

  it('requires cookie, exact Origin, and CSRF on every mutation', async () => {
    const { server, cookie, csrf } = await authenticated();
    const read = await server.app.inject({
      method: 'GET', url: '/api/v1/roles',
      headers: { host: '127.0.0.1:49271', cookie },
    });
    expect(read.statusCode).toBe(200);
    const noCsrf = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271', cookie,
      },
      payload: { text: 'hello' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const crossOrigin = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://evil.invalid',
        cookie, 'x-csrf-token': csrf,
      },
      payload: { text: 'hello' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const good = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
        cookie, 'x-csrf-token': csrf,
      },
      payload: { text: 'hello' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ accepted: true, terminalOutcomeKnown: false });
    await server.close();
  });

  it('sets strict browser headers and does not grant CORS', async () => {
    const { server, cookie } = await authenticated();
    const response = await server.app.inject({
      method: 'GET', url: '/api/v1/meta',
      headers: { host: '127.0.0.1:49271', cookie },
    });
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    await server.close();
  });

  it('exposes one authenticated contract for config read, preview, save, and topology', async () => {
    const calls: string[] = [];
    const configuration = {
      read() { calls.push('read'); return { firstRun: false, revision: 'r1', model: { roles: {} } }; },
      async preview(revision: string) { calls.push(`preview:${revision}`); return { valid: true, revision }; },
      async write(revision: string) { calls.push(`write:${revision}`); return { saved: true, newRevision: 'r2' }; },
    };
    const topology = async () => ({ nodes: [], edges: [], unknownLineage: [] });
    const { server, cookie, csrf } = await authenticated({ configuration, topology });
    const read = await server.app.inject({
      method: 'GET', url: '/api/v1/configuration', headers: { host: boundary.host, cookie },
    });
    expect(read.statusCode).toBe(200);
    const graph = await server.app.inject({
      method: 'GET', url: '/api/v1/topology', headers: { host: boundary.host, cookie },
    });
    expect(graph.json()).toEqual({ nodes: [], edges: [], unknownLineage: [] });
    const preview = await server.app.inject({
      method: 'POST', url: '/api/v1/configuration/preview',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { revision: 'r1', model: { roles: {} } },
    });
    expect(preview.statusCode).toBe(200);
    const save = await server.app.inject({
      method: 'POST', url: '/api/v1/configuration/save',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { revision: 'r1', model: { roles: {} } },
    });
    expect(save.json()).toMatchObject({ saved: true, newRevision: 'r2' });
    expect(calls).toEqual(['read', 'preview:r1', 'write:r1']);
    await server.close();
  });

  it('guards role removal with authentication, CSRF, exact path handling, and typed service input', async () => {
    const calls: unknown[] = [];
    const removal = {
      previewWeb(role: string) { calls.push(['preview', role]); return { role, confirmation: 'typed-role-name' }; },
      async removeWeb(input: unknown) { calls.push(['remove', input]); return { ...(input as object), removed: true, recoveryPath: '/archive' }; },
    };
    const { server, cookie, csrf } = await authenticated({ removal });
    const unauthenticated = await server.app.inject({ method: 'GET', url: '/api/v1/roles/Alpha/removal-preview', headers: { host: boundary.host } });
    expect(unauthenticated.statusCode).toBe(401);
    const traversal = await server.app.inject({ method: 'GET', url: '/api/v1/roles/%2e%2e%2fAlpha/removal-preview', headers: { host: boundary.host, cookie } });
    expect(traversal.statusCode).toBe(400);
    const noCsrf = await server.app.inject({ method: 'POST', url: '/api/v1/roles/Alpha/remove',
      headers: { host: boundary.host, origin: boundary.origin, cookie }, payload: { confirmation: 'Alpha' } });
    expect(noCsrf.statusCode).toBe(403);
    const removed = await server.app.inject({ method: 'POST', url: '/api/v1/roles/Alpha/remove',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { confirmation: 'Alpha' } });
    expect(removed.statusCode).toBe(200);
    expect(calls).toEqual([['remove', { role: 'Alpha', confirmation: 'Alpha' }]]);
    await server.close();
  });

  it('resumes only at the exact boundary, rotates the device, and logout revokes it', async () => {
    const { server, cookies, csrf } = await authenticated();
    const device = cookies.find(value => value.startsWith('ofs_device='))!;
    server.auth.clearSessions();
    const hostile = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: { host: boundary.host, origin: 'http://evil.invalid', cookie: device },
    });
    expect(hostile.statusCode).toBe(403);
    const resumed = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: { host: boundary.host, origin: boundary.origin, cookie: device },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).not.toContain(device.slice('ofs_device='.length));
    expect(JSON.stringify(server.audit.list())).not.toContain(device.slice('ofs_device='.length));
    const rotated = ([] as string[]).concat(resumed.headers['set-cookie'] ?? [])
      .map(value => value.split(';')[0]);
    const resumedCookie = rotated.join('; ');
    const oldReplay = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: { host: boundary.host, origin: boundary.origin, cookie: device },
    });
    expect(oldReplay.statusCode).toBe(401);
    const logout = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: {
        host: boundary.host, origin: boundary.origin, cookie: resumedCookie,
        'x-csrf-token': resumed.json().csrfToken,
      },
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    const revoked = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: {
        host: boundary.host, origin: boundary.origin,
        cookie: rotated.find(value => value.startsWith('ofs_device=')),
      },
    });
    expect(revoked.statusCode).toBe(401);
    expect(csrf).toBeTruthy();
    await server.close();
  });
});

describe('watchdog read endpoints', () => {
  const WATCHDOG: ResolvedWatchdog = {
    name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
    intervalMs: 600_000, watch: ['Alice'], harness: 'claude-code', session: 'tmux',
    identity: 'Watchdog-nightwatch', timeoutMs: 300_000, keepReports: 50,
    alertCooldownMs: 3_600_000, sourceFile: 'fleet.yaml',
  };
  const fleetConfig: FleetConfig = {
    roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
    watchdogs: [WATCHDOG],
  };
  const report = (runId: string, startedAt: string): WatchdogReport => ({
    schema_version: 1, watchdog: 'nightwatch', run_id: runId,
    started_at: startedAt, finished_at: startedAt, status: 'ok',
    summary: { checked: 1, healthy: 1, idle: 0, anomalies: 0 },
    roles: [{ role: 'Alice', status: 'healthy' }], alerts: [], error: null,
  });
  const OLDER = report('20260731T110000Z', '2026-07-31T11:00:00Z');
  const NEWER = report('20260731T120000Z', '2026-07-31T12:00:00Z');

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-web-'));
    process.env.OURS_FLEET_HOME = dir;
    writeReport('nightwatch', OLDER);
    writeReport('nightwatch', NEWER);
    writeSchedulerState('nightwatch', {
      version: 1, consecutiveFailures: 3, heldDown: true, heldSince: '2026-07-31T12:00:00Z',
      lastRunAt: '2026-07-31T12:00:00Z', nextRunAt: '2026-07-31T12:05:00Z',
    });
  });
  afterEach(() => {
    delete process.env.OURS_FLEET_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  function watchdogServices() {
    return { watchdogs: new WatchdogQueryService(() => fleetConfig) };
  }

  it('lists watchdogs with heldDown and the latest run', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs', headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.watchdogs).toHaveLength(1);
    expect(body.watchdogs[0]).toMatchObject({
      name: 'nightwatch', enabled: true, heldDown: true, heldSince: '2026-07-31T12:00:00Z', intervalMs: 600_000,
      coordinator: 'FleetCoordinator', watch: ['Alice'],
    });
    expect(body.watchdogs[0].latest.runId).toBe('20260731T120000Z');
    await server.close();
  });

  it('honors reports limit', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/nightwatch/reports?limit=1',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toBe('20260731T120000Z');
    await server.close();
  });

  it('returns a stored report deep-equal to what was written', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/nightwatch/reports/20260731T110000Z',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    // fastify re-serializes the response, so this checks deep JSON equality with the
    // stored report rather than byte-for-byte identity of the response body.
    expect(res.json()).toEqual(OLDER);
    await server.close();
  });

  it('404s an unknown watchdog name', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/Ghost/reports',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('404s an unknown report run id for a known watchdog', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/nightwatch/reports/20260101T000000Z',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('rejects unauthenticated requests like other read routes', async () => {
    const server = await testServer(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs', headers: { host: boundary.host },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('reports capability_unavailable when no watchdog service is wired', async () => {
    const { server, cookie } = await authenticated();
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs', headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
