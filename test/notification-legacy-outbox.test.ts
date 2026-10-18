import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { NotificationOutbox } from '../src/notifications/outbox.js';
import { FleetNotificationProducer, legacyRecord } from '../src/notifications/fleet-producer.js';

// Outbox records written before typed targets. Every earlier release persisted the
// projected payload before its first send, so a record without one was never sent.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
// Earlier releases derived event IDs as <role>:<session generation (randomUUID)>:<ledger sequence>.
const G = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ev = (seq: number | string, role = 'agent-one') => `${role}:${G}:${seq}`;
const agents = (m: string) => `/fleet/chats/agents/agent-one#fleet-message-${m}`;
const chats = (m: string) => `/fleet/chats?chat=agent-one&detail=1#fleet-message-${m}`;
const frozen = { id: ev(10), value: { url: agents('m10') },
  payload: { eventId: ev(10), title: 'agent-one: agent completed', body: 'Original', url: agents('m10') } };
// Present-but-falsy fields, other envelopes, roles and non-canonical serializations are not proof of a never-sent record.
const ambiguous = [
  frozen,
  ...[null, false, 0, ''].map((payload, i) => ({ id: ev(20 + i), value: { url: agents('p' + i) }, payload })),
  ...[null, false, '', 'delete-target'].map((operation, i) => ({ id: ev(30 + i), value: { url: agents('o' + i) }, operation })),
  { id: ev(40), value: { url: agents('v') }, targetVersion: null },
  { id: ev(41), value: { url: agents('e') }, attempted: true },
  { id: ev(42, 'agent-two'), value: { url: agents('i') } },
  { id: 'agent-one:', value: {} },
  { id: `agent-one:${G}:NOT_A_SEQUENCE`, value: { url: agents('s') } },
  { id: `agent-one:${G}:0`, value: {} },
  { id: `agent-one:${G}:07`, value: {} },
  { id: 'agent-one:g:8', value: {} },
  { id: `agent-one:${G.toUpperCase()}:9`, value: {} },
  // Session generations came only from randomUUID(): version 4 with the RFC 4122 variant.
  { id: 'agent-one:00000000-0000-0000-0000-000000000000:11', value: {} },
  { id: 'agent-one:0f1e2d3c-4b5a-1968-8776-655443322110:12', value: {} },
  { id: 'agent-one:0f1e2d3c-4b5a-4968-c776-655443322110:13', value: {} },
  { id: 'agent-one:0f1e2d3c-4b5a-4968-7776-655443322110:14', value: { url: agents('m14') } },
  { id: `agent-one-x:${G}:10`, value: {} },
  { id: ev(53), value: { taskId: null } },
  { id: ev(54), value: { taskId: 'task_1' } },
  { id: ev(55), value: { url: agents('%20') } },
  { id: ev(56), value: { url: agents('%20%09') } },
  { id: ev(43), value: { url: '/fleet/chats/agents/other#fleet-message-x' } },
  { id: ev(44), value: { url: agents('m'), title: 'Injected' } },
  { id: ev(45), value: { url: agents('a%2fb') } },
  { id: ev(46), value: { url: agents('x#y') } },
  { id: ev(47), value: { url: agents('x?y=1') } },
  { id: ev(48), value: { url: agents('%E0%A4%A') } },
  { id: ev(49), value: { url: agents('%00') } },
  { id: ev(50), value: { url: agents('') } },
  { id: ev(51), value: { url: '/fleet/chats/agents/agent-one' } },
  { id: ev(52), value: { url: chats('m').replace('&detail=1', '') } },
];

