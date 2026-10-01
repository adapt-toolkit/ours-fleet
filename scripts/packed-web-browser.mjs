// Hosted-only acceptance of the installed package's real frontend and auth API.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import https from 'node:https';
const consumer=resolve(process.argv[2]),playwrightModule=resolve(process.argv[3]);
const {chromium}=await import(pathToFileURL(playwrightModule));
const packaged=join(consumer,'node_modules/@ours.network/fleet/dist');
const {buildWebServer}=await import(pathToFileURL(join(packaged,'web/server.js')));
const {WebAuth}=await import(pathToFileURL(join(packaged,'web/auth.js')));
const {WorkspaceDeviceStore}=await import(pathToFileURL(join(packaged,'web/workspace-devices.js')));
const dir=mkdtempSync(join(tmpdir(),'packed-fleet-browser-'));
const appOrigin='https://app.ours-tunnel.com',workspaceOrigin='https://packed-fixture.ours-tunnel.com';
const store=new WorkspaceDeviceStore(join(dir,'devices')),code=store.mint();
const enrolled=store.enroll(code.enrollment,code.workspaceId,'Hosted Chromium');
const auth=new WebAuth(workspaceOrigin,new URL(workspaceOrigin).host,Date.now,undefined,{version:1,mode:'pairing'},store,appOrigin);
const server=await buildWebServer({configuration:{read:()=>({revision:'fixture',model:{brains:{},agents:{},agent_templates:{}})}},{origin:workspaceOrigin,host:auth.host},{auth});
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=packed-fixture.ours-tunnel.com'],{stdio:'ignore'});
let browser;const observed=[];
const tls=https.createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},async(req,res)=>{
 if(req.headers.host===new URL(appOrigin).host){
  res.setHeader('Content-Type','text/html');
  return res.end(`<iframe title="Packed Fleet" src="${workspaceOrigin}/fleet?workspace-frame=1&account-origin=${encodeURIComponent(appOrigin)}"></iframe><script>
  window.expired=false;addEventListener('message',event=>{if(event.origin!==${JSON.stringify(workspaceOrigin)} || event.source!==document.querySelector('iframe').contentWindow)return;
   if(event.data.type==='ours.workspace.ready')event.source.postMessage({type:'ours.workspace.authorize',nonce:event.data.nonce,token:${JSON.stringify(enrolled.token)},context:{activeId:'fixture',workspaces:[{id:'fixture',name:'Packed workspace',linked:true,status:'ready'}]}},event.origin);
   if(event.data.type==='ours.workspace.expired')window.expired=true;
  });</script>`);
 }
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const url=req.url.replace(/^\/fleet\/api\//,'/api/');
 if(url.startsWith('/api/'))observed.push({url,authorized:req.headers.authorization==='Bearer '+enrolled.token});
 const result=await server.app.inject({method:req.method,url,headers:req.headers,payload:chunks.length?Buffer.concat(chunks):undefined});
 res.writeHead(result.statusCode,result.headers);res.end(result.rawPayload);
});
try{
 await new Promise((resolve,reject)=>{tls.once('error',reject);tls.listen(0,'127.0.0.1',resolve);});
 const port=tls.address().port;
 browser=await chromium.launch({args:['--ignore-certificate-errors','--no-proxy-server',`--host-resolver-rules=MAP app.ours-tunnel.com 127.0.0.1:${port}, MAP packed-fixture.ours-tunnel.com 127.0.0.1:${port}`,'--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests']});
 const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.goto(appOrigin);
 const frame=page.frameLocator('iframe');
 await frame.getByRole('heading',{name:'Connect your agent accounts'}).waitFor();
 await frame.getByRole('button',{name:'Switch workspace',exact:true}).click();
 await frame.getByRole('dialog',{name:'Workspaces',exact:true}).getByRole('button',{name:'Packed workspace',exact:true}).waitFor();
 const child=page.frames().find(frame=>frame.url().startsWith(workspaceOrigin));assert.ok(child);
 assert.equal(await child.evaluate(async()=>{const res=await fetch('/fleet/api/v1/meta');return res.status;}),200);
 assert.ok(observed.some(item=>item.url==='/api/v1/meta' && item.authorized));
 const artifacts=resolve('test-artifacts/packed-web');mkdirSync(artifacts,{recursive:true});
 for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
  await page.setViewportSize({width,height});
  await page.locator('iframe').evaluate(node=>{node.style.cssText='border:0;width:100vw;height:100vh';document.body.style.margin='0';});
  await page.screenshot({path:join(artifacts,name+'.png'),fullPage:true});
 }
 assert.deepEqual(errors,[]);
 assert.equal(await child.evaluate(async id=>(await fetch('/fleet/api/v1/devices/'+id,{method:'DELETE'})).status,enrolled.device.id),200);
 assert.equal(await child.evaluate(async()=>(await fetch('/fleet/api/v1/meta')).status),401);
 await page.waitForFunction(()=>window.expired===true);
 process.stdout.write('Installed packaged Fleet rendered, completed frame authorization/service-worker setup, authenticated its real API and rejected the revoked device.\n');
}finally{await browser?.close();tls.closeAllConnections();await new Promise(resolve=>tls.close(resolve));await server.close();rmSync(dir,{recursive:true,force:true});}
