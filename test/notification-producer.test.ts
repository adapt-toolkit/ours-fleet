import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { FleetNotificationProducer } from '../src/notifications/fleet-producer.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { delete process.env.OURS_NOTIFICATIONS_ORIGIN; delete process.env.OURS_NOTIFICATIONS_PRODUCER_TOKEN;
  for (const close of cleanup.splice(0).reverse()) await close(); });
it('produces only user-correlated completions, retries, and recovers delivery after a gateway restart without restarting the agent', async () => {
  mkdirSync('.test-artifacts', { recursive: true });
  const dir = mkdtempSync(join('.test-artifacts', 'notifications-'));
  const accepted: any[] = []; let fail = true;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    expect(req.url).toBe('/api/v1/send'); expect(req.headers.authorization).toBe('Bearer ' + 't'.repeat(40));
    if (fail) { res.writeHead(503); res.end(); return; }
    accepted.push(JSON.parse(body)); res.end('{}');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const config = { origin: `http://127.0.0.1:${(server.address() as any).port}`, token: 't'.repeat(40) };
  const root = join(dir, 'agents'); mkdirSync(root);
  const producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), config); cleanup.push(() => producer.close());
  const store = new ConversationEventStore(join(root, 'agent-one', '.conversation'), { roleId: 'agent-one' }); cleanup.push(async () => store.close());
  const admit = (promptId: string, source: 'owner_admin_console' | 'fleet_monitor') => store.append({ kind: 'prompt.admitted', promptId, source, sessionGeneration: 'g', payload: { queuedBehind: 0 } });
  const complete = (promptId: string) => store.append({ kind: 'turn.completed', promptId, sessionGeneration: 'g', payload: { outcome: 'completed' } });
  admit('human', 'owner_admin_console'); store.append({kind:'message.replace',promptId:'human',messageId:'reply-human',sessionGeneration:'g',payload:{role:'assistant',content:{type:'text',text:'Answer'}}}); const done = complete('human'); admit('wake', 'fleet_monitor'); complete('wake');
  producer.poll(); await producer.drain(); expect(accepted).toHaveLength(0);
  await producer.close(); store.close();
  const restarted = new FleetNotificationProducer([root], join(dir, 'outboxes'), config);
  cleanup.push(() => restarted.close()); fail = false; await restarted.drain();
  expect(accepted).toHaveLength(1); expect(accepted[0].eventId).toBe(`agent-one:g:${done.seq}`);
  expect(accepted[0].url).toBe('/fleet/chats?chat=agent-one&detail=1#fleet-message-reply-human');

});

it('advances past oversized output, split UTF8 records and segment rotation, retaining prompt state across restart', async () => {
  mkdirSync('.test-artifacts', { recursive: true }); const dir = mkdtempSync(join('.test-artifacts', 'ledger-reader-'));
  const root = join(dir, 'agents'); mkdirSync(root);
  const config = { origin: 'http://127.0.0.1:1', token: 'x'.repeat(40) };
  let producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), config);
  cleanup.push(() => producer.close());
  const ledger = join(root, 'reader-agent', '.conversation'); mkdirSync(ledger, { recursive: true });
  const event = (seq: number, kind: string, payload: unknown = {}, source?: string) => ({ schemaVersion: 1, roleId: 'reader-agent', seq, sessionGeneration: 'g', promptId: 'p', kind, source, payload });
  const first = join(ledger, 'events-000001.jsonl');
  writeFileSync(first, JSON.stringify(event(1, 'prompt.admitted', {}, 'owner_admin_console')) + '\n');
  producer.poll(); await producer.close();
  producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), config);
  appendFileSync(first, JSON.stringify(event(2, 'message.replace', { text: '😀'.repeat(90_000) })) + '\n');
  producer.poll(); producer.poll();
  const second = join(ledger, 'events-000002.jsonl');
  const record = Buffer.from(JSON.stringify(event(3, 'turn.completed', { outcome: 'completed', label: '😀' })) + '\n');
  const split = record.indexOf(Buffer.from('😀')) + 2;
  writeFileSync(second, record.subarray(0, split)); producer.poll();
  appendFileSync(second, record.subarray(split)); producer.poll();
  const file = join(dir, 'outboxes', readdirSync(join(dir, 'outboxes'))[0]);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.entries).toHaveLength(1); expect(saved.entries[0].id).toBe('reader-agent:g:3');
  expect(saved.checkpoint.segment).toBe('events-000002.jsonl'); expect(saved.checkpoint.offset).toBe(record.length);
  await producer.close();
});

