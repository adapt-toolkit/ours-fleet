import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { NotificationOutbox, producerConfig } from '../src/notifications/outbox.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'p'.repeat(43), credential = 'c'.repeat(43);
function profileDir(serverUrl = 'http://127.0.0.1:3050', producer?: unknown) {
  // Private credential reads refuse group-writable ancestors, so this fixture lives under the system temp directory.
  const dir = mkdtempSync(join(tmpdir(), 'producer-profile-')); chmodSync(dir, 0o700);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const credentialPath = join(dir, 'credential'); writeFileSync(credentialPath, credential + '\n', { mode: 0o600 });
  const profile = { serverUrl, endpoint: serverUrl + '/daemon', expectedInstanceId: 'instance-1', credentialPath };
  if (producer !== undefined) writeFileSync(join(dir, 'notifications-producer.json'), JSON.stringify(producer), { mode: 0o600 });
  return { dir, profile };
}

it('keeps the explicit environment configuration first', () => {
  const { profile } = profileDir('http://127.0.0.1:3050', { schema: 1, serverUrl: 'http://127.0.0.1:3050', expectedInstanceId: 'instance-1', token });
  expect(producerConfig({ OURS_NOTIFICATIONS_ORIGIN: 'http://127.0.0.1:9', OURS_NOTIFICATIONS_PRODUCER_TOKEN: 't'.repeat(40) }, () => profile))
    .toEqual({ origin: 'http://127.0.0.1:9', token: 't'.repeat(40) });
});

it('derives the producer route from the client profile and its bound producer credential', () => {
  const { profile } = profileDir('http://127.0.0.1:3050/ours', { schema: 1, serverUrl: 'http://127.0.0.1:3050/ours', expectedInstanceId: 'instance-1', token });
  expect(producerConfig({}, () => profile)).toEqual({ origin: 'http://127.0.0.1:3050/ours/notifications', token, gatewayCredential: credential });
});

it('stays off without a client profile or without a producer credential', () => {
  const warnings: string[] = [];
  expect(producerConfig({}, () => undefined, w => warnings.push(w))).toBeUndefined();
  const { profile } = profileDir();
  expect(producerConfig({}, () => profile, w => warnings.push(w))).toBeUndefined();
  expect(warnings).toEqual([]);
});

it('refuses, visibly, a producer credential bound to another server or installation', () => {
  for (const producer of [
    { schema: 1, serverUrl: 'http://127.0.0.1:3999', expectedInstanceId: 'instance-1', token },
    { schema: 1, serverUrl: 'http://127.0.0.1:3050', expectedInstanceId: 'other', token },
    { schema: 1, serverUrl: 'http://127.0.0.1:3050', expectedInstanceId: 'instance-1', token: 'short' },
    'not an object',
  ]) {
    const warnings: string[] = [];
    const { profile } = profileDir('http://127.0.0.1:3050', producer);
    expect(producerConfig({}, () => profile, w => warnings.push(w))).toBeUndefined();
    expect(warnings).toHaveLength(1); expect(warnings[0]).toMatch(/notification/i); expect(warnings[0]).not.toContain(token);
  }
});

it('never quotes a malformed secret-bearing producer file in its warning', () => {
  const { dir, profile } = profileDir();
  writeFileSync(join(dir, 'notifications-producer.json'), 'FAKE_PRODUCER_SECRET_' + token, { mode: 0o600 });
  const warnings: string[] = [];
  expect(producerConfig({}, () => profile, w => warnings.push(w))).toBeUndefined();
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('not valid producer JSON');
  expect(warnings[0]).not.toMatch(/FAKE|p{10}/);
});

it('refuses a non-private producer credential file', () => {
  const warnings: string[] = [];
  const { dir, profile } = profileDir('http://127.0.0.1:3050', { schema: 1, serverUrl: 'http://127.0.0.1:3050', expectedInstanceId: 'instance-1', token });
  chmodSync(join(dir, 'notifications-producer.json'), 0o644);
  expect(producerConfig({}, () => profile, w => warnings.push(w))).toBeUndefined();
  expect(warnings).toHaveLength(1);
});

it('refuses plain HTTP to a remote server', () => {
  const warnings: string[] = [];
  const { profile } = profileDir('http://ours.example', { schema: 1, serverUrl: 'http://ours.example', expectedInstanceId: 'instance-1', token });
  expect(producerConfig({}, () => profile, w => warnings.push(w))).toBeUndefined();
  expect(warnings).toHaveLength(1);
});

it('sends through the authenticated server gateway with the producer credential in its own header', async () => {
  const seen: Array<{ url?: string; headers: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => { for await (const _ of req); seen.push({ url: req.url, headers: req.headers }); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  mkdirSync('.test-artifacts', { recursive: true });
  const dir = mkdtempSync(join('.test-artifacts', 'producer-gateway-'));
  const outbox = new NotificationOutbox(join(dir, 'outbox.json'),
    { origin: `http://127.0.0.1:${(server.address() as any).port}/base/notifications`, token, gatewayCredential: credential },
    async (_value, id) => ({ eventId: id, title: 'Done', body: 'Open', url: '/fleet/chats?chat=a' }));
  cleanup.push(() => outbox.close());
  outbox.enqueue('event-1', {}); await outbox.drain();
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe('/base/notifications/api/v1/send');
  expect(seen[0].headers['x-ours-api-token']).toBe(credential);
  expect(seen[0].headers['x-ours-notifications-producer']).toBe(token);
  expect(seen[0].headers.authorization).toBeUndefined();
});
