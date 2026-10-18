import {it,expect,vi,afterEach} from 'vitest';
import {createServer,request} from 'node:http';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {startWebConsole} from '../../src/web/runtime.js';
import {WebAccessStore} from '../../src/web/access.js';
import {WorkspaceDeviceStore} from '../../src/web/workspace-devices.js';
import {ensureMinimalSetup} from '../../src/minimal-setup.js';
import {enrollWorkspace} from '../../src/workspace-enrollment.js';
import {adoptAccountOrigin,beginWorkspaceReplacement,readWorkspaceBinding} from '../../src/workspace-replacement.js';

// Hosts enrolled before the account origin was recorded have a binding without appOrigin.
const appOrigin='https://app.ours.network',host='fixture.ours-tunnel.com';
const id=(c:string)=>c.repeat(43);
afterEach(()=>{vi.restoreAllMocks();});
function options(origin=appOrigin,stale=false){
 return {version:1 as const,appOrigin:origin,hostname:stale?'stale.ours-tunnel.com':host,rootName:'different@account',name:'New',surname:'Profile',connectorToken:stale?'stale-connector':'fixture-connector',invitation:'fixture-invite',serverCid:'b'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:id('w'),expiresAt:Date.now()+600000}};
}
async function preflight(url:string,headers:Record<string,string>) {
 return new Promise<{status:number;allowOrigin:unknown}>((resolve,reject)=>{const req=request(url,{method:'OPTIONS',headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode ?? 0,allowOrigin:res.headers['access-control-allow-origin']}));res.on('error',reject);});req.on('error',reject);req.end();});
}
function isolatedHome(){
 const dir=mkdtempSync(join(tmpdir(),'workspace-legacy-binding-')),previous={...process.env};
 for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH','OURS_ACCOUNT_ORIGIN'])delete process.env[key];
 process.env.OURS_FLEET_HOME=dir;
 const restore=()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);rmSync(dir,{recursive:true,force:true});};
 return {dir,workspace:join(dir,'.ours-fleet','workspace'),restore};
}

