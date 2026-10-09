// Actual default Fleet child spawning, runManagedMember, runOnce, leases and IPC.
// Only ACP backend and Cowork management are fixtures; SDK daemon/admission are real.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { attachOursClient } from '@ours.network/sdk/client';
import { prepareManagedAgent, storeRoomSecret, storeTemporaryLaunch } from '../dist/agent-ours/service.js';
import { binderKey } from '../dist/agent-ours/state.js';
import { runFleetManager } from '../dist/supervisor/manager.js';
import { memberKey, memberPath, memberProcess, readMember, registerMember, captureMemberEnvironment } from '../dist/supervisor/catalog.js';
import { agentDir, stateRoot } from '../dist/paths.js';
import { loadConfig, findRole, splitRootFor } from '../dist/config.js';
import '../dist/harness/codex.js';
import { createTask, startTask, updateTaskRoom } from '../dist/rooms-tasks/task-state.js';
import { createRoomRecord, updateMemberSeats, getRoomRecord } from '../dist/rooms-tasks/room-state.js';
import { prepareTempSupervisor, updateTempSupervisor, stopTempSupervisor } from '../dist/temp-lifecycle.js';
import { controlRequest } from '../dist/session/control.js';
import { acceptTaskDeletion, settleTaskDeletion } from '../dist/rooms-tasks/deletion.js';
import { createCoworkAdapter } from '../dist/rooms-tasks/cowork-adapter.js';
import { getTask } from '../dist/rooms-tasks/task-state.js';
import { retireOwnedLayoutMember, layoutOwnedMemberName, ownedLayoutRetirementSeats } from '../dist/rooms-tasks/layout-member-retirement.js';
import { eraseMemberArtifacts } from '../dist/rooms-tasks/erasure.js';
import { managedStartupPrompt, managedTaskPrompt } from '../dist/startup-prompt.js';
const script = fileURLToPath(import.meta.url), cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const acp = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() >= end) throw Error('fixture timed out: ' + label); await pause(50); }
}
if (process.argv[2] === 'parent') {
  // Crucially: no ManagerDeps.spawnChild or runOnce/runTemp injection.
  await runFleetManager(cli);
} else if (process.argv[2] === 'seed') {
  const f = json(process.argv[3]);
  try {
    if (f.temporary) { storeTemporaryLaunch(f.role, f.action); storeRoomSecret(f.role); }
    const service = await prepareManagedAgent(f.role, f.dir, f.temporary); await service.close(false);
  } catch (error) { console.error(error?.message ?? 'seed failed'); process.exitCode = 1; }
} else {
  const root = mkdtempSync('/tmp/fmgr-'), fleetHome = join(root, 'fleet'), daemonState = join(root, 'daemon');
  mkdirSync(fleetHome, { mode: 0o700 }); mkdirSync(daemonState, { mode: 0o700 });
  delete process.env.OURS_FLEET_PROXY_STATE_DIR; delete process.env.OURS_FLEET_PROXY_CALLER;
  process.env.CODEX_HOME = join(root, 'codex'); mkdirSync(process.env.CODEX_HOME, { mode: 0o700 });
  process.env.OURS_FLEET_HOME = fleetHome; process.env.OURS_FLEET_SOCKET_ROOT = join(root, 'sockets');
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const daemonId = randomUUID(), endpoint = `http://127.0.0.1:${port}`, credential = join(root, 'credential');
  const daemonConfig = join(daemonState, 'config.json'); save(daemonConfig, { stateDir: daemonState, port, apiVisibility: 'owner' });
  const daemonEnv = { ...process.env, TMPDIR: '/tmp', OURS_CONFIG: daemonConfig, OURS_STATE_DIR: daemonState,
    OURS_PORT: String(port), OURS_DAEMON_ID: daemonId, OURS_API_VISIBILITY: 'owner', OURS_BROKER_URL: 'wss://invalid.local/none' };
  for (const field of ['OURS_API_TOKEN', 'OURS_TLS_CERT', 'OURS_TLS_KEY', 'OURS_LISTEN_HOST']) delete daemonEnv[field];
  const profilePath = join(root, 'profile.json'); process.env.OURS_CONFIG = profilePath;
  const configPath = join(fleetHome, 'fleet.yaml'), members = new Map(), observed = new Map();
  let daemon, parent, control, daemonExit, parentExit, daemonOutput = '', cowork;
  const children = new Set(), messages = [], rooms = new Map();
  let releaseFaultToken, releaseFaultHits = 0, removeFaultName, scanFault = false, scanFaultHits = 0, roomDeleteFault = false;
  const options = { endpoint, expectedInstanceId: daemonId, credentialPath: credential, sessionMode: 'external', env: {} };
  const watchdog = setTimeout(() => { parent?.kill('SIGKILL'); daemon?.kill('SIGKILL'); for (const pid of children) { try { process.kill(-pid, 'SIGKILL'); } catch {} } process.exit(124); }, 240000);
  const runtimeRoot = join(stateRoot(), 'private-ours');
  function runtime(name) { return json(join(runtimeRoot, binderKey(daemonId, name), 'state.json')); }
  function observedRows() { return [...observed.values()].flatMap(rows => [...rows.values()]); }
  function observeWorkers() {
    for (const key of members.keys()) { const record = readMember(key); if (record?.pid && record.generation) {
      children.add(record.pid); if (!observed.has(key)) observed.set(key, new Map());
      observed.get(key).set(record.generation, { key, pid: record.pid, generation: record.generation });
    } }
  }
  async function stopParent(signal = 'SIGTERM') {
    if (!parent || parent.exitCode !== null || parent.signalCode !== null) return;
    observeWorkers(); const old = observedRows(); parent.kill(signal); await parentExit;
    await until(async () => (await Promise.all(old.map(async row => {
      const record = readMember(row.key);
      return !record || (await memberProcess({ ...record, pid: row.pid, generation: row.generation })).state === 'stopped';
    }))).every(Boolean), 'worker quiescence after ' + signal);
  }
  async function startParent() {
    parent = spawn(process.execPath, [script, 'parent'], { env: { ...process.env, TMPDIR: '/tmp' }, stdio: ['ignore', 'ignore', 'pipe'] });
    parentExit = once(parent, 'exit'); parent.stderr.on('data', chunk => messages.push(String(chunk)));
  }
  function snapshot(f) {
    const state = runtime(f.name);
    return { cid: state.cid, daemon: state.daemon, instance: state.instance, room: state.room,
      session: readFileSync(join(f.dir, '.acp-session-id'), 'utf8').trim(), generation: readMember(f.key).generation };
  }
  async function ready(f) {
    await until(async () => {
      observeWorkers(); assert.equal(parent.exitCode, null, 'parent exited');
      const member = readMember(f.key); if (!member?.pid || !member.generation) return false;
      if ((await memberProcess(member)).state !== 'running') return false;
      if (lines(f.wire).filter(row => row.method === 'session/load').length < observed.get(f.key).size - (f.firstFresh ? 1 : 0)) return false;
      try { const result = await controlRequest(f.dir, { command: 'snapshot' }, 1000); return result.ok; } catch { return false; }
    }, 'production control readiness: ' + f.name);
    const matches = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' }).split('\n')
      .filter(line => line.includes(`${cli} _run-managed ${f.key} `));
    assert.equal(matches.length, 1, `one actual production worker for ${f.key}`); return snapshot(f);
  }
  function rawRole(name, cwd) {
    return { name, identity: name, harness: 'codex', session: 'acp', mission: 'Fixture work: record one safe checkpoint.', cwd,
      session_options: { acp: { command: [process.execPath, acp] } },
      permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
      monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 500, inject: 'notification', interrupt: false },
      env: { OURS_CONFIG: profilePath, ACP_FIXTURE_LOAD_SESSION: '1', ACP_FIXTURE_REQUEST_JSON_LOG: join(root, name + '.wire') } };
  }
  async function seedRuntime(f, role, temporary) {
    // Fixture initial admission uses the same production runtime service. It
    // seeds an already admitted conversation; recovery itself is unmodified.
    const seedPath = join(root, f.name + '.seed.json'); save(seedPath, { role, dir: f.dir, temporary, action: f.action });
    const child = spawn(process.execPath, [script, 'seed', seedPath], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-500); });
    const [code] = await once(child, 'exit'); rmSync(seedPath);
    assert.equal(code, 0, 'runtime seed child failed: ' + error);
    f.originalRuntime = runtime(f.name);
    writeFileSync(join(f.dir, '.identity'), f.name + '\n');
    for (const file of ['.session-id', '.acp-session-id']) writeFileSync(join(f.dir, file), f.session);
    writeFileSync(join(f.dir, '.booted'), 'fixture prior admitted attempt\n');
  }
  async function deleteTaskMember(f, permanent, retry = false, scanRetry = false) {
    const before = readFileSync(memberPath(permanent.key));
    const permanentIdentity = JSON.stringify((await control.listIdentities()).find(row => row.name === permanent.name));
    await acceptTaskDeletion(f.taskId, { kind: 'local_control', surface: 'cli' });
    const settle = () => settleTaskDeletion({ taskId: f.taskId, cowork: () => createCoworkAdapter() });
    if (scanRetry) {
      removeFaultName = f.name;
      await assert.rejects(settle(), /listIdentities/); assert.equal(scanFaultHits, 1);
      assert.equal(runtime(f.name).phase, 'RELEASED');
      assert(!(await control.listIdentities()).some(row => row.name === f.name));
      assert(existsSync(join(runtimeRoot, binderKey(daemonId, f.name))));
      assert.deepEqual(readFileSync(memberPath(permanent.key)), before);
    }
    if (retry) {
      releaseFaultToken = json(join(runtimeRoot, binderKey(daemonId, f.name), 'owner.json')).token;
      await assert.rejects(settle(), /releaseLease/); assert.equal(releaseFaultHits, 1);
      assert.equal(runtime(f.name).phase, 'CLEANUP_PENDING');
      assert(!(await control.listIdentities()).some(row => row.name === f.name));
      assert.deepEqual(readFileSync(memberPath(permanent.key)), before);
      assert(existsSync(join(runtimeRoot, binderKey(daemonId, f.name))));
      roomDeleteFault = true;
      await assert.rejects(settle(), /HTTP 500|protocol|fixture|Cowork|JSON|result/i);
      assert(existsSync(join(runtimeRoot, binderKey(daemonId, f.name))));
      assert.equal(runtime(f.name).phase, 'RELEASED');
      assert.deepEqual(readFileSync(memberPath(permanent.key)), before);
    }
    const result = await settle();
    assert.equal(result.deleted, true); assert.equal(readMember(f.key), undefined);
    assert(!(await control.listIdentities()).some(row => row.name === f.name));
    assert.equal(getRoomRecord(f.roomId), undefined);
    assert.throws(() => getTask(f.taskId), /task not found/);
    assert.equal(existsSync(f.dir), false);
    assert.equal(existsSync(join(runtimeRoot, binderKey(daemonId, f.name))), false);
    assert.deepEqual(readFileSync(memberPath(permanent.key)), before);
    assert.equal(JSON.stringify((await control.listIdentities()).find(row => row.name === permanent.name)), permanentIdentity);
  }
  try {
    console.log('setup: isolated daemon');
    daemon = spawn(process.execPath, [process.env.FLEET_DAEMON_CLI ?? 'node_modules/@ours.network/daemon/dist/cli.js', 'daemon', 'serve', '--managed'],
      { env: daemonEnv, stdio: ['ignore', 'pipe', 'pipe'] }); daemonExit = once(daemon, 'exit');
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { daemonOutput = (daemonOutput + chunk).slice(-3000); });
    await until(async () => { assert.equal(daemon.exitCode, null, 'isolated daemon exited'); try {
      const result = await fetch(endpoint + '/selection', { signal: AbortSignal.timeout(500) });
      return result.ok && (await result.json()).instanceId === daemonId;
    } catch { return false; } }, 'isolated daemon selection', 180000);
    copyFileSync(join(daemonState, 'daemon-token'), credential); chmodSync(credential, 0o600);
    control = await attachOursClient({ ...options, leaseToken: randomUUID() });
    const identity = await control.createRootIdentity({ name: 'IsolatedRoom', bio: '', exposeLocal: false, localAutoAccept: true, skipIfRootExists: false });
    const roomCid = identity.info.cid;
    cowork = createServer(async (req, res) => {
      try {
        if (req.url?.startsWith('/daemon/')) {
          if (req.url.endsWith('/listIdentities') && scanFault) {
            scanFault = false; scanFaultHits++; req.resume(); res.writeHead(503); res.end('fixture lost CID verification'); return;
          }
          let requestBody = '';
          if (req.url.endsWith('/removeIdentity')) req.on('data', chunk => { requestBody += chunk; });
          const upstream = httpRequest(endpoint + req.url.slice('/daemon'.length), { method: req.method, headers: req.headers }, reply => {
            if (req.url.endsWith('/releaseLease') && releaseFaultToken && req.headers['x-ours-lease-token'] === releaseFaultToken) {
              releaseFaultToken = undefined; releaseFaultHits++;
              reply.resume(); reply.on('end', () => { res.writeHead(503); res.end('fixture lost terminal acknowledgement'); }); return;
            }
            if (req.url.endsWith('/removeIdentity') && removeFaultName && JSON.parse(requestBody).name === removeFaultName) {
              removeFaultName = undefined; scanFault = true;
            }
            res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
          });
          upstream.on('error', () => { res.writeHead(502); res.end(); });
          req.pipe(upstream); req.on('close', () => { if (!req.complete) upstream.destroy(); });
          res.on('close', () => upstream.destroy()); return;
        }
        let body = ''; for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body), room = rooms.get(rpc.params.room_id);
        assert.equal(req.headers['x-ours-api-token'], readFileSync(credential, 'utf8').trim());
        if (rpc.method === 'room.delete' && roomDeleteFault) {
          roomDeleteFault = false; res.writeHead(500); res.end('{}'); return;
        }
        if (rpc.method === 'room.close' || rpc.method === 'room.delete') {
          if (room) room.closed = true;
          if (rpc.method === 'room.delete') rooms.delete(rpc.params.room_id);
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, id: rpc.id, result: {} })); return;
        }
        assert.equal(rpc.method, 'room.show'); assert(room);
        const cid = (await control.listIdentities()).find(row => row.name === room.member)?.cid;
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, id: rpc.id, result: {
          room_id: rpc.params.room_id, identity_name: 'IsolatedRoom', identity_cid: roomCid, room_name: 'Fixture', state: room.closed ? 'closed' : 'active',
          seats: cid ? [{ identity: cid, display_name: room.member, invite_id: 'original-seat', role: 'Developer', state: 'active' }] : [],
          role_briefings: {}, anonymous: false,
        } }));
      } catch { res.statusCode = 500; res.end('{}'); }
    }); cowork.listen(0, '127.0.0.1'); await once(cowork, 'listening');
    const serverUrl = `http://127.0.0.1:${cowork.address().port}`;
    save(profilePath, { endpoint: serverUrl + '/daemon', expectedInstanceId: daemonId, credentialPath: credential, serverUrl });
    const roleRaw = rawRole('Permanent', root), agentFile = join(splitRootFor(configPath), 'agents', 'Permanent.yaml');
    mkdirSync(join(agentFile, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, stringify({ api_version: 'ours.network/fleet/v2' }), { mode: 0o600 });
    const { harness, session, session_options, mission, ...ops } = roleRaw; delete ops.name;
    writeFileSync(agentFile, stringify({ role: { inline: { mission } }, brain: { inline: { harness, session, session_options } }, ...ops }), { mode: 0o600 });
    const role = findRole(loadConfig(configPath), 'Permanent');
    const permanent = { name: 'Permanent', key: memberKey('Permanent', 'permanent'), dir: agentDir('Permanent'), session: 'retained-permanent-session', wire: roleRaw.env.ACP_FIXTURE_REQUEST_JSON_LOG, role };
    mkdirSync(permanent.dir, { recursive: true, mode: 0o700 }); members.set(permanent.key, permanent);
    console.log('setup: real permanent runtime'); await seedRuntime(permanent, role, false);
    await registerMember({ name: permanent.name, kind: 'permanent', dir: permanent.dir, configPath, environment: await captureMemberEnvironment() });
    await startParent(); const originalPermanent = await ready(permanent);
    const addTask = async (requestedName, variant = 'idle') => {
      const task = createTask({ title: 'Real parent recovery', origin: { type: 'cli' }, start: false }); startTask(task.task_id);
      const runId = 'task-' + task.task_id, layoutKey = 'worker';
      const name = variant === 'layout' ? layoutOwnedMemberName(runId, layoutKey) : requestedName;
      const roomId = name + '-room'; rooms.set(roomId, { member: name });
      createRoomRecord({ room_id: roomId, room_name: 'Fixture', room_identity_cid: roomCid, task_id: task.task_id, workspace: task.workspace });
      updateTaskRoom(task.task_id, roomId, roomCid);
      const dir = agentDir(name, true), action = variant === 'layout' ? runId + ':' + layoutKey : name + '-action'; mkdirSync(dir, { recursive: true, mode: 0o700 });
      const owner = { taskId: task.task_id, roomId, roomIdentityCid: roomCid, creationActionId: action };
      const kind = variant === 'finite' ? 'temporary' : 'task';
      const metadata = prepareTempSupervisor(dir, name, variant === 'finite' ? undefined : owner);
      await updateTempSupervisor(dir, { kind: 'fleet-managed', target: memberKey(name, kind), binPath: cli, phase: 'active' });
      const invite = await control.generateInvite({ mode: 'one_time' });
      const role = { ...rawRole(name, task.workspace.path), roomMemberStartup: { workspace: task.workspace, task_id: task.task_id, room_id: roomId,
        room_identity_cid: roomCid, identity_name: name, invite_id: 'original-seat', role: 'Developer', task: 'Fixture brief', invite: invite.blob } };
      if (variant === 'interrupted') role.env.ACP_FIXTURE_PROMPT_HOLD_FILE = join(root, name + '.hold');
      if (variant === 'finite') delete role.roomMemberStartup.task_id;
      const f = { runId, layoutKey, firstFresh: variant === 'fresh', name, key: memberKey(name, kind), dir, taskId: task.task_id, roomId, action, launchId: metadata.launchId,
        session: name + '-retained-session', wire: role.env.ACP_FIXTURE_REQUEST_JSON_LOG, role };
      members.set(f.key, f); writeFileSync(join(dir, 'role.yaml'), stringify({ ...role, roomMemberStartup: { ...role.roomMemberStartup, invite: '' } }), { mode: 0o600 });
      save(join(dir, 'creation.json'), { role: name, creationActionId: action });
      console.log('setup: real task runtime ' + name); await seedRuntime(f, role, true);
      const cursor = { version: 1, session: 'established', readiness: true, initial: 'completed', active: false };
      if (variant === 'interrupted') {
        cursor.initial = 'pending'; writeFileSync(role.env.ACP_FIXTURE_PROMPT_HOLD_FILE, 'hold');
      }
      if (variant === 'uncertain') { cursor.initial = 'dispatching'; cursor.active = true; }
      if (variant === 'fresh') {
        cursor.session = 'pending'; cursor.readiness = false; cursor.initial = 'pending';
        rmSync(join(dir, '.acp-session-id')); f.session = 'fixture-session';
      }
      save(join(dir, '.managed-recovery.json'), cursor);
      updateMemberSeats(roomId, [{ role_name: name, identity_cid: runtime(name).cid, slot: 'developer', cowork_role: 'Developer', seat_state: 'active', invite_id: 'original-seat',
        launch: { state: 'launched', action_id: action, launch_id: metadata.launchId, task_supervised: variant !== 'finite', attempt: 1, updated_at: '' } }]);
      await registerMember({ name, kind, dir, ...(variant !== 'finite' ? { taskOwner: owner } : {}), launchId: metadata.launchId, environment: await captureMemberEnvironment() });
      return f;
    };
    const beforeRegistration = readFileSync(memberPath(permanent.key)), task = await addTask('TaskMember', 'interrupted');
    const firstTask = await ready(task); assert.deepEqual(readFileSync(memberPath(permanent.key)), beforeRegistration);
    assert.equal(readMember(permanent.key).generation, originalPermanent.generation);
    assert.equal((await controlRequest(permanent.dir, { command: 'snapshot' }, 1000)).ok, true, 'neighbor permanent control responsive after task registration');
    const taskCursor = () => json(join(task.dir, '.managed-recovery.json'));
    const taskPrompts = () => lines(task.wire).filter(row => row.method === 'session/prompt').map(row => row.prompt.filter(part => part.type === 'text').map(part => part.text).join(''));
    await until(() => taskPrompts().length === 1 && taskCursor().active && taskCursor().initial === 'dispatching', 'initial assignment in flight');
    assert.equal(taskPrompts()[0], managedTaskPrompt(task.dir, 'fresh', false));
    const savedTaskOwner = readFileSync(join(runtimeRoot, binderKey(daemonId, task.name), 'owner.json'));
    let priorPermanent = originalPermanent;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      console.log('recovery: ' + signal); await stopParent(signal);
      if (signal === 'SIGTERM') rmSync(task.role.env.ACP_FIXTURE_PROMPT_HOLD_FILE);
      assert.equal(runtime(permanent.name).phase, 'RELEASED', 'IPC shutdown gracefully releases permanent runtime');
      assert.equal(readMember(permanent.key).desired, 'running'); assert.equal(readMember(task.key).desired, 'running');
      await startParent(); const p = await ready(permanent), t = await ready(task);
      for (const field of ['cid', 'daemon', 'session']) assert.equal(p[field], originalPermanent[field]);
      assert.notEqual(p.instance, priorPermanent.instance); priorPermanent = p;
      for (const field of ['cid', 'daemon', 'instance', 'session']) assert.equal(t[field], firstTask[field]);
      assert.deepEqual(t.room, firstTask.room); assert.equal(readMember(task.key).launchId, task.launchId);
      assert.deepEqual(readFileSync(join(runtimeRoot, binderKey(daemonId, task.name), 'owner.json')), savedTaskOwner);
      await until(() => taskCursor().initial === 'completed' && !taskCursor().active, 'continuation completed');
      await pause(200); assert.equal(taskPrompts().length, 2);
    }
    for (const f of [permanent, task]) {
      assert.equal(observed.get(f.key).size, 3); const wire = lines(f.wire);
      assert.equal(wire.filter(row => row.method === 'session/load').length, 3);
      assert(wire.filter(row => row.method === 'session/load').every(row => row.sessionId === f.session));
      assert.equal(wire.filter(row => row.method === 'session/new').length, 0);
    }
    const permanentPrompts = lines(permanent.wire).filter(row => row.method === 'session/prompt')
      .map(row => row.prompt.filter(part => part.type === 'text').map(part => part.text).join(''));
    assert.deepEqual(permanentPrompts, Array.from({ length: 3 }, () => [
      managedStartupPrompt(permanent.dir, 'resume', true), managedTaskPrompt(permanent.dir, 'resume', true),
    ]).flat());
    assert.match(taskPrompts()[1], /^Fleet supervisor restarted\. Continue pending work/);
    assert(taskPrompts()[1].includes(join(task.dir, 'briefing.md')));
    assert.equal(taskPrompts().filter(text => text === managedTaskPrompt(task.dir, 'fresh', false)).length, 1);
    console.log('delete: parent up with lost release response and retry before artifact erasure'); await deleteTaskMember(task, permanent, true);
    const fresh = await addTask('TaskFirstSession', 'fresh'); const firstFresh = await ready(fresh);
    await until(() => json(join(fresh.dir, '.managed-recovery.json')).initial === 'completed', 'first-session assignment completed');
    const freshWire = lines(fresh.wire); assert.equal(freshWire.filter(row => row.method === 'session/new').length, 1);
    assert.equal(freshWire.filter(row => row.method === 'session/load').length, 0);
    const freshPromptCount = freshWire.filter(row => row.method === 'session/prompt').length; assert.equal(freshPromptCount, 2);
    await stopParent(); await startParent(); const resumedFresh = await ready(fresh); await ready(permanent); await pause(200);
    for (const field of ['cid', 'daemon', 'instance', 'session']) assert.equal(resumedFresh[field], firstFresh[field]);
    assert.equal(lines(fresh.wire).filter(row => row.method === 'session/new').length, 1);
    assert.equal(lines(fresh.wire).filter(row => row.method === 'session/prompt').length, freshPromptCount);
    await deleteTaskMember(fresh, permanent);
    const uncertain = await addTask('TaskUncertain', 'uncertain'); await ready(uncertain);
    await until(() => json(join(uncertain.dir, '.managed-recovery.json')).initial === 'completed', 'uncertain dispatch continuation completed');
    const uncertainPrompts = lines(uncertain.wire).filter(row => row.method === 'session/prompt');
    assert.equal(uncertainPrompts.length, 1); assert(uncertainPrompts[0].prompt[0].text.includes(join(uncertain.dir, 'briefing.md')));
    await deleteTaskMember(uncertain, permanent);
    const layout = await addTask('LayoutOwned', 'layout'); const layoutRuntime = await ready(layout);
    const permanentBeforeLayout = readFileSync(memberPath(permanent.key));
    const permanentIdentityBeforeLayout = JSON.stringify((await control.listIdentities()).find(row => row.name === permanent.name));
    const instance = { supervisor: stateRoot(), agent: layout.name, temporary: true, launch: layoutRuntime.instance, cid: layoutRuntime.cid, session: layoutRuntime.session };
    await retireOwnedLayoutMember(instance, layout.runId, layout.layoutKey, {}, true);
    assert.equal(runtime(layout.name).phase, 'RELEASED'); assert.equal(readMember(layout.key), undefined);
    assert(!(await control.listIdentities()).some(row => row.name === layout.name));
    const seats = ownedLayoutRetirementSeats({ participants: { worker: { owned: true, retired: true, instance }, borrowed: { owned: false, instance: { ...instance, agent: permanent.name, temporary: false } } } }, layout.runId);
    await eraseMemberArtifacts('task', layout.taskId, seats, [layout.roomId]);
    assert.equal(existsSync(join(runtimeRoot, binderKey(daemonId, layout.name))), false);
    assert.deepEqual(readFileSync(memberPath(permanent.key)), permanentBeforeLayout);
    assert.equal(JSON.stringify((await control.listIdentities()).find(row => row.name === permanent.name)), permanentIdentityBeforeLayout);
    await deleteTaskMember(layout, permanent);
    const scanRetry = await addTask('TaskCidRetry'); await ready(scanRetry);
    console.log('delete: fault after SDK removal before CID verification'); await deleteTaskMember(scanRetry, permanent, false, true);
    const finite = await addTask('NormalOperatorStop', 'finite'); await ready(finite);
    console.log('delete: live finite worker completed terminal operator stop'); await stopTempSupervisor(finite.name);
    await until(() => runtime(finite.name).phase === 'RELEASED' && !existsSync(finite.dir), 'normal terminal worker release/archive');
    assert(existsSync(join(runtimeRoot, binderKey(daemonId, finite.name), 'owner.json')));
    await deleteTaskMember(finite, permanent);
    const taskStop = await addTask('TaskOperatorStop'); await ready(taskStop);
    console.log('delete: live task worker completed terminal operator stop'); await stopTempSupervisor(taskStop.name);
    await until(() => runtime(taskStop.name).phase === 'RELEASED' && !existsSync(taskStop.dir), 'task operator terminal release/archive');
    assert(existsSync(join(runtimeRoot, binderKey(daemonId, taskStop.name), 'owner.json')));
    await deleteTaskMember(taskStop, permanent);
    const second = await addTask('TaskDeleteDown'); await ready(second);
    console.log('delete: parent down'); await stopParent(); await deleteTaskMember(second, permanent);
    await startParent(); await ready(permanent); await pause(400);
    assert.equal(readMember(second.key), undefined); assert.equal(observed.get(second.key).size, 1);
    console.log('baseline: direct permanent supervisor abrupt death'); await stopParent();
    const direct = () => {
      const child = spawn(process.execPath, [cli, '_run', permanent.name, '-c', configPath], { env: process.env, detached: true, stdio: 'ignore' });
      children.add(child.pid); return child;
    };
    const directReady = async expectedLoads => until(async () => {
      if (lines(permanent.wire).filter(row => row.method === 'session/load').length < expectedLoads) return false;
      try { return (await controlRequest(permanent.dir, { command: 'snapshot' }, 1000)).ok; } catch { return false; }
    }, 'direct baseline control readiness');
    const priorLoads = lines(permanent.wire).filter(row => row.method === 'session/load').length;
    const baseline = direct(); await directReady(priorLoads + 1); const baselineInstance = runtime(permanent.name).instance;
    const baselineExit = once(baseline, 'exit'); process.kill(-baseline.pid, 'SIGKILL'); await baselineExit;
    assert.notEqual(runtime(permanent.name).phase, 'RELEASED');
    const baselineRestart = direct(); await directReady(priorLoads + 2);
    assert.equal(runtime(permanent.name).instance, baselineInstance);
    assert.equal(runtime(permanent.name).cid, originalPermanent.cid);
    const baselineRestartExit = once(baselineRestart, 'exit'); baselineRestart.kill('SIGTERM'); await baselineRestartExit;
    assert.equal(runtime(permanent.name).phase, 'RELEASED');
    console.log('PASS: default-spawn production runManagedMember/runOnce SIGTERM/SIGKILL; same real SDK CID/instance/contact admission and ACP session ID; one worker/member, exact observed generations; real control responsiveness; initial/interrupted/completed-idle ACP delivery cursor, first-session missing backend ID, uncertain dispatch briefing pointer, saved-owner release acknowledgement retry, SDK-remove-before-CID-verify retry and post-verification retry, normal live finite/task operator terminal release, actual layout-owned retirement; parent-up/down full task/room/workspace/artifact deletion preserves permanent record. Parent TERM/KILL gracefully releases permanent instances; task instance/admission remain retained. Direct permanent supervisor SIGKILL retains its instance, explicitly differing from parent IPC quiescence. Native services/reboot and authenticated model harness remain unqualified.');
  } catch (error) {
    console.error('parent diagnostics:', messages.join('').slice(-2000));
    for (const key of members.keys()) { const m = readMember(key); console.error('worker state:', key, m?.desired, m?.generation, m?.pid, m?.retryAt); }
    // Only allowlisted diagnostics; never dump private profiles or runtime tokens.
    for (const f of members.values()) if (existsSync(join(f.dir, 'supervisor.log'))) {
      const log = readFileSync(join(f.dir, 'supervisor.log'), 'utf8');
      console.error(f.name + ' worker diagnostic:', log.split('\n').filter(line => line && line.length < 1500).slice(-16).join('\n'));
    }
    throw Error(error?.message ?? 'fixture failure');
  } finally {
    clearTimeout(watchdog); try { await stopParent(); } catch { parent?.kill('SIGKILL'); }
    for (const pid of children) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    if (cowork) await new Promise(resolve => cowork.close(resolve));
    try { await control?.releaseLease(); await control?.close(); } finally {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon.kill('SIGKILL'), 7000); await daemonExit; clearTimeout(timer); }
      rmSync(root, { recursive: true, force: true });
    }
  }
}
