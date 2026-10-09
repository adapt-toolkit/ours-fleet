import { fleetHostBackend } from '../src/supervisor/fleet.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { createTask, startTask, updateTaskRoom, beginTaskDeletionIntent } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, updateMemberSeats } from '../src/rooms-tasks/room-state.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { prepareTempSupervisor, readTempSupervisor, makeTempSupervisorLauncher, reclaimStaleTempState, stopTempSupervisor } from '../src/temp-lifecycle.js';
import { memberKey, memberPath, readMember } from '../src/supervisor/catalog.js';
import { taskSupervisorMayRun } from '../src/task-supervision.js';
import { migrateLegacyTaskMembers, taskSystemdUnit, taskLaunchdLabel, uninstallRetainedTaskService, assertTaskServicesAbsent } from '../src/task-supervisor-service.js';
import { runTemp, readRestartLedger, writeRestartLedger } from '../src/runner.js';
import { recoverTaskMembers } from '../src/rooms-tasks/recovery.js';
import { adoptLegacyTaskMember } from '../src/rooms-tasks/legacy-task-member.js';
import { binderKey } from '../src/agent-ours/state.js';
import { readClientProfile } from '../src/client-profile.js';
import { parse } from 'yaml';
import { gatewayFixture } from './gateway-fixture.js';

let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fleet-task-durable-'));
  vi.stubEnv('OURS_FLEET_HOME', root);
  vi.stubEnv('OURS_CONFIG', gatewayFixture(root).env.OURS_CONFIG);
  const setup = async () => ({ code: 0, stdout: '', stderr: '' });
  await fleetHostBackend(setup, 'linux').init('/fixture/fleet');
  await fleetHostBackend(setup, 'darwin').init('/fixture/fleet');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const task = createTask({ title: 'Durable', origin: { type: 'cli' }, start: false });
  startTask(task.task_id);
  const room = createRoomRecord({ room_id: 'task-room', room_name: 'Durable', room_identity_cid: 'ROOMCID', task_id: task.task_id });
  updateTaskRoom(task.task_id, room.room_id, 'ROOMCID');
  const name = 'TaskDeveloper', dir = agentDir(name, true), action = 'task-action';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.yaml'), stringify({ name, identity: name, harness: 'codex', cwd: task.workspace!.path, monitor: { mode: 'fleet' }, roomMemberStartup: {
    workspace: task.workspace, task_id: task.task_id, room_id: room.room_id, room_identity_cid: 'ROOMCID', identity_name: name, invite_id: 'invite', role: 'Developer', task: 'Work', invite: '', owner_seat_cid: null,
  } }));
  writeFileSync(join(dir, 'creation.json'), JSON.stringify({ role: name, creationActionId: action }));
  const metadata = prepareTempSupervisor(dir, name, { taskId: task.task_id, roomId: room.room_id, roomIdentityCid: 'ROOMCID', creationActionId: action });
  updateMemberSeats(room.room_id, [{ role_name: name, slot: 'developer', cowork_role: 'Developer', seat_state: 'pending', invite_id: 'invite', launch: {
    state: 'intent', action_id: action, attempt: 1, updated_at: '',
  } }]);
  return { task, room, name, dir, metadata };
}

function seedLegacyService(f: ReturnType<typeof fixture>) {
  const target = taskSystemdUnit(f.name), path = join(root, '.config/systemd/user', target);
  const contents = `[Service]\nEnvironment="OURS_CONFIG=${process.env.OURS_CONFIG}"\nExecStart=/fixture/fleet _run-temp ${f.name}\n`;
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, contents);
  const proof = join(stateRoot(), 'task-supervisors', f.name + '.json');
  mkdirSync(join(proof, '..'), { recursive: true });
  writeFileSync(proof, JSON.stringify({ version: 1, role: f.name, taskOwner: f.metadata.taskOwner,
    launchId: f.metadata.launchId, kind: 'systemd-persistent', target,
    fileHash: createHash('sha256').update(contents).digest('hex') }));
  writeFileSync(join(f.dir, '.temp-supervisor.json'), JSON.stringify({ ...f.metadata, kind: 'systemd-persistent', target, phase: 'active' }));
}

