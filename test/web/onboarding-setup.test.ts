import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { FleetConfigService } from '../../src/web/fleet-config-service.js';
import { ensureMinimalSetup } from '../../src/minimal-setup.js';
import { WorkspaceDeviceStore } from '../../src/web/workspace-devices.js';
import { executeInitAnswers, publishSetup } from '../../src/init-wizard.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
const headers = { host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271' };
const sol = { harness: 'codex', model: 'gpt-6.1-sol' };

let root: string;
let previousHome: string | undefined;
let previousUserHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-onboarding-'));
  previousHome = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = root;
  previousUserHome = process.env.HOME; process.env.HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previousHome;
  process.env.HOME = previousUserHome;
  rmSync(root, { recursive: true, force: true });
});

describe('first-time setup through the API', () => {
  it('turns the minimal tunnel setup into a configured Fleet from the chosen models, once', async () => {
    const configPath = join(mkdtempSync(join(root, 'config-')), 'fleet.yaml');
    await ensureMinimalSetup(configPath);
    const dir = mkdtempSync(join(root, 'web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
    const configuration = new FleetConfigService({ configPath });
    let hostSetups = 0;
    const server = await buildWebServer({
      audit: new AuditSink(join(dir, 'audit')), configuration,
      onboardingSetup: async (answers: Parameters<typeof executeInitAnswers>[0]) => {
        await executeInitAnswers(answers, configPath, { async hostSetup() { hostSetups++; }, publish: publishSetup });
      },
    } as any, boundary, { auth, staticRoot: dir });
    try {
      const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { ...headers, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
      const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
      const session = { ...headers, cookie, 'x-csrf-token': exchange.json().csrfToken as string };
      const setup = (models: unknown, extra: Record<string, string> = session) =>
        server.app.inject({ method: 'POST', url: '/api/v1/onboarding/setup', headers: { ...extra, 'content-type': 'application/json' }, payload: { models } });

      expect((await server.app.inject({ method: 'GET', url: '/api/v1/onboarding', headers: session })).json().configured).toBe(false);
      expect((await setup({ coordination: sol, development: sol, review: sol }, headers)).statusCode).toBe(401);
      expect((await setup({ coordination: sol, development: sol })).statusCode).toBe(400);
      expect((await setup({ coordination: sol, development: sol, review: { harness: 'codex', model: 'not-a-model' } })).statusCode).toBe(400);
      expect(hostSetups).toBe(0);
      expect(configuration.read(false).model.agents.FleetCoordinator).toBeUndefined();

      const done = await setup({ coordination: sol, development: sol, review: { harness: 'codex', model: 'gpt-6-astra' } });
      expect(done.json()).toEqual({ configured: true });
      expect(done.statusCode).toBe(200);
      expect(hostSetups).toBe(1);
      const model = configuration.read(true).model;
      expect(model.agents.FleetCoordinator.brain).toEqual({ ref: 'coordination' });
      expect(model.brains?.review).toMatchObject({ harness: 'codex', model: 'gpt-6-astra', effort: 'medium' });
      expect(Object.keys(model.agent_templates).sort()).toEqual(['Critic', 'Developer', 'Engineer', 'LocalCoordinator']);
      expect((await server.app.inject({ method: 'GET', url: '/api/v1/onboarding', headers: session })).json().configured).toBe(true);

      expect((await setup({ coordination: sol, development: sol, review: sol })).statusCode).toBe(409);
      expect(hostSetups).toBe(1);
    } finally { await server.close(); }
  });

  it('lets exactly one of two concurrent setups with different choices win', async () => {
    const configPath = join(mkdtempSync(join(root, 'config-')), 'fleet.yaml');
    await ensureMinimalSetup(configPath);
    const dir = mkdtempSync(join(root, 'web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
    const configuration = new FleetConfigService({ configPath });
    const server = await buildWebServer({
      audit: new AuditSink(join(dir, 'audit')), configuration,
      onboardingSetup: async (answers: Parameters<typeof executeInitAnswers>[0]) => {
        await executeInitAnswers(answers, configPath, { async hostSetup() { await new Promise(resolve => setTimeout(resolve, 50)); }, publish: publishSetup });
      },
    } as any, boundary, { auth, staticRoot: dir });
    try {
      const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { ...headers, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
      const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
      const session = { ...headers, cookie, 'x-csrf-token': exchange.json().csrfToken as string, 'content-type': 'application/json' };
      const astra = { harness: 'codex', model: 'gpt-6-astra' };
      const [first, second] = await Promise.all([sol, astra].map(model =>
        server.app.inject({ method: 'POST', url: '/api/v1/onboarding/setup', headers: session, payload: { models: { coordination: model, development: model, review: model } } })));
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
      const winner = first.statusCode === 200 ? 'gpt-6.1-sol' : 'gpt-6-astra';
      const brains = configuration.read(true).model.brains!;
      for (const work of ['coordination', 'development', 'review']) expect(brains[work].model).toBe(winner);
    } finally { await server.close(); }
  });

  it('accepts setup from the account App origin only with a valid workspace device credential', async () => {
    const configPath = join(mkdtempSync(join(root, 'config-')), 'fleet.yaml');
    await ensureMinimalSetup(configPath);
    const dir = mkdtempSync(join(root, 'web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const appOrigin = 'https://app.ours-tunnel.com';
    const store = new WorkspaceDeviceStore(mkdtempSync(join(root, 'devices-')));
    const auth = new WebAuth(boundary.origin, boundary.host, Date.now, undefined, undefined, store, appOrigin);
    const configuration = new FleetConfigService({ configPath });
    let hostSetups = 0;
    const server = await buildWebServer({
      audit: new AuditSink(join(dir, 'audit')), configuration,
      onboardingSetup: async (answers: Parameters<typeof executeInitAnswers>[0]) => {
        await executeInitAnswers(answers, configPath, { async hostSetup() { hostSetups++; }, publish: publishSetup });
      },
    } as any, boundary, { auth, staticRoot: dir });
    try {
      const issue = () => { const link = store.mint(); return store.enroll(link.enrollment, link.workspaceId, 'device'); };
      const device = issue(), revoked = issue();
      auth.revokeWorkspaceDevice(revoked.device.id);
      const setup = (extra: Record<string, string>) => server.app.inject({
        method: 'POST', url: '/api/v1/onboarding/setup',
        headers: { host: boundary.host, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', ...extra },
        payload: { models: { coordination: sol, development: sol, review: sol } },
      });
      expect((await setup({ origin: appOrigin })).statusCode).toBeGreaterThanOrEqual(401);
      expect((await setup({ origin: appOrigin, authorization: `Bearer ${revoked.token}` })).statusCode).toBe(401);
      expect((await setup({ origin: 'https://attacker.invalid', authorization: `Bearer ${device.token}` })).statusCode).toBe(403);
      expect(hostSetups).toBe(0);
      expect(configuration.read(false).model.agents.FleetCoordinator).toBeUndefined();
      const done = await setup({ origin: appOrigin, authorization: `Bearer ${device.token}` });
      expect(done.statusCode).toBe(200);
      expect(done.headers['access-control-allow-origin']).toBe(appOrigin);
      expect(hostSetups).toBe(1);
      expect(configuration.read(false).model.agents.FleetCoordinator).toBeDefined();
    } finally { await server.close(); }
  });
});
