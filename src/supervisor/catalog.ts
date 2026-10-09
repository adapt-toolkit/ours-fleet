import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { agentDir, stateRoot, watchdogsRoot } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { TaskSupervisorOwner } from '../temp-lifecycle.js';
import type { Liveness } from './types.js';

export interface FleetMember {
  version: 1;
  key: string;
  name: string;
  kind: 'permanent' | 'task' | 'temporary' | 'watchdogs';
  dir: string;
  desired: 'running' | 'stopped';
  retiring?: boolean;
  incarnation: string;
  taskOwner?: TaskSupervisorOwner;
  launchId?: string;
  configPath?: string;
  generation?: string;
  pid?: number;
  retryAt?: number;
}
export const catalogRoot = () => join(stateRoot(), 'supervisor', 'members');
export function memberKey(name: string, kind: FleetMember['kind']): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(name)) throw Error('FLEET_MEMBER_INVALID_NAME');
  return `${kind}-${name}`;
}
export function memberPath(key: string): string {
  if (!/^(permanent|task|temporary|watchdogs)-[A-Za-z0-9_-]{1,160}$/.test(key))
    throw Error('FLEET_MEMBER_INVALID_KEY');
  return join(catalogRoot(), `${key}.json`);
}
export const withMemberLock = <T>(key: string, work: () => T | Promise<T>): Promise<T> =>
  withFileLock(join(stateRoot(), 'locks', 'fleet-members', memberKeyFromValidatedKey(key)), work);

function memberKeyFromValidatedKey(key: string): string { memberPath(key); return key; }

