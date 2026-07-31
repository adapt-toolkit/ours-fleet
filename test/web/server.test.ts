import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };

async function testServer() {
  const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-web-server-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const isolatedServices = services();
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

async function authenticated() {
  const server = await testServer();
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
