import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildWebServer } from '../../src/web/server.js';
import { RoleRepository } from '../../src/application/role-repository.js';
import { FleetQueryService } from '../../src/application/fleet-query-service.js';
import { createTask, listTasks, tasksDir } from '../../src/rooms-tasks/task-state.js';
import { writeV2Fixture } from '../v2-fixture.js';

const clean: Array<()=>void> = [];
afterEach(()=>{ for (const fn of clean.splice(0).reverse()) fn(); });

it.each(['roles','tasks'] as const)('ordinary %s REST retains healthy rows while a corrupt entry explicitly fails bound SSE', async resource => {
  mkdirSync('.test-artifacts',{recursive:true});
  const root=resolve(mkdtempSync('.test-artifacts/resource-list-compat-'));
  const previous=process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME=root;
  clean.push(()=>{if(previous===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=previous;rmSync(root,{recursive:true,force:true});});
  const config=join(root,'fleet.yaml');writeV2Fixture(config,'roles:\n  Healthy: { session: acp }\n');
  const temporaryRoot=join(root,'.ours-fleet','tmp');mkdirSync(join(temporaryRoot,'Broken'),{recursive:true});writeFileSync(join(temporaryRoot,'Broken','role.yaml'),'[invalid');
  const repository=new RoleRepository({configPath:config,temporaryRoot,probeBackend:async()=>({})});
  const query=new FleetQueryService({repository,supervisor:{id:'none',liveness:async()=>({state:'unknown',detail:'fixture'})} as any,control:async()=>({ok:false,error:'offline'}) as any});
  const valid=createTask({title:'Healthy task',origin:{type:'cli'},start:false});writeFileSync(join(tasksDir(),'corrupt.json'),'{invalid');
  const browser={id:'browser',absoluteExpiresAt:Date.now()+60000};
  const auth={shutdown(){},validateBoundary(){},authenticate(){return browser;},sessionValid(){return true;},bindTransport(){return()=>{};}};
  const web=await buildWebServer({query,repository,taskRooms:{listTasks,withLayoutRooms:(task:unknown)=>task,listTaskLists:()=>[]},resourceScope:{paths:[root],roots:[]}} as any,{origin:'http://127.0.0.1',host:'127.0.0.1'},{auth:auth as any});
  const address=await web.app.listen({host:'127.0.0.1',port:0});
  const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    const response=await fetch(address+'/api/v1/resource-events',{signal:abort.signal});reader=response.body!.getReader();let text='';const decoder=new TextDecoder();
    const until=async(predicate:(text:string)=>boolean)=>{while(!predicate(text)){const next=await reader!.read();if(next.done)throw Error('unexpected stream close');text+=decoder.decode(next.value,{stream:true});}};
    await until(text=>text.includes('resource-connection'));
    const connection=JSON.parse(text.split('data: ')[1].split('\n')[0]);
    const registered=await fetch(address+'/api/v1/resource-subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:connection.connectionId,viewId:resource,subscriptionEpoch:1,descriptor:{viewId:resource,resource,...(resource==='roles'?{includeTemporary:true}:{})}})});
    expect(registered.status).toBe(200);const binding=await registered.json() as any;
    await until(text=>text.includes('projection_unavailable'));
    expect(text).not.toContain('"kind":"snapshot"');expect(text).not.toContain('"kind":"ready"');expect(text).not.toContain('"kind":"delete"');
    const bound=await fetch(address+'/api/v1/'+resource,{headers:{'X-Resource-Connection':connection.connectionId,'X-Resource-View':resource,'X-Resource-Epoch':'1','X-Resource-Baseline':binding.baselineId}});
    expect(bound.status).toBeGreaterThanOrEqual(400);
    const ordinary=await fetch(address+'/api/v1/'+resource+(resource==='roles'?'?includeTemporary=true':''));
    expect(ordinary.status).toBe(200);const payload=await ordinary.json() as any;
    if(resource==='roles') {expect(payload.roles.some((row:any)=>row.role.id==='Healthy')).toBe(true);expect(payload.roles.find((row:any)=>row.role.id==='Broken').role.stateHealth).toBe('corrupt');}
    else expect(payload.tasks.map((task:any)=>task.task_id)).toContain(valid.task_id);
  } finally {abort.abort();await reader?.cancel().catch(()=>{});await web.close();}
});
