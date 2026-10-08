import {createReadStream} from 'node:fs';
import {open,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import type {ConversationEventV1} from '../session/conversation-types.js';
import type {ConversationPageView} from './session-control.js';

const HISTORICAL_KINDS=['file.attached','fleet.task_created','prompt.admitted','message.chunk','message.replace','tool.upsert','tool.content_chunk','turn.completed'];

/** Whether a ledger event belongs in the conversation: the live generation, or history of the resumed ACP session. */
export function conversationEventVisible(event:ConversationEventV1,sessionGeneration:string,resumedSessionId?:string):boolean {
  return event.source!=='agent_replay' && (event.sessionGeneration===sessionGeneration || (!!resumedSessionId&&HISTORICAL_KINDS.includes(event.kind)&&event.acpSessionId===resumedSessionId));
}

/** Newest-first lines of a file, read in chunks from its end; `visit` returns false to stop. */
async function readLinesBackward(path:string,visit:(line:string)=>boolean):Promise<boolean> {
  const file=await open(path,'r');
  try {
    let position=(await file.stat()).size;let carry=Buffer.alloc(0);
    while(position>0){
      const size=Math.min(256*1024,position);position-=size;
      const chunk=Buffer.alloc(size);await file.read(chunk,0,size,position);
      let buffer=Buffer.concat([chunk,carry]);let end=buffer.length;
      for(let i=buffer.length-1;i>=0;i--){
        if(buffer[i]!==10)continue;
        if(end>i+1&&!visit(buffer.toString('utf8',i+1,end)))return false;
        end=i;
      }
      carry=buffer.subarray(0,end);
    }
    if(carry.length&&!visit(carry.toString('utf8')))return false;
    return true;
  } finally {await file.close();}
}

/** The last event cursor in a segment, read from its tail; undefined when none is readable. */
async function lastSeq(path:string):Promise<number|undefined> {
  let seq:number|undefined;
  await readLinesBackward(path,line=>{try{const value=Number(JSON.parse(line).seq);if(Number.isSafeInteger(value)){seq=value;return false;}}catch{}return true;});
  return seq;
}

export interface ConversationTailPage extends ConversationPageView {
  /** Pass as `before` to read the next older page. */
  olderCursor?: string;
  hasOlder: boolean;
  /** Latest page only: older events the view still needs, the current session's latest capabilities and still-pending permission requests. */
  context: ConversationEventV1[];
}

/**
 * The newest `limit` visible events before `before` (or the newest overall),
 * read backwards from the ledger so opening a long session costs one page.
 * `nextCursor` is the newest ledger position seen, for forward `after` paging.
 */
export async function conversationTailPage(stateDir:string,request:{before?:string;limit?:number},snapshot:ConversationPageView['snapshot'],resumedSessionId?:string):Promise<ConversationTailPage> {
  const before=request.before===undefined?Infinity:Number(request.before);
  if(before!==Infinity&&(!Number.isSafeInteger(before)||before<0))throw new Error('before must be a ledger cursor');
  const limit=Math.min(1000,Math.max(1,Number.isFinite(request.limit)?Math.floor(request.limit!):200));
  let files:string[]=[];
  try{files=(await readdir(join(stateDir,'.conversation'))).filter(n=>/^events-\d{6}\.jsonl$/.test(n)).sort().reverse();}catch{}
  const events:ConversationEventV1[]=[];let newest:number|undefined;let hasOlder=false;
  const pending=new Set(snapshot.pendingPermissionIds);let capabilities:ConversationEventV1|undefined;const context:ConversationEventV1[]=[];
  // Context only accompanies the newest page; older pages stop as soon as they are full.
  const wantsContext=()=>before===Infinity&&(!capabilities||pending.size>0);
  const generation=`"sessionGeneration":${JSON.stringify(snapshot.sessionGeneration)}`;
  for(const file of files){
    const more=await readLinesBackward(join(stateDir,'.conversation',file),line=>{
      if(hasOlder){
        // The page is full; only the current generation's context kinds matter. Generations are
        // appended in order, so the first line of an older one ends the search.
        if(!line.includes(generation))return !line.includes('"sessionGeneration":')&&wantsContext();
        if(!line.includes('"capabilities.updated"')&&!line.includes('"permission.requested"'))return wantsContext();
      }
      let event:ConversationEventV1;try{event=JSON.parse(line);}catch{return true;}
      const seq=Number(event.seq);if(!Number.isSafeInteger(seq))return true;
      newest??=seq;
      if(seq<before&&conversationEventVisible(event,snapshot.sessionGeneration,resumedSessionId)){
        const inPage=!hasOlder&&events.length<limit;
        if(event.sessionGeneration===snapshot.sessionGeneration){
          if(event.kind==='capabilities.updated'&&!capabilities){capabilities=event;if(!inPage)context.push(event);}
          if(event.kind==='permission.requested'&&event.permissionId&&pending.delete(event.permissionId)&&!inPage)context.push(event);
        }
        if(inPage)events.push(event);else hasOlder=true;
      }
      return !hasOlder||wantsContext();
    });
    if(!more)break;
  }
  events.reverse();context.reverse();
  return {events,snapshot,hasOlder,context,hasMore:false,
    ...(events.length?{olderCursor:String(events[0].seq)}:{}),
    ...(before===Infinity&&newest!==undefined?{nextCursor:String(newest)}:{})};
}

/** Read the existing ACP session ledger without opening its writer/recovery store. */
export async function resumedConversationPage(stateDir:string, request:{after?:string;limit?:number}, live:ConversationPageView, expectedSessionId:string):Promise<ConversationPageView> {
  let sessionId:string;let files:string[];
  try {
    sessionId=(await readFile(join(stateDir,'.acp-session-id'),'utf8')).trim();
    files=(await readdir(join(stateDir,'.conversation'))).filter(n=>/^events-\d{6}\.jsonl$/.test(n)).sort();
  } catch {return live;}
  if(!sessionId||sessionId!==expectedSessionId||!files.length)return live;
  const after=Number(request.after??0);
  if(!Number.isSafeInteger(after)||after<0)return live;
  const limit=Math.min(1000,Math.max(1,Number.isFinite(request.limit)?Math.floor(request.limit!):200));
  const events:ConversationEventV1[]=[];let next=String(after);let first:string|undefined;
  let hasMore=false;
  scan: for(const file of files){
    // Forward polling asks for the newest few events: skip whole segments that end at or before the cursor.
    const end=await lastSeq(join(stateDir,'.conversation',file));
    if(end!==undefined&&end<=after)continue;
    const input=createReadStream(join(stateDir,'.conversation',file),{encoding:'utf8'});
    const lines=createInterface({input,crlfDelay:Infinity});
    try {
      for await(const line of lines){
        let event:ConversationEventV1;try{event=JSON.parse(line);}catch{continue;}
        const cursor=Number(event.seq);
        if(!Number.isSafeInteger(cursor)||cursor<=after)continue;
        const historical=['file.attached','fleet.task_created','prompt.admitted','message.chunk','message.replace','tool.upsert','tool.content_chunk','turn.completed'].includes(event.kind);
        const visible=event.source!=='agent_replay' && (event.sessionGeneration===live.snapshot.sessionGeneration || (historical&&event.acpSessionId===sessionId));
        if(!visible){next=String(cursor);continue;}
        if(events.length===limit){hasMore=true;break scan;}
        first??=String(cursor);events.push(event);next=String(cursor);
      }
    } finally {lines.close();input.destroy();}
  }
  // If a fresh/resumed session changed during the read, use the live page only.
  if((await readFile(join(stateDir,'.acp-session-id'),'utf8')).trim()!==sessionId)return live;
  return {...live,events,firstAvailableCursor:first,nextCursor:next,hasMore};
}

/** Download authorization requires an actual published attachment, never an orphan copy. */
export async function conversationHasAttachment(stateDir: string, attachment: import('../file-delivery/types.js').DeliveredFile): Promise<boolean> {
  const dir = join(stateDir, '.conversation');
  const names = (await readdir(dir)).filter(n => /^events-\d+\.jsonl$/.test(n)).sort().reverse();
  let found = false;
  for (const name of names) {
    await readLinesBackward(join(dir, name), line => {
      try {
        const e = JSON.parse(line) as ConversationEventV1;
        const a = (e.payload as { attachment?: import('../file-delivery/types.js').DeliveredFile }).attachment;
        if (e.kind === 'file.attached' && e.source === 'agent' && a?.id === attachment.id
            && e.sessionGeneration === attachment.sessionGeneration && e.acpSessionId === attachment.acpSessionId
            && e.turnId === attachment.turnId && JSON.stringify(a) === JSON.stringify(attachment)) found = true;
      } catch { /* unreadable lines cannot authorize a download */ }
      return !found;
    });
    if (found) break;
  }
  return found;
}
