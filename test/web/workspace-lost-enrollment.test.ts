import {afterEach,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {parse,stringify} from 'yaml';
import {loadConfig,splitRootFor} from '../../src/config.js';
import {ensureMinimalSetup} from '../../src/minimal-setup.js';
import {checkWorkspaceConfiguration,enrollWorkspace,type WorkspacePayload} from '../../src/workspace-enrollment.js';
import {WebAccessStore} from '../../src/web/access.js';

const previous='a'.repeat(64),current='d'.repeat(64);
const undo:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const step of undo.splice(0).reverse())await step();});

/** A host whose Messenger answers with `cid` (or not at all) and counts every enrollment it receives. */
async function host(cid:string|null,enrolled:string|null=cid) {
 const dir=mkdtempSync(join(tmpdir(),'fleet-lost-')),prior={...process.env};const enrollments:unknown[]=[];let identities=0;
 const server:Server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
  if(req.method==='GET'){identities++;if(cid===null){res.statusCode=503;res.end('{}');return;}res.end(JSON.stringify({cid,preserveProfile:true}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);enrollments.push(JSON.parse(Buffer.concat(chunks).toString()));
  res.end(JSON.stringify({submitted:true,rootCid:enrolled,ownerInvite:'fixture-new-public-invite'}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 undo.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);rmSync(dir,{recursive:true,force:true});});
 for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];process.env.OURS_FLEET_HOME=dir;
 const endpoint='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const credential=join(dir,'credential');writeFileSync(credential,'fixture-credential',{mode:0o600});
 const profile=join(dir,'profile.json');writeFileSync(profile,JSON.stringify({serverUrl:endpoint,endpoint:endpoint+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
 new WebAccessStore().write({version:1,mode:'pairing'});
 const config=join(dir,'fleet.yaml'),workspace=join(dir,'.ours-fleet','workspace'),invite=join(workspace,'owner.invite');
 const payload:WorkspacePayload={version:1,appOrigin:'https://app.ours-tunnel.com',hostname:'alice-home.ours-tunnel.com',rootName:'alice@home',name:'New',surname:'Account',connectorToken:'fixture-scoped',invitation:'fixture-invite',serverCid:'b'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000}};
 return {dir,config,workspace,invite,payload,enrollments,identities:()=>identities};
}
/** Exactly what tunnel setup itself leaves behind after enrolling `owner`. */
const generated=(owner:string,invite:string,change:(rooms:any)=>void=()=>{})=>{const section={rooms:{owner:{provider:'messenger-server',expected_cid:owner,public_invite_file:invite,role:'Owner'},defaults:{attach_owner:true,close_when_task_done:true}}};change(section.rooms);return 'api_version: ours.network/fleet/v2\n\n'+stringify(section);};
const writeGenerated=(config:string,text:string)=>{writeFileSync(config,text,{mode:0o600});mkdirSync(join(splitRootFor(config),'agents'),{recursive:true,mode:0o700});};

describe('tunnel setup on a host that kept a generated configuration',()=>{
 it('accepts a generated configuration whose enrollment state is gone and records the newly enrolled Owner',async()=>{
  const h=await host(current);writeGenerated(h.config,generated(previous,h.invite));
  expect(()=>loadConfig(h.config,{yamlMode:'strict'})).toThrow(/public_invite_file: not found/);
  await checkWorkspaceConfiguration(h.config);await ensureMinimalSetup(h.config);
  expect(h.enrollments).toHaveLength(0);expect(readFileSync(h.config,'utf8')).toBe(generated(previous,h.invite));
  const result=await enrollWorkspace(h.payload,h.config,{preserveProfile:true});
  expect(result.rootCid).toBe(current);expect(h.enrollments).toHaveLength(1);expect(h.enrollments[0]).toMatchObject({preserveProfile:true});
  expect(readFileSync(h.invite,'utf8')).toBe('fixture-new-public-invite\n');
  expect(parse(readFileSync(h.config,'utf8'))).toEqual(parse(generated(current,h.invite)));
  const loaded=loadConfig(h.config,{yamlMode:'strict'});expect(loaded.rooms?.owner.expected_cid).toBe(current);expect(loaded.ownerInvite).toBe('fixture-new-public-invite');
  // Repeating setup on the now-bound host keeps the same root and configuration.
  const settled=readFileSync(h.config,'utf8');await checkWorkspaceConfiguration(h.config);await ensureMinimalSetup(h.config);
  expect((await enrollWorkspace(h.payload,h.config,{preserveProfile:true})).rootCid).toBe(current);expect(readFileSync(h.config,'utf8')).toBe(settled);
 });

 it('keeps the configured Owner when only the setup-written invitation file is missing',async()=>{
  const h=await host(current);writeGenerated(h.config,generated(current,h.invite));const before=readFileSync(h.config,'utf8');
  await checkWorkspaceConfiguration(h.config);await ensureMinimalSetup(h.config);
  await enrollWorkspace(h.payload,h.config,{preserveProfile:true});
  expect(readFileSync(h.config,'utf8')).toBe(before);expect(readFileSync(h.invite,'utf8')).toBe('fixture-new-public-invite\n');
 });

 const refused:Array<[string,(h:Awaited<ReturnType<typeof host>>)=>void,RegExp]>=[
  ['an extra manifest key',h=>writeGenerated(h.config,generated(previous,h.invite)+'vars:\n  kept: value\n'),/different Owner/],
  ['a retained agent file',h=>{writeGenerated(h.config,generated(previous,h.invite));writeFileSync(join(splitRootFor(h.config),'agents','kept.yaml.disabled'),'kept',{mode:0o600});},/different Owner/],
  ['another split directory',h=>{writeGenerated(h.config,generated(previous,h.invite));mkdirSync(join(splitRootFor(h.config),'room_templates'),{mode:0o700});},/different Owner/],
  ['a non-generated role',h=>writeGenerated(h.config,generated(previous,h.invite,rooms=>{rooms.owner.role='Lead';})),/different Owner/],
  ['non-generated defaults',h=>writeGenerated(h.config,generated(previous,h.invite,rooms=>{rooms.defaults.close_when_task_done=false;})),/different Owner/],
  ['a remaining binding record',h=>{writeGenerated(h.config,generated(previous,h.invite));mkdirSync(h.workspace,{recursive:true,mode:0o700});writeFileSync(join(h.workspace,'binding.json'),JSON.stringify({workspaceId:'w'.repeat(43),appOrigin:'https://app.ours-tunnel.com'}),{mode:0o600});},/different Owner/],
  ['a missing invitation file outside the setup-owned path',h=>writeGenerated(h.config,generated(previous,join(h.dir,'custom.invite'))),/public_invite_file: not found/],
  ['a relative invitation path',h=>writeGenerated(h.config,generated(previous,'.ours-fleet/workspace/owner.invite')),/public_invite_file: not found/],
  ['a relative path that reaches the setup-owned invitation file',h=>writeGenerated(h.config,generated(previous,relative(process.cwd(),h.invite))),/public_invite_file: not found/],
 ];
 it.each(refused)('refuses %s before the command is used and changes nothing',async(_name,arrange,message)=>{
  const h=await host(current);arrange(h);const before=readFileSync(h.config,'utf8');
  await expect(checkWorkspaceConfiguration(h.config)).rejects.toThrow(message);
  expect(h.enrollments).toHaveLength(0);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);
 });

 it('refuses a retained Owner when this host identity cannot be read',async()=>{
  const h=await host(null);writeGenerated(h.config,generated(previous,h.invite));const before=readFileSync(h.config,'utf8');
  await expect(checkWorkspaceConfiguration(h.config)).rejects.toThrow(/Messenger identity cannot be read/);
  expect(h.identities()).toBe(1);expect(h.enrollments).toHaveLength(0);expect(readFileSync(h.config,'utf8')).toBe(before);
 });

 it('enrollment itself never replaces an Owner beside retained configuration',async()=>{
  const h=await host(current);writeGenerated(h.config,generated(previous,h.invite)+'vars:\n  kept: value\n');const before=readFileSync(h.config,'utf8');
  await expect(enrollWorkspace(h.payload,h.config,{preserveProfile:true})).rejects.toThrow('Retained room owner CID conflicts with the Human root');
  expect(h.enrollments).toHaveLength(0);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);
 });

 it.each([['a generated configuration whose enrollment state is gone',previous],['a matching configured Owner',current]])('records nothing when enrollment answers for another root than this host (%s)',async(_name,configured)=>{
  const h=await host(current,'e'.repeat(64));writeGenerated(h.config,generated(configured,h.invite));const before=readFileSync(h.config,'utf8');
  await expect(enrollWorkspace(h.payload,h.config,{preserveProfile:true})).rejects.toThrow('different root than this host identity');
  expect(h.enrollments).toHaveLength(1);expect(readFileSync(h.config,'utf8')).toBe(before);expect(existsSync(h.invite)).toBe(false);expect(existsSync(join(h.workspace,'binding.json'))).toBe(false);
 });

 it('passes a host with no configuration and names a split directory left without its manifest',async()=>{
  const h=await host(current);await checkWorkspaceConfiguration(h.config);expect(h.identities()).toBe(0);
  mkdirSync(splitRootFor(h.config),{mode:0o700});await expect(checkWorkspaceConfiguration(h.config)).rejects.toThrow(/exists without/);
 });
});
