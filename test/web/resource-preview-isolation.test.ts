import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebServer } from '../../src/web/server.js';
import { publishFleetResourceCommit } from '../../src/application/resource-observer.js';

it.each(['malformed complete', 'older partial'])('isolates a %s preview and delivers healthy updates and repair on the same subscription', async corruption => {
  const root=mkdtempSync(join(tmpdir(),'preview-isolation-'));
  const dirs=Object.fromEntries(['A','B'].map(id=>[id,join(root,id)]));
  for(const dir of Object.values(dirs))mkdirSync(join(dir,'.conversation'),{recursive:true});
  const file=(id:string)=>join(dirs[id],'.conversation','events-000001.jsonl');
  const record=(text:string,seq:number)=>JSON.stringify({schemaVersion:1,seq,at:String(seq),kind:'message.replace',messageId:String(seq),payload:{role:'assistant',content:{type:'text',text}}})+'\n';
  writeFileSync(file('A'),record('A initial',1));
  writeFileSync(file('B'),corruption==='malformed complete'?'{broken}\n':'{"partial":');
  if(corruption==='older partial')writeFileSync(join(dirs.B,'.conversation','events-000002.jsonl'),'');
  const browser={id:'browser',absoluteExpiresAt:Date.now()+60000};
  const auth={shutdown(){},validateBoundary(){},authenticate(){return browser;},sessionValid(){return true;},bindTransport(){return()=>{};}};
  const web=await buildWebServer({repository:{list:async()=>[{id:'A'},{id:'B'}],stateDir:(role:{id:string})=>dirs[role.id]},resourceScope:{paths:[root],roots:[root],watch:()=>Object.assign(new EventEmitter(),{close(){}})}} as any,{origin:'http://127.0.0.1',host:'127.0.0.1'},{auth:auth as any});
  const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    const address=await web.app.listen({host:'127.0.0.1',port:0});
    reader=(await fetch(address+'/api/v1/resource-events',{signal:abort.signal})).body!.getReader();
    let text='';const decoder=new TextDecoder();
    const frames=()=>text.split('\n\n').filter(block=>block.startsWith('event: resource\n')).map(block=>JSON.parse(block.split('data: ')[1]));
    const until=async(predicate:()=>boolean)=>{while(!predicate()){const next=await reader!.read();if(next.done)throw Error('unexpected close');text+=decoder.decode(next.value,{stream:true});}};
    await until(()=>text.includes('resource-connection'));
    const connection=JSON.parse(text.split('data: ')[1].split('\n')[0]);
    const register=await fetch(address+'/api/v1/resource-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:connection.connectionId,viewId:'previews',subscriptionEpoch:1,descriptor:{viewId:'previews',resource:'previews',ids:['A','B']}})});
    expect(register.status).toBe(200);const binding=await register.json() as any;
    await until(()=>frames().some(frame=>['ready','resync'].includes(frame.kind)));
    expect(frames().some(frame=>frame.kind==='resync')).toBe(false);
    const expected={A:{text:'A initial',at:'1'},B:{text:'Preview unavailable',at:'',unavailable:true}};
    expect(frames().find(frame=>frame.kind==='snapshot').payload).toEqual({previews:expected});
    const baseline=await fetch(address+'/api/v1/previews?ids=A,B',{headers:{'X-Resource-Connection':connection.connectionId,'X-Resource-View':'previews','X-Resource-Epoch':'1','X-Resource-Baseline':binding.baselineId}});
    expect(baseline.status).toBe(200);expect(await baseline.json()).toMatchObject({previews:expected});
    writeFileSync(file('A'),record('A updated',2));publishFleetResourceCommit(file('A'));
    await until(()=>frames().some(frame=>frame.payload?.previews?.A?.text==='A updated'));
    expect(frames().filter(frame=>frame.kind==='snapshot').at(-1).payload.previews.B).toEqual(expected.B);
    writeFileSync(file('B'),record('B repaired',3));publishFleetResourceCommit(file('B'));
    await until(()=>frames().some(frame=>frame.payload?.previews?.B?.text==='B repaired'));
    expect(frames().filter(frame=>frame.kind==='snapshot').at(-1).payload).toEqual({previews:{A:{text:'A updated',at:'2'},B:{text:'B repaired',at:'3'}}});
    expect(frames().filter(frame=>['resync','delete'].includes(frame.kind))).toEqual([]);
    expect(frames().every(frame=>frame.subscriptionEpoch===1)).toBe(true);
  } finally {abort.abort();await reader?.cancel().catch(()=>{});await web.close();rmSync(root,{recursive:true,force:true});}
});
