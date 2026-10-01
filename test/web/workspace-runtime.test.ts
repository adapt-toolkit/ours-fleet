import {it,expect} from 'vitest';
import {createServer,request} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {startWebConsole} from '../../src/web/runtime.js';
import {writeV2Fixture} from '../v2-fixture.js';
import {WebAccessStore} from '../../src/web/access.js';
import {enrollWorkspace} from '../../src/workspace-enrollment.js';
import {WorkspaceDeviceStore} from '../../src/web/workspace-devices.js';
async function browserRequest(url:string,options:{method?:string;headers?:Record<string,string>;body?:string}={}) {
 return new Promise<Response>((resolve,reject)=>{const req=request(url,{method:options.method,headers:options.headers},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers as Record<string,string>})));res.on('error',reject);});req.on('error',reject);req.end(options.body);});
}
it.each(['https://app.ours.network','https://app.ours-tunnel.com'])('runs %s native public workspace gateway with protected services and a public static iframe shell',async(appOrigin)=>{
 const dir=mkdtempSync(join(tmpdir(),'workspace-runtime-')),previous={...process.env};let running:Awaited<ReturnType<typeof startWebConsole>>|undefined;
 const observed:Array<Record<string,unknown>>=[];
 const provider=createServer((req,res)=>{observed.push({url:req.url,authorization:req.headers.authorization,token:req.headers['x-ours-api-token'],origin:req.headers.origin,csrf:req.headers['x-ours-messenger-csrf']});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({workspace:'fixture'}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin='http://127.0.0.1:'+(provider.address() as {port:number}).port;
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
 try{
  for(const key of ['OURS_PORT','OURS_STATE_DIR','OURS_API_TOKEN','OURS_DAEMON_ID','OURS_DAEMON_URL','OURS_DAEMON_CREDENTIAL_PATH'])delete process.env[key];
  process.env.OURS_FLEET_HOME=dir;const profile=join(dir,'profile.json'),credential=join(dir,'server-credential');writeFileSync(credential,'fixture-server-credential-32-characters\n',{mode:0o600});writeFileSync(profile,JSON.stringify({serverUrl:providerOrigin,endpoint:providerOrigin+'/daemon',expectedInstanceId:'12345678-1234-1234-1234-123456789abc',credentialPath:credential}),{mode:0o600});process.env.OURS_CONFIG=profile;
  mkdirSync(join(dir,'.ours-fleet','workspace'),{recursive:true,mode:0o700});writeFileSync(join(dir,'.ours-fleet','workspace','binding.json'),JSON.stringify({appOrigin}),{mode:0o600});
  const config=join(dir,'fleet.yaml');writeV2Fixture(config,{roles:{}});const staticRoot=join(dir,'static');mkdirSync(staticRoot);writeFileSync(join(staticRoot,'fleet-index.html'),'<html>workspace fixture shell</html>');writeFileSync(join(staticRoot,'index.html'),'<html>workspace fixture shell</html>');
  const access=new WebAccessStore();access.write({version:1,mode:'none'});
  await expect(enrollWorkspace({} as Parameters<typeof enrollWorkspace>[0],config)).rejects.toThrow('requires protected web access');
  expect(observed.length).toBe(0);access.write({version:1,mode:'pairing'});
  running=await startWebConsole({configPath:config,binPath:process.execPath,port,publicOrigin:'https://fixture.ours-tunnel.com',open:false,control:false,staticRoot});
  const origin='http://127.0.0.1:'+port,host='fixture.ours-tunnel.com';
  const devices=new WorkspaceDeviceStore(join(dir,'.ours-fleet','web'));const link=devices.mint();devices.close();
  const enrolled=await browserRequest(origin+'/fleet/api/v1/devices/enroll',{method:'POST',headers:{Host:host,Origin:appOrigin,'Content-Type':'application/json','Sec-Fetch-Site':'cross-site'},body:JSON.stringify({...link,label:'Browser fixture'})});expect(enrolled.status, enrolled.status===200?undefined:await enrolled.clone().text()).toBe(200);const first=await enrolled.json() as {token:string;device:{id:string}};
  const opposite=appOrigin==='https://app.ours.network'?'https://app.ours-tunnel.com':'https://app.ours.network';
  expect((await browserRequest(origin+'/fleet/api/v1/devices',{headers:{Host:host,Origin:opposite,Authorization:'Bearer '+first.token}})).status).toBe(403);
  const headers={Host:host,Origin:'https://fixture.ours-tunnel.com',Authorization:'Bearer '+first.token};
  const shell=await browserRequest(origin+'/fleet?workspace-frame=1',{headers:{Host:host,'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe'}});expect(shell.status,shell.status===200?undefined:await shell.clone().text()).toBe(200);expect(await shell.text()).toContain('fixture shell');expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'self' "+appOrigin);
  expect((await browserRequest(origin+'/fleet',{headers:{Host:host,'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'iframe'}})).status).toBe(403);
  expect((await browserRequest(origin+'/messenger/api/identity',{headers:{Host:host}})).status).toBe(401);
  expect((await browserRequest(origin+'/fleet/api/v1/devices',{headers})).status).toBe(200);
  const upstream=await browserRequest(origin+'/messenger/api/workspace/enroll',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});expect(upstream.status).toBe(200);
  expect(observed.at(-1)).toEqual({url:'/messenger/api/workspace/enroll',authorization:undefined,token:'fixture-server-credential-32-characters',origin:providerOrigin,csrf:'1'});
  expect((await browserRequest(origin+'/messenger/api/identity',{headers:{...headers,Authorization:'Bearer invalid'}})).status).toBe(401);
  const linked=await browserRequest(origin+'/fleet/api/v1/devices/link',{method:'POST',headers});expect(linked.status).toBe(200);const secondLink=await linked.json();
  const secondResponse=await browserRequest(origin+'/fleet/api/v1/devices/enroll',{method:'POST',headers:{Host:host,Origin:appOrigin,'Content-Type':'application/json'},body:JSON.stringify({...secondLink,label:'Second browser'})});const second=await secondResponse.json();
  expect((await browserRequest(origin+'/fleet/api/v1/devices/'+first.device.id,{method:'DELETE',headers})).status).toBe(200);
  expect((await browserRequest(origin+'/messenger/api/identity',{headers})).status).toBe(401);
  expect((await browserRequest(origin+'/messenger/api/identity',{headers:{...headers,Authorization:'Bearer '+second.token}})).status).toBe(200);
 }finally{await running?.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);rmSync(dir,{recursive:true,force:true});}
},30000);
