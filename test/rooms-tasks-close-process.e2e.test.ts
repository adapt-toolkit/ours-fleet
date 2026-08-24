import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { attachOursClient, type OursClient } from '@ours.network/sdk/client';

import { createCoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
import {
  activateRoom, createRoomRecord, getRoomRecord, updateMemberSeats,
} from '../src/rooms-tasks/room-state.js';
import { spawnTemp } from '../src/spawn.js';
import { makeTempSupervisorLauncher, readTempSupervisor } from '../src/temp-lifecycle.js';

const ROOT = resolve(import.meta.dirname, '..');
const FLEET_CLI = join(ROOT, 'dist', 'cli.js');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'acp-agent.mjs');
const COWORK_ROOT = process.env.OURS_FLEET_CLOSE_E2E_COWORK_ROOT;
const enabled = Boolean(COWORK_ROOT);
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const MUTATED_ENV = [
  'OURS_FLEET_HOME', 'OURS_CONFIG', 'OURS_COWORK_CONFIG', 'OURS_FLEET_SUPERVISOR',
] as const;
const originalEnv = Object.fromEntries(MUTATED_ENV.map(key => [key, process.env[key]]));

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a test port');
  await new Promise<void>((resolveClose, reject) =>
    server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}

async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  description: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}${last ? `: ${String(last)}` : ''}`);
}

async function waitForPort(port: number): Promise<void> {
  await waitFor(() => new Promise<boolean>(resolveReady => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolveReady(true); });
    socket.once('error', () => { socket.destroy(); resolveReady(false); });
  }), `port ${port}`);
}

async function runNode(
  file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 40_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [file, ...args], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = await Promise.race([
    new Promise<{ code: number | null }>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolveExit({ code }));
    }),
    sleep(timeoutMs).then(() => ({ timeout: true as const })),
  ]);
  if ('timeout' in result) {
    child.kill('SIGKILL');
    throw new Error(`timed out: ${file} ${args.join(' ')}`);
  }
  return { ...result, stdout, stderr };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function processWithArgs(expected: string[]): number | undefined {
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return undefined; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const args = readFileSync(join('/proc', name, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      if (expected.every((value, index) => args[index] === value)) return Number(name);
    } catch { /* process exited during inspection */ }
  }
  return undefined;
}

function detached(binPath: string, args: string[], dir: string): number {
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: dir, env: process.env, detached: true, stdio: 'ignore',
  });
  child.unref();
  if (!child.pid) throw new Error('detached test supervisor has no pid');
  return child.pid;
}

describe.skipIf(!enabled)('real process room close', () => {
  const children: ChildProcess[] = [];
  const clients: OursClient[] = [];
  let testRoot: string | undefined;
  let oursEnv: NodeJS.ProcessEnv | undefined;
  let coworkEnv: NodeJS.ProcessEnv | undefined;

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.releaseLease().catch(() => {});
    if (coworkEnv && COWORK_ROOT) {
      await runNode(join(COWORK_ROOT, 'dist', 'cli.js'), ['stop', '--json'], COWORK_ROOT, coworkEnv, 20_000)
        .catch(() => {});
    }
    if (oursEnv) {
      await runNode(
        join(ROOT, 'node_modules', '@ours.network', 'cli', 'dist', 'cli.js'),
        ['daemon', 'stop', '--config', oursEnv.OURS_CONFIG!, '--json'], ROOT, oursEnv, 20_000,
      ).catch(() => {});
    }
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (testRoot) rmSync(testRoot, { recursive: true, force: true });
    testRoot = undefined;
    oursEnv = undefined;
    coworkEnv = undefined;
    for (const key of MUTATED_ENV) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('converges after its public caller dies and removes only exact live resources', async () => {
    if (!COWORK_ROOT) throw new Error('OURS_FLEET_CLOSE_E2E_COWORK_ROOT is required');
    const coworkCli = join(COWORK_ROOT, 'dist', 'cli.js');
    const brokerBin = join(COWORK_ROOT, 'node_modules', '.bin', 'adapt-broker');
    expect(existsSync(FLEET_CLI)).toBe(true);
    expect(existsSync(coworkCli)).toBe(true);
    expect(existsSync(brokerBin)).toBe(true);

    testRoot = mkdtempSync(join(tmpdir(), 'ours-fleet-close-e2e-'));
    const brokerPort = await unusedPort();
    const broker = spawn(brokerBin, ['--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], {
      cwd: COWORK_ROOT, stdio: 'ignore',
    });
    children.push(broker);
    await waitForPort(brokerPort);

    const oursPort = await unusedPort();
    const oursConfig = join(testRoot, 'ours.json');
    writeFileSync(oursConfig, JSON.stringify({
      brokerUrl: `ws://127.0.0.1:${brokerPort}`,
      port: oursPort,
      stateDir: join(testRoot, 'ours-state'),
      apiVisibility: 'owner',
    }), { mode: 0o600 });
    oursEnv = { ...process.env, OURS_CONFIG: oursConfig };
    for (const key of ['OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN']) delete oursEnv[key];
    const oursCli = join(ROOT, 'node_modules', '@ours.network', 'cli', 'dist', 'cli.js');
    const daemonStart = await runNode(
      oursCli, ['daemon', 'start', '--config', oursConfig, '--json'], ROOT, oursEnv,
    );
    expect(daemonStart.code, daemonStart.stderr).toBe(0);
    await waitForPort(oursPort);

    const coworkConfig = join(testRoot, 'cowork.json');
    const coworkState = join(testRoot, 'cowork-state');
    writeFileSync(coworkConfig, JSON.stringify({
      version: 1, stateDir: coworkState, rest: { enabled: false, port: 3052 },
    }), { mode: 0o600 });
    coworkEnv = { ...oursEnv, OURS_COWORK_CONFIG: coworkConfig };
    const coworkStart = await runNode(coworkCli, ['start', '--json'], COWORK_ROOT, coworkEnv);
    expect(coworkStart.code, coworkStart.stderr).toBe(0);
    const cowork = createCoworkAdapter({ env: coworkEnv });
    await waitFor(() => cowork.available(), 'Cowork management socket');

    const peer = await attachOursClient({ env: oursEnv, leaseToken: 'fleet-close-peer' });
    clients.push(peer);
    const peerIdentity = await peer.createIdentity({
      name: 'PersistentPeer', bio: 'persistent room peer', exposeLocal: false, localAutoAccept: true,
    });
    const observer = await attachOursClient({ env: oursEnv, leaseToken: 'fleet-close-observer' });
    clients.push(observer);
    const member = await observer.createIdentity({
      name: 'CloseMember', bio: 'real Fleet close member', exposeLocal: false, localAutoAccept: true,
    });

    const created = await cowork.createRoom({
      room_name: 'Fleet caller-loss close', goal: 'prove convergence', briefing: 'retain exact evidence',
    });
    const invite = await cowork.issueInvite(created.room_id, { role: 'member', min_accepts: 2 });
    await observer.addContact({ invite: invite.invite });
    await peer.addContact({ invite: invite.invite });
    await waitFor(async () => (await cowork.getSeats(created.room_id)).length === 2,
      'both real Cowork seats');

    process.env.OURS_FLEET_HOME = testRoot;
    process.env.OURS_CONFIG = oursConfig;
    process.env.OURS_COWORK_CONFIG = coworkConfig;
    process.env.OURS_FLEET_SUPERVISOR = 'none';
    const fleetConfig = join(testRoot, 'fleet.yaml');
    writeFileSync(fleetConfig, [
      'roles: {}',
      'rooms:',
      '  owner:',
      `    expected_cid: ${'a'.repeat(64)}`,
      '  defaults:',
      '    attach_owner: false',
      '  cowork:',
      `    config: ${coworkConfig}`,
      '',
    ].join('\n'), { mode: 0o600 });
    chmodSync(fleetConfig, 0o600);

    createRoomRecord({
      room_id: created.room_id,
      room_name: 'Fleet caller-loss close',
      room_identity_cid: created.identity_cid,
    });
    updateMemberSeats(created.room_id, [{
      role_name: 'CloseMember', identity_cid: member.info.cid, slot: 'member',
      cowork_role: 'member', seat_state: 'active',
    }]);
    activateRoom(created.room_id);

    await observer.releaseLease();
    clients.splice(clients.indexOf(observer), 1);
    const baseLauncher = makeTempSupervisorLauncher({ supervisor: 'none', spawnDetached: detached });
    const memberDir = await spawnTemp({
      name: 'CloseMember', identity: 'CloseMember', harness: 'codex', session: 'acp',
      mission: 'stubborn block 60000', cwd: testRoot,
    }, FLEET_CLI, async (binPath, args, dir) => {
      const rolePath = join(dir, 'role.yaml');
      const role = parse(readFileSync(rolePath, 'utf8')) as Record<string, unknown>;
      role.session_options = { acp: { command: [process.execPath, FIXTURE] } };
      writeFileSync(rolePath, stringify(role), { mode: 0o600 });
      await baseLauncher(binPath, args, dir);
    });
    const supervisor = await waitFor(() => {
      const value = readTempSupervisor(memberDir);
      return value?.phase === 'active' && value.pid && pidAlive(value.pid) ? value : undefined;
    }, 'live exact Fleet temp supervisor');

    const closeEnv = {
      ...process.env,
      OURS_FLEET_HOME: testRoot,
      OURS_CONFIG: oursConfig,
      OURS_COWORK_CONFIG: coworkConfig,
      OURS_FLEET_SUPERVISOR: 'none',
    };
    const caller = spawn(process.execPath, [
      FLEET_CLI, 'room', 'close', created.room_id, created.room_id, '--json', '-c', fleetConfig,
    ], { cwd: ROOT, env: closeEnv, stdio: 'ignore' });
    children.push(caller);
    const workerArgs = [process.execPath, FLEET_CLI, 'room', '_close', created.room_id, '-c', fleetConfig];
    const workerPid = await waitFor(() => processWithArgs(workerArgs), 'detached hidden room-close worker');
    expect(workerPid).not.toBe(caller.pid);
    caller.kill('SIGKILL');
    await new Promise<void>(resolveExit => caller.once('exit', () => resolveExit()));

    const closed = await waitFor(() => {
      const room = getRoomRecord(created.room_id);
      if (room?.close?.error) throw new Error(
        `${room.close.phase}: ${room.close.error} (${room.close.recovery_hint ?? 'no recovery hint'})`,
      );
      return room?.state === 'closed' ? room : undefined;
    }, 'Fleet close convergence after caller death', 45_000);
    expect(closed.close?.phase).toBe('completed');
    await waitFor(() => !pidAlive(supervisor.pid!), 'exact temp supervisor absence');
    expect(processWithArgs([process.execPath, FLEET_CLI, '_run-temp', 'CloseMember'])).toBeUndefined();
    expect(processWithArgs(workerArgs)).toBeUndefined();

    const verifier = await attachOursClient({ env: oursEnv, leaseToken: 'fleet-close-verifier' });
    clients.push(verifier);
    const identities = await verifier.listIdentities();
    expect(identities.some(row => row.name === 'CloseMember' || row.cid === member.info.cid)).toBe(false);
    expect(identities.some(row => row.cid === created.identity_cid)).toBe(false);
    expect(identities.some(row => row.cid === peerIdentity.info.cid)).toBe(true);
    await waitFor(async () => !(await peer.listContacts()).contacts
      .some(contact => contact.container_id === created.identity_cid),
    'persistent non-member peer room-contact removal');

    expect(existsSync(memberDir)).toBe(false);
    const recoveryRoot = join(testRoot, '.ours-fleet', 'recovery', 'temporary');
    const recoveryEntries = readdirSync(recoveryRoot).sort();
    expect(recoveryEntries.filter(name => name !== 'terminations.jsonl')).toHaveLength(1);
    const archive = join(recoveryRoot, recoveryEntries.find(name => name !== 'terminations.jsonl')!);
    const allowedFleetArchive = new Set([
      '.acp-session-id', '.booted', '.control-token', '.conversation', '.cwd', '.exit-status',
      '.identity', '.monitor-owner', '.monitor-state.json', '.monitor-status', '.notify-cursor',
      '.provenance.json', '.session-events.jsonl', '.session-id', '.temp-stop-request.json',
      '.temp-supervisor.json', '.termination-globally-recorded', 'WORKLOG.md', 'briefing.md',
      'creation.json', 'role.yaml', 'supervisor.log', 'termination.jsonl',
    ]);
    expect(readdirSync(archive).filter(name => !allowedFleetArchive.has(name))).toEqual([]);
    expect(readdirSync(archive)).toEqual(expect.arrayContaining([
      '.identity', '.temp-supervisor.json', '.termination-globally-recorded',
      'WORKLOG.md', 'briefing.md', 'role.yaml', 'termination.jsonl',
    ]));
    expect(JSON.parse(readFileSync(join(archive, '.temp-supervisor.json'), 'utf8')))
      .toMatchObject({ role: 'CloseMember', launchId: supervisor.launchId, pid: supervisor.pid });

    const coworkRoomDir = join(coworkState, 'rooms', created.room_id);
    expect(readdirSync(coworkRoomDir).sort()).toEqual(['archive.jsonl', 'room.json']);
    expect(JSON.parse(readFileSync(join(coworkRoomDir, 'room.json'), 'utf8')).state).toBe('closed');
  }, 120_000);
});
