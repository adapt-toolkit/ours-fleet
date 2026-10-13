import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Duplex } from 'node:stream';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openChatFile, openDirectory, MAX_FILE_BYTES } from '../src/file-delivery/reader.js';
import { currentChatFileHandler } from '../src/agent-ours/service.js';
import { FileCallbacks } from '../src/agent-ours/file-rpc.js';
import { Wire } from '../src/agent-ours/wire.js';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { conversationEventVisible, conversationHasAttachment } from '../src/application/conversation-history.js';
import { ArtifactStore, readDeliveredFile } from '../src/file-delivery/store.js';
import { AcpSession } from '../src/session/acp.js';
const dirs: string[]=[]; const sessions: AcpSession[]=[];
afterEach(async()=>{for(const s of sessions.splice(0))await s.close();for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});delete process.env.OURS_FLEET_HOME;});
function temp(){mkdirSync(resolve('test-output'),{recursive:true});const p=mkdtempSync(resolve('test-output/file-delivery-'));dirs.push(p);return p;}
const signal=()=>new AbortController().signal;
const binding={sessionGeneration:'g',acpSessionId:'actual',turnId:'t'};
const policy={approval:'allow',filesystem:'workspace',unattended:'deny'} as const;
async function live(){const dir=temp(); const s=await AcpSession.start({name:'A',argv:[process.execPath,resolve('test/fixtures/acp-agent.mjs')],cwd:dir,env:{},stateDir:dir,mode:'fresh',permissions:policy,log:()=>{}});sessions.push(s);return {dir,s};}
async function running(s:AcpSession){const task=s.submitPrompt('block 20000');await new Promise<void>((r,j)=>{const stop=setTimeout(()=>j(Error('no turn')),2000);const check=()=>{if(s.snapshot().readiness==='running'){clearTimeout(stop);r();}else setTimeout(check,5);};check();});return {task};}
it('reader accepts the provided path anywhere: relative, parent-relative, absolute, hidden and through a symlinked ancestor',async()=>{
 const base=temp(),cwd=join(base,'work'),outside=join(base,'.hidden','elsewhere');mkdirSync(cwd);mkdirSync(outside,{recursive:true});
 writeFileSync(join(cwd,'in.bin'),'in');writeFileSync(join(outside,'out.bin'),'out');writeFileSync(join(outside,'.env'),'dot');symlinkSync(outside,join(cwd,'linked-dir'));
 for(const [path,bytes] of [['in.bin','in'],['./in.bin','in'],['../.hidden/elsewhere/out.bin','out'],[join(outside,'out.bin'),'out'],[join(outside,'.env'),'dot'],['linked-dir/out.bin','out']]){
  const opened=await openChatFile(cwd,path);
  try{expect((await opened.file.readFile()).toString()).toBe(bytes);expect(opened.path).toBe(path.startsWith('linked-dir')?join(outside,'out.bin'):resolve(cwd,path));}finally{await opened.file.close();}
 }
});
it('reader keeps ordinary file integrity checks and names each refusal',async()=>{
 const cwd=temp();writeFileSync(join(cwd,'file.bin'),'abc');symlinkSync(join(cwd,'file.bin'),join(cwd,'link'));linkSync(join(cwd,'file.bin'),join(cwd,'hard'));mkdirSync(join(cwd,'dir'));
 execFileSync('mkfifo',[join(cwd,'fifo')]);writeFileSync(join(cwd,'single.bin'),'abc');
 const big=join(cwd,'big.bin');fs.closeSync(fs.openSync(big,'w'));fs.truncateSync(big,MAX_FILE_BYTES+1);
 for(const [path,reason] of [['link','CHAT_FILE_IS_SYMLINK'],['hard','CHAT_FILE_HARDLINKED'],['file.bin','CHAT_FILE_HARDLINKED'],['dir','CHAT_FILE_NOT_REGULAR'],['fifo','CHAT_FILE_NOT_REGULAR'],
   ['missing','CHAT_FILE_NOT_FOUND'],['file.bin/child','CHAT_FILE_NOT_FOUND'],['big.bin','FILE_EXCEEDS_20_MIB'],['','INVALID_CHAT_FILE_PATH'],['a\0b','INVALID_CHAT_FILE_PATH']])
  await expect(openChatFile(cwd,path)).rejects.toThrow(reason);
 const ok=await openChatFile(cwd,'single.bin');await ok.file.close();
});
function bridgePair(){
 let a!:Duplex,b!:Duplex;
 a=new Duplex({read(){},write(chunk,_e,done){b.push(chunk);done();}});b=new Duplex({read(){},write(chunk,_e,done){a.push(chunk);done();}});
 return [a,b] as const;
}
/** The real bridge-side open and supervisor-side callbacks, joined by an in-memory wire. */
function chatFiles(cwd:string){
 const [left,right]=bridgePair();const server=new Wire(left as never),bridge=new Wire(right as never);const files=new FileCallbacks(server);
 const handles=new Map<string,{file:Awaited<ReturnType<typeof openChatFile>>['file'];size:number;mtimeMs:number}>();
 server.onFrame=frame=>files.receive(frame);
 bridge.onFrame=async(raw:any)=>{try{
   let value:unknown=null;
   if(raw.op==='export-open'){const opened=await openChatFile(cwd,raw.args.path);const stat=await opened.file.stat();handles.set(raw.args.handle,{file:opened.file,size:stat.size,mtimeMs:stat.mtimeMs});value={filename:opened.path.split('/').at(-1),size:stat.size,path:opened.path};}
   else if(raw.op==='read'){const row=handles.get(raw.args.handle)!;const stat=await row.file.stat();if(stat.size!==row.size||stat.mtimeMs!==row.mtimeMs)throw Error('CHAT_FILE_CHANGED');const buffer=Buffer.alloc(65536);const {bytesRead}=await row.file.read(buffer);value=bytesRead?buffer.subarray(0,bytesRead).toString('base64'):null;}
   else if(raw.op==='close'){await handles.get(raw.args.handle)?.file.close();handles.delete(raw.args.handle);}
   await bridge.send({kind:'fs-result',id:raw.id,value});
  }catch(error){await bridge.send({kind:'fs-result',id:raw.id,error:(error as Error).message});}};
 return files;
}
const extra=()=>({requestId:randomUUID(),signal:signal()}) as never;
it('default handler needs no Agent setting: sends an out-of-tree absolute path on the live ACP turn with exact bytes',async()=>{
 const base=temp();process.env.OURS_FLEET_HOME=base;mkdirSync(join(base,'.ours-fleet'));const {dir,s}=await live();writeFileSync(join(dir,'.session-id'),randomUUID());
 const outside=join(base,'.elsewhere');mkdirSync(outside);const bytes=Buffer.from([0,255,128,42,10,0,64]);writeFileSync(join(outside,'report.pdf'),bytes);
 // A role as resolved from a manifest with no file_delivery block at all.
 const role={harness:'claude-code',session:'acp',permissions:policy} as const;
 const handler=currentChatFileHandler({role,cwd:dir,store:new ArtifactStore(dir),sender:()=>s.sendFileToChat.bind(s),privateState:[join(base,'.ours-fleet','private-ours')]});
 const files=chatFiles(dir);
 await expect(handler({path:join(outside,'report.pdf')},extra(),files)).rejects.toThrow('CURRENT_CHAT_DELIVERY_UNAVAILABLE'); // idle: no turn to bind
 const {task}=await running(s);
 // Outside the role's `workspace` boundary the neutral policy asks a human instead of auto-allowing; nothing else gates the path.
 s.setControllerAttached(true);let asked=0;const approve=setInterval(()=>{for(const e of s.conversationPage({}).events.filter(e=>e.kind==='permission.requested'))if(s.respondPermission(e.permissionId!,'send'))asked++;},5);
 const sent=await handler({path:join(outside,'report.pdf')},extra(),files);
 expect(sent).toMatchObject({name:'report.pdf',mimeType:'application/pdf',size:bytes.length,acpSessionId:s.snapshot().sessionId});
 expect((await readDeliveredFile(dir,sent.id)).bytes).toEqual(bytes);
 const relative=await handler({path:'../'+base.split('/').at(-1)+'/.elsewhere/report.pdf',filename:'renamed.bin'},extra(),files);expect(relative.name).toBe('renamed.bin');
 clearInterval(approve);expect(asked).toBe(2);
 writeFileSync(join(dir,'inside.txt'),'in');expect((await handler({path:'inside.txt'},extra(),files)).mimeType).toBe('text/plain');expect(asked).toBe(2); // inside: auto-allowed
 expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(3);
 await expect(handler({path:join(dir,'absent.pdf')},extra(),files)).rejects.toThrow('CHAT_FILE_NOT_FOUND');
 await expect(handler({path:'inside.txt',filename:'a/b'},extra(),files)).rejects.toThrow('INVALID_FILENAME');
 await expect(handler({path:'inside.txt',mime:'not a mime'},extra(),files)).rejects.toThrow('INVALID_MIME');
 expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(3);
 await s.interrupt();await task;
});
it('a source changed while it is read is refused and never published',async()=>{
 const base=temp();process.env.OURS_FLEET_HOME=base;mkdirSync(join(base,'.ours-fleet'));const {dir,s}=await live();writeFileSync(join(dir,'.session-id'),randomUUID());
 const path=join(dir,'growing.txt');writeFileSync(path,'abc');const files=chatFiles(dir);
 const store=new ArtifactStore(dir);const copy=store.copy.bind(store);
 const handler=currentChatFileHandler({role:{harness:'codex',session:'acp',permissions:policy},cwd:dir,sender:()=>s.sendFileToChat.bind(s),privateState:[],
  store:{copy:(...args)=>{appendFileSync(path,'more');return copy(...args);}}});
 const {task}=await running(s);
 await expect(handler({path:'growing.txt'},extra(),files)).rejects.toThrow(/CHAT_FILE_CHANGED|SOURCE_SIZE_CHANGED/);
 expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(0);await s.interrupt();await task;
});
it('Fleet private state is refused by provided path before approval and by real path after open',async()=>{
 const base=temp(),secret=join(base,'private-ours');mkdirSync(secret);writeFileSync(join(secret,'token'),'secret');symlinkSync(secret,join(base,'alias'));
 let approvals=0,copies=0;const sender=async(_i:any,_s:any,copy:any)=>{approvals++;return copy(binding);};
 const handler=currentChatFileHandler({role:{harness:'codex',session:'acp',permissions:policy},cwd:base,sender:()=>sender as never,privateState:[secret],
  store:{copy:async()=>{copies++;throw Error('unexpected copy');}}});
 const files=chatFiles(base);
 for(const path of ['private-ours/token',join(secret,'token'),'x/../private-ours/token']){await expect(handler({path},extra(),files)).rejects.toThrow('PRIVATE_STATE_CANNOT_BE_SENT');}
 expect(approvals).toBe(0);
 await expect(handler({path:'alias/token'},extra(),files)).rejects.toThrow('PRIVATE_STATE_CANNOT_BE_SENT');expect(approvals).toBe(1);expect(copies).toBe(0);
});
it.each([['codex','tmux'],['claude-code','tmux'],['gemini','acp'],['opencode','acp']])('unsupported backend %s/%s gets a precise result, never a read',async(harness,session)=>{
 let touched=0;const fail=()=>{touched++;throw Error('unexpected');};
 const handler=currentChatFileHandler({role:{harness,session,permissions:policy} as never,cwd:'/work',sender:()=>fail as never,privateState:[],store:{copy:fail as never}});
 await expect(handler({path:'x'},extra(),{readChatFile:fail} as never)).rejects.toThrow(`CURRENT_CHAT_DELIVERY_UNAVAILABLE: sending a file to this chat requires a Codex or Claude ACP session; this Agent runs ${harness}/${session}. Pass contact to send through Ours instead`);
 expect(touched).toBe(0);
});
it('a supported role whose session exposes no chat sender reports that precisely',async()=>{
 const handler=currentChatFileHandler({role:{harness:'codex',session:'acp',permissions:policy},cwd:'/work',sender:()=>undefined,privateState:[],store:{copy:async()=>{throw Error('unexpected');}}});
 await expect(handler({path:'x'},extra(),{} as never)).rejects.toThrow('CURRENT_CHAT_DELIVERY_UNAVAILABLE: this session has no ACP chat to attach to');
});
it('private immutable copy retains original bytes, rejects short/oversized input, and manual repetition is independent',async()=>{
 const dir=temp();process.env.OURS_FLEET_HOME=dir;mkdirSync(join(dir,'.ours-fleet'));const state=join(dir,'role');mkdirSync(state);writeFileSync(join(state,'.session-id'),randomUUID());const store=new ArtifactStore(state);let closed=0;
 const source=(size=3)=>({size,body:new Blob(['abc']).stream(),close:async()=>{closed++;}});
 const a=await store.copy(source(),'file.html','text/html',binding,signal()), b=await store.copy(source(),'file.html','text/html',binding,signal());
 expect(a.id).not.toBe(b.id);
 const conversation = new ConversationEventStore(join(state,'.conversation'), { roleId: 'A' });
 expect(await conversationHasAttachment(state,a)).toBe(false);
 const event=conversation.append({kind:'file.attached',source:'agent',...binding,payload:{attachment:a}});
 expect(await conversationHasAttachment(state,a)).toBe(true);expect(conversationEventVisible(event,'new','actual')).toBe(true);expect(conversationEventVisible(event,'new','foreign')).toBe(false);conversation.close();
 expect((await readDeliveredFile(state,a.id)).bytes.toString()).toBe('abc');expect(closed).toBe(2);
 await expect(store.copy(source(4),'short','text/plain',binding,signal())).rejects.toThrow('SOURCE_SIZE_CHANGED');
 await expect(store.copy(source(MAX_FILE_BYTES+1),'large','text/plain',binding,signal())).rejects.toThrow();
 const other=join(dir,'other');mkdirSync(other);writeFileSync(join(other,'.session-id'),randomUUID());await expect(readDeliveredFile(other,a.id)).rejects.toThrow();
});
it('live trusted session publication and neutral denial; idle/stale calls cannot read',async()=>{
 const {s}=await live();let copies=0;
 const copy=async(b:any)=>{copies++;return {id:randomUUID(),name:'x',mimeType:'text/plain',size:1,sha256:'x',...b};};
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),copy,policy)).rejects.toThrow();expect(copies).toBe(0);
 const {task}=await running(s);
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),copy,{...policy,approval:'deny'})).rejects.toThrow();expect(copies).toBe(0);
 const a=await s.sendFileToChat({path:'deliverables/x'},signal(),copy,policy);
 expect(a.acpSessionId).toBe(s.snapshot().sessionId);expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(1);
 await s.interrupt();await task;
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),copy,policy)).rejects.toThrow();expect(copies).toBe(1);
});
it('cancel during copy blocks publication, concurrent export fails, and failed copy never retries',async()=>{
 const {s}=await live();const {task}=await running(s);let resolveCopy!:(v:any)=>void,started!:(v:void)=>void;const began=new Promise<void>(r=>started=r);let copies=0;
 const pending=s.sendFileToChat({path:'deliverables/x'},signal(),async b=>{copies++;started();return new Promise(r=>{resolveCopy=v=>r({...v,...b});});},policy);
 await began;
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),async()=>{throw Error('unexpected');},policy)).rejects.toThrow('FILE_DELIVERY_BUSY');
 await s.interrupt();await task;resolveCopy({id:randomUUID(),name:'x',mimeType:'text/plain',size:1,sha256:'x'});
 await expect(pending).rejects.toThrow();expect(copies).toBe(1);expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(0);
 const next=await running(s);
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),async()=>{copies++;throw Error('copy failed');},policy)).rejects.toThrow('copy failed');expect(copies).toBe(2);
 await s.interrupt();await next.task;
});
it('neutral ask uses a single human decision before copy; manual approval, then unattended denial',async()=>{
 const {s}=await live();const {task}=await running(s);let copies=0;const copy=async(b:any)=>{copies++;return {id:randomUUID(),name:'x',mimeType:'text/plain',size:1,sha256:'x',...b};};
 s.setControllerAttached(true);
 const pending=s.sendFileToChat({path:'deliverables/x'},signal(),copy,{...policy,approval:'ask'});
 for(let i=0;i<100&&!s.conversationPage({}).events.some(e=>e.kind==='permission.requested');i++)await new Promise(r=>setTimeout(r,5));
 const permission=s.conversationPage({}).events.find(e=>e.kind==='permission.requested')!;expect(copies).toBe(0);expect(s.respondPermission(permission.permissionId!, 'send')).toBe(true);await pending;expect(copies).toBe(1);
 s.setControllerAttached(false);
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),copy,{...policy,approval:'ask'})).rejects.toThrow('FILE_SEND_DENIED');expect(copies).toBe(1);
 await s.interrupt();await task;
});

