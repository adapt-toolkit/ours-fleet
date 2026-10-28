import { NotificationOutbox } from '../src/notifications/outbox.js';
import { FleetNotificationProducer } from '../src/notifications/fleet-producer.js';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (check: () => boolean, ms = 1000) => {
  const end = performance.now() + ms;
  while (!check()) { if (performance.now() > end) return false; await new Promise(r => setTimeout(r, 5)); }
  return true;
};
async function gate() {
  const seen: string[] = [], held: ServerResponse[] = []; let mode: 'ok' | 'fail' | 'hold' = 'ok';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body).eventId);
    if (mode === 'fail') { res.writeHead(503); res.end(); return; }
    if (mode === 'hold') { held.push(res); return; }
    res.end('{}');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return { seen, held, set: (next: typeof mode) => { mode = next; },
    config: { origin: `http://127.0.0.1:${(server.address() as any).port}`, token: 't'.repeat(40) } };
}
const project = async (_value: unknown, eventId: string) => ({ eventId, title: 'Agent', body: 'Done', target: { kind: 'agent' as const, agentId: 'a' } });
const directory = () => { mkdirSync('.test-artifacts', { recursive: true }); return mkdtempSync(join('.test-artifacts', 'outbox-prompt-')); };

it('delivers after durable enqueue, follows up once for mid-pass arrivals, and leaves retries to the interval after a failure', async () => {
  const g = await gate(), dir = directory();
  const outbox = new NotificationOutbox(join(dir, 'outbox.json'), g.config, project); cleanup.push(() => outbox.close());
  expect(outbox.enqueue('p1', {})).toBe(true); outbox.prompt();
  expect(await until(() => g.seen.includes('p1'))).toBe(true);
  g.set('hold'); outbox.enqueue('p2', {}); outbox.prompt();
  expect(await until(() => g.held.length === 1)).toBe(true);
  outbox.enqueue('p3', {}); outbox.prompt(); outbox.prompt();
  g.set('ok'); g.held.shift()!.end('{}');
  expect(await until(() => g.seen.includes('p3'))).toBe(true);
  expect(g.seen).toEqual(['p1', 'p2', 'p3']);
  g.set('fail'); outbox.enqueue('p4', {}); outbox.prompt();
  expect(await until(() => g.seen.length === 4)).toBe(true);
  for (const id of ['p5', 'p6']) { outbox.enqueue(id, {}); outbox.prompt(); }
  await until(() => false, 300);
  expect(g.seen.length).toBe(4);
  g.set('ok'); await outbox.drain();
  expect(g.seen.slice(4)).toEqual(['p4', 'p5', 'p6']);
  expect(JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')).entries).toEqual([]);
  outbox.enqueue('p7', {}); outbox.prompt();
  expect(await until(() => g.seen.includes('p7'))).toBe(true);
});

it('keeps the 32-attempt pass limit for a burst and starts nothing once closed or retired', async () => {
  const g = await gate(), dir = directory();
  const burst = new NotificationOutbox(join(dir, 'burst.json'), g.config, project); cleanup.push(() => burst.close());
  for (let i = 0; i < 40; i++) { burst.enqueue(`b${i}`, {}); burst.prompt(); }
  expect(await until(() => g.seen.length === 33, 1500)).toBe(true);
  await until(() => false, 300);
  expect(g.seen.length).toBe(33);
  expect(await until(() => g.seen.length === 40, 4000)).toBe(true);
  expect(g.seen).toEqual(Array.from({ length: 40 }, (_, i) => `b${i}`));
  const closed = new NotificationOutbox(join(dir, 'closed.json'), g.config, project);
  await closed.close(); closed.enqueue('c1', {}); closed.prompt();
  const retired = new NotificationOutbox(join(dir, 'retired.json'), g.config, project);
  retired.enqueue('r1', {}); await retired.retire(); retired.prompt();
  await until(() => false, 300);
  expect(g.seen).not.toContain('c1'); expect(g.seen).not.toContain('r1');
});

it('delivers a completed turn without waiting for the outbox interval', async () => {
  const g = await gate(), dir = directory();
  const root = join(dir, 'agents'); mkdirSync(root);
  const producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), g.config); cleanup.push(() => producer.close());
  const store = new ConversationEventStore(join(root, 'agent-one', '.conversation'), { roleId: 'agent-one' }); cleanup.push(async () => store.close());
  // Three turns, each delivered well inside the 3 s interval: chance alignment with the
  // interval cannot pass all three.
  for (const [i, promptId] of ['one', 'two', 'three'].entries()) {
    store.append({ kind: 'prompt.admitted', promptId, source: 'owner_admin_console', sessionGeneration: 'g', payload: { queuedBehind: 0 } });
    await until(() => false, 200);
    const at = performance.now();
    store.append({ kind: 'turn.completed', promptId, sessionGeneration: 'g', payload: { outcome: 'completed' } });
    expect(await until(() => g.seen.length === i + 1, 2500)).toBe(true);
    expect(performance.now() - at).toBeLessThan(500);
  }
});