it('does not advance over a completion when the durable outbox is full', async () => {
  mkdirSync('.test-artifacts', { recursive: true }); const dir = mkdtempSync(join('.test-artifacts', 'ledger-full-'));
  const root = join(dir, 'agents'); mkdirSync(root);
  const config = { origin: 'http://127.0.0.1:1', token: 'x'.repeat(40) };
  let producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), config);
  const ledger = join(root, 'agent', '.conversation'); mkdirSync(ledger, { recursive: true });
  const admitted = { schemaVersion: 1, roleId: 'agent', seq: 1, sessionGeneration: 'g', promptId: 'p', kind: 'prompt.admitted', source: 'browser', payload: {} };
  const file = join(ledger, 'events-000001.jsonl'); writeFileSync(file, JSON.stringify(admitted) + '\n'); producer.poll(); await producer.close();
  const queueFile = join(dir, 'outboxes', readdirSync(join(dir, 'outboxes'))[0]), state = JSON.parse(readFileSync(queueFile, 'utf8'));
  state.entries = Array.from({ length: 2000 }, (_, i) => ({ id: `pending-${i}`, value: {} })); writeFileSync(queueFile, JSON.stringify(state));
  appendFileSync(file, JSON.stringify({ ...admitted, seq: 2, kind: 'turn.completed' }) + '\n');
  producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), config); producer.poll(); await producer.close();
  const full = JSON.parse(readFileSync(queueFile, 'utf8')); expect(full.checkpoint.offset).toBe(state.checkpoint.offset);
  full.entries = []; writeFileSync(queueFile, JSON.stringify(full));
  producer = new FleetNotificationProducer([root], join(dir, 'outboxes'), config); producer.poll(); await producer.close();
  expect(JSON.parse(readFileSync(queueFile, 'utf8')).entries[0].id).toBe('agent:g:2');
});

it('retires a deleted target after the in-flight send and clears persisted pending sends before retry',async()=>{
  const {rmSync}=await import('node:fs');const {retireNotificationTarget}=await import('../src/notifications/target-cleanup.js');
  mkdirSync('.test-artifacts',{recursive:true});const dir=mkdtempSync(join('.test-artifacts','deleted-target-')),previous=process.env.OURS_FLEET_HOME;process.env.OURS_FLEET_HOME=dir;
  cleanup.push(async()=>{if(previous===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=previous;});
  const events:string[]=[];let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),sent=new Promise<void>(resolve=>{started=resolve;});
  const server=createServer(async(req,res)=>{for await(const chunk of req){void chunk;}if(req.url==='/api/v1/send'){events.push('send-start');started();await waiting;events.push('send-end');}else events.push('delete');res.end('{}');});
  server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const config={origin:`http://127.0.0.1:${(server.address() as any).port}`,token:'x'.repeat(40)};
  const root=join(dir,'agents');mkdirSync(root);const state=join(dir,'outboxes');const producer=new FleetNotificationProducer([root],state,config);cleanup.push(()=>producer.close());
  const roleDir=join(root,'removed-agent');const store=new ConversationEventStore(join(roleDir,'.conversation'),{roleId:'removed-agent'});cleanup.push(async()=>store.close());
  store.append({kind:'prompt.admitted',promptId:'p',source:'owner_admin_console',sessionGeneration:'g',payload:{}});store.append({kind:'turn.completed',promptId:'p',sessionGeneration:'g',payload:{outcome:'completed'}});producer.poll();const draining=producer.drain();await sent;
  store.close();rmSync(roleDir,{recursive:true,force:true});await retireNotificationTarget('/fleet/chats?chat=removed-agent',config);expect(events).toEqual(['send-start','delete']);
  producer.poll();release();await draining;await producer.close();expect(events).toEqual(['send-start','delete','send-end','delete']);
  const saved=JSON.parse(readFileSync(join(state,readdirSync(state)[0]),'utf8'));expect(saved.entries).toEqual([]);
});
