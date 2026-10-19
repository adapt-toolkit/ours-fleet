import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetResourceViews, canonicalResourceDescriptor, resourceFrames } from '../src/web/resource-views.js';
import { publishFleetResourceCommit } from '../src/application/resource-observer.js';
import { conversationPreview } from '../src/application/conversation-history.js';
const clean:Array<()=>void>=[];
afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
function fixture(project:(descriptor:any,signal:AbortSignal)=>Promise<unknown>,authorized=()=>true){
  const root=mkdtempSync(join(tmpdir(),'resource-views-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const response=new EventEmitter() as any;response.write=vi.fn(()=>true);response.end=vi.fn();
  const handles:any[]=[];
  const resources=new FleetResourceViews({paths:[root],roots:[root],watch:()=>{const h=new EventEmitter() as any;h.close=vi.fn();handles.push(h);return h;}},project);
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
  const old=f.register(1,'tasks',{state:'active'});await Promise.resolve();
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
  const binding=f.register();await Promise.resolve();publishFleetResourceCommit(f.root);release({rows:[]});
  const baseline=await f.resources.bound('owner',f.connection.connectionId,'view',1,binding.baselineId);
  expect(baseline.payload).toEqual({rows:['committed']});
  fail=true;publishFleetResourceCommit(f.root);await new Promise(setImmediate);
  expect(f.frames().filter(f=>f.kind==='snapshot')).toHaveLength(1);
  expect(f.frames().at(-1).kind).toBe('resync');
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
  });
  const binding = f.register(1, resource, resource === 'previews' ? {ids:['selected']} : {});
  const initial = await f.resources.bound('owner', f.connection.connectionId, 'view', 1, binding.baselineId);
  expect(initial.payload).toEqual({value:'initial'});
  value = 'updated';
  publishFleetResourceCommit(resource === 'previews'
    ? join(f.root, 'selected', '.conversation', 'events-000001.jsonl') : join(f.root, 'fleet.yaml'));
  await new Promise(setImmediate);
  expect(f.frames().filter(frame => frame.kind === 'snapshot').at(-1).payload).toEqual({value:'updated'});
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
it('retains the three capture limit for continuously changing selected preview data', async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    publishFleetResourceCommit(join(f.root, 'selected', '.conversation', 'events-000001.jsonl'));
    return {value:'unstable'};
  });
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
  });
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
  expect(f.frames().filter(frame => frame.kind === 'snapshot').at(-1)?.payload.roles.map((row:any) => row.status.sequence)).toEqual([4,4]);
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
  expect(f.frames()).toHaveLength(1);
  expect(f.frames()[0]).toMatchObject({kind:'snapshot',source:{protocolVersion:1,position:1},payload:{rows:['new']}});
});
it('excludes pending, failed and replaced registrations while an unchanged sibling stays covered',async()=>{
  vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});clean.push(()=>vi.useRealTimers());
  let hold=false,release!:(payload:unknown)=>void;
  const f=fixture(async d=>d.viewId==='pending'&&hold?new Promise(r=>release=r):({rows:[d.viewId]}));
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
