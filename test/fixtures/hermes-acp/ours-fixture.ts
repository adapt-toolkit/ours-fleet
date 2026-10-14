import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OursClient } from '@ours.network/sdk/client';

/** Separate local daemon, Human fixture root and agent; never selects an operator daemon. */
export async function createPrivateOursFixture() {
  const cli = process.env.HERMES_ACP_TEST_OURS_CLI ?? join(homedir(), '.local/lib/node_modules/@ours.network/daemon/dist/cli.js');
  const mcp = process.env.HERMES_ACP_TEST_OURS_MCP ?? join(homedir(), '.local/lib/node_modules/@ours.network/mcp/dist/cli.js');
  await Promise.all([access(cli), access(mcp)]);
  const root = await mkdtemp(join(tmpdir(), 'fleet-hermes-private-ours-'));
  const home = join(root, 'home'); const stateDir = join(root, 'state'); await mkdir(home, { mode: 0o700 });
  const reservation = createServer(); await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('No private daemon port');
  const port = address.port; await new Promise<void>(done => reservation.close(() => done()));
  const config = join(root, 'config.json'); const appConfig = join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ stateDir, port, brokerUrl: 'ws://127.0.0.1:1', apiVisibility: 'open' }), { mode: 0o600 });
  await writeFile(appConfig, JSON.stringify({ version: 1, daemons: { [stateDir]: { identities: ['FixtureAgent'] } } }), { mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'daemon', 'serve', '--config', config], { env: {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, OURS_CONFIG: config, OURS_BROKER_URL: 'ws://127.0.0.1:1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = ''; child.stdout.on('data', data => { diagnostic = (diagnostic + data).slice(-3000); });
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-3000); });
  const url = `http://127.0.0.1:${port}`;
  const owner = new OursClient({ url, leaseToken: `fixture-owner-${randomUUID()}`, clientPid: process.pid });
  const agent = new OursClient({ url, leaseToken: `fixture-agent-${randomUUID()}`, clientPid: process.pid });
  async function close() {
    await Promise.allSettled([owner.releaseLease(), agent.releaseLease()]);
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); done(); }); child.kill('SIGTERM');
    });
    await rm(root, { recursive: true, force: true });
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { const response = await fetch(`${url}/info`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).stateDir === stateDir) { ready = true; break; }
      } catch { /* startup */ }
      if (child.exitCode !== null) break;
      await new Promise(done => setTimeout(done, 100));
    }
    if (!ready) throw new Error(`Private fixture daemon failed: ${diagnostic}`);
    if ((await owner.listIdentities()).length !== 0) throw new Error('Private fixture daemon was not empty');
    const rootIdentity = await owner.createRootIdentity({ name: 'FixtureOwner', bio: 'Local test Human identity', exposeLocal: true, localAutoAccept: true, skipIfRootExists: false });
    const agentIdentity = await agent.createIdentity({ name: 'FixtureAgent', bio: 'Local test agent identity', exposeLocal: true, localAutoAccept: true });
    await agent.releaseLease();
    return { owner, ownerCid: rootIdentity.info.cid, agentCid: agentIdentity.info.cid, close,
      declaration: { name: 'ours', command: process.execPath, args: [mcp, 'proxy'], env: Object.entries({
        HOME: home, OURS_CONFIG: config, OURS_MCP_CONFIG: appConfig, OURS_BIND_IDENTITY: 'FixtureAgent',
        OURS_CLIENT_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: `fixture-mcp-${randomUUID()}`,
      }).map(([name, value]) => ({ name, value })) },
    };
  } catch (error) { await close(); throw error; }
}
