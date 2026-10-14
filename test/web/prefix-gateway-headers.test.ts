import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createPrefixGateway } from '../../src/web/prefix-gateway.js';
import { WebAuth } from '../../src/web/auth.js';
import { WorkspaceDeviceStore } from '../../src/web/workspace-devices.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';

for (const status of [200, 401, 502]) {
  it(`forwards upstream ${status} headers and exact App CORS before the first service body byte`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-response-headers-'));
    const appOrigin = 'https://app.ours.network', store = new WorkspaceDeviceStore(dir);
    const auth = new WebAuth('http://localhost', 'localhost', Date.now, new TrustedDeviceStore(join(dir, 'trusted')), undefined, store, appOrigin);
    const link = store.mint(), device = store.enroll(link.enrollment, link.workspaceId, 'fixture');
    let upstreamResponse: ServerResponse | undefined, wroteBody = false;
    const backend = createServer((_req, res) => {
      upstreamResponse = res;
      res.writeHead(status, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*', 'x-ours-workspace-auth': 'rejected' });
      res.flushHeaders(); // The first event or error body is deliberately held.
    });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    const upstreamOrigin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
    const gateway = createPrefixGateway({ auth, fleetOrigin: upstreamOrigin, services: [{ prefix: '/messenger', origin: upstreamOrigin }] });
    gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
    const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
    auth.setBoundary(origin, new URL(origin).host);
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(origin + '/messenger/api/events', {
        headers: { origin: appOrigin, authorization: 'Bearer ' + device.token, 'sec-fetch-site': 'cross-site' }, signal: controller.signal,
      });
      expect(wroteBody).toBe(false);
      expect(response.status).toBe(status);
      expect(response.headers.get('access-control-allow-origin')).toBe(appOrigin);
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('x-ours-workspace-auth')).toBe(status === 401 ? 'service' : null);
      expect(store.authenticate(device.token).id).toBe(device.device.id);
      if (status === 200) {
        wroteBody = true; upstreamResponse!.write('event: sync_required\ndata: {}\n\n');
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('sync_required');
        const closed = once(upstreamResponse!, 'close'); controller.abort(); await closed;
      } else {
        const read = response.body!.getReader().read(); upstreamResponse!.destroy();
        await expect(read).rejects.toThrow(); // Preserve transport failure after headers; never manufacture a healthy body.
      }
    } finally {
      clearTimeout(deadline); controller.abort(); await gateway.close(); auth.shutdown();
      backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
