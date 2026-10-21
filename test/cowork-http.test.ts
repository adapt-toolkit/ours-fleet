import { test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoworkAdapter, CoworkProtocolError, CoworkUnavailableError } from '../src/rooms-tasks/cowork-adapter.js';
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
      if(mode==='gateway502'){res.statusCode=502;res.setHeader('content-type','text/html; charset=utf-8');return res.end('<html><head><title>502 Bad Gateway</title></head><body>private-room-label</body></html>');}
      if(mode==='rpc503'){res.statusCode=503;return res.end(JSON.stringify({version:1,id:rpc.id,error:{code:'not_ready',message:'fixture warming up'}}));}
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
test('explicit local socket override cannot bypass malformed gateway profile',async()=>{
  const f=await fixture();writeFileSync(f.env.OURS_CONFIG,'not-json',{mode:0o600});
  expect(()=>createCoworkAdapter({env:f.env,home:f.root,socketPath:join(f.root,'missing.sock')})).toThrow('Local Cowork selectors');
  expect(f.requests).toEqual([]);
});
test('failed cleanup preserves its RPC and timeout stage without leaking request or credential', async () => {
  const f = await fixture({ mode: 'timeout' });
  const adapter = createCoworkAdapter({ env: f.env, home: f.root, timeoutMs: 1000 });
  let error: unknown;
  try { await adapter.deleteRoom('private-room-label'); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/Cowork HTTP room\.delete failed during management (request|response) \(timeout\)/);
  expect((error as Error).message).not.toMatch(/private-room-label|test-issued|127\.0\.0\.1|credential/);
  expect(f.requests.filter(path => path.endsWith('/rpc'))).toHaveLength(1);
});
test('credential rejection remains an explicit protocol error instead of an inferred transport diagnosis', async () => {
  const f = await fixture({ badToken: true });
  const adapter = createCoworkAdapter({ env: f.env, home: f.root });
  await expect(adapter.deleteRoom('fixture')).rejects.toMatchObject({ name: 'CoworkProtocolError', code: 'unauthorized' });
  expect(f.requests.filter(path => path.endsWith('/rpc'))).toHaveLength(1);
});

// Boot incidents 2026-10-15/16: a gateway whose Cowork upstream was still
// starting answered nginx's HTML 502 page, which surfaced as "server returned
// malformed JSON" and spent a restart-budget slot as if Cowork were broken.
test('a gateway error page is retryable unavailability with status and media type, never body', async () => {
  const f = await fixture({ mode: 'gateway502' });
  const error = await createCoworkAdapter({ env: f.env, home: f.root }).getRoom('private-room-label').catch(e => e);
  expect(error).toBeInstanceOf(CoworkUnavailableError);
  expect(error.retryable).toBe(true);
  expect(error.message).toBe('Cowork HTTP room.show failed: gateway answered HTTP 502, text/html without an RPC response');
  expect(error.message).not.toMatch(/private-room-label|test-issued|127\.0\.0\.1/);
  expect(f.requests.filter(p => p.endsWith('/rpc'))).toHaveLength(1);
});
test('a malformed 200 stays a non-retryable protocol error and now names its shape', async () => {
  const f = await fixture({ mode: 'malformed' });
  const error = await createCoworkAdapter({ env: f.env, home: f.root }).getRoom('fixture').catch(e => e);
  expect(error).toBeInstanceOf(CoworkProtocolError);
  expect(error.message).toBe('cowork room.show: server returned malformed JSON (HTTP 200, application/json)');
});
test('an RPC error keeps its meaning even under a gateway-unavailable status', async () => {
  const f = await fixture({ mode: 'rpc503' });
  await expect(createCoworkAdapter({ env: f.env, home: f.root }).getRoom('fixture'))
    .rejects.toMatchObject({ name: 'CoworkProtocolError', code: 'not_ready' });
});
test('selection mismatch and credential rejection are never retryable', async () => {
  const wrong = await fixture({ wrongInstance: true });
  const selection = await createCoworkAdapter({ env: wrong.env, home: wrong.root }).getRoom('fixture').catch(e => e);
  expect(selection).toBeInstanceOf(CoworkUnavailableError);
  expect(selection.retryable).toBe(false);
  expect(wrong.requests).toEqual(['/base/daemon/selection']);
  const bad = await fixture({ badToken: true });
  await expect(createCoworkAdapter({ env: bad.env, home: bad.root }).getRoom('fixture'))
    .rejects.toMatchObject({ name: 'CoworkProtocolError', code: 'unauthorized' });
});
test('a gateway that is not listening yet is retryable unavailability', async () => {
  const f = await fixture();
  const server = servers.pop()!;
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  const error = await createCoworkAdapter({ env: f.env, home: f.root }).getRoom('fixture').catch(e => e);
  expect(error).toBeInstanceOf(CoworkUnavailableError);
  expect(error.message).toContain('ECONNREFUSED');
  expect(error.retryable).toBe(true);
});
