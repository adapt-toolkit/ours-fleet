// Real Codex/Claude OS sandbox + ordinary CLI audit + daemon/Cowork room deletion. No MCP.
// Requires built Fleet, FLEET_CODEX_BIN or FLEET_CLAUDE_BIN, and FLEET_COWORK_CLI. A scripted local model provider; no user state.
import assert from 'node:assert/strict';
import { executeClaudeWithRules } from './claude-exec-policy-fixture.mjs';
import { executeWithRules, quote } from './codex-exec-policy-fixture.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, realpathSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attachOursClient } from '@ours.network/sdk/client';
import { RoleControlServer } from '../dist/session/control.js';
import { FleetCommandAuditStore } from '../dist/fleet-command-audit.js';
import { createCoworkAdapter } from '../dist/rooms-tasks/cowork-adapter.js';
import { createRoomRecord, getRoomRecord } from '../dist/rooms-tasks/room-state.js';

const claude = process.env.FLEET_CLAUDE_BIN;
const codex = process.env.FLEET_CODEX_BIN, coworkCli = process.env.FLEET_COWORK_CLI;
assert((codex || claude) && coworkCli, 'Set FLEET_CODEX_BIN or FLEET_CLAUDE_BIN, and FLEET_COWORK_CLI');
const daemonCli = resolve(process.env.FLEET_DAEMON_CLI ?? 'node_modules/@ours.network/daemon/dist/cli.js');
const root = realpathSync(mkdtempSync(process.env.FLEET_TEST_TMP_PREFIX ?? '/tmp/fleet-ipc-'));
const children = [];
mkdirSync(join(root, 'tmp'), {mode:0o700});
// Allowlist the fixture environment: never inherit provider auth, preloads or user config.
const cleanEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_CACHE_HOME: join(root, 'xdg-cache'),
  XDG_DATA_HOME: join(root, 'xdg-data'), LANG: process.env.LANG ?? 'C.UTF-8' };
