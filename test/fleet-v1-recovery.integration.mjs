// Actual OwnerChannel + OursSdkClient + installed V1 SDK + packed CLI daemon.
// Network-disabled Docker only. Session seam never invokes an authenticated AI harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
import { OursSdkClient } from '../dist/owner-channel/ours-client.js';
import { OwnerChannel } from '../dist/owner-channel/channel.js';
import { createMonitor } from '../dist/monitor.js';

const mode = process.argv[2] ?? 'retry';
assert(['retry','terminal-after-failure','terminal-release-failure'].includes(mode));
const daemonCli = process.env.FLEET_DAEMON_CLI ?? 'node_modules/@ours.network/cli/dist/cli.js';
const tokenUpdateCli = process.env.FLEET_TOKEN_CLI ?? 'node_modules/@ours.network/cli/dist/cli.js';
const root = mkdtempSync(join(tmpdir(), 'fleet-v1-recovery-'));
const daemonState = join(root, 'daemon'), fleetState = join(root, 'fleet');
const hostState = join(root, 'host'), deliveryState = join(root, 'delivery');
mkdirSync(daemonState, { mode: 0o700 }); mkdirSync(fleetState, { mode: 0o700 });
mkdirSync(hostState, { mode: 0o700 }); mkdirSync(deliveryState, { mode: 0o700 });
const port = await new Promise(resolve => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1', () => {
    const port = socket.address().port; socket.close(() => resolve(port));
  });
});
const daemonEndpoint = 'http://127.0.0.1:' + port, expectedInstanceId = randomUUID();
const credentialPath = join(hostState, 'daemon-token');
const deliveryPath = join(deliveryState, 'daemon-token');
const daemonConfigPath = join(daemonState, 'daemon-config.json');
const profilePath = join(hostState, 'client.json');
writeFileSync(daemonConfigPath, JSON.stringify({
  stateDir: daemonState, port, apiVisibility: 'owner', apiTokenDeliveryFiles: [deliveryPath],
}) + '\n', { mode: 0o600 });
const daemonEnv = {
  ...process.env, OURS_STATE_DIR: daemonState, OURS_PORT: String(port),
  OURS_DAEMON_ID: expectedInstanceId, OURS_API_VISIBILITY: 'owner',
  OURS_BROKER_URL: 'wss://invalid.local/none',
  OURS_CONFIG: daemonConfigPath,
};
for (const key of ['OURS_API_TOKEN','OURS_TLS_CERT','OURS_TLS_KEY','OURS_LISTEN_HOST']) delete daemonEnv[key];
const fleetEnv = { OURS_CONFIG: profilePath };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let daemon, daemonExit, daemonOutput = '', control, sibling, channel, adapter, successor, proxy, monitor;
const attached = [], ids = [];
async function startDaemon() {
  daemonOutput = '';
  daemon = spawn(process.execPath, [daemonCli,'daemon','serve','--managed'],
    { env: daemonEnv, stdio: ['ignore','pipe','pipe'] });
  daemonExit = once(daemon, 'exit');
  for (const stream of [daemon.stdout,daemon.stderr]) stream.on('data', data => { daemonOutput = (daemonOutput + data).slice(-12000); });
  const deadline = Date.now()+180000;
  while (Date.now()<deadline) {
    assert.equal(daemon.exitCode, null, daemonOutput);
    try {
      const response = await fetch(daemonEndpoint+'/selection', {signal:AbortSignal.timeout(500)});
      if (response.ok && (await response.json()).instanceId === expectedInstanceId) return;
    } catch {}
    await pause(100);
  }
  throw new Error('daemon readiness timeout: '+daemonOutput);
}
async function stopDaemon(signal='SIGTERM') {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill(signal);
  const timer=setTimeout(()=>daemon.kill('SIGKILL'),7000);
  await daemonExit; clearTimeout(timer);
}
const names = async () => (await control.listIdentities()).map(x=>x.name).sort();
const identity = name => ({name,bio:'',exposeLocal:false,localAutoAccept:true});
const expectedNames = ['FleetOwnerTempA','FleetOwnerTempB','RecoveryRoot','SiblingTemp'].sort();
const watchdog=setTimeout(()=>{daemon?.kill('SIGKILL');process.exit(124);},360000);
try {
  await startDaemon();
  copyFileSync(join(daemonState, 'daemon-token'), deliveryPath);
  copyFileSync(join(daemonState, 'daemon-token'), credentialPath);
  let dropUpdateResponse = true;
  proxy = createHttpServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(daemonEndpoint + request.url, {
        method: request.method, headers: request.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual',
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.url === '/api-token/update' && upstream.status === 200 && dropUpdateResponse) {
        dropUpdateResponse = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      });
      response.end(bytes);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + proxy.address().port;
  writeFileSync(profilePath, JSON.stringify({ endpoint, expectedInstanceId, credentialPath }) + '\n',
    { mode: 0o600 });
  const runTokenUpdate = async (extra = []) => {
    const env = { ...process.env, OURS_CONFIG: profilePath };
    for (const key of Object.keys(env)) if (key.startsWith('OURS_') && key !== 'OURS_CONFIG') delete env[key];
    const child = spawn(process.execPath, [
      tokenUpdateCli, 'config', 'token-update',
      '--config', profilePath, '--json', ...extra,
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve); child.once('error', reject);
    });
    return { code, stdout, stderr, json: stdout.trim() ? JSON.parse(stdout) : null };
  };
  control=await attachOursClient({endpoint,expectedInstanceId,credentialPath,requiredCapabilities:['local-pid-v1'],env:{}});
  const created=await control.createRootIdentity({...identity('RecoveryRoot'),skipIfRootExists:false});
  await control.releaseLease();
  sibling=await attachOursClient({endpoint,expectedInstanceId,credentialPath,sessionMode:'external',leaseToken:randomUUID(),env:{}});
  await sibling.createTemporaryIdentity(identity('SiblingTemp'));
  adapter=new OursSdkClient(fleetEnv,()=>undefined,{
    attachClient:async options=>{
      ids.push(options.leaseToken);
      const client=await attachOursClient(options); attached.push(client); return client;
    },
  });
  await adapter.start();
  await attached.at(-1).createTemporaryIdentity(identity('FleetOwnerTempA'));
  await attached.at(-1).createTemporaryIdentity(identity('FleetOwnerTempB'));
  await adapter.bindIdentity('RecoveryRoot');
  const channelConfig={identity:'RecoveryRoot',owners:[created.cid],interrupt:false,progress_interval_ms:0};
  channel=new OwnerChannel({
    role:'RecoveryRole',harness:'codex',
    config:channelConfig,
    session:{
      backend:'acp',pid:process.pid,isAlive:()=>true,
      snapshot:()=>({backend:'acp',alive:true,readiness:'running'}),
      eventsSince:()=>[],
      queuePrompt:()=>{throw new Error('native harness must not run');},
      interrupt:async()=>({state:'settled'}),
    },
    stateDir:fleetState,client:adapter,log:()=>undefined,
    prepareRestart:async()=>{throw new Error('native harness restart must not run');},
  });
  await channel.start(); await channel.drain();
  assert.deepEqual(await names(),expectedNames);
  assert((await attached.at(-1).listSelfCommands()).length>0,'real typed catalog registered');
  const ownerId=ids[0];

  const monitorDir=join(fleetState,'monitor');mkdirSync(monitorDir,{mode:0o700});
  const monitorDeliveries=[];
  monitor=createMonitor({
    name:'RecoveryMonitor',identity:'RecoveryRoot',agentDir:monitorDir,
    cfg:{mode:'fleet',enabled:true,wake_sources:['message_received','file_received','local_contact_request','pending_message'],batch_ms:0,inject:'notification',interrupt:false},
    deps:{
      fetch:async()=>{throw new Error('explicit monitor must not use legacy fetch');},
      isAlive:()=>true,sleep:pause,now:Date.now,log:()=>undefined,env:fleetEnv,
      timers:{set:setTimeout,clear:clearTimeout},
      delivery:{submit:async text=>{monitorDeliveries.push(text);monitor.stop();return{succeeded:true,outcome:'completed'};}},
    },
  });
  await monitor.prime();
  const cursorBefore=JSON.parse(readFileSync(join(monitorDir,'.monitor-state.json'),'utf8')).deliveredCursor;
  assert.equal(typeof cursorBefore,'number');
  const originalToken=readFileSync(credentialPath,'utf8').trim();
  const lost=await runTokenUpdate();
  assert.equal(lost.code,1,lost.stderr||lost.stdout);
  assert.equal(lost.json.status,'incomplete');
  assert.equal(readFileSync(credentialPath,'utf8').trim(),originalToken,
    'host file remains old while daemon authority has already changed');
  assert.notEqual(readFileSync(join(daemonState,'daemon-token'),'utf8').trim(),originalToken,
    JSON.stringify(lost.json));
  assert.equal((await fetch(endpoint+'/version',{headers:{authorization:`Bearer ${originalToken}`}})).status,401,
    'old credential is denied during the authority-to-file publication gap');

  const monitorRun=monitor.run(process.pid);
  const authDeadline=Date.now()+15000;
  while (Date.now()<authDeadline) {
    if (existsSync(join(monitorDir,'.monitor-status'))
        && readFileSync(join(monitorDir,'.monitor-status'),'utf8').includes('auth')) break;
    await pause(50);
  }
  assert(readFileSync(join(monitorDir,'.monitor-status'),'utf8').includes('auth'),
    'monitor reports the temporary file-backed authentication gap');
  const resumed=await runTokenUpdate();
  assert.equal(resumed.code,0,resumed.stderr||resumed.stdout);
  assert.equal(resumed.json.status,'complete');
  const rotatedToken=readFileSync(credentialPath,'utf8').trim();
  assert.notEqual(rotatedToken,originalToken);
  assert.equal((await fetch(endpoint+'/version',{headers:{authorization:`Bearer ${rotatedToken}`}})).status,200);
  assert.equal((lost.stdout+lost.stderr+resumed.stdout+resumed.stderr).includes(originalToken),false);
  assert.equal((lost.stdout+lost.stderr+resumed.stdout+resumed.stderr).includes(rotatedToken),false);

  const invite=await adapter.generateInvite('monitor-refresh');
  const contact=await sibling.addContact({invite:invite.blob,name:'RecoveryRoot'});
  await sibling.sendMessage({contact:contact.cid,text:'credential refresh notification'});
  await monitorRun;
  assert.equal(monitorDeliveries.length,1,'built monitor receives a notification after file publication');
  const monitorState=JSON.parse(readFileSync(join(monitorDir,'.monitor-state.json'),'utf8'));
  assert(monitorState.deliveredCursor>cursorBefore,'monitor advances the retained byte cursor');
  assert.equal(monitorState.profileKey,endpoint+'#'+expectedInstanceId);
  assert.match(readFileSync(join(monitorDir,'.monitor-status'),'utf8'),/^armed at /);
  assert(ids.every(id=>id===ownerId),'token update keeps the owner lease ID');
  assert.equal((await adapter.getMessages(1)).messages.length,1,
    'same owner channel reads the message after credential replacement');
  console.log('PASS explicit profile token update: temporary 401 recovered, same owner and cursor retained, notification delivered');

  const wrongProfilePath=join(hostState,'wrong-client.json');
  writeFileSync(wrongProfilePath,JSON.stringify({
    endpoint,expectedInstanceId:randomUUID(),credentialPath,
  })+'\n',{mode:0o600});
  const wrongClient=new OursSdkClient({OURS_CONFIG:wrongProfilePath},()=>undefined);
  await assert.rejects(()=>wrongClient.start(),/selection metadata.*mismatch/i);
  assert.equal((await adapter.getMessages(1)).messages.length,0);
  console.log('PASS wrong selected UUID refuses without default-daemon fallback');

  const firstBoot=(await control.version({startup:true})).startup.bootId;
  try {
    await channel.recover('transport-reconnect');
  } catch (error) {
    console.log(JSON.stringify({stage:'actual-channel-recover',code:error.code,
      remainingIdentities:await names()}));
    throw error;
  }
  assert(ids.every(id=>id===ownerId),'transport reconnect must retain the exact owner ID');
  assert.deepEqual(await names(),expectedNames,'ordinary recovery preserves owner temporaries, root and sibling');
  assert.equal((await attached.at(-1).currentIdentity()).name,'RecoveryRoot');
  assert((await attached.at(-1).listSelfCommands()).length>0);
  console.log('PASS actual OwnerChannel transport recovery: same owner ID, binding, typed catalog and all identities preserved');

  channelConfig.identity='MissingRecoveryIdentity';
  await assert.rejects(()=>channel.recover('failed-bind'),error=>error.code==='NO_SUCH_IDENTITY');
  assert.deepEqual(await names(),expectedNames,'failed recovery must not terminally release ownership');
  if (mode === 'terminal-after-failure') {
    await channel.close();
    assert.deepEqual(await names(),['RecoveryRoot','SiblingTemp'],
      'immediate terminal close after failed recovery must release retained owner temporaries');
    assert.equal(JSON.parse(readFileSync(join(fleetState,'.owner-channel-shutdown.json'),'utf8')).state,'closed');
    console.log('PASS immediate terminal close after failed recovery releases exact retained owner without successful rebind');
  } else if (mode === 'terminal-release-failure') {
    fleetEnv.OURS_API_TOKEN='deliberately-invalid-fixture-token';
    await channel.close();
    assert.deepEqual(await names(),expectedNames);
    assert.equal(channel.binderReleaseSafe(),false);
    assert.equal(JSON.parse(readFileSync(join(fleetState,'.owner-channel-shutdown.json'),'utf8')).state,'degraded',
      'failed terminal release must not be reported closed');
    delete fleetEnv.OURS_API_TOKEN;
    await adapter.close(); // Explicit later cleanup, no automatic retry controller.
    assert.deepEqual(await names(),['RecoveryRoot','SiblingTemp']);
    console.log('PASS rejected terminal release is degraded and preserves ownership; explicit later close releases the same owner');
  } else {
  channelConfig.identity='RecoveryRoot';
  await channel.recover('retry-bind');
  assert(ids.every(id=>id===ownerId));
  assert.deepEqual(await names(),expectedNames);
  console.log('PASS actual failed bind/retry preserves owner ID and temporaries');

  await stopDaemon('SIGKILL'); await startDaemon();
  const secondBoot=(await control.version({startup:true})).startup.bootId;
  assert.notEqual(secondBoot,firstBoot);
  await channel.recover('daemon-restart');
  assert(ids.every(id=>id===ownerId),'daemon restart recovery keeps the same owner ID');
  assert.deepEqual(await names(),expectedNames);
  assert.equal((await attached.at(-1).currentIdentity()).name,'RecoveryRoot');
  assert.equal((await adapter.getMessages(1)).messages.length,0);
  assert((await attached.at(-1).listSelfCommands()).length>0);
  assert.equal((await sibling.currentIdentity()).name,'SiblingTemp');
  console.log('PASS actual daemon SIGKILL/restart plus OwnerChannel recovery: changed boot ID, unchanged owner ID and independent sibling');
  }

  await channel.close();
  assert.deepEqual(await names(),['RecoveryRoot','SiblingTemp']);
  let successorId;
  successor=new OursSdkClient(fleetEnv,()=>undefined,{
    attachClient:async options=>{successorId=options.leaseToken;return attachOursClient(options);},
  });
  await successor.start(); await successor.bindIdentity('RecoveryRoot');
  assert.notEqual(successorId,ownerId,'terminal successor has a fresh ID');
  await adapter.start();
  await assert.rejects(()=>adapter.bindIdentity('RecoveryRoot'),error=>error.code==='BINDING_REASSIGNED');
  await adapter.close();
  assert.equal((await successor.getMessages(1)).messages.length,0);
  assert.equal((await sibling.currentIdentity()).name,'SiblingTemp');
  assert.deepEqual(await names(),['RecoveryRoot','SiblingTemp']);
  console.log('PASS terminal close removes only owned temporaries; fresh successor binds, retired predecessor cannot revive or disturb sibling');
} catch (error) {
  console.error('Actual recovery scenario failed:', error);
  console.error('Last daemon diagnostics:', daemonOutput);
  throw error;
} finally {
  monitor?.stop();
  await channel?.close();
  // Best-effort teardown must not mask the scenario's primary failure.
  await adapter?.close().catch(() => undefined);
  await successor?.close().catch(() => undefined);
  await sibling?.releaseLease().catch(()=>undefined);
  await sibling?.close(); await control?.close();
  if (proxy) {
    proxy.closeAllConnections?.();
    await new Promise(resolve=>proxy.close(resolve));
  }
  await stopDaemon(); clearTimeout(watchdog);
  rmSync(root,{recursive:true,force:true});
}
