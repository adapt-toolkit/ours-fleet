import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resumedConversationPage} from '../src/application/conversation-history.js';
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