it('delivers never-sent records of every earlier shape with their event IDs, message anchors and task association', async () => {
  mkdirSync('.test-artifacts', { recursive: true });
  const dir = mkdtempSync(join('.test-artifacts', 'notification-legacy-'));
  const accepted: any[] = []; let fail = true;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (fail) { res.writeHead(503); res.end(); return; }
    accepted.push(JSON.parse(body)); res.end('{}');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const config = { origin: `http://127.0.0.1:${(server.address() as any).port}`, token: 't'.repeat(40) };
  const root = join(dir, 'agents'), roleDir = join(root, 'agent-one'), ledger = join(roleDir, '.conversation');
  mkdirSync(ledger, { recursive: true });
  const segment = join(ledger, 'events-000001.jsonl');
  writeFileSync(segment, JSON.stringify({ schemaVersion: 1, roleId: 'agent-one', seq: 1, sessionGeneration: 'g', kind: 'session.started', payload: {} }) + '\n');
  const outboxes = join(dir, 'outboxes'); mkdirSync(outboxes);
  const file = join(outboxes, createHash('sha256').update(roleDir).digest('hex') + '.json');
  const checkpoint = { segment: 'events-000001.jsonl', offset: statSync(segment).size, prompts: [] };
  const unicode = 'réponse/😀 #1';
  writeFileSync(file, JSON.stringify({ entries: [
    { id: ev(1), value: { taskId: null, url: agents('reply-1') } },
    ...ambiguous.slice(0, 3),
    { id: ev(2), value: { taskId: 'task_1', url: chats(encodeURIComponent(unicode)) } },
    { id: ev(3), value: { url: chats('prompt-3') } },
    { id: ev(4), value: {} },
    ...ambiguous.slice(3),
  ], cursor: 9, checkpoint }));
  let producer = new FleetNotificationProducer([root], outboxes, config); cleanup.push(() => producer.close());
  producer.poll(); await producer.drain();
  const pending = JSON.parse(readFileSync(file, 'utf8')).entries.find((entry: any) => entry.id === ev(1));
  expect(pending.value).toEqual({ taskId: null, url: agents('reply-1') });
  expect(pending.payload).toEqual({ eventId: ev(1), title: 'agent-one: agent completed',
    body: 'Your agent finished responding. Open the chat to view the result.', taskId: null,
    anchor: { kind: 'fleet-message', messageId: 'reply-1' }, target: { kind: 'agent', agentId: 'agent-one' } });
  await producer.close();
  producer = new FleetNotificationProducer([root], outboxes, config); cleanup.push(() => producer.close());
  fail = false; producer.poll(); await producer.drain();
  expect(accepted.map(event => event.eventId)).toEqual([ev(1), ev(2), ev(3), ev(4)]);
  expect(accepted[0]).toEqual(pending.payload);
  expect(accepted[1]).toMatchObject({ taskId: 'task_1', anchor: { kind: 'fleet-message', messageId: unicode } });
  expect(accepted[2].anchor).toEqual({ kind: 'fleet-message', messageId: 'prompt-3' });
  expect(accepted[2]).not.toHaveProperty('taskId');
  expect(accepted[3]).not.toHaveProperty('anchor');
  for (const event of accepted) { expect(event.target).toEqual({ kind: 'agent', agentId: 'agent-one' }); expect(event).not.toHaveProperty('url'); }
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.entries.map((entry: unknown) => JSON.stringify(entry))).toEqual(ambiguous.map(entry => JSON.stringify(entry)));
  expect(saved.cursor).toBe(9);
  expect(saved.checkpoint).toEqual(checkpoint);
});

it('retires recognized never-sent records with their target and keeps every ambiguous one byte-for-byte', async () => {
  mkdirSync('.test-artifacts', { recursive: true });
  const file = join(mkdtempSync(join('.test-artifacts', 'notification-legacy-retire-')), 'outbox.json');
  writeFileSync(file, JSON.stringify({ entries: [{ id: ev(1), value: {} }, ...ambiguous], cursor: 3 }));
  const outbox = new NotificationOutbox(file, { origin: 'http://127.0.0.1:1', token: 't'.repeat(40) }, async () => { throw Error('retired target'); },
    undefined, legacyRecord('agent-one'));
  try { await outbox.retire(); } finally { await outbox.close(); }
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.entries.map((entry: unknown) => JSON.stringify(entry))).toEqual(ambiguous.map(entry => JSON.stringify(entry)));
  expect(saved.cursor).toBe(3);
});
