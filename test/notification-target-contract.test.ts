import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationOutbox } from '../src/notifications/outbox.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.unstubAllGlobals(); });
it('preserves unsupported frozen and raw entries without projection or head blocking typed work', async () => {
  mkdirSync('.test-artifacts', { recursive: true });const dir=mkdtempSync(join('.test-artifacts','typed-notifications-')),file=join(dir,'outbox.json');
  const legacy=Array.from({length:40},(_,i)=>({id:`old-${i}`,value:{url:'/fleet/chats?chat=old'},...(i%2?{payload:{eventId:`old-${i}`,title:'Old',body:'Keep',url:'/fleet/chats/agents/old'}}:{})}));
  writeFileSync(file,JSON.stringify({entries:legacy,cursor:7,checkpoint:{offset:9}}));
  const sent:any[]=[],project=vi.fn(async(_value:unknown,eventId:string)=>({eventId,title:'New',body:'View',target:{kind:'agent',agentId:'A'},anchor:{kind:'fleet-message',messageId:'opaque/#message'}} as any));
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response('{}');}));
  const queue=new NotificationOutbox(file,{origin:'https://service.invalid',token:'t'.repeat(40)},project);closes.push(()=>queue.close());
  expect(queue.enqueue('typed',{})).toBe(true);await queue.drain();await queue.drain();
  expect(sent).toEqual([{eventId:'typed',title:'New',body:'View',target:{kind:'agent',agentId:'A'},anchor:{kind:'fleet-message',messageId:'opaque/#message'}}]);expect(project).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({entries:legacy,cursor:7,checkpoint:{offset:9}});await queue.retire();expect(JSON.parse(readFileSync(file,'utf8')).entries).toEqual(legacy);
});
it('freezes typed payload before send and replays identical target and raw anchor after restart',async()=>{
 mkdirSync('.test-artifacts',{recursive:true});const file=join(mkdtempSync(join('.test-artifacts','typed-frozen-')),'outbox.json');
 const payload:any={eventId:'typed',title:'New',body:'View',target:{kind:'agent',agentId:'A'},anchor:{kind:'fleet-message',messageId:'raw/%message'}};const sent:any[]=[];let ok=false;
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{sent.push(JSON.parse(init.body));expect(JSON.parse(readFileSync(file,'utf8')).entries[0].payload).toEqual(payload);return new Response('{}',{status:ok?200:503});}));
 let queue=new NotificationOutbox(file,{origin:'https://service.invalid',token:'t'.repeat(40)},async()=>payload);queue.enqueue('typed',{});await queue.drain();await queue.close();
 queue=new NotificationOutbox(file,{origin:'https://service.invalid',token:'t'.repeat(40)},async()=>{throw Error('must not reproject');});closes.push(()=>queue.close());ok=true;await queue.drain();expect(sent).toEqual([payload,payload]);expect(JSON.parse(readFileSync(file,'utf8')).entries).toEqual([]);
});