it.each(['linux', 'darwin'] as const)('registers task members under the single Fleet service on %s and removes only membership', async platform => {
  const f = fixture(), calls: string[][] = [];
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'launchctl' && args[0] === 'print') return calls.some(call => call[1] === 'bootstrap')
      ? { code: 0, stdout: 'state = running', stderr: '' } : { code: 1, stdout: '', stderr: 'Could not find service' };
    return { code: 0, stdout: 'active\n', stderr: '' };
  });
  await makeTempSupervisorLauncher({ platform, supervisor: platform === 'linux' ? 'systemd' : 'launchd', exec })('/fixture/fleet', ['_run-temp', f.name], f.dir);
  const service = platform === 'linux'
    ? join(root, '.config/systemd/user/ours-fleet.service')
    : join(root, 'Library/LaunchAgents/network.ours.fleet.plist');
  const text = readFileSync(service, 'utf8');
  expect(text).toContain('_run-fleet');
  expect(readMember(memberKey(f.name, 'task'))?.taskOwner).toEqual(f.metadata.taskOwner);
  expect(text).toContain(platform === 'linux' ? 'WantedBy=default.target' : '<key>RunAtLoad</key><true/>');
  expect(text).not.toContain('OURS_API_TOKEN');
  expect(calls.some(call => call[0] === 'systemd-run' || call[1] === 'submit')).toBe(false);
  expect(readTempSupervisor(f.dir)?.taskOwner).toEqual(f.metadata.taskOwner);
  const id = readTempSupervisor(f.dir)?.launchId;
  await reclaimStaleTempState({ now: () => Date.now() + 100_000, exec: async () => ({ code: 0, stdout: 'inactive\n', stderr: '' }) });
  expect(existsSync(f.dir)).toBe(true);
  await stopTempSupervisor(f.name, { exec });
  expect(existsSync(service)).toBe(true);
  expect(readMember(memberKey(f.name, 'task'))).toBeUndefined();
  expect(readTempSupervisor(f.dir)?.launchId).toBe(id);
  expect(calls.some(call => call.includes('disable') || call.includes('bootout') || call.includes('restart'))).toBe(false);
});

it('preserves state and retries cleanup after failed persistent service disable', async () => {
  const f = fixture();
  seedLegacyService(f);
  await expect(stopTempSupervisor(f.name, { exec: async () => ({ code: 1, stdout: '', stderr: 'bus unavailable' }) })).rejects.toThrow('TASK_SERVICE_DISABLE_FAILED');
  expect(existsSync(join(root, '.config/systemd/user', taskSystemdUnit(f.name)))).toBe(true);
  expect(existsSync(f.dir)).toBe(true);
  await stopTempSupervisor(f.name, { exec: async () => ({ code: 0, stdout: '', stderr: '' }) });
  expect(existsSync(join(root, '.config/systemd/user', taskSystemdUnit(f.name)))).toBe(false);
});

it('fences deleted tasks and mismatched actions before harness/identity work', async () => {
  const f = fixture();
  expect(taskSupervisorMayRun(f.name)).toBe(true);
  const attempt = vi.fn();
  beginTaskDeletionIntent(f.task.task_id, { kind: 'local_control', surface: 'cli' });
  expect(taskSupervisorMayRun(f.name)).toBe(false);
  await runTemp(f.name, {}, attempt);
  expect(attempt).not.toHaveBeenCalled();
  expect(existsSync(f.dir)).toBe(true);
  writeFileSync(join(f.dir, 'creation.json'), JSON.stringify({ role: f.name, creationActionId: 'wrong' }));
  await expect(runTemp(f.name, {}, attempt)).rejects.toThrow('TASK_SUPERVISOR_OWNERSHIP_MISMATCH');
});

