// Isolated real daemon + external identity owner + process-lifetime runtime fence.
// Room observation is an explicit admitted-seat fixture backed by real contacts;
// no live Cowork service, authenticated harness, user service, or host reboot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOursClient } from '@ours.network/sdk/client';
import { RuntimeController } from '../dist/agent-ours/controller.js';
import { AgentOursRuntime } from '../dist/agent-ours/runtime.js';
import { binderKey } from '../dist/agent-ours/state.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv[2] === 'member') {
  const f = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const controller = await RuntimeController.acquire(f.runtimeRoot, f.daemon, f.name, f.instance);
  const generation = controller.resumeGeneration();
  const client = await attachOursClient({ endpoint: f.endpoint, expectedInstanceId: f.daemon,
    credentialPath: f.credential, sessionMode: 'external', leaseToken: f.owner, env: {} });
  const prior = controller.journal.read();
  const runtime = new AgentOursRuntime({ instance: f.instance, generation, daemon: f.daemon,
    name: f.name, lifetime: 'temporary', action: f.action, expectedCid: prior?.cid, allowCreate: !prior },
  { journal: controller.journal, client, assertFence: controller.assertFence, now: Date.now, sleep: pause });
  let redeemed = 0;
  await runtime.prepare({ id: 'isolated-room', cid: f.roomCid, seat: 'original-seat', action: 'original-invite',
    redeem: async attached => { redeemed++; return attached.addContact({ invite: f.invite }); },
    observe: async cid => {
      if (prior?.cid && cid !== prior.cid) return 'mismatch';
      const contacts = await client.listContacts();
      return contacts.contacts.some(contact => contact.container_id === f.roomCid) ? 'established' : 'pending';
    }, discardSecret: async () => {},
  });
  process.send({ ready: true, cid: runtime.snapshot.cid, generation, redeemed, instance: f.instance,
    room: runtime.snapshot.room, session: readFileSync(f.session, 'utf8') });
  let closing = false;
  process.on('message', async command => {
    if (closing) return; closing = true;
    try { if (command === 'terminal') await runtime.terminal(); else await runtime.suspend();
      await client.close(); controller.unlock(); process.exit(0);
    } catch { process.exit(2); }
  });
} else {
  const root = mkdtempSync(join(tmpdir(), 'fleet-task-runtime-'));
  const daemonState = join(root, 'daemon'), host = join(root, 'host'), runtimeRoot = join(root, 'runtime');
  for (const path of [daemonState, host, runtimeRoot]) mkdirSync(path, { mode: 0o700 });
  const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => {
    const port = s.address().port; s.close(() => resolve(port)); }); });
  const daemonId = randomUUID(), endpoint = `http://127.0.0.1:${port}`;
  const credential = join(host, 'credential'), config = join(daemonState, 'config.json');
  writeFileSync(config, JSON.stringify({ stateDir: daemonState, port, apiVisibility: 'owner' }), { mode: 0o600 });
  const env = { ...process.env, OURS_CONFIG: config, OURS_STATE_DIR: daemonState,
    OURS_PORT: String(port), OURS_DAEMON_ID: daemonId, OURS_API_VISIBILITY: 'owner', OURS_BROKER_URL: 'wss://invalid.local/none' };
  for (const key of ['OURS_API_TOKEN', 'OURS_TLS_CERT', 'OURS_TLS_KEY', 'OURS_LISTEN_HOST']) delete env[key];
  let daemon, member, control, room, daemonExit;
  let output = '';
  async function startDaemon() {
    daemon = spawn(process.execPath, [process.env.FLEET_DAEMON_CLI ?? 'node_modules/@ours.network/daemon/dist/cli.js', 'daemon', 'serve', '--managed'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemonExit = once(daemon, 'exit');
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', data => { output = (output + data).slice(-12000); });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      assert.equal(daemon.exitCode, null, 'isolated daemon exited');
      try { const r = await fetch(endpoint + '/selection', { signal: AbortSignal.timeout(500) });
        if (r.ok && (await r.json()).instanceId === daemonId) return;
      } catch {}
      await pause(100);
    }
    throw Error('isolated daemon readiness timed out');
  }
  async function stopDaemon() { if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
    daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon.kill('SIGKILL'), 7000);
    await daemonExit; clearTimeout(timer); }
  const watchdog = setTimeout(() => { member?.kill('SIGKILL'); daemon?.kill('SIGKILL'); process.exit(124); }, 240000);
  try {
    await startDaemon(); copyFileSync(join(daemonState, 'daemon-token'), credential);
    const options = { endpoint, expectedInstanceId: daemonId, credentialPath: credential, sessionMode: 'external', env: {} };
    control = await attachOursClient({ ...options, leaseToken: randomUUID() });
    const rootIdentity = await control.createRootIdentity({ name: 'IsolatedTaskRoom', bio: '', exposeLocal: false, localAutoAccept: true, skipIfRootExists: false });
    const invite = await control.generateInvite({ mode: 'one_time' });
    const session = join(host, 'conversation'); writeFileSync(session, 'original-task-conversation', { mode: 0o600 });
    const f = { endpoint, daemon: daemonId, credential, runtimeRoot, name: 'IsolatedTaskMember',
      instance: randomUUID(), action: 'original-task-action', owner: randomUUID(), roomCid: rootIdentity.info.cid, invite: invite.blob, session };
    const fixture = join(host, 'fixture.json'); writeFileSync(fixture, JSON.stringify(f), { mode: 0o600 });
    const startMember = async () => {
      member = spawn(process.execPath, [fileURLToPath(import.meta.url), 'member', fixture], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let childOutput = ''; member.stderr.on('data', value => { childOutput = (childOutput + value).slice(-1000); });
      return await new Promise((resolve, reject) => { member.once('message', resolve);
        member.once('exit', code => reject(Error('member exited before readiness: ' + code + ' ' + childOutput))); });
    };
    const first = await startMember(); assert.equal(first.ready, true); assert.equal(first.redeemed, 1);
    const stopMember = async command => { const exited = once(member, 'exit');
      if (command === 'SIGKILL') member.kill(command); else member.send(command); await exited; };
    await stopMember('suspend');
    assert((await control.listIdentities()).some(row => row.name === f.name && row.cid === first.cid));
    const second = await startMember(); assert.equal(second.cid, first.cid); assert.equal(second.redeemed, 0);
    assert.equal(second.session, first.session); assert.equal(second.instance, first.instance); assert.equal(second.generation, 2);
    await stopMember('SIGKILL');
    await control.close(); control = undefined;
    await stopDaemon(); await startDaemon();
    control = await attachOursClient({ ...options, leaseToken: randomUUID() });
    const third = await startMember(); assert.equal(third.cid, first.cid); assert.equal(third.redeemed, 0);
    assert.deepEqual(third.room, first.room); assert.equal(third.session, first.session); assert.equal(third.generation, 3);
    await stopMember('terminal');
    assert(!(await control.listIdentities()).some(row => row.name === f.name || row.cid === first.cid));
    const state = JSON.parse(readFileSync(join(runtimeRoot, binderKey(daemonId, f.name), 'state.json'), 'utf8'));
    assert.equal(state.phase, 'RELEASED');
    console.log('PASS: isolated real daemon; suspend, SIGKILL, daemon restart preserve owner/CID/conversation/contact admission; terminal release removes exact member.');
  } finally {
    clearTimeout(watchdog); if (member?.exitCode === null && member?.signalCode === null) { member.kill('SIGKILL'); await once(member, 'exit'); }
    try { await control?.releaseLease(); await control?.close(); } finally { await stopDaemon(); rmSync(root, { recursive: true, force: true }); }
  }
}
