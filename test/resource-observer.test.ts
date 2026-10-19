import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, readFileSync, realpathSync, watch as nativeWatch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeFleetResources, publishFleetResourceCommit } from '../src/application/resource-observer.js';
const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-resources-'));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const roles = join(root, 'agents'); mkdirSync(roles);
  const controller = new AbortController(); clean.push(() => controller.abort());
  return { root, roles, controller };
}
it('routes every known or unknown wake before batching and fences retired callbacks',async()=>{
  const f=fixture(),routes:Array<string|undefined>=[],handles=new Map<string,any>(),committed=vi.fn();
  observeFleetResources({roots:[f.roles],onInvalidated:path=>routes.push(path),watch:(path,listener)=>{
    const handle=Object.assign(new EventEmitter(),{close(){}});handles.set(path,{handle,listener});return handle;
  }},committed,f.controller.signal);
  const known=join(f.roles,'A','.conversation','events-000001.jsonl');
  publishFleetResourceCommit(known);handles.get(f.roles).listener('change',null);
  expect(routes).toEqual([known,undefined]);expect(committed).not.toHaveBeenCalled();
  await Promise.resolve();expect(committed).toHaveBeenCalled();
  f.controller.abort();const count=routes.length;
  publishFleetResourceCommit(known);handles.get(f.roles).listener('change',null);
  await Promise.resolve();expect(routes).toHaveLength(count);
});
it('installs before startup read and observes atomic root recreation and detached ledger writers', async () => {
  const f = fixture(), events: any[] = [];
  const observer = observeFleetResources({ roots: [f.roles] }, e => events.push(e), f.controller.signal);
  expect(observer.snapshot().health).toBe('healthy');
  renameSync(f.roles, f.roles + '-old'); mkdirSync(f.roles);
  const ledger = join(f.roles, 'A', '.conversation'); mkdirSync(ledger, { recursive: true });
  await expect.poll(() => events.length).toBeGreaterThan(0);
  const before = events.length;
  writeFileSync(join(ledger, 'events-000001.jsonl'), '{}\n');
  await expect.poll(() => events.length).toBeGreaterThan(before);
  expect(observer.snapshot().position).toBeGreaterThan(0);
});
it('direct commits advance synchronously and callback after disposal is fenced', async () => {
  const f = fixture(), changed = vi.fn();
  const observation = observeFleetResources({ roots: [f.roles] }, changed, f.controller.signal);
  const initial = observation.snapshot().position;
  publishFleetResourceCommit(join(f.roles, 'A'));
  expect(observation.snapshot().position).toBeGreaterThan(initial);
  await Promise.resolve(); expect(changed).toHaveBeenCalled();
  f.controller.abort(); changed.mockClear();
  publishFleetResourceCommit(join(f.roles, 'A'));
  await Promise.resolve(); expect(changed).not.toHaveBeenCalled();
});
it('degrades on unsupported/error watchers and ignores retired handle callbacks', async () => {
  const f = fixture(), handles: any[] = [], changed = vi.fn();
  const observation = observeFleetResources({ roots: [f.roles], watch: () => {
    const handle = new EventEmitter() as any; handle.close = vi.fn(); handles.push(handle); return handle;
  } }, changed, f.controller.signal);
  handles[0].emit('error', new Error('watch failed'));
  expect(observation.snapshot().health).toBe('failed');
  expect(handles.every(h => h.close.mock.calls.length === 1)).toBe(true);
  const unsupported = observeFleetResources({ roots: [f.roles], watch: () => { throw Object.assign(Error(), { code: 'ENOSYS' }); } }, () => {}, f.controller.signal);
  expect(unsupported.snapshot().health).toBe('unsupported');
});
it('task delivery catches a commit during startup replay and an external atomic writer without an idle tick', async () => {
  const { createTask, pendingTaskNotifications, tasksDir } = await import('../src/rooms-tasks/task-state.js');
  const { TaskNotificationProducer } = await import('../src/notifications/task-producer.js');
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const f=fixture(),previous=process.env.OURS_FLEET_HOME;process.env.OURS_FLEET_HOME=f.root;
  clean.push(()=>{if(previous===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=previous;});
  const first=createTask({title:'first',origin:{type:'cli'},start:false});
  const path=join(tasksDir(),first.task_id+'.json'),record=JSON.parse(readFileSync(path,'utf8'));
  let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve),sent:string[]=[];
  const request=(async(_url,options)=>{const event=JSON.parse(options!.body as string);sent.push(event.taskId);if(sent.length===1)await held;return new Response('{}');}) as typeof fetch;
  const producer=new TaskNotificationProducer({origin:'http://127.0.0.1:1',token:'x'.repeat(40)},undefined,request);
  try {
    const second=createTask({title:'during replay',origin:{type:'cli'},start:false});release();
    await expect.poll(()=>sent.includes(second.task_id)).toBe(true);
    await expect.poll(()=>pendingTaskNotifications().length).toBe(0);
    const third={...record,notification_events:record.notification_events.map((event:any)=>({...event,eventId:event.eventId+'-external'}))};
    execFileSync(process.execPath,['--input-type=module','-e',"import{writeFileSync,renameSync}from'node:fs';const[p,data]=process.argv.slice(1);writeFileSync(p+'.external',data);renameSync(p+'.external',p);",path,JSON.stringify(third)]);
    await expect.poll(()=>sent.filter(id=>id===first.task_id).length,{timeout:1500}).toBe(2);
  }finally{release();await producer.close();}
});

