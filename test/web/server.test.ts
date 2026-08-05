import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
