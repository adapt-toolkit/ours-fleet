import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { encodeConversationRecord, ConversationStreamDecoder } from '../../src/web/conversation-stream-codec.js';
import { ConversationStreamWriter } from '../../src/web/conversation-stream.js';
import { WebAuth } from '../../src/web/auth.js';

const MiB = 1024 * 1024;
describe('bounded conversation SSE', () => {
  it('progressively publishes an exact 16 MiB UTF-8 record only after commit', async () => {
    const payload = { text: '🦊'.repeat((16 * MiB - 12) / 4) + 'x' };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBe(16 * MiB);
    const frames = [...encodeConversationRecord('state', payload, 'one')];
    expect(Math.max(...frames.map(frame => Buffer.byteLength(frame)))).toBeLessThanOrEqual(512 * 1024);
    const published: unknown[] = [];
    const decoder = new ConversationStreamDecoder(record => published.push(record));
    for (const frame of frames.slice(0, -1)) {
      const bytes = Buffer.from(frame);
      decoder.push(bytes.subarray(0, 17)); decoder.push(bytes.subarray(17));
    }
    expect(published).toHaveLength(0);
    decoder.push(Buffer.from(frames.at(-1)!));
    expect(published).toEqual([{ version: 1, type: 'state', payload }]);
  });
  it('rejects oversize, overlapping assembly, and inconsistent commit before publishing', () => {
    expect(() => [...encodeConversationRecord('state', 'x'.repeat(16 * MiB), 'x')]).toThrow(/limit/);
    const published: unknown[] = [], decoder = new ConversationStreamDecoder(record => published.push(record));
    const frames = [...encodeConversationRecord('state', {text:'x'.repeat(MiB)}, 'one')];
    decoder.push(Buffer.from(frames[0]));
    expect(() => decoder.push(Buffer.from(frames[0]))).toThrow(/assembly/);
    expect(published).toEqual([]);
    const other = new ConversationStreamDecoder(record => published.push(record));
    other.push(Buffer.from(frames[0]));
    expect(() => other.push(Buffer.from(frames.at(-1)!))).toThrow(/length/);
  });
  it('writes a valid 16 MiB record through backpressure and bounds waiting output', async () => {
    let release: (() => void) | undefined;
    const frames: string[] = [];
    const output = new Writable({highWaterMark:1, write(chunk, _encoding, callback) { frames.push(chunk.toString()); release = callback; }});
    const writer = new ConversationStreamWriter(output, () => {});
    expect(writer.send('state', {text:'x'.repeat(16 * MiB - 11)})).toBe(true);
    expect(writer.pendingBytes).toBe(0);
    while (writer.busy) { release?.(); await new Promise(resolve => setImmediate(resolve)); }
    const decoded: unknown[] = [];
    const decoder = new ConversationStreamDecoder(value => decoded.push(value));
    for (const frame of frames) decoder.push(Buffer.from(frame));
    expect(decoded).toHaveLength(1);
    expect(Math.max(...frames.map(frame => Buffer.byteLength(frame)))).toBeLessThanOrEqual(512 * 1024);
    writer.close();
  });
  it('closes a slow consumer on waiting-output overflow', () => {
    const output = new Writable({highWaterMark:1, write() {}}), closed = vi.fn();
    const writer = new ConversationStreamWriter(output, closed);
    writer.send('state', {text:'x'.repeat(MiB)});
    for (let i=0;i<20;i++) writer.send('ledger', {text:'x'.repeat(MiB)});
    expect(writer.pendingBytes).toBeLessThanOrEqual(8 * MiB);
    expect(closed).toHaveBeenCalledOnce();
    expect(output.destroyed).toBe(true);
  });
  it('checks cookie idle expiry without touching lastSeenAt, including the exact boundary', () => {
    let now = 0;
    const auth = new WebAuth('http://localhost','localhost',()=>now, undefined, {version:1,mode:'none'});
    const session = auth.anonymous({headers:{host:'localhost',origin:'http://localhost'}} as any);
    now = 30 * 60_000 - 1;
    expect(auth.sessionValid(session)).toBe(true);
    expect(session.lastSeenAt).toBe(0);
    now++;
    expect(auth.sessionValid(session)).toBe(false);
    expect(() => auth.authenticate({headers:{host:'localhost',cookie:`ofs_session=${session.id}`}} as any)).toThrow(/expired/);
    auth.shutdown();
  });
});

