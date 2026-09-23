import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { startMcpEndpoint } from '../src/agent-ours/mcp-endpoint.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const cid = 'A'.repeat(64);
async function fixture(temporary = false) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-tools-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.ours-fleet', temporary ? 'tmp' : 'agents', 'Alpha');
  mkdirSync(join(dir, '.ours-bridge'), { recursive: true });
  writeFileSync(join(dir, '.identity'), 'AlphaIdentity');
  let calls = 0;
  let releases = 0;
  const mutations: unknown[] = [];
  const endpoint = await startMcpEndpoint({
    socket: join(root, 'm.sock'), capability: 'test-private-capability', generation: 7,
    runtime: { admit: async () => () => {} } as never,
    client: {
      currentIdentity: async () => ({ name: 'AlphaIdentity', cid, described: false }),
      listContacts: async () => { calls++; return { contacts: [], pending: [], roots: {}, degraded: [], renames: {} }; },
      addContact: async (args: unknown) => { mutations.push(args); return { display: 'Peer', cid: 'B'.repeat(64) }; },
      releaseLease: async () => { releases++; },
    } as never,
    identities: { list: async () => ['AlphaIdentity'] } as never,
    remoteDaemonFiles: true,
  });
  cleanups.push(() => endpoint.close());
  const descriptor = join(dir, '.ours-bridge', 'descriptor.json');
  const metadata = { socket: join(root, 'm.sock'), capability: 'test-private-capability', generation: 7,
    role: 'Alpha', identity: 'AlphaIdentity', cid };
  writeFileSync(descriptor, JSON.stringify(metadata));
  const cli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    execFile(process.execPath, [resolve('dist/cli.js'), 'ours', ...args],
      { env: { ...process.env, OURS_FLEET_HOME: root }, timeout: 15_000 },
      (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
  });
  return { root, dir, descriptor, metadata, cli, mutations, calls: () => calls, releases: () => releases };
}

it.each([false, true])('CLI uses the fixed identity and managed tool policy (temporary=%s)', async temporary => {
  const f = await fixture(temporary);
  const discovery = await f.cli('tools', 'Alpha');
  expect(discovery.code, discovery.stderr).toBe(0);
  const listed = JSON.parse(discovery.stdout);
  expect(listed.identity).toEqual({ name: 'AlphaIdentity', cid, generation: 7 });
  const names = listed.tools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(['send_message', 'generate_invite', 'add_contact', 'list_contacts']));
  for (const tool of ['choose_identity', 'create_identity', 'create_temporary_identity', 'remove_identity']) {
    expect(names).not.toContain(tool);
    const denied = await f.cli('call', 'Alpha', tool);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('not exposed');
  }
  const identity = await f.cli('call', 'Alpha', 'current_identity');
  expect(identity.code, identity.stderr).toBe(0);
  expect(identity.stdout).toContain(cid);
  const contacts = await f.cli('call', 'Alpha', 'list_contacts');
  expect(contacts.code, contacts.stderr).toBe(0);
  expect(contacts.stdout).toContain('No contacts yet.');
  expect(f.calls()).toBe(1);
  const args = join(f.root, 'args.json');
  writeFileSync(args, JSON.stringify({ invite: 'PRIVATE_TEST_INVITE', name: 'Peer' }));
  expect((await f.cli('call', 'Alpha', 'add_contact', '--args-file', args)).code).toBe(0);
  expect(f.mutations).toEqual([{ invite: 'PRIVATE_TEST_INVITE', name: 'Peer' }]);
  expect(f.releases()).toBe(0);
}, 30_000);

