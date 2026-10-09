import { existsSync } from 'node:fs';
import { agentDir } from '../paths.js';
import { readTempSupervisor, tempArchiveForCreationAction, tempArchiveForLaunch } from '../temp-lifecycle.js';
import { unregisterTaskMember, hasTaskMemberRegistration } from '../supervisor/catalog.js';
import { assertMemberNotPermanent } from './member-ownership.js';
import type { Exec } from '../exec.js';

/** Registration retirement precedes every identity-absence shortcut. A proven
 * legacy transient/detached launch never owned a retained registration.
 * Missing state still requires exact catalog ownership before unregistering.
 */
export async function retireTaskMemberService(name: string,
  expected: { taskId: string; creationActionId?: string; launchId?: string; taskSupervised?: boolean }, exec?: Exec): Promise<void> {
  assertMemberNotPermanent(name);
  const archive = expected.creationActionId ? tempArchiveForCreationAction(name, expected.creationActionId)
    : expected.launchId ? { path: tempArchiveForLaunch(name, expected.launchId) } : undefined;
  const source = existsSync(agentDir(name, true)) ? agentDir(name, true) : archive?.path;
  const metadata = source ? readTempSupervisor(source) : undefined;
  const hasServiceEvidence = hasTaskMemberRegistration(name);
  const durableMetadata = metadata?.taskOwner && metadata.kind === 'fleet-managed';
  if (!hasServiceEvidence && !expected.taskSupervised && !durableMetadata) return;
  await unregisterTaskMember(name, expected, { exec });
}
