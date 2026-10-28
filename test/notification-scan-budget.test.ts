import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, statSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetNotificationProducer } from '../src/notifications/fleet-producer.js';

const observation = vi.hoisted(() => ({callback:undefined as any, accepts:undefined as any, route:undefined as any, position:0, selected:0}));
vi.mock('../src/application/resource-observer.js', () => ({observeFleetResources:(scope:any, callback:any) => {
  observation.callback=callback; observation.route=scope.onInvalidated; observation.accepts=undefined; observation.position=observation.selected=0;
  return {snapshot:()=>({position:observation.position,health:'healthy'}),cursor:(accepts:any) => {
    observation.accepts=accepts; return {snapshot:()=>({position:observation.selected,health:'healthy'})};
  }};
}}));
vi.mock('node:fs', async original => {
  const fs=await original<typeof import('node:fs')>(); return {...fs,openSync:vi.fn(fs.openSync),readdirSync:vi.fn(fs.readdirSync),statSync:vi.fn(fs.statSync),lstatSync:vi.fn(fs.lstatSync),readFileSync:vi.fn(fs.readFileSync)};
});
const close:Array<()=>Promise<void>|void>=[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,body:{cancel:async()=>{}}})));
});
afterEach(async () => {for(const fn of close.splice(0).reverse())await fn();vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});
function wake(path?:string, health='healthy') {
  observation.route?.(path);
  observation.position++;
  if(path===undefined || observation.accepts?.(path))observation.selected=observation.position;
  observation.callback({position:observation.position,health});
}
function fixture(count=0, historicalCompletion=false) {
  const home=mkdtempSync(join(tmpdir(),'notification-scan-'));close.push(()=>rmSync(home,{recursive:true,force:true}));
  vi.stubEnv('OURS_FLEET_HOME',home);const root=join(home,'agents');mkdirSync(root);
  const event=(role:string,seq:number,kind='message.chunk')=>JSON.stringify({schemaVersion:1,roleId:role,sessionGeneration:'g',promptId:'p',source:'browser',kind,seq})+'\n';
  const ledger=(role:string,segment=1)=>join(root,role,'.conversation',`events-${String(segment).padStart(6,'0')}.jsonl`);
  const write=(role:string,text:string,segment=1)=>{const file=ledger(role,segment);mkdirSync(join(root,role,'.conversation'),{recursive:true});writeFileSync(file,text);return file;};
  for(let n=0;n<count;n++)write('Role'+n,historicalCompletion?event('Role'+n,1,'prompt.admitted')+event('Role'+n,2,'turn.completed'):event('Role'+n,1));
  const producer=new FleetNotificationProducer([root],join(home,'outboxes'),{origin:'http://127.0.0.1:1',token:'x'.repeat(40)});close.push(()=>producer.close());
  const queues=()=>(producer as any).queues as Map<string,any>;
  const opens=()=>vi.mocked(openSync).mock.calls.map(args=>String(args[0])).filter(path=>path.includes('/.conversation/'));
  return {home,root,producer,event,ledger,write,queues,opens};
}
it('does not open caught-up ledgers or allocate a batch on an explicit discovery pass',async()=>{
  const f=fixture(24);await vi.advanceTimersByTimeAsync(50);vi.mocked(openSync).mockClear();
  const allocate=vi.spyOn(Buffer,'alloc');
  try{f.producer.poll();await vi.advanceTimersByTimeAsync(50);expect(f.opens()).toEqual([]);expect(allocate.mock.calls.some(([size])=>size===256*1024)).toBe(false);}
  finally{allocate.mockRestore();}
});
it('ignores known unrelated runtime writes and queues only the changed ledger role',async()=>{
  const f=fixture(3);await vi.advanceTimersByTimeAsync(50);
  vi.mocked(openSync).mockClear();
  const metadata=()=>[...vi.mocked(readdirSync).mock.calls,...vi.mocked(statSync).mock.calls,...vi.mocked(lstatSync).mock.calls,...vi.mocked(readFileSync).mock.calls].map(args=>String(args[0])).filter(path=>path===f.root||path.startsWith(f.root+'/'));
  for(const method of [readdirSync,statSync,lstatSync,readFileSync])vi.mocked(method).mockClear();
  for(let n=0;n<40;n++)wake(join(f.root,'Role0','.monitor-status'));
  await vi.advanceTimersByTimeAsync(20);expect(f.opens()).toEqual([]);expect(metadata()).toEqual([]);
  appendFileSync(f.ledger('Role0'),f.event('Role0',2));
  for(let n=0;n<40;n++)wake(f.ledger('Role0'));
  expect(f.opens()).toEqual([]); // Observer callbacks never synchronously scan content.
  await vi.advanceTimersByTimeAsync(20);
  expect(f.opens()).toEqual([f.ledger('Role0')]);
  expect(metadata().length).toBeGreaterThan(0);
  expect(metadata().every(path=>path.startsWith(join(f.root,'Role0')+'/'))).toBe(true);
});
it('bounds a discovery turn to four role batches and resumes remaining roles',async()=>{
  const f=fixture();
  for(let n=0;n<10;n++)f.write('New'+n,f.event('New'+n,1,'prompt.admitted')+f.event('New'+n,2,'turn.completed'));
  let timerAt=-1;setTimeout(()=>{timerAt=f.queues().size;},0);
  vi.mocked(openSync).mockClear();f.producer.poll();
  expect(f.opens().length).toBeLessThanOrEqual(4);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.queues().size).toBe(10);
  expect(timerAt).toBeGreaterThanOrEqual(0);expect(timerAt).toBeLessThan(10);
  for(const queue of f.queues().values())expect(queue.entries).toHaveLength(1);
});
it('checkpoints progress and yields between records when the turn time budget is exhausted',async()=>{
  const f=fixture();const text=Array.from({length:20},(_,n)=>f.event('New',n+1)).join('');f.write('New',text);
  let clock=0;const now=vi.spyOn(performance,'now').mockImplementation(()=>clock+=2);
  try{
    f.producer.poll();const queue=f.queues().get(join(f.root,'New'));
    expect(queue.checkpoint.offset).toBeGreaterThan(0);expect(queue.checkpoint.offset).toBeLessThan(Buffer.byteLength(text));
    await vi.advanceTimersByTimeAsync(50);expect(queue.checkpoint.offset).toBe(Buffer.byteLength(text));
  }finally{now.mockRestore();}
});
it('keeps full-role backoff despite same-role wakes while ready roles progress, then admits once after capacity recovers',async()=>{
  const f=fixture(2);await vi.advanceTimersByTimeAsync(50);
  f.write('Role0',f.event('Role0',1,'prompt.admitted')+f.event('Role0',2,'turn.completed'));
  f.write('Role0',f.event('Role0',3),2);
  const blocked=f.queues().get(join(f.root,'Role0'));
  blocked.entries=Array.from({length:2000},(_,n)=>({id:'pending-'+n,value:{},targetVersion:1}));
  blocked.checkpoint={segment:'events-000001.jsonl',offset:0,prompts:[],messages:{}};
  f.producer.poll();const retained=blocked.checkpoint.offset;vi.mocked(openSync).mockClear();
  appendFileSync(f.ledger('Role1'),f.event('Role1',2,'prompt.admitted')+f.event('Role1',3,'turn.completed'));wake(f.ledger('Role1'));
  for(let n=0;n<5;n++){wake(f.ledger('Role0'));await vi.advanceTimersByTimeAsync(100);}
  expect(f.opens().filter(path=>path.includes('/Role0/'))).toEqual([]);
  expect(blocked.entries).toHaveLength(2000);expect(blocked.checkpoint.offset).toBe(retained);
  expect(f.queues().get(join(f.root,'Role1')).entries.map((entry:any)=>entry.id)).toEqual(['Role1:g:3']);
  expect(vi.mocked(fetch).mock.calls.map(([,init])=>JSON.parse(String(init?.body)).eventId)).toEqual(['Role1:g:3']);
  blocked.entries=[];await vi.advanceTimersByTimeAsync(550);
  expect(blocked.entries.map((entry:any)=>entry.id)).toEqual(['Role0:g:2']);
  f.producer.poll();await vi.advanceTimersByTimeAsync(20);
  expect(blocked.entries.map((entry:any)=>entry.id)).toEqual(['Role0:g:2']);
  // Each newly admitted completion prompts one send. Failed sends remain
  // durable, and same-role wakes or an explicit poll add no retry attempts.
  expect(vi.mocked(fetch).mock.calls.map(([,init])=>JSON.parse(String(init?.body)).eventId)).toEqual(['Role1:g:3','Role0:g:2']);
});
it('retains conservative unknown discovery, rotation and observation recovery',async()=>{
  const f=fixture(1);await vi.advanceTimersByTimeAsync(50);
  const file=f.write('New',f.event('New',1,'prompt.admitted')+f.event('New',2,'turn.completed'));
  wake();await vi.advanceTimersByTimeAsync(20);expect(f.queues().get(join(f.root,'New')).entries[0].id).toBe('New:g:2');
  const rotated=f.write('Role0',f.event('Role0',2,'prompt.admitted')+f.event('Role0',3,'turn.completed'),2);
  wake(rotated);await vi.advanceTimersByTimeAsync(20);expect(f.queues().get(join(f.root,'Role0')).entries[0].id).toBe('Role0:g:3');
  wake(file,'failed');appendFileSync(file,f.event('New',3,'prompt.admitted')+f.event('New',4,'turn.completed'));
  wake(undefined,'healthy');await vi.advanceTimersByTimeAsync(20);
  expect(f.queues().get(join(f.root,'New')).entries.map((entry:any)=>entry.id)).toEqual(['New:g:2','New:g:4']);
});
it('does not lose unknown discovery while another role is blocked',async()=>{
  const f=fixture(1);await vi.advanceTimersByTimeAsync(50);
  f.write('Role0',f.event('Role0',1,'prompt.admitted')+f.event('Role0',2,'turn.completed'));
  const blocked=f.queues().get(join(f.root,'Role0'));
  blocked.entries=Array.from({length:2000},(_,n)=>({id:'pending-'+n,value:{},targetVersion:1}));
  blocked.checkpoint={segment:'events-000001.jsonl',offset:0,prompts:[],messages:{}};
  f.producer.poll();
  f.write('New',f.event('New',1,'prompt.admitted')+f.event('New',2,'turn.completed'));
  wake();wake(f.ledger('Role0'));await vi.advanceTimersByTimeAsync(20);
  expect(f.queues().get(join(f.root,'New')).entries[0].id).toBe('New:g:2');
  expect(blocked.entries).toHaveLength(2000);
});
it('a cold start seeds a live generation binding from the durable sidecar, not the skipped history',async()=>{
  const f=fixture(1);await vi.advanceTimersByTimeAsync(50);
  const task='0mvrpv4kt1f567911';
  writeFileSync(join(f.root,'Role0','.session-ownership.json'),JSON.stringify({schema:1,generations:{g:{launchId:'launch',taskId:task}}}));
  appendFileSync(f.ledger('Role0'),f.event('Role0',2,'prompt.admitted')+f.event('Role0',3,'turn.completed'));wake(f.ledger('Role0'));
  await vi.advanceTimersByTimeAsync(20);
  const queue=f.queues().get(join(f.root,'Role0'));expect(queue.entries[0].value.taskId).toBe(task);
});
for(const rotate of [false,true])it(`retains the startup EOF boundary for a deferred existing role, rotation=${rotate}`,async()=>{
  const f=fixture(8,true);
  const role=Array.from({length:8},(_,n)=>'Role'+n).find(name=>!f.queues().has(join(f.root,name)))!;
  expect(role,'the completion must arrive before this existing role is initialized').toBeDefined();
  const later=f.event(role,3,'prompt.admitted')+f.event(role,4,'turn.completed');
  const file=rotate?f.write(role,later,2):f.ledger(role);
  if(!rotate)appendFileSync(file,later);
  wake(file);await vi.advanceTimersByTimeAsync(50);
  const queue=f.queues().get(join(f.root,role));
  expect(queue.entries.map((entry:any)=>entry.id)).toEqual([`${role}:g:4`]);
  f.producer.poll();await vi.advanceTimersByTimeAsync(20);
  expect(queue.entries.map((entry:any)=>entry.id)).toEqual([`${role}:g:4`]);
});
