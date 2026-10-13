import {it,expect} from 'vitest';
import {createServer,request} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {startWebConsole} from '../../src/web/runtime.js';
import {WebAccessStore} from '../../src/web/access.js';
import {ensureMinimalSetup} from '../../src/minimal-setup.js';
import {requestWebControl} from '../../src/web/control.js';
import {enrollWorkspace} from '../../src/workspace-enrollment.js';
const appOrigin='https://app.ours.network',host='fixture.ours-tunnel.com';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Call={status:number;headers:Headers;body:any;text:string};
async function call(url:string,options:{method?:string;headers?:Record<string,string>;body?:unknown}={}):Promise<Call> {
 return new Promise((resolve,reject)=>{const req=request(url,{method:options.method ?? (options.body===undefined?'GET':'POST'),headers:{Host:host,...(options.body===undefined?{}:{'Content-Type':'application/json'}),...options.headers}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let body:any;try{body=JSON.parse(text);}catch{body=undefined;}resolve({status:res.statusCode ?? 0,headers:new Headers(res.headers as Record<string,string>),body,text});});res.on('error',reject);});req.on('error',reject);req.end(options.body===undefined?undefined:JSON.stringify(options.body));});
}
// What the account App's page sends; a server-to-server call from the account server sends none of it.
const page=(token:string)=>({Origin:appOrigin,'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'cors',Authorization:'Bearer '+token});
it('serves rotating workspace credentials to the account server only, through the real gateway',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workspace-refresh-runtime-')),previous={...process.env};let running:Awaited<ReturnType<typeof startWebConsole>>|undefined;
 const provider=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/messenger/api/workspace/enrollment-identity'?{cid:'a'.repeat(64),preserveProfile:true}:req.url==='/messenger/api/workspace/enroll'?{submitted:true,rootCid:'a'.repeat(64),ownerInvite:'fixture-public-owner-invite'}:{workspace:'fixture'}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin='http://127.0.0.1:'+(provider.address() as {port:number}).port;
 try{
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];
  process.env.OURS_FLEET_HOME=dir;const profile=join(dir,'profile.json'),credential=join(dir,'server-credential');writeFileSync(credential,'fixture-server-credential-32-characters\n',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:providerOrigin,endpoint:providerOrigin+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  const config=join(dir,'fleet.yaml');await ensureMinimalSetup(config);
  new WebAccessStore().write({version:1,mode:'pairing'});
  await enrollWorkspace({version:1 as const,appOrigin,hostname:host,rootName:'different@account',name:'New',surname:'Profile',connectorToken:'fixture-connector',invitation:'fixture-invite',serverCid:'b'.repeat(64),challenge:{nonce:'n'.repeat(43),accountId:'c'.repeat(43),workspaceId:'w'.repeat(43),expiresAt:Date.now()+600000}},config,{preserveProfile:true});
  running=await startWebConsole({configPath:config,binPath:process.execPath,port:0,publicOrigin:'https://'+host,control:true});
  const bound=JSON.parse(readFileSync(join(dir,'.ours-fleet','web','workspace-port.json'),'utf8')) as {port:number};
  const origin='http://127.0.0.1:'+bound.port,api=origin+'/fleet/api/v1';
  const code=async()=>{const link=await requestWebControl('link-device');if(!link)throw Error('Expected a device enrollment code');return link as {enrollment:string;workspaceId:string};};

  // A page cannot be handed refresh material, even with a valid link code; the refusal spends nothing.
  const first=await code();
  const fromPage=await call(api+'/devices/enroll',{headers:{Origin:appOrigin,'Sec-Fetch-Site':'cross-site'},body:{...first,label:'Browser',credential:2}});
  expect(fromPage.status).toBe(403);expect(fromPage.text).not.toContain('owr.');
  const enrolled=await call(api+'/devices/enroll',{body:{...first,label:'Browser',credential:2}});
  expect(enrolled.status,enrolled.text).toBe(200);expect(enrolled.headers.get('cache-control')).toBe('no-store');expect(enrolled.headers.get('access-control-allow-origin')).toBeNull();
  const link=enrolled.body as {accessToken:string;refreshToken:string;accessExpiresAt:number;refreshExpiresAt:number;familyExpiresAt:number;device:{id:string};token?:string};
  expect(link.token).toBeUndefined();expect(link.accessToken).toMatch(/^owa\./);expect(link.refreshToken).toMatch(/^owr\./);
  expect(link.accessExpiresAt-Date.now()).toBeLessThanOrEqual(5*60_000);expect(link.familyExpiresAt-link.refreshExpiresAt).toBe(23*86_400_000);

  // The page works with the access credential exactly as it did with the fixed bearer.
  expect((await call(api+'/devices',{headers:page(link.accessToken)})).status).toBe(200);
  const current=await call(api+'/devices/current',{headers:page(link.accessToken)});
  expect(current.body).toEqual({deviceId:link.device.id,authorizedUntil:link.accessExpiresAt});
  expect((await call(origin+'/messenger/api/identity',{headers:page(link.accessToken)})).status).toBe(200);
  // A refresh credential is not an access credential.
  const misuse=await call(api+'/devices',{headers:page(link.refreshToken)});
  expect(misuse.status).toBe(401);expect(misuse.headers.get('x-ours-workspace-auth')).toBe('rejected');

  // Stolen access cannot become lasting authority: no link code, and so nothing to enroll or refresh.
  const escalation=await call(api+'/devices/link',{method:'POST',headers:page(link.accessToken)});
  expect(escalation.status).toBe(403);expect(escalation.text).not.toContain('enrollment');
  expect((await call(api+'/devices/link',{method:'POST',headers:{Authorization:'Bearer '+link.accessToken}})).status).toBe(403);
  expect((await call(api+'/devices/link',{headers:page(link.accessToken),body:{refreshToken:link.refreshToken}})).status).toBe(403);
  expect((await call(api+'/devices/link',{body:{refreshToken:link.accessToken}})).status).toBe(401);
  expect((await call(api+'/devices/refresh',{headers:page(link.accessToken),body:{refreshToken:link.refreshToken}})).status).toBe(403);
  expect((await call(api+'/devices/refresh',{body:{refreshToken:link.accessToken}})).status).toBe(401);
  expect((await call(api+'/devices/refresh',{body:{}})).status).toBe(400);
  // The link is intact after every refused attempt.
  expect((await call(api+'/devices',{headers:page(link.accessToken)})).body.devices.filter((device:{revokedAt:number|null})=>device.revokedAt===null)).toHaveLength(1);

  // The account server links a second browser with the first link's own refresh credential.
  const minted=await call(api+'/devices/link',{body:{refreshToken:link.refreshToken}});
  expect(minted.status,minted.text).toBe(200);
  const child=(await call(api+'/devices/enroll',{body:{enrollment:minted.body.enrollment,workspaceId:minted.body.workspaceId,label:'Second browser',credential:2}})).body as typeof link;
  expect((await call(api+'/devices',{headers:page(child.accessToken)})).status).toBe(200);

  // Rotation: one successor, repeated until it is used; then the spent credential is a replay.
  const rotated=await call(api+'/devices/refresh',{body:{refreshToken:link.refreshToken}});
  expect(rotated.status,rotated.text).toBe(200);expect(rotated.headers.get('cache-control')).toBe('no-store');
  const retried=await call(api+'/devices/refresh',{body:{refreshToken:link.refreshToken}});
  expect(retried.body.refreshToken).toBe(rotated.body.refreshToken);expect(retried.body.refreshExpiresAt).toBe(rotated.body.refreshExpiresAt);
  // The earlier access credential keeps its own deadline beside the new one.
  for(const token of [link.accessToken,rotated.body.accessToken,retried.body.accessToken])expect((await call(api+'/devices',{headers:page(token)})).status).toBe(200);
  const replay=await call(api+'/devices/refresh',{body:{refreshToken:link.refreshToken}});
  expect(replay.status).toBe(401);expect(replay.headers.get('x-ours-workspace-auth')).toBe('rejected');expect(replay.text).not.toContain('owr.');
  for(const token of [link.accessToken,rotated.body.accessToken,child.accessToken]) {
   const dead=await call(origin+'/messenger/api/identity',{headers:page(token)});
   expect(dead.status).toBe(401);expect(dead.headers.get('x-ours-workspace-auth')).toBe('rejected');
  }
  expect((await call(api+'/devices/refresh',{body:{refreshToken:rotated.body.refreshToken}})).status).toBe(401);
  expect((await call(api+'/devices/refresh',{body:{refreshToken:child.refreshToken}})).status).toBe(401);

  // Sign-out names the link by the hash of its refresh credential; a page cannot, and a hash cannot refresh.
  const third=(await call(api+'/devices/enroll',{body:{...(await code()),label:'Third',credential:2}})).body as typeof link;
  expect((await call(api+'/devices/revoke',{headers:{Origin:appOrigin},body:{refreshHash:sha(third.refreshToken)}})).status).toBe(403);
  expect((await call(api+'/devices/refresh',{body:{refreshToken:sha(third.refreshToken)}})).status).toBe(401);
  expect((await call(api+'/devices/revoke',{body:{refreshHash:sha('owr.unknown')}})).body).toEqual({revoked:false});
  expect((await call(api+'/devices/revoke',{body:{refreshHash:sha(third.refreshToken)}})).body).toEqual({revoked:true});
  expect((await call(api+'/devices',{headers:page(third.accessToken)})).status).toBe(401);
  // Signing out with the access credential ends the link as before.
  const fourth=(await call(api+'/devices/enroll',{body:{...(await code()),label:'Fourth',credential:2}})).body as typeof link;
  expect((await call(api+'/auth/logout',{method:'POST',headers:page(fourth.accessToken)})).status).toBeLessThan(300);
  expect((await call(api+'/devices/refresh',{body:{refreshToken:fourth.refreshToken}})).status).toBe(401);

  // A fixed bearer of an earlier App version: still linked by the page, exchanged once by the account server.
  const legacy=(await call(api+'/devices/enroll',{headers:{Origin:appOrigin,'Sec-Fetch-Site':'cross-site'},body:{...(await code()),label:'Old App'}})).body as {token:string;device:{id:string}};
  expect(legacy.token).toMatch(/^[\w-]{43}\.[\w-]{43}$/);
  expect((await call(api+'/devices',{headers:page(legacy.token)})).status).toBe(200);
  expect((await call(api+'/devices/exchange',{method:'POST',headers:page(legacy.token)})).status).toBe(403);
  const exchanged=await call(api+'/devices/exchange',{method:'POST',headers:{Authorization:'Bearer '+legacy.token}});
  expect(exchanged.status,exchanged.text).toBe(200);expect(exchanged.body.device.id).toBe(legacy.device.id);
  const spent=await call(api+'/devices',{headers:page(legacy.token)});
  expect(spent.status).toBe(401);expect(spent.headers.get('x-ours-workspace-auth')).toBe('rejected');
  expect((await call(api+'/devices/exchange',{method:'POST',headers:{Authorization:'Bearer '+legacy.token}})).status).toBe(401);
  expect((await call(api+'/devices',{headers:page(exchanged.body.accessToken)})).status).toBe(200);
  expect((await call(api+'/devices/exchange',{method:'POST',headers:{Authorization:'Bearer '+exchanged.body.accessToken}})).status).toBe(401);
 }finally{await running?.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);rmSync(dir,{recursive:true,force:true});}
},30000);
