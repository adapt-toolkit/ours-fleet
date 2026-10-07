import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { WorkspaceDeviceStore } from '../../src/web/workspace-devices.js';
import { AuditSink } from '../../src/web/audit.js';
import { buildWebServer } from '../../src/web/server.js';
import { getAdapter } from '../../src/harness/registry.js';
import '../../src/harness/codex.js';
import '../../src/harness/claude-code.js';

it('answers authenticated setup state without tool/model/provider discovery; keeps the full setup report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-state-'));
  const boundary = { origin: 'http://localhost', host: 'localhost' };
  const appOrigin = 'https://app.ours.network';
  const store = new WorkspaceDeviceStore(dir);
  const link = store.mint(), device = store.enroll(link.enrollment, link.workspaceId, 'fixture');
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(join(dir, 'trusted')), undefined, store, appOrigin);
  const headers = { host: boundary.host, origin: appOrigin, authorization: 'Bearer ' + device.token, 'sec-fetch-site': 'cross-site' };
  let configured = true;
  const tools = ['codex', 'claude-code'].map(harness => vi.spyOn(getAdapter(harness), 'checkPrereqs').mockResolvedValue({ ok: true, checks: [] }));
  const models = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { state: 'known', models: [] }; });
  const providers = vi.fn(async () => []);
  const server = await buildWebServer({ audit: new AuditSink(join(dir, 'audit')), configuration: { read: () => ({ model: { agents: configured ? { FleetCoordinator: {} } : {} } }) }, codexModels: models, subscriptions: { list: providers } } as any, boundary, { auth });
  const state = (extra = {}) => server.app.inject({ url: '/api/v1/onboarding?view=state', headers: { ...headers, ...extra } });
  try {
    const start = performance.now();
    const response = await state();
    console.log('STATE_TIMING_MS', Math.round(performance.now() - start));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true });
    expect(models).not.toHaveBeenCalled(); expect(providers).not.toHaveBeenCalled();
    for (const tool of tools) expect(tool).not.toHaveBeenCalled();
    configured = false;
    expect((await state()).json()).toEqual({ configured: false });
    const fullStart = performance.now();
    const full = await server.app.inject({ url: '/api/v1/onboarding', headers });
    console.log('FULL_DISCOVERY_TIMING_MS', Math.round(performance.now() - fullStart));
    expect(full.json()).toMatchObject({ configured: false, harnesses: expect.any(Array), catalog: expect.any(Array), providers: [] });
    expect(models).toHaveBeenCalledOnce(); expect(providers).toHaveBeenCalledOnce();
    expect((await state({ origin: 'https://foreign.example' })).statusCode).toBe(403);
    store.revoke(device.device.id);
    const rejected = await state();
    expect(rejected.statusCode).toBe(401); expect(rejected.headers['x-ours-workspace-auth']).toBe('rejected');
    expect((await state({ authorization: '' })).statusCode).toBe(403);
    expect((await state({ authorization: '', 'sec-fetch-site': 'none' })).statusCode).toBe(401);
  } finally {
    await server.close(); for (const tool of tools) tool.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
});
