import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { WatchdogQueryService } from '../../src/watchdog/query.js';
import { writeReport } from '../../src/watchdog/store.js';
import { writeSchedulerState } from '../../src/watchdog/scheduler.js';
import type { WatchdogReport } from '../../src/watchdog/report.js';
import type { FleetConfig } from '../../src/config.js';
import type { ResolvedWatchdog } from '../../src/watchdog/config.js';

const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };

async function testServer(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-web-server-'));
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(dir));
  const isolatedServices = { ...services(), ...overrides };
  isolatedServices.audit = new AuditSink(join(dir, 'audit'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Fleet</title>');
  return buildWebServer(isolatedServices, boundary, { auth, staticRoot: dir });
}

function services() {
  const role = {
    id: 'Alpha', lifetime: 'permanent', configured: true, stateHealth: 'present',
    configuredBackend: 'acp', detectedBackend: 'acp',
    compatibility: { compatible: true }, problems: [],
  };
  const status = {
    roleId: 'Alpha', observedAt: new Date().toISOString(), overall: 'ready',
    supervisor: { backend: 'none', liveness: 'running', detail: 'running' },
    session: { backend: 'acp', reachability: 'online', readiness: 'idle', evidence: 'inferred' },
    restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
    monitor: { mode: 'unknown', health: 'unknown', stale: true },
    isolation: { degraded: false }, problems: [],
  };
  return {
    query: {
      async list() { return [{ role, status, capabilities: {} }]; },
      async detail() { return { role, status, capabilities: {} }; },
    },
    repository: { async get() { return role; } },
    async session() {
      return {
        async describe() { return { backend: 'acp', protocolVersion: 1, features: [] }; },
        async snapshot() { return { backend: 'acp', alive: true, readiness: 'idle' }; },
        async recentOutput() { return { events: [], text: 'safe', truncated: false }; },
        async sendText() {
          return {
            accepted: true, promptId: 'p', queuedBehind: 0,
            terminalOutcomeKnown: false, detail: 'sent',
          };
        },
      };
    },
    logs: { source: () => ({ tail: async () => ({ records: [], truncated: false }) }) },
    commands: {
      async execute() { return { actionId: 'a', state: 'accepted' }; },
      get() { return undefined; },
    },
    creation: {
      async capabilities() {
        return {
          available: false, reasons: ['fixture'], harnesses: [], lifetimes: [],
          identityBootstrap: {
            mode: 'current-fleet-first-boot', existingIdentity: 'unknown',
            bindingEvidence: 'not-structured', warnings: [],
          },
          safePermissionSchemaVersion: 1,
        };
      },
      async preview(body: unknown) { return { request: body, previewHash: 'hash' }; },
      async create() { return { actionId: 'c', roleId: 'A', state: 'validating' }; },
      get() { return undefined; },
    },
  } as any;
}

async function authenticated(overrides: Record<string, unknown> = {}) {
  const server = await testServer(overrides);
  const exchange = await server.app.inject({
    method: 'POST', url: '/api/v1/auth/exchange',
    headers: {
      host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
      authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
    },
  });
  const cookies = ([] as string[]).concat(exchange.headers['set-cookie'] ?? [])
    .map(value => value.split(';')[0]);
  const cookie = cookies.join('; ');
  const csrf = exchange.json().csrfToken as string;
  return { server, cookie, cookies, csrf };
}

describe('secure local web host', () => {
  it('uploads actual files for the selected generation and expands verified IDs on input', async () => {
    const dir=mkdtempSync(join(tmpdir(),'fleet-upload-route-'));const calls:any[]=[];let generation='g1';
    const control={conversationPage:async()=>({snapshot:{sessionGeneration:generation}}),submitPromptV2:async(input:any)=>{calls.push(input);return {state:'starting',promptId:'p'};}};
    const {server,cookie,csrf}=await authenticated({repository:{get:async(id:string)=>id==='Alpha'?{id}:undefined,stateDir:()=>dir},session:async()=>control});
    const headers={host:boundary.host,cookie,origin:boundary.origin,'x-csrf-token':csrf};
    const payload={name:'photo.png',mimeType:'image/png',data:Buffer.from([137,80,78,71,0,1,255]).toString('base64'),expectedSessionGeneration:'g1'};
    try {
      const denied=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/attachments',headers:{host:boundary.host,cookie,origin:boundary.origin},payload});expect(denied.statusCode).toBe(403);
      const upload=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/attachments',headers,payload});expect(upload.statusCode).toBe(200);const id=upload.json().id;
      const contentUrl='/api/v1/roles/Alpha/attachments/'+id;
      const anonymous=await server.app.inject({method:'GET',url:contentUrl,headers:{host:boundary.host}});expect(anonymous.statusCode).toBe(401);
      const content=await server.app.inject({method:'GET',url:contentUrl,headers});expect(content.statusCode).toBe(200);expect(content.rawPayload).toEqual(Buffer.from(payload.data,'base64'));expect(content.headers['x-content-type-options']).toBe('nosniff');expect(content.headers['cache-control']).toBe('private, no-store');expect(content.headers['content-disposition']).toContain('inline');
      const absent=await server.app.inject({method:'GET',url:contentUrl.replace(id,'0'.repeat(64)),headers});expect(absent.statusCode).toBe(404);
      const otherRole=await server.app.inject({method:'GET',url:contentUrl.replace('Alpha','Missing'),headers});expect(otherRole.statusCode).toBe(404);
      const retry=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/attachments',headers,payload});expect(retry.json().id).toBe(id);
      const body={text:'',commandId:'once',expectedSessionGeneration:'g1',attachments:[id]};
      const sent=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/input',headers,payload:body});expect(sent.statusCode).toBe(202);
      const prompt=calls[0].text;const files=JSON.parse(prompt.slice(prompt.indexOf('[\n')));expect(readFileSync(files[0].path)).toEqual(Buffer.from(payload.data,'base64'));expect(calls[0].expectedSessionGeneration).toBe('g1');
      await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/input',headers,payload:body});expect(calls[1]).toEqual(calls[0]);
      const malformed=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/input',headers,payload:{...body,attachments:['../private']}});expect(malformed.statusCode).toBe(400);expect(calls).toHaveLength(2);
      generation='g2';const stale=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/attachments',headers,payload});expect(stale.statusCode).toBe(409);
      const wrong=await server.app.inject({method:'POST',url:'/api/v1/roles/Missing/attachments',headers,payload});expect(wrong.statusCode).toBe(404);
    }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('creates layout tasks without legacy provisioning and routes layout room operations', async () => {
    const task={task_id:'selected',state:'active',layout:{name:'work',run_id:'task-selected',definition_hash:'h'}};
    const taskRooms={
      createTask:vi.fn().mockResolvedValue(task),launchTaskProvisioning:vi.fn(),
      taskLayout:vi.fn().mockReturnValue({name:'work',rooms:[{key:'design',state:'declared'}]}),
      launchTaskLayoutOperation:vi.fn().mockResolvedValue({operation:'open',room:'design',status:'launching'}),
      retryTaskLayoutCleanup:vi.fn().mockResolvedValue({operation:'close',status:'launching'}),
      setTaskLayout:vi.fn().mockResolvedValue({...task,state:'backlog'}),withLayoutRooms:vi.fn((t:unknown)=>t),
    };
    const presetProvenance={read:vi.fn().mockReturnValue({role:{Developer:{status:'predefined',preset:'mission: Build\n'}},brain:{},template:{},layout:{}})};
    const roomLayouts={list:vi.fn().mockReturnValue([{name:'work'}]),defaultLayout:vi.fn().mockReturnValue('work'),validate:vi.fn().mockReturnValue({issues:[]}),
      save:vi.fn().mockResolvedValue({name:'work',revision:'r2'}),remove:vi.fn().mockResolvedValue({name:'work',deleted:true})};
    const {server,cookie,csrf}=await authenticated({taskRooms,roomLayouts,presetProvenance});
    const headers={host:boundary.host,cookie,origin:boundary.origin,'x-csrf-token':csrf};
    try {
      const created=await server.app.inject({method:'POST',url:'/api/v1/tasks',headers,payload:{title:'Ship',layout:'work'}});
      expect(created.statusCode).toBe(201);expect(created.json()).toEqual({task});
      expect(taskRooms.createTask).toHaveBeenCalledWith(expect.objectContaining({layout:'work',title:'Ship'}));
      expect(taskRooms.launchTaskProvisioning).not.toHaveBeenCalled();
      // Every task needs a saved layout; room templates and inline room plans are refused before the service.
      for (const payload of [{title:'Ship'},{title:'Ship',layout:''},{title:'Ship',layout:'work',template:'pair'},{title:'Ship',layout:'work',noRoom:true}])
        expect((await server.app.inject({method:'POST',url:'/api/v1/tasks',headers,payload})).statusCode).toBe(400);
      expect(taskRooms.createTask).toHaveBeenCalledTimes(1);
      expect((await server.app.inject({method:'GET',url:'/api/v1/tasks/selected/layout',headers})).json()).toEqual({layout:{name:'work',rooms:[{key:'design',state:'declared'}]}});
      const open=await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/layout/rooms/design/open',headers});
      expect(open.statusCode).toBe(202);
      expect(taskRooms.launchTaskLayoutOperation).toHaveBeenCalledWith(expect.objectContaining({taskId:'selected',room:'design',operation:'open'}));
      await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/layout/rooms/design/close',headers});
      expect(taskRooms.launchTaskLayoutOperation).toHaveBeenLastCalledWith(expect.objectContaining({operation:'close-room'}));
      expect((await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/layout/cleanup',headers})).statusCode).toBe(202);
      expect((await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/layout/rooms/design/open',headers:{host:boundary.host,cookie}})).statusCode).toBe(403);
      const chosen=await server.app.inject({method:'PATCH',url:'/api/v1/tasks/selected/layout',headers,payload:{layout:'work',expectedLayout:null}});
      expect(chosen.statusCode).toBe(200);expect(chosen.json().task.state).toBe('backlog');
      expect(taskRooms.setTaskLayout).toHaveBeenCalledWith(expect.objectContaining({taskId:'selected',layout:'work',expectedLayout:null}));
      for (const payload of [{layout:''},{layout:null,expectedLayout:'work'}])
        expect((await server.app.inject({method:'PATCH',url:'/api/v1/tasks/selected/layout',headers,payload})).statusCode).toBe(400);
      expect((await server.app.inject({method:'PATCH',url:'/api/v1/tasks/selected/layout',headers:{host:boundary.host,cookie},payload:{layout:null,expectedLayout:'work'}})).statusCode).toBe(403);
      expect(taskRooms.setTaskLayout).toHaveBeenCalledTimes(1);
      expect((await server.app.inject({method:'GET',url:'/api/v1/configuration/provenance',headers})).json().provenance.role.Developer.status).toBe('predefined');
      expect((await server.app.inject({method:'GET',url:'/api/v1/configuration/provenance',headers:{host:boundary.host}})).statusCode).toBe(401);
      expect((await server.app.inject({method:'GET',url:'/api/v1/room-layouts',headers})).json()).toEqual({layouts:[{name:'work'}],default_layout:'work'});
      const saved=await server.app.inject({method:'PUT',url:'/api/v1/room-layouts/work',headers,payload:{revision:'r1',definition:{version:1}}});
      expect(saved.json()).toEqual({name:'work',revision:'r2'});expect(roomLayouts.save).toHaveBeenCalledWith('work','r1',{version:1});
      expect((await server.app.inject({method:'PUT',url:'/api/v1/room-layouts/work',headers,payload:{definition:{}}})).statusCode).toBe(400);
      expect((await server.app.inject({method:'DELETE',url:'/api/v1/room-layouts/work?revision=r2',headers})).json()).toEqual({name:'work',deleted:true});
      expect((await server.app.inject({method:'DELETE',url:'/api/v1/room-layouts/work',headers})).statusCode).toBe(400);
    } finally {await server.close();}
  });
  it('authenticates and forwards selected-task member creation and receipt reads', async () => {
    const taskRooms={addMember:vi.fn().mockResolvedValue({state:'running',requestId:'request-1'}),memberAddition:vi.fn().mockResolvedValue({state:'succeeded'})};
    const {server,cookie,csrf}=await authenticated({taskRooms});
    const headers={host:boundary.host,cookie,origin:boundary.origin,'x-csrf-token':csrf};
    const payload={requestId:'request-1',slot:'Reviewer',role:'critic',brain:'codex',agentTemplate:'assistant'};
    try {
      expect((await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/members',headers,payload})).statusCode).toBe(202);
      expect(taskRooms.addMember).toHaveBeenCalledWith('selected',payload);
      expect((await server.app.inject({method:'GET',url:'/api/v1/tasks/selected/member-additions/request-1',headers})).json()).toEqual({state:'succeeded'});
      expect(taskRooms.memberAddition).toHaveBeenCalledWith('selected','request-1');
      expect((await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/members',headers:{host:boundary.host,cookie},payload})).statusCode).toBe(403);
      expect(taskRooms.addMember).toHaveBeenCalledTimes(1);
      const {MemberAdditionRejected}=await import('../../src/rooms-tasks/add-member.js');
      taskRooms.addMember.mockRejectedValueOnce(new MemberAdditionRejected('Slot exists'));
      const rejected=await server.app.inject({method:'POST',url:'/api/v1/tasks/selected/members',headers,payload});
      expect(rejected.statusCode).toBe(409);expect(rejected.json()).toMatchObject({accepted:false,error:{code:'member_not_accepted'}});
    } finally {await server.close();}
  });
  it('routes authenticated correspondence GETs to the selected supervisor without MCP',async()=>{
    const calls:unknown[]=[];const {server,cookie}=await authenticated({session:async(id:string)=>({agentContacts:async()=>{calls.push({id,operation:'contacts'});return {contacts:[{name:'Peer'}]};},agentHistory:async(query:unknown)=>{calls.push({id,query});return {items:[],next_cursor:null};}}),oursTools:{call:()=>{throw Error('must not call MCP');}}});
    try{const headers={host:boundary.host,cookie};expect((await server.app.inject({method:'GET',url:'/api/v1/roles/Selected/contacts',headers})).json()).toMatchObject({contacts:[{name:'Peer'}]});const peer='B'.repeat(64);expect((await server.app.inject({method:'GET',url:`/api/v1/roles/Selected/messages?peer_cid=${peer}&limit=10&before_seq=4`,headers})).statusCode).toBe(200);expect(calls).toEqual([{id:'Selected',operation:'contacts'},{id:'Selected',query:{peer_cid:peer,limit:10,before_seq:4}}]);expect((await server.app.inject({method:'GET',url:'/api/v1/roles/Selected/contacts',headers:{host:boundary.host}})).statusCode).toBe(401);}finally{await server.close();}
  });
  it('serves the login document on an external link without relaxing API fetch metadata', async () => {
    const { server } = await authenticated();
    const headers = { host: boundary.host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect((await server.app.inject({ method: 'GET', url: '/', headers })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/roles', headers })).statusCode).toBe(403);
    await server.close();
  });
  it('exposes authenticated task-list and assignment routes through the shared service', async () => {
    const task = { task_id: 'task-id', list_id: 'default', list_name: 'default' };
    const taskRooms = {
      listTaskLists: vi.fn(() => [{ list_id: 'default', name: 'default', built_in: true }]),
      createTaskList: vi.fn(async ({ name }) => ({ list_id: 'list-id', name, built_in: false })),
      renameTaskList: vi.fn(async ({ newName }) => ({ list_id: 'list-id', name: newName, built_in: false })),
      deleteTaskList: vi.fn(async () => ({ deleted: { name: 'Work' }, moved: 1 })),
      withLayoutRooms: vi.fn((t: unknown) => t), listTasks: vi.fn(() => [task]), groupedTasks: vi.fn(() => [{ list: { name: 'default' }, tasks: [task] }]),
      createTask: vi.fn(async () => task), moveTask: vi.fn(async () => task),
    };
    const { server, cookie, csrf } = await authenticated({ taskRooms });
    const readHeaders = { host: boundary.host, cookie };
    const writeHeaders = { ...readHeaders, origin: boundary.origin, 'x-csrf-token': csrf };
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/task-lists', headers: readHeaders })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/task-lists', headers: writeHeaders,
      payload: { name: 'Work' } })).statusCode).toBe(201);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/v1/task-lists/Work', headers: writeHeaders,
      payload: { name: 'Renamed' } })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'DELETE', url: '/api/v1/task-lists/Renamed?destination=default',
      headers: writeHeaders })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/tasks?list=default&groupByList=true',
      headers: readHeaders })).json()).toHaveProperty('groups');
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/tasks', headers: writeHeaders,
      payload: { title: 'Task', backlog: true, list: 'default', layout: 'single' } })).statusCode).toBe(201);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/v1/tasks/task-id/list', headers: writeHeaders,
      payload: { list: 'default' } })).statusCode).toBe(200);
    const rejected = await server.app.inject({ method: 'POST', url: '/api/v1/task-lists',
      headers: readHeaders, payload: { name: 'No CSRF' } });
    expect(rejected.statusCode).toBe(403);
    expect(taskRooms.moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-id', list: 'default' }));
    await server.close();
  });
  it('runs accepted task workers and distinguishes pending settlement from completion', async () => {
    const task = { task_id: 't', terminal_intent: { status: 'pending' } };
    let layout: object | undefined;
    const taskRooms = {
      getTask: vi.fn(() => ({ task: { task_id: 't', layout } })),
      startTask: vi.fn(async () => task),
      launchTaskProvisioning: vi.fn(async () => ({ kind: 'in_progress' })),
      finishTask: vi.fn(async () => ({ task, settlementRequired: true })),
      cancelTask: vi.fn(async () => ({ task: { task_id: 't', state: 'cancelled' }, settlementRequired: false })),
      launchTaskSettlement: vi.fn(async () => task),
    };
    const { server, cookie, csrf } = await authenticated({ taskRooms });
    const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf };
    const call = (action: string) => server.app.inject({ method: 'POST', url: `/api/v1/tasks/t/${action}`, headers, payload: {} });
    // Start is refused until the task has a layout.
    const unchosen = await call('start');
    expect(unchosen.statusCode).toBe(409); expect(unchosen.json().error.message).toMatch(/choose a room layout/);
    expect(taskRooms.startTask).not.toHaveBeenCalled();
    layout = { name: 'single', run_id: 'task-t', definition_hash: 'h' };
    expect((await call('start')).statusCode).toBe(202);
    expect(taskRooms.launchTaskProvisioning).toHaveBeenCalledWith('t');
    const finish = await call('finish');
    expect(finish.statusCode).toBe(202); expect(finish.json().pending).toBe(true);
    expect(taskRooms.launchTaskSettlement).toHaveBeenCalledOnce();
    const cancel = await call('cancel');
    expect(cancel.statusCode).toBe(200); expect(cancel.json().pending).toBe(false);
    expect(taskRooms.launchTaskSettlement).toHaveBeenCalledOnce();
    await server.close();
  });
  it('deletes tasks in any state with exact confirmation, bounded settlement, and mutation auth', async () => {
    const taskRooms = {
      withLayoutRooms: vi.fn((t: unknown) => t), listTasks: vi.fn(() => []),
      requestTaskDeletion: vi.fn(async () => ({ status: 'accepted', task: { task_id: 'task-id' } })),
      launchTaskDeletionWorker: vi.fn(async () => ({ deleted: true, pending: false })),
    };
    const { server, cookie, csrf } = await authenticated({ taskRooms });
    const readHeaders = { host: boundary.host, cookie };
    const writeHeaders = { ...readHeaders, origin: boundary.origin, 'x-csrf-token': csrf };

    // Confirmation is validated before existence or idempotency.
    const mismatch = await server.app.inject({
      method: 'DELETE', url: '/api/v1/tasks/task-id?confirm=other-id', headers: writeHeaders });
    expect(mismatch.statusCode).toBe(400);
    const missingConfirm = await server.app.inject({
      method: 'DELETE', url: '/api/v1/tasks/task-id', headers: writeHeaders });
    expect(missingConfirm.statusCode).toBe(400);
    expect(taskRooms.requestTaskDeletion).not.toHaveBeenCalled();

    // Mutation auth boundary: no CSRF token → rejected.
    const noCsrf = await server.app.inject({
      method: 'DELETE', url: '/api/v1/tasks/task-id?confirm=task-id', headers: readHeaders });
    expect(noCsrf.statusCode).toBe(403);
    expect(taskRooms.requestTaskDeletion).not.toHaveBeenCalled();

    // Settled within the bounded wait → 200, physical deletion reported.
    const settled = await server.app.inject({
      method: 'DELETE', url: '/api/v1/tasks/task-id?confirm=task-id', headers: writeHeaders });
    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toEqual({ task_id: 'task-id', deleted: true });

    // Still settling (slow worker/outage) → 202 pending with recovery action, never success.
    taskRooms.launchTaskDeletionWorker.mockResolvedValueOnce({
      deleted: false, pending: true, error: 'Cowork management socket is not reachable' });
    const pending = await server.app.inject({
      method: 'DELETE', url: '/api/v1/tasks/task-id?confirm=task-id', headers: writeHeaders });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toMatchObject({
      task_id: 'task-id', accepted: true, deletion: 'pending',
      error: 'Cowork management socket is not reachable' });
    expect(pending.json().recovery).toContain('DELETE /api/v1/tasks/task-id?confirm=task-id');

    // Concurrent settlement already removed the record → idempotent 200.
    taskRooms.requestTaskDeletion.mockResolvedValueOnce({ status: 'already_absent' });
    const absent = await server.app.inject({
      method: 'DELETE', url: '/api/v1/tasks/task-id?confirm=task-id', headers: writeHeaders });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ task_id: 'task-id', deleted: false, already_absent: true });

    // includeDeleting is opt-in, validated, and authenticated.
    const badFilter = await server.app.inject({
      method: 'GET', url: '/api/v1/tasks?includeDeleting=maybe', headers: readHeaders });
    expect(badFilter.statusCode).toBe(400);
    const withDeleting = await server.app.inject({
      method: 'GET', url: '/api/v1/tasks?includeDeleting=true', headers: readHeaders });
    expect(withDeleting.statusCode).toBe(200);
    expect(taskRooms.listTasks).toHaveBeenCalledWith(expect.objectContaining({ includeDeleting: true }));
    await server.close();
  });

  it('does not bridge browser device trust into owner-channel authorization management', async () => {
    const { server, cookie } = await authenticated();
    const response = await server.app.inject({
      method: 'GET', url: '/api/v1/owner-channel/owners',
      headers: { host: boundary.host, cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('delegates restart-resume target and mode through the REST action adapter', async () => {
    const execute = vi.fn(async () => ({ actionId: 'restart-action', roleId: 'Alpha',
      action: 'restart_resume', state: 'accepted' }));
    const { server, cookie, csrf } = await authenticated({ commands: { execute,
      get: vi.fn() } });
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/roles/Alpha/actions',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { action: 'restart_resume', actionId: 'restart-action' } });
    expect(response.statusCode).toBe(202);
    expect(execute).toHaveBeenCalledWith({ roleId: 'Alpha', action: 'restart_resume',
      actionId: 'restart-action', confirmation: undefined });
    await server.close();
  });
  it.each([false,true])('marks lifecycle rejection not accepted only without prior receipt (%s)', async prior => {
    const { server,cookie,csrf }=await authenticated({commands:{execute:vi.fn(async()=>{throw Error('validation refused');}),get:vi.fn(()=>prior?{actionId:'same-action',state:'running'}:undefined)}});
    const response=await server.app.inject({method:'POST',url:'/api/v1/roles/Alpha/actions',headers:{host:boundary.host,origin:boundary.origin,cookie,'x-csrf-token':csrf},payload:{action:'restart_resume',actionId:'same-action'}});
    if(prior)expect(response.json().accepted).toBeUndefined();
    else {expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({accepted:false,error:{code:'action_not_accepted'}});}
    await server.close();
  });
  it('does not register room or template query routes', async () => {
    const { server, cookie } = await authenticated();
    for (const url of ['/api/v1/rooms', '/api/v1/rooms/room-id', '/api/v1/templates']) {
      const response = await server.app.inject({ method: 'GET', url,
        headers: { cookie, host: boundary.host } });
      expect(response.statusCode).toBe(404);
    }
    const create = await server.app.inject({ method: 'POST', url: '/api/v1/rooms',
      headers: { cookie, host: boundary.host } });
    expect(create.statusCode).toBe(404);
    for (const url of ['/api/v1/rooms/room-id/delete', '/api/v1/rooms/room-id/recover']) {
      const response = await server.app.inject({ method: 'POST', url,
        headers: { cookie, host: boundary.host } });
      expect(response.statusCode).toBe(404);
    }
    await server.app.close();
  });
  it('accepts localhost and explains an unconfigured browser host as HTML', async () => {
    const server = await testServer();
    server.auth.setBoundary(boundary.origin, boundary.host, {
      hosts: ['localhost:49271'], origins: ['http://localhost:49271'],
    });
    const localhost = await server.app.inject({ method: 'GET', url: '/api/v1/auth/mode',
      headers: { host: 'localhost:49271' } });
    expect(localhost.statusCode).toBe(200);
    const wrong = await server.app.inject({ method: 'GET', url: '/',
      headers: { host: 'vps.invalid' } });
    expect(wrong.statusCode).toBe(421);
    expect(wrong.headers['content-type']).toContain('text/html');
    expect(wrong.body).toContain('not configured');
    expect(wrong.body).not.toContain('invalid Host header');
    await server.close();
  });

  it('requires exact Host and Origin for bootstrap and consumes the secret once', async () => {
    const server = await testServer();
    const wrong = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: {
        host: 'localhost:49271', origin: 'http://evil.invalid',
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    expect(wrong.statusCode).toBe(403);
    const good = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    expect(good.statusCode).toBe(200);
    const replay = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/exchange',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
        authorization: `Bootstrap ${server.auth.bootstrapSecret}`,
      },
    });
    expect(replay.statusCode).toBe(401);
    await server.close();
  });

  it('requires cookie, exact Origin, and CSRF on every mutation', async () => {
    const { server, cookie, csrf } = await authenticated();
    const read = await server.app.inject({
      method: 'GET', url: '/api/v1/roles',
      headers: { host: '127.0.0.1:49271', cookie },
    });
    expect(read.statusCode).toBe(200);
    const noCsrf = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271', cookie,
      },
      payload: { text: 'hello' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const crossOrigin = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://evil.invalid',
        cookie, 'x-csrf-token': csrf,
      },
      payload: { text: 'hello' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const good = await server.app.inject({
      method: 'POST', url: '/api/v1/roles/Alpha/input',
      headers: {
        host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
        cookie, 'x-csrf-token': csrf,
      },
      payload: { text: 'hello' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ accepted: true, terminalOutcomeKnown: false });
    await server.close();
  });

  it('sets strict browser headers and does not grant CORS', async () => {
    const { server, cookie } = await authenticated();
    const response = await server.app.inject({
      method: 'GET', url: '/api/v1/meta',
      headers: { host: '127.0.0.1:49271', cookie },
    });
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    await server.close();
  });

  it('exposes one authenticated contract for config read, preview, save, and topology', async () => {
    const calls: string[] = [];
    const configuration = {
      read() { calls.push('read'); return { firstRun: false, revision: 'r1', model: { roles: {} } }; },
      async preview(revision: string) { calls.push(`preview:${revision}`); return { valid: true, revision }; },
      async write(revision: string) { calls.push(`write:${revision}`); return { saved: true, newRevision: 'r2' }; },
    };
    const topology = async () => ({ nodes: [], edges: [], unknownLineage: [] });
    const { server, cookie, csrf } = await authenticated({ configuration, topology });
    const read = await server.app.inject({
      method: 'GET', url: '/api/v1/configuration', headers: { host: boundary.host, cookie },
    });
    expect(read.statusCode).toBe(200);
    const graph = await server.app.inject({
      method: 'GET', url: '/api/v1/topology', headers: { host: boundary.host, cookie },
    });
    expect(graph.json()).toEqual({ nodes: [], edges: [], unknownLineage: [] });
    const preview = await server.app.inject({
      method: 'POST', url: '/api/v1/configuration/preview',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { revision: 'r1', model: { roles: {} } },
    });
    expect(preview.statusCode).toBe(200);
    const save = await server.app.inject({
      method: 'POST', url: '/api/v1/configuration/save',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { revision: 'r1', model: { roles: {} } },
    });
    expect(save.json()).toMatchObject({ saved: true, newRevision: 'r2' });
    expect(calls).toEqual(['read', 'preview:r1', 'write:r1']);
    await server.close();
  });

  it('guards role removal with authentication, CSRF, exact path handling, and typed service input', async () => {
    const calls: unknown[] = [];
    const removal = {
      previewWeb(role: string) { calls.push(['preview', role]); return { role, confirmation: 'typed-role-name' }; },
      async removeWeb(input: unknown) { calls.push(['remove', input]); return { ...(input as object), removed: true, recoveryPath: '/archive' }; },
    };
    const { server, cookie, csrf } = await authenticated({ removal });
    const unauthenticated = await server.app.inject({ method: 'GET', url: '/api/v1/roles/Alpha/removal-preview', headers: { host: boundary.host } });
    expect(unauthenticated.statusCode).toBe(401);
    const traversal = await server.app.inject({ method: 'GET', url: '/api/v1/roles/%2e%2e%2fAlpha/removal-preview', headers: { host: boundary.host, cookie } });
    expect(traversal.statusCode).toBe(400);
    const noCsrf = await server.app.inject({ method: 'POST', url: '/api/v1/roles/Alpha/remove',
      headers: { host: boundary.host, origin: boundary.origin, cookie }, payload: { confirmation: 'Alpha' } });
    expect(noCsrf.statusCode).toBe(403);
    const removed = await server.app.inject({ method: 'POST', url: '/api/v1/roles/Alpha/remove',
      headers: { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': csrf },
      payload: { confirmation: 'Alpha' } });
    expect(removed.statusCode).toBe(200);
    expect(calls).toEqual([['remove', { role: 'Alpha', confirmation: 'Alpha' }]]);
    await server.close();
  });

  it('resumes only at the exact boundary, rotates the device, and logout revokes it', async () => {
    const { server, cookies, csrf } = await authenticated();
    const device = cookies.find(value => value.startsWith('ofs_device='))!;
    server.auth.clearSessions();
    const hostile = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: { host: boundary.host, origin: 'http://evil.invalid', cookie: device },
    });
    expect(hostile.statusCode).toBe(403);
    const resumed = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: { host: boundary.host, origin: boundary.origin, cookie: device },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).not.toContain(device.slice('ofs_device='.length));
    expect(JSON.stringify(server.audit.list())).not.toContain(device.slice('ofs_device='.length));
    const rotated = ([] as string[]).concat(resumed.headers['set-cookie'] ?? [])
      .map(value => value.split(';')[0]);
    const resumedCookie = rotated.join('; ');
    const oldReplay = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: { host: boundary.host, origin: boundary.origin, cookie: device },
    });
    expect(oldReplay.statusCode).toBe(401);
    const logout = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: {
        host: boundary.host, origin: boundary.origin, cookie: resumedCookie,
        'x-csrf-token': resumed.json().csrfToken,
      },
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    const revoked = await server.app.inject({
      method: 'POST', url: '/api/v1/auth/resume',
      headers: {
        host: boundary.host, origin: boundary.origin,
        cookie: rotated.find(value => value.startsWith('ofs_device=')),
      },
    });
    expect(revoked.statusCode).toBe(401);
    expect(csrf).toBeTruthy();
    await server.close();
  });
});