const pause = ms => new Promise(r => setTimeout(r, ms));
let control, gateway, sdk;
function start(command, args, env, captureFile) {
  // Node's pipe transports use socket pairs. Capture the sandbox command into
  // a regular file so its stdio is independent of network syscall restrictions.
  const fd = captureFile ? openSync(captureFile, 'w', 0o600) : undefined;
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', fd ?? 'pipe', fd ?? 'pipe'] });
  if (fd !== undefined) closeSync(fd);
  children.push(child);
  child.output = ''; child.stdout?.on('data', b => { child.output = (child.output + b).slice(-16000); });
  child.stderr?.on('data', b => { child.output = (child.output + b).slice(-16000); });
  child.closed = false; child.once('close', () => {
    if (captureFile) child.output = readFileSync(captureFile, 'utf8');
    child.closed = true;
  });
  return child;
}
async function wait(check, description, child) {
  const end = Date.now() + 60_000;
  let last;
  while (Date.now() < end) {
    if (child?.exitCode !== undefined && child.exitCode !== null) throw Error(child.output);
    try { if (await check()) return; } catch (error) { last = error; }
    await pause(100);
  }
  throw Error(description + ': ' + (last ?? '') + '\n' + (child?.output ?? ''));
}
async function port() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const p = server.address().port; await new Promise(r => server.close(r)); return p;
}
function json(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
const watchdog = setTimeout(() => { for (const c of children) c.kill('SIGKILL'); process.exit(124); }, 600_000);
try {
  const daemonState = join(root, 'daemon'); mkdirSync(daemonState, { mode: 0o700 });
  const daemonPort = await port(), coworkPort = await port();
  const instance = randomUUID(), daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const credential = join(root, 'credential'), daemonConfig = join(root, 'daemon.json');
  json(daemonConfig, { stateDir: daemonState, port: daemonPort, apiVisibility: 'owner' });
  const daemon = start(process.execPath, [daemonCli, 'daemon', 'serve', '--managed'], {
    ...cleanEnv, OURS_CONFIG: daemonConfig, OURS_STATE_DIR: daemonState,
    OURS_PORT: String(daemonPort), OURS_DAEMON_ID: instance, OURS_API_VISIBILITY: 'owner',
    OURS_BROKER_URL: 'wss://invalid.local/none',
  });
  await wait(async () => (await (await fetch(daemonUrl + '/selection')).json()).instanceId === instance, 'daemon', daemon);
  copyFileSync(join(daemonState, 'daemon-token'), credential);
  sdk = await attachOursClient({ endpoint: daemonUrl, expectedInstanceId: instance,
    credentialPath: credential, sessionMode: 'external', leaseToken: randomUUID(), env: {} });
  const owner = await sdk.createRootIdentity({ name: 'FixtureOwner', bio: '', exposeLocal: false, localAutoAccept: true, skipIfRootExists: false });
  await sdk.releaseLease(); sdk = undefined;

  const coworkConfig = join(root, 'cowork.json');
  json(coworkConfig, { version: 1, stateDir: join(root, 'cowork'), rest: { enabled: true, host: '127.0.0.1', port: coworkPort } });
  const cowork = start(process.execPath, [resolve(coworkCli), 'serve'], {
    ...cleanEnv, OURS_COWORK_CONFIG: coworkConfig, OURS_COWORK_HTTP_MANAGEMENT: '1',
    OURS_DAEMON_URL: daemonUrl, OURS_DAEMON_ID: instance, OURS_DAEMON_CREDENTIAL_PATH: credential,
  });
  gateway = httpServer(async (req, res) => {
    try {
      const isDaemon = req.url.startsWith('/daemon/');
      if (!isDaemon && !req.url.startsWith('/cowork/')) { res.writeHead(404).end(); return; }
      const prefix = isDaemon ? '/daemon' : '/cowork';
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await fetch((isDaemon ? daemonUrl : `http://127.0.0.1:${coworkPort}`) + req.url.slice(prefix.length), {
        method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`, profile = join(root, 'profile.json');
  json(profile, { serverUrl, endpoint: serverUrl + '/daemon', expectedInstanceId: instance, credentialPath: credential });
  const env = { ...cleanEnv, OURS_CONFIG: profile, OURS_FLEET_HOME: root, OURS_FLEET_SUPERVISOR: 'none' };
  // The standalone fixture process owns these values; they never reference user state.
  process.env.OURS_FLEET_HOME = root;
  // Harness preparation and SDK defaults must resolve only this disposable home.
  process.env.HOME = root;
  const adapter = createCoworkAdapter({ env });
  await wait(() => adapter.available(), 'Cowork management', cowork);
  const created = await adapter.createRoom({ room_name: 'IPC fixture', goal: 'sandbox transport regression', briefing: 'Isolated test room' });
  const id = created.room_id;
  createRoomRecord({ room_id: id, room_name: 'IPC fixture', room_identity_cid: created.identity_cid });
  const config = join(root, 'fleet.yaml');
  mkdirSync(join(root, 'fleet', 'agents'), { recursive: true });
  writeFileSync(config, `api_version: ours.network/fleet/v2\nrooms:\n  owner:\n    expected_cid: "${owner.info.cid}"\n  defaults:\n    attach_owner: false\n`);
  const state = join(root, 'role'); mkdirSync(state);
  const audit = new FleetCommandAuditStore(join(state, 'audit.json'));
  control = new RoleControlServer(state, {}, () => {});
  control.setFleetAuditor({
    async begin(requestId, argv) { const row = audit.begin(requestId, 'Fixture', argv); return audit.invocation(row.correlationId, 'Fixture', 'delivered'); },
    async finish({ correlationId, ...outcome }) { audit.finish(correlationId, 'Fixture', outcome); return audit.outcome(correlationId, 'Fixture', 'delivered'); },
    async present() {},
  });
  await control.start();
  if (!claude) {
  const sandbox = start(codex, ['sandbox', '-P', 'fixture',
    '-c', 'permissions.fixture.filesystem={":root"="read",":project_roots"="write"}',
    '-c', 'permissions.fixture.network.enabled=false', '-C', root, '--',
    process.execPath, resolve('dist/cli.js'), '--help'], {
    ...env, OURS_FLEET_PROXY_CALLER: 'Fixture', OURS_FLEET_PROXY_STATE_DIR: state,
  }, join(root, 'sandbox-output'));
  await wait(() => sandbox.closed, 'sandbox execution');
  assert.equal(sandbox.exitCode, 1, sandbox.output);
  assert.match(sandbox.output, /connect EPERM/, sandbox.output);
  assert.match(sandbox.output, /operating system denied access before 'fleet_audit_begin'/);
  assert.equal(audit.list().length, 0);
  console.log(`PASS ${process.platform}: real Codex sandbox blocks direct audited CLI before help`);

  }
  const project = join(root, 'project'); mkdirSync(project);
  const cli = resolve('dist/cli.js');
  const prefixes = [
    [process.execPath, cli, '--help'],
    [process.execPath, cli, 'room', 'delete', '--configuration', config, '--json', '--'],
  ];
  const rules = prefixes.map(pattern => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="allow")`).join('\n');
  const execute = options => claude ? executeClaudeWithRules({ ...options, claude, prefixes }) : executeWithRules(options);
  async function invoke(argv, program = cli) {
    return execute({ codex, root, cwd: project,
      env: { ...env, OURS_FLEET_PROXY_CALLER: 'Fixture', OURS_FLEET_PROXY_STATE_DIR: state },
      allowProbe: program === '-e', rules, command: [process.execPath, program, ...argv].map(quote).join(' '),
    });
  }
  if (claude) {
    const blocked = await executeClaudeWithRules({ claude, root, cwd: project,
      env: { ...env, OURS_FLEET_PROXY_CALLER: 'Fixture', OURS_FLEET_PROXY_STATE_DIR: state },
      prefixes, exclude: false, command: [process.execPath, cli, '--help'].map(quote).join(' '),
    });
    assert.notEqual(blocked.exitCode, 0, blocked.output);
    assert.match(blocked.output, /connect (EPERM|EACCES)/);
    assert.equal(audit.list().length, 0);
    console.log(`PASS ${process.platform}: real Claude sandbox blocks direct audited CLI before help`);
  }
  const guard = await invoke([`try { require('node:fs').writeFileSync(${JSON.stringify(join(root, 'outside-project'))}, 'unexpected'); process.exitCode=2; } catch (e) { if (!['EPERM','EACCES','EROFS'].includes(e.code)) throw e; console.log('filesystem restriction retained'); }`], '-e');
  assert.equal(guard.exitCode, 0, guard.output);
  assert.match(guard.output, /filesystem restriction retained/);
  const help = await invoke(['--help']);
  assert.equal(help.exitCode, 0, help.output);
  // An allowed argv prefix must not authorize arbitrary preload code.
  const preload = join(project, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'preload-escaped'))}, 'bad');`);
  const injected = await execute({ codex, root, cwd: project,
    env: { ...env, OURS_FLEET_PROXY_CALLER: 'Fixture', OURS_FLEET_PROXY_STATE_DIR: state }, rules,
    command: `NODE_OPTIONS=--require=${preload} ` + [process.execPath, cli, '--help'].map(quote).join(' '),
  });
  assert.notEqual(injected.exitCode, 0, injected.output);
  assert.equal(existsSync(join(root, 'preload-escaped')), false);
  const otherConfig = await invoke(['room', 'delete', '--configuration', join(root, 'other.yaml'), '--json', '--', id, id]);
  assert.notEqual(otherConfig.exitCode, 0, otherConfig.output);
  if (!claude) assert.match(otherConfig.output, /connect EPERM/);
  const rejected = await invoke(['room', 'delete', '--configuration', config, '--json', '--', id, 'wrong']);
  assert.equal(rejected.exitCode, 1, rejected.output);
  assert(await adapter.getRoom(id)); assert(getRoomRecord(id));
  const deleted = await invoke(['room', 'delete', '--configuration', config, '--json', '--', id, id]);
  assert.equal(deleted.exitCode, 0, deleted.output);
  assert.equal(JSON.parse(deleted.output).deleted, true);
  assert.equal(await adapter.getRoom(id), undefined); assert.equal(getRoomRecord(id), undefined);
  assert.equal(audit.list().length, 3);
  console.log(`PASS ${process.platform}: ordinary CLI through workspace execution rules (${claude ? process.env.FLEET_TEST_SESSION ?? 'claude-standalone' : process.env.FLEET_TEST_SESSION ?? 'exec'}) with sandbox retained; help, confirmation refusal, actual room deletion and audit`);
} finally {
  clearTimeout(watchdog);
  await control?.close();
  gateway?.closeAllConnections(); gateway?.close(); await sdk?.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await pause(1000);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (process.env.FLEET_TEST_KEEP_ARTIFACTS === '1') console.log('Fixture artifacts retained: ' + root);
  else rmSync(root, { recursive: true, force: true });
}
