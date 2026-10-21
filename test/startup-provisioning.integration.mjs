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
  const variants = {
    before: await import(resolve(process.env.FLEET_STARTUP_BASELINE ?? '../baseline/dist/agent-ours/service.js')),
    after: await import('../dist/agent-ours/service.js'),
  };
  const samples = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const temporary of [false, true]) {
      for (const variant of (repetition % 2 ? ['after', 'before'] : ['before', 'after'])) {
        const service = variants[variant];
        const name = `${variant}-${temporary ? 'temp' : 'permanent'}-${repetition}`;
        const role = { name, identity: name, harness: 'codex', sourceFile: 'isolated benchmark',
          bio: 'Fixture public profile', persona: 'Fixture private operating contract', env: { OURS_CONFIG: profile } };
        const dir = join(root, 'agents', name); mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (temporary) service.storeTemporaryLaunch(role, name);
        requests = [];
        const began = performance.now();
        managed = await service.prepareManagedAgent(role, dir, temporary);
        const provisioning_ms = performance.now() - began;
        const provisioning_api = [...requests];
        // Trusted test seam, outside the timed segment; no LLM identity ritual.
        const identity = await managed.runtime.deps.client.currentIdentity();
        samples.push({ variant, temporary, repetition, provisioning_ms, provisioning_api,
          bio_applied: identity.bio === role.bio, persona_applied: identity.persona === role.persona });
        await managed.close(true); managed = undefined;
      }
    }
  }
  console.log(JSON.stringify({ schema: 1, baseline: 'b7d24b24d1a5618370afb64d9d2d1f5e50a39c6f',
    fixture: 'real isolated daemon via HTTP gateway; fresh identities; no harness/model/room',
    samples }, null, 2));
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
