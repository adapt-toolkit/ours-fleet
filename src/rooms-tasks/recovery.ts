import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { withFileLock } from '../atomic-file.js';
import { agentDir, stateRoot } from '../paths.js';
import { readProvenance } from '../creation.js';
import { readTempSupervisor, tempSupervisorLiveness, requestedTempStopReason } from '../temp-lifecycle.js';
import { taskSupervisorMayRun } from '../task-supervision.js';
import { resumeTaskSupervisor } from '../spawn.js';
import { resetRestartLedger, readRestartLedger } from '../runner.js';
import { readRoomReadiness } from '../agent-ours/service.js';
import type { ResolvedRole } from '../config.js';
import type { CoworkAdapter } from './cowork-adapter.js';
import { getTask } from './task-state.js';
import { getRoomRecord } from './room-state.js';
import { roomCloseLockPath, CLOSE_LOCK_STALE_MS } from './close.js';
import { taskOperationLockPath, TASK_OPERATION_LOCK_STALE_MS } from './terminal.js';
import { adoptLegacyTaskMember } from './legacy-task-member.js';

export type MemberRecovery = { name: string; status: 'running' | 'resumed' | 'migration_pending' | 'recovery_reset' };
export interface TaskMemberRecoveryDeps {
  liveness?: typeof tempSupervisorLiveness;
  resume?: typeof resumeTaskSupervisor;
  adopt?(taskId: string, roomId: string, name: string): Promise<void>;
}
/** Explicit supported recovery; never creates an identity, seat, invite, or session ID. */
export async function recoverTaskMembers(input: {
  taskId: string; binPath: string; cowork?: Pick<CoworkAdapter, 'getRoom'>; deps?: TaskMemberRecoveryDeps;
}): Promise<MemberRecovery[]> {
  const deps = input.deps ?? {};
  return withFileLock(taskOperationLockPath(input.taskId), async () => {
    const task = getTask(input.taskId);
    if (!['provisioning', 'active', 'review'].includes(task.state) || task.deletion || task.terminal_intent)
      throw Error('Task is not open for member recovery');
    const recover = async (name: string, roomId?: string): Promise<MemberRecovery> => {
      const dir = agentDir(name, true), metadata = readTempSupervisor(dir);
      if (!metadata || metadata.role !== name) throw Error('Exact supervisor state missing; explicit reconciliation required');
      if (requestedTempStopReason(dir)) throw Error('Task member has an explicit retirement request');
      const live = await (deps.liveness ?? tempSupervisorLiveness)(dir);
      if (live === 'unknown') throw Error('Supervisor liveness unknown; refusing recovery');
      if (!metadata.taskOwner) {
        if (live === 'running') return { name, status: 'migration_pending' };
        if (!roomId) throw Error('Legacy layout member requires explicit reconciliation');
        if (deps.adopt) await deps.adopt(input.taskId, roomId, name);
        else {
          const room = getRoomRecord(roomId)!;
          const seat = room.member_seats.find(member => member.role_name === name)!;
          const adopted = await adoptLegacyTaskMember({ taskId: input.taskId, roomId,
            roomIdentityCid: room.room_identity_cid!, creationActionId: seat.launch!.action_id! }, name);
          if (adopted === 'running-legacy') return { name, status: 'migration_pending' };
        }
      }
      if (!taskSupervisorMayRun(name)) throw Error('Task member is retired');
      const reset = readRestartLedger(dir).circuit === 'open';
      if (reset) resetRestartLedger(dir);
      if (live === 'running') {
        return { name, status: reset ? 'recovery_reset' : 'running' };
      }
      await (deps.resume ?? resumeTaskSupervisor)(name, input.binPath);
      return { name, status: 'resumed' };
    };
    if (task.layout) {
      const path = join(stateRoot(), 'layouts', `${task.layout.run_id}.json`);
      return withFileLock(path + '.lock', async () => {
        const state = JSON.parse(readFileSync(path, 'utf8'));
        if (state.closed || state.closing || state.uncertain) throw Error('Layout requires reconciliation before recovery');
        const result: MemberRecovery[] = [];
        for (const member of Object.values(state.participants) as Array<{ owned: boolean; retired?: boolean; instance?: { agent?: string; remote?: unknown } }>) {
          if (!member.owned || member.retired) continue;
          if (!member.instance?.agent || member.instance.remote) throw Error('Layout owned instance evidence missing');
          result.push(await recover(member.instance.agent));
        }
        return result;
      });
    }
    if (!task.room_id || !input.cowork) throw Error('Task room required for member recovery');
    return withFileLock(roomCloseLockPath(task.room_id), async () => {
      const room = getRoomRecord(task.room_id!);
      if (!room || room.task_id !== task.task_id || room.close || !['active', 'provisioning'].includes(room.state)
          || !room.room_identity_cid || room.room_identity_cid !== task.room_identity_cid)
        throw Error('Exact open task room required');
      const remote = await input.cowork!.getRoom(room.room_id);
      if (!remote || remote.identity_cid !== room.room_identity_cid || remote.state !== 'active')
        throw Error('Exact active Cowork room required');
      // Validate the complete admitted roster before any member is resumed.
      for (const seat of room.member_seats) {
        const dir = agentDir(seat.role_name, true), metadata = readTempSupervisor(dir), provenance = readProvenance(dir);
        const role = parse(readFileSync(join(dir, 'role.yaml'), 'utf8')) as ResolvedRole, startup = role.roomMemberStartup;
        const found = remote.seats.filter(item => item.display_name === seat.role_name && item.seat_state !== 'removed');
        const ready = readRoomReadiness(room.room_identity_cid, seat.role_name);
        if (seat.retirement || !seat.identity_cid || !seat.invite_id || !seat.launch?.action_id || !seat.launch.launch_id
            || metadata?.role !== seat.role_name || metadata.launchId !== seat.launch.launch_id
            || provenance?.role !== seat.role_name || provenance.creationActionId !== seat.launch.action_id
            || role.identity !== seat.role_name || startup?.identity_name !== seat.role_name
            || startup.room_id !== room.room_id || startup.room_identity_cid !== room.room_identity_cid
            || startup.invite_id !== seat.invite_id || startup.role !== seat.cowork_role
            || !ready || ready.cid !== seat.identity_cid || ready.room !== room.room_id || ready.invite !== seat.invite_id
            || found.length !== 1 || found[0].identity_cid !== seat.identity_cid || found[0].invite_id !== seat.invite_id
            || found[0].role !== seat.cowork_role || found[0].seat_state !== 'active')
          throw Error(`Exact admitted member proof missing: ${seat.role_name}`);
      }
      const result: MemberRecovery[] = [];
      for (const seat of room.member_seats) result.push(await recover(seat.role_name, room.room_id));
      return result;
    }, {}, CLOSE_LOCK_STALE_MS);
  }, {}, TASK_OPERATION_LOCK_STALE_MS);
}