it('CLI scrubs malformed private inputs and fails closed on metadata mismatch/ambiguity', async () => {
  const f = await fixture();
  const secret = 'FAKE_PRIVATE_INVITE_SENTINEL';
  const args = join(f.root, 'request.json');
  writeFileSync(args, secret);
  const invalid = await f.cli('call', 'Alpha', 'add_contact', '--args-file', args);
  expect(invalid.code).toBe(1);
  expect(invalid.stdout + invalid.stderr).not.toContain('FAKE');
  writeFileSync(f.descriptor, secret);
  const corrupt = await f.cli('tools', 'Alpha');
  expect(corrupt.code).toBe(1);
  expect(corrupt.stdout + corrupt.stderr).not.toContain('FAKE');
  writeFileSync(f.descriptor, JSON.stringify({ ...f.metadata, identity: 'Other' }));
  expect((await f.cli('tools', 'Alpha')).stderr).toContain('mismatched');
  writeFileSync(f.descriptor, JSON.stringify({ ...f.metadata, generation: 8 }));
  const stale = await f.cli('tools', 'Alpha');
  expect(stale.code).toBe(1);
  expect(stale.stderr).not.toContain('test-private-capability');
  const second = join(f.root, '.ours-fleet', 'tmp', 'Alpha', '.ours-bridge');
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, 'descriptor.json'), JSON.stringify(f.metadata));
  expect((await f.cli('tools', 'Alpha')).stderr).toContain('ambiguous');
  expect(f.calls()).toBe(0);
}, 30_000);

it('REST uses the same real bridge, authenticates reads and requires CSRF for calls', async () => {
  const f = await fixture();
  const previous = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = f.root;
  cleanups.push(() => { if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; });
  // Import compiled service so its sibling bridge.js is the shipped executable.
  const modulePath = resolve('dist/application/supervisor-ours-tools.js');
  const { SupervisorOursTools } = await import(modulePath);
  const serverModulePath = resolve('dist/web/server.js');
  const { buildWebServer } = await import(serverModulePath);
  const { WebAuth } = await import(resolve('dist/web/auth.js'));
  const { TrustedDeviceStore } = await import(resolve('dist/web/device-store.js'));
  const { AuditSink } = await import(resolve('dist/web/audit.js'));
  const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(f.root));
  const server = await buildWebServer({ oursTools: new SupervisorOursTools(), audit: new AuditSink(join(f.root, 'audit')) } as never, boundary, { auth });
  cleanups.push(() => server.app.close());
  const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: {
    host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${auth.bootstrapSecret}`,
  } });
  const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
  const headers = { host: boundary.host, origin: boundary.origin, cookie };
  const list = '/api/v1/roles/Alpha/ours/tools';
  const call = '/api/v1/roles/Alpha/ours/call';
  expect((await server.app.inject({ method: 'GET', url: list, headers: { host: boundary.host } })).statusCode).toBe(401);
  const tools = await server.app.inject({ method: 'GET', url: list, headers });
  expect(tools.statusCode, tools.body).toBe(200);
  expect(tools.json().identity.cid).toBe(cid);
  expect((await server.app.inject({ method: 'POST', url: call, headers, payload: { tool: 'list_contacts' } })).statusCode).toBe(403);
  expect(f.calls()).toBe(0);
  const accepted = await server.app.inject({ method: 'POST', url: call,
    headers: { ...headers, 'x-csrf-token': exchange.json().csrfToken }, payload: { tool: 'list_contacts' } });
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.body).toContain('No contacts yet.');
  expect(f.calls()).toBe(1);
  const denied = await server.app.inject({ method: 'POST', url: call,
    headers: { ...headers, 'x-csrf-token': exchange.json().csrfToken }, payload: { tool: 'choose_identity', arguments: { name: 'Other' } } });
  expect(denied.statusCode, denied.body).toBe(403);
  const privateHeaders = { ...headers, 'x-csrf-token': exchange.json().csrfToken, 'content-type': 'application/json' };
  const malformed = await server.app.inject({ method: 'POST', url: call, headers: privateHeaders, payload: 'PRIVATE_TEST_INVITE' });
  expect(malformed.statusCode, malformed.body).toBe(400);
  expect(malformed.body).not.toContain('PRIVATE');
  const mutation = await server.app.inject({ method: 'POST', url: call, headers: privateHeaders,
    payload: { tool: 'add_contact', arguments: { invite: 'PRIVATE_TEST_INVITE', name: 'Peer' } } });
  expect(mutation.statusCode, mutation.body).toBe(200);
  expect(f.mutations).toEqual([{ invite: 'PRIVATE_TEST_INVITE', name: 'Peer' }]);
  expect(readFileSync(join(f.root, 'audit', 'audit.jsonl'), 'utf8')).not.toContain('PRIVATE_TEST_INVITE');
  expect(f.releases()).toBe(0);
}, 30_000);
