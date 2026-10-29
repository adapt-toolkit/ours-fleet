import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,renameSync,statSync,utimesSync,appendFileSync,fstatSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {conversationTailPage,resumedConversationPage} from '../src/application/conversation-history.js';
it('pages exact resumed ACP session across generations, excluding foreign/fresh and replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-history-'));
 try{
  mkdirSync(join(dir,'.conversation'));writeFileSync(join(dir,'.acp-session-id'),'same-session');
  const event=(seq:number,sessionGeneration:string,acpSessionId:string,source='agent')=>({version:1,seq,eventId:String(seq),roleId:'A',at:new Date().toISOString(),kind:'message.chunk',sessionGeneration,acpSessionId,source,payload:{content:{type:'text',text:String(seq)}}});
  writeFileSync(join(dir,'.conversation/events-000001.jsonl'),[event(1,'old','other-session'),event(2,'old','same-session'),event(3,'current','same-session','agent_replay'),event(4,'current','same-session'),{...event(5,'old','same-session'),kind:'permission.requested'},{...event(6,'old','same-session'),kind:'capabilities.updated'}].map(e=>JSON.stringify(e)).join('\n')+'\n');
  const live={events:[],snapshot:{sessionGeneration:'current',readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[]},hasMore:false};
  const first=await resumedConversationPage(dir,{limit:1},live,'same-session');expect(first.events.map(e=>e.seq)).toEqual([2]);expect(first.hasMore).toBe(true);expect(await resumedConversationPage(dir,{limit:1},live,'same-session')).toEqual(first);
  const second=await resumedConversationPage(dir,{after:first.nextCursor,limit:1},live,'same-session');expect(second.events.map(e=>e.seq)).toEqual([4]);expect(second.hasMore).toBe(false);expect(second.snapshot).toBe(live.snapshot);
  expect(await resumedConversationPage(dir,{},live,'different-live-session')).toBe(live);
  writeFileSync(join(dir,'.acp-session-id'),'fresh-session');
  const fresh=await resumedConversationPage(dir,{}, {...live,snapshot:{...live.snapshot,sessionGeneration:'fresh'}},'fresh-session');expect(fresh.events).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('forward pages skip segments that end before the cursor without dropping boundary events',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-history-'));
 try{
  mkdirSync(join(dir,'.conversation'));writeFileSync(join(dir,'.acp-session-id'),'s');
  const e=(seq:number)=>JSON.stringify({version:1,seq,eventId:String(seq),roleId:'A',at:'2026-09-30T00:00:00Z',kind:'message.chunk',sessionGeneration:'g',acpSessionId:'s',source:'agent',payload:{}});
  writeFileSync(join(dir,'.conversation/events-000001.jsonl'),[1,2,3,4,5].map(e).join('\n')+'\n');
  writeFileSync(join(dir,'.conversation/events-000002.jsonl'),[6,7,8].map(e).join('\n')+'\n');
  const live={events:[],snapshot:{sessionGeneration:'g',readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[]},hasMore:false};
  for(const [after,expected] of [['5',[6,7,8]],['3',[4,5,6,7,8]],['8',[]],['0',[1,2,3,4,5,6,7,8]]] as const)
   expect((await resumedConversationPage(dir,{after,limit:100},live,'s')).events.map(x=>x.seq)).toEqual(expected);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('forward pages reuse unchanged segment ends and keep non-monotonic segments readable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-history-'));
 const handle=await open(dir,'r');const proto=Object.getPrototypeOf(handle);await handle.close();
 const read=proto.read;let tails=0;
 try{
  mkdirSync(join(dir,'.conversation'));writeFileSync(join(dir,'.acp-session-id'),'s');
  const e=(seq:number)=>JSON.stringify({version:1,seq,eventId:String(seq),roleId:'A',at:'2026-09-30T00:00:00Z',kind:'message.chunk',sessionGeneration:'g',acpSessionId:'s',source:'agent',payload:{}});
  const segment=(n:number,seqs:number[])=>writeFileSync(join(dir,`.conversation/events-00000${n}.jsonl`),seqs.map(e).join('\n')+'\n');
  for(let n=0;n<6;n++)segment(n+1,[1,2,3].map(k=>n*3+k));
  const live={events:[],snapshot:{sessionGeneration:'g',readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[]},hasMore:false};
  const poll=async(after:string)=>(await resumedConversationPage(dir,{after,limit:100},live,'s')).events.map(x=>x.seq);
  proto.read=function(this:unknown,...args:unknown[]){tails++;return read.apply(this,args);};
  expect(await poll('18')).toEqual([]);
  expect(tails).toBe(6);
  // Unchanged segments are not read again by later polls.
  tails=0;
  expect(await poll('18')).toEqual([]);
  expect(tails).toBe(0);
  // The active segment grows: only its end is read again.
  segment(6,[16,17,18,19]);
  expect(await poll('18')).toEqual([19]);
  expect(tails).toBe(1);
  proto.read=read;
  const seen:number[]=[];let after='0';
  for(;;){
   const page=await resumedConversationPage(dir,{after,limit:4},live,'s');
   seen.push(...page.events.map(x=>x.seq));after=page.nextCursor!;
   if(!page.hasMore)break;
  }
  expect(seen).toEqual(Array.from({length:19},(_,i)=>i+1));
  // A pre-fix ledger whose later segment restarts below an earlier one still yields the earlier events.
  for(let n=1;n<=6;n++)rmSync(join(dir,`.conversation/events-00000${n}.jsonl`));
  segment(1,[1,2,100]);segment(2,[3,4,5]);
  expect(await poll('50')).toEqual([100]);
  // A segment replaced by rename, even with the same size and time, is not served from the cache.
  const replaced=join(dir,'.conversation/events-00000.next');
  writeFileSync(replaced,[1,2,200].map(e).join('\n')+'\n');
  const before=statSync(join(dir,'.conversation/events-000001.jsonl'));utimesSync(replaced,before.atime,before.mtime);
  renameSync(replaced,join(dir,'.conversation/events-000001.jsonl'));
  expect(await poll('100')).toEqual([200]);
 }finally{proto.read=read;rmSync(dir,{recursive:true,force:true});}
});