it('injected steering revokes both later sends and publication of a copy already in progress',async()=>{
 const {s}=await live();const {task}=await running(s);let finish!:(v:any)=>void,started!:()=>void;const began=new Promise<void>(r=>started=r);let copies=0;
 const pending=s.sendFileToChat({path:'deliverables/x'},signal(),async b=>{copies++;started();return new Promise(r=>finish=v=>r({...v,...b}));},policy);
 await began;const steered=await (await s.queuePrompt('steering',{steer:true})).completion;expect(steered.detail).toBe('injected');
 finish({id:randomUUID(),name:'x',mimeType:'text/plain',size:1,sha256:'x'});await expect(pending).rejects.toThrow('CURRENT_CHAT_DELIVERY_UNAVAILABLE');
 await expect(s.sendFileToChat({path:'deliverables/x'},signal(),async()=>{copies++;throw Error('unexpected');},policy)).rejects.toThrow('CURRENT_CHAT_DELIVERY_UNAVAILABLE');
 expect(copies).toBe(1);expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(0);await s.interrupt();await task;
 const next=await running(s);await s.sendFileToChat({path:'deliverables/x'},signal(),async b=>({id:randomUUID(),name:'x',mimeType:'text/plain',size:1,sha256:'x',...b}),policy);await s.interrupt();await next.task;
});

