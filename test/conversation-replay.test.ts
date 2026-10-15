import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeSync, fsyncSync, appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import type { ConversationEventV1 } from '../src/session/conversation-types.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), writeSync: vi.fn(fs.writeSync) };
});

const dirs: string[] = [];
const stores: ConversationEventStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, {recursive:true,force:true}); });
function dir() { const d = mkdtempSync(join(tmpdir(),'fleet-replay-')); dirs.push(d); return d; }
function store(d = dir(), segmentBytes = 4096) { const s = new ConversationEventStore(d,{roleId:'A',segmentBytes}); stores.push(s); return s; }
const draft = (generation = 'current', source: ConversationEventV1['source'] = 'agent') => ({sessionGeneration:generation,source,kind:'message.chunk' as const,payload:{role:'assistant' as const,content:{type:'text' as const,text:'hello',bytes:5}}});
async function replay(s: ConversationEventStore, after = 0, through = Number(s.lastCursor() ?? 0), generation = 'current') {
  const events: ConversationEventV1[] = []; let coveredThrough = after; let pages = 0;
  for await (const page of s.replay({ expectedGeneration:generation, after, through, pageSize:2 })) {
    expect(page.coveredThrough).toBeGreaterThan(coveredThrough);
    events.push(...page.events); coveredThrough=page.coveredThrough; pages++;
  }
  return {events,coveredThrough,pages};
}
describe('durable replay coverage', () => {
  it('covers more than two pages including filtered-only gaps through the frozen barrier', async () => {
    const s=store(); s.append(draft('old')); s.append(draft());
    for(let i=0;i<6;i++)s.append(draft('current','agent_replay'));
    s.append(draft()); s.append(draft());
    const barrier=Number(s.lastCursor()); s.append(draft());
    const result=await replay(s,0,barrier);
    expect(result.pages).toBeGreaterThan(2);
    expect(result.coveredThrough).toBe(barrier);
    expect(result.events.map(e=>e.seq)).toEqual([2,9,10]);
    expect(result.events.every(e=>e.seq<=barrier)).toBe(true);
  });
  it('yields to timers while replaying a backlog larger than the memory tail', async () => {
    const s=store(undefined,1024*1024); for(let i=0;i<1205;i++)s.append(draft());
    let timer=false; setTimeout(()=>{timer=true;},0);
    let count=0;
    for await(const page of s.replay({expectedGeneration:'current',after:0,through:1205,pageSize:128})) {
      count+=page.events.length;
    }
    expect(timer).toBe(true); expect(count).toBe(1205);
  });
  it.each([-1,0.5,NaN,Infinity,20])('rejects invalid or unavailable cursor %s', async after => {
    const s=store();s.append(draft()); await expect(replay(s,after)).rejects.toThrow(/coverage|cursor/);
  });
  it.each(['missing','unreadable'])('does not erase %s manifest coverage in recovery', async mode => {
    const d=dir(); const s=store(d,1);s.append(draft());s.append(draft());s.append(draft());s.close();
    rmSync(join(d,'events-000002.jsonl')); if(mode==='unreadable')mkdirSync(join(d,'events-000002.jsonl'));
    const recovered=store(d); await expect(replay(recovered)).rejects.toThrow(/coverage/);
    recovered.close(); await expect(replay(store(d))).rejects.toThrow(/coverage/);
  });
  it('allows positively localized old damage outside the current generation range', async () => {
    const d=dir();const s=store(d,1);s.append(draft('old'));s.append(draft('old'));s.append(draft('old'));s.append(draft());s.close();
    rmSync(join(d,'events-000002.jsonl'));const recovered=store(d);
    expect(recovered.degraded).toBe(true);
    const result=await replay(recovered);expect(result.coveredThrough).toBe(4);expect(result.events.map(e=>e.seq)).toEqual([4]);
  });
  it('rejects unknown damage immediately before the first observed current generation record',async()=>{
    const d=dir();const s=store(d,1);s.append(draft('old'));s.append(draft());s.append(draft());s.close();
    rmSync(join(d,'events-000002.jsonl'));await expect(replay(store(d))).rejects.toThrow(/coverage/);
  });
  it('latches failed durable append for that generation even after subsequent writes succeed',async()=>{
    const d=dir();const s=store(d);mkdirSync(join(d,'events-000001.jsonl'));
    expect(s.appendSafe(draft())).toBeUndefined();rmSync(join(d,'events-000001.jsonl'),{recursive:true});
    s.append(draft());await expect(replay(s)).rejects.toThrow(/durab|coverage/);
    s.append(draft('next'));expect((await replay(s,1,2,'next')).events.map(e=>e.seq)).toEqual([2]);
  });
  it('preserves a crash-torn tail and the next append across a second reopen',async()=>{
    const d=dir();const s=store(d);s.append(draft('old'));s.close();
    const path=join(d,'events-000001.jsonl');appendFileSync(path,'{"schemaVersion":1,"seq":2');
    const damaged=readFileSync(path,'utf8');const recovered=store(d);const appended=recovered.append(draft());recovered.close();
    expect(readFileSync(path,'utf8')).toBe(damaged);
    const reopened=store(d);expect(reopened.page().events.map(e=>e.seq)).toEqual([1,appended.seq]);
  });
});

