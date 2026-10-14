import {buildWebServer} from '../src/web/server.js';
import {WebAuth} from '../src/web/auth.js';
import {TrustedDeviceStore} from '../src/web/device-store.js';
import {TaskRoomApplicationService} from '../src/application/task-room-service.js';
import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTask,getTask,updateTaskBrief} from '../src/rooms-tasks/task-state.js';
import {writeV2Fixture} from './v2-fixture.js';
import {ConversationEventStore} from '../src/session/conversation-store.js';
import {appendTaskCreated} from '../src/session/task-notice.js';
it('persists only selected task description, allows empty/retry and rejects conflicting edits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-description-'));const previous=process.env.OURS_FLEET_HOME;
 try{
  process.env.OURS_FLEET_HOME=dir;writeV2Fixture(join(dir,'fleet.yaml'),{});
  const task=createTask({title:'Edit',brief:'Before',origin:{type:'cli'},start:false});
  const other=createTask({title:'Other',brief:'Untouched',origin:{type:'cli'},start:false});
  updateTaskBrief(task.task_id,'First\nSecond','Before');
  expect(getTask(task.task_id)).toEqual({...task,brief:'First\nSecond'});
  expect(getTask(other.task_id)).toEqual(other);
  expect(()=>updateTaskBrief(task.task_id,'Lost update','Before')).toThrow(/changed elsewhere/);
  updateTaskBrief(task.task_id,'First\nSecond','Before');
  updateTaskBrief(task.task_id,'','First\nSecond');expect(getTask(task.task_id).brief).toBe('');
  expect(()=>updateTaskBrief('../bad','text','')).toThrow(/invalid task ID/);
 }finally{if(previous===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=previous;rmSync(dir,{recursive:true,force:true});}
});
it('durably deduplicates task-created receipt and retains original prompt/session binding',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-notice-'));
 try{
  const binding={sessionGeneration:'generation',acpSessionId:'session',promptId:'prompt'};
  const notice={operationId:'operation',taskId:'0mul7vkrx8f79074b',title:'Created',state:'backlog'};
  const store=new ConversationEventStore(dir,{roleId:'fixture'});appendTaskCreated(store,binding,notice);store.close();
  const resumed=new ConversationEventStore(dir,{roleId:'fixture'});appendTaskCreated(resumed,{...binding,promptId:'different'},notice);
  expect(resumed.page({}).events).toEqual([expect.objectContaining({...binding,kind:'fleet.task_created',source:'fleet_lifecycle',payload:notice})]);resumed.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('authenticates description writes and reloads persisted metadata through HTTP',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-description-http-'));const previous=process.env.OURS_FLEET_HOME;
 let server:Awaited<ReturnType<typeof buildWebServer>>|undefined;
 try{
  process.env.OURS_FLEET_HOME=dir;writeV2Fixture(join(dir,'fleet.yaml'),{});
  const task=createTask({title:'HTTP edit',brief:'Before',origin:{type:'cli'},start:false});
  const boundary={origin:'http://127.0.0.1:49271',host:'127.0.0.1:49271'};
  const auth=new WebAuth(boundary.origin,boundary.host,Date.now,new TrustedDeviceStore(join(dir,'auth')));
  server=await buildWebServer({taskRooms:new TaskRoomApplicationService(undefined)} as any,boundary,{auth});
  const exchange=await server.app.inject({method:'POST',url:'/api/v1/auth/exchange',headers:{host:boundary.host,origin:boundary.origin,authorization:`Bootstrap ${server.auth.bootstrapSecret}`}});
  const cookie=([] as string[]).concat(exchange.headers['set-cookie']??[]).map(v=>v.split(';')[0]).join('; ');
  const headers={host:boundary.host,origin:boundary.origin,cookie,'x-csrf-token':exchange.json().csrfToken};
  const url=`/api/v1/tasks/${task.task_id}/description`,payload={brief:'Saved\nDescription',expectedBrief:'Before'};
  expect((await server.app.inject({method:'PATCH',url,headers:{host:boundary.host,origin:boundary.origin},payload})).statusCode).toBe(401);
  expect((await server.app.inject({method:'PATCH',url,headers,payload:{brief:4,expectedBrief:'Before'}})).statusCode).toBe(400);
  expect((await server.app.inject({method:'PATCH',url,headers,payload})).statusCode).toBe(200);
  expect((await server.app.inject({method:'GET',url:`/api/v1/tasks/${task.task_id}`,headers})).json().task).toEqual({...task,brief:payload.brief});
  expect((await server.app.inject({method:'PATCH',url,headers,payload:{brief:'Conflicting',expectedBrief:'Before'}})).statusCode).toBe(409);
 }finally{await server?.app.close();if(previous===undefined)delete process.env.OURS_FLEET_HOME;else process.env.OURS_FLEET_HOME=previous;rmSync(dir,{recursive:true,force:true});}
});
