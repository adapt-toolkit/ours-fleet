import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDir } from '../src/paths.js';
import { catalogLiveness, hasTaskMemberRegistration, memberKey, memberPath, memberProcess, readMember, registerMember, unregisterMember, unregisterTaskMember, writeMember, type FleetMember } from '../src/supervisor/catalog.js';
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
