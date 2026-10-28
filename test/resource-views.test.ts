import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetResourceViews, canonicalResourceDescriptor, resourceFrames } from '../src/web/resource-views.js';
import { publishFleetResourceCommit } from '../src/application/resource-observer.js';
import { conversationActivity, conversationPreview } from '../src/application/conversation-history.js';
import { stateRoot } from '../src/paths.js';
import { open } from 'node:fs/promises';
const clean:Array<()=>void>=[];
afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
// Churn tests keep activity coalescing active with a short interval; its production bound has its own test.
function fixture(project:(descriptor:any,signal:AbortSignal)=>Promise<unknown>,authorized=()=>true,configPath?:string|((root:string)=>string),activityIntervalMs=20){
  const root=mkdtempSync(join(tmpdir(),'resource-views-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const response=new EventEmitter() as any;response.write=vi.fn(()=>true);response.end=vi.fn();
  const handles:any[]=[];
  const resources=new FleetResourceViews({paths:[root],roots:[root],...(configPath?{configPath:typeof configPath==='function'?configPath(root):configPath}:{}),watch:()=>{const h=new EventEmitter() as any;h.close=vi.fn();handles.push(h);return h;}},project,()=>[],activityIntervalMs);
  const connection=resources.open(response,'owner',authorized);clean.push(()=>resources.close());
  const frames=()=>response.write.mock.calls.map(([s]:[string])=>String(s)).filter((s:string)=>s.startsWith('event: resource\n')).map((s:string)=>JSON.parse(s.split('data: ')[1]));
  const register=(epoch=1,resource='directory',extra={})=>resources.register('owner',connection.connectionId,'view',epoch,{viewId:'view',resource,...extra});
  return {root,response,resources,connection,frames,register,handles};
}
it('publishes atomic ordered replacement snapshots, coalesces unchanged observedAt and binds initial GET without reread',async()=>{
  let rows=['B','A'],at=0;const project=vi.fn(async()=>({rows,observedAt:String(++at)}));const f=fixture(project),binding=f.register();
  const initial=await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  expect(initial.payload).toEqual({rows:['B','A'],observedAt:'1'});expect(project).toHaveBeenCalledTimes(1);
  publishFleetResourceCommit(f.root);await new Promise(setImmediate);
  expect(f.frames().filter(f=>f.kind==='snapshot')).toHaveLength(1);
  rows=['A'];publishFleetResourceCommit(f.root);await new Promise(setImmediate);
  expect(f.frames().filter(f=>f.kind==='snapshot').at(-1).payload.rows).toEqual(['A']);
  expect(f.frames().map(f=>f.sequence)).toEqual(f.frames().map((_,i)=>i+1));
  await expect(f.resources.bound('different-owner',f.connection.connectionId,'view',1,binding.baselineId)).rejects.toThrow('unknown resource connection');
});
it('fences invalidation during projection and a replaced filter/window even when old projection ignores abort',async()=>{
  let release!:(value:any)=>void;let calls=0;
  const f=fixture(async descriptor=>{if(++calls===1)return new Promise(resolve=>release=resolve);return {state:descriptor.state,rows:['new']};});
  const old=f.register(1,'tasks',{state:'active'});await expect.poll(()=>typeof release).toBe('function');
  const fresh=f.register(2,'tasks',{state:'done'});
  const baseline=await f.resources.bound('owner',f.connection.connectionId,'view',2,fresh.baselineId);
  expect(baseline.payload).toEqual({state:'done',rows:['new']});
  release({rows:['stale']});await new Promise(setImmediate);
  expect(f.frames().filter(f=>f.kind==='snapshot').every(f=>f.subscriptionEpoch===2)).toBe(true);
  await expect(f.resources.bound('owner',f.connection.connectionId,'view',1,old.baselineId)).rejects.toThrow('binding mismatch');
});
it('rereads a capture invalidated during projection and never publishes partial/error as removal',async()=>{
  let release!:(value:any)=>void,calls=0,fail=false;
  const f=fixture(async()=>{if(fail)throw Error('partial parse');if(++calls===1)return new Promise(resolve=>release=resolve);return {rows:['committed']};});
  const binding=f.register();await expect.poll(()=>typeof release).toBe('function');publishFleetResourceCommit(f.root);release({rows:[]});
  const baseline=await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  expect(baseline.payload).toEqual({rows:['committed']});
  fail=true;publishFleetResourceCommit(f.root);await new Promise(setImmediate);
  expect(f.frames().filter(f=>f.kind==='snapshot')).toHaveLength(1);
  await expect.poll(()=>f.frames().at(-1).kind).toBe('resync');
});
it('fails covered views on watch failure and fences callbacks after disposal',async()=>{
  const project=vi.fn(async()=>({rows:[]})),f=fixture(project),binding=f.register();
  await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  f.handles[0].emit('error',Error('watch failed'));await new Promise(setImmediate);
  expect(f.frames().at(-1)).toMatchObject({kind:'health',payload:{reason:'upstream_unavailable'}});
  const calls=project.mock.calls.length;publishFleetResourceCommit(f.root);await new Promise(setImmediate);expect(project).toHaveBeenCalledTimes(calls);
});
it('uses bounded wire framing and rejects unsafe descriptors',()=>{
  const frames=[...resourceFrames({protocolVersion:1,producerGeneration:'g',viewId:'view',subscriptionEpoch:1,sequence:1,revision:1,kind:'snapshot',payload:'😀'.repeat(200000)})];
  expect(frames[0].data.type).toBe('start');expect(frames.at(-1)!.data.type).toBe('commit');
  for(const frame of frames)expect(Buffer.byteLength(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)).toBeLessThanOrEqual(512*1024);
  expect(()=>canonicalResourceDescriptor({viewId:'v',resource:'previews',ids:['../../private']})).toThrow();
});
it('projects durable text/nontext chunks with the existing preview grouping, timestamp and300character selector',async()=>{
  const root=mkdtempSync(join(tmpdir(),'preview-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'.conversation'));
  const events=[
    {seq:1,kind:'message.chunk',messageId:'first',payload:{role:'assistant',content:{type:'text',text:'old'}}},
    {seq:2,kind:'message.chunk',messageId:'last',payload:{role:'assistant',content:{type:'text',text:' hi  '}}},
    {seq:3,kind:'message.chunk',messageId:'last',payload:{role:'assistant',content:{type:'image'}}},
    {seq:4,kind:'message.chunk',messageId:'last',payload:{role:'assistant',content:{type:'text',text:' there\n'}}},
  ].map(e=>({schemaVersion:1,at:String(e.seq),...e}));
  const path=join(root,'.conversation','events-000001.jsonl');writeFileSync(path,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  expect(await conversationPreview(root,new AbortController().signal)).toEqual({text:'hi [image] there',at:'4'});
  writeFileSync(path,'{"partial":');expect(await conversationPreview(root,new AbortController().signal)).toEqual({text:'No recent agent output',at:''});
  writeFileSync(join(root,'.conversation','events-000002.jsonl'),'');await expect(conversationPreview(root,new AbortController().signal)).rejects.toThrow('partial record');
});
it('reads a preview backwards only until its newest two hundred events',async()=>{
  const root=mkdtempSync(join(tmpdir(),'preview-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'.conversation'));
  const event=(seq:number,extra:object)=>JSON.stringify({schemaVersion:1,seq,at:String(seq),...extra});
  // About 3 MiB of older tool output, then 250 small events ending in one assistant message.
  const lines=[...Array.from({length:30},(_,i)=>event(i+1,{kind:'tool.upsert',pad:'x'.repeat(100*1024)})),
    ...Array.from({length:250},(_,i)=>i%2?event(i+31,{kind:'message.chunk',messageId:'m',payload:{role:'assistant',content:{type:'text',text:`w${i} `}}}):event(i+31,{kind:'thought.chunk'}))];
  writeFileSync(join(root,'.conversation','events-000001.jsonl'),lines.join('\n')+'\n');
  const probe=await open(join(root,'.conversation','events-000001.jsonl'),'r'),proto=Object.getPrototypeOf(probe);await probe.close();
  let bytes=0;const read=proto.read;
  const spy=vi.spyOn(proto,'read').mockImplementation(async function(this:unknown,...args:unknown[]){const result=await read.apply(this,args);bytes+=result.bytesRead;return result;});
  try {
    const preview=await conversationPreview(root,new AbortController().signal);
    expect(preview.at).toBe('280');expect(preview.text.startsWith('w51 w53 ')).toBe(true);
    expect(bytes).toBeLessThanOrEqual(64*1024);
  } finally {spy.mockRestore();}
});
it('reads activity only back to the newest assistant message, with the time its text preview has',async()=>{
  const root=mkdtempSync(join(tmpdir(),'preview-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'.conversation'));
  const event=(seq:number,extra:object)=>JSON.stringify({schemaVersion:1,seq,at:String(seq),...extra});
  const path=join(root,'.conversation','events-000001.jsonl');
  expect(await conversationActivity(join(root,'missing'),new AbortController().signal)).toEqual({at:''});
  // Large older tool output, an assistant message, then large newer tool output.
  const lines=[...Array.from({length:10},(_,i)=>event(i+1,{kind:'tool.upsert',pad:'x'.repeat(100*1024)})),
    event(11,{kind:'message.chunk',messageId:'m',payload:{role:'assistant',content:{type:'text',text:'done'}}}),
    ...Array.from({length:8},(_,i)=>event(i+12,{kind:'tool.upsert',pad:'y'.repeat(100*1024)}))];
  writeFileSync(path,lines.join('\n')+'\n');
  const probe=await open(path,'r'),proto=Object.getPrototypeOf(probe);await probe.close();
  let bytes=0;const read=proto.read;
  const spy=vi.spyOn(proto,'read').mockImplementation(async function(this:unknown,...args:unknown[]){const result=await read.apply(this,args);bytes+=result.bytesRead;return result;});
  try {
    expect(await conversationActivity(root,new AbortController().signal)).toEqual({at:'11'});
    const activityBytes=bytes;bytes=0;
    expect((await conversationPreview(root,new AbortController().signal)).at).toBe('11');
    expect(activityBytes).toBeLessThan(900*1024);
    expect(bytes).toBeGreaterThanOrEqual(1800*1024);
  } finally {spy.mockRestore();}
  // No assistant message within the newest events: no time, as for the text preview.
  writeFileSync(path,Array.from({length:250},(_,i)=>event(i+1,{kind:'thought.chunk'})).join('\n')+'\n');
  expect(await conversationActivity(root,new AbortController().signal)).toEqual({at:''});
  expect((await conversationPreview(root,new AbortController().signal)).at).toBe('');
  // An assistant message older than the newest two hundred events is not activity, for either.
  writeFileSync(path,[event(1,{kind:'message.chunk',payload:{role:'assistant',content:{type:'text',text:'old'}}}),...Array.from({length:200},(_,i)=>event(i+2,{kind:'thought.chunk'}))].join('\n')+'\n');
  expect(await conversationActivity(root,new AbortController().signal)).toEqual({at:''});
  expect((await conversationPreview(root,new AbortController().signal)).at).toBe('');
  // Trade-off: records older than the found message are not read, so a damaged one there no
  // longer makes the agent unavailable; a damaged record newer than it still does.
  writeFileSync(path,['{"schemaVersion":7}',event(2,{kind:'message.chunk',payload:{role:'assistant',content:{type:'text',text:'hi'}}})].join('\n')+'\n');
  expect(await conversationActivity(root,new AbortController().signal)).toEqual({at:'2'});
  await expect(conversationPreview(root,new AbortController().signal)).rejects.toThrow('preview ledger invalid');
  writeFileSync(path,[event(1,{kind:'message.chunk',payload:{role:'assistant',content:{type:'text',text:'hi'}}}),'{"schemaVersion":7}'].join('\n')+'\n');
  await expect(conversationActivity(root,new AbortController().signal)).rejects.toThrow('preview ledger invalid');
  expect(canonicalResourceDescriptor({viewId:'v',resource:'previews',ids:['a'],activityOnly:true})).toMatchObject({activityOnly:true});
  expect(()=>canonicalResourceDescriptor({viewId:'v',resource:'directory',activityOnly:true})).toThrow();
  expect(()=>canonicalResourceDescriptor({viewId:'v',resource:'previews',activityOnly:'yes'})).toThrow();
});
it('serves one authenticated canonical capture over SSE and bound HTTP, reuses redacted config serialization and retires on revocation',async()=>{
  const {buildWebServer}=await import('../src/web/server.js');
  const root=mkdtempSync(join(tmpdir(),'resource-http-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const browser={id:'browser',absoluteExpiresAt:Date.now()+60000};let revoke=()=>{};
  const query=vi.fn(async()=>[]),read=vi.fn(()=>({revision:'config-revision',model:{env:{API_KEY:'__OURS_FLEET_SECRET_REDACTED__'}}}));
  const auth={shutdown(){},validateBoundary(){},authenticate(){return browser;},sessionValid(){return true;},bindTransport(_session:unknown,close:()=>void){revoke=close;return()=>{};}};
  const web=await buildWebServer({query:{list:query},repository:{list:async()=>[]},taskRooms:{listTasks:()=>[],listTaskLists:()=>[{name:'default'}]},configuration:{read},presetProvenance:{read:()=>({role:{Example:{status:'custom'}},brain:{},template:{},layout:{}})},resourceScope:{paths:[root],roots:[]}} as any,{origin:'http://127.0.0.1',host:'127.0.0.1'},{auth:auth as any});
  const address=await web.app.listen({host:'127.0.0.1',port:0});
  const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const response=await fetch(address+'/api/v1/resource-events',{signal:abort.signal});reader=response.body!.getReader();
    let records='';const decoder=new TextDecoder();
    const until=async(test:(text:string)=>boolean)=>{while(!test(records)){const next=await reader!.read();if(next.done)throw Error('unexpected close');records+=decoder.decode(next.value,{stream:true});}};
    await until(text=>text.includes('resource-connection'));
    const connection=JSON.parse(records.split('data: ')[1].split('\n')[0]);
    const registered=await fetch(address+'/api/v1/resource-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:connection.connectionId,viewId:'config',subscriptionEpoch:1,descriptor:{viewId:'config',resource:'configuration',includeDefinitions:true}})});
    expect(registered.status).toBe(200);const binding=await registered.json() as any;
    await until(text=>text.includes('"kind":"ready"'));
    const bound=await fetch(address+'/api/v1/configuration?includeDefinitions=true',{headers:{'X-Resource-Connection':connection.connectionId,'X-Resource-View':'config','X-Resource-Epoch':'1','X-Resource-Baseline':binding.baselineId}});
    expect(bound.status).toBe(200);expect(bound.headers.get('X-Resource-Baseline')).toBe(binding.baselineId);
    const canonical=await bound.json() as any;expect(canonical.model.env.API_KEY).toBe('__OURS_FLEET_SECRET_REDACTED__');expect(canonical.provenance.role.Example.status).toBe('custom');expect(read).toHaveBeenCalledTimes(1);
    revoke();await reader.cancel();
  }finally{abort.abort();await reader?.cancel().catch(()=>{});await web.close();}
});

it('accepts narrow operation descriptors and passes authenticated owner to the canonical projection',async()=>{
  for(const descriptor of [
    {resource:'task-layout',entityId:'task-A'},
    {resource:'creation-action',entityId:'receipt-A'},
    {resource:'action',entityId:'receipt-A'},
    {resource:'member-addition',entityId:'task-A',receiptId:'receipt-A'},
    {resource:'login',entityId:'receipt-A',provider:'codex'},
    {resource:'onboarding-health'}, {resource:'subscriptions'},
  ]) expect(canonicalResourceDescriptor({viewId:'v',...descriptor})).toMatchObject(descriptor);
  expect(()=>canonicalResourceDescriptor({viewId:'v',resource:'login',entityId:'../../secret',provider:'codex'})).toThrow();
  const project=vi.fn(async()=>({state:'running'})),f=fixture(project),binding=f.register(1,'action',{entityId:'receipt-A'});
  await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  expect(project.mock.calls[0][2]).toBe('owner');
});

it('keeps owner A onboarding observation after B projects health and emits canonical operation terminal/deleted snapshots',async()=>{
  const {buildWebServer}=await import('../src/web/server.js');
  const {FleetEventBus}=await import('../src/web/events.js');
  const root=mkdtempSync(join(tmpdir(),'resource-owners-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const events=new FleetEventBus();let revision='one';
  const receipts=new Map([['operation',{actionId:'operation',state:'running'}]]);
  const auth={shutdown(){},validateBoundary(){},authenticate(request:any){return {id:String(request.headers['x-owner']??'A'),absoluteExpiresAt:Date.now()+60000};},sessionValid(){return true;},bindTransport(){return()=>{};}};
  const web=await buildWebServer({query:{list:async()=>[]},repository:{list:async()=>[]},commands:{get:(id:string)=>receipts.get(id)},configuration:{read:()=>({revision,model:{agents:{}}})},subscriptions:{list:async()=>[]},events,resourceScope:{paths:[root],roots:[],subscribeMutations:listener=>events.subscribeResources(listener)}} as any,{origin:'http://127.0.0.1',host:'127.0.0.1'},{auth:auth as any});
  const address=await web.app.listen({host:'127.0.0.1',port:0});
  const abort=new AbortController(),readers:ReadableStreamDefaultReader<Uint8Array>[]=[];
  const open=async(owner:string)=>{
    const response=await fetch(address+'/api/v1/resource-events',{signal:abort.signal,headers:{'X-Owner':owner}});
    const reader=response.body!.getReader();readers.push(reader);let records='';const decoder=new TextDecoder();
    const until=async(test:(text:string)=>boolean)=>{while(!test(records)){const next=await reader.read();if(next.done)throw Error('unexpected close');records+=decoder.decode(next.value,{stream:true});}};
    await until(text=>text.includes('resource-connection'));const connection=JSON.parse(records.split('data: ')[1].split('\n')[0]);
    let epoch=0;
    const read=async(resource:string,entityId?:string)=>{
      const registered=await fetch(address+'/api/v1/resource-subscriptions',{method:'POST',headers:{'Content-Type':'application/json','X-Owner':owner},body:JSON.stringify({connectionId:connection.connectionId,viewId:'view',subscriptionEpoch:++epoch,descriptor:{viewId:'view',resource,...(entityId?{entityId}:{})}})});
      expect(registered.status).toBe(200);const binding=await registered.json() as any;
      const bound=await fetch(address+'/api/v1/'+resource,{headers:{'X-Owner':owner,'X-Resource-Connection':connection.connectionId,'X-Resource-View':'view','X-Resource-Epoch':String(epoch),'X-Resource-Baseline':binding.baselineId}});
      expect(bound.status).toBe(200);return bound.json();
    };
    return {read};
  };
  try {
    const initial=await web.app.inject({method:'GET',url:'/api/v1/onboarding',headers:{'X-Owner':'A'}});
    expect(initial.statusCode).toBe(200);const report=initial.json();
    const A=await open('A'),B=await open('B');
    expect(await A.read('onboarding-health')).toMatchObject({observationCurrent:true,catalog:report.catalog});
    expect(await B.read('onboarding-health')).toMatchObject({observationCurrent:false});
    expect(await A.read('onboarding-health')).toMatchObject({observationCurrent:true,catalog:report.catalog});
    expect(await A.read('action','operation')).toEqual({actionId:'operation',state:'running'});
    receipts.set('operation',{actionId:'operation',state:'succeeded'});events.publish('action.changed',{});
    expect(await A.read('action','operation')).toEqual({actionId:'operation',state:'succeeded'});
    receipts.delete('operation');events.publish('action.changed',{});
    expect(await A.read('action','operation')).toEqual({deleted:true,id:'operation'});
    revision='two';events.publish('configuration.changed',{});
    expect(await A.read('onboarding-health')).toMatchObject({observationCurrent:false});
  } finally {abort.abort();await Promise.all(readers.map(reader=>reader.cancel().catch(()=>{})));await web.close();}
});

it('retains validated retirement fences before registration and permits only newer replacement',async()=>{
 const f=fixture(async()=>({rows:[]}));
 f.resources.remove('owner',f.connection.connectionId,'view',2);
 expect(()=>f.register(1)).toThrow('obsolete');expect(()=>f.register(2)).toThrow('obsolete');
 const binding=f.register(3);await f.resources.bound('owner',f.connection.connectionId,'view',3,binding.baselineId);
 f.resources.remove('owner',f.connection.connectionId,'view',1);
 expect((await f.resources.bound('owner',f.connection.connectionId,'view',3,binding.baselineId)).payload).toEqual({rows:[]});
 expect(()=>f.resources.remove('owner',f.connection.connectionId,'bad/id',1)).toThrow('invalid');
 expect(()=>f.resources.remove('owner',f.connection.connectionId,'view',NaN)).toThrow('invalid');
});
it('bounds retained retirement identities without dropping old fences',()=>{
 const f=fixture(async()=>({rows:[]}));
 for(let n=0;n<256;n++)f.resources.remove('owner',f.connection.connectionId,'v'+n,1);
 expect(()=>f.resources.remove('owner',f.connection.connectionId,'overflow',1)).toThrow('capacity');
 expect(()=>f.resources.register('owner',f.connection.connectionId,'v0',1,{viewId:'v0',resource:'directory'})).toThrow('obsolete');
});

it('retires registration when its control response is aborted before finish',async()=>{
 const {buildWebServer}=await import('../src/web/server.js');
 const root=mkdtempSync(join(tmpdir(),'resource-abort-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const browser={id:'owner',absoluteExpiresAt:Date.now()+60000};
 const auth={shutdown(){},validateBoundary(){},authenticate(){return browser;},sessionValid(){return true;},bindTransport(){return()=>{};}};
 const web=await buildWebServer({query:{list:async()=>[]},repository:{list:async()=>[]},taskRooms:{listTasks:()=>[],listTaskLists:()=>[]},resourceScope:{paths:[root],roots:[]}}as any,{origin:'http://127.0.0.1',host:'127.0.0.1'},{auth:auth as any});
 let entered!:()=>void,closed!:()=>void,release!:()=>void,baseline='';
 const waiting=new Promise<void>(r=>entered=r),closing=new Promise<void>(r=>closed=r),held=new Promise<void>(r=>release=r);
 web.app.addHook('onSend',async(request,reply,payload)=>{
  if(request.headers['x-hold']){baseline=JSON.parse(String(payload)).baselineId;reply.raw.once('close',closed);entered();await held;}
  return payload;
 });
 const address=await web.app.listen({host:'127.0.0.1',port:0});const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const response=await fetch(address+'/api/v1/resource-events');reader=response.body!.getReader();const first=await reader.read();const connection=JSON.parse(new TextDecoder().decode(first.value).split('data: ')[1].split('\n')[0]);
  const body={connectionId:connection.connectionId,viewId:'view',subscriptionEpoch:1,descriptor:{viewId:'view',resource:'directory'}};
  const pending=fetch(address+'/api/v1/resource-subscriptions',{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json','X-Hold':'true'},body:JSON.stringify(body)}).catch(()=>{});
  await waiting;abort.abort();await closing;release();await pending;
  const retired=await fetch(address+'/api/v1/directory',{headers:{'X-Resource-Connection':connection.connectionId,'X-Resource-View':'view','X-Resource-Epoch':'1','X-Resource-Baseline':baseline}});
  expect(retired.status).toBe(409);
  const newer=await fetch(address+'/api/v1/resource-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,subscriptionEpoch:2})});expect(newer.status).toBe(200);
 }finally{release();abort.abort();await reader?.cancel().catch(()=>{});await web.close();}
});

for (const resource of ['configuration', 'previews']) it(`keeps ${resource} ready and live during unrelated role ledger churn`, async () => {
  vi.useFakeTimers({toFake:['setInterval', 'clearInterval', 'Date']}); clean.push(() => vi.useRealTimers());
  let value = 'initial', reads = 0;
  const f = fixture(async () => {
    reads++;
    // A different role continues committing during every canonical capture.
    publishFleetResourceCommit(join(f.root, 'other', '.conversation', 'events-000001.jsonl'));
    return {value};
  },()=>true,resource==='configuration'?root=>join(root,'fleet.yaml'):undefined);
  const binding = f.register(1, resource, resource === 'previews' ? {ids:['selected']} : {});
  const initial = await f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId);
  expect(initial.payload).toEqual({value:'initial'});
  value = 'updated';
  publishFleetResourceCommit(resource === 'previews'
    ? join(f.root, 'selected', '.conversation', 'events-000001.jsonl') : join(f.root, 'fleet.yaml'));
  await new Promise(setImmediate);
  await expect.poll(()=>f.frames().filter(frame => frame.kind === 'snapshot').at(-1).payload).toEqual({value:'updated'});
  expect(f.frames().filter(frame => frame.kind === 'snapshot').at(-1).source).toMatchObject({protocolVersion:1});
  expect(f.frames().some(frame => frame.kind === 'resync' || frame.kind === 'health')).toBe(false);
  const settled = reads;
  for (let n = 0; n < 12; n++) publishFleetResourceCommit(join(f.root, 'other', '.conversation', 'events-000001.jsonl'));
  await new Promise(setImmediate);
  expect(reads).toBe(settled);
  const captured = f.frames().filter(frame => frame.kind === 'snapshot').at(-1).source;
  await vi.advanceTimersByTimeAsync(15000);
  const batches = f.response.write.mock.calls.map(([s]:[string])=>s).filter(s=>s.startsWith('event: resource-coverage\n')).map(s=>JSON.parse(s.split('data: ')[1]));
  expect(batches).toHaveLength(1);
  expect(batches[0].views[0].source).toEqual(captured);
  expect(reads).toBe(settled);
});
it('readies committed selected previews during sustained appends and drains their starting watermarks in order', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});
  clean.push(()=>vi.useRealTimers());
  let reads = 0, commits = 0, readyAt = -1;
  const event = (seq:number) => JSON.stringify({schemaVersion:1,seq,at:String(seq),kind:'message.replace',messageId:'reply',payload:{role:'assistant',content:{type:'text',text:`reply ${seq}`}}})+'\n';
  const f = fixture(async (_descriptor, signal) => {
    reads++;
    const preview = await conversationPreview(join(f.root, 'selected'), signal);
    if (commits < 8) {
      commits++;
      appendFileSync(file, event(commits));
      publishFleetResourceCommit(file);
      publishFleetResourceCommit(join(dir, 'manifest.json'));
    }
    return {previews:{selected:preview}};
  }, undefined, undefined, 0); // Every follow-up in order; coalescing has its own tests.
  const dir=join(f.root,'selected','.conversation');mkdirSync(dir,{recursive:true});
  const file=join(dir,'events-000001.jsonl');writeFileSync(file,event(0));
  f.response.write.mockImplementation((text:string)=>{if(text.includes('"kind":"ready"'))readyAt=commits;return true;});
  const binding = f.register(1, 'previews', {ids:['selected']});
  const initial=await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  expect(initial.payload).toEqual({previews:{selected:{text:'reply 0',at:'0'}}});
  expect(initial.source.position).toBe(0);
  expect(readyAt).toBe(1); // Ready while seven more captures will overlap commits.
  await expect.poll(()=>f.frames().filter(frame=>frame.kind==='snapshot').at(-1)?.payload.previews.selected.text).toBe('reply 8');
  const snapshots=f.frames().filter(frame=>frame.kind==='snapshot');
  expect(snapshots.map(frame=>frame.payload.previews.selected.at)).toEqual(Array.from({length:9},(_,i)=>String(i)));
  expect(snapshots.map(frame=>frame.source.position)).toEqual(Array.from({length:9},(_,i)=>i*2));
  expect(f.frames().some(frame=>frame.kind==='resync'||frame.kind==='health')).toBe(false);
  // Discover the directories created after initial watch installation, then
  // verify idle coverage does not reopen completed preview records.
  await vi.advanceTimersByTimeAsync(100);await new Promise(setImmediate);
  const settled=reads;await vi.advanceTimersByTimeAsync(60_000);
  expect(reads).toBe(settled);
});

it('keeps selected previews live while independent task layout receipts commit during every capture', async () => {
  let value = 'initial', reads = 0;
  const f = fixture(async () => {
    reads++;
    // A task worker writes its run and operation receipts independently of
    // role membership/configuration and the selected conversation ledgers.
    publishFleetResourceCommit(join(stateRoot(), 'layouts', 'task-observed.json'));
    publishFleetResourceCommit(join(stateRoot(), 'layouts', 'task-observed.op.json'));
    publishFleetResourceCommit(join(stateRoot(), 'layouts', 'task-observed.brief.md'));
    return {value};
  });
  vi.stubEnv('OURS_FLEET_HOME', f.root); clean.push(() => vi.unstubAllEnvs());
  const binding = f.register(1, 'previews', {ids:['selected']});
  const initial = await f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId);
  expect(initial.payload).toEqual({value:'initial'});
  value = 'committed';
  publishFleetResourceCommit(join(f.root, 'selected', '.conversation', 'events-000001.jsonl'));
  await new Promise(setImmediate);
  await expect.poll(()=>f.frames().filter(frame => frame.kind === 'snapshot').at(-1).payload).toEqual({value:'committed'});
  expect(f.frames().some(frame => frame.kind === 'resync' || frame.kind === 'health')).toBe(false);
  expect(reads).toBe(2);
});

it.each(['unknown.json','nested/events-000001.jsonl'])('retains selected preview capture fencing for unknown ledger path %s', async filename => {
  let reads=0;
  const f=fixture(async()=>{
    reads++;publishFleetResourceCommit(join(f.root,'selected','.conversation',filename));
    return {previews:{selected:{text:'unstable',at:''}}};
  });
  const binding=f.register(1,'previews',{ids:['selected']});
  await expect(f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId)).rejects.toThrow('unstable');
  expect(reads).toBe(3);
  expect(f.frames().some(frame=>frame.kind==='snapshot'||frame.kind==='ready')).toBe(false);
});

it('retains preview authority for an explicit config named as a known ledger manifest', async()=>{
  let reads=0;
  const f=fixture(async()=>{
    reads++;publishFleetResourceCommit(join(f.root,'selected','.conversation','manifest.json'));
    return {previews:{selected:{text:'stale',at:''}}};
  },()=>true,root=>join(root,'selected','.conversation','manifest.json'));
  const binding=f.register(1,'previews',{ids:['selected']});
  await expect(f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId)).rejects.toThrow('unstable');
  expect(reads).toBe(3);
  expect(f.frames().some(frame=>frame.kind==='snapshot'||frame.kind==='ready')).toBe(false);
});

for (const [resource, filename] of [['directory', 'task-observed.op.json'], ['previews', 'unknown.json']]) {
  it(`retains capture fencing for ${resource} during ${filename} commits`, async () => {
    let reads = 0;
    const f = fixture(async () => {
      reads++;
      publishFleetResourceCommit(join(stateRoot(), 'layouts', filename));
      return {value:'unstable'};
    });
    vi.stubEnv('OURS_FLEET_HOME', f.root); clean.push(() => vi.unstubAllEnvs());
    const binding = f.register(1, resource, resource === 'previews' ? {ids:['selected']} : {});
    await expect(f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId)).rejects.toThrow('unstable');
    expect(reads).toBe(3);
    expect(f.frames().some(frame => frame.kind === 'snapshot')).toBe(false);
  });
}

it('fences a selected preview capture when its explicit config path resembles a task receipt', async () => {
  const home = mkdtempSync(join(tmpdir(), 'resource-custom-config-'));
  clean.push(() => rmSync(home, {recursive:true,force:true}));
  vi.stubEnv('OURS_FLEET_HOME', home); clean.push(() => vi.unstubAllEnvs());
  const configPath = join(stateRoot(), 'layouts', 'task-config.json');
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    publishFleetResourceCommit(configPath);
    return {value:'unstable config'};
  }, () => true, configPath);
  const binding = f.register(1, 'previews', {ids:['selected']});
  await expect(f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId)).rejects.toThrow('unstable');
  expect(reads).toBe(3);
  expect(f.frames().some(frame => frame.kind === 'snapshot')).toBe(false);
});

it('keeps committed previews live through an incomplete append and publishes its completed record', async () => {
  const f = fixture(async (_descriptor, signal) => ({previews:{selected:await conversationPreview(join(f.root, 'selected'), signal)}}));
  const dir = join(f.root, 'selected', '.conversation'); mkdirSync(dir, {recursive:true});
  const file = join(dir, 'events-000001.jsonl');
  const event = (seq: number, text: string) => JSON.stringify({schemaVersion:1,seq,at:String(seq),kind:'message.replace',messageId:'reply',payload:{role:'assistant',content:{type:'text',text}}});
  const committed = event(1, 'previous committed reply') + '\n';
  const next = event(2, 'new committed reply');
  writeFileSync(file, committed + next.slice(0, 30));
  const binding = f.register(1, 'previews', {ids:['selected']});
  const initial = await f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId);
  expect(initial.payload).toEqual({previews:{selected:{text:'previous committed reply',at:'1'}}});
  writeFileSync(file, committed + next + '\n'); publishFleetResourceCommit(file);
  await expect.poll(() => f.frames().filter(frame => frame.kind === 'snapshot').at(-1).payload).toEqual({previews:{selected:{text:'new committed reply',at:'2'}}});
  expect(f.frames().some(frame => frame.kind === 'resync')).toBe(false);
  writeFileSync(file, committed + '{malformed complete record}\n');
  await expect(conversationPreview(join(f.root, 'selected'), new AbortController().signal)).rejects.toThrow();
});

for (const resource of ['directory', 'roles']) it.each(['.conversation/events-000001.jsonl', '.notify-cursor', '.monitor-state.json', '.monitor-status'])(`keeps ${resource} ready and ordered through sustained independent agent status commits (%s)`, async activityPath => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});clean.push(()=>vi.useRealTimers());
  const status = { A: 0, B: 0 };
  let commits = 0, reads = 0, readyAt = -1;
  const f = fixture(async () => {
    reads++;
    // Canonical list rows are independent last-observed status captures. Each
    // capture overlaps another owner's commit, including beyond three attempts.
    const rows = Object.entries(status).map(([id, sequence]) => ({role:{id}, status:{sequence}, capabilities:{read:true}}));
    await Promise.resolve();
    if (commits < 8) {
      const id = commits++ % 2 === 0 ? 'A' : 'B';
      status[id]++;
      const path=join(f.root,id,activityPath);
      mkdirSync(join(f.root,id,...activityPath.split('/').slice(0,-1)),{recursive:true});
      writeFileSync(path,String(status[id]));
      publishFleetResourceCommit(path);
    }
    return resource === 'directory' ? {roles:rows,tasks:[],lists:[]} : {roles:rows};
  }, undefined, undefined, 0); // Every follow-up in order; coalescing has its own tests.
  f.response.write.mockImplementation((text:string) => {
    if (text.includes('"kind":"ready"')) readyAt = commits;
    return true;
  });
  const binding = f.register(1, resource);
  const initial = await f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId);
  expect(readyAt).toBeGreaterThan(0);
  expect(readyAt).toBeLessThan(8); // Readiness must not wait for global quiet.
  expect(initial.source.position).toBe(0); // The commit during this capture is still queued.
  expect((initial.payload as any).roles.map((row:any) => row.status.sequence)).toEqual([0,0]);
  await new Promise(setImmediate);
  await expect.poll(()=>f.frames().filter(frame => frame.kind === 'snapshot').at(-1)?.payload.roles.map((row:any) => row.status.sequence)).toEqual([4,4]);
  let accepted = [0,0];
  for (const frame of f.frames()) {
    if (frame.kind === 'snapshot') {
      const next = frame.payload.roles.map((row:any) => row.status.sequence);
      expect(next[0]).toBeGreaterThanOrEqual(accepted[0]); expect(next[1]).toBeGreaterThanOrEqual(accepted[1]);
      accepted = next;
    }
    if (frame.kind === 'ready' || frame.kind === 'coverage')
      expect(frame.payload.source.position).toBe(accepted[0] + accepted[1]);
  }
  expect(f.frames().some(frame => frame.kind === 'resync' || frame.kind === 'health')).toBe(false);
  // These commits created new role directories. The observer's deferred discovery
  // installs their watches and requires one final capture even after [4,4] arrived.
  const beforeDiscovery = reads;
  const snapshots = f.frames().filter(frame => frame.kind === 'snapshot').length;
  await vi.advanceTimersByTimeAsync(100);
  await new Promise(setImmediate);
  expect(reads).toBe(beforeDiscovery + 1);
  expect(f.frames().filter(frame => frame.kind === 'snapshot')).toHaveLength(snapshots);
  const settled = reads;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reads).toBe(settled); // No content work during four settled health periods.
});

