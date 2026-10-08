import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pinExportRoot, openExportFile, openDirectory, MAX_FILE_BYTES } from '../src/file-delivery/reader.js';
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
it('safe reader enforces original cwd paths, symlink/hardlink/hidden/traversal boundaries and pinned root',async()=>{
 const dir=temp(),root=join(dir,'deliverables');mkdirSync(root,{mode:0o700});writeFileSync(join(root,'file.bin'),'abc');writeFileSync(join(dir,'file.bin'),'different');
 const pin=await pinExportRoot(root);
 try{
  for(const p of ['deliverables/file.bin',join(root,'file.bin')]){const f=await openExportFile(pin.root,dir,p);expect(await f.readFile()).toEqual(Buffer.from('abc'));await f.close();}
  symlinkSync(join(dir,'file.bin'),join(root,'link'));linkSync(join(root,'file.bin'),join(root,'hard'));
  for(const p of ['file.bin','deliverables/link','deliverables/hard','deliverables/../file.bin','deliverables/.secret'])await expect(openExportFile(pin.root,dir,p)).rejects.toThrow();
  renameSync(root,join(dir,'moved'));mkdirSync(root,{mode:0o700});writeFileSync(join(root,'file.bin'),'replacement');
  await expect(openExportFile(pin.root,dir,'deliverables/file.bin')).rejects.toThrow('EXPORT_ROOT_CHANGED');
 }finally{await pin.handle.close();}
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
