import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { binderKey } from '../agent-ours/state.js';
import { readClientProfile } from '../client-profile.js';
import { readProvenance } from '../creation.js';
import { agentDir, stateRoot } from '../paths.js';
import { readTempSupervisor, secureStoppedTempArchive, stopTempSupervisor, tempArchiveForCreationAction, type TempLifecycleDeps } from '../temp-lifecycle.js';
import { assertMemberIdentityAbsent, removeExactMemberIdentity, waitForLivenessAbsent } from './close.js';
import { assertMemberNotPermanent } from './member-ownership.js';
import type { LayoutInstance, RoomLayoutState } from './layout.js';
import type { RoomMemberSeat } from './types.js';
function proof(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('LAYOUT_MEMBER_UNSAFE_PROOF');
  return readFileSync(path, 'utf8');
}

export function layoutOwnedMemberName(runId: string, key: string): string {
  return `layout-${createHash('sha256').update(runId + ':' + key).digest('hex').slice(0, 16)}`;
}
function assertOwned(instance: LayoutInstance, runId: string, key: string): asserts instance is LayoutInstance & { agent: string } {
  if (instance.remote || !instance.agent || instance.temporary !== true
      || instance.agent !== layoutOwnedMemberName(runId, key) || instance.supervisor !== stateRoot())
    throw Error('LAYOUT_MEMBER_NOT_OWNED');
  assertMemberNotPermanent(instance.agent);
}
function seatFor(instance: LayoutInstance & { agent: string }, key: string, action: string, launchId: string): RoomMemberSeat {
  return { role_name: instance.agent, identity_cid: instance.cid, slot: key, cowork_role: key, seat_state: 'removed',
    launch: { state: 'stopped', action_id: action, launch_id: launchId, attempt: 1, updated_at: '' } };
}

/** Retire a local layout factory result, never a borrowed binding. The runtime
 * instance and CID fence replacement supervisors even when already stopped.
 */
export async function retireOwnedLayoutMember(instance: LayoutInstance, runId: string, key: string,
  lifecycle: TempLifecycleDeps = {}): Promise<void> {
  assertOwned(instance, runId, key);
  const action = `${runId}:${key}`, dir = agentDir(instance.agent, true);
  const archived = tempArchiveForCreationAction(instance.agent, action);
  if (!existsSync(dir) && !archived) {
    // A prior erasure may already have consumed its archive. No live state plus
    // authoritative identity absence is required before accepting completion.
    await assertMemberIdentityAbsent({ role_name: instance.agent, identity_cid: instance.cid,
      slot: key, cowork_role: key, seat_state: 'removed' });
    return;
  }
  const source = existsSync(dir) ? dir : archived!.path;
  const supervisor = readTempSupervisor(source), provenance = readProvenance(source);
  if (!supervisor || supervisor.role !== instance.agent || provenance?.role !== instance.agent
      || provenance.creationActionId !== action || proof(join(source, '.identity')).trim() !== instance.agent)
    throw Error('LAYOUT_MEMBER_LAUNCH_MISMATCH');
  {
    const profile = readClientProfile(process.env);
    const privateDir = join(stateRoot(), 'private-ours', binderKey(profile.expectedInstanceId, instance.agent));
    const runtime = JSON.parse(proof(join(privateDir, 'state.json')));
    const runtimeInstance = JSON.parse(proof(join(privateDir, 'instance.json')));
    if (runtime.instance !== instance.launch || runtimeInstance.instance !== instance.launch
        || runtimeInstance.role !== instance.agent || runtimeInstance.temporary !== true
        || runtime.name !== instance.agent || runtime.daemon !== profile.expectedInstanceId
        || runtime.lifetime !== 'temporary' || runtime.action !== action
        || runtime.cid?.toLowerCase() !== instance.cid.toLowerCase())
      throw Error('LAYOUT_MEMBER_INSTANCE_MISMATCH');
    if (existsSync(dir)) {
      await stopTempSupervisor(instance.agent, lifecycle);
      await waitForLivenessAbsent(instance.agent, supervisor.launchId, lifecycle);
    }
  }
  await secureStoppedTempArchive(instance.agent, supervisor.launchId, lifecycle);
  await removeExactMemberIdentity(seatFor(instance, key, action, supervisor.launchId));
  await assertMemberIdentityAbsent(seatFor(instance, key, action, supervisor.launchId));
}

/** Exact archived launches used by the existing artifact erasure saga. */
export function ownedLayoutRetirementSeats(state: RoomLayoutState, runId: string): RoomMemberSeat[] {
  return Object.entries(state.participants).flatMap(([key, participant]) => {
    if (!participant.owned || !participant.instance) return [];
    const instance = participant.instance;
    assertOwned(instance, runId, key);
    if (!participant.retired) throw Error('LAYOUT_MEMBER_NOT_RETIRED');
    const action = `${runId}:${key}`, archive = tempArchiveForCreationAction(instance.agent, action);
    return [seatFor(instance, key, action, archive?.launchId ?? 'absent-verified')];
  });
}