it('fences an in-flight old agent row on structural removal and replacement while retaining status wakes', async () => {
  let release!:(value:any)=>void, reads=0;
  let rows = [{role:{id:'A',generation:'old'},status:{sequence:0},capabilities:{}}];
  const f=fixture(async()=>{
    reads++;
    const captured=structuredClone(rows);
    if(reads===2) return new Promise(resolve=>release=resolve);
    return {roles:captured,tasks:[],lists:[]};
  });
  const binding=f.register();
  await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  publishFleetResourceCommit(join(f.root,'A','.conversation','events-000001.jsonl'));
  await expect.poll(()=>typeof release).toBe('function');
  rows=[];
  publishFleetResourceCommit(join(f.root,'A')); // Canonical membership removal, not status.
  release({roles:[{role:{id:'A',generation:'old'},status:{sequence:99},capabilities:{}}],tasks:[],lists:[]});
  await expect.poll(()=>f.frames().filter(frame=>frame.kind==='snapshot').at(-1)?.payload.roles).toEqual([]);
  rows=[{role:{id:'A',generation:'new'},status:{sequence:0},capabilities:{}}];
  publishFleetResourceCommit(join(f.root,'A'));
  await expect.poll(()=>f.frames().filter(frame=>frame.kind==='snapshot').at(-1)?.payload.roles[0]?.role.generation).toBe('new');
  expect(f.frames().filter(frame=>frame.kind==='snapshot').some(frame=>frame.payload.roles.some((row:any)=>row.status.sequence===99))).toBe(false);
});

