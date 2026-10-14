import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { FleetConfigService } from '../../src/web/fleet-config-service.js';
import { ensureMinimalSetup } from '../../src/minimal-setup.js';
import { createCodexModelDiscovery } from '../../src/application/codex-models.js';
import { codexOfferedModels, type OfferedModels } from '../../src/subscriptions/cli.js';
import '../../src/harness/claude-code.js';
import '../../src/harness/codex.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
const headers = { host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271' };

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-codex-models-'));
  for (const key of ['OURS_FLEET_HOME', 'HOME']) { saved[key] = process.env[key]; process.env[key] = root; }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
});

/** A web server whose Codex model discovery answers whatever `answer` currently returns. */
async function webConsole(answer?: () => OfferedModels) {
  const configPath = join(mkdtempSync(join(root, 'config-')), 'fleet.yaml');
  await ensureMinimalSetup(configPath);
  const dir = mkdtempSync(join(root, 'web-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  let setups = 0;
  const server = await buildWebServer({
    audit: new AuditSink(join(dir, 'audit')), configuration: new FleetConfigService({ configPath }),
    onboardingSetup: async () => { setups++; },
    ...(answer ? { codexModels: async () => answer() } : {}),
  } as any, boundary, { auth });
  const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { ...headers, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
  const session = { ...headers, cookie, 'x-csrf-token': exchange.json().csrfToken as string };
  const report = async () => (await server.app.inject({ method: 'GET', url: '/api/v1/onboarding', headers: session })).json() as { catalog: Array<{ harness: string; model: string }>; codexModels?: { state: string; reason?: string; models?: unknown } };
  const codex = async () => (await report()).catalog.filter(model => model.harness === 'codex').map(model => model.model).sort();
  const setup = (model: string) => server.app.inject({ method: 'POST', url: '/api/v1/onboarding/setup', headers: { ...session, 'content-type': 'application/json' },
    payload: { models: Object.fromEntries(['coordination', 'development', 'review'].map(work => [work, { harness: 'codex', model }])) } });
  return { server, report, codex, setup, setups: () => setups };
}

describe('Codex models offered during onboarding', () => {
  it('offers exactly the models the runtime listed for the account and refuses setup with any other', async () => {
    const web = await webConsole(() => ({ state: 'known', models: ['gpt-6-sol', 'gpt-5.5', 'not-in-the-catalog'] }));
    try {
      expect(await web.codex()).toEqual(['gpt-5.5', 'gpt-6-sol']);
      const report = await web.report();
      expect(report.codexModels).toEqual({ state: 'known' });
      expect(report.catalog.some(model => model.harness === 'claude-code')).toBe(true);
      expect((await web.setup('gpt-6.1-sol')).statusCode).toBe(400);
      expect(web.setups()).toBe(0);
      // An offered model passes the model check and reaches the host setup.
      expect((await web.setup('gpt-6-sol')).statusCode).not.toBe(400);
      expect(web.setups()).toBe(1);
    } finally { await web.server.app.close(); }
  });
  it('offers no Codex model when the account is offered none', async () => {
    const web = await webConsole(() => ({ state: 'known', models: [] }));
    try {
      expect(await web.codex()).toEqual([]);
      expect((await web.report()).codexModels).toEqual({ state: 'known' });
      expect((await web.setup('gpt-6-sol')).statusCode).toBe(400);
    } finally { await web.server.app.close(); }
  });
  it('offers no Codex model and says why when the runtime could not be asked', async () => {
    const web = await webConsole(() => ({ state: 'unknown', reason: 'model/list timed out' }));
    try {
      expect(await web.codex()).toEqual([]);
      expect((await web.report()).codexModels).toEqual({ state: 'unknown', reason: 'model/list timed out' });
      expect((await web.setup('gpt-6-sol')).statusCode).toBe(400);
      expect(web.setups()).toBe(0);
    } finally { await web.server.app.close(); }
  });
  it('follows the account when another one is signed in', async () => {
    let models = ['gpt-6.1-sol'];
    const web = await webConsole(() => ({ state: 'known', models }));
    try {
      expect(await web.codex()).toEqual(['gpt-6.1-sol']);
      models = ['gpt-5.5'];
      expect(await web.codex()).toEqual(['gpt-5.5']);
      expect((await web.setup('gpt-6.1-sol')).statusCode).toBe(400);
    } finally { await web.server.app.close(); }
  });
  it('keeps the packaged catalog when this server has no way to ask', async () => {
    const web = await webConsole();
    try {
      expect(await web.codex()).toContain('gpt-6.1-sol');
      expect((await web.report()).codexModels).toBeUndefined();
    } finally { await web.server.app.close(); }
  });
});

describe('asking the selected runtime for the account', () => {
  const profile = () => { const home = join(root, '.codex'); mkdirSync(home, { recursive: true }); return home; };
  it('reuses an answer only for the same executable, version, profile and sign-in', async () => {
    const home = profile(); writeFileSync(join(home, 'auth.json'), '{}');
    let version = '0.156.1', now = 1_000, asked: string[] = [];
    const discover = createCodexModelDiscovery({
      runtime: async () => ({ executable: '/host/codex', version }),
      ask: async executable => { asked.push(`${executable} ${version}`); return { state: 'known', models: [version] }; },
      now: () => now,
    });
    expect(await discover()).toEqual({ state: 'known', models: ['0.156.1'] });
    expect(await discover()).toEqual({ state: 'known', models: ['0.156.1'] });
    expect(asked).toHaveLength(1);
    version = '0.157.0';
    expect(await discover()).toEqual({ state: 'known', models: ['0.157.0'] });
    utimesSync(join(home, 'auth.json'), new Date(86_400_000), new Date(86_400_000));
    await discover();
    expect(asked).toHaveLength(3);
    now += 6 * 60_000;
    await discover();
    expect(asked).toHaveLength(4);
  });
  it('does not keep an unknown answer, and reports a runtime it cannot select', async () => {
    profile();
    let now = 0, answers = 0;
    const discover = createCodexModelDiscovery({
      runtime: async () => ({ executable: '/host/codex', version: '0.156.1' }),
      ask: async () => ++answers === 1 ? { state: 'unknown', reason: 'codex app-server exited' } : { state: 'known', models: [] },
      now: () => now,
    });
    expect(await discover()).toEqual({ state: 'unknown', reason: 'codex app-server exited' });
    now += 11_000;
    expect(await discover()).toEqual({ state: 'known', models: [] });
    const broken = createCodexModelDiscovery({ runtime: async () => { throw new Error('Cannot read Codex version'); }, ask: async () => ({ state: 'known', models: ['x'] }), now: () => 0 });
    expect(await broken()).toEqual({ state: 'unknown', reason: 'Cannot read Codex version' });
  });

  /** A stand-in `codex app-server` that answers model/list with the given pages. */
  function appServer(pages: Record<string, unknown>): string {
    const path = join(mkdtempSync(join(root, 'bin-')), 'codex');
    writeFileSync(path, `#!/usr/bin/env node
const pages = ${JSON.stringify(pages)};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') return void process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  if (message.method !== 'model/list') return void process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'unknown method' } }) + '\\n');
  const page = pages[message.params.cursor ?? ''];
  if (page === 'exit') process.exit(3);
  process.stdout.write(JSON.stringify({ id: message.id, result: page }) + '\\n');
});
`);
    chmodSync(path, 0o700);
    return path;
  }
  it('ends a runtime that never answers and one that keeps listing, within the budget', async () => {
    const pidFile = join(root, 'app-server.pid');
    const silent = join(mkdtempSync(join(root, 'bin-')), 'codex');
    writeFileSync(silent, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\n`);
    chmodSync(silent, 0o700);
    const gone = async (pid: number) => { for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise(resolve => setTimeout(resolve, 100)); } return false; };
    const started = Date.now();
    expect(await codexOfferedModels(silent, process.env, 1_500)).toEqual({ state: 'unknown', reason: 'initialize timed out' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    expect((await codexOfferedModels(appServer({ '': { data: [{ id: 'a' }], nextCursor: 'loop' }, loop: { data: [{ id: 'b' }], nextCursor: 'loop' } }), process.env, 1_000)).state).toBe('unknown');
  });
  it('reads every page of the runtime model list, leaving hidden models out', async () => {
    const bin = appServer({ '': { data: [{ id: 'gpt-6-sol' }, { id: 'gpt-reserve', hidden: true }], nextCursor: 'next' }, next: { data: [{ id: 'gpt-5.5', hidden: false }, { id: 7 }], nextCursor: null } });
    expect(await codexOfferedModels(bin, process.env)).toEqual({ state: 'known', models: ['gpt-6-sol', 'gpt-5.5'] });
  });
  it('keeps an empty list as an answer and a missing or broken answer as unknown', async () => {
    expect(await codexOfferedModels(appServer({ '': { data: [], nextCursor: null } }), process.env)).toEqual({ state: 'known', models: [] });
    expect(await codexOfferedModels(appServer({ '': { models: [] } }), process.env)).toEqual({ state: 'unknown', reason: 'Codex did not return a model list' });
    expect((await codexOfferedModels(appServer({ '': 'exit' }), process.env)).state).toBe('unknown');
    expect((await codexOfferedModels(join(root, 'missing-codex'), process.env)).state).toBe('unknown');
  });
});