it('retains state and owner on orderly supervisor stop and counts failures across resumes', async () => {
  const f = fixture(), release = vi.fn();
  writeFileSync(join(f.dir, '.session-id'), 'stable-session\n');
  let stop = false, clock = 0;
  const attempts = vi.fn(async (_name, options) => {
    expect(options).toMatchObject({ temp: true, allowResumeRotation: false });
    return { elapsedSecs: 0, mode: 'resume' as const, rotated: false, exit: { version: 1 as const, class: 'unknown' as const, detail: 'failed session' } };
  });
  await runTemp(f.name, { shouldStop: () => stop, releaseAgentOurs: release, now: () => clock, sleep: async ms => { clock += ms; stop = true; }, log: () => {} }, attempts);
  expect(attempts).toHaveBeenCalledTimes(1);
  expect(readRestartLedger(f.dir).consecutiveImmediateFailures).toBe(1);
  stop = false;
  await runTemp(f.name, { shouldStop: () => stop, releaseAgentOurs: release, now: () => clock, sleep: async ms => { clock += ms; stop = true; }, log: () => {} }, attempts);
  expect(readRestartLedger(f.dir).consecutiveImmediateFailures).toBe(2);
  expect(readFileSync(join(f.dir, '.session-id'), 'utf8')).toBe('stable-session\n');
  expect(readTempSupervisor(f.dir)?.launchId).toBe(f.metadata.launchId);
  expect(release).not.toHaveBeenCalled();
  expect(existsSync(join(f.dir, '.supervisor-run.json'))).toBe(false);
  expect(existsSync(join(f.dir, 'termination.jsonl'))).toBe(false);
});

it('recovers the same task launch after real process signals and rejects an overlapping supervisor', async () => {
  const f = fixture(), driver = join(root, 'task-worker.mjs');
  const runner = fileURLToPath(new URL('../dist/runner.js', import.meta.url));
  const metadataPath = join(f.dir, '.temp-supervisor.json');
  writeFileSync(join(f.dir, '.session-id'), 'stable-session\n');
  writeFileSync(driver, `import {runTemp} from ${JSON.stringify(runner)};
    import {readFileSync} from 'node:fs';
    await runTemp(${JSON.stringify(f.name)}, {log:()=>{}}, async(name,opts,deps)=>{
      process.send({pid:process.pid,session:readFileSync(${JSON.stringify(join(f.dir, '.session-id'))},'utf8'),opts});
      while(!deps.shouldStop()) await new Promise(r=>setTimeout(r,10));
      return {elapsedSecs:100,mode:'resume',rotated:false,exit:{version:1,class:'clean',detail:'shutdown'}};
    });`);
  const children: ReturnType<typeof spawn>[] = [];
  const launch = () => {
    const child = spawn(process.execPath, [driver], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let error = ''; child.stderr!.on('data', chunk => { error += chunk; });
    const exited = new Promise<{code: number | null; signal: string | null; error: string}>(resolve => child.once('exit', (code, signal) => resolve({ code, signal, error })));
    const started = new Promise<{pid: number; session: string; opts: unknown}>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('worker readiness timeout')), 10_000);
      child.once('message', value => { clearTimeout(timeout); resolve(value as any); });
      child.once('exit', () => { clearTimeout(timeout); reject(Error(error || 'worker exited')); });
    });
    return { child, exited, started };
  };
  try {
    const first = launch(), a = await first.started;
    expect(a.opts).toMatchObject({ temp: true, allowResumeRotation: false });
    const overlap = launch();
    await expect(overlap.started).rejects.toThrow(/overlap|handoff|within/);
    expect((await overlap.exited).code).not.toBe(0);
    expect(JSON.parse(readFileSync(metadataPath, 'utf8')).pid).toBe(a.pid);
    first.child.kill('SIGTERM');
    expect((await first.exited).code).toBe(0);
    expect(existsSync(f.dir)).toBe(true);
    expect(existsSync(join(f.dir, 'termination.jsonl'))).toBe(false);
    const second = launch(), b = await second.started;
    expect(b.session).toBe(a.session);
    second.child.kill('SIGKILL'); await second.exited;
    const third = launch(), c = await third.started;
    expect(c.session).toBe(a.session);
    expect(c.pid).not.toBe(b.pid);
    expect(readRestartLedger(f.dir).lastTermination?.class).toBe('abrupt');
    expect(readTempSupervisor(f.dir)?.launchId).toBe(f.metadata.launchId);
    third.child.kill('SIGTERM'); expect((await third.exited).code).toBe(0);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 25_000);

