import { mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { AuditSink } from '../../src/web/audit.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { buildWebServer } from '../../src/web/server.js';
import { ArtifactStore,artifactDirectory } from '../../src/file-delivery/store.js';
import { ConversationEventStore } from '../../src/session/conversation-store.js';
const boundary={origin:'http://127.0.0.1:49271',host:'127.0.0.1:49271'};
it('only authenticated published files in this role incarnation download as safe attachments; original bytes survive restart',async()=>{
 mkdirSync(resolve('test-output'),{recursive:true});const dir=mkdtempSync(resolve('test-output/file-http-'));process.env.OURS_FLEET_HOME=dir;mkdirSync(join(dir,'.ours-fleet'));
 const state=join(dir,'Alpha'),other=join(dir,'Beta');for(const p of[state,other]){mkdirSync(p);writeFileSync(join(p,'.session-id'),randomUUID());}
 const bytes=Buffer.from([0,255,128,10,60,115,99,114,105,112,116,62]);
 const copy=()=>({size:bytes.length,body:new Blob([bytes]).stream(),close:async()=>{}});
 const binding={sessionGeneration:'g',acpSessionId:'real',turnId:'turn'};
 const store=new ArtifactStore(state),a=await store.copy(copy(),'test.html','text/html',binding,new AbortController().signal),orphan=await store.copy(copy(),'orphan','text/plain',binding,new AbortController().signal);
 const events=new ConversationEventStore(join(state,'.conversation'),{roleId:'Alpha'});events.append({kind:'file.attached',source:'agent',...binding,payload:{attachment:a}});events.close();
 const role={id:'Alpha',lifetime:'permanent',configured:true,stateHealth:'present',configuredBackend:'acp',detectedBackend:'acp',compatibility:{compatible:true},problems:[]};
 const auth=new WebAuth(boundary.origin,boundary.host,Date.now,new TrustedDeviceStore(dir));
 const server=await buildWebServer({query:{async list(){return[];},async detail(){return{role,status:{},capabilities:{}};}},repository:{async get(id:string){return ['Alpha','Beta'].includes(id)?{...role,id}:undefined;},stateDir:(r:{id:string})=>r.id==='Alpha'?state:other},async session(){return{};},logs:{source:()=>({tail:async()=>({records:[],truncated:false})})},commands:{async execute(){return{};},get(){return undefined;}},creation:{async capabilities(){return{};},async preview(){return{};},async create(){return{};},get(){return undefined;}},audit:new AuditSink(join(dir,'audit'))} as never,boundary,{auth});
 try{
 const url='/api/v1/roles/Alpha/artifacts/'+a.id, headers={host:boundary.host,origin:boundary.origin};
 expect((await server.app.inject({url,headers})).statusCode).toBe(401);
 const login=await server.app.inject({method:'POST',url:'/api/v1/auth/exchange',headers:{...headers,authorization:'Bootstrap '+auth.bootstrapSecret}});
 const cookie=[].concat(login.headers['set-cookie'] as never??[]).map((v:string)=>v.split(';')[0]).join('; ');const h={...headers,cookie};
 const response=await server.app.inject({url,headers:h});expect(response.statusCode).toBe(200);expect(response.rawPayload).toEqual(bytes);
 expect(response.headers['content-type']).toMatch(/^application\/octet-stream/);expect(response.headers['content-disposition']).toContain('attachment');expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['cache-control']).toContain('no-store');expect(response.headers['content-security-policy']).toContain('sandbox');
 for(const path of ['/api/v1/roles/Beta/artifacts/'+a.id,'/api/v1/roles/Alpha/artifacts/'+orphan.id,'/api/v1/roles/Missing/artifacts/'+a.id])expect((await server.app.inject({url:path,headers:h})).statusCode).toBe(404);
 chmodSync(join(artifactDirectory(state),a.id+'.data'),0o600);writeFileSync(join(artifactDirectory(state),a.id+'.data'),Buffer.from('tamper'));expect((await server.app.inject({url,headers:h})).statusCode).toBe(404);
 writeFileSync(join(state,'.session-id'),randomUUID());expect((await server.app.inject({url,headers:h})).statusCode).toBe(404);
 }finally{await server.close();delete process.env.OURS_FLEET_HOME;rmSync(dir,{recursive:true,force:true});}
});
