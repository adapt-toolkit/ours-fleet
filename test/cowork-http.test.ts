import { test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
import { readClientProfile } from '../src/client-profile.js';
const roots: string[] = [], servers: Server[] = [];
afterEach(async()=>{for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
async function fixture({wrongInstance=false,redirect=false,badToken=false,mode='normal'}={}) {
  const root=mkdtempSync(join(tmpdir(),'fleet-http-'));roots.push(root);
  const id='11111111-2222-3333-4444-555555555555';
  const requests: string[]=[];
  const server=createServer((req,res)=>{
    requests.push(req.url!);res.setHeader('content-type','application/json');
    if(req.url==='/base/daemon/selection')return res.end(JSON.stringify({schema:1,instanceId:wrongInstance?'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee':id,capabilities:['external-sessions-v1']}));
    if(req.headers['x-ours-api-token']!=='test-issued'){res.statusCode=401;return res.end('{}');}
    if(req.url!=='/base/cowork/management/rpc'){res.statusCode=404;return res.end('{}');}
    if(redirect){res.statusCode=302;res.setHeader('location','/redirected');return res.end();}
    let body='';req.on('data',b=>body+=b);req.on('end',()=>{
      const rpc=JSON.parse(body);
      if(mode==='timeout')return;
      if(mode==='oversized')return res.end('x'.repeat(4*1024*1024+1));
      if(mode==='malformed')return res.end('not-json');
      if(mode==='wrong-id')return res.end(JSON.stringify({version:1,id:'wrong',result:[]}));
      if(mode==='error'){res.statusCode=400;return res.end(JSON.stringify({version:1,id:rpc.id,error:{code:'invalid_state',message:'fixture refusal'}}));}
      res.end(JSON.stringify({version:1,id:rpc.id,result:rpc.method==='room.list'?[]:{identity:'A'.repeat(64),state:'pending'}}));
    });
  });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const profilePath=join(root,'profile.json'),credentialPath=join(root,'credential');
  writeFileSync(credentialPath,badToken?'wrong':'test-issued',{mode:0o600});
  writeFileSync(profilePath,JSON.stringify({endpoint:origin+'/base/daemon',serverUrl:origin+'/base',expectedInstanceId:id,credentialPath}),{mode:0o600});
  return {root,env:{OURS_CONFIG:profilePath},requests,origin};
}
test('one server profile retains the daemon prefix and selects authenticated HTTP room management',async()=>{
  const f=await fixture();expect(readClientProfile(f.env)?.endpoint).toBe(f.origin+'/base/daemon');
  const adapter=createCoworkAdapter({env:f.env,home:f.root});expect(await adapter.listRooms()).toEqual([]);
  expect(await adapter.acceptInvite('room','private-test-invite',{role:'Critic'})).toMatchObject({seat_cid:'A'.repeat(64),seat_state:'pending'});
  expect(f.requests).toEqual(['/base/daemon/selection','/base/cowork/management/rpc','/base/daemon/selection','/base/cowork/management/rpc']);
});
test.each([{wrongInstance:true},{redirect:true},{badToken:true}])('fails closed without alternate socket or replay: %j',async options=>{
  const f=await fixture(options);await expect(createCoworkAdapter({env:f.env,home:f.root}).listRooms()).rejects.toThrow();
  expect(f.requests.filter(p=>p.endsWith('/rpc')).length).toBeLessThanOrEqual(1);
  expect(f.requests).not.toContain('/redirected');
  if(options.wrongInstance)expect(f.requests).toEqual(['/base/daemon/selection']);
});

test.each(['timeout','oversized','malformed','wrong-id','error'])('bounds failed mutation without replay: %s', async mode => {
  const f=await fixture({mode});
  const adapter=createCoworkAdapter({env:f.env,home:f.root,timeoutMs:mode==='timeout'?50:2000});
  await expect(adapter.closeRoom('fixture')).rejects.toThrow();
  expect(f.requests.filter(p=>p.endsWith('/rpc'))).toHaveLength(1);
});
test('oversized request is rejected before contacting the server',async()=>{
  const f=await fixture();
  await expect(createCoworkAdapter({env:f.env,home:f.root}).createRoom({room_name:'fixture',goal:'x'.repeat(1024*1024),briefing:''})).rejects.toThrow('request exceeded');
  expect(f.requests).toEqual([]);
});
test('explicit local socket override skips malformed remote profile',async()=>{
  const f=await fixture();writeFileSync(f.env.OURS_CONFIG,'not-json',{mode:0o600});
  const adapter=createCoworkAdapter({env:f.env,home:f.root,socketPath:join(f.root,'missing.sock')});
  await expect(adapter.listRooms()).rejects.toThrow('socket');
  expect(f.requests).toEqual([]);
});