describe('conversationTailPage',()=>{
 const snap=(pendingPermissionIds:string[]=[])=>({sessionGeneration:'current',readiness:'idle' as const,queueDepth:0,pendingPermissionIds});
 const ev=(seq:number,extra:Record<string,unknown>={})=>({version:1,seq,eventId:String(seq),roleId:'A',at:'2026-09-30T00:00:00Z',kind:'message.chunk',sessionGeneration:'current',acpSessionId:'same-session',source:'agent',payload:{content:{type:'text',text:String(seq)}},...extra});
 const withLedger=async(files:Record<string,unknown[]>,run:(dir:string)=>Promise<void>)=>{
  const dir=mkdtempSync(join(tmpdir(),'fleet-tail-'));
  try{mkdirSync(join(dir,'.conversation'));for(const [name,events] of Object.entries(files))writeFileSync(join(dir,'.conversation',name),events.map(e=>JSON.stringify(e)).join('\n')+'\n');await run(dir);}
  finally{rmSync(dir,{recursive:true,force:true});}
 };
 it('pages backwards across segments without gaps or duplicates and reports the newest cursor',async()=>{
  const all=Array.from({length:23},(_,i)=>ev(i+1,i%5===4?{source:'agent_replay'}:{}));
  await withLedger({'events-000001.jsonl':all.slice(0,10),'events-000002.jsonl':all.slice(10)},async dir=>{
   const visible=all.filter(e=>e.source!=='agent_replay').map(e=>e.seq);
   const first=await conversationTailPage(dir,{limit:4},snap());
   expect(first.events.map(e=>e.seq)).toEqual(visible.slice(-4));
   expect(first.nextCursor).toBe('23');expect(first.hasOlder).toBe(true);
   const seen=[...first.events.map(e=>e.seq)];let page=first;
   while(page.hasOlder){page=await conversationTailPage(dir,{before:page.olderCursor,limit:4},snap());expect(page.nextCursor).toBeUndefined();seen.unshift(...page.events.map(e=>e.seq));}
   expect(seen).toEqual(visible);
   expect((await conversationTailPage(dir,{limit:100},snap())).hasOlder).toBe(false);
  });
 });
 it('returns resumed-session history, hides foreign sessions, and reads lines longer than a read chunk',async()=>{
  const long='x'.repeat(300*1024);
  await withLedger({'events-000001.jsonl':[ev(1,{sessionGeneration:'old'}),ev(2,{sessionGeneration:'old',acpSessionId:'other'}),ev(3,{payload:{content:{type:'text',text:long}}}),ev(4)]},async dir=>{
   expect((await conversationTailPage(dir,{limit:10},snap(),'same-session')).events.map(e=>e.seq)).toEqual([1,3,4]);
   expect((await conversationTailPage(dir,{limit:10},snap())).events.map(e=>e.seq)).toEqual([3,4]);
   expect(((await conversationTailPage(dir,{limit:2},snap())).events[0].payload as any).content.text).toBe(long);
  });
 });
 it('adds older current capabilities and still-pending permission requests as context',async()=>{
  const events=[ev(1,{kind:'capabilities.updated',sessionGeneration:'old',payload:{commands:[{name:'stale'}]}}),ev(2,{kind:'capabilities.updated',payload:{commands:[{name:'old'}]}}),ev(3,{kind:'capabilities.updated',payload:{commands:[{name:'current'}]}}),
   ev(4,{kind:'permission.requested',permissionId:'p-pending',payload:{title:'Deploy'}}),ev(5,{kind:'permission.requested',permissionId:'p-resolved'}),...Array.from({length:10},(_,i)=>ev(6+i))];
  await withLedger({'events-000001.jsonl':events},async dir=>{
   const page=await conversationTailPage(dir,{limit:3},snap(['p-pending']));
   expect(page.events.map(e=>e.seq)).toEqual([13,14,15]);
   expect(page.context.map(e=>e.seq)).toEqual([3,4]);
   expect((await conversationTailPage(dir,{before:'13',limit:3},snap(['p-pending']))).context).toEqual([]);
   const inPage=await conversationTailPage(dir,{limit:20},snap(['p-pending']));
   expect(inPage.context).toEqual([]);
  });
 });
 it('uses complete barrier-bound inventories without opening older context segments',async()=>{
  const tail=Array.from({length:202},(_,i)=>ev(i+10));
  await withLedger({'events-000002.jsonl':tail},async dir=>{
   // This segment would fail if the reader sought capabilities or permissions
   // after filling the page. A legacy reader must still attempt that search.
   mkdirSync(join(dir,'.conversation','events-000001.jsonl'));
   const pending={permissionId:'pending',title:'Presented permission',options:[]};
   const snapshot={...snap(['pending']),ledgerBarrier:211,stateRevision:2,
    commands:[{name:'current'}],pendingPermissions:[pending]};
   const page=await conversationTailPage(dir,{limit:200},snapshot);
   expect(page.events.map(e=>e.seq)).toEqual(tail.slice(-200).map(e=>e.seq));
   expect(page.context).toEqual([]);expect(page.hasOlder).toBe(true);
   expect(page.nextCursor).toBe('211');expect(page.snapshot).toBe(snapshot);
   // Empty inventories are equally authoritative: absence is not a reason
   // to search all prior events for a command that was never offered.
   expect((await conversationTailPage(dir,{limit:200},{...snapshot,
    pendingPermissionIds:[],commands:[],pendingPermissions:[]})).context).toEqual([]);
  });
 });
 it('preserves context recovery for incomplete and failed captures',async()=>{
  const events=[ev(1,{kind:'capabilities.updated',payload:{commands:[{name:'legacy'}]}}),
   ev(2,{kind:'permission.requested',permissionId:'pending',payload:{title:'Presented permission',options:[]}}),
   ...Array.from({length:10},(_,i)=>ev(i+3))];
  await withLedger({'events-000001.jsonl':events},async dir=>{
   const position={ledgerBarrier:12,stateRevision:2};
   for(const snapshot of [
    {...snap(['pending']),...position},
    {...snap(['pending']),commands:[],pendingPermissions:[]},
    {...snap(['pending']),...position,commands:[],pendingPermissions:[],observationFailure:'capture_failed' as const},
   ])expect((await conversationTailPage(dir,{limit:3},snapshot)).context.map(e=>e.seq)).toEqual([1,2]);
   // An incomplete permission inventory cannot hide a still-pending request.
   expect((await conversationTailPage(dir,{limit:3},{...snap(['pending']),...position,
    commands:[],pendingPermissions:[]})).context.some(e=>e.permissionId==='pending')).toBe(true);
  });
 });
 it('stops searching for context at the first older generation',async()=>{
  await withLedger({'events-000002.jsonl':[ev(10,{sessionGeneration:'old'}),ev(11,{kind:'capabilities.updated'}),ev(12),ev(13)]},async dir=>{
   mkdirSync(join(dir,'.conversation','events-000001.jsonl'));
   const page=await conversationTailPage(dir,{limit:1},snap(['never-found']));
   expect(page.events.map(e=>e.seq)).toEqual([13]);expect(page.context.map(e=>e.seq)).toEqual([11]);
  });
 });
 it('rejects a malformed cursor',async()=>{
  await withLedger({'events-000001.jsonl':[ev(1)]},async dir=>{await expect(conversationTailPage(dir,{before:'abc'},snap())).rejects.toThrow(/cursor/);});
 });
 it('retires a cancelled tail before opening ledger segments',async()=>{
  await withLedger({'events-000001.jsonl':[ev(1)]},async dir=>{
   const owner=new AbortController();
   const read=conversationTailPage(dir,{limit:1},snap(),undefined,owner.signal);
   owner.abort();
   await expect(read).rejects.toMatchObject({name:'AbortError'});
   await expect(conversationTailPage(dir,{limit:1},snap(),undefined,owner.signal)).rejects.toMatchObject({name:'AbortError'});
  });
 });
});

