import {createReadStream} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import type {ConversationEventV1} from '../session/conversation-types.js';
import type {ConversationPageView} from './session-control.js';

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
    const input=createReadStream(join(stateDir,'.conversation',file),{encoding:'utf8'});
    const lines=createInterface({input,crlfDelay:Infinity});
    try {
      for await(const line of lines){
        let event:ConversationEventV1;try{event=JSON.parse(line);}catch{continue;}
        const cursor=Number(event.seq);
        if(!Number.isSafeInteger(cursor)||cursor<=after)continue;
        const historical=['prompt.admitted','message.chunk','message.replace','tool.upsert','tool.content_chunk','turn.completed'].includes(event.kind);
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
