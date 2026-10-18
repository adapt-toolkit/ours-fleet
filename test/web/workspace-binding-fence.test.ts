import {it,expect,vi,afterEach} from 'vitest';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {startWebConsole} from '../../src/web/runtime.js';
import {WebAccessStore} from '../../src/web/access.js';
import {ensureMinimalSetup} from '../../src/minimal-setup.js';
import {enrollWorkspace} from '../../src/workspace-enrollment.js';
import {beginWorkspaceReplacement,readWorkspaceBinding} from '../../src/workspace-replacement.js';

// Workspace bindings record their account origin; one without it is unsupported and refused.
const appOrigin='https://app.ours.network',host='fixture.ours-tunnel.com';
const id=(c:string)=>c.repeat(43);
afterEach(()=>{vi.restoreAllMocks();});
function options(origin=appOrigin,stale=false){
 return {version:1 as const,appOrigin:origin,hostname:stale?'stale.ours-tunnel.com':host,rootName:'different@account',name:'New',surname:'Profile',connectorToken:stale?'stale-connector':'fixture-connector',invitation:'fixture-invite',serverCid:'b'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:id('w'),expiresAt:Date.now()+600000}};
}
function isolatedHome(){
 const dir=mkdtempSync(join(tmpdir(),'workspace-binding-fence-')),previous={...process.env};
 for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH','OURS_ACCOUNT_ORIGIN'])delete process.env[key];
 process.env.OURS_FLEET_HOME=dir;
 const restore=()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);rmSync(dir,{recursive:true,force:true});};
 return {dir,workspace:join(dir,'.ours-fleet','workspace'),restore};
}

