import { request as sendHttp, createServer, type Server, type RequestListener } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createPrefixGateway } from '../../src/web/prefix-gateway.js';
import { WebAuth } from '../../src/web/auth.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { WorkspaceDeviceStore } from '../../src/web/workspace-devices.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function setup(handler: RequestListener) {
  const backend = createServer(handler); const origin = await listen(backend);
  cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  const auth = new WebAuth('http://localhost', 'localhost', Date.now, new TrustedDeviceStore(mkdtempSync(join(tmpdir(), 'gateway-'))), { version: 1, mode: 'none' });
  const gateway = createPrefixGateway({ auth, fleetOrigin: origin, services: [{ prefix: '/messenger', origin, headers: { 'x-ours-api-token': 'server-credential' } }] });
  const publicOrigin = await listen(gateway.server); auth.setBoundary(publicOrigin, new URL(publicOrigin).host);
  const session = auth.anonymous({ headers: { host: new URL(publicOrigin).host, origin: publicOrigin } } as any);
  const headers = { cookie: `ofs_session=${session.id}`, origin: publicOrigin, 'x-csrf-token': session.csrf };
  cleanups.push(() => gateway.close()); return { backend, gateway, auth, session, publicOrigin, headers };
}
describe('generic service prefix transport', () => {
  it('answers only the configured account origin on service prefixes and still requires the device credential', async () => {
    const seen: string[] = [];
    const backend = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('ok'); });
    const origin = await listen(backend);
    cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
    const dir = mkdtempSync(join(tmpdir(), 'gateway-account-origin-')); const store = new WorkspaceDeviceStore(dir);
    const appOrigin = 'https://app.ours-tunnel.com';
    const auth = new WebAuth('http://localhost', 'localhost', Date.now, undefined, undefined, store, appOrigin);
    const gateway = createPrefixGateway({ auth, fleetOrigin: origin, services: [{ prefix: '/messenger', origin }] });
    const publicOrigin = await listen(gateway.server); auth.setBoundary(publicOrigin, new URL(publicOrigin).host);
    cleanups.push(async () => { await gateway.close(); auth.shutdown(); rmSync(dir, { recursive: true, force: true }); });
    const link = store.mint(); const { token } = store.enroll(link.enrollment, link.workspaceId, 'device');
    const call = (method: string, headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = sendHttp(publicOrigin + '/messenger/api/contacts', { method, headers: { 'sec-fetch-site': 'cross-site', ...headers } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers })); });
      req.on('error', reject); req.end();
    });
    const preflight = await call('OPTIONS', { origin: appOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(appOrigin);
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('Authorization');
    const foreignPreflight = await call('OPTIONS', { origin: 'https://attacker.invalid', 'access-control-request-method': 'POST' });
    expect(foreignPreflight.status).toBeGreaterThanOrEqual(400);
    expect(foreignPreflight.headers['access-control-allow-origin']).toBeUndefined();
    const anonymous = await call('GET', { origin: appOrigin });
    // A cross-site request without the device credential is not a workspace request at all.
    expect(anonymous.status).toBe(403);
    expect(anonymous.headers['access-control-allow-origin']).toBe(appOrigin);
    const foreign = await call('GET', { origin: 'https://attacker.invalid', authorization: `Bearer ${token}` });
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(seen).toEqual([]);
    const authorized = await call('GET', { origin: appOrigin, authorization: `Bearer ${token}` });
    expect(authorized.status).toBe(200);
    expect(authorized.headers['access-control-allow-origin']).toBe(appOrigin);
    expect(authorized.headers.vary).toBe('Origin');
    expect(seen).toEqual(['GET /api/contacts']);
  });
  it('rejects every cross-site request, external page links included', async () => {
    const { publicOrigin } = await setup((_req, res) => res.end('page'));
    const status = (path: string, headers: Record<string,string>, method = 'GET') => new Promise<number>((resolve,reject) => { const req = sendHttp(publicOrigin + path, { method, headers }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error',reject);req.end(); });
    const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (const path of ['/', '/fleet', '/fleet?workspace-frame=1']) expect(await status(path, headers)).toBe(403);
    for (const path of ['/fleet/api/v1/roles', '/api/v1/roles', '/messenger/api/contacts'])
      expect(await status(path, headers)).toBe(403);
    expect(await status('/fleet', { ...headers, 'sec-fetch-dest': 'iframe' })).toBe(403);
    expect(await status('/fleet', headers, 'POST')).toBe(403);
    expect(await status('/fleet', { ...headers, host: 'evil.example' })).toBe(403);
  });
  it('keeps the separate machine-client listener inaccessible to browser requests', async () => {
    let requests = 0;
    const backend = createServer((_req, res) => { requests++; res.end('ok'); });
    const origin = await listen(backend);
    cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
    const gateway = createPrefixGateway({ auth: 'backend', fleetOrigin: origin, services: [{ prefix: '/daemon', origin }] });
    const url = await listen(gateway.server); cleanups.push(() => gateway.close());
    expect((await fetch(url + '/daemon/status', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await fetch(url + '/daemon/status', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(403);
    expect((await fetch(url + '/unknown')).status).toBe(403);
    expect(requests).toBe(0);
    expect(await (await fetch(url + '/daemon/status')).text()).toBe('ok');
  });
  it('passes unknown encoded paths and large binary bodies with server credentials', async () => {
    let url: string | undefined; let requestHeaders: any;
    const s = await setup((req, res) => {
      url = req.url; requestHeaders = req.headers;
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
        res.writeHead(418, { 'content-type': 'application/octet-stream', 'x-backend': 'yes' }); res.end(Buffer.concat(chunks));
      });
    });
    const bytes = Buffer.alloc(2 * 1024 * 1024, 171);
    const response = await fetch(s.publicOrigin + '/messenger/future/a%2Fb?q=a%2Bb', { method: 'POST', body: bytes,
      headers: { ...s.headers, 'x-ours-api-token': 'attacker', 'x-forwarded-host': 'attacker' } });
    expect(response.status).toBe(418); expect(response.headers.get('x-backend')).toBe('yes');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); expect(url).toBe('/future/a%2Fb?q=a%2Bb');
    expect(requestHeaders.cookie).toBeUndefined(); expect(requestHeaders.authorization).toBeUndefined();
    expect(requestHeaders['x-forwarded-host']).toBeUndefined(); expect(requestHeaders['x-ours-api-token']).toBe('server-credential');
  });
  it('rejects missing sessions and cross-origin mutations before dispatch', async () => {
    let calls = 0; const s = await setup((_req, res) => { calls++; res.end('ok'); });
    expect((await fetch(s.publicOrigin+'/messenger/api/status',{headers:{...s.headers,authorization:'Bearer invalid-device'}})).status).toBe(401);
    expect(calls).toBe(0);
    expect((await fetch(s.publicOrigin + '/messenger/new')).status).toBe(401);
    expect((await fetch(s.publicOrigin + '/messenger/new', { method: 'POST', headers: { ...s.headers, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(s.publicOrigin + '/messenger/new', { method: 'POST', headers: { cookie: s.headers.cookie, origin: s.publicOrigin } })).status).toBe(403);
    expect(calls).toBe(0);
  });
  it('streams immediately, cancels upstream and revokes open streams', async () => {
    let closed = 0;
    const s = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); res.on('close', () => closed++); });
    const abort = new AbortController(); const response = await fetch(s.publicOrigin + '/messenger/events', { headers: s.headers, signal: abort.signal });
    const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    abort.abort(); await new Promise(resolve => setTimeout(resolve, 30)); expect(closed).toBe(1);
    const response2 = await fetch(s.publicOrigin + '/messenger/events', { headers: s.headers }); const reader2 = response2.body!.getReader(); await reader2.read();
    s.auth.clearSessions(); await expect(reader2.read()).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 30)); expect(closed).toBe(2);
  });
  it('terminates downstream when an upstream response is cut off', async () => {
    const s = await setup((_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('partial'); setTimeout(() => res.destroy(), 20); });
    const response = await fetch(s.publicOrigin + '/messenger/interrupted', { headers: s.headers, signal: AbortSignal.timeout(1000) });
    await expect(response.arrayBuffer()).rejects.not.toThrow(/timeout/i);
  });
  it('proxies WebSocket bytes and closes authenticated connections on logout', async () => {
    const s = await setup((_req, res) => res.end()); const upstream = new WebSocketServer({ server: s.backend });
    upstream.on('connection', socket => socket.on('message', (bytes, binary) => socket.send(bytes, { binary })));
    const socket = new WebSocket(s.publicOrigin.replace('http:', 'ws:') + '/messenger/brand-new-ws', { headers: s.headers });
    await once(socket, 'open'); const reply = once(socket, 'message'); socket.send(Buffer.from([0, 1, 255])); expect((await reply)[0]).toEqual(Buffer.from([0, 1, 255]));
    const closed = once(socket, 'close'); s.auth.clearSessions(); await closed; await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
});
