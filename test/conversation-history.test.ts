import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
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
});