it('metadata sync failure returns failure without a receipt, publication or automatic second attempt',async()=>{
 const {dir,s}=await live();process.env.OURS_FLEET_HOME=dir;mkdirSync(join(dir,'.ours-fleet'));writeFileSync(join(dir,'.session-id'),randomUUID());
 const store=new ArtifactStore(dir);const {task}=await running(s);let attempts=0,metadataSyncs=0;
 const original=fs.fsyncSync;const sync=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{
  if(fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('.json')){metadataSyncs++;throw Error('injected metadata fsync failure');}
  return original(fd);
 });
 try{
  await expect(s.sendFileToChat({path:'deliverables/x'},signal(),async b=>{
   attempts++;return store.copy({size:3,body:new Blob(['abc']).stream(),close:async()=>{}},'x','text/plain',b,signal());
  },policy)).rejects.toThrow('injected metadata fsync failure');
  expect(metadataSyncs).toBe(1);expect(attempts).toBe(1);
  expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(0);
 }finally{sync.mockRestore();await s.interrupt();await task;}
});

it.each(['private-file-delivery','state root'])('%s directory sync failure prevents first attachment publication',async level=>{
 const {dir,s}=await live();process.env.OURS_FLEET_HOME=dir;const stateRoot=join(dir,'.ours-fleet');mkdirSync(stateRoot,{mode:0o700});writeFileSync(join(dir,'.session-id'),randomUUID());
 const store=new ArtifactStore(dir);const {task}=await running(s);let attempts=0,parentSyncs=0;
 const probe=await openDirectory(dir);const prototype=Object.getPrototypeOf(probe);const original=prototype.sync;await probe.close();
 const target=level==='state root'?stateRoot:join(stateRoot,'private-file-delivery');
 const sync=vi.spyOn(prototype,'sync').mockImplementation(function(this:any){
  if(fs.readlinkSync(`/proc/self/fd/${this.fd}`)===target){parentSyncs++;return Promise.reject(Error('injected parent directory fsync failure'));}
  return original.call(this);
 });
 try{
  await expect(s.sendFileToChat({path:'deliverables/x'},signal(),async b=>{
   attempts++;return store.copy({size:3,body:new Blob(['abc']).stream(),close:async()=>{}},'x','text/plain',b,signal());
  },policy)).rejects.toThrow('injected parent directory fsync failure');
  expect(parentSyncs).toBe(1);expect(attempts).toBe(1);
  expect(s.conversationPage({}).events.filter(e=>e.kind==='file.attached')).toHaveLength(0);
 }finally{sync.mockRestore();await s.interrupt();await task;}
});