describe('atomic follow replay',()=>{
  async function setup() {
    const {startConversationReplay}=await import('../src/session/conversation-replay.js');
    const s=store();for(let i=0;i<7;i++)s.append(draft());
    const state={sessionGeneration:'current',ledgerBarrier:7,stateRevision:1,readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[],pendingPermissions:[],pendingPrompts:[],pendingPromptCount:0,activePromptIds:[],commands:[],alive:true};
    let listener:((value:typeof state)=>void)|undefined;let disposed=0;
    const session={subscribeConversationFailure:(fn:(generation:string)=>void)=>s.subscribeFailure(fn),subscribeConversation:(fn:(event:ConversationEventV1)=>void)=>s.subscribe(fn),
      observeConversation:(fn:(value:typeof state)=>void)=>{listener=fn;return {snapshot:structuredClone(state),unsubscribe:()=>{listener=undefined;disposed++;}};},
      replayConversation:(request:any)=>s.replay({...request,pageSize:2})};
    return {s,state,session,startConversationReplay,emitState:()=>listener?.({...state}),disposed:()=>disposed};
  }
  it('commits ready after all replay pages before releasing concurrent events and state',async()=>{
    const {s,state,session,startConversationReplay,emitState,disposed}=await setup();
    const order:string[]=[];const visible:number[]=[];
    const follow=startConversationReplay(session,{expectedGeneration:'current',after:0,controller:false},{
      replay:page=>{visible.push(...page.events.map(e=>e.seq));order.push(`page:${page.coveredThrough}`);if(page.coveredThrough===2){s.append(draft());state.ledgerBarrier=8;state.stateRevision=2;emitState();}},
      ready:ready=>{order.push('ready');expect(ready.coveredThrough).toBe(7);expect(ready.snapshot.ledgerBarrier).toBe(7);},
      event:event=>order.push(`live:${event.seq}`),state:value=>order.push(`state:${value.stateRevision}`),close:()=>order.push('closed'),
    });
    await follow.ready;
    await expect.poll(()=>order.includes('state:2')).toBe(true);
    expect(visible).toEqual([1,2,3,4,5,6,7]);
    expect(order).toEqual(['page:2','page:4','page:6','page:7','ready','live:8','state:2']);
    follow.close();follow.close();expect(disposed()).toBe(1);
  });
  it('rejects a concurrent live buffer over 8 MiB before claiming ready',async()=>{
    const {s,session,startConversationReplay,disposed}=await setup();let ready=false;
    const follow=startConversationReplay(session,{expectedGeneration:'current',after:0,controller:false},{
      replay:page=>{if(page.coveredThrough===2)for(let i=0;i<9;i++)s.append({...draft(),payload:{role:'assistant',content:{type:'text',text:'x'.repeat(1024*1024),bytes:1024*1024}}});},
      ready:()=>{ready=true;},event:()=>{},state:()=>{},close:()=>{},
    });
    await expect(follow.ready).rejects.toThrow(/buffer/);expect(ready).toBe(false);expect(disposed()).toBe(1);
  });
  it('aborts an in-progress replay and releases registered listeners without a ready',async()=>{
    const {session,startConversationReplay,disposed}=await setup();const controller=new AbortController();let ready=false;
    const follow=startConversationReplay(session,{expectedGeneration:'current',after:0,controller:false,signal:controller.signal},{
      replay:()=>controller.abort(),ready:()=>{ready=true;},event:()=>{},state:()=>{},close:()=>{},
    });
    await expect(follow.ready).rejects.toThrow();expect(ready).toBe(false);expect(disposed()).toBe(1);
  });
});

it('ignores localized old corruption within the same segment but rejects corruption inside the requested range',async()=>{
 const d=dir();const s=store(d);s.append(draft('old'));s.append(draft('old'));s.append(draft());s.close();
 const path=join(d,'events-000001.jsonl');const lines=readFileSync(path,'utf8').trimEnd().split('\n');
 writeFileSync(path,[lines[0],'{broken',lines[1],lines[2]].join('\n')+'\n');
 const recovered=store(d);expect((await replay(recovered)).events.map(e=>e.seq)).toEqual([3]);
 await expect(replay(recovered,0,3,'old')).rejects.toThrow(/coverage/);
});