it('refuses a binding without a recorded account origin everywhere, changing nothing',async()=>{
 const home=isolatedHome();
 const calls:string[]=[];
 const provider=createServer((req,res)=>{calls.push(req.url ?? '');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/messenger/api/workspace/enrollment-identity'?{cid:'a'.repeat(64),preserveProfile:true}:req.url==='/messenger/api/workspace/enroll'?{submitted:true,rootCid:'a'.repeat(64),ownerInvite:'fixture-public-owner-invite'}:{workspace:'fixture'}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin='http://127.0.0.1:'+(provider.address() as {port:number}).port;
 try{
  const profile=join(home.dir,'profile.json'),credential=join(home.dir,'server-credential');writeFileSync(credential,'fixture-server-credential-32-characters\n',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:providerOrigin,endpoint:providerOrigin+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(home.dir,'fleet.yaml');await ensureMinimalSetup(config);
  new WebAccessStore().write({version:1,mode:'pairing'});
  await enrollWorkspace(options(),config,{preserveProfile:true});
  const bindingFile=join(home.workspace,'binding.json'),current=JSON.parse(readFileSync(bindingFile,'utf8'));
  const unsupported=JSON.stringify({workspaceId:current.workspaceId,hostWorkspaceId:current.hostWorkspaceId})+'\n';
  writeFileSync(bindingFile,unsupported,{mode:0o600});
  await expect(startWebConsole({configPath:config,binPath:process.execPath,port:0,publicOrigin:'https://'+host,control:true})).rejects.toThrow('Unsupported account origin');
  process.env.OURS_ACCOUNT_ORIGIN=appOrigin;
  expect(()=>readWorkspaceBinding()).toThrow('Unsupported account origin');
  const before=calls.length;
  await expect(enrollWorkspace(options(),config,{preserveProfile:true})).rejects.toThrow('Unsupported account origin');
  expect(calls.length).toBe(before);
  expect(readFileSync(bindingFile,'utf8')).toBe(unsupported);
 }finally{provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));home.restore();}
},30000);

it('enrollment never overwrites a binding changed by another writer while it runs',async()=>{
 const home=isolatedHome();
 let gate:{url:string;open:Promise<void>;used?:boolean}|undefined;
 const calls:string[]=[];
 const provider=createServer(async(req,res)=>{const url=req.url ?? '';calls.push(url);if(gate?.url===url && !gate.used){gate.used=true;await gate.open;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url==='/messenger/api/workspace/enrollment-identity'?{cid:'a'.repeat(64),preserveProfile:true}:url==='/messenger/api/workspace/enroll'?{submitted:true,rootCid:'a'.repeat(64),ownerInvite:'fixture-public-owner-invite'}:{workspace:'fixture'}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin='http://127.0.0.1:'+(provider.address() as {port:number}).port;
 try{
  const profile=join(home.dir,'profile.json'),credential=join(home.dir,'server-credential');writeFileSync(credential,'fixture-server-credential-32-characters\n',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:providerOrigin,endpoint:providerOrigin+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(home.dir,'fleet.yaml');await ensureMinimalSetup(config);
  new WebAccessStore().write({version:1,mode:'pairing'});
  await enrollWorkspace(options(),config,{preserveProfile:true});
  const file=join(home.workspace,'binding.json');
  // Everything an enrollment commits locally besides the binding.
  const sideFiles=()=>[join(home.workspace,'owner.invite'),config,join(home.workspace,'connector'),join(home.workspace,'tunnel.json')].map(path=>readFileSync(path,'utf8'));
  for(const url of ['/messenger/api/workspace/enrollment-identity','/messenger/api/workspace/enroll']){
   let release!:()=>void;gate={url,open:new Promise<void>(r=>{release=r;})};
   const before=calls.length;
   const running=enrollWorkspace(options(appOrigin,true),config,{preserveProfile:true});
   while(!calls.slice(before).includes(url))await new Promise(r=>setTimeout(r,10));
   // Another writer commits while this enrollment is in flight.
   const concurrent=JSON.stringify({...JSON.parse(readFileSync(file,'utf8')),appOrigin:'https://other.example.test'})+'\n';
   writeFileSync(file,concurrent,{mode:0o600});
   const side=sideFiles();
   release();
   await expect(running).rejects.toThrow('binding changed during setup');
   expect(readFileSync(file,'utf8')).toBe(concurrent);
   expect(sideFiles()).toEqual(side);
   if(url.endsWith('enrollment-identity'))expect(calls.slice(before)).not.toContain('/messenger/api/workspace/enroll');
   gate=undefined;
   writeFileSync(file,JSON.stringify({...JSON.parse(concurrent),appOrigin})+'\n',{mode:0o600});
  }
  // An explicit migration commits while an ordinary same-origin enrollment is still in flight.
  let release!:()=>void;gate={url:'/messenger/api/workspace/enroll',open:new Promise<void>(r=>{release=r;})};
  const before=calls.length,stale=enrollWorkspace(options(appOrigin,true),config,{preserveProfile:true});
  while(!calls.slice(before).includes('/messenger/api/workspace/enroll'))await new Promise(r=>setTimeout(r,10));
  const realFetch=globalThis.fetch;
  vi.stubGlobal('fetch',(input:string|URL|Request,init?:RequestInit)=>String(input instanceof Request?input.url:input).startsWith('https://other.example.test/')
   ?Promise.resolve(new Response(JSON.stringify({verified:true}),{headers:{'Content-Type':'application/json'}})):realFetch(input,init));
  await enrollWorkspace(options('https://other.example.test'),config,{preserveProfile:true,migrateAppOrigin:true});
  const migrated=readFileSync(file,'utf8'),side=sideFiles();
  expect(JSON.parse(migrated).appOrigin).toBe('https://other.example.test');
  release();
  await expect(stale).rejects.toThrow('binding changed during setup');
  expect(readFileSync(file,'utf8')).toBe(migrated);
  expect(sideFiles()).toEqual(side);
 }finally{vi.unstubAllGlobals();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));home.restore();}
},30000);

it('enrollment and a replacement started while it runs never both commit',async()=>{
 const home=isolatedHome();
 let gate:{url:string;open:Promise<void>;used?:boolean}|undefined;
 const calls:string[]=[];
 const provider=createServer(async(req,res)=>{const url=req.url ?? '';calls.push(url);if(gate?.url===url && !gate.used){gate.used=true;await gate.open;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url==='/messenger/api/workspace/enrollment-identity'?{cid:'a'.repeat(64),preserveProfile:true}:url==='/messenger/api/workspace/enroll'?{submitted:true,rootCid:'a'.repeat(64),ownerInvite:'fixture-public-owner-invite'}:{workspace:'fixture'}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin='http://127.0.0.1:'+(provider.address() as {port:number}).port;
 const realFetch=globalThis.fetch;
 vi.stubGlobal('fetch',(input:string|URL|Request,init?:RequestInit)=>String(input instanceof Request?input.url:input).startsWith('https://other.example.test/')
  ?Promise.resolve(new Response(JSON.stringify({verified:true}),{headers:{'Content-Type':'application/json'}})):realFetch(input,init));
 try{
  const profile=join(home.dir,'profile.json'),credential=join(home.dir,'server-credential');writeFileSync(credential,'fixture-server-credential-32-characters\n',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:providerOrigin,endpoint:providerOrigin+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(home.dir,'fleet.yaml');await ensureMinimalSetup(config);
  new WebAccessStore().write({version:1,mode:'pairing'});
  await enrollWorkspace(options(),config,{preserveProfile:true});
  const file=join(home.workspace,'binding.json'),replacement=join(home.workspace,'replacement.json'),bound=readFileSync(file,'utf8');
  const sideFiles=()=>[join(home.workspace,'owner.invite'),config,join(home.workspace,'connector'),join(home.workspace,'tunnel.json')].map(path=>readFileSync(path,'utf8'));
  const successor={...options(),challenge:{...options().challenge,workspaceId:id('z')}},root='d'.repeat(64);
  // A replacement of this binding begins while an explicit origin migration is in flight.
  let release!:()=>void;gate={url:'/messenger/api/workspace/enrollment-identity',open:new Promise<void>(r=>{release=r;})};
  const before=calls.length,migration=enrollWorkspace(options('https://other.example.test',true),config,{preserveProfile:true,migrateAppOrigin:true});
  while(!calls.slice(before).includes(gate.url))await new Promise(r=>setTimeout(r,10));
  await beginWorkspaceReplacement(readWorkspaceBinding()!,successor,config,{preflight:async()=>root});
  const pending=readFileSync(replacement,'utf8'),side=sideFiles();
  expect(JSON.parse(pending).previous.appOrigin).toBe(appOrigin);
  release();
  await expect(migration).rejects.toThrow('unfinished replacement changed during setup');
  expect(calls.slice(before)).not.toContain('/messenger/api/workspace/enroll');
  expect(readFileSync(file,'utf8')).toBe(bound);
  expect(readFileSync(replacement,'utf8')).toBe(pending);
  expect(sideFiles()).toEqual(side);
  // No other setup starts while that replacement is unfinished.
  await expect(enrollWorkspace(options('https://other.example.test',true),config,{preserveProfile:true,migrateAppOrigin:true})).rejects.toThrow('An unfinished replacement exists');
  rmSync(replacement);
  // A migration commits while a replacement of the binding it changes is still being checked.
  let preflightRelease!:()=>void,preflightStarted=false;const held=new Promise<void>(r=>{preflightRelease=r;});
  const begin=beginWorkspaceReplacement(readWorkspaceBinding()!,successor,config,{preflight:async()=>{preflightStarted=true;await held;return root;}});
  while(!preflightStarted)await new Promise(r=>setTimeout(r,10));
  await enrollWorkspace(options('https://other.example.test',true),config,{preserveProfile:true,migrateAppOrigin:true});
  const migrated=readFileSync(file,'utf8'),after=sideFiles();
  expect(JSON.parse(migrated).appOrigin).toBe('https://other.example.test');
  preflightRelease();
  await expect(begin).rejects.toThrow('binding changed during setup');
  expect(existsSync(replacement)).toBe(false);
  expect(readFileSync(file,'utf8')).toBe(migrated);
  expect(sideFiles()).toEqual(after);
 }finally{vi.unstubAllGlobals();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));home.restore();}
},30000);
