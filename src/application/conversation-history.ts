import {createReadStream} from 'node:fs';
import {open,readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import type {ConversationEventV1,ConversationObservationState} from '../session/conversation-types.js';
import type {ConversationPageView} from './session-control.js';

const HISTORICAL_KINDS=['file.attached','fleet.task_created','prompt.admitted','message.chunk','message.replace','tool.upsert','tool.content_chunk','turn.completed'];

/** Whether a ledger event belongs in the conversation: the live generation, or history of the resumed ACP session. */
export function conversationEventVisible(event:ConversationEventV1,sessionGeneration:string,resumedSessionId?:string):boolean {
  return event.source!=='agent_replay' && (event.sessionGeneration===sessionGeneration || (!!resumedSessionId&&HISTORICAL_KINDS.includes(event.kind)&&event.acpSessionId===resumedSessionId));
}

// A seek attempt is transactional: its caller discards all collected rows and
// performs one ordinary scan if a probe or the file identity is no longer safe.
class SeekFallback extends Error {}
type SegmentStamp = {dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number};
const stamp=(info:SegmentStamp)=>`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
type TailSeek = {before:number;checked:Array<{path:string;key:string}>};

/** Strict lower bound in an admitted monotonic writer segment, on this FD only. */
async function seekBefore(file:Awaited<ReturnType<typeof open>>,size:number,before:number,signal?:AbortSignal):Promise<number> {
  const read=async(position:number,length:number)=>{
    signal?.throwIfAborted();
    const bytes=Buffer.alloc(length);
    const {bytesRead}=await file.read(bytes,0,length,position);
    signal?.throwIfAborted();
    if(bytesRead!==length)throw new SeekFallback('segment changed during seek');
    return bytes;
  };
  if(!size)return 0;
  // An active partial append is not a safe boundary, even if the first event
  // would let us skip this whole segment.
  if((await read(size-1,1))[0]!==10)throw new SeekFallback('partial segment');
  const record=async(position:number)=>{
    let start=position,end=position;const left:Buffer[]=[],right:Buffer[]=[];
    while(start>0){
      const length=Math.min(4096,start),chunk=await read(start-length,length);
      const newline=chunk.lastIndexOf(10);
      left.push(chunk.subarray(newline+1));start-=length;
      if(newline>=0){start+=newline+1;break;}
    }
    while(end<size){
      const chunk=await read(end,Math.min(4096,size-end)),newline=chunk.indexOf(10);
      right.push(newline<0?chunk:chunk.subarray(0,newline));end+=newline<0?chunk.length:newline+1;
      if(newline>=0)break;
    }
    let event:ConversationEventV1;
    try{event=JSON.parse(Buffer.concat([...left.reverse(),...right]).toString('utf8'));}
    catch{throw new SeekFallback('unreadable seek record');}
    if(!event||event.schemaVersion!==1||!Number.isSafeInteger(event.seq)||event.seq<=0)throw new SeekFallback('legacy seek record');
    return {start,end,seq:event.seq};
  };
  const first=await record(0);
  if(first.seq>=before)return 0;
  let low=first.end,high=size,lower=first.seq,upper=Infinity;
  while(low<high){
    const found=await record(Math.floor((low+high)/2));
    if(found.start<low||found.end>high||found.seq<=lower||found.seq>=upper)throw new SeekFallback('non-monotonic seek record');
    if(found.seq<before){low=found.end;lower=found.seq;}
    else{high=found.start;upper=found.seq;}
  }
  return low;
}

/** Newest-first lines; optional finite-before seek is only for a healthy writer. */
async function readLinesBackward(path:string,visit:(line:string)=>boolean,signal?:AbortSignal,seek?:TailSeek):Promise<boolean> {
  signal?.throwIfAborted();
  let file:Awaited<ReturnType<typeof open>>;
  try{file=await open(path,'r');}catch(error){signal?.throwIfAborted();if(seek)throw new SeekFallback('segment disappeared');throw error;}
  try {
    const initial=await file.stat(),key=stamp(initial);
    let position=seek?await seekBefore(file,initial.size,seek.before,signal):initial.size;
    let carry=Buffer.alloc(0),more=true;
    scan: while(position>0){
      signal?.throwIfAborted();
      const size=Math.min(256*1024,position);position-=size;
      const chunk=Buffer.alloc(size);const {bytesRead}=await file.read(chunk,0,size,position);
      signal?.throwIfAborted();
      if(seek&&bytesRead!==size)throw new SeekFallback('short segment read');
      const buffer=Buffer.concat([chunk.subarray(0,bytesRead),carry]);let end=buffer.length;
      for(let i=buffer.length-1;i>=0;i--){
        if(buffer[i]!==10)continue;
        if(end>i+1&&!visit(buffer.toString('utf8',i+1,end))){more=false;break scan;}
        end=i;
      }
      carry=buffer.subarray(0,end);
    }
    if(more&&carry.length&&!visit(carry.toString('utf8')))more=false;
    if(seek){
      signal?.throwIfAborted();
      const current=await stat(path).catch(()=>undefined);
      if(stamp(await file.stat())!==key||!current||stamp(current)!==key)throw new SeekFallback('segment changed during read');
      seek.checked.push({path,key});
    }
    return more;
  } catch(error){signal?.throwIfAborted();if(seek&&!(error instanceof SeekFallback))throw new SeekFallback('seek read unavailable');throw error;}
  finally {await file.close();}
}

/** Existing writer provenance, never a substitute for the captured barrier. */
async function seekManifest(dir:string,files:string[],signal?:AbortSignal):Promise<string|undefined> {
  try{
    signal?.throwIfAborted();
    const raw=await readFile(join(dir,'manifest.json'),{encoding:'utf8',signal}),value=JSON.parse(raw);
    if(value.schemaVersion!==1||!Number.isSafeInteger(value.nextSeq)||value.nextSeq<1
      ||!Array.isArray(value.segments)||value.segments.length!==files.length
      ||value.segments.some((name:unknown,i:number)=>name!==files[files.length-1-i])
      ||(value.failedGenerations!==undefined&&(!Array.isArray(value.failedGenerations)||value.failedGenerations.length>0)))return;
    return raw;
  }catch{signal?.throwIfAborted();return;}
}

// Rotated segments never change, so their last cursor is reused until the file itself changes.
const lastSeqs=new Map<string,{key:string;seq:number|undefined}>();

/** The last event cursor in a segment, read from its tail; undefined when none is readable. */
async function lastSeq(path:string):Promise<number|undefined> {
  const info=await stat(path).catch(()=>undefined);
  const key=info&&`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  const known=key?lastSeqs.get(path):undefined;
  if(key&&known?.key===key)return known.seq;
  let seq:number|undefined;
  await readLinesBackward(path,line=>{try{const value=Number(JSON.parse(line).seq);if(Number.isSafeInteger(value)){seq=value;return false;}}catch{}return true;});
  if(key){
    lastSeqs.delete(path);lastSeqs.set(path,{key,seq});
    if(lastSeqs.size>4096)lastSeqs.delete(lastSeqs.keys().next().value!);
  }
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
export async function conversationTailPage(stateDir:string,request:{before?:string;limit?:number},snapshot:ConversationPageView['snapshot'],resumedSessionId?:string,signal?:AbortSignal):Promise<ConversationTailPage> {
  try{return await tailPage(stateDir,request,snapshot,resumedSessionId,signal,true);}
  catch(error){
    signal?.throwIfAborted();
    if(!(error instanceof SeekFallback))throw error;
    return tailPage(stateDir,request,snapshot,resumedSessionId,signal,false);
  }
}

async function tailPage(stateDir:string,request:{before?:string;limit?:number},snapshot:ConversationPageView['snapshot'],resumedSessionId:string|undefined,signal:AbortSignal|undefined,allowSeek:boolean):Promise<ConversationTailPage> {
  signal?.throwIfAborted();
  const before=request.before===undefined?Infinity:Number(request.before);
  if(before!==Infinity&&(!Number.isSafeInteger(before)||before<0))throw new Error('before must be a ledger cursor');
  const limit=Math.min(1000,Math.max(1,Number.isFinite(request.limit)?Math.floor(request.limit!):200));
  let files:string[]=[];
  try{files=(await readdir(join(stateDir,'.conversation'))).filter(n=>/^events-\d{6}\.jsonl$/.test(n)).sort().reverse();}catch{}
  const events:ConversationEventV1[]=[];let newest:number|undefined;let hasOlder=false;
  const observation = snapshot as Partial<ConversationObservationState>;
  const barrier = observation.ledgerBarrier;
  // Current supervisors capture these sanitized inventories together with the
  // ledger barrier. The browser uses them directly, including authoritative
  // empty arrays. Looking for their old ledger events would scan the entire
  // generation on every open. Legacy/incomplete snapshots still need context.
  const complete = !snapshot.observationFailure && Number.isSafeInteger(barrier) && barrier! >= 0
    && Number.isSafeInteger(observation.stateRevision) && observation.stateRevision! >= 0;
  const dir=join(stateDir,'.conversation');
  const manifest=allowSeek&&before!==Infinity&&complete&&!snapshot.historyDegraded
    ?await seekManifest(dir,files,signal):undefined;
  const seek:TailSeek|undefined=manifest===undefined?undefined:{before,checked:[]};
  let previousSeq=Infinity;
  const needsCapabilities = !complete || !Array.isArray(observation.commands);
  const pending=new Set(complete && Array.isArray(observation.pendingPermissions)
    && snapshot.pendingPermissionIds.every(id=>observation.pendingPermissions!.some(permission=>permission.permissionId===id))
    ? [] : snapshot.pendingPermissionIds);
  let capabilities:ConversationEventV1|undefined;const context:ConversationEventV1[]=[];
  // Context only accompanies the newest page; older pages stop as soon as they are full.
  const wantsContext=()=>before===Infinity&&((needsCapabilities&&!capabilities)||pending.size>0);
  const generation=`"sessionGeneration":${JSON.stringify(snapshot.sessionGeneration)}`;
  for(const file of files){
    const more=await readLinesBackward(join(stateDir,'.conversation',file),line=>{
      if(hasOlder){
        // The page is full; only the current generation's context kinds matter. Generations are
        // appended in order, so the first line of an older one ends the search.
        if(!line.includes(generation))return !line.includes('"sessionGeneration":')&&wantsContext();
        if(!line.includes('"capabilities.updated"')&&!line.includes('"permission.requested"'))return wantsContext();
      }
      let event:ConversationEventV1;try{event=JSON.parse(line);}catch{if(seek)throw new SeekFallback('unreadable page record');return true;}
      const seq=Number(event.seq);
      if(seek){
        if(event.schemaVersion!==1||!Number.isSafeInteger(seq)||seq<=0||seq>=previousSeq)throw new SeekFallback('non-monotonic page record');
        previousSeq=seq;
      }
      if(!Number.isSafeInteger(seq))return true;
      if(barrier!==undefined&&seq>barrier)return true;
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
    },signal,seek);
    if(!more)break;
  }
  if(seek){
    signal?.throwIfAborted();
    const currentFiles=(await readdir(dir).catch(()=>{throw new SeekFallback('ledger disappeared');})).filter(n=>/^events-\d{6}\.jsonl$/.test(n)).sort().reverse();
    if(await seekManifest(dir,currentFiles,signal)!==manifest||currentFiles.join()!==files.join())throw new SeekFallback('segments rotated during page');
    for(const checked of seek.checked){
      signal?.throwIfAborted();
      const current=await stat(checked.path).catch(()=>undefined);
      if(!current||stamp(current)!==checked.key)throw new SeekFallback('segment replaced during page');
    }
  }
  events.reverse();context.reverse();
  return {events,snapshot,hasOlder,context,hasMore:false,
    ...(events.length?{olderCursor:String(events[0].seq)}:{}),
    ...(before===Infinity&&(barrier!==undefined||newest!==undefined)?{nextCursor:String(barrier??newest)}:{})};
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

/** Passive, bounded last assistant text for directory previews. Never opens the
 * ledger writer/recovery path or acquires a session/controller. An incomplete
 * newest append is not committed yet; completed malformed records still fail. */
/** The assistant message events a preview is made of. */
const previewAssistant=(event:ConversationEventV1)=>['message.chunk','message.replace'].includes(event.kind) && (event.payload as any)?.role==='assistant' && typeof (event.payload as any)?.content?.type==='string';
/** Bytes of a segment's tail a preview may consider, and the newest events it reads. */
const PREVIEW_WINDOW_BYTES = 2 * 1024 * 1024;
const PREVIEW_EVENTS = 200;

/**
 * Newest-first completed events from the last PREVIEW_WINDOW_BYTES of one
 * segment, read backwards in chunks until `need` events are found. A record
 * cut by the window start is not complete and is skipped. Only the newest
 * segment can have an in-flight append; elsewhere a partial record fails.
 */
async function previewSegmentEvents(path:string,newest:boolean,need:number,signal:AbortSignal,until?:(event:ConversationEventV1)=>boolean):Promise<ConversationEventV1[]> {
  const events:ConversationEventV1[]=[];
  const file=await open(path,'r');
  try {
    const size=(await file.stat()).size,floor=Math.max(0,size-PREVIEW_WINDOW_BYTES);
    let position=size,carry=Buffer.alloc(0),trailing=true;
    const take=(line:string)=>{
      const event=JSON.parse(line) as ConversationEventV1;
      if(event.schemaVersion!==1 || !Number.isSafeInteger(event.seq))throw Error('preview ledger invalid');
      events.push(event);
      if(until?.(event))need=events.length;
    };
    while(position>floor && events.length<need){
      signal.throwIfAborted();
      const length=Math.min(64*1024,position-floor);position-=length;
      const chunk=Buffer.alloc(length);await file.read(chunk,0,length,position);
      const buffer=Buffer.concat([chunk,carry]);let end=buffer.length;
      for(let i=buffer.length-1;i>=0 && events.length<need;i--){
        if(buffer[i]!==10)continue;
        if(trailing){
          if(end>i+1 && !newest)throw Error('preview ledger has partial record');
          trailing=false;
        } else take(buffer.toString('utf8',i+1,end));
        end=i;
      }
      carry=buffer.subarray(0,end);
    }
    if(trailing && position===floor && (!newest || floor>0) && size>0)throw Error('preview ledger has partial record');
    // At the file start the remaining bytes are the first complete record.
    if(!trailing && floor===0 && position===0 && events.length<need)take(carry.toString('utf8'));
  } finally {await file.close();}
  return events;
}

/**
 * The newest assistant message's time alone: the same event the text preview ends with,
 * found by reading backwards only until it, within the same event and byte bounds.
 * Records older than it are not read, so they are not validated either.
 */
export async function conversationActivity(stateDir: string, signal: AbortSignal): Promise<{at:string}> {
  signal.throwIfAborted();
  const dir=join(stateDir,'.conversation');
  let files:string[];
  try {files=(await readdir(dir)).filter(name=>/^events-\d{6}\.jsonl$/.test(name)).sort().reverse();}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {at:''};throw error;}
  let read=0;
  for(const name of files){
    signal.throwIfAborted();
    const events=await previewSegmentEvents(join(dir,name),name===files[0],PREVIEW_EVENTS-read,signal,previewAssistant);
    const found=events.find(previewAssistant);
    if(found)return {at:found.at??''};
    read+=events.length;
    if(read>=PREVIEW_EVENTS)break;
  }
  signal.throwIfAborted();
  return {at:''};
}

export async function conversationPreview(stateDir: string, signal: AbortSignal): Promise<{text:string;at:string}> {
  signal.throwIfAborted();
  const dir=join(stateDir,'.conversation');
  let files:string[];
  try {files=(await readdir(dir)).filter(name=>/^events-\d{6}\.jsonl$/.test(name)).sort().reverse();}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {text:'No recent agent output',at:''};throw error;}
  const events:ConversationEventV1[]=[];
  for(const name of files){
    signal.throwIfAborted();
    events.push(...await previewSegmentEvents(join(dir,name),name===files[0],PREVIEW_EVENTS-events.length,signal));
    if(events.length>=PREVIEW_EVENTS)break;
  }
  signal.throwIfAborted();
  const assistant=previewAssistant;
  const end=events.findIndex(assistant);if(end<0)return {text:'No recent agent output',at:''};
  const last=events[end],parts:string[]=[];
  for(let i=end;i<events.length;i++){
    const event=events[i];
    if(last.messageId!==undefined){if(!assistant(event)||event.messageId!==last.messageId)continue;}
    else if(!assistant(event)||event.messageId!==undefined)break;
    const content=(event.payload as any).content;
    parts.unshift(content.type==='text'?content.text:`[${content.type}]`);
    if(event.kind==='message.replace')break;
  }
  return {text:parts.join('').replace(/\s+/g,' ').trim().slice(0,300)||'No recent agent output',at:last.at??''};
}