it('skips segments already covered by the cursor and catches missing required files after recovery',async()=>{
 const d=dir();const s=store(d,1);for(let i=0;i<4;i++)s.append(draft());
 rmSync(join(d,'events-000001.jsonl'));expect((await replay(s,2,4)).events.map(e=>e.seq)).toEqual([3,4]);
 rmSync(join(d,'events-000003.jsonl'));await expect(replay(s,2,4)).rejects.toThrow(/coverage/);
});

it('progressively delivers one valid large live record without charging it to the pending buffer',async()=>{
 const {startConversationReplay}=await import('../src/session/conversation-replay.js');
 const s=store();s.append(draft());const events:number[]=[];let reason:string|undefined;
 const state={sessionGeneration:'current',ledgerBarrier:1,stateRevision:1,readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[],pendingPermissions:[],pendingPrompts:[],pendingPromptCount:0,activePromptIds:[],commands:[],alive:true};
 const follow=startConversationReplay({observeConversation:()=>({snapshot:state,unsubscribe:()=>{}}),subscribeConversation:fn=>s.subscribe(fn),subscribeConversationFailure:fn=>s.subscribeFailure(fn),replayConversation:r=>s.replay(r)},
 {expectedGeneration:'current',after:0,controller:false},
 {replay:()=>{},ready:()=>{},event:e=>{events.push(e.seq);},state:()=>{},close:r=>{reason=r;}});
 await follow.ready;
 const maximum=16*1024*1024;
 const content={type:'text' as const,text:'',bytes:maximum};
 const large={...draft(),payload:{role:'assistant' as const,content}};
 const overhead=Buffer.byteLength(JSON.stringify({...s.page().events[0],...large}));
 content.bytes=maximum-overhead;content.text='x'.repeat(content.bytes);
 const appended=s.append(large);expect(Buffer.byteLength(JSON.stringify(appended))).toBe(maximum);
 await expect.poll(()=>events).toEqual([2]);expect(reason).toBeUndefined();follow.close();
});

describe('follow failure signals',()=>{
 const state=()=>({sessionGeneration:'current',ledgerBarrier:1,stateRevision:1,readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[],pendingPermissions:[],pendingPrompts:[],pendingPromptCount:0,activePromptIds:[],commands:[],alive:true});
 const sink=(close:(reason?:string)=>void)=>({replay:()=>{},ready:()=>{},event:()=>{},state:()=>{},close});
 it('rejects an initial failed observation even when its retained barrier remains readable',async()=>{
  const {startConversationReplay}=await import('../src/session/conversation-replay.js');const s=store();s.append(draft());let disposed=0;
  const follow=startConversationReplay({subscribeConversation:fn=>s.subscribe(fn),subscribeConversationFailure:()=>()=>{},
   replayConversation:r=>s.replay(r),observeConversation:()=>({snapshot:{...state(),observationFailure:'capture_failed'},unsubscribe:()=>{disposed++;}})},
   {expectedGeneration:'current',controller:false},sink(()=>{}));
  await expect(follow.ready).rejects.toThrow(/observation/);expect(disposed).toBe(1);
 });
 it('terminates on a subsequent observation failure without advancing the visible state',async()=>{
  const {startConversationReplay}=await import('../src/session/conversation-replay.js');const s=store();s.append(draft());let listener:any;let reason:string|undefined;let delivered=0;
  const follow=startConversationReplay({subscribeConversation:fn=>s.subscribe(fn),subscribeConversationFailure:()=>()=>{},
   replayConversation:r=>s.replay(r),observeConversation:fn=>{listener=fn;return {snapshot:state(),unsubscribe:()=>{listener=undefined;}};}},
   {expectedGeneration:'current',controller:false},{...sink(r=>{reason=r;}),state:()=>{delivered++;}});
  await follow.ready;listener({...state(),stateRevision:2,observationFailure:'capture_failed'});
  expect(reason).toMatch(/observation/);expect(delivered).toBe(0);expect(listener).toBeUndefined();
 });
 it('cleans up event subscription if initial owner registration throws',async()=>{
  const {startConversationReplay}=await import('../src/session/conversation-replay.js');const s=store();let disposed=0;
  const follow=startConversationReplay({subscribeConversation:()=>()=>{disposed++;},subscribeConversationFailure:()=>()=>{},
   replayConversation:r=>s.replay(r),observeConversation:()=>{throw new Error('observation unavailable');}},
   {expectedGeneration:'current',controller:false},sink(()=>{}));
  await expect(follow.ready).rejects.toThrow(/unavailable/);expect(disposed).toBe(1);
 });
 it('terminates an already-ready follow on current-generation append failure even with an old history warning',async()=>{
  const {startConversationReplay}=await import('../src/session/conversation-replay.js');const d=dir();const s=store(d,1);s.append(draft());let reason:string|undefined;
  const follow=startConversationReplay({subscribeConversation:fn=>s.subscribe(fn),subscribeConversationFailure:fn=>s.subscribeFailure(fn),
   replayConversation:r=>s.replay(r),observeConversation:()=>({snapshot:{...state(),historyDegraded:true},unsubscribe:()=>{}})},
   {expectedGeneration:'current',controller:false},sink(r=>{reason=r;}));
  await follow.ready;mkdirSync(join(d,'events-000002.jsonl'));expect(s.appendSafe(draft())).toBeUndefined();
  expect(reason).toMatch(/durab/);await expect(replay(s,1,1)).rejects.toThrow(/durab/);
 });
});

