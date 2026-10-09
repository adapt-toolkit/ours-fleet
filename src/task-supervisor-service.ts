import { chmodSync, mkdirSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, home, stateRoot } from './paths.js';
import { replaceFileAtomically, withFileLock } from './atomic-file.js';
import { createHash } from 'node:crypto';
import { realExec } from './exec.js';
import type { TaskSupervisorOwner } from './temp-lifecycle.js';
import type { Exec } from './exec.js';
import { captureMemberEnvironment, registerMember, unregisterTaskMember, hasTaskMemberRegistration, assertTaskRegistrationsAbsent as assertCatalogAbsent } from './supervisor/catalog.js';
import { assertSafeAncestors } from './rooms-tasks/workspace.js';
import { ensureFleetParent } from './supervisor/fleet.js';

export const taskSystemdUnit = (role: string) => `ours-fleet-task-${role}.service`;
export const taskLaunchdLabel = (role: string) => `network.ours.fleet.task.${role}`;
const unitPath = (role: string) => join(home(), '.config', 'systemd', 'user', taskSystemdUnit(role));
const ownerPath = (role: string) => join(stateRoot(), 'task-supervisors', `${role}.json`);
function readProof(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('TASK_SERVICE_UNSAFE_PROOF');
  return readFileSync(path, 'utf8');
}
const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');
interface ServiceOwner {
  version: 1; role: string; taskOwner: TaskSupervisorOwner; kind: string; target: string; fileHash: string; launchId: string;
  migration?: { phase: 'prepared' | 'native-retired'; desired: 'running' | 'stopped'; environment?: Record<string, string> };
}
const withTaskServiceLock = <T>(role: string, work: () => Promise<T>) => {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(role)) throw Error('TASK_SERVICE_INVALID_INPUT');
  return withFileLock(join(stateRoot(), 'locks', 'task-services', role), work);
};
const plistPath = (role: string) => join(home(), 'Library', 'LaunchAgents', `${taskLaunchdLabel(role)}.plist`);
function writeServiceOwner(role: string, owner: ServiceOwner): void {
  const dir = join(stateRoot(), 'task-supervisors');
  assertSafeAncestors(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  replaceFileAtomically(ownerPath(role), JSON.stringify(owner) + '\n');
}
/** Task members use the same Fleet parent and process catalog as permanent members. */
export async function installTaskSupervisorService(
  role: string, binPath: string, dir: string, platform: NodeJS.Platform, exec: Exec, taskOwner: TaskSupervisorOwner, launchId: string,
): Promise<{ kind: 'fleet-managed'; target: string }> {
  // Start the shared parent before any legacy retirement. Its empty catalog
  // cannot overlap an old native runner; registration follows proof of absence.
  await ensureFleetParent(exec, platform);
  return withTaskServiceLock(role, async () => {
    if (existsSync(ownerPath(role))) await migrateLegacyTaskMember(role, exec);
    const result = await registerMember({ name: role, kind: 'task', dir, taskOwner, launchId, environment: await captureMemberEnvironment() });
    return { kind: 'fleet-managed', target: result.member.key };
  });
}

async function checked(exec: Exec, command: string, args: string[]): Promise<void> {
  const result = await exec(command, args);
  if (result.code !== 0) throw Error(`${command} ${args[0]} failed (${result.code})`);
}

/** A failed disable/bootout keeps the state and retirement cursor retryable. */
export async function uninstallTaskSupervisorService(
  role: string, kind: string, target: string, exec: Exec,
): Promise<void> {
  if (kind === 'systemd-persistent') {
    if (target !== taskSystemdUnit(role)) throw Error('TASK_SERVICE_TARGET_MISMATCH');
    const result = await exec('systemctl', ['--user', 'disable', '--now', target]);
    if (result.code !== 0 && !/not (?:be )?(?:found|loaded)|could not be found|does not exist/i.test(result.stderr))
      throw Error('TASK_SERVICE_DISABLE_FAILED');
    rmSync(unitPath(role), { force: true });
    await checked(exec, 'systemctl', ['--user', 'daemon-reload']);
  } else if (kind === 'launchd-persistent') {
    if (target !== taskLaunchdLabel(role)) throw Error('TASK_SERVICE_TARGET_MISMATCH');
    const result = await exec('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${target}`]);
    if (result.code !== 0 && !/could not find|no such process/i.test(`${result.stdout}\n${result.stderr}`))
      throw Error('TASK_SERVICE_BOOTOUT_FAILED');
    rmSync(plistPath(role), { force: true });
  } else throw Error('TASK_SERVICE_KIND_MISMATCH');
}

/** Ownership survives a lost temporary directory. Caller proves the retained task/seat action. */
export async function uninstallRetainedTaskService(
  role: string, expected: { taskId: string; creationActionId?: string; launchId?: string }, exec: Exec = realExec,
): Promise<void> {
  return withTaskServiceLock(role, () => uninstallRetainedTaskServiceLocked(role, expected, exec));
}
async function uninstallRetainedTaskServiceLocked(role: string, expected: { taskId: string; creationActionId?: string; launchId?: string }, exec: Exec): Promise<void> {
  const central = hasTaskMemberRegistration(role);
  if (central) await unregisterTaskMember(role, expected, { exec });
  const path = ownerPath(role);
  if (!existsSync(path)) {
    if (central && !existsSync(unitPath(role)) && !existsSync(plistPath(role))) return;
    if (existsSync(unitPath(role)) || existsSync(plistPath(role))) throw Error('TASK_SERVICE_OWNER_MISSING');
    if (process.platform === 'linux') {
      const result = await exec('systemctl', ['--user', 'show', '-p', 'LoadState', '--value', taskSystemdUnit(role)]);
      if (!(result.code === 0 && result.stdout.trim() === 'not-found')
          && !/could not be found|not (?:be )?(?:found|loaded)|does not exist/i.test(result.stderr))
        throw Error('TASK_SERVICE_ABSENCE_UNPROVEN');
    } else if (process.platform === 'darwin') {
      const result = await exec('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${taskLaunchdLabel(role)}`]);
      if (result.code === 0 || !/could not find service|no such process/i.test(`${result.stdout}\n${result.stderr}`))
        throw Error('TASK_SERVICE_ABSENCE_UNPROVEN');
    }
    return;
  }
  const owner = JSON.parse(readProof(path)) as ServiceOwner;
  if (owner.version !== 1 || owner.role !== role || owner.taskOwner?.taskId !== expected.taskId
      || (!expected.creationActionId && !expected.launchId)
      || (expected.creationActionId !== undefined && owner.taskOwner.creationActionId !== expected.creationActionId)
      || (expected.launchId !== undefined && owner.launchId !== expected.launchId)
      || !['systemd-persistent', 'launchd-persistent'].includes(owner.kind))
    throw Error('TASK_SERVICE_OWNER_MISMATCH');
  const file = owner.kind === 'systemd-persistent' ? unitPath(role) : plistPath(role);
  if (existsSync(file) && hash(readProof(file)) !== owner.fileHash) throw Error('TASK_SERVICE_FILE_MISMATCH');
  await uninstallTaskSupervisorService(role, owner.kind, owner.target, exec);
  await assertLegacyTaskProcessStopped(role, exec);
  rmSync(path, { force: true });
}

/** Task deletion must not forget surviving boot services when a run/room record is lost. */
export function assertTaskRegistrationsAbsent(taskId: string): void {
  assertCatalogAbsent(taskId);
  const root = join(stateRoot(), 'task-supervisors');
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const owner = JSON.parse(readProof(join(root, entry.name))) as ServiceOwner;
    if (owner.version !== 1 || !owner.role || entry.name !== owner.role + '.json' || !owner.taskOwner?.taskId)
      throw Error('TASK_SERVICE_OWNER_CORRUPT');
    if (owner.taskOwner.taskId === taskId) throw Error('TASK_SERVICES_REMAIN');
  }
}

/** Presence-only compatibility query; incomplete/symlink evidence is still not absence. */
export function hasRetainedTaskService(role: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(role)) throw Error('TASK_SERVICE_INVALID_INPUT');
  if (hasTaskMemberRegistration(role)) return true;
  return [ownerPath(role), unitPath(role), plistPath(role)].some(path => {
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    readProof(path); return true;
  });
}

export const assertTaskServicesAbsent = assertTaskRegistrationsAbsent;

/** Native shutdown returning success is insufficient if a detached predecessor survives. */
async function assertLegacyTaskProcessStopped(role: string, exec: Exec): Promise<void> {
  const result = await exec('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  if (result.code !== 0) throw Error('TASK_SERVICE_STOP_UNPROVEN');
  if (result.stdout.split('\n').some(line => {
    const args = line.trim().split(/\s+/);
    return args.some((arg, index) => ['_run-temp', '_run-temp-worker'].includes(arg) && args[index + 1] === role);
  })) throw Error('TASK_SERVICE_STOP_UNPROVEN');
}

function legacyTaskEnvironment(contents: string, kind: string): Record<string, string> {
  const keys = ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'CODEX_PATH', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_API_TOKEN', 'OURS_CONFIG'];
  const env: Record<string, string> = {};
  if (kind === 'systemd-persistent') {
    for (const match of contents.matchAll(/^Environment="((?:[^"\\]|\\.)*)"$/gm)) {
      const value = match[1].replace(/\\([\\"])/g, '$1').replaceAll('%%', '%');
      const split = value.indexOf('=');
      if (split > 0 && keys.includes(value.slice(0, split))) env[value.slice(0, split)] = value.slice(split + 1);
    }
  } else {
    const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(contents)?.[1] ?? '';
    for (const match of block.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
      if (keys.includes(match[1])) env[match[1]] = match[2].replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    }
  }
  // The old generator always froze the profile path. Guessing the invoker's
  // profile during adoption could bind a different daemon/identity.
  if (!env.OURS_CONFIG || !env.OURS_CONFIG.startsWith('/')) throw Error('TASK_SERVICE_PROFILE_UNPROVEN');
  return env;
}

/** The exact old owner proof doubles as a durable transfer receipt. Deletion
 * and transfer share a role lock; no directory scan invents missing members. */
async function migrateLegacyTaskMember(role: string, exec: Exec): Promise<void> {
  const path = ownerPath(role), owner = JSON.parse(readProof(path)) as ServiceOwner;
  if (owner.version !== 1 || owner.role !== role || !owner.taskOwner?.taskId
      || !owner.taskOwner.creationActionId || !owner.launchId
      || !['systemd-persistent', 'launchd-persistent'].includes(owner.kind)
      || owner.target !== (owner.kind === 'systemd-persistent' ? taskSystemdUnit(role) : taskLaunchdLabel(role))
      || !/^[a-f0-9]{64}$/.test(owner.fileHash)
      || (owner.migration && (!['prepared', 'native-retired'].includes(owner.migration.phase)
          || !['running', 'stopped'].includes(owner.migration.desired)))) throw Error('TASK_SERVICE_OWNER_CORRUPT');
  const file = owner.kind === 'systemd-persistent' ? unitPath(role) : plistPath(role);
  if (existsSync(file) && hash(readProof(file)) !== owner.fileHash) throw Error('TASK_SERVICE_FILE_MISMATCH');
  const { readTempSupervisor, updateTempSupervisor, requestedTempStopReason } = await import('./temp-lifecycle.js');
  const dir = agentDir(role, true), metadata = readTempSupervisor(dir);
  readProof(join(dir, '.temp-supervisor.json'));
  if (metadata?.role !== role || metadata.launchId !== owner.launchId
      || JSON.stringify(metadata.taskOwner) !== JSON.stringify(owner.taskOwner)) throw Error('TASK_SERVICE_OWNER_MISMATCH');
  const { taskSupervisorMayRun } = await import('./task-supervision.js');
  const allowed = taskSupervisorMayRun(role) && !requestedTempStopReason(dir);
  if (!owner.migration) {
    let desired: 'running' | 'stopped';
    if (owner.kind === 'systemd-persistent') {
      const enabled = await exec('systemctl', ['--user', 'is-enabled', owner.target]);
      if (enabled.stdout.trim() === 'enabled') desired = allowed ? 'running' : 'stopped';
      else if (['disabled', 'static'].includes(enabled.stdout.trim())) desired = 'stopped';
      else throw Error('TASK_SERVICE_ENABLEMENT_UNPROVEN');
    } else desired = allowed ? 'running' : 'stopped';
    owner.migration = { phase: 'prepared', desired, environment: legacyTaskEnvironment(readProof(file), owner.kind) };
    writeServiceOwner(role, owner);
  }
  await uninstallTaskSupervisorService(role, owner.kind, owner.target, exec);
  await assertLegacyTaskProcessStopped(role, exec);
  owner.migration.phase = 'native-retired';
  writeServiceOwner(role, owner);
  // Publish metadata before running intent; a crash at either side retains the
  // old proof, allowing a successor to complete the same launch without replay.
  await updateTempSupervisor(dir, { kind: 'fleet-managed', target: 'task-' + role, phase: 'active' });
  await registerMember({ name: role, kind: 'task', dir, taskOwner: owner.taskOwner, launchId: owner.launchId, environment: owner.migration.environment }, {
    initialDesired: taskSupervisorMayRun(role) && !requestedTempStopReason(dir) ? owner.migration.desired : 'stopped', preserveExisting: true,
  });
  rmSync(path);
}

export async function migrateLegacyTaskMembers(exec: Exec = realExec): Promise<void> {
  const root = join(stateRoot(), 'task-supervisors');
  let names: string[];
  try { names = readdirSync(root).filter(name => name.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const role = name.slice(0, -5);
    await withTaskServiceLock(role, async () => {
      // A concurrent authorized deletion may already have retired this proof.
      if (existsSync(ownerPath(role))) await migrateLegacyTaskMember(role, exec);
    });
  }
}
