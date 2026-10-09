import { existsSync } from 'node:fs';
import { agentDir } from '../paths.js';
import { readTempSupervisor, tempArchiveForCreationAction, tempArchiveForLaunch } from '../temp-lifecycle.js';
import { uninstallRetainedTaskService, hasRetainedTaskService } from '../task-supervisor-service.js';
import { assertMemberNotPermanent } from './member-ownership.js';
import type { Exec } from '../exec.js';

/** Registration retirement precedes every identity-absence shortcut. A proven
 * legacy transient/detached launch never owned a retained registration.
 * Missing state requires surviving registration proof or manager absence.
 */
export async function retireTaskMemberService(name: string,
  expected: { taskId: string; creationActionId?: string; launchId?: string; taskSupervised?: boolean }, exec?: Exec): Promise<void> {
  assertMemberNotPermanent(name);
  const archive = expected.creationActionId ? tempArchiveForCreationAction(name, expected.creationActionId)
    : expected.launchId ? { path: tempArchiveForLaunch(name, expected.launchId) } : undefined;
  const source = existsSync(agentDir(name, true)) ? agentDir(name, true) : archive?.path;
  const metadata = source ? readTempSupervisor(source) : undefined;
  const hasServiceEvidence = hasRetainedTaskService(name);
  const durableMetadata = metadata?.taskOwner && ['fleet-managed', 'systemd-persistent', 'launchd-persistent'].includes(metadata.kind ?? '');
  if (!hasServiceEvidence && !expected.taskSupervised && !durableMetadata) return;
  await uninstallRetainedTaskService(name, expected, exec);
}
