import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localFleetAuditor} from '../src/runner.js';
import {ConversationEventStore} from '../src/session/conversation-store.js';
import {appendTaskCreated,type TaskNoticeBinding} from '../src/session/task-notice.js';
import type {AgentSession} from '../src/session/types.js';
it('binds trusted audit begin to original prompt and emits only completed success once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-auditor-notice-'));const ledger=new ConversationEventStore(join(dir,'ledger'),{roleId:'fixture'});
 let binding:TaskNoticeBinding|undefined={sessionGeneration:'g',acpSessionId:'s',promptId:'original'};
 const session={taskNoticeBinding:()=>binding,recordTaskCreated:(b,n)=>appendTaskCreated(ledger,b,n)} as AgentSession;
 const audit=localFleetAuditor(dir,'fixture',()=>{},session);
 const presentation={kind:'task' as const,operation:'create' as const,eventId:'task-created',id:'0mul7vkrx8f79074b',title:'Fixture',previousState:'none',newState:'backlog',agents:[]};
 try{
  const started=await audit.begin('request1',['task','create','--title','Fixture','--backlog','--no-room']);
  binding={...binding!,promptId:'later'};
  const finish={correlationId:started.correlationId,class:'success' as const,effect:'completed' as const,presentations:[presentation]};
  await audit.finish(finish);await audit.finish(finish);
  expect(ledger.page({}).events).toEqual([expect.objectContaining({promptId:'original',acpSessionId:'s',payload:expect.objectContaining({operationId:'task-created'})})]);
  for(const [name,classification,effect] of [['failed','runtime','not_started'],['unknown','timeout','unknown']] as const){
   const a=await audit.begin(name,['task','create']);await audit.finish({correlationId:a.correlationId,class:classification,effect,presentations:[{...presentation,eventId:name}]});
  }
  binding=undefined;const unbound=await audit.begin('unbound',['task','create']);await audit.finish({...finish,correlationId:unbound.correlationId,presentations:[{...presentation,eventId:'unbound'}]});
  expect(ledger.page({}).events).toHaveLength(1);
  binding={sessionGeneration:'g',acpSessionId:'s',promptId:'last'};
  session.recordTaskCreated=()=>{throw Error('disk failure')};const bad=await audit.begin('disk',['task','create']);
  expect((await audit.finish({...finish,correlationId:bad.correlationId,presentations:[{...presentation,eventId:'disk'}]})).outcome?.class).toBe('success');
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
