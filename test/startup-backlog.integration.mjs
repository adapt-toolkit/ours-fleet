// Isolated daemon and state only; no authenticated AI harness or production daemon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
assert(process.env.TMPDIR, 'Supply a task-owned TMPDIR');
const root = mkdtempSync(join(tmpdir(), 'startup-provisioning-'));
const state = join(root, 'daemon');
mkdirSync(state, { mode: 0o700 });
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const instance = randomUUID(),
  endpoint = `http://127.0.0.1:${port}`,
  credentialPath = join(root, 'token'),
  profile = join(root, 'profile.json'),
  config = join(root, 'daemon.json');
writeFileSync(config, JSON.stringify({ stateDir: state, port, apiVisibility: 'owner' }), {
  mode: 0o600,
});
// Exercise the current gateway profile contract through a task-isolated relay.
let requests = [];
const gateway = createHttpServer((req, res) => {
  requests.push(req.url.split('/').at(-1));
  if (!req.url.startsWith('/daemon/')) { res.writeHead(404); res.end(); return; }
  const upstream = httpRequest(endpoint + req.url.slice('/daemon'.length), { method: req.method, headers: req.headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
writeFileSync(profile, JSON.stringify({ serverUrl, endpoint: serverUrl + '/daemon', expectedInstanceId: instance, credentialPath }), {
  mode: 0o600,
});
const env = {
  ...process.env,
  OURS_STATE_DIR: state,
  OURS_PORT: String(port),
  OURS_DAEMON_ID: instance,
  OURS_API_VISIBILITY: 'owner',
  OURS_CONFIG: config,
  OURS_BROKER_URL: 'ws://127.0.0.1:1',
};
for (const key of ['OURS_API_TOKEN', 'OURS_TLS_CERT', 'OURS_TLS_KEY', 'OURS_LISTEN_HOST'])
  delete env[key];
const child = spawn(
  process.execPath,
  [
    resolve(process.env.FLEET_DAEMON_CLI ?? 'node_modules/@ours.network/daemon/dist/cli.js'),
    'daemon',
    'serve',
    '--managed',
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
const exited = once(child, 'exit');
let output = '';
for (const s of [child.stdout, child.stderr])
  s.on('data', (b) => {
    output = (output + b).slice(-12000);
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => child.kill('SIGKILL'), 90000);
let control, managed;
const oldHome = process.env.OURS_FLEET_HOME;
process.env.OURS_FLEET_HOME = join(root, 'fleet');
try {
  let ready = false;
  for (let i = 0; i < 300; i++) {
    assert.equal(child.exitCode, null, output);
    try {
      const r = await fetch(endpoint + '/selection', { signal: AbortSignal.timeout(100) });
      if (r.ok && (await r.json()).instanceId === instance) {
        ready = true;
        break;
      }
    } catch {}
    await pause(100);
  }
  assert(ready, 'daemon readiness timeout: ' + output);
  copyFileSync(join(state, 'daemon-token'), credentialPath);
  control = await attachOursClient({
    endpoint,
    expectedInstanceId: instance,
    credentialPath,
    sessionMode: 'local',
    requiredCapabilities: ['local-pid-v1'],
  });
  await control.createRootIdentity({
    skipIfRootExists: true,
    name: 'TestRoot',
    bio: 'isolated test',
    exposeLocal: false,
    localAutoAccept: true,
  });
  const service = await import('../dist/agent-ours/service.js');
  const name = 'BacklogWorker', temporary = process.argv.includes('--temporary');
  const role = { name, identity: name, harness: 'codex', sourceFile: 'isolated backlog fixture',
    bio: 'Fixture worker', env: { OURS_CONFIG: profile } };
  const dir = join(root, 'agents', name); mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (temporary) service.storeTemporaryLaunch(role, 'isolated-backlog-launch');
  managed = await service.prepareManagedAgent(role, dir, temporary);
  const worker = managed.runtime.deps.client;
  const invitation = await control.generateInvite({ name: 'BacklogWorker' });
  await worker.addContact({ invite: invitation.blob });
  let established = false;
  for (let i = 0; i < 100; i++) {
    const contacts = await control.listContacts();
    if (contacts.contacts.some(c => c.container_id === managed.runtime.snapshot.cid)) { established = true; break; }
    await pause(50);
  }
  assert(established, 'Fixture contact handshake timeout');
  await control.sendMessage({ contact: managed.runtime.snapshot.cid, text: 'Fixture task: inspect the assigned patch.' });
  let summary;
  for (let i = 0; i < 100; i++) {
    summary = await control.unread();
    if (summary.identities.some(row => row.name === name && row.count === 1)) break;
    await pause(50);
  }
  assert.equal(summary.identities.find(row => row.name === name)?.count, 1);
  const { createMonitor } = await import('../dist/monitor.js');
  let monitor;
  const wakes = [];
  monitor = createMonitor({ name, identity: name, agentDir: dir,
    cfg: { mode: 'fleet', enabled: true, wake_sources: ['message_received'], batch_ms: 0, inject: 'notification' },
    deps: { fetch, env: { OURS_CONFIG: profile }, isAlive: () => true, now: Date.now,
      sleep: pause, log: () => {}, timers: { set: setTimeout, clear: clearTimeout },
      delivery: { submit: async text => {
        wakes.push(text); monitor.stop(); return { succeeded: true, outcome: 'completed' };
      } },
    },
  });
  await monitor.prime(); // Existing task predates the early stream cursor.
  assert.equal(wakes.length, 0);
  await monitor.run(process.pid); // Runner calls this only after the ready turn.
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /unread backlog: 1 messages/);
  assert(!wakes[0].includes('inspect the assigned patch'));
  assert.equal((await control.unread()).identities.find(row => row.name === name)?.count, 1,
    'Supervisor metadata check must not consume unread mail');
  const mail = await worker.getMessages();
  assert.equal(mail.messages.length, 1);
  assert.match(mail.messages[0].text ?? mail.messages[0].body, /Fixture task/);
  console.log(JSON.stringify({ fixture: 'real isolated daemon initial backlog after ready',
    pass: true, temporary, pre_prime_messages: 1, supervisor_wakes: wakes.length, messages_consumed_by_probe: 0 }));
  await managed.close(true); managed = undefined;

} finally {
  await managed?.close(false);
  await control?.close();
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
  clearTimeout(watchdog);
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
  // Retain task-owned benchmark artifacts; daemon process is stopped above.
}