it('flushes a partial page before a large record instead of assembling both together',async()=>{
 const s=store();s.append({...draft(),payload:{role:'assistant',content:{type:'text',text:'a'.repeat(200*1024),bytes:200*1024}}});
 s.append({...draft(),payload:{role:'assistant',content:{type:'text',text:'b'.repeat(1024*1024),bytes:1024*1024}}});
 const pages=[];for await(const page of s.replay({expectedGeneration:'current',after:0,through:2}))pages.push(page.events.map(e=>e.seq));
 expect(pages).toEqual([[1],[2]]);
});


it.each([
 {label:'first append',prior:false,after:0,durable:undefined,oldSeqs:[1],expectedSeqs:[1,2],next:2},
 {label:'preceding success',prior:true,after:1,durable:'1',oldSeqs:[1,2],expectedSeqs:[1,2,3],next:3},
])('never reuses a sequence after post-write fsync failure: $label',async fixture=>{
 const d=dir();const s=store(d);if(fixture.prior)s.append(draft('old'));
 vi.mocked(fsyncSync).mockImplementationOnce(()=>{throw new Error('post-write fsync fault');});
 expect(()=>s.append(draft('old'))).toThrow('post-write fsync fault');
 expect(s.lastCursor()).toBe(fixture.durable);
 // The failed event really reached disk; an open-before-write fault cannot exercise this path.
 const oldLines=readFileSync(join(d,'events-000001.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
 expect(oldLines.map(e=>e.seq)).toEqual(fixture.oldSeqs);
 const current=s.append(draft('current'));
 const live=await replay(s,fixture.after,Number(s.lastCursor()));
 expect(live.events.map(e=>e.seq)).toEqual([current.seq]);
 expect.soft(current.seq).toBe(fixture.next);expect.soft(live.coveredThrough).toBe(fixture.next);
 await expect(replay(s,fixture.after,Number(s.lastCursor()),'old')).rejects.toThrow(/durab/);
 s.close();const reopened=store(d);
 const canonical=reopened.page({limit:100}).events;
 expect.soft(canonical.map(e=>e.seq)).toEqual(fixture.expectedSeqs);
 expect.soft(new Set(canonical.map(e=>e.seq)).size).toBe(canonical.length);
 const recovered=await replay(reopened,fixture.after,Number(reopened.lastCursor()));
 expect(recovered.events.map(e=>e.seq)).toEqual([fixture.next]);expect(recovered.coveredThrough).toBe(fixture.next);
 await expect(replay(reopened,fixture.after,fixture.next,'old')).rejects.toThrow(/durab/);
});


it('keeps a reserved partial-write gap distinct and rejects its unknown recovered coverage',async()=>{
 const fs=await vi.importActual<typeof import('node:fs')>('node:fs');
 const d=dir();const s=store(d);s.append(draft('old'));
 vi.mocked(writeSync).mockImplementationOnce((fd,buffer,offset,length)=>fs.writeSync(fd,buffer as Uint8Array,Number(offset),Math.min(24,Number(length))))
  .mockImplementationOnce(()=>{throw new Error('partial write fault');});
 expect(()=>s.append(draft('old'))).toThrow('partial write fault');
 expect(s.lastCursor()).toBe('1');const current=s.append(draft());expect(current.seq).toBe(3);
 expect((await replay(s,1,3)).events.map(e=>e.seq)).toEqual([3]);
 s.close();const recovered=store(d);
 expect(recovered.page().events.map(e=>e.seq)).toEqual([1,3]);
 await expect(replay(recovered,1,3)).rejects.toThrow(/coverage/);
 await expect(replay(recovered,0,3,'old')).rejects.toThrow(/durab/);
});

it('rejects recovered sequence collisions instead of treating the old record as current coverage',async()=>{
 const d=dir();const s=store(d);s.append(draft('old'));s.append(draft());s.close();
 const path=join(d,'events-000001.jsonl');const entries=readFileSync(path,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
 entries[1].seq=1;entries[1].eventId='e1';writeFileSync(path,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
 const recovered=store(d);await expect(replay(recovered,0,1)).rejects.toThrow(/coverage/);
 recovered.close();await expect(replay(store(d),0,1)).rejects.toThrow(/coverage/);
});
