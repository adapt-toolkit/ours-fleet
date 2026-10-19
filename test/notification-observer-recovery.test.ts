import { afterEach, expect, it, vi } from 'vitest';
const watches=vi.hoisted(()=>[]as Array<{path:string;handle:any;listener:Function}>);
vi.mock('node:fs',async original=>{
 const fs=await original<typeof import('node:fs')>(),{EventEmitter}=await import('node:events');
 return {...fs,openSync:vi.fn(fs.openSync),readSync:vi.fn(fs.readSync),readdirSync:vi.fn(fs.readdirSync),statSync:vi.fn(fs.statSync),lstatSync:vi.fn(fs.lstatSync),readFileSync:vi.fn(fs.readFileSync),watch(path:string,_options:unknown,listener:Function){
  const handle=new EventEmitter()as any;handle.close=vi.fn(()=>handle.emit('close'));
  watches.push({path,handle,listener});return handle;
 }};
});
import { mkdtempSync,mkdirSync,rmSync,readFileSync,readdirSync,openSync,readSync,statSync,lstatSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { FleetNotificationProducer } from '../src/notifications/fleet-producer.js';
import { TaskNotificationProducer } from '../src/notifications/task-producer.js';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { createTask,pendingTaskNotifications,tasksDir } from '../src/rooms-tasks/task-state.js';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();vi.useRealTimers();vi.unstubAllGlobals();watches.length=0;});
const flush=async()=>{for(let n=0;n<100;n++)await Promise.resolve();};
function fixture(){
 vi.useFakeTimers();const root=mkdtempSync(join(tmpdir(),'notification-watch-')),before=process.env.OURS_FLEET_HOME;process.env.OURS_FLEET_HOME=root;
 clean.push(()=>{if(before===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=before;rmSync(root,{recursive:true,force:true});});
 return root;
}
const config={origin:'http://127.0.0.1:1',token:'t'.repeat(40)};
for(const code of ['EIO','ENOSYS'])for(const timing of ['during','after'])it(`Fleet notification discovery reinstalls ${code} watchers and admits completion ${timing} degradation after idle backlog drains`,async()=>{
 const home=fixture(),root=join(home,'agents'),outboxes=join(home,'outboxes');mkdirSync(root);
 const accepted:any[]=[];vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{accepted.push(JSON.parse(String(init.body)));return new Response('{}');});
 const producer=new FleetNotificationProducer([root],outboxes,config);clean.push(()=>producer.close());
 const store=new ConversationEventStore(join(root,'agent','.conversation'),{roleId:'agent'});clean.push(()=>store.close());
 const append=(p:string)=>{store.append({kind:'prompt.admitted',promptId:p,source:'browser',sessionGeneration:'g',payload:{}});const done=store.append({kind:'turn.completed',promptId:p,sessionGeneration:'g',payload:{outcome:'completed'}});watches.filter(row=>row.path===resolve(root)).at(-1)!.listener('change','agent');return done;};
 const admitted=async(seq:number)=>{
  const id=`agent:g:${seq}`;await flush();
  // Admission now yields to a timer turn. Advance a bounded number of phases
  // until the actual durable event is queued (or its send already completed).
  for(let turn=0;turn<10;turn++){
   await vi.advanceTimersByTimeAsync(1);await flush();
   const files=existsSync(outboxes)?readdirSync(outboxes):[];
   if(accepted.some(row=>row.eventId===id)||files.some(file=>JSON.parse(readFileSync(join(outboxes,file),'utf8')).entries.some((entry:any)=>entry.id===id)))return;
  }
  throw Error(`Notification admission did not complete within ten timer turns: ${id}`);
 };
 const first=append('first');await admitted(first.seq);await producer.drain();expect(accepted).toHaveLength(1);
 const observed=watches.find(row=>row.path===resolve(root))!;observed.handle.emit('error',Object.assign(Error('watch unavailable'),{code}));
 // No mutation after restoration is needed to discover a commit made while degraded.
 const during=timing==='during'?append('during-degradation'):undefined;await flush();
 await vi.advanceTimersByTimeAsync(3000);await flush();
 const last=during??append('after-recovery');await admitted(last.seq);
 const file=join(outboxes,readdirSync(outboxes)[0]);
 expect(JSON.parse(readFileSync(file,'utf8')).checkpoint.prompts).toEqual([]);
 await producer.drain();expect(accepted.some(row=>row.eventId===`agent:g:${last.seq}`)).toBe(true);
 // Settle the outstanding one-shot directory discovery before measuring idle.
 await vi.advanceTimersByTimeAsync(100);await flush();
 const polls=vi.spyOn(producer,'poll'),reads=[openSync,readSync,readdirSync,statSync,lstatSync,readFileSync];
 for(const read of reads)vi.mocked(read).mockClear();
 await vi.advanceTimersByTimeAsync(15000);expect(polls).not.toHaveBeenCalled();
 for(const read of reads)expect(read).not.toHaveBeenCalled();
 expect(accepted.map(row=>row.eventId)).toEqual([`agent:g:${first.seq}`,`agent:g:${last.seq}`]);
 polls.mockRestore();
});
it('task notifications recover observation, discover a later commit and cancel degraded recovery on close',async()=>{
 const home=fixture(),sent:any[]=[];const first=createTask({title:'first',origin:{type:'cli'},start:false});
 const request=(async(_url,init)=>{sent.push(JSON.parse(String(init!.body)));return new Response('{}');})as typeof fetch;
 const producer=new TaskNotificationProducer(config,undefined,request);clean.push(()=>producer.close());await flush();await producer.drain();await flush();
 expect(pendingTaskNotifications()).toEqual([]);expect(sent.some(row=>row.taskId===first.task_id)).toBe(true);
 const watched=watches.find(row=>row.path===resolve(tasksDir()))!;watched.handle.emit('error',Error('transient watcher failure'));
 const during=createTask({title:'committed while degraded',origin:{type:'cli'},start:false});await flush();expect(sent.some(row=>row.taskId===during.task_id)).toBe(false);
 await vi.advanceTimersByTimeAsync(3000);await flush();expect(sent.some(row=>row.taskId===during.task_id)).toBe(true);
 const later=createTask({title:'later',origin:{type:'cli'},start:false});await flush();
 expect(sent.some(row=>row.taskId===later.task_id)).toBe(true);expect(pendingTaskNotifications()).toEqual([]);
 // Settle the existing final outstanding-work retry, then measure healthy idle.
 await vi.advanceTimersByTimeAsync(3000);
 const reads=vi.spyOn(producer,'drain');await vi.advanceTimersByTimeAsync(15000);expect(reads).not.toHaveBeenCalled();reads.mockRestore();
 const active=watches.filter(row=>row.path===resolve(tasksDir())).at(-1)!;active.handle.emit('error',Error('fail again'));
 await producer.close();const count=watches.length;await vi.advanceTimersByTimeAsync(30000);expect(watches).toHaveLength(count);
});
it('reinstallation remains degraded after synchronous watch creation and install-time error, with one retry timer only',async()=>{
 const {observeFleetResources}=await import('../src/application/resource-observer.js');
 const {EventEmitter}=await import('node:events');
 const home=fixture(),abort=new AbortController(),states:any[]=[];clean.push(()=>abort.abort());
 let calls=0,mode:'throw'|'error'|'healthy'='throw';
 const observer=observeFleetResources({paths:[home],roots:[],retryWatchFailures:true,watch:()=>{
  calls++;if(mode==='throw')throw Error('watch creation failed');
  const handle=new EventEmitter()as any;handle.close=vi.fn();
  const on=handle.on.bind(handle);handle.on=(name:string,fn:Function)=>{on(name,fn);if(mode==='error'&&name==='error')handle.emit('error',Error('failure during listener installation'));return handle;};return handle;
 }},state=>states.push(state),abort.signal);
 expect(observer.snapshot().health).toBe('failed');expect(calls).toBe(1);
 await vi.advanceTimersByTimeAsync(2999);expect(calls).toBe(1);
 await vi.advanceTimersByTimeAsync(1);expect(calls).toBe(2);expect(observer.snapshot().health).toBe('failed');
 mode='error';await vi.advanceTimersByTimeAsync(3000);expect(observer.snapshot().health).toBe('failed');expect(states.some(state=>state.health==='healthy')).toBe(false);
 mode='healthy';await vi.advanceTimersByTimeAsync(3000);expect(observer.snapshot().health).toBe('healthy');expect(states.filter(state=>state.health==='healthy')).toHaveLength(1);
 const installed=calls;await vi.advanceTimersByTimeAsync(30000);expect(calls).toBe(installed);abort.abort();expect(vi.getTimerCount()).toBe(0);
});