it('still bounds continuously changing directory structure to three capture attempts', async()=>{
  let reads=0;
  const f=fixture(async()=>{reads++;publishFleetResourceCommit(join(f.root,'A'));return {roles:[],tasks:[],lists:[]};});
  const binding=f.register();
  await expect(f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId)).rejects.toThrow('unstable');
  expect(reads).toBe(3);
  expect(f.frames().some(frame=>frame.kind==='snapshot'||frame.kind==='ready')).toBe(false);
});

it('accepts canonical query activity with actual conversation, diagnostic and usage persistence during capture', async () => {
  const {FleetQueryService}=await import('../src/application/fleet-query-service.js');
  const {ConversationEventStore}=await import('../src/session/conversation-store.js');
  const {SessionEvents}=await import('../src/session/events.js');
  const {recordClaudeRateLimit}=await import('../src/subscriptions/observed.js');
  let commits=0;
  const f=fixture(async()=>({roles:await query.list(true,true),tasks:[],lists:[]}));
  const dir=join(f.root,'A');mkdirSync(dir);
  const conversation=new ConversationEventStore(join(dir,'.conversation'),{roleId:'A',segmentBytes:1});
  clean.push(()=>conversation.close());
  const events=new SessionEvents(join(dir,'.session-events.jsonl'));
  const role={id:'A',lifetime:'permanent',configured:true,stateRef:{lifetime:'permanent'},stateHealth:'present',configuredBackend:'acp',detectedBackend:'acp',compatibility:{compatible:true},problems:[]};
  const query=new FleetQueryService({
    repository:{list:async()=>[role],stateDir:()=>dir} as any,
    supervisor:{id:'none',liveness:async()=>({state:'running',detail:'active'})} as any,
    control:async()=>{
      const captured=commits;
      await Promise.resolve();
      if(commits<5) {
        commits++;
        conversation.append({kind:'message.chunk',sessionGeneration:'g',messageId:'reply',payload:{role:'assistant',content:{type:'text',text:String(commits)}}} as any);
        events.emit('agent_text',{text:String(commits)});
        recordClaudeRateLimit(dir,{rateLimitType:'five_hour',utilization:commits/10});
        // Deliver the actual writers' committed paths through the existing
        // observer seam; native event delivery is qualified by observer tests.
        for(const file of ['.conversation/manifest.json','.conversation/events-000001.jsonl','.session-events.jsonl','.session-events.jsonl.1','.subscription-usage.json'])
          publishFleetResourceCommit(join(dir,file));
      }
      return {ok:true,result:{backend:'acp',alive:true,readiness:'working',activity:{activeToolCalls:captured,lastUpdateAt:new Date(captured*1000).toISOString()}}} as any;
    },
  });
  const binding=f.register();
  const initial=await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  expect((initial.payload as any).roles[0].status.session.activity.activeToolCalls).toBe(0);
  expect(initial.source.position).toBe(0);
  await expect.poll(()=>f.frames().filter(frame=>frame.kind==='snapshot').at(-1)?.payload.roles[0].status.session.activity.activeToolCalls).toBe(5);
  expect(f.frames().some(frame=>frame.kind==='resync')).toBe(false);
});

