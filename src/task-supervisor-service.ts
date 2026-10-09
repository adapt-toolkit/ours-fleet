import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { home, stateRoot } from './paths.js';
import { createHash } from 'node:crypto';
import { realExec } from './exec.js';
import type { TaskSupervisorOwner } from './temp-lifecycle.js';
import type { Exec } from './exec.js';
import { registerMember, unregisterTaskMember, hasTaskMemberRegistration, assertTaskRegistrationsAbsent as assertCatalogAbsent } from './supervisor/catalog.js';
import { fleetHostBackend } from './supervisor/fleet.js';

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
interface ServiceOwner { version: 1; role: string; taskOwner: TaskSupervisorOwner; kind: string; target: string; fileHash: string; launchId: string }
const plistPath = (role: string) => join(home(), 'Library', 'LaunchAgents', `${taskLaunchdLabel(role)}.plist`);
/** Task members use the same Fleet parent and process catalog as permanent members. */
export async function installTaskSupervisorService(
  role: string, binPath: string, dir: string, platform: NodeJS.Platform, exec: Exec, taskOwner: TaskSupervisorOwner, launchId: string,
): Promise<{ kind: 'fleet-managed'; target: string }> {
  // A previously installed task unit is retired with its exact ownership proof
  // before central launch is permitted. New launches never write a per-agent unit.
  if (existsSync(ownerPath(role))) await uninstallRetainedTaskService(role, { ...taskOwner, launchId }, exec);
  const result = await registerMember({ name: role, kind: 'task', dir, taskOwner, launchId });
  const host = fleetHostBackend(exec, platform);
  await host.init(binPath);
  await host.install('fleet', binPath);
  return { kind: 'fleet-managed', target: result.member.key };
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
  if (!/^[A-Za-z0-9_-]+$/.test(role)) throw Error('TASK_SERVICE_INVALID_INPUT');
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
