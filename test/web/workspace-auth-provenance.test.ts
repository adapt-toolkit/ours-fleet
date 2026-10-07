import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { WorkspaceDeviceStore } from '../../src/web/workspace-devices.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { createPrefixGateway } from '../../src/web/prefix-gateway.js';
import { buildWebServer } from '../../src/web/server.js';
import { AuditSink, type AuditEvent } from '../../src/web/audit.js';
import { FleetError } from '../../src/application/errors.js';

it('makes a gateway connection failure readable only to the configured App, without claiming device rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-cors-502-'));
  const store = new WorkspaceDeviceStore(dir), appOrigin = 'https://app.ours.network';
  const auth = new WebAuth('http://localhost', 'localhost', Date.now, new TrustedDeviceStore(join(dir, 'trusted')), undefined, store, appOrigin);
  const link = store.mint(), device = store.enroll(link.enrollment, link.workspaceId, 'fixture');
  const upstream = createServer(); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  const gateway = createPrefixGateway({ auth, fleetOrigin: upstreamOrigin, services: [{ prefix: '/notifications', origin: upstreamOrigin }] });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  auth.setBoundary(origin, new URL(origin).host);
  try {
    const preflight = await fetch(origin + '/notifications/api/v1/summary', { method: 'OPTIONS', headers: { origin: appOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(appOrigin);
    const headers = { origin: appOrigin, authorization: 'Bearer ' + device.token, 'sec-fetch-site': 'cross-site' };
    const failure = await fetch(origin + '/notifications/api/v1/summary', { headers });
    expect(failure.status).toBe(502); expect(failure.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect(failure.headers.get('vary')).toBe('Origin'); expect(failure.headers.get('x-ours-workspace-auth')).toBeNull();
    expect((await failure.json()).error.code).toBe('upstream_unavailable');
    expect(store.authenticate(device.token).id).toBe(device.device.id);
    const foreign = await fetch(origin + '/notifications/api/v1/summary', { headers: { ...headers, origin: 'https://foreign.example' } });
    expect(foreign.status).toBe(403); expect(foreign.headers.get('access-control-allow-origin')).toBeNull(); await foreign.text();
    store.revoke(device.device.id);
    const rejected = await fetch(origin + '/notifications/api/v1/summary', { headers });
    expect(rejected.status).toBe(401); expect(rejected.headers.get('x-ours-workspace-auth')).toBe('rejected'); await rejected.text();
  } finally { await gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('marks only device validation failure, strips forged service provenance and records bounded safe diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-provenance-'));
  const store = new WorkspaceDeviceStore(dir);
  const appOrigin = 'https://app.ours.network';
  const auth = new WebAuth('http://localhost', 'localhost', Date.now, new TrustedDeviceStore(join(dir, 'trusted')), undefined, store, appOrigin);
  let forwarded: Record<string, unknown> = {}, calls = 0;
  const upstream = createServer((req, res) => {
    calls++; forwarded = req.headers;
    res.writeHead(401, { 'x-ours-workspace-auth': 'rejected', 'x-ours-request-id': 'forged-id' }); res.end('service refused');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const recorded: AuditEvent[] = [];
  const gateway = createPrefixGateway({ auth, fleetOrigin: upstreamOrigin, services: [{ prefix: '/messenger', origin: upstreamOrigin }], audit: { record: async event => { recorded.push(event); } } });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  auth.setBoundary(origin, new URL(origin).host);
  const issue = () => { const link = store.mint(); return store.enroll(link.enrollment, link.workspaceId, 'fixture'); };
  const one = issue(), two = issue();
  const headers = (token: string) => ({ origin: appOrigin, authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site', 'x-ours-workspace-auth': 'rejected', 'x-ours-request-id': 'attacker-id' });
  const web = await buildWebServer({ audit: new AuditSink(join(dir, 'audit')) } as any, { origin, host: new URL(origin).host }, { auth });
  web.app.get('/api/v1/business-refusal', async () => { throw new FleetError('unauthorized', 'business authorization refused'); });
  try {
    for (const device of [one, two]) {
      const response = await fetch(origin + '/messenger/private-resource?private=not-for-audit', { headers: headers(device.token) });
      expect(response.status).toBe(401);
      expect(response.headers.get('x-ours-workspace-auth')).toBe('service');
      expect(response.headers.get('x-ours-request-id')).not.toBe('forged-id');
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Ours-Workspace-Auth');
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Ours-Request-Id');
      expect(store.authenticate(device.token).id).toBe(device.device.id);
      await response.text();
    }
    expect(forwarded['x-ours-workspace-auth']).toBeUndefined(); expect(forwarded['x-ours-request-id']).toBeUndefined();
    expect(recorded.map(event => event.result)).toEqual(['upstream_401', 'upstream_401']);
    store.revoke(one.device.id);
    const before = calls;
    const rejected = await fetch(origin + '/messenger/private-resource', { headers: headers(one.token) });
    expect(rejected.status).toBe(401); expect(rejected.headers.get('x-ours-workspace-auth')).toBe('rejected'); await rejected.text();
    expect(calls).toBe(before); expect(recorded.at(-1)?.result).toBe('device_rejected');
    const fleetRejected = await web.app.inject({ url: '/api/v1/auth/session', headers: { ...headers(one.token), host: new URL(origin).host } });
    expect(fleetRejected.statusCode).toBe(401); expect(fleetRejected.headers['x-ours-workspace-auth']).toBe('rejected');
    expect(fleetRejected.headers['access-control-expose-headers']).toContain('X-Ours-Workspace-Auth');
    const business = await web.app.inject({ url: '/api/v1/business-refusal', headers: { ...headers(two.token), host: new URL(origin).host } });
    expect(business.statusCode).toBe(401); expect(business.headers['x-ours-workspace-auth']).toBeUndefined();
    for (let i = 0; i < 65; i++) { const response = await fetch(origin + '/messenger/private-resource', { headers: headers(one.token) }); await response.text(); }
    expect(recorded).toHaveLength(60);
    const diagnostic = JSON.stringify(recorded);
    for (const value of [one.token, two.token, 'private-resource', 'not-for-audit', 'attacker-id', 'forged-id']) expect(diagnostic).not.toContain(value);
  } finally {
    await gateway.close(); await web.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
  }
});