it('captures startup layout writes and observes later detached layout and subscription commits',async()=>{
  const f=fixture(),old=process.env.OURS_FLEET_HOME;process.env.OURS_FLEET_HOME=f.root;
  clean.push(()=>{if(old===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=old;});
  const {stateRoot}=await import('../src/paths.js');
  const layouts=join(stateRoot(),'layouts'),usage=join(stateRoot(),'subscriptions','observed','claude','profile');
  mkdirSync(layouts,{recursive:true});mkdirSync(usage,{recursive:true});
  const layoutFile=join(layouts,'task-A.op.json'),usageFile=join(usage,'.subscription-usage.json');
  writeFileSync(usageFile,JSON.stringify({windows:[]}));
  let projectedLayout:{status:string}|undefined,projectedUsage:{windows:number[]}|undefined;
  const observer=observeFleetResources({},()=>{
    // Model the canonical projection, not a promised number of native callbacks.
    try{projectedLayout=JSON.parse(readFileSync(layoutFile,'utf8'));}catch{}
    try{projectedUsage=JSON.parse(readFileSync(usageFile,'utf8'));}catch{}
  },f.controller.signal);
  expect(observer.snapshot().health).toBe('healthy');
  writeFileSync(layoutFile+'.external',JSON.stringify({status:'started'}));
  renameSync(layoutFile+'.external',layoutFile);
  const {readFile}=await import('node:fs/promises');
  const initial=await Promise.all([readFile(layoutFile,'utf8'),readFile(usageFile,'utf8')]);
  expect(JSON.parse(initial[0])).toEqual({status:'started'});
  expect(JSON.parse(initial[1])).toEqual({windows:[]});
  // A startup write is covered by the initial read; the next distinct commit
  // must reach a canonical projection through the already-installed observer.
  writeFileSync(layoutFile+'.external',JSON.stringify({status:'succeeded'}));
  renameSync(layoutFile+'.external',layoutFile);
  await expect.poll(()=>projectedLayout,{timeout:1500}).toEqual({status:'succeeded'});
  writeFileSync(usageFile,JSON.stringify({windows:[1]}));
  await expect.poll(()=>projectedUsage,{timeout:1500}).toEqual({windows:[1]});
  expect(observer.snapshot().health).toBe('healthy');
});

it('watches each directory before discovery so an install-time mkdir cannot become an unwatched healthy ledger',async()=>{
 const f=fixture(),handles=new Map<string,{listener:(event:string,name:string|null)=>void;handle:any}>(),changed=vi.fn();
 const ledger=join(f.roles,'A','.conversation');let created=false;
 const observer=observeFleetResources({roots:[f.roles],watch:(path,listener)=>{
  // The supported external writer creates its hierarchy immediately before
  // this directory's watch becomes active, after any earlier discovery pass.
  if(path===f.roles&&!created){created=true;mkdirSync(ledger,{recursive:true});}
  const handle=new EventEmitter()as any;handle.close=vi.fn();handles.set(path,{listener,handle});return handle;
 }},changed,f.controller.signal);
 expect(observer.snapshot().health).toBe('healthy');
 expect(handles.has(ledger),'new nested ledger must be watched before initial coverage is healthy').toBe(true);
 writeFileSync(join(ledger,'events-000001.jsonl'),'{}\n');
 handles.get(ledger)!.listener('change','events-000001.jsonl');await Promise.resolve();
 expect(changed).toHaveBeenCalled();
});

for (const placement of ['ancestor', 'root']) it(`observes explicit resources through a symlink ${placement} without following discovered child links`, async () => {
  const f = fixture(), target = join(f.root, 'target'), alias = join(f.root, 'alias');
  mkdirSync(target); symlinkSync(target, alias, 'dir');
  const path = placement === 'root' ? alias : join(alias, 'resources');
  if (placement === 'ancestor') mkdirSync(path);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(path, 'escaped'), 'dir');
  writeFileSync(join(path, 'initial.json'), '{}');
  const events: unknown[] = [];
  const watched = new Set<string>();
  let replayCommit:(()=>void)|undefined;
  const observer = observeFleetResources({paths:[path], roots:[], watch:(dir,listener)=>{
    watched.add(realpathSync(dir));
    return nativeWatch(dir,{persistent:false},(event,name)=>{
      const filename=name===null?null:String(name);
      if(filename==='committed.json')replayCommit=()=>listener(event,filename);
      listener(event,filename);
    });
  }}, state => events.push(state), f.controller.signal);
  expect(observer.snapshot().health).toBe('healthy');
  // Match the production subscribe-before-read contract before an external commit.
  const {readFile} = await import('node:fs/promises');
  expect(await readFile(join(path, 'initial.json'), 'utf8')).toBe('{}');
  writeFileSync(join(path, 'committed.json'), '{}');
  await expect.poll(() => typeof replayCommit).toBe('function');
  await expect.poll(() => events.length).toBeGreaterThan(0);
  expect(watched.has(realpathSync(path))).toBe(true);
  writeFileSync(join(outside, 'unrelated.json'), '{}');
  // Native delivery may repeat an earlier in-scope event after this write.
  replayCommit!();
  await Promise.resolve();
  expect(watched.has(realpathSync(outside))).toBe(false);
  expect(observer.snapshot().health).toBe('healthy');
});

