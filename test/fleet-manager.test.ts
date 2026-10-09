import { writeV2Fixture } from './v2-fixture.js';
import { retirePermanentRegistration, resumeFleetTransfers } from '../src/supervisor/adoption.js';
import { ensureFleetParent, fleetHostBackend, makeFleetBackend } from '../src/supervisor/fleet.js';
import { makeTempSupervisorLauncher, prepareTempSupervisor } from '../src/temp-lifecycle.js';
import { assertNativeFleetScope } from '../src/supervisor/scope.js';
import { realExec } from '../src/exec.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDir } from '../src/paths.js';
import { captureMemberEnvironment, catalogRoot, managedMemberEnvironment, catalogLiveness, hasTaskMemberRegistration, memberKey, memberPath, memberProcess, readMember, registerMember, unregisterMember, unregisterTaskMember, writeMember, type FleetMember } from '../src/supervisor/catalog.js';
import { runFleetManager } from '../src/supervisor/manager.js';
import { readRestartLedger, resetRestartLedger, writeRestartLedger } from '../src/runner.js';

let root: string;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await check())) { if (Date.now() > end) throw Error('condition timed out'); await pause(20); }
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-parent-')); process.env.OURS_FLEET_HOME = root; });
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(root, { recursive: true, force: true }); });
async function permanent(name = 'Permanent') {
  const dir = agentDir(name); mkdirSync(dir, { recursive: true });
  return (await registerMember({ name, kind: 'permanent', dir })).member;
}
async function task(name = 'Task') {
  const dir = agentDir(name, true); mkdirSync(dir, { recursive: true });
  return (await registerMember({ name, kind: 'task', dir, launchId: 'launch', taskOwner: { taskId: 'task1', creationActionId: 'action1' } })).member;
}
// Real private process groups and exact generation argv, with a small worker
// replacing the SDK/harness. The separate recovery integration qualifies SDK state.
const children: ChildProcess[] = [];
function worker(member: FleetMember, generation: string) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0));process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000)", '_run-managed', member.key, generation], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child); return child;
}
afterEach(() => { for (const child of children.splice(0)) { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } } });

describe('Fleet catalog safety', () => {
  it('rejects unsafe keys, record symlinks and foreign state directories before launch', async () => {
    await expect(registerMember({ name: '../outside', kind: 'permanent', dir: root })).rejects.toThrow('INVALID_NAME');
    await expect(registerMember({ name: 'Wrong', kind: 'permanent', dir: root })).rejects.toThrow('INVALID_RECORD');
    const member = await task(); rmSync(memberPath(member.key)); symlinkSync(join(root, 'missing'), memberPath(member.key));
    expect(hasTaskMemberRegistration(member.name)).toBe(true);
    expect(() => readMember(member.key)).toThrow('UNSAFE_RECORD');
    await expect(unregisterTaskMember(member.name, { taskId: 'task1', launchId: 'launch' })).rejects.toThrow('UNSAFE_RECORD');
  });
  it('fences PID reuse and finds a generation before the pid write', async () => {
    const member = await permanent();
    expect(await memberProcess({ ...member, pid: process.pid, generation: randomUUID() })).toMatchObject({ state: 'stopped' });
    const generation = randomUUID(), child = worker(member, generation);
    await until(async () => (await memberProcess({ ...member, generation })).state === 'running');
    expect(await memberProcess({ ...member, generation })).toMatchObject({ state: 'running', pid: child.pid });
  });
  it('preserves exact ownership and makes retirement block concurrent reactivation', async () => {
    const member = await task();
    await expect(unregisterTaskMember(member.name, { taskId: 'foreign', launchId: 'launch' })).rejects.toThrow('OWNER_MISMATCH');
    writeMember({ ...member, generation: randomUUID() });
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const retirement = unregisterMember(member.key, { exec: async () => { entered(); await gate; return { code: 0, stdout: '', stderr: '' }; } });
    await started;
    expect(readMember(member.key)).toMatchObject({ retiring: true, desired: 'stopped' });
    await expect(registerMember(member)).rejects.toThrow('RETIRING');
    release(); await retirement; expect(readMember(member.key)).toBeUndefined();
  });
});