it('stops tail orchestration after a cancelled private-control read settles',async()=>{
 const {RoleSessionControlAdapter}=await import('../src/application/session-control.js');
 const owner=new AbortController();const commands:string[]=[];
 const adapter=new RoleSessionControlAdapter('/unused',async(_dir,request)=>{
  commands.push(request.command);owner.abort();
  return {version:1,id:'x',ok:true,result:{events:[],hasMore:false,snapshot:{sessionGeneration:'g',pendingPermissionIds:[],queueDepth:0,readiness:'idle'}}};
 });
 await expect(adapter.conversationTail({signal:owner.signal})).rejects.toMatchObject({name:'AbortError'});
 expect(commands).toEqual(['conversation_page']);
});

it('rechecks generation after asynchronous latest-tail work and limits unstable baselines to three attempts', async()=>{
 const {RoleSessionControlAdapter}=await import('../src/application/session-control.js');
 const dir=mkdtempSync(join(tmpdir(),'fleet-tail-generation-'));
 try {
  mkdirSync(join(dir,'.conversation'));
  let calls=0;
  const adapter=new RoleSessionControlAdapter(dir,async(_dir,request)=>{
   if(request.command==='snapshot')return {version:1,id:'x',ok:true,result:{backend:'acp'}};
   calls++;return {version:1,id:'x',ok:true,result:{events:[],hasMore:false,snapshot:{sessionGeneration:`g${calls}`,readiness:'idle',pendingPermissionIds:[],queueDepth:0}}};
  });
  await expect(adapter.conversationTail()).rejects.toThrow(/changed|generation/);
  expect(calls).toBe(6);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('keeps latest-tail cursor at the captured barrier when a permission is created during the REST load',async()=>{
 const {RoleSessionControlAdapter}=await import('../src/application/session-control.js');
 const dir=mkdtempSync(join(tmpdir(),'fleet-tail-permission-'));
 try{
  mkdirSync(join(dir,'.conversation'));let calls=0;
  const ev=(seq:number,kind:string)=>({schemaVersion:1,seq,eventId:`e${seq}`,roleId:'A',at:'now',sessionGeneration:'g',source:'agent',kind,permissionId:kind==='permission.requested'?'p':undefined,payload:{}});
  writeFileSync(join(dir,'.conversation/events-000001.jsonl'),JSON.stringify(ev(1,'message.chunk'))+'\n');
  const adapter=new RoleSessionControlAdapter(dir,async(_dir,request)=>{
   if(request.command==='snapshot'){
    writeFileSync(join(dir,'.conversation/events-000001.jsonl'),[ev(1,'message.chunk'),ev(2,'permission.requested')].map(JSON.stringify).join('\n')+'\n');
    return {version:1,id:'x',ok:true,result:{backend:'acp'}};
   }
   calls++;return {version:1,id:'x',ok:true,result:{events:[],hasMore:false,snapshot:{sessionGeneration:'g',ledgerBarrier:calls===1?1:2,readiness:'idle',pendingPermissionIds:calls===1?[]:['p'],queueDepth:0}}};
  });
  const page=await adapter.conversationTail();expect(page.nextCursor).toBe('1');expect(page.events.map(e=>e.seq)).toEqual([1]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('closes a private follow handle that arrives after cancellation exactly once',async()=>{
 const {RoleSessionControlAdapter}=await import('../src/application/session-control.js');
 const {Socket}=await import('node:net');const abort=new AbortController();
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let closes=0;let finished=0;let options:any;
 const adapter=new RoleSessionControlAdapter('/unused',undefined,async(_dir,request)=>{
  options=request;await gate;return {socket:new Socket(),close:()=>{closes++;}};
 });
 const pending=adapter.followConversation({expectedGeneration:'g',after:0,controller:false,signal:abort.signal,onReplay:()=>{},onReady:()=>{},onEvent:()=>{},onState:()=>{},onClose:()=>{finished++;}});
 abort.abort();release();const handle=await pending;handle.close();handle.close();
 expect(options).toMatchObject({expectedGeneration:'g',after:0,controller:false});expect(closes).toBe(1);expect(finished).toBe(1);
});

// Structural I/O regression: an older page must not reparse all newer records.
it('seeks repeated healthy older pages without rereading the newer rotated prefix',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-tail-seek-'));
 const handle=await open(dir,'r');const proto=Object.getPrototypeOf(handle);await handle.close();
 const read=proto.read,parse=JSON.parse;let bytes=0,parses=0;
 try{
  mkdirSync(join(dir,'.conversation'));
  const names=Array.from({length:4},(_,i)=>`events-${String(i+1).padStart(6,'0')}.jsonl`);
  for(let segment=0;segment<4;segment++)writeFileSync(join(dir,'.conversation',names[segment]),Array.from({length:2000},(_,i)=>JSON.stringify({schemaVersion:1,seq:segment*2000+i+1,eventId:`seek-${segment*2000+i+1}`,kind:'message.chunk',sessionGeneration:'g',source:'agent',payload:{text:'界'.repeat(340)}})).join('\n')+'\n');
  writeFileSync(join(dir,'.conversation/manifest.json'),JSON.stringify({schemaVersion:1,nextSeq:8001,segments:names,failedGenerations:[]}));
  const snapshot={sessionGeneration:'g',readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[],ledgerBarrier:8000,stateRevision:1,commands:[],pendingPermissions:[]};
  proto.read=async function(this:unknown,...args:unknown[]){const result=await read.apply(this,args);bytes+=result.bytesRead;return result;};
  JSON.parse=((...args:Parameters<typeof JSON.parse>)=>{const value=parse(...args);if(value?.eventId?.startsWith('seek-'))parses++;return value;}) as typeof JSON.parse;
  let before='2201';const seen:number[]=[];
  for(let i=0;i<3;i++){
   const page=await conversationTailPage(dir,{before,limit:200},snapshot);
   expect(page.events.map(e=>e.seq)).toEqual(Array.from({length:200},(_,j)=>Number(before)-200+j));
   expect(page.hasOlder).toBe(true);expect(page.nextCursor).toBeUndefined();expect(page.context).toEqual([]);
   before=page.olderCursor!;seen.unshift(...page.events.map(e=>e.seq));
  }
  expect(seen).toEqual(Array.from({length:600},(_,i)=>1601+i));
  console.info('healthy older page structural counters',JSON.stringify({bytes,parses}));
  expect(bytes).toBeLessThan(2*1024*1024);
  expect(parses).toBeLessThan(800);
 }finally{proto.read=read;JSON.parse=parse;rmSync(dir,{recursive:true,force:true});}
});


describe('healthy older seek safety',()=>{
 const event=(seq:number,extra:Record<string,unknown>={})=>({schemaVersion:1,seq,eventId:`safety-${seq}`,kind:'message.chunk',sessionGeneration:'g',acpSessionId:'s',source:'agent',payload:{text:`界 ${seq}`},...extra});
 const snapshot={sessionGeneration:'g',readiness:'idle' as const,queueDepth:0,pendingPermissionIds:[],ledgerBarrier:1000,stateRevision:1,commands:[],pendingPermissions:[]};
 const fixture=async(run:(dir:string,write:(name:string,rows:unknown[],newline?:boolean)=>void,manifest:(names:string[],extra?:Record<string,unknown>)=>void)=>Promise<void>)=>{
  const dir=mkdtempSync(join(tmpdir(),'fleet-tail-seek-safety-'));mkdirSync(join(dir,'.conversation'));
  const write=(name:string,rows:unknown[],newline=true)=>writeFileSync(join(dir,'.conversation',name),rows.map(x=>JSON.stringify(x)).join('\n')+(newline?'\n':''));
  const manifest=(names:string[],extra:Record<string,unknown>={})=>writeFileSync(join(dir,'.conversation/manifest.json'),JSON.stringify({schemaVersion:1,nextSeq:1,segments:names,failedGenerations:[],...extra}));
  try{await run(dir,write,manifest);}finally{rmSync(dir,{recursive:true,force:true});}
 };
 const one='events-000001.jsonl',two='events-000002.jsonl';
 it('preserves numeric boundaries, visibility, resumed history and the captured barrier across rotations',async()=>{
  await fixture(async(dir,write,manifest)=>{
   const rows=Array.from({length:240},(_,i)=>event(i*2+1,i%7===0?{source:'agent_replay'}:i%5===0?{sessionGeneration:'old'}:i%3===0?{sessionGeneration:'foreign',acpSessionId:'foreign'}:{}));
   write(one,rows.slice(0,100));write(two,rows.slice(100));manifest([one,two]);
   // A recovery-time nextSeq can legitimately trail subsequent appends.
   const captured={...snapshot,ledgerBarrier:451};
   for(const resumed of [undefined,'s'])for(const before of ['0','1','199','201','202','305','481','2000']){
    const expected=await conversationTailPage(dir,{before,limit:17},{...captured,historyDegraded:true},resumed);
    expect(await conversationTailPage(dir,{before,limit:17},captured,resumed)).toEqual({...expected,snapshot:captured});
   }
   let before='481';const seen:number[]=[];
   for(;;){const page=await conversationTailPage(dir,{before,limit:17},captured,'s');seen.unshift(...page.events.map(x=>x.seq));if(!page.hasOlder)break;before=page.olderCursor!;}
   expect(seen).toEqual(rows.filter(x=>x.seq<=451&&x.source!=='agent_replay'&&(x.sessionGeneration==='g'||x.acpSessionId==='s')).map(x=>x.seq));
  });
 });
 it('keeps legacy, degraded and unproven manifests on the original non-monotonic scan',async()=>{
  await fixture(async(dir,write,manifest)=>{
   const rows=[event(1),event(40),event(2),{bad:'malformed schema'},event(100),event(3),event(4)];write(one,rows);
   const expected=[1,40,2,3,4];
   const cases=[
    {snapshot:{...snapshot,historyDegraded:true},manifest:{}},
    {snapshot,manifest:{failedGenerations:['g']}},
    {snapshot,manifest:{schemaVersion:2}},
    {snapshot,manifest:{nextSeq:0}},
    {snapshot,manifest:{segments:[one,one]}},
    {snapshot,manifest:{segments:[two]}},
    {snapshot:{...snapshot,observationFailure:'capture_failed' as const},manifest:{}},
    {snapshot:{...snapshot,stateRevision:undefined},manifest:{}},
    {snapshot:{...snapshot,ledgerBarrier:undefined},manifest:{}},
   ];
   const handle=await open(dir,'r'),proto=Object.getPrototypeOf(handle);await handle.close();const read=proto.read;
   try{
    for(const item of cases){
     manifest([one],item.manifest);const lengths:number[]=[];
     proto.read=function(this:unknown,...args:any[]){lengths.push(args[2]);return read.apply(this,args);};
     expect((await conversationTailPage(dir,{before:'50',limit:100},item.snapshot)).events.map(x=>x.seq)).toEqual(expected);
     expect(lengths).toEqual([statSync(join(dir,'.conversation',one)).size]);
    }
    proto.read=read;rmSync(join(dir,'.conversation/manifest.json'));
    expect((await conversationTailPage(dir,{before:'50',limit:100},snapshot)).events.map(x=>x.seq)).toEqual(expected);
    manifest([one]);write(two,[event(101)]); // discovered extra omitted by manifest
    expect((await conversationTailPage(dir,{before:'50',limit:100},snapshot)).events.map(x=>x.seq)).toEqual(expected);
    manifest([two,one]); // inverted manifest order is unproven too
    expect((await conversationTailPage(dir,{before:'50',limit:100},snapshot)).events.map(x=>x.seq)).toEqual(expected);
   }finally{proto.read=read;}
  });
 });
 it('reads complete huge UTF8 records and conservatively scans partial or legacy records',async()=>{
  await fixture(async(dir,write,manifest)=>{
   const huge=event(2,{payload:{text:'界🙂'.repeat(80000)}});const rows=[event(1),huge,event(3),event(4),event(5)];
   manifest([one]);
   for(const newline of [true,false]){
    write(one,rows,newline);
    const handle=await open(dir,'r'),proto=Object.getPrototypeOf(handle);await handle.close();const read=proto.read;let bytes=0;
    try{
     proto.read=async function(this:unknown,...args:any[]){const result=await read.apply(this,args);bytes+=result.bytesRead;return result;};
     const page=await conversationTailPage(dir,{before:'4',limit:2},snapshot);
     expect(page.events).toEqual([huge,event(3)]);expect(page.olderCursor).toBe('2');expect(page.hasOlder).toBe(true);
     // A midpoint inside a huge record discards that entire probe interval:
     // it must not read the same long line again at every binary-search step.
     expect(bytes).toBeLessThan(3*statSync(join(dir,'.conversation',one)).size);
     console.info('huge older record structural bytes',JSON.stringify({newline,bytes}));
    }finally{proto.read=read;}
   }
   write(one,[{...event(1),schemaVersion:undefined},huge,event(3)]);
   expect((await conversationTailPage(dir,{before:'4',limit:10},snapshot)).events.map(x=>x.seq)).toEqual([1,2,3]);
   writeFileSync(join(dir,'.conversation',one),JSON.stringify(event(1))+'\n{torn\n'+JSON.stringify(event(2))+'\n');
   expect((await conversationTailPage(dir,{before:'3',limit:10},snapshot)).events.map(x=>x.seq)).toEqual([1,2]);
  });
 });
 it('discards the whole seek attempt on append, rotation, truncation, replacement or short read',async()=>{
  for(const change of ['append','rotation','truncate','replace','short','during-page'])await fixture(async(dir,write,manifest)=>{
   const original=Array.from({length:40},(_,i)=>event(i+1));write(one,original);manifest([one]);
   const handle=await open(dir,'r'),proto=Object.getPrototypeOf(handle);await handle.close();const read=proto.read;
   let changed=false,calls=0;let expected=[25,26,27,28,29];
   try{
    proto.read=async function(this:unknown,...args:any[]){
     const result=await read.apply(this,args);calls++;
     if(!changed&&(change!=='during-page'||args[2]>4096)){
      changed=true;
      if(change==='append'||change==='during-page')appendFileSync(join(dir,'.conversation',one),JSON.stringify(event(41))+'\n');
      if(change==='rotation'){write(two,[event(41)]);manifest([one,two]);}
      if(change==='truncate'){write(one,original.slice(0,20));expected=[16,17,18,19,20];}
      if(change==='replace'){
       write('replacement',Array.from({length:40},(_,i)=>event((i+1)*3)));const before=statSync(join(dir,'.conversation',one));utimesSync(join(dir,'.conversation/replacement'),before.atime,before.mtime);renameSync(join(dir,'.conversation/replacement'),join(dir,'.conversation',one));expected=[15,18,21,24,27];
      }
      if(change==='short')return {...result,bytesRead:0};
     }
     return result;
    };
    const page=await conversationTailPage(dir,{before:'30',limit:5},{...snapshot,ledgerBarrier:40});
    expect(changed,change).toBe(true);expect(page.events.map(x=>x.seq),change).toEqual(expected);expect(new Set(page.events.map(x=>x.seq)).size).toBe(5);expect(page.hasOlder).toBe(true);expect(calls).toBeLessThan(40);
   }finally{proto.read=read;}
  });
 });
 it('cancels seek probes at different positions and closes the owned file',async()=>{
  for(const stopAfter of [1,2,4])await fixture(async(dir,write,manifest)=>{
   write(one,Array.from({length:50},(_,i)=>event(i+1)));manifest([one]);
   const handle=await open(dir,'r'),proto=Object.getPrototypeOf(handle);await handle.close();const read=proto.read;
   const owner=new AbortController();let fd=-1,reads=0;
   try{
    proto.read=async function(this:{fd:number},...args:any[]){const result=await read.apply(this,args);fd=this.fd;if(++reads===stopAfter)owner.abort();return result;};
    await expect(conversationTailPage(dir,{before:'30',limit:5},snapshot,undefined,owner.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(reads).toBe(stopAfter);expect(()=>fstatSync(fd)).toThrow(expect.objectContaining({code:'EBADF'}));
   }finally{proto.read=read;}
  });
 });
});
