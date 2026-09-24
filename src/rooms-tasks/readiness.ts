import { agentDir } from '../paths.js';
import { realExec } from '../exec.js';
import { readTempSupervisor, tempSupervisorLiveness } from '../temp-lifecycle.js';
import { controlRequest } from '../session/control.js';
import type { SessionSnapshot } from '../session/types.js';
import type { CoworkAdapter } from './cowork-adapter.js';
import type { RoomMemberSeat, RoomOrchestrationRecord } from './types.js';

export const READINESS_TIMEOUT_MS = 2_000;
export const ROOM_RECOVERY_ACTION = 'Ask the Fleet coordinator to inspect the existing room seats and retained temporary recovery context before deliberate recovery. Do not respawn or adopt replacements from this observation; unavailable control is not proof that a session is dead.';

export interface RoomReadiness {
  ownerAttached: boolean;
  active: number;
  launched: number;
  issues: string[];
}

/** A live control response corroborates the exact durable launch, never a socket file. */
async function memberAvailable(seat: RoomMemberSeat): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(seat.role_name) || !seat.launch?.launch_id
      || seat.launch.state !== 'launched') return false;
  const dir = agentDir(seat.role_name, true);
  const before = readTempSupervisor(dir);
  if (!before || before.role !== seat.role_name || before.launchId !== seat.launch.launch_id) return false;
  try {
    const [liveness, response] = await Promise.all([
      tempSupervisorLiveness(dir, { exec: (cmd, args) => realExec(cmd, args, { timeout: READINESS_TIMEOUT_MS }) }),
      controlRequest(dir, { command: 'status', controller: false }, READINESS_TIMEOUT_MS),
    ]);
    const status = response.result as Partial<SessionSnapshot> | null | undefined;
    const after = readTempSupervisor(dir);
    return liveness === 'running' && response.ok === true && status?.alive === true
      && ['idle', 'running', 'awaiting_permission'].includes(status.readiness ?? '')
      && after?.role === before.role && after.launchId === before.launchId;
  } catch {
    // Transport details can contain private paths and session errors. They also
    // cannot distinguish a busy/unreachable session from a stopped one.
    return false;
  }
}

/** Read-only corroboration. Never reconcile invites, archives, identities or seats. */
export async function observeRoomReadiness(
  room: RoomOrchestrationRecord, expected: number, cowork: CoworkAdapter,
): Promise<RoomReadiness> {
  let remote;
  try { remote = await cowork.getRoom(room.room_id); }
  catch { return { ownerAttached: false, active: 0, launched: 0, issues: ['room_unavailable'] }; }
  if (!remote || remote.room_id !== room.room_id || !room.room_identity_cid
      || remote.identity_cid.toLowerCase() !== room.room_identity_cid.toLowerCase()
      || remote.state !== 'active')
    return { ownerAttached: false, active: 0, launched: 0, issues: ['room_mismatch_or_inactive'] };

  const owners = remote.seats.filter(seat => room.owner_seat_cid
    && seat.identity_cid.toLowerCase() === room.owner_seat_cid.toLowerCase());
  const ownerAttached = owners.length === 1 && owners[0].seat_state === 'active';
  const members = room.member_seats;
  if (members.length !== expected || new Set(members.map(seat => seat.role_name)).size !== expected
      || new Set(members.map(seat => seat.identity_cid?.toLowerCase())).size !== expected)
    return { ownerAttached: false, active: 0, launched: 0, issues: ['member_records_inconsistent'] };
  const memberCids = new Set(members.map(seat => seat.identity_cid?.toLowerCase()));
  const memberRoles = new Set(members.map(seat => seat.cowork_role));
  const untracked = remote.seats.some(seat => seat.seat_state === 'active'
    && memberRoles.has(seat.role) && !memberCids.has(seat.identity_cid.toLowerCase())
    && seat.identity_cid.toLowerCase() !== room.owner_seat_cid?.toLowerCase());
  const observations = await Promise.all(members.map(async member => {
    const matching = remote.seats.filter(seat => member.identity_cid
      && seat.identity_cid.toLowerCase() === member.identity_cid.toLowerCase());
    const active = matching.length === 1 && matching[0].seat_state === 'active'
      && matching[0].role === member.cowork_role;
    return { active, launched: await memberAvailable(member) };
  }));
  const active = observations.filter(seat => seat.active).length;
  const launched = observations.filter(seat => seat.launched).length;
  return { ownerAttached, active, launched, issues: [
    ...(untracked ? ['untracked_member_seats'] : []),
    ...(room.owner_seat_cid && !ownerAttached ? ['owner_seat_unavailable'] : []),
    ...(active !== expected ? ['member_seats_unavailable'] : []),
    ...(launched !== expected ? ['member_sessions_unavailable'] : []),
  ] };
}
