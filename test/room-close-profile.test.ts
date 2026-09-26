import { afterEach, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityCidPresent, removeExactMemberIdentity } from '../src/rooms-tasks/close.js';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(wrongInstance = false) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-close-profile-'));
  roots.push(root);
  const id = '11111111-2222-3333-4444-555555555555';
  const cid = 'ab'.repeat(32);
  const requests: { path: string; credential?: string }[] = [];
  let present = true;
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, credential: req.headers['x-ours-api-token'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/base/daemon/selection') {
      return res.end(JSON.stringify({ schema: 1, instanceId: wrongInstance ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : id, capabilities: ['external-sessions-v1'] }));
    }
    if (req.headers['x-ours-api-token'] !== 'fixture-issued') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/base/daemon/api/v1/listIdentities') return res.end(JSON.stringify(present ? [{ name: 'member', cid, kind: 'role', temp: null, session: null }] : []));
    if (req.url === '/base/daemon/api/v1/removeIdentity') { present = false; return res.end(JSON.stringify({})); }
    if (req.url === '/base/daemon/api/v1/releaseLease') return res.end(JSON.stringify([]));
    res.statusCode = 404; res.end('{}');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const credentialPath = join(root, 'credential');
  writeFileSync(credentialPath, 'fixture-issued', { mode: 0o600 });
  mkdirSync(join(root, '.ours-client'), { mode: 0o700 });
  const profilePath = join(root, '.ours-client/profile.json');
  writeFileSync(profilePath, JSON.stringify({ serverUrl: origin + '/base', endpoint: origin + '/base/daemon', expectedInstanceId: id, credentialPath }), { mode: 0o600 });
  vi.stubEnv('HOME', root);
  for (const key of ['OURS_CONFIG', 'OURS_PORT', 'OURS_API_TOKEN', 'OURS_STATE_DIR', 'OURS_DAEMON_ID']) vi.stubEnv(key, undefined);
  return { cid, requests, profilePath };
}

test('room retirement uses the managed daemon profile for inventory, exact removal and release', async () => {
  const f = await fixture();
  expect(await identityCidPresent(f.cid)).toBe(true);
  await removeExactMemberIdentity({ role_name: 'member', identity_cid: f.cid, slot: 'dev', cowork_role: 'Developer', seat_state: 'active' });
  expect(await identityCidPresent(f.cid)).toBe(false);
  expect(f.requests.every(req => req.path.startsWith('/base/daemon/'))).toBe(true);
  expect(f.requests.filter(req => req.path.endsWith('/removeIdentity'))).toHaveLength(1);
  expect(f.requests.filter(req => req.path.endsWith('/releaseLease'))).toHaveLength(3);
});

test('room retirement refuses an unexpected daemon before sending its credential', async () => {
  const f = await fixture(true);
  await expect(identityCidPresent(f.cid)).rejects.toThrow();
  expect(f.requests).toEqual([{ path: '/base/daemon/selection', credential: undefined }]);
});

test('room retirement refuses an incomplete selected profile without legacy fallback', async () => {
  const f = await fixture();
  writeFileSync(f.profilePath, '{}');
  await expect(identityCidPresent(f.cid)).rejects.toThrow('serverUrl');
  expect(f.requests).toEqual([]);
});
