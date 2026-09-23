import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from '../paths.js';
import { tempArchiveForLaunch, tempArchiveForCreationAction, tempSupervisorLiveness } from '../temp-lifecycle.js';
import { assertMemberIdentityAbsent } from './close.js';
import type { ArchivedMemberAbsence, RoomMemberSeat } from './types.js';

/** Revalidate live facts; a persisted timestamp is never cleanup authority. */
export async function verifyArchivedAbsence(proof: ArchivedMemberAbsence): Promise<void> {
  const absent = () => {
    if (existsSync(agentDir(proof.name, true))) throw new Error('Archived member has replacement live state');
  };
  absent();
  const archive = tempArchiveForLaunch(proof.name, proof.launch_id);
  const action = tempArchiveForCreationAction(proof.name, proof.action_id);
  if (!archive || archive !== proof.archive_path || action?.path !== archive
      || action.launchId !== proof.launch_id
      || readFileSync(join(archive, '.identity'), 'utf8').trim() !== proof.name)
    throw new Error('Archived member absence ownership proof mismatch');
  if (await tempSupervisorLiveness(archive) !== 'stopped')
    throw new Error('Archived member supervisor absence is not proven');
  await assertMemberIdentityAbsent({
    role_name: proof.name, slot: 'archived', cowork_role: 'archived', seat_state: 'removed',
  });
  absent();
}

export async function proveArchivedAbsence(seat: RoomMemberSeat): Promise<ArchivedMemberAbsence> {
  if (seat.identity_cid || seat.retirement?.phase !== 'identity_absent'
      || !seat.launch?.launch_id || !seat.launch.action_id
      || seat.launch.launch_id !== seat.retirement.launch_id || !seat.retirement.archive_path)
    throw new Error('Missing exact archived member absence evidence');
  const proof: ArchivedMemberAbsence = {
    name: seat.role_name, launch_id: seat.launch.launch_id, action_id: seat.launch.action_id,
    archive_path: seat.retirement.archive_path, checked_at: new Date().toISOString(),
  };
  await verifyArchivedAbsence(proof);
  return proof;
}