function admittedFixture() {
  const f = fixture(), cid = 'MEMBERCID', daemon = readClientProfile(process.env).expectedInstanceId;
  updateMemberSeats(f.room.room_id, [{ role_name: f.name, identity_cid: cid, slot: 'developer', cowork_role: 'Developer',
    seat_state: 'active', invite_id: 'invite', launch: { state: 'launched', action_id: 'task-action',
      launch_id: f.metadata.launchId, attempt: 1, updated_at: '' } }]);
  const privateDir = join(stateRoot(), 'private-ours', binderKey(daemon, f.name));
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, 'instance.json'), JSON.stringify({ instance: 'instance', role: f.name, temporary: true }));
  writeFileSync(join(privateDir, 'owner.json'), JSON.stringify({ instance: 'instance', token: 'fixture-owner' }));
  writeFileSync(join(privateDir, 'identity-pin.json'), JSON.stringify({ daemon, name: f.name, cid }));
  writeFileSync(join(privateDir, 'state.json'), JSON.stringify({ version: 1, instance: 'instance', generation: 1,
    daemon, name: f.name, cid, lifetime: 'temporary', action: 'task-action', phase: 'RECOVERING', revision: 1, updatedAt: '',
    room: { id: f.room.room_id, cid: 'ROOMCID', seat: 'Developer', agentCid: cid, action: 'invite' } }));
  const launchDir = join(stateRoot(), 'private-ours', 'launches'); mkdirSync(launchDir, { recursive: true });
  writeFileSync(join(launchDir, binderKey('temporary', f.name) + '.json'), JSON.stringify({ role: f.name, identity: f.name, action: 'task-action' }));
  const inputs = join(stateRoot(), 'private-ours', 'room-inputs'); mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, binderKey('ROOMCID', f.name) + '.ready.json'), JSON.stringify({ room: f.room.room_id, cid, invite: 'invite', generation: 1 }));
  writeFileSync(join(f.dir, '.session-id'), 'stable-runner');
  writeFileSync(join(f.dir, '.acp-session-id'), 'stable-acp');
  writeFileSync(join(f.dir, '.booted'), 'previous-start');
  writeFileSync(join(f.dir, '.identity'), f.name);
  const remote = { room_id: f.room.room_id, identity_cid: 'ROOMCID', state: 'active', seats: [{
    display_name: f.name, identity_cid: cid, invite_id: 'invite', role: 'Developer', seat_state: 'active' }] };
  return { ...f, privateDir, cowork: { getRoom: vi.fn(async () => remote as any) } };
}

it('resumes proven members and resets a held circuit without changing launch/context', async () => {
  const f = admittedFixture(), resume = vi.fn(async () => {});
  writeRestartLedger(f.dir, { version: 1, consecutiveImmediateFailures: 5, circuit: 'open',
    resumeDiscarded: false, nextDelayMs: 0, updatedAt: '' });
  expect(await recoverTaskMembers({ taskId: f.task.task_id, binPath: '/fixture/fleet', cowork: f.cowork,
    deps: { liveness: async () => 'stopped', resume } })).toEqual([{ name: f.name, status: 'resumed' }]);
  expect(resume).toHaveBeenCalledWith(f.name, '/fixture/fleet');
  expect(readRestartLedger(f.dir).circuit).toBe('closed');
  expect(readTempSupervisor(f.dir)?.launchId).toBe(f.metadata.launchId);
  expect(readFileSync(join(f.dir, '.acp-session-id'), 'utf8')).toBe('stable-acp');
});