it('scopes cursor invalidation for direct and native commits, retaining unknown events and health', async () => {
  const f = fixture(), handles = new Map<string, {listener: Function; handle: any}>();
  const observer = observeFleetResources({roots:[f.roles], watch:(path, listener) => {
    const handle = new EventEmitter() as any; handle.close = vi.fn(); handles.set(path, {listener, handle}); return handle;
  }}, () => {}, f.controller.signal);
  const lifetime = new AbortController();
  const cursor = observer.cursor(path => path.endsWith('selected.json'), lifetime.signal);
  publishFleetResourceCommit(join(f.roles, 'other.json'));
  expect(cursor.snapshot().position).toBe(0);
  publishFleetResourceCommit(join(f.roles, 'selected.json'));
  expect(cursor.snapshot().position).toBeGreaterThan(0);
  const native = handles.get(f.roles)!;
  const before = cursor.snapshot().position;
  native.listener('change', 'other.json'); expect(cursor.snapshot().position).toBe(before);
  native.listener('change', null); expect(cursor.snapshot().position).toBeGreaterThan(before);
  const retired = cursor.snapshot().position;
  lifetime.abort(); publishFleetResourceCommit(join(f.roles, 'selected.json'));
  expect(cursor.snapshot().position).toBe(retired);
  native.handle.emit('error', Error('watch lost'));
  expect(cursor.snapshot().health).toBe('failed');
});

it.each(['removed', 'replaced with file', 'watch-open removed'] as const)('keeps parent discovery healthy when a child is %s during installation', async race => {
  const f=fixture(),child=join(f.roles,'ephemeral'),handles=new Map<string,any>(),events:any[]=[];
  mkdirSync(child);let raced=false;
  const observation=observeFleetResources({roots:[f.roles],watch:(dir,callback)=>{
    if(dir===child&&!raced){
      raced=true;rmSync(child,{recursive:true});
      if(race==='replaced with file')writeFileSync(child,'not a directory');
      if(race==='watch-open removed')throw Object.assign(Error('vanished'),{code:'ENOENT'});
    }
    const handle=Object.assign(new EventEmitter(),{close:vi.fn(),callback});handles.set(String(dir),handle);return handle as any;
  }},state=>events.push(state),f.controller.signal);
  expect(raced).toBe(true);expect(observation.snapshot().health).toBe('healthy');
  expect(handles.get(f.roles).close).not.toHaveBeenCalled();
  rmSync(child,{force:true});mkdirSync(child);
  handles.get(f.roles).callback('rename','ephemeral');await Promise.resolve();
  expect(observation.snapshot().health).toBe('healthy');
  expect(handles.get(child).close).not.toHaveBeenCalled();
  const before=events.length;handles.get(child).callback('change','committed.json');await Promise.resolve();
  expect(events.length).toBeGreaterThan(before);expect(events.every(event=>event.health==='healthy')).toBe(true);
});
it.each(['EACCES','EIO','ENOENT'])('does not disguise %s watch failure for a directory that still exists', code=>{
  const f=fixture(),child=join(f.roles,'present');mkdirSync(child);
  const observation=observeFleetResources({roots:[f.roles],watch:dir=>{
    if(dir===child)throw Object.assign(Error('watch failed'),{code});
    return Object.assign(new EventEmitter(),{close:vi.fn()}) as any;
  }},()=>{},f.controller.signal);
  expect(observation.snapshot().health).toBe('failed');
});
