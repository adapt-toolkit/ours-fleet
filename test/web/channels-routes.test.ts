import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { ChannelsStore } from '../../src/channels/store.js';
import { ChannelsService } from '../../src/channels/service.js';

const boundary = { origin: 'http://127.0.0.1:49273', host: '127.0.0.1:49273' };
const headers = { host: '127.0.0.1:49273', origin: 'http://127.0.0.1:49273' };
const cid = (n: number) => n.toString(16).toUpperCase().padStart(64, '0');
const OWNER = cid(1), SALES = cid(3), ACME = cid(10), ROOT = cid(13);

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

async function serve(channels?: ChannelsService) {
  const dir = mkdtempSync(join(tmpdir(), 'channels-routes-')); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const server = await buildWebServer({ audit: new AuditSink(join(dir, 'audit')), ...(channels ? { channels } : {}) } as any, boundary, { auth });
  clean.push(() => server.app.close());
  const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { ...headers, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
  const get = (url: string, session = true) => server.app.inject({ method: 'GET', url, headers: session ? { ...headers, cookie } : headers });
  return { get };
}

describe('Ours Channels routes', () => {
  it('serve the projection and one perspective history only to an authenticated Owner session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channels-routes-store-')); clean.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new ChannelsStore(dir); clean.push(() => store.close());
    store.setSources([{ kind: 'owner', name: 'Owner', cid: OWNER, ended: false }, { kind: 'agent', name: 'sales', cid: SALES, roleId: 'Sales', ended: false }]);
    store.replaceEdges(SALES, [{ contactCid: ACME, contactName: 'Acme', lastActivity: '2026-11-02T10:00:00.000Z', rootCid: ROOT, rootName: 'Acme Root', roleId: 'support' }]);
    const history = vi.fn(async () => ({ identity: { name: 'sales', cid: SALES }, source: { protocolVersion: 1 as const, producerGeneration: 'g', position: 3 },
      items: [{ seq: 7, wire_id: 'W', direction: 'in', text: 'hi', inbox_state: 'unread' }], next_cursor: null }));
    const service = new ChannelsService({ store, reader: { contactsActivity: vi.fn(), history }, indexer: { sync: vi.fn() } as any, ownerRoot: () => OWNER, ready: () => true });
    const { get } = await serve(service);

    for (const url of ['/api/v1/channels', '/api/v1/channels-status', `/api/v1/channels/${ACME}`, `/api/v1/channels/${ACME}/perspectives/${SALES}/messages`])
      expect((await get(url, false)).statusCode).toBe(401);

    const list = await get('/api/v1/channels?limit=10&q=acme');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ channels: [{ cid: ACME, name: 'Acme', perspectives: 1, ownerConnected: false, claimsOwnerRoot: false, claimedRoot: { rootCid: ROOT } }], nextCursor: null });
    expect((await get(`/api/v1/channels?root=${ROOT.toLowerCase()}`)).json().channels).toHaveLength(1);
    expect((await get('/api/v1/channels-status')).json()).toMatchObject({ ready: true, sources: expect.arrayContaining([expect.objectContaining({ cid: SALES, kind: 'agent' })]) });
    expect((await get(`/api/v1/channels/${ACME.toLowerCase()}`)).json().perspectives).toMatchObject([{ sourceCid: SALES, roleId: 'Sales' }]);

    const page = await get(`/api/v1/channels/${ACME}/perspectives/${SALES}/messages?before_seq=9&limit=20`);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ items: [{ wire_id: 'W' }], perspective: { sourceCid: SALES, kind: 'agent', roleId: 'Sales' } });
    expect(history).toHaveBeenCalledWith({ identity: 'sales', expectedCid: SALES, peer_cid: ACME, before_seq: 9, limit: 20 });

    expect((await get(`/api/v1/channels/${ACME}/perspectives/${OWNER}/messages`)).statusCode).toBe(404);
    expect((await get(`/api/v1/channels/${cid(99)}`)).statusCode).toBe(404);
    for (const url of ['/api/v1/channels/not-a-cid', `/api/v1/channels/${ACME}/perspectives/${SALES}/messages?limit=500`, '/api/v1/channels?cursor=garbage', '/api/v1/channels?limit=0'])
      expect((await get(url)).statusCode, url).toBe(400);
  });

  it('report Channels as unavailable on a server without a daemon profile', async () => {
    const { get } = await serve();
    const response = await get('/api/v1/channels');
    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.json())).toContain('capability_unavailable');
  });
});