describe('watchdog read endpoints', () => {
  const WATCHDOG: ResolvedWatchdog = {
    name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
    intervalMs: 600_000, watch: ['Alice'], harness: 'claude-code', session: 'acp',
    identity: 'Watchdog-nightwatch', timeoutMs: 300_000, keepReports: 50,
    alertCooldownMs: 3_600_000, sourceFile: 'fleet.yaml',
  };
  const fleetConfig: FleetConfig = {
    roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
    watchdogs: [WATCHDOG],
  };
  const report = (runId: string, startedAt: string): WatchdogReport => ({
    schema_version: 1, watchdog: 'nightwatch', run_id: runId,
    started_at: startedAt, finished_at: startedAt, status: 'ok',
    summary: { checked: 1, healthy: 1, idle: 0, anomalies: 0 },
    roles: [{ role: 'Alice', status: 'healthy' }], alerts: [], error: null,
  });
  const OLDER = report('20260731T110000Z', '2026-07-31T11:00:00Z');
  const NEWER = report('20260731T120000Z', '2026-07-31T12:00:00Z');

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-web-'));
    process.env.OURS_FLEET_HOME = dir;
    writeReport('nightwatch', OLDER);
    writeReport('nightwatch', NEWER);
    writeSchedulerState('nightwatch', {
      version: 1, consecutiveFailures: 3, heldDown: true, heldSince: '2026-07-31T12:00:00Z',
      lastRunAt: '2026-07-31T12:00:00Z', nextRunAt: '2026-07-31T12:05:00Z',
    });
  });
  afterEach(() => {
    delete process.env.OURS_FLEET_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  function watchdogServices() {
    return { watchdogs: new WatchdogQueryService(() => fleetConfig) };
  }

  it('lists watchdogs with heldDown and the latest run', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs', headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.watchdogs).toHaveLength(1);
    expect(body.watchdogs[0]).toMatchObject({
      name: 'nightwatch', enabled: true, heldDown: true, heldSince: '2026-07-31T12:00:00Z', intervalMs: 600_000,
      coordinator: 'FleetCoordinator', watch: ['Alice'],
    });
    expect(body.watchdogs[0].latest.runId).toBe('20260731T120000Z');
    await server.close();
  });

  it('honors reports limit', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/nightwatch/reports?limit=1',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].runId).toBe('20260731T120000Z');
    await server.close();
  });

  it('returns a stored report deep-equal to what was written', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/nightwatch/reports/20260731T110000Z',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    // fastify re-serializes the response, so this checks deep JSON equality with the
    // stored report rather than byte-for-byte identity of the response body.
    expect(res.json()).toEqual(OLDER);
    await server.close();
  });

  it('404s an unknown watchdog name', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/Ghost/reports',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('404s an unknown report run id for a known watchdog', async () => {
    const { server, cookie } = await authenticated(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs/nightwatch/reports/20260101T000000Z',
      headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('rejects unauthenticated requests like other read routes', async () => {
    const server = await testServer(watchdogServices());
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs', headers: { host: boundary.host },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('reports capability_unavailable when no watchdog service is wired', async () => {
    const { server, cookie } = await authenticated();
    const res = await server.app.inject({
      method: 'GET', url: '/api/v1/watchdogs', headers: { host: boundary.host, cookie },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});

it('layout machine grant uses its own authorization and cannot authenticate browser control', async () => {
  const control = vi.fn(async (_id: string, authorization?: string) => {
    if (authorization !== 'Bearer scoped-grant') throw new (await import('../../src/application/errors.js')).FleetError('unauthorized', 'binding unavailable');
    return { instance: { cid: 'granted-agent' } };
  });
  const server = await testServer({ layoutBindings: { control } });
  try {
    const url = '/api/v1/layout-bindings/grant-id/control';
    const headers = { host: boundary.host, authorization: 'Bearer scoped-grant' };
    expect((await server.app.inject({ method: 'POST', url, headers, payload: { action: 'verify' } })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url, headers: { host: boundary.host }, payload: {} })).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/roles', headers })).statusCode).toBe(401);
    const before = control.mock.calls.length;
    for (const unsafe of [{ origin: 'https://foreign.example' }, { host: 'foreign.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await server.app.inject({ method: 'POST', url, headers: { ...headers, ...unsafe }, payload: { action: 'verify' } })).statusCode).toBe(403);
    }
    expect(control.mock.calls.length).toBe(before);
  } finally { await server.close(); }
});
