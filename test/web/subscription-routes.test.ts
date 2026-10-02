import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { SubscriptionService } from '../../src/subscriptions/service.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
const fixtures = resolve('test/fixtures/subscriptions');
const headers = { host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271' };

let root: string;
let previousHome: string | undefined;
let previousUserHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-sub-routes-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  previousUserHome = process.env.HOME;
  process.env.HOME = root;
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, '.codex'));
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  process.env.HOME = previousUserHome;
  rmSync(root, { recursive: true, force: true });
});

async function authenticated() {
  const dir = mkdtempSync(join(root, 'web-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const audit = new AuditSink(join(dir, 'audit'));
  const subscriptions = new SubscriptionService({
    agents: async () => [],
    binaries: { claude: join(fixtures, 'fake-claude.mjs'), codex: join(fixtures, 'fake-codex.mjs'), script: 'script' },
  });
  const server = await buildWebServer({ audit, subscriptions } as any, boundary, { auth });
  const exchange = await server.app.inject({
    method: 'POST', url: '/api/v1/auth/exchange',
    headers: { ...headers, authorization: `Bootstrap ${server.auth.bootstrapSecret}` },
  });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
  return { server, cookie, csrf: exchange.json().csrfToken as string, auditDir: join(dir, 'audit') };
}

describe('subscription routes', () => {
  it('requires a session and CSRF for mutations', async () => {
    const { server, cookie } = await authenticated();
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/subscriptions', headers })).statusCode).toBe(401);
    const noCsrf = await server.app.inject({ method: 'POST', url: '/api/v1/subscriptions/claude/logins', headers: { ...headers, cookie } });
    expect(noCsrf.statusCode).toBeGreaterThanOrEqual(400);
    const probeNoCsrf = await server.app.inject({ method: 'POST', url: '/api/v1/subscriptions/claude/profiles/default/probe', headers: { ...headers, cookie } });
    expect(probeNoCsrf.statusCode).toBeGreaterThanOrEqual(400);
    await server.close();
  });

  it('runs a Claude login end to end; the code never appears in responses or the audit log', async () => {
    const { server, cookie, csrf, auditDir } = await authenticated();
    const h = { ...headers, cookie, 'x-csrf-token': csrf };
    const start = await server.app.inject({ method: 'POST', url: '/api/v1/subscriptions/claude/logins', headers: h });
    expect(start.statusCode).toBe(201);
    const { loginId, url } = start.json();
    expect(url).toMatch(/^https:\/\/claude\.com\//);
    const code = 'good-code#state123';
    const submitted = await server.app.inject({ method: 'POST', url: `/api/v1/subscriptions/claude/logins/${loginId}/code`, headers: h, payload: { code } });
    expect(submitted.statusCode).toBe(200);
    let view = submitted.json();
    for (let i = 0; i < 100 && view.state === 'verifying'; i++) {
      await new Promise(r => setTimeout(r, 50));
      view = (await server.app.inject({ method: 'GET', url: `/api/v1/subscriptions/claude/logins/${loginId}`, headers: h })).json();
    }
    expect(view.state).toBe('succeeded');
    const list = await server.app.inject({ method: 'GET', url: '/api/v1/subscriptions', headers: h });
    const bodies = [start.body, submitted.body, JSON.stringify(view), list.body].join('\n');
    expect(bodies).not.toContain(code);
    expect(bodies).not.toMatch(/SECRET/);
    const audit = readdirSync(auditDir).map(f => readFileSync(join(auditDir, f), 'utf8')).join('\n');
    expect(audit).toContain('subscription.login.code.claude');
    expect(audit).not.toContain(code);
    expect(audit).not.toContain(loginId);
    await server.close();
  });

  it('switches the active profile and reports stale agents; rejects unknown providers and foreign logins', async () => {
    const { server, cookie, csrf } = await authenticated();
    const h = { ...headers, cookie, 'x-csrf-token': csrf };
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/subscriptions/nope/logins/x', headers: h })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/subscriptions/nope/active', headers: h, payload: { profileId: 'default' } })).statusCode).toBe(400);
    const active = await server.app.inject({ method: 'POST', url: '/api/v1/subscriptions/codex/active', headers: h, payload: { profileId: 'default' } });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({ provider: 'codex', activeProfileId: 'default', staleAgents: [] });
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/subscriptions/codex/active', headers: h, payload: { profileId: 'p-missing' } })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'DELETE', url: '/api/v1/subscriptions/codex/profiles/default', headers: h })).statusCode).toBe(409);
    await server.close();
  });
});