describe('Fleet parent lifecycle', () => {
  it('keeps permanent/task intent through shutdown; new registration and retirement preserve the existing child', async () => {
    const member = await permanent(); let stop = false, spawns = 0;
    const parent = runFleetManager('/unused', { shouldStop: () => stop, spawnChild: (m, g) => { spawns++; return worker(m, g); } });
    try {
      await until(async () => (await catalogLiveness(member.key)).state === 'running');
      const original = readMember(member.key)!;
      const other = await task(); await until(async () => (await catalogLiveness(other.key)).state === 'running');
      expect(readMember(member.key)).toMatchObject({ pid: original.pid, generation: original.generation });
      expect(spawns).toBe(2);
      await unregisterTaskMember(other.name, { taskId: 'task1', launchId: 'launch' });
      expect(await catalogLiveness(member.key)).toMatchObject({ state: 'running' });
      expect(readMember(member.key)).toMatchObject({ pid: original.pid, generation: original.generation });
      await task(); await until(async () => (await catalogLiveness(other.key)).state === 'running');
      stop = true; await parent;
      await until(() => !readMember(member.key)?.generation && !readMember(other.key)?.generation);
      expect(readMember(member.key)?.desired).toBe('running'); expect(readMember(other.key)?.desired).toBe('running');
      expect(readRestartLedger(other.dir).consecutiveImmediateFailures).toBe(0);
      stop = false;
      const successor = runFleetManager('/unused', { shouldStop: () => stop, spawnChild: worker });
      try { await until(async () => (await catalogLiveness(other.key)).state === 'running'); }
      finally { stop = true; await successor; }
    } finally { stop = true; await parent; }
  }, 15000);
  it('registering permanent, temporary and task members keeps the installed unit and existing process unchanged', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: 'active\nrunning\n', stderr: '' }; };
    await fleetHostBackend(exec, 'linux').init('/installed/release/cli.js');
    const path = join(root, '.config/systemd/user/ours-fleet.service');
    const bytes = readFileSync(path), mtime = statSync(path).mtimeMs; calls.length = 0;
    const original = await permanent(); let stop = false;
    const parent = runFleetManager('/unused', { shouldStop: () => stop, spawnChild: worker });
    try {
      await until(async () => (await catalogLiveness(original.key)).state === 'running');
      const pid = readMember(original.key)?.pid;
      mkdirSync(agentDir('Second'), { recursive: true });
      await makeFleetBackend(exec, 'linux').install('Second', '/task/dev/cli.js');
      const tempDir = agentDir('Transient', true); mkdirSync(tempDir, { recursive: true }); prepareTempSupervisor(tempDir, 'Transient');
      await makeTempSupervisorLauncher({ exec, platform: 'linux', supervisor: 'managed' })('/another/dev/cli.js', ['_run-temp', 'Transient'], tempDir);
      await makeFleetBackend(exec, 'linux').stop('Second');
      await makeFleetBackend(exec, 'linux').uninstall('Second');
      expect(await catalogLiveness(original.key)).toMatchObject({ state: 'running' });
      const taskDir = agentDir('NewTask', true); mkdirSync(taskDir, { recursive: true });
      prepareTempSupervisor(taskDir, 'NewTask', { taskId: 'task2', creationActionId: 'action2' });
      await makeTempSupervisorLauncher({ exec, platform: 'linux', supervisor: 'managed' })('/third/dev/cli.js', ['_run-temp', 'NewTask'], taskDir);
      await until(async () => (await catalogLiveness('task-NewTask')).state === 'running');
      expect(readMember(original.key)?.pid).toBe(pid);
      expect(readFileSync(path)).toEqual(bytes); expect(statSync(path).mtimeMs).toBe(mtime);
      expect(calls.every(call => call[0] === 'systemctl' && call[2] === 'show')).toBe(true);
    } finally { stop = true; await parent; }
  });
  it('up of one permanent leaves another legacy role and its native plist untouched', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.some(arg => arg.includes('network.ours.fleet.Other'))) throw Error('other role must not be inspected');
      return { code: 0, stdout: 'state = running', stderr: '' };
    };
    const cfgPath = join(root, 'fleet.yaml');
    writeV2Fixture(cfgPath, { roles: { Selected: { harness: 'codex' }, Other: { harness: 'codex' } } });
    const dir = agentDir('Selected'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.config-path'), cfgPath);
    await fleetHostBackend(exec, 'darwin').init('/installed/fleet');
    const legacy = join(root, 'Library/LaunchAgents/network.ours.fleet.Other.plist');
    writeFileSync(legacy, 'operator-owned-other-role');
    const before = readFileSync(legacy); let stop = false;
    const parent = runFleetManager('/unused', { shouldStop: () => stop, spawnChild: worker });
    try {
      await makeFleetBackend(exec, 'darwin').install('Selected', '/installed/fleet');
      expect(readMember('permanent-Selected')?.desired).toBe('running');
      expect(readMember('permanent-Other')).toBeUndefined();
      expect(readFileSync(legacy)).toEqual(before);
      expect(calls.some(call => call.includes('bootout') || call.some(arg => arg.includes('network.ours.fleet.Other')))).toBe(false);
    } finally { stop = true; await parent; }
  });
  it('explicit service upgrade preserves operator parent drop-ins', async () => {
    const exec = async () => ({ code: 0, stdout: '', stderr: '' });
    await fleetHostBackend(exec, 'linux').init('/installed/old/fleet');
    const path = join(root, '.config/systemd/user/ours-fleet.service.d/operator.conf');
    mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '[Service]\nExecStartPre=/operator/wait-ready\n');
    const before = readFileSync(path);
    await fleetHostBackend(exec, 'linux').init('/installed/new/fleet');
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(join(root, '.config/systemd/user/ours-fleet.service'), 'utf8')).toContain('/installed/new/fleet');
  });
  it('requires explicit initialization and refuses isolated real OS supervision without issuing OS calls', async () => {
    await expect(ensureFleetParent(async () => ({ code: 0, stdout: 'active', stderr: '' }), 'linux')).rejects.toThrow('FLEET_SERVICE_NOT_INSTALLED');
    expect(() => assertNativeFleetScope(realExec)).toThrow('FLEET_SERVICE_HOME_CONFLICT');
    process.env.OURS_FLEET_HOME = join(root, 'another');
    expect(() => assertNativeFleetScope(realExec)).toThrow('FLEET_SERVICE_HOME_CONFLICT');
    expect(existsSync(join(root, '.config/systemd/user/ours-fleet.service'))).toBe(false);
  });
  it('keeps creator profile selection private across parent environment changes and redacts status', async () => {
    const member = await task();
    const environment = await captureMemberEnvironment({ OURS_CONFIG: '/creator/profile.json', OURS_PORT: '43118', OURS_STATE_DIR: '/creator/state', OURS_API_TOKEN: 'fixture-secret-value' });
    writeMember({ ...member, environment });
    expect(managedMemberEnvironment(readMember(member.key)!, { OURS_CONFIG: '/other/profile', OURS_API_TOKEN: 'other', PATH: '/parent' })).toMatchObject({ OURS_CONFIG: '/creator/profile.json', OURS_PORT: '43118', OURS_STATE_DIR: '/creator/state', OURS_API_TOKEN: 'fixture-secret-value' });
    expect(statSync(memberPath(member.key)).mode & 0o777).toBe(0o600);
    await registerMember({ ...readMember(member.key)!, environment: { OURS_CONFIG: '/other-recovery/profile.json' } });
    expect(readMember(member.key)?.environment).toEqual(environment); expect(statSync(catalogRoot()).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(await catalogLiveness(member.key))).not.toContain('fixture-secret-value');
    await unregisterTaskMember(member.name, { taskId: 'task1', launchId: 'launch' });
    expect(existsSync(memberPath(member.key))).toBe(false);
  });
  it('an explicit removal closes a pending migration cursor before boot can recover it', async () => {
    const member = await permanent();
    const receipt = join(root, '.ours-fleet/supervisor/legacy-permanent', member.name + '.json');
    mkdirSync(join(receipt, '..'), { recursive: true });
    writeFileSync(receipt, JSON.stringify({ version: 1, name: member.name, phase: 'native-retired' }));
    const exec = async () => { throw Error('must not inspect native services for a removed member'); };
    await retirePermanentRegistration(member.name, exec);
    await resumeFleetTransfers('/fixture/fleet', exec, 'linux');
    expect(readMember(member.key)).toBeUndefined();
    expect(JSON.parse(readFileSync(receipt, 'utf8')).phase).toBe('registered');
  });
  it('a sustained worker uptime resets the parent-added failure streak before another crash', async () => {
    const member = await permanent();
    writeRestartLedger(member.dir, { ...readRestartLedger(member.dir), circuit: 'closed', consecutiveImmediateFailures: 4 });
    let stop = false, clock = 0;
    const parent = runFleetManager('/unused', { shouldStop: () => stop, now: () => clock, spawnChild: worker });
    try {
      await until(async () => (await catalogLiveness(member.key)).state === 'running');
      clock = 100_001; process.kill(readMember(member.key)!.pid!, 'SIGKILL');
      await until(() => readRestartLedger(member.dir).lastReason === 'Fleet member runner exited unexpectedly');
      expect(readRestartLedger(member.dir)).toMatchObject({ circuit: 'closed', consecutiveImmediateFailures: 1 });
    } finally { stop = true; await parent; }
  });
  it('honors the existing runner circuit across parent restart and operator reset', async () => {
    const member = await permanent();
    writeRestartLedger(member.dir, { ...readRestartLedger(member.dir), circuit: 'open', consecutiveImmediateFailures: 5, lastReason: 'fixture failure' });
    let stop = false, spawns = 0;
    const parent = runFleetManager('/unused', { shouldStop: () => stop, spawnChild: (m, g) => { spawns++; return worker(m, g); } });
    try {
      await pause(350); expect(spawns).toBe(0);
      expect(await catalogLiveness(member.key)).toMatchObject({ state: 'stopped', detail: expect.stringContaining('held after 5 failures') });
      resetRestartLedger(member.dir);
      await until(async () => (await catalogLiveness(member.key)).state === 'running');
      expect(spawns).toBe(1);
    } finally { stop = true; await parent; }
  });
});