it('leaves running legacy members untouched, then adopts only proven stopped state', async () => {
  const f = admittedFixture(), resume = vi.fn(async () => {});
  const metadata = readTempSupervisor(f.dir)!; delete metadata.taskOwner;
  writeFileSync(join(f.dir, '.temp-supervisor.json'), JSON.stringify(metadata));
  const role = parse(readFileSync(join(f.dir, 'role.yaml'), 'utf8')); delete role.roomMemberStartup.task_id;
  writeFileSync(join(f.dir, 'role.yaml'), stringify(role));
  const before = readFileSync(join(f.dir, 'role.yaml'));
  expect(await recoverTaskMembers({ taskId: f.task.task_id, binPath: '/fixture/fleet', cowork: f.cowork,
    deps: { liveness: async () => 'running', resume } })).toEqual([{ name: f.name, status: 'migration_pending' }]);
  expect(readFileSync(join(f.dir, 'role.yaml'))).toEqual(before); expect(resume).not.toHaveBeenCalled();
  await recoverTaskMembers({ taskId: f.task.task_id, binPath: '/fixture/fleet', cowork: f.cowork,
    deps: { liveness: async () => 'stopped', resume, adopt: async () => {
      await adoptLegacyTaskMember(f.metadata.taskOwner!, f.name, { liveness: async () => 'stopped', verifyIdentity: async () => {} });
    } } });
  expect(resume).toHaveBeenCalledTimes(1);
  expect(readTempSupervisor(f.dir)?.launchId).toBe(f.metadata.launchId);
});

it.each(['unknown', 'session', 'owner', 'workspace', 'retirement', 'remote'])('fails recovery closed for %s evidence', async missing => {
  const f = admittedFixture(), resume = vi.fn(async () => {});
  if (missing === 'session') rmSync(join(f.dir, '.acp-session-id'));
  if (missing === 'owner') rmSync(join(f.privateDir, 'owner.json'));
  if (missing === 'workspace') writeFileSync(join(f.task.workspace!.path, '.fleet-workspace.json'), '{}');
  if (missing === 'retirement') writeFileSync(join(f.dir, '.temp-stop-request.json'), JSON.stringify({ reason: 'operator-stop' }));
  if (missing === 'remote') f.cowork.getRoom.mockRejectedValue(Error('authority unavailable'));
  await expect(recoverTaskMembers({ taskId: f.task.task_id, binPath: '/fixture/fleet', cowork: f.cowork,
    deps: { liveness: async () => missing === 'unknown' ? 'unknown' : 'stopped', resume } })).rejects.toThrow();
  expect(resume).not.toHaveBeenCalled();
  expect(readTempSupervisor(f.dir)?.launchId).toBe(f.metadata.launchId);
});

it('does not bootstrap an existing macOS service when liveness cannot be read', async () => {
  const f = fixture(), exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'permission denied' }));
  await expect(makeTempSupervisorLauncher({ platform: 'darwin', supervisor: 'launchd', exec })(
    '/fixture/fleet', ['_run-temp', f.name], f.dir)).rejects.toThrow('FLEET_SERVICE_LIVENESS_UNKNOWN');
  expect(exec.mock.calls).toHaveLength(1);
});

it('uses explicit layout ownership and excludes borrowed participants from recovery', async () => {
  const task = createTask({ title: 'Layout', origin: { type: 'cli' }, layout: { name: 'work', definition_hash: 'hash' } });
  const runId = task.layout!.run_id, key = 'room:developer';
  const name = `layout-${createHash('sha256').update(runId + ':' + key).digest('hex').slice(0, 16)}`;
  const dir = agentDir(name, true); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.yaml'), stringify({ name, identity: name, cwd: task.workspace!.path }));
  writeFileSync(join(dir, 'creation.json'), JSON.stringify({ role: name, creationActionId: `${runId}:${key}` }));
  prepareTempSupervisor(dir, name, { taskId: task.task_id, layout: { runId, participant: key }, creationActionId: `${runId}:${key}` });
  const layoutDir = join(stateRoot(), 'layouts'); mkdirSync(layoutDir, { recursive: true });
  const path = join(layoutDir, runId + '.json');
  writeFileSync(path, JSON.stringify({ participants: { [key]: { owned: true } } }));
  expect(taskSupervisorMayRun(name)).toBe(true); // provisioning intent precedes the first instance
  writeFileSync(path, JSON.stringify({ participants: { [key]: { owned: false } } }));
  expect(() => taskSupervisorMayRun(name)).toThrow('TASK_LAYOUT_PARTICIPANT_MISMATCH');
  const resume = vi.fn(async () => {}), liveness = vi.fn(async () => 'stopped' as const);
  expect(await recoverTaskMembers({ taskId: task.task_id, binPath: '/fixture/fleet', deps: { resume, liveness } })).toEqual([]);
  expect(resume).not.toHaveBeenCalled(); expect(liveness).not.toHaveBeenCalled();
});

