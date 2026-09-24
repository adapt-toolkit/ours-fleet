import { realExec } from '../exec.js';
import { agentDir } from '../paths.js';
import { readRoomReadiness } from '../agent-ours/service.js';
import { controlRequest } from '../session/control.js';
import { readTempSupervisor, tempSupervisorLiveness } from '../temp-lifecycle.js';
import type { CoworkAdapter } from './cowork-adapter.js';
import type { RoomOrchestrationRecord, TaskRecord } from './types.js';

export type TaskReadinessIssue = {
  state: 'degraded' | 'unknown';
  reason: string;
  member?: string;
};
export interface LiveReadinessDeps {
  supervisor?: typeof readTempSupervisor;
  liveness?: typeof tempSupervisorLiveness;
  readiness?: typeof readRoomReadiness;
  control?: typeof controlRequest;
}

/** Read-only observation. A failed probe never grants authority to replace a seat. */
export async function taskLiveReadiness(
  task: TaskRecord, room: RoomOrchestrationRecord | undefined,
  cowork: Pick<CoworkAdapter, 'getRoom'>, deps: LiveReadinessDeps = {},
): Promise<TaskReadinessIssue | undefined> {
  const degraded = (reason: string, member?: string): TaskReadinessIssue => ({ state: 'degraded', reason, member });
  const unknown = (reason: string, member?: string): TaskReadinessIssue => ({ state: 'unknown', reason, member });
  if (!room || task.state !== 'active' || task.room_id !== room.room_id || room.state !== 'active' || room.close || task.terminal_intent
      || room.task_id !== task.task_id || !room.room_identity_cid
      || task.room_identity_cid !== room.room_identity_cid)
    return degraded('room_record_mismatch');
  const expected = room.template_snapshot?.members.reduce((n, member) => n + member.count, 0);
  if (expected === undefined || room.member_seats.length !== expected
      || new Set(room.member_seats.map(seat => seat.role_name)).size !== expected)
    return degraded('member_roster_mismatch');
  let remote;
  try { remote = await cowork.getRoom(room.room_id); }
  catch { return unknown('room_probe_unavailable'); }
  if (!remote || remote.room_id !== room.room_id || remote.identity_cid !== room.room_identity_cid
      || remote.state !== 'active') return degraded('room_identity_or_state_mismatch');
  if (room.owner_seat_cid && !remote.seats.some(seat =>
    seat.identity_cid === room.owner_seat_cid && seat.seat_state === 'active'))
    return degraded('owner_seat_missing');
  for (const seat of room.member_seats) {
    const member = seat.role_name;
    if (seat.seat_state !== 'active' || !seat.identity_cid || !seat.invite_id
        || seat.launch?.state !== 'launched' || !seat.launch.launch_id || seat.retirement)
      return degraded('member_record_incomplete', member);
    const matches = remote.seats.filter(item => item.display_name === member && item.seat_state !== 'removed');
    if (matches.length !== 1 || matches[0].identity_cid !== seat.identity_cid
        || matches[0].invite_id !== seat.invite_id || matches[0].role !== seat.cowork_role
        || matches[0].seat_state !== 'active') return degraded('member_seat_mismatch', member);
    const dir = agentDir(member, true);
    try {
      const supervisor = (deps.supervisor ?? readTempSupervisor)(dir);
      if (!supervisor) return unknown('supervisor_record_missing', member);
      if (supervisor.role !== member || supervisor.launchId !== seat.launch.launch_id)
        return degraded('supervisor_launch_mismatch', member);
      const live = await (deps.liveness ?? tempSupervisorLiveness)(dir, {
        exec: (cmd, args, opts) => realExec(cmd, args, { ...opts, timeout: 2_000 }),
      });
      if (live === 'stopped') return degraded('supervisor_stopped', member);
      if (live !== 'running') return unknown('supervisor_liveness_unknown', member);
      const ready = (deps.readiness ?? readRoomReadiness)(room.room_identity_cid, member);
      if (!ready || ready.room !== room.room_id || ready.invite !== seat.invite_id || ready.cid !== seat.identity_cid)
        return degraded('member_readiness_mismatch', member);
    } catch { return unknown('supervisor_probe_unavailable', member); }
    try {
      const response = await (deps.control ?? controlRequest)(dir, { command: 'status' }, 2_000);
      if (!response.ok) return unknown('control_unavailable', member);
      const status = response.result as { alive?: boolean; readiness?: string } | undefined;
      if (status?.alive === false || status?.readiness === 'failed') return degraded('agent_not_ready', member);
      if (status?.alive !== true || !['idle', 'running', 'awaiting_permission'].includes(status.readiness ?? ''))
        return unknown('agent_readiness_unknown', member);
    } catch { return unknown('control_unavailable', member); }
  }
}
