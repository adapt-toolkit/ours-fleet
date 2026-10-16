import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeV2Fixture} from '../v2-fixture.js';
import {decodeWorkspacePayload,enrollWorkspace,type WorkspacePayload} from '../../src/workspace-enrollment.js';
import {WebAccessStore} from '../../src/web/access.js';
it.each([true,false])('existing host requires profile preservation capability (%s)',async(supported)=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-existing-')),prior={...process.env};const received:Array<Record<string,unknown>>=[];const root='a'.repeat(64);
 const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify({cid:root,...(supported?{preserveProfile:true}:{})}));return;}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);received.push(JSON.parse(Buffer.concat(chunks).toString()));res.end(JSON.stringify({submitted:true,rootCid:root,ownerInvite:'fixture-public-invite'}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];process.env.OURS_FLEET_HOME=dir;
  const endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const credential=join(dir,'credential');writeFileSync(credential,'fixture-credential',{mode:0o600});const profile=join(dir,'non-default-profile.json');writeFileSync(profile,JSON.stringify({serverUrl:endpoint,endpoint:endpoint+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(dir,'fleet.yaml'),invite=join(dir,'owner.invite');writeFileSync(invite,'old-public-fixture',{mode:0o600});writeV2Fixture(config,{roles:{},rooms:{owner:{provider:'messenger-server',expected_cid:root.toUpperCase(),public_invite_file:invite,role:'Owner'},defaults:{attach_owner:true,close_when_task_done:true}}});const original=readFileSync(config);
  new WebAccessStore().write({version:1,mode:'pairing'});
  const payload:WorkspacePayload={version:1,appOrigin:'https://app.ours-tunnel.com',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',fullName:'New Account',name:'New',surname:'Account',connectorToken:'fixture-scoped',invitation:'fixture-invite',serverCid:'b'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000}};
  if(supported){const result=await enrollWorkspace(payload,config,{preserveProfile:true});expect(result.origin).toBe('https://alice-home.ours-tunnel.com');expect(received).toHaveLength(1);expect(received[0]).toMatchObject({preserveProfile:true,challenge:payload.challenge});expect(received[0]).not.toHaveProperty('fullName');expect(received[0]).not.toHaveProperty('name');expect(received[0]).not.toHaveProperty('surname');expect(readFileSync(join(dir,'.ours-fleet','workspace','connector'),'utf8')).toBe('fixture-scoped\n');}
  else{await expect(enrollWorkspace(payload,config,{preserveProfile:true})).rejects.toThrow('requires Messenger profile-preservation support');expect(received).toHaveLength(0);}
  expect(readFileSync(config)).toEqual(original);expect(JSON.parse(readFileSync(profile,'utf8')).endpoint).toBe(endpoint+'/daemon');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);rmSync(dir,{recursive:true,force:true});}
});

const profilePayload={version:1,appOrigin:'https://app.ours.network',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',connectorToken:'fixture',invitation:'invite',serverCid:'a'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'a'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000}};
it.each([
 [{fullName:'Prince',name:null,surname:null},{fullName:'Prince',name:null,surname:null}],
 [{},{fullName:null,name:null,surname:null}],
 [{name:'Alice'},{fullName:null,name:'Alice',surname:null}],
 [{surname:'Tester'},{fullName:null,name:null,surname:'Tester'}],
 [{name:'Alice',surname:'Tester'},{fullName:null,name:'Alice',surname:'Tester'}],
])('decodes independent optional profile %s',(fields,want)=>{
 const result=decodeWorkspacePayload(Buffer.from(JSON.stringify({...profilePayload,...fields})).toString('base64url'));
 expect({fullName:result.fullName,name:result.name,surname:result.surname}).toEqual(want);
});
it.each(['fullName','name','surname'])('rejects malformed optional profile %s',(key)=>{
 for(const value of [42,{},'bad\nname','x'.repeat(8193)])expect(()=>decodeWorkspacePayload(Buffer.from(JSON.stringify({...profilePayload,name:'Alice',surname:'Tester',[key]:value})).toString('base64url'))).toThrow();
});

it.each([true,false])('fresh optional profile requires Messenger capability before enrollment or connector writes (%s)',async(supported)=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-optional-')),prior={...process.env},root='a'.repeat(64);const received:Array<Record<string,unknown>>=[];
 const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify({cid:root,preserveProfile:true,...(supported?{optionalWorkspaceProfileV1:true}:{})}));return;}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);received.push(JSON.parse(Buffer.concat(chunks).toString()));res.end(JSON.stringify({submitted:true,rootCid:root,ownerInvite:'fixture-public-invite'}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];process.env.OURS_FLEET_HOME=dir;
  const endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port,credential=join(dir,'credential'),profile=join(dir,'profile.json');writeFileSync(credential,'fixture',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:endpoint,endpoint:endpoint+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(dir,'fleet.yaml');writeV2Fixture(config,{roles:{}});const original=readFileSync(config);new WebAccessStore().write({version:1,mode:'pairing'});
  const payload={...profilePayload,fullName:'Prince',name:null,surname:null} as WorkspacePayload;
  if(supported){await enrollWorkspace(payload,config);expect(received).toHaveLength(1);expect(received[0]).toMatchObject({fullName:'Prince',name:null,surname:null,challenge:payload.challenge});}
  else{await expect(enrollWorkspace({...payload,connectorToken:undefined},config)).rejects.toThrow('owned private connector file');await expect(enrollWorkspace(payload,config)).rejects.toThrow(/update.*Messenger|Messenger.*update/i);expect(received).toHaveLength(0);expect(readFileSync(config)).toEqual(original);for(const file of ['connector','binding.json','owner.invite'])expect(existsSync(join(dir,'.ours-fleet','workspace',file))).toBe(false);}
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);rmSync(dir,{recursive:true,force:true});}
});