it('removes the exact retained service after losing live task member state', async () => {
  const f = fixture(), exec = vi.fn(async () => ({ code: 0, stdout: 'active', stderr: '' }));
  await makeTempSupervisorLauncher({ platform: 'linux', supervisor: 'systemd', exec })(
    '/fixture/fleet', ['_run-temp', f.name], f.dir);
  const proof = memberPath(memberKey(f.name, 'task'));
  const service = join(root, '.config/systemd/user/ours-fleet.service');
  rmSync(f.dir, { recursive: true });
  await expect(uninstallRetainedTaskService(f.name, { taskId: 'other-task', creationActionId: 'task-action' }, exec))
    .rejects.toThrow('TASK_SERVICE_OWNER_MISMATCH');
  expect(existsSync(service)).toBe(true); expect(existsSync(proof)).toBe(true);
  await uninstallRetainedTaskService(f.name, f.metadata.taskOwner!, exec);
  expect(existsSync(service)).toBe(true); expect(existsSync(proof)).toBe(false);
  await uninstallRetainedTaskService(f.name, f.metadata.taskOwner!, async () => ({ code: 0, stdout: 'not-found', stderr: '' })); // retry
});

it('preserves a replaced service file and its cleanup proof', async () => {
  const f = fixture(), exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  seedLegacyService(f);
  const service = join(root, '.config/systemd/user', taskSystemdUnit(f.name));
  writeFileSync(service, 'replacement service'); exec.mockClear();
  await expect(uninstallRetainedTaskService(f.name, f.metadata.taskOwner!, exec)).rejects.toThrow('TASK_SERVICE_FILE_MISMATCH');
  expect(exec).not.toHaveBeenCalled();
  expect(readFileSync(service, 'utf8')).toBe('replacement service');
  expect(existsSync(join(stateRoot(), 'task-supervisors', f.name + '.json'))).toBe(true);
});

it('refuses corrupt task supervisor metadata instead of entering standalone temporary retirement', async () => {
  const f = fixture(), attempt = vi.fn();
  writeFileSync(join(f.dir, '.temp-supervisor.json'), '{}');
  await expect(runTemp(f.name, {}, attempt)).rejects.toThrow('TASK_SUPERVISOR_OWNER_MISSING');
  expect(attempt).not.toHaveBeenCalled(); expect(existsSync(f.dir)).toBe(true);
});

it.each(['permanent', 'symlink'])('refuses retained task startup with %s ownership evidence', mode => {
  const f = admittedFixture();
  if (mode === 'permanent') mkdirSync(agentDir(f.name), { recursive: true });
  else { const path = join(f.privateDir, 'identity-pin.json'), copy = join(root, 'other-pin');
    writeFileSync(copy, readFileSync(path)); rmSync(path); symlinkSync(copy, path); }
  expect(() => taskSupervisorMayRun(f.name)).toThrow();
});

it('refuses service removal through a symlinked ownership marker', async () => {
  const f = fixture(), exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  seedLegacyService(f);
  const path = join(stateRoot(), 'task-supervisors', f.name + '.json'), copy = join(root, 'foreign-service-owner');
  writeFileSync(copy, readFileSync(path)); rmSync(path); symlinkSync(copy, path); exec.mockClear();
  await expect(uninstallRetainedTaskService(f.name, f.metadata.taskOwner!, exec)).rejects.toThrow('TASK_SERVICE_UNSAFE_PROOF');
  expect(exec).not.toHaveBeenCalled(); expect(existsSync(copy)).toBe(true);
});