it('keeps a legacy host usable without account access until its origin is explicitly adopted',async()=>{
 const home=isolatedHome();let running:Awaited<ReturnType<typeof startWebConsole>>|undefined;
 const calls:string[]=[];
 const provider=createServer((req,res)=>{calls.push(req.url ?? '');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/messenger/api/workspace/enrollment-identity'?{cid:'a'.repeat(64),preserveProfile:true}:req.url==='/messenger/api/workspace/enroll'?{submitted:true,rootCid:'a'.repeat(64),ownerInvite:'fixture-public-owner-invite'}:{workspace:'fixture'}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin='http://127.0.0.1:'+(provider.address() as {port:number}).port;
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  const profile=join(home.dir,'profile.json'),credential=join(home.dir,'server-credential');writeFileSync(credential,'fixture-server-credential-32-characters\n',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:providerOrigin,endpoint:providerOrigin+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(home.dir,'fleet.yaml');await ensureMinimalSetup(config);
  new WebAccessStore().write({version:1,mode:'pairing'});
  await enrollWorkspace(options(),config,{preserveProfile:true});
  const bindingFile=join(home.workspace,'binding.json'),current=JSON.parse(readFileSync(bindingFile,'utf8'));
  const legacy={workspaceId:current.workspaceId,hostWorkspaceId:current.hostWorkspaceId};
  writeFileSync(bindingFile,JSON.stringify(legacy)+'\n',{mode:0o600});
  const devices=new WorkspaceDeviceStore(),hostWorkspaceId=devices.workspaceId;devices.close();
  const consoleOptions={configPath:config,binPath:process.execPath,port:0,publicOrigin:'https://'+host,control:true};
  const account=async()=>{const bound=JSON.parse(readFileSync(join(home.dir,'.ours-fleet','web','workspace-port.json'),'utf8')) as {port:number};
   return preflight('http://127.0.0.1:'+bound.port+'/fleet/api/v1/devices',{Host:host,Origin:appOrigin,'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'cors'});};
  // Without a recorded origin the console starts and explains the recovery; the account App is not admitted.
  running=await startWebConsole(consoleOptions);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ours-fleet adopt-account-origin'));
  expect(await account()).toEqual({status:403,allowOrigin:undefined});
  await running.close();running=undefined;
  // Strict paths never guess the origin; configuration does not stand in for it.
  process.env.OURS_ACCOUNT_ORIGIN=appOrigin;
  expect(()=>readWorkspaceBinding()).toThrow('records no account origin');
  const before=calls.length;
  await expect(enrollWorkspace(options(),config,{preserveProfile:true})).rejects.toThrow('records no account origin');
  expect(calls.length).toBe(before);
  expect(readFileSync(bindingFile,'utf8')).toBe(JSON.stringify(legacy)+'\n');
  // Explicit adoption records only the origin.
  expect(adoptAccountOrigin(appOrigin)).toEqual({...legacy,appOrigin});
  expect(JSON.parse(readFileSync(bindingFile,'utf8'))).toEqual({...legacy,appOrigin});
  expect(()=>adoptAccountOrigin('https://other.example.test')).toThrow('already records its account origin');
  running=await startWebConsole(consoleOptions);
  expect(await account()).toEqual({status:204,allowOrigin:appOrigin});
  await running.close();running=undefined;
  // Migration guards apply against the adopted origin.
  await expect(enrollWorkspace(options('https://other.example.test'),config,{preserveProfile:true})).rejects.toThrow('--migrate-app-origin');
  await enrollWorkspace(options(),config,{preserveProfile:true});
  expect(readWorkspaceBinding()).toMatchObject({...legacy,appOrigin});
  const after=new WorkspaceDeviceStore();expect(after.workspaceId).toBe(hostWorkspaceId);after.close();
 }finally{await running?.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));home.restore();}
},30000);

it('adopts only into an owned private regular binding with valid identities and no recorded origin',()=>{
 const home=isolatedHome();
 try{
  const file=join(home.workspace,'binding.json');
  expect(()=>adoptAccountOrigin(appOrigin)).toThrow('no workspace binding');
  mkdirSync(home.workspace,{recursive:true,mode:0o700});
  // No recorded host identity: the binding cannot be shown to belong to this host.
  writeFileSync(file,JSON.stringify({workspaceId:id('w'),hostWorkspaceId:id('h')})+'\n',{mode:0o600});
  expect(()=>adoptAccountOrigin(appOrigin)).toThrow('different host identity');
  const devices=new WorkspaceDeviceStore(),host=devices.workspaceId;devices.close();
  const store=join(home.dir,'.ours-fleet','web','workspace-devices.db'),storeBytes=readFileSync(store);
  const legacy=JSON.stringify({workspaceId:id('w'),hostWorkspaceId:host,serverCid:'B'.repeat(64)})+'\n';
  const refuses=(contents:string,message:string,origin=appOrigin)=>{writeFileSync(file,contents,{mode:0o600});chmodSync(file,0o600);expect(()=>adoptAccountOrigin(origin)).toThrow(message);expect(readFileSync(file,'utf8')).toBe(contents);};
  refuses(legacy,'Unsupported account origin','http://app.ours.network');
  refuses('{not json','invalid');
  refuses(JSON.stringify({workspaceId:'short',hostWorkspaceId:host}),'invalid');
  refuses(JSON.stringify({workspaceId:[id('w')],hostWorkspaceId:host}),'invalid');
  refuses(JSON.stringify({workspaceId:id('w'),hostWorkspaceId:[host]}),'invalid');
  refuses(JSON.stringify({workspaceId:id('w'),hostWorkspaceId:host===id('h')?id('i'):id('h')}),'different host identity');
  refuses(JSON.stringify({workspaceId:id('w'),hostWorkspaceId:host,appOrigin:'https://recorded.example.test'}),'already records its account origin');
  writeFileSync(file,legacy,{mode:0o644});chmodSync(file,0o644);
  expect(()=>adoptAccountOrigin(appOrigin)).toThrow('private regular file');
  rmSync(file);const target=join(home.dir,'elsewhere.json');writeFileSync(target,legacy,{mode:0o600});symlinkSync(target,file);
  expect(()=>adoptAccountOrigin(appOrigin)).toThrow('private regular file');
  expect(readFileSync(target,'utf8')).toBe(legacy);
  rmSync(file);writeFileSync(file,legacy,{mode:0o600});
  writeFileSync(join(home.workspace,'replacement.json'),'{}',{mode:0o600});
  expect(()=>adoptAccountOrigin(appOrigin)).toThrow('unfinished replacement');
  rmSync(join(home.workspace,'replacement.json'));
  expect(adoptAccountOrigin(appOrigin)).toEqual({...JSON.parse(legacy),appOrigin});
  expect(readFileSync(file,'utf8')).toBe(JSON.stringify({...JSON.parse(legacy),appOrigin})+'\n');
  expect(readFileSync(store).equals(storeBytes)).toBe(true);
 }finally{home.restore();}
});

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