export function readMember(key: string): FleetMember | undefined {
  const path = memberPath(key);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error('FLEET_MEMBER_UNSAFE_RECORD');
  const record = JSON.parse(readFileSync(path, 'utf8')) as FleetMember;
  validateMember(record, key);
  return record;
}
function validateMember(record: FleetMember, key: string): void {
  const expectedDir = record.kind === 'watchdogs' ? watchdogsRoot()
    : agentDir(record.name, record.kind !== 'permanent');
  if (record.version !== 1 || !['permanent', 'task', 'temporary', 'watchdogs'].includes(record.kind)
      || memberKey(record.name, record.kind) !== key || record.key !== key
      || !['running', 'stopped'].includes(record.desired)
      || !/^[a-f0-9-]{36}$/.test(record.incarnation)
      || record.dir !== resolve(record.dir) || record.dir !== expectedDir
      || (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid <= 0))
      || (record.retryAt !== undefined && (!Number.isFinite(record.retryAt) || record.retryAt < 0))
      || (record.kind === 'task' && (!record.taskOwner?.taskId || !record.taskOwner.creationActionId || !record.launchId)))
    throw Error('FLEET_MEMBER_INVALID_RECORD');
}
export function writeMember(record: FleetMember): void {
  validateMember(record, record.key);
  replaceFileAtomically(memberPath(record.key), JSON.stringify(record) + '\n');
}
export function listMemberKeys(): string[] {
  try { return readdirSync(catalogRoot()).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function listMembers(): FleetMember[] {
  let entries;
  try { entries = readdirSync(catalogRoot(), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.name.endsWith('.json')).map(entry => {
    const value = readMember(entry.name.slice(0, -5));
    if (!value) throw Error('FLEET_MEMBER_DISAPPEARED');
    return value;
  });
}

export type MemberRegistration = Pick<FleetMember, 'name' | 'kind' | 'dir' | 'taskOwner' | 'launchId' | 'configPath'>;
/** Persist intent before starting anything. The parent never discovers members from tmp directories. */
export async function registerMember(input: MemberRegistration, options: { initialDesired?: FleetMember['desired']; preserveExisting?: boolean } = {}): Promise<{ created: boolean; member: FleetMember }> {
  const key = memberKey(input.name, input.kind);
  return withMemberLock(key, () => {
    const previous = readMember(key);
    if (previous && (previous.dir !== input.dir || previous.launchId !== input.launchId
        || JSON.stringify(previous.taskOwner) !== JSON.stringify(input.taskOwner)))
      throw Error('FLEET_MEMBER_OWNER_COLLISION');
    if (previous && options.preserveExisting) return { created: false, member: previous };
    if (previous?.retiring) throw Error('FLEET_MEMBER_RETIRING');
    const desired = options.initialDesired ?? 'running';
    const member: FleetMember = previous
      ? { ...previous, desired, configPath: input.configPath ?? previous.configPath, retryAt: 0 }
      : { ...input, version: 1, key, desired, incarnation: randomUUID() };
    writeMember(member);
    return { created: !previous, member };
  });
}

export interface CatalogDeps { exec?: Exec; sleep?(ms: number): Promise<void>; timeoutMs?: number }
/** A unique generation in argv fences PID reuse, including the spawn-to-pid-write crash seam. */
export async function memberProcess(record: FleetMember, exec: Exec = realExec): Promise<Liveness & { pid?: number }> {
  if (!record.generation) return { state: 'stopped', detail: 'no child generation' };
  if (!/^[a-f0-9-]{36}$/.test(record.generation)) return { state: 'unknown', detail: 'invalid child generation' };
  const matches = (command: string) => command.split(/\s+/).some((part, index, words) =>
    part === '_run-managed' && words[index + 1] === record.key && words[index + 2] === record.generation);
  if (record.pid) {
    try { process.kill(record.pid, 0); }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
        ? { state: 'stopped', detail: 'child pid absent' }
        : { state: 'unknown', detail: 'child pid probe failed' };
    }
    try {
      const command = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0').join(' ');
      return matches(command) ? { state: 'running', detail: 'exact child generation', pid: record.pid }
        : { state: 'stopped', detail: 'pid belongs to another generation' };
    } catch { /* non-/proc hosts use ps */ }
  }
  const result = await exec('ps', record.pid ? ['-p', String(record.pid), '-o', 'pid=', '-o', 'command=']
    : ['-ax', '-o', 'pid=', '-o', 'command=']);
  if (result.code !== 0) return result.code === 1 && record.pid
    ? { state: 'stopped', detail: 'child absent' } : { state: 'unknown', detail: 'process probe unavailable' };
  const pids = result.stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line);
    return row && matches(row[2]) ? [Number(row[1])] : [];
  });
  if (pids.length > 1) return { state: 'unknown', detail: 'ambiguous child generation' };
  return pids.length ? { state: 'running', detail: 'exact child generation', pid: pids[0] }
    : { state: 'stopped', detail: 'child generation absent' };
}
export async function catalogLiveness(key: string, exec: Exec = realExec): Promise<Liveness> {
  try {
    const record = readMember(key);
    if (!record) return { state: 'stopped', detail: 'member unregistered' };
    const live = await memberProcess(record, exec);
    if (live.state === 'stopped' && record.desired === 'running') {
      const { readRestartLedger } = await import('../runner.js');
      const ledger = readRestartLedger(record.dir);
      if (ledger.circuit === 'open') return { ...live, detail: `held after ${ledger.consecutiveImmediateFailures} failures: ${ledger.lastReason}; use up/restart or task recovery to reset` };
    }
    return live;
  } catch { return { state: 'unknown', detail: 'member record unavailable' }; }
}
export async function waitMember(key: string, desired: 'running' | 'stopped', deps: CatalogDeps = {}): Promise<void> {
  const deadline = Date.now() + (deps.timeoutMs ?? 30_000);
  do {
    const live = await catalogLiveness(key, deps.exec);
    if (live.state === desired) return;
    await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(100);
  } while (Date.now() < deadline);
  throw Error(desired === 'stopped' ? 'FLEET_MEMBER_STOP_UNPROVEN' : 'FLEET_MEMBER_START_UNPROVEN');
}
export async function stopMember(key: string, deps: CatalogDeps = {}): Promise<void> {
  await withMemberLock(key, () => {
    const record = readMember(key);
    if (record) writeMember({ ...record, desired: 'stopped' });
  });
  // A stopped parent cannot consume intent, but its IPC children stop on disconnect.
  // Never signal an arbitrary recorded pid or erase a record on timeout.
  await waitMember(key, 'stopped', deps);
}
export async function unregisterMember(key: string, deps: CatalogDeps = {}): Promise<boolean> {
  const original = readMember(key);
  if (!original) return false;
  await withMemberLock(key, () => {
    const current = readMember(key);
    if (!current || current.incarnation !== original.incarnation) throw Error('FLEET_MEMBER_RETIREMENT_CONFLICT');
    writeMember({ ...current, desired: 'stopped', retiring: true });
  });
  await waitMember(key, 'stopped', deps);
  return withMemberLock(key, async () => {
    const current = readMember(key);
    if (!current) return false;
    if (current.incarnation !== original.incarnation || current.desired !== 'stopped')
      throw Error('FLEET_MEMBER_RETIREMENT_CONFLICT');
    if ((await memberProcess(current, deps.exec)).state !== 'stopped') throw Error('FLEET_MEMBER_STOP_UNPROVEN');
    rmSync(memberPath(key));
    return true;
  });
}
export async function unregisterTaskMember(
  role: string, expected: { taskId: string; creationActionId?: string; launchId?: string }, deps: CatalogDeps = {},
): Promise<void> {
  const key = memberKey(role, 'task');
  await withMemberLock(key, () => {
    const current = readMember(key);
    if (!current) return;
    if (current.kind !== 'task' || current.taskOwner?.taskId !== expected.taskId
        || (!expected.creationActionId && !expected.launchId)
        || (expected.creationActionId !== undefined && current.taskOwner.creationActionId !== expected.creationActionId)
        || (expected.launchId !== undefined && current.launchId !== expected.launchId))
      throw Error('TASK_SERVICE_OWNER_MISMATCH');
    writeMember({ ...current, desired: 'stopped', retiring: true });
  });
  await unregisterMember(key, deps);
}
export function hasTaskMemberRegistration(role: string): boolean {
  const path = memberPath(memberKey(role, 'task'));
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function assertTaskRegistrationsAbsent(taskId: string): void {
  if (listMembers().some(record => record.taskOwner?.taskId === taskId)) throw Error('TASK_SERVICES_REMAIN');
}
export const permanentRegistration = (name: string): MemberRegistration => ({ name, kind: 'permanent', dir: agentDir(name) });
