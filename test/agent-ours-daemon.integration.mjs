// Isolated daemon and state only; no authenticated AI harness or production daemon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  prepareManagedAgent,
  releaseManagedAgent,
  storeTemporaryLaunch,
} from '../dist/agent-ours/service.js';
const root = mkdtempSync(join(tmpdir(), 'fleet-daemon-managed-'));
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
writeFileSync(profile, JSON.stringify({ endpoint, expectedInstanceId: instance, credentialPath }), {
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
    resolve(process.env.FLEET_DAEMON_CLI ?? '../ours-sdk/packages/daemon/dist/cli.js'),
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
let control, managed, mcp;
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
  const role = {
    name: 'Agent',
    identity: 'Agent',
    harness: 'codex',
    sourceFile: 'test',
    env: { OURS_CONFIG: profile },
  };
  const dir = join(root, 'agent');
  mkdirSync(dir);
  storeTemporaryLaunch(role, 'one');
  managed = await prepareManagedAgent(role, dir, true);
  const cid = managed.runtime.snapshot.cid;
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/agent-ours/bridge.js')],
      cwd: dir,
      env: { FLEET_OURS_BRIDGE_DESCRIPTOR: managed.descriptor },
      stderr: 'pipe',
    });
    mcp = new Client({ name: 'probe', version: '1' });
    await mcp.connect(transport);
    assert.equal((await mcp.listTools()).tools.length, 27);
    const identity = await mcp.callTool({ name: 'current_identity', arguments: {} });
    assert.equal(identity.isError, false);
    assert(JSON.stringify(identity).includes(cid));
  };
  await managed.runtime.startHarness(connect);
  await mcp.close();
  mcp = undefined;
  await managed.close(false);
  managed = undefined;
  managed = await prepareManagedAgent(role, dir, true);
  assert.equal(managed.runtime.snapshot.cid, cid);
  await managed.runtime.startHarness(connect);
  await mcp.close();
  mcp = undefined;
  await managed.close(false);
  managed = undefined;
  await releaseManagedAgent(role);
  assert(!(await control.listIdentities()).some((r) => r.name === 'Agent'));
  const permanent = { ...role, name: 'Permanent', identity: 'Permanent' };
  managed = await prepareManagedAgent(permanent, dir, false);
  const permanentCid = managed.runtime.snapshot.cid;
  await managed.close(true);
  managed = undefined;
  managed = await prepareManagedAgent(permanent, dir, false);
  assert.equal(managed.runtime.snapshot.cid, permanentCid);
  await managed.close(true);
  managed = undefined;
  console.log(
    'PASS actual daemon + service + MCP bridge: temp restart retains CID; terminal cleans; permanent restart retains CID',
  );
} finally {
  await mcp?.close();
  await managed?.close(false);
  await control?.close();
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
  clearTimeout(watchdog);
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
}