it('shares sparse idle coverage without reprojection or snapshots across current views',async()=>{
  vi.useFakeTimers();clean.push(()=>vi.useRealTimers());
  const project=vi.fn(async()=>({rows:[]})),f=fixture(project);
  for(const viewId of ['one','two']) {
    const binding=f.resources.register('owner',f.connection.connectionId,viewId,1,{viewId,resource:'directory'});
    await f.resources.bound('owner',f.connection.connectionId,viewId,1,binding.baselineId);
  }
  f.response.write.mockClear();project.mockClear();
  await vi.advanceTimersByTimeAsync(60000);
  const writes=f.response.write.mock.calls.map(([s]:[string])=>s);
  const batches=writes.filter(s=>s.startsWith('event: resource-coverage\n')).map(s=>JSON.parse(s.split('data: ')[1]));
  expect(batches.length).toBeGreaterThanOrEqual(4);expect(batches.length).toBeLessThanOrEqual(5);
  expect(batches.flatMap(b=>b.views)).toHaveLength(8);
  expect(batches[0].views.map((v:any)=>[v.viewId,v.sequence])).toEqual([['one',3],['two',3]]);
  expect(f.frames()).toHaveLength(0);expect(project).not.toHaveBeenCalled();
});
it('qualifies changed data with captured source and suppresses its immediate coverage',async()=>{
  let rows=['old'];const f=fixture(async()=>({rows})),binding=f.register();
  await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  f.response.write.mockClear();rows=['new'];publishFleetResourceCommit(f.root);await new Promise(setImmediate);
  await expect.poll(()=>f.frames()).toHaveLength(1);
  expect(f.frames()[0]).toMatchObject({kind:'snapshot',source:{protocolVersion:1,position:1},payload:{rows:['new']}});
});
it('excludes pending, failed and replaced registrations while an unchanged sibling stays covered',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});clean.push(()=>vi.useRealTimers());
  let hold=false,release!:(payload:unknown)=>void;
  const f=fixture(async d=>d.viewId==='pending'&&hold?new Promise(r=>release=r):({rows:[d.viewId]}),undefined,undefined,0);
  for(const viewId of ['quiet','pending']){
    const binding=f.resources.register('owner',f.connection.connectionId,viewId,1,{viewId,resource:'previews',ids:[viewId]});
    await f.resources.bound('owner',f.connection.connectionId,viewId,1,binding.baselineId);
  }
  hold=true;publishFleetResourceCommit(join(f.root,'pending','.conversation','events-000001.jsonl'));await new Promise(setImmediate);
  f.response.write.mockClear();await vi.advanceTimersByTimeAsync(15000);
  const batches=()=>f.response.write.mock.calls.map(([s]:[string])=>s).filter(s=>s.startsWith('event: resource-coverage\n')).map(s=>JSON.parse(s.split('data: ')[1]));
  expect(batches().at(-1).views.map((v:any)=>v.viewId)).toEqual(['quiet']);
  hold=false;const replacement=f.resources.register('owner',f.connection.connectionId,'pending',2,{viewId:'pending',resource:'previews',ids:['pending']});
  await f.resources.bound('owner',f.connection.connectionId,'pending',2,replacement.baselineId);release({rows:['obsolete']});await new Promise(setImmediate);
  expect(f.frames().filter(f=>f.kind==='snapshot').every(f=>f.subscriptionEpoch===2)).toBe(true);
  await vi.advanceTimersByTimeAsync(15000);
  expect(batches().at(-1).views.map((v:any)=>[v.viewId,v.subscriptionEpoch])).toEqual([['quiet',1],['pending',2]]);
  f.handles[0].emit('error',Error('failed'));await new Promise(setImmediate);const count=batches().length;
  await vi.advanceTimersByTimeAsync(30000);expect(batches()).toHaveLength(count);
});
it('keeps a shared coverage batch behind the complete chunked record under backpressure',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});clean.push(()=>vi.useRealTimers());
  const f=fixture(async d=>({rows:[d.viewId==='large'?'x'.repeat(900000):'quiet']}));
  const quiet=f.resources.register('owner',f.connection.connectionId,'quiet',1,{viewId:'quiet',resource:'directory'});
  await f.resources.bound('owner',f.connection.connectionId,'quiet',1,quiet.baselineId);
  f.response.write.mockClear();f.response.write.mockImplementationOnce(()=>false);
  const large=f.resources.register('owner',f.connection.connectionId,'large',1,{viewId:'large',resource:'directory'});
  await new Promise(setImmediate);await vi.advanceTimersByTimeAsync(15000);
  expect(f.response.write.mock.calls).toHaveLength(1);
  f.response.emit('drain');await f.resources.bound('owner',f.connection.connectionId,'large',1,large.baselineId);
  const writes=f.response.write.mock.calls.map(([s]:[string])=>s);
  const commit=writes.findIndex(s=>s.startsWith('event: resource-chunk\n')&&JSON.parse(s.split('data: ')[1]).type==='commit');
  const batch=writes.findIndex(s=>s.startsWith('event: resource-coverage\n'));
  expect(commit).toBeGreaterThan(0);expect(batch).toBeGreaterThan(commit);
  expect(JSON.parse(writes[batch].split('data: ')[1]).views.map((v:any)=>[v.viewId,v.sequence])).toEqual([['quiet',3]]);
});