it('blocks task erasure while a surviving service proof references a lost layout or room', async () => {
  const f = fixture(), exec = async () => ({ code: 0, stdout: 'active', stderr: '' });
  await makeTempSupervisorLauncher({ platform: 'linux', supervisor: 'systemd', exec })('/fixture/fleet', ['_run-temp', f.name], f.dir);
  expect(() => assertTaskServicesAbsent('another-task')).not.toThrow();
  rmSync(f.dir, { recursive: true });
  expect(() => assertTaskServicesAbsent(f.task.task_id)).toThrow('TASK_SERVICES_REMAIN');
  await uninstallRetainedTaskService(f.name, { taskId: f.task.task_id, launchId: f.metadata.launchId }, exec);
  expect(() => assertTaskServicesAbsent(f.task.task_id)).not.toThrow();
});

it('resumes the same legacy task transfer after native removal before central publication', async () => {
  const f = fixture(); seedLegacyService(f);
  const proof = join(stateRoot(), 'task-supervisors', f.name + '.json');
  let fail = true;
  const exec = async (_cmd: string, args: string[]) => {
    if (args.includes('daemon-reload') && fail) { fail = false; return { code: 1, stdout: '', stderr: 'interrupted reload' }; }
    return { code: 0, stdout: args.includes('is-enabled') ? 'enabled' : '', stderr: '' };
  };
  await expect(migrateLegacyTaskMembers(exec)).rejects.toThrow('systemctl --user failed');
  expect(existsSync(proof)).toBe(true); expect(readMember('task-' + f.name)).toBeUndefined();
  expect(existsSync(join(root, '.config/systemd/user', taskSystemdUnit(f.name)))).toBe(false);
  await migrateLegacyTaskMembers(exec);
  expect(existsSync(proof)).toBe(false);
  expect(readMember('task-' + f.name)).toMatchObject({ desired: 'running', taskOwner: f.metadata.taskOwner, launchId: f.metadata.launchId });
  expect(readTempSupervisor(f.dir)).toMatchObject({ kind: 'fleet-managed', launchId: f.metadata.launchId });
});
it('serializes task transfer and deletion so a retained crash receipt cannot resurrect a retired member', async () => {
  const f = fixture(); seedLegacyService(f);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const migration = migrateLegacyTaskMembers(async (_cmd, args) => {
    if (args.includes('disable')) { entered(); await gate; }
    return { code: 0, stdout: args.includes('is-enabled') ? 'enabled' : '', stderr: '' };
  });
  await started;
  beginTaskDeletionIntent(f.task.task_id, { kind: 'local_control', surface: 'cli' });
  const deletion = uninstallRetainedTaskService(f.name, { ...f.metadata.taskOwner!, launchId: f.metadata.launchId }, async () => ({ code: 0, stdout: 'not-found', stderr: '' }));
  release(); await migration; await deletion;
  expect(readMember('task-' + f.name)).toBeUndefined();
  await migrateLegacyTaskMembers(async () => ({ code: 0, stdout: '', stderr: '' }));
  expect(readMember('task-' + f.name)).toBeUndefined(); expect(existsSync(f.dir)).toBe(true);
});

it('rejects an unproven legacy profile before any native retirement', async () => {
  const f = fixture(); seedLegacyService(f);
  const file = join(root, '.config/systemd/user', taskSystemdUnit(f.name));
  const contents = '[Service]\nExecStart=/fixture/fleet _run-temp TaskDeveloper\n';
  writeFileSync(file, contents);
  const path = join(stateRoot(), 'task-supervisors', f.name + '.json');
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...owner, fileHash: createHash('sha256').update(contents).digest('hex') }));
  const exec = vi.fn(async () => ({ code: 0, stdout: 'enabled', stderr: '' }));
  await expect(migrateLegacyTaskMembers(exec)).rejects.toThrow('TASK_SERVICE_PROFILE_UNPROVEN');
  expect(exec.mock.calls.some(call => call[1].includes('disable'))).toBe(false);
  expect(readFileSync(file, 'utf8')).toBe(contents); expect(readMember('task-' + f.name)).toBeUndefined();
});
