import {afterEach,expect,it,vi} from 'vitest';
import {appendFileSync,mkdirSync,mkdtempSync,renameSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Count segment opens so a test can prove a preview was served without reading.
const opened=vi.hoisted(()=>({count:0}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:(async(...args:Parameters<typeof actual.open>)=>{opened.count++;return actual.open(...args);}) as typeof actual.open};
});
const {conversationPreview}=await import('../src/application/conversation-history.js');

const clean:(()=>void)[]=[];
afterEach(()=>{vi.useRealTimers();while(clean.length)clean.pop()!();});
const live=()=>new AbortController().signal;
const message=(seq:number,messageId:string,text:string)=>JSON.stringify({schemaVersion:1,seq,at:String(seq),kind:'message.chunk',messageId,payload:{role:'assistant',content:{type:'text',text}}})+'\n';
const agent=()=>{
  const root=mkdtempSync(join(tmpdir(),'preview-cache-'));mkdirSync(join(root,'.conversation'));
  clean.push(()=>rmSync(root,{recursive:true,force:true}));
  return {root,segment:(n:number)=>join(root,'.conversation',`events-00000${n}.jsonl`)};
};
// Reads happen well after the ledger last changed, as for an idle agent. Only
// Date is faked; file times stay real.
const idleReads=()=>{const now=Date.now();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now+5_000);};
// A later change must land in a later file-time tick than the cached read.
const nextTick=()=>new Promise(resolve=>setTimeout(resolve,50));
const opensFor=async(root:string)=>{const before=opened.count;const preview=await conversationPreview(root,live());return {preview,opens:opened.count-before};};

it('serves an idle agent without reopening its segments, and re-reads it after an append',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','first answer'));
  idleReads();
  expect(await opensFor(root)).toEqual({preview:{text:'first answer',at:'1'},opens:1});
  expect(await opensFor(root)).toEqual({preview:{text:'first answer',at:'1'},opens:0});
  await nextTick();
  appendFileSync(segment(1),message(2,'b','second answer'));
  expect(await opensFor(root)).toEqual({preview:{text:'second answer',at:'2'},opens:1});
});

it('does not cache a preview read within the racy window of the last change',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','alpha'));
  expect((await opensFor(root)).opens).toBe(1);
  expect((await opensFor(root)).opens).toBe(1);
  // A same-size rewrite in the same file-time tick leaves size, mtime, ctime
  // and inode unchanged; it must still be seen.
  writeFileSync(segment(1),message(1,'a','omega'));
  expect((await conversationPreview(root,live())).text).toBe('omega');
});

it('re-reads after rotation to a new segment',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','before rotation'));
  idleReads();
  expect((await conversationPreview(root,live())).text).toBe('before rotation');
  writeFileSync(segment(2),message(2,'b','after rotation'));
  expect(await conversationPreview(root,live())).toEqual({text:'after rotation',at:'2'});
});

it('re-reads a same-size rewrite even when mtime is restored',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','alpha'));
  idleReads();
  expect((await conversationPreview(root,live())).text).toBe('alpha');
  const before=statSync(segment(1));
  await nextTick();
  writeFileSync(segment(1),message(1,'a','omega'));
  utimesSync(segment(1),before.atime,before.mtime);
  expect(statSync(segment(1)).size).toBe(before.size);
  expect((await conversationPreview(root,live())).text).toBe('omega');
});

it('re-reads an atomically replaced segment with the same size and mtime',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','alpha'));
  idleReads();
  expect((await conversationPreview(root,live())).text).toBe('alpha');
  const before=statSync(segment(1));
  const replacement=join(root,'.conversation','replacement.tmp');
  writeFileSync(replacement,message(1,'a','omega'));utimesSync(replacement,before.atime,before.mtime);
  renameSync(replacement,segment(1));
  expect((await conversationPreview(root,live())).text).toBe('omega');
});

it('tracks an older segment the preview consulted, not only the newest',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','from the older segment'));
  writeFileSync(segment(2),JSON.stringify({schemaVersion:1,seq:2,at:'2',kind:'turn.completed',payload:{}})+'\n');
  idleReads();
  expect(await opensFor(root)).toEqual({preview:{text:'from the older segment',at:'1'},opens:2});
  expect((await opensFor(root)).opens).toBe(0);
  await nextTick();
  writeFileSync(segment(1),message(1,'a','older segment repaired'));
  expect((await conversationPreview(root,live())).text).toBe('older segment repaired');
  rmSync(segment(1));
  expect(await conversationPreview(root,live())).toEqual({text:'No recent agent output',at:''});
});

it('does not cache failures, and keeps partial-newest and malformed-completed behavior',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','committed'));
  writeFileSync(segment(2),'{"partial":');
  idleReads();
  // The in-flight newest append is not committed yet.
  expect((await conversationPreview(root,live())).text).toBe('committed');
  await nextTick();
  // A completed malformed record still fails, every time.
  writeFileSync(segment(2),'{"malformed":\n');
  await expect(conversationPreview(root,live())).rejects.toThrow();
  await expect(conversationPreview(root,live())).rejects.toThrow();
  writeFileSync(segment(2),message(2,'b','repaired'));
  expect((await conversationPreview(root,live())).text).toBe('repaired');
});

it('honors each caller abort signal on a cached preview',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','cached'));
  idleReads();
  expect((await conversationPreview(root,live())).text).toBe('cached');
  const aborted=new AbortController();aborted.abort();
  await expect(conversationPreview(root,aborted.signal)).rejects.toThrow();
  expect(await opensFor(root)).toEqual({preview:{text:'cached',at:'1'},opens:0});
});

it('keeps agents isolated and serves concurrent callers fresh previews',async()=>{
  const first=agent(),second=agent();
  writeFileSync(first.segment(1),message(1,'a','first agent'));
  writeFileSync(second.segment(1),message(1,'a','second agent'));
  idleReads();
  const results=await Promise.all([first.root,second.root,first.root,second.root].map(root=>conversationPreview(root,live())));
  expect(results.map(r=>r.text)).toEqual(['first agent','second agent','first agent','second agent']);
  await nextTick();
  appendFileSync(first.segment(1),message(2,'b','first agent again'));
  const again=await Promise.all([first.root,second.root,first.root].map(root=>conversationPreview(root,live())));
  expect(again.map(r=>r.text)).toEqual(['first agent again','second agent','first agent again']);
  // Opens are counted one caller at a time: the unchanged agent is still cached.
  expect(await opensFor(second.root)).toEqual({preview:{text:'second agent',at:'1'},opens:0});
});

it('forgets an agent whose ledger directory disappears',async()=>{
  const {root,segment}=agent();
  writeFileSync(segment(1),message(1,'a','present'));
  idleReads();
  expect((await conversationPreview(root,live())).text).toBe('present');
  rmSync(join(root,'.conversation'),{recursive:true,force:true});
  expect(await conversationPreview(root,live())).toEqual({text:'No recent agent output',at:''});
  mkdirSync(join(root,'.conversation'));writeFileSync(segment(1),message(1,'a','recreated'));
  expect((await conversationPreview(root,live())).text).toBe('recreated');
});