it('retains two-second idle authorization enforcement independently of sparse wire health',async()=>{
  vi.useFakeTimers();clean.push(()=>vi.useRealTimers());
  let valid=true;const authorized=vi.fn(()=>valid),f=fixture(async()=>({rows:[]}),authorized),binding=f.register();
  await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  f.response.write.mockClear();await vi.advanceTimersByTimeAsync(60000);
  expect(authorized).toHaveBeenCalledTimes(34); // 30 admission checks + four health-send checks.
  expect(f.response.write.mock.calls).toHaveLength(4);
  valid=false;await vi.advanceTimersByTimeAsync(2000);expect(f.response.end).toHaveBeenCalledTimes(1);
});

describe('activity follow-up coalescing', () => {
  const activity = (root:string) => join(root, 'A', '.conversation', 'events-000001.jsonl');
  const setup = async () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});clean.push(()=>vi.useRealTimers());
    let state = 0;
    const project = vi.fn(async () => ({roles:[{id:'A', state}]}));
    const f = fixture(project, undefined, undefined, 1000);
    const binding = f.register();
    await f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId);
    const commit = async (path:string) => {state++;publishFleetResourceCommit(path);for(let i=0;i<5;i++)await new Promise(setImmediate);};
    const latest = () => f.frames().filter(frame => frame.kind === 'snapshot').at(-1)?.payload.roles[0].state;
    const advance = async (ms:number) => {await vi.advanceTimersByTimeAsync(ms);for(let i=0;i<5;i++)await new Promise(setImmediate);};
    return {f, project, commit, latest, advance};
  };
  it('re-projects sustained agent activity once per interval and always ends with a trailing capture', async () => {
    const {f, project, commit, latest, advance} = await setup();
    for (let n = 0; n < 10; n++) { await commit(activity(f.root)); await advance(50); }
    expect(project).toHaveBeenCalledTimes(1); // Ten appends inside the first interval add no capture yet.
    await advance(600);
    expect(project).toHaveBeenCalledTimes(2);
    expect(latest()).toBe(10); // The trailing capture observes every append.
    await advance(5000);
    expect(project).toHaveBeenCalledTimes(2); // Quiet afterwards.
  });
  it('captures a structural change immediately during the activity interval', async () => {
    const {f, project, commit, latest} = await setup();
    await commit(activity(f.root));
    expect(project).toHaveBeenCalledTimes(1);
    await commit(join(f.root, 'A', 'role.yaml'));
    expect(project).toHaveBeenCalledTimes(2);
    expect(latest()).toBe(2);
  });
  it('drops a pending activity capture when its view is retired', async () => {
    const {f, project, commit, advance} = await setup();
    await commit(activity(f.root));
    f.resources.remove('owner', f.connection.connectionId, 'view', 1);
    await advance(2000);
    expect(project).toHaveBeenCalledTimes(1);
  });
});
it('qualifies an active unchanged directory with the source each completed capture read',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date','performance']});clean.push(()=>vi.useRealTimers());
  // Wakes whose capture leaves the payload unchanged arrive faster than the activity interval,
  // so the view is dirty at every health tick.
  const read:number[]=[];
  const f=fixture(async()=>{read.push(view().source.snapshot().position);return {roles:[{id:'a',readiness:'running'}]};},undefined,undefined,1000);
  const view=()=>(f.resources as any).connections.get(f.connection.connectionId).views.get('view');
  const binding=f.register();await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  f.response.write.mockClear();
  const start=Date.now(),seen:number[]=[];
  for(let at=0;at<120_000;at+=500){
    publishFleetResourceCommit(join(f.root,'a','.session-events.jsonl'));await vi.advanceTimersByTimeAsync(500);
    if(f.response.write.mock.calls.length>seen.length)seen.push(Date.now()-start);
    while(seen.length<f.response.write.mock.calls.length)seen.push(Date.now()-start);
  }
  const writes=f.response.write.mock.calls.map(([s]:[string])=>s);
  expect(writes.some(s=>s.startsWith('event: resource\n'))).toBe(false);
  const batches=writes.filter(s=>s.startsWith('event: resource-coverage\n')).map(s=>JSON.parse(s.split('data: ')[1]));
  const times=writes.map((s,i)=>[s,seen[i]] as const).filter(([s])=>s.startsWith('event: resource-coverage\n')).map(([,t])=>t);
  // The client recovers a healthy view after 45s without qualification.
  expect(Math.max(...[0,...times,120_000].slice(1).map((t,i)=>t-[0,...times][i]))).toBeLessThan(45_000);
  expect(batches.length).toBeLessThanOrEqual(9);
  const sources=batches.map(b=>b.views[0].source.position);
  for(const position of sources)expect(read).toContain(position);
  expect(sources).toEqual([...sources].sort((a,b)=>a-b));
  expect(batches.map(b=>b.views[0].sequence)).toEqual(batches.map((_,i)=>i+3));
});
it('does not qualify an unchanged capture that was replaced while it ran',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});clean.push(()=>vi.useRealTimers());
  let hold=false,release!:(payload:unknown)=>void;
  const f=fixture(async()=>hold?new Promise(r=>release=r):({rows:['same']}),undefined,undefined,0);
  const binding=f.register();await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  await vi.advanceTimersByTimeAsync(16_000);f.response.write.mockClear();
  hold=true;publishFleetResourceCommit(f.root);await expect.poll(()=>typeof release).toBe('function');
  const replacement=f.register(2);hold=false;
  await f.resources.bound('owner',f.connection.connectionId,'view',2,replacement.baselineId);
  const coverage=()=>f.response.write.mock.calls.map(([s]:[string])=>s).filter(s=>s.startsWith('event: resource-coverage\n')).flatMap(s=>JSON.parse(s.split('data: ')[1]).views);
  // The obsolete capture completes unchanged after its qualification interval.
  release({rows:['same']});await new Promise(setImmediate);await new Promise(setImmediate);
  expect(coverage().filter((v:any)=>v.subscriptionEpoch===1)).toEqual([]);
  // The replacement was qualified by its ready at about 16s; the first tick due for it is at 45s.
  await vi.advanceTimersByTimeAsync(30_000);
  expect(coverage().length).toBeGreaterThan(0);
  expect(coverage().every((v:any)=>v.subscriptionEpoch===2)).toBe(true);
});
it('does not qualify an unchanged capture whose observation failed while it ran',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});clean.push(()=>vi.useRealTimers());
  let hold=false,release!:(payload:unknown)=>void;
  const f=fixture(async()=>hold?new Promise(r=>release=r):({rows:['same']}),undefined,undefined,0);
  const binding=f.register();await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  await vi.advanceTimersByTimeAsync(16_000);f.response.write.mockClear();
  hold=true;publishFleetResourceCommit(f.root);await expect.poll(()=>typeof release).toBe('function');
  f.handles[0].emit('error',Error('failed'));await new Promise(setImmediate);
  release({rows:['same']});await new Promise(setImmediate);await vi.advanceTimersByTimeAsync(30_000);
  const writes=f.response.write.mock.calls.map(([s]:[string])=>s);
  expect(writes.some(s=>s.startsWith('event: resource-coverage\n'))).toBe(false);
  expect(f.frames().map(f=>f.kind)).toEqual(['health']);
});
it('keeps a capture qualification behind a backpressured chunked record',async()=>{
  // Only Date is fake: the sparse health timer never fires, so coverage comes from the capture.
  vi.useFakeTimers({toFake:['Date']});clean.push(()=>vi.useRealTimers());
  const f=fixture(async d=>({rows:[d.viewId==='large'?'x'.repeat(900000):'quiet']}),undefined,undefined,0);
  const quiet=f.resources.register('owner',f.connection.connectionId,'quiet',1,{viewId:'quiet',resource:'directory'});
  await f.resources.bound('owner',f.connection.connectionId,'quiet',1,quiet.baselineId);
  vi.setSystemTime(Date.now()+16_000);
  f.response.write.mockClear();f.response.write.mockImplementationOnce(()=>false);
  const large=f.resources.register('owner',f.connection.connectionId,'large',1,{viewId:'large',resource:'directory'});
  await expect.poll(()=>f.response.write.mock.calls.length).toBe(1);
  // Wakes both views; the quiet capture is unchanged and due for qualification.
  publishFleetResourceCommit(join(f.root,'quiet','.session-events.jsonl'));
  for(let i=0;i<5;i++)await new Promise(setImmediate);
  expect(f.response.write.mock.calls).toHaveLength(1);
  f.response.emit('drain');await f.resources.bound('owner',f.connection.connectionId,'large',1,large.baselineId);
  const writes=()=>f.response.write.mock.calls.map(([s]:[string])=>s);
  await expect.poll(()=>writes().some(s=>s.startsWith('event: resource-coverage\n'))).toBe(true);
  const commit=writes().findIndex(s=>s.startsWith('event: resource-chunk\n')&&JSON.parse(s.split('data: ')[1]).type==='commit');
  const batch=writes().findIndex(s=>s.startsWith('event: resource-coverage\n'));
  expect(commit).toBeGreaterThan(0);expect(batch).toBeGreaterThan(commit);
  const views=JSON.parse(writes()[batch].split('data: ')[1]).views;
  expect(views.map((v:any)=>v.viewId)).toEqual(['quiet']);
  expect(views[0].sequence).toBe(3);
});