import { buildWebServer, type WebServices } from '../../src/web/server.js';
import type { PassiveConversationFollow } from '../../src/application/session-control.js';
import type { ConversationRoleState } from '../../src/application/conversation-role-observer.js';
async function streamFixture(delayed = false, closeBeforeReturn = false, initialSnapshot:any={sessionGeneration:'g',stateRevision:1,ledgerBarrier:0}) {
  const role: ConversationRoleState={roleId:'A',roleRevision:1,roleLifetime:'life',availability:'available',health:'healthy',stateDir:'/private/not-public'};
  let callback: ((state:ConversationRoleState)=>void) | undefined, disposed=0, closed=0;
  let follow: PassiveConversationFollow | undefined;
  let release!:()=>void;
  const gate = delayed ? new Promise<void>(resolve=>{release=resolve;}) : Promise.resolve();
  const control={describe:async()=>({features:['conversation_live_complete']}),followConversation:async(request:PassiveConversationFollow)=>{
    follow=request; if(closeBeforeReturn)request.onClose('control-silent'); await gate;
    if (!request.signal?.aborted) request.onReady({snapshot:initialSnapshot,coveredThrough:0});
    return {close:()=>{closed++;}};
  }};
  const auth = new WebAuth('http://localhost','localhost',Date.now,undefined,{version:1,mode:'none'});
  const session=auth.anonymous({headers:{host:'localhost',origin:'http://localhost'}} as any);
  const web=await buildWebServer({session:async()=>control,observeRole:(_id:string, listener:any)=>{
    callback=listener; return {snapshot:()=>({...role}),subscribe:()=>({snapshot:{...role},unsubscribe(){}}),dispose(){disposed++;}};
  }} as unknown as WebServices,{origin:'http://localhost',host:'localhost'},{auth});
  await web.app.listen({host:'127.0.0.1',port:0});
  const origin=web.app.listeningOrigin; auth.setBoundary(origin,new URL(origin).host);
  return {web,auth,session,origin,get follow(){return follow;},get disposed(){return disposed;},get closed(){return closed;},release:()=>release?.(),change:(state:Partial<ConversationRoleState>)=>{Object.assign(role,state);callback?.({...role});}};
}
const readRecord = async(reader:ReadableStreamDefaultReader<Uint8Array>)=>{
  const records:any[]=[];const decoder=new ConversationStreamDecoder(record=>records.push(record));
  while(!records.length) { const next=await reader.read();if(next.done)throw Error('stream ended');decoder.push(next.value); }
  return records;
};
it('opens the authenticated passive route and disposes delayed-open handles after abort', async()=>{
  const f=await streamFixture(true), abort=new AbortController();
  try {
    const denied=await fetch(f.origin+'/api/v1/roles/A/conversation/events?expectedGeneration=g&after=0');
    expect(denied.status).toBe(401); await denied.text();
    const response=await fetch(f.origin+'/api/v1/roles/A/conversation/events?expectedGeneration=g&after=0',{headers:{cookie:`ofs_session=${f.session.id}`},signal:abort.signal});
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const records=await readRecord(response.body!.getReader());
    expect(records[0]).toMatchObject({type:'role',payload:{roleLifetime:'life'}});
    expect(JSON.stringify(records)).not.toContain('/private/');
    await expect.poll(()=>f.follow?.controller).toBe(false);
    abort.abort(); f.release();
    await expect.poll(()=>f.disposed).toBe(1);
    await expect.poll(()=>f.closed).toBe(1);
  } finally {abort.abort();f.release();f.web.app.server.closeAllConnections();await f.web.close();}
});
it('keeps one observer across missing roles and closes all owners on auth revocation',async()=>{
  const f=await streamFixture(), abort=new AbortController();
  try {
    const response=await fetch(f.origin+'/api/v1/roles/A/conversation/events?expectedGeneration=g',{headers:{cookie:`ofs_session=${f.session.id}`},signal:abort.signal});
    const reader=response.body!.getReader();await readRecord(reader);
    f.change({roleRevision:2,availability:'missing'});
    const records=await readRecord(reader);expect(records.some(record=>record.type==='role')).toBe(true);
    expect(f.disposed).toBe(0);
    f.auth.clearSessions();
    await expect.poll(()=>f.disposed).toBe(1);
    expect(f.closed).toBe(1);
  } finally {abort.abort();f.web.app.server.closeAllConnections();await f.web.close();}
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer, type Socket } from 'node:net';
import { RoleControlServer, followConversation, controlSocketPath, controlTokenPath } from '../../src/session/control.js';
import { RoleSessionControlAdapter } from '../../src/application/session-control.js';
it.each(['not-json\n','x'.repeat(16*MiB+1024)])('fails closed on malformed or oversized private input %#',async input=>{
  const dir=mkdtempSync(join(tmpdir(),'sse-malformed-'));writeFileSync(controlTokenPath(dir),'secret');
  const server=netServer(socket=>{socket.once('data',()=>socket.write(input));});
  await new Promise<void>(resolve=>server.listen(controlSocketPath(dir),resolve));
  const adapter=new RoleSessionControlAdapter(dir), closed=vi.fn();
  const handle=await adapter.followConversation({controller:false,expectedGeneration:'g',onReplay(){},onReady(){},onEvent(){},onState(){},onClose:closed});
  try {await expect.poll(()=>closed.mock.calls.length,{timeout:1000}).toBe(1);}
  finally {handle.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
it('delivers exact 16 MiB through the actual private adapter under socket backpressure without attaching a controller',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sse-private-'));
  const event:any={schemaVersion:1,seq:1,sessionGeneration:'g',kind:'message.replace',source:'agent',payload:{text:''}};
  event.payload.text='x'.repeat(16*MiB-Buffer.byteLength(JSON.stringify(event)));
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(16*MiB);
  let controllers=0, emitted=0;
  const snapshot={sessionGeneration:'g',stateRevision:1,ledgerBarrier:1};
  const owner:any={snapshot:()=>snapshot,conversationPage:()=>({events:[],snapshot}),subscribeConversation:()=>()=>{},
    subscribeConversationFailure:()=>()=>{},observeConversation:()=>({snapshot,unsubscribe(){}}),conversationReplayAvailable:()=>true,
    replayConversation:async function*(){emitted++;yield {events:[event],coveredThrough:1};},setControllerAttached:(attached:boolean)=>{controllers+=attached?1:-1;}};
  const server=new RoleControlServer(dir,owner,()=>{});await server.start();
  let socket:Socket|undefined, peak=0, blocked=false;
  // Instrument the actual server socket boundary; the production progressive writer is exercised.
  (server as any).server.on('connection',(peer:Socket)=>{const write=peer.write.bind(peer);peer.write=((...args:any[])=>{
    const accepted=(write as any)(...args);peak=Math.max(peak,peer.writableLength);if(!accepted)blocked=true;return accepted;
  }) as any;});
  const adapter=new RoleSessionControlAdapter(dir,undefined,async(...args)=>{const result=await followConversation(...args);socket=result.socket;socket.pause();return result;});
  let delivered:any,ready=false;
  const handle=await adapter.followConversation({controller:false,expectedGeneration:'g',onReplay:page=>{delivered=page.events[0];},onReady:()=>{ready=true;},onEvent(){},onState(){},onClose(){}});
  try {
    await expect.poll(()=>emitted).toBe(1);
    await new Promise(resolve=>setTimeout(resolve,50));
    expect(blocked).toBe(true);expect(delivered).toBeUndefined();expect(peak).toBeLessThanOrEqual(8*MiB);
    socket!.resume();await expect.poll(()=>ready,{timeout:4000}).toBe(true);
    expect(delivered.payload.text).toHaveLength(event.payload.text.length);expect(delivered.seq).toBe(1);
    expect(controllers).toBe(0);
  } finally {handle.close();await server.close();rmSync(dir,{recursive:true,force:true});}
});
it('accepts exactly 8 MiB of encoded waiting frames and rejects the next byte budget',()=>{
  const output=new Writable({highWaterMark:1,write(){}}), closed=vi.fn();
  const writer=new ConversationStreamWriter(output,closed);
  writer.send('state',{});
  const overhead=Buffer.byteLength([...encodeConversationRecord('ledger','','unused')][0]);
  const payload='x'.repeat(512*1024-overhead);
  for(let i=0;i<16;i++)expect(writer.send('ledger',payload)).toBe(true);
  expect(writer.pendingBytes).toBe(8*MiB);expect(closed).not.toHaveBeenCalled();
  expect(writer.send('ledger','')).toBe(false);expect(closed).toHaveBeenCalledOnce();
});
it('does not extend the cookie policy through bound SSE keepalives',async()=>{
  const f=await streamFixture(),abort=new AbortController();
  try {
    const response=await fetch(f.origin+'/api/v1/roles/A/conversation/events?expectedGeneration=g',{headers:{cookie:`ofs_session=${f.session.id}`},signal:abort.signal});
    const reader=response.body!.getReader();await readRecord(reader);
    f.session.lastSeenAt=Date.now()-30*60_000;
    let records=await readRecord(reader);
    while(!records.some(record=>record.type==='resync'))records=await readRecord(reader);
    expect(records).toContainEqual(expect.objectContaining({type:'resync',payload:expect.objectContaining({reason:'auth-expired'})}));
    await expect.poll(()=>f.disposed).toBe(1);
    expect(f.auth.sessionValid(f.session)).toBe(false);
  }finally{abort.abort();f.web.app.server.closeAllConnections();await f.web.close();}
});
it('decodes a UTF-8 code point split across network reads and rejects a forged assembly revision',()=>{
  const published:any[]=[],decoder=new ConversationStreamDecoder(record=>published.push(record));
  const frame=Buffer.from([...encodeConversationRecord('state',{sessionGeneration:'g',stateRevision:3,text:'🦊'},'one')][0]);
  const split=frame.indexOf(Buffer.from('🦊'))+1;
  decoder.push(frame.subarray(0,split));expect(published).toHaveLength(0);decoder.push(frame.subarray(split));
  expect(published[0].payload.text).toBe('🦊');
  const chunks=[...encodeConversationRecord('state',{sessionGeneration:'g',stateRevision:3,text:'x'.repeat(MiB)},'two')];
  for(const chunk of chunks.slice(0,-1))decoder.push(Buffer.from(chunk));
  expect(()=>decoder.push(Buffer.from(chunks.at(-1)!.replace('"revision":3','"revision":4')))).toThrow(/revision/);
  expect(published).toHaveLength(1);
});
it('keeps two panes and another tab passive while voice independently owns its controller',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sse-consumers-'));let controllers=0,subscribers=0;
  const snapshot={sessionGeneration:'g',stateRevision:1,ledgerBarrier:0};
  const owner:any={snapshot:()=>snapshot,conversationPage:()=>({events:[],snapshot}),subscribeConversation:()=>{subscribers++;return()=>{subscribers--;};},
    subscribeConversationFailure:()=>()=>{},observeConversation:()=>({snapshot,unsubscribe(){}}),replayConversation:async function*(){},
    setControllerAttached:(attached:boolean)=>{controllers+=attached?1:-1;}};
  const server=new RoleControlServer(dir,owner,()=>{});await server.start();
  const adapter=new RoleSessionControlAdapter(dir), handles:Array<{close():void}>=[];
  try {
    handles.push(await adapter.followConversation({onPage(){},onEvent(){},onClose(){}}));
    await expect.poll(()=>controllers).toBe(1);
    for(let index=0;index<3;index++)handles.push(await adapter.followConversation({controller:false,expectedGeneration:'g',onReplay(){},onReady(){},onEvent(){},onState(){},onClose(){}}));
    await expect.poll(()=>subscribers).toBe(4);expect(controllers).toBe(1);
    handles.pop()!.close();await expect.poll(()=>subscribers).toBe(3);expect(controllers).toBe(1);
    handles.shift()!.close();await expect.poll(()=>controllers).toBe(0);expect(subscribers).toBe(2);
  }finally{for(const handle of handles)handle.close();await server.close();rmSync(dir,{recursive:true,force:true});}
});

it('fences a follow that closes before its handle resolves',async()=>{
  const f=await streamFixture(false,true),abort=new AbortController();
  try {
    const response=await fetch(f.origin+'/api/v1/roles/A/conversation/events?expectedGeneration=g',{headers:{cookie:`ofs_session=${f.session.id}`},signal:abort.signal});
    const records=await readRecord(response.body!.getReader());
    expect(records.some(record=>record.type==='ready')).toBe(false);
    await expect.poll(()=>f.closed).toBe(1);
  }finally{abort.abort();f.web.app.server.closeAllConnections();await f.web.close();}
});
it('delivers an unblocked ledger immediately without a batching timer beyond 50 ms',()=>{
  vi.useFakeTimers();
  try {
    const frames:string[]=[],output=new Writable({write(chunk,_encoding,done){frames.push(chunk.toString());done();}});
    const writer=new ConversationStreamWriter(output,()=>{});
    writer.send('ledger',{seq:1,sessionGeneration:'g'});
    expect(frames).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);writer.close();
  }finally{vi.useRealTimers();}
});

it('delivers an exact 16 MiB initial snapshot before ready without charging its wrapper to assembly',async()=>{
  const snapshot={sessionGeneration:'g',stateRevision:1,ledgerBarrier:0,text:''};
  snapshot.text='x'.repeat(16*MiB-Buffer.byteLength(JSON.stringify(snapshot)));
  const f=await streamFixture(false,false,snapshot),abort=new AbortController();
  try {
    const response=await fetch(f.origin+'/api/v1/roles/A/conversation/events?expectedGeneration=g',{headers:{cookie:`ofs_session=${f.session.id}`},signal:abort.signal});
    const records:any[]=[],decoder=new ConversationStreamDecoder(record=>records.push(record)),reader=response.body!.getReader();
    while(!records.some(record=>record.type==='ready'||record.type==='resync')){const value=await reader.read();if(value.done)break;decoder.push(value.value);}
    expect(records.at(-1)).toMatchObject({type:'ready',payload:{coveredThrough:0,sessionGeneration:'g',stateRevision:1}});
    expect(records.find(record=>record.type==='state')?.payload.text).toHaveLength(snapshot.text.length);
  }finally{abort.abort();f.web.app.server.closeAllConnections();await f.web.close();}
});
it('drops a queued ready marker when the stream closes after initial state',()=>{
  const frames:string[]=[],output=new Writable({highWaterMark:1,write(chunk){frames.push(chunk.toString());}});
  const writer=new ConversationStreamWriter(output,()=>{});
  writer.send('state',{sessionGeneration:'g',stateRevision:1,ledgerBarrier:0});
  writer.send('ready',{sessionGeneration:'g',stateRevision:1,ledgerBarrier:0,coveredThrough:0});
  writer.close();output.emit('drain');
  const records:any[]=[],decoder=new ConversationStreamDecoder(record=>records.push(record));
  for(const frame of frames)decoder.push(Buffer.from(frame));
  expect(records.map(record=>record.type)).toEqual(['state']);
});
it('rejects empty chunks before they can accumulate without consuming assembly bytes',()=>{
  const published:unknown[]=[],decoder=new ConversationStreamDecoder(record=>published.push(record));
  const push=(frame:unknown)=>decoder.push(Buffer.from(`event: conversation\ndata: ${JSON.stringify(frame)}\n\n`));
  push({version:1,type:'start',id:'empty',recordType:'state',totalBytes:2});
  expect(()=>push({version:1,type:'chunk',id:'empty',index:0,data:''})).toThrow(/empty chunk/);
  expect(published).toEqual([]);
  expect(()=>push({version:1,type:'commit',id:'empty',totalBytes:2})).toThrow(/identity/);
});
