import { detachDeletedRoom } from './task-state.js';
import { binderKey } from '../agent-ours/state.js';
import { eraseMemberArtifacts } from './erasure.js';
import { deleteWorkspace, assertWorkspaceDeletable } from './workspace.js';
import { collectWorkspaceArchives } from './workspace-artifacts.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachOursClient, type OursClient } from '@ours.network/sdk/client';

import { withFileLock } from '../atomic-file.js';
import { agentDir, stateRoot } from '../paths.js';
import { readClientProfile } from '../client-profile.js';
import {
  readTempSupervisor, secureStoppedTempArchive, stopTempSupervisor, tempSupervisorLiveness,
  tempArchiveForLaunch, tempArchiveForCreationAction, type TempLifecycleDeps,
} from '../temp-lifecycle.js';
import { CoworkProtocolError, type CoworkAdapter } from './cowork-adapter.js';
import {
  advanceMemberRetirement, advanceRoomClose, beginRoomClose, closeRoom,
  deleteRoomRecord, getRoomRecord, listRoomRecords, setRoomCloseError, recordRetirementMemberCids,
} from './room-state.js';
import type { RoomMemberSeat, RoomOrchestrationRecord } from './types.js';

export const CLOSE_LOCK_STALE_MS = 5 * 60_000;
const STOP_POLLS = 50;
const STOP_POLL_MS = 100;

export function roomCloseLockPath(roomId: string): string {
  return join(stateRoot(), 'locks', 'room-close', encodeURIComponent(roomId));
}

export interface RoomCloseDeps {
  inspectMember?(seat: RoomMemberSeat): Promise<{ launchId: string }>;
  requestStop?(role: string): Promise<void>;
  waitForLivenessAbsent?(role: string, launchId: string): Promise<void>;
  secureArchive?(role: string, launchId: string): Promise<string>;
  removeIdentity?(seat: RoomMemberSeat): Promise<void>;
  lock?: typeof withFileLock;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exactMemberIdentity(seat: RoomMemberSeat): void {
  const dir = agentDir(seat.role_name, true);
  const identityPath = join(dir, '.identity');
  if (existsSync(dir) && !existsSync(identityPath) && seat.launch?.action_id && seat.launch.launch_id) {
    const supervisor = readTempSupervisor(dir);
    let creation;
    try { creation = JSON.parse(readFileSync(join(dir, 'creation.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (supervisor?.role === seat.role_name && supervisor.launchId === seat.launch.launch_id
        && creation?.role === seat.role_name && creation.creationActionId === seat.launch.action_id) return;
  }
  if (!existsSync(dir) || !existsSync(identityPath)) {
    throw new Error(
      `room member '${seat.role_name}' has no live Fleet temp-state identity proof; refusing retirement`,
    );
  }
  const identity = readFileSync(identityPath, 'utf8').trim();
  if (identity !== seat.role_name) {
    throw new Error(
      `room member '${seat.role_name}' temp state binds identity '${identity}'; refusing mismatched retirement`,
    );
  }
}

export async function inspectMember(seat: RoomMemberSeat): Promise<{ launchId: string }> {
  exactMemberIdentity(seat);
  const supervisor = readTempSupervisor(agentDir(seat.role_name, true));
  if (!supervisor || supervisor.role !== seat.role_name
      || (seat.launch?.launch_id && supervisor.launchId !== seat.launch.launch_id)) {
    throw new Error(`room member '${seat.role_name}' has no exact Fleet supervisor ownership proof`);
  }
  return { launchId: supervisor.launchId };
}

export async function waitForLivenessAbsent(
  role: string, launchId: string, lifecycleDeps: TempLifecycleDeps = {},
): Promise<void> {
  const dir = agentDir(role, true);
  const sleep = lifecycleDeps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < STOP_POLLS; attempt++) {
    if (!existsSync(dir)) return; // secureStoppedTempArchive proves the exact archive next.
    const supervisor = readTempSupervisor(dir);
    if (!supervisor || supervisor.role !== role || supervisor.launchId !== launchId) {
      throw new Error(`temporary role '${role}' changed while waiting for launch ${launchId} to stop`);
    }
    const state = await tempSupervisorLiveness(dir, lifecycleDeps);
    if (state === 'stopped') return;
    if (attempt < STOP_POLLS - 1) await sleep(STOP_POLL_MS);
  }
  throw new Error(`temporary role '${role}' did not reach proven stopped liveness`);
}

async function withIdentityClient<T>(work: (client: OursClient) => Promise<T>): Promise<T> {
  const profile = readClientProfile(process.env);
  const leaseToken = `ours-fleet-room-close-${process.pid}-${randomUUID()}`;
  const client = await attachOursClient(profile ? {
    endpoint: profile.endpoint,
    expectedInstanceId: profile.expectedInstanceId,
    credentialPath: profile.credentialPath,
    sessionMode: 'external', env: {}, leaseToken,
  } : {
    env: process.env,
    leaseToken,
    clientPid: process.pid,
  });
  try { return await work(client); }
  finally {
    try { await client.releaseLease().catch(() => {}); }
    finally { await client.close(); }
  }
}

function listedIdentity(
  rows: Awaited<ReturnType<OursClient['listIdentities']>>, name: string,
): { name: string; cid: string } | undefined {
  return rows.find((row): row is Extract<typeof row, { cid: string }> =>
    row.name === name && 'cid' in row);
}

/** Report whether any daemon identity — under any name — carries this exact CID. */
export async function identityCidPresent(cid: string): Promise<boolean> {
  return withIdentityClient(async client => {
    const rows = await client.listIdentities();
    return rows.some(row => 'cid' in row && row.cid.toLowerCase() === cid.toLowerCase());
  });
}

export async function removeExactMemberIdentity(seat: RoomMemberSeat): Promise<void> {
  await withIdentityClient(async client => {
    const rows = await client.listIdentities();
    const before = listedIdentity(rows, seat.role_name);
    if (!before) {
      if (rows.some(row => row.name === seat.role_name || (seat.identity_cid && 'cid' in row
          && row.cid.toLowerCase() === seat.identity_cid.toLowerCase())))
        throw new Error(`room member '${seat.role_name}' identity absence is not proven`);
      return;
    }
    if (!seat.identity_cid) {
      throw new Error(
        `room member '${seat.role_name}' exists without a recorded authenticated CID; identity absence is not proven; refusing removal`,
      );
    }
    if (before.cid?.toLowerCase() !== seat.identity_cid.toLowerCase()) {
      throw new Error(
        `room member '${seat.role_name}' identity absence is not proven: CID mismatch: recorded ${seat.identity_cid}, found ${before.cid ?? 'none'}`,
      );
    }
    try {
      await client.removeIdentity({ name: seat.role_name });
    } catch (error) {
      const code = error instanceof Error && error.name === 'OursError'
        ? (error as Error & { code?: string }).code
        : undefined;
      if (code !== 'NO_SUCH_IDENTITY') throw error;
      const after = listedIdentity(await client.listIdentities(), seat.role_name);
      if (after) throw error;
    }
    const after = await client.listIdentities();
    if (after.some(row => row.name === seat.role_name || (seat.identity_cid && 'cid' in row
        && row.cid.toLowerCase() === seat.identity_cid.toLowerCase()))) {
      throw new Error(`room member '${seat.role_name}' identity still exists after remove_identity`);
    }
  });
}

export async function assertMemberIdentityAbsent(seat: RoomMemberSeat): Promise<void> {
  await withIdentityClient(async client => {
    const rows = await client.listIdentities();
    if (rows.some(row => row.name === seat.role_name ||
        (seat.identity_cid && 'cid' in row && row.cid.toLowerCase() === seat.identity_cid.toLowerCase()))) {
      throw new Error(`room member '${seat.role_name}' identity absence is not proven; refusing retirement`);
    }
  });
}

async function retireMember(
  roomId: string, seat: RoomMemberSeat, deps: RoomCloseDeps,
): Promise<void> {
  let room = getRoomRecord(roomId)!;
  let current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
  let retirement = current.retirement;
  if (retirement?.phase === 'identity_absent') {
    if (!deps.inspectMember) {
      if (existsSync(agentDir(current.role_name, true))) throw new Error('Retired member has replacement launch live state');
      await assertMemberIdentityAbsent(current);
    }
    return;
  }
  if (!retirement) {
    if (!existsSync(agentDir(current.role_name, true)) && current.launch?.launch_id && current.launch.action_id) {
      const archived = tempArchiveForLaunch(current.role_name, current.launch.launch_id);
      const created = tempArchiveForCreationAction(current.role_name, current.launch.action_id);
      if (archived && (!created || created.path !== archived || created.launchId !== current.launch.launch_id))
        throw new Error('Archived member creation ownership mismatch');
      if (archived && created?.path === archived && created.launchId === current.launch.launch_id) {
        if (readFileSync(join(archived, '.identity'), 'utf8').trim() !== current.role_name)
          throw new Error(`room member '${current.role_name}' archive identity mismatch`);
        if (await tempSupervisorLiveness(archived) !== 'stopped')
          throw new Error(`room member '${current.role_name}' archived supervisor is not proven stopped`);
        // A terminated launch can archive itself before room retirement begins.
        // Accept its exact durable provenance only when no identity needs removal.
        await (deps.removeIdentity ?? removeExactMemberIdentity)(current);
        await assertMemberIdentityAbsent(current);
        const latest = getRoomRecord(roomId)?.member_seats.find(seat => seat.role_name === current.role_name);
        if (existsSync(agentDir(current.role_name, true))
            || latest?.launch?.launch_id !== current.launch.launch_id
            || latest?.launch?.action_id !== current.launch.action_id
            || latest?.identity_cid !== current.identity_cid)
          throw new Error(`room member '${current.role_name}' changed during archived retirement proof`);
        advanceMemberRetirement(roomId, current.role_name, 'identity_absent', current.launch.launch_id, archived);
        return;
      }
    }
    if (current.launch?.state === 'pending' && current.launch.attempt === 0) {
      if (existsSync(agentDir(current.role_name, true))) {
        throw new Error(
          `never-launched room member '${current.role_name}' unexpectedly has Fleet temp state`,
        );
      }
      await (deps.removeIdentity ?? removeExactMemberIdentity)(current);
      advanceMemberRetirement(
        roomId, current.role_name, 'identity_absent', 'never-launched',
      );
      return;
    }
    if (!deps.inspectMember && !existsSync(agentDir(current.role_name, true))) {
      await (deps.removeIdentity ?? removeExactMemberIdentity)(current);
      if (existsSync(agentDir(current.role_name, true)))
        throw new Error(`room member '${current.role_name}' acquired replacement state during retirement`);
      advanceMemberRetirement(roomId, current.role_name, 'identity_absent', 'absent-verified');
      return;
    }
    const ownership = await (deps.inspectMember ?? inspectMember)(current);
    room = advanceMemberRetirement(
      roomId, current.role_name, 'stop_requested', ownership.launchId,
    );
    current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
    retirement = current.retirement!;
  }

  if (['stop_requested', 'liveness_absent', 'archive_secured'].includes(retirement.phase) && !deps.requestStop
      && !existsSync(agentDir(current.role_name, true))) {
    const archive = tempArchiveForLaunch(current.role_name, retirement.launch_id);
    if (archive && await tempSupervisorLiveness(archive) !== 'stopped')
      throw new Error('Archived supervisor is not proven stopped');
    await (deps.removeIdentity ?? removeExactMemberIdentity)(current);
    await assertMemberIdentityAbsent(current);
    advanceMemberRetirement(roomId, current.role_name, 'identity_absent', retirement.launch_id, archive, !archive);
    return;
  }

  if (retirement.phase === 'stop_requested') {
    if (!deps.inspectMember && (await inspectMember(current)).launchId !== retirement.launch_id)
      throw new Error('Member launch changed before stop');
    await (deps.requestStop ?? (async role => { await stopTempSupervisor(role); }))(current.role_name);
    await (deps.waitForLivenessAbsent ?? waitForLivenessAbsent)(
      current.role_name, retirement.launch_id,
    );
    room = advanceMemberRetirement(
      roomId, current.role_name, 'liveness_absent', retirement.launch_id,
    );
    current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
    retirement = current.retirement!;
  }

  if (retirement.phase === 'liveness_absent') {
    const archivePath = await (deps.secureArchive ?? secureStoppedTempArchive)(
      current.role_name, retirement.launch_id,
    );
    room = advanceMemberRetirement(
      roomId, current.role_name, 'archive_secured', retirement.launch_id, archivePath,
    );
    current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
    retirement = current.retirement!;
  }

  if (retirement.phase === 'archive_secured') {
    await (deps.removeIdentity ?? removeExactMemberIdentity)(current);
    advanceMemberRetirement(
      roomId, current.role_name, 'identity_absent', retirement.launch_id,
      retirement.archive_path,
    );
  }
}

/** One forward-only room close saga shared by every Fleet entry point. */
export function acceptManagedRoomClose(roomId: string): Promise<RoomOrchestrationRecord> {
  return withFileLock(
    roomCloseLockPath(roomId),
    () => beginRoomClose(roomId),
    {},
    CLOSE_LOCK_STALE_MS,
  );
}

export function recordManagedRoomCloseError(
  roomId: string, error: string, recoveryHint: string,
): Promise<RoomOrchestrationRecord> {
  return withFileLock(
    roomCloseLockPath(roomId),
    () => setRoomCloseError(roomId, error, recoveryHint),
    {},
    CLOSE_LOCK_STALE_MS,
  );
}

export async function closeManagedRoom(input: {
  roomId: string;
  cowork: Pick<CoworkAdapter, 'closeRoom'> & Partial<Pick<CoworkAdapter, 'getRoom'>>;
  deps?: RoomCloseDeps;
}): Promise<RoomOrchestrationRecord> {
  const deps = input.deps ?? {};
  const lock = deps.lock ?? withFileLock;
  return lock(roomCloseLockPath(input.roomId), async () => {
    let room = beginRoomClose(input.roomId);
    if (room.state === 'closed') {
      if (!deps.inspectMember) for (const seat of room.member_seats) {
        if (existsSync(agentDir(seat.role_name, true))) throw new Error('Closed room has replacement live state');
        await assertMemberIdentityAbsent(seat);
      }
      return room;
    }
    try {
      if (room.close?.phase === 'retire_members') {
        room = await recoverMemberCids(room, input.cowork);
        for (const seat of room.member_seats) {
          await retireMember(input.roomId, seat, deps);
        }
        room = advanceRoomClose(input.roomId, 'close_cowork');
      }
      if (room.close?.phase === 'close_cowork') {
        try { await input.cowork.closeRoom(input.roomId); }
        catch (error) {
          if (!(error instanceof CoworkProtocolError && error.code === 'not_found')) throw error;
        }
      }
      return closeRoom(input.roomId);
    } catch (error) {
      setRoomCloseError(
        input.roomId,
        errorText(error),
        `Retry 'ours-fleet room delete ${input.roomId} ${input.roomId}'.`,
      );
      throw error;
    }
  }, {}, CLOSE_LOCK_STALE_MS);
}

export interface ManagedRoomDeleteResult {
  room_id: string;
  deleted: true;
}

/** Remove retained state written by prerelease builds that stopped at `closed`. */
export async function deleteLegacyClosedRooms(input: {
  cowork: Pick<CoworkAdapter, 'deleteRoom'>;
}): Promise<string[]> {
  const deleted: string[] = [];
  for (const room of listRoomRecords({ state: 'closed' })) {
    // This compatibility sweep is retirement, never explicit workspace deletion.
    if (room.workspace) continue;
    try {
      await input.cowork.deleteRoom(room.room_id);
    } catch (error) {
      // The retained Fleet record is the legacy state being migrated. If the
      // exact Cowork room is already absent, the desired deletion is complete.
      if (!(error instanceof CoworkProtocolError && error.code === 'not_found')) throw error;
    }
    deleteRoomRecord(room.room_id);
    deleted.push(room.room_id);
  }
  return deleted;
}

/** Retire live resources through the existing cursor, then delete retained state. */
export async function deleteManagedRoom(input: {
  roomId: string;
  cowork: Pick<CoworkAdapter, 'closeRoom' | 'deleteRoom'> & Partial<Pick<CoworkAdapter, 'getRoom'>>;
  deps?: RoomCloseDeps;
}): Promise<ManagedRoomDeleteResult> {
  if (getRoomRecord(input.roomId)) await closeManagedRoom(input);
  return withFileLock(roomCloseLockPath(input.roomId), async () => {
    try {
      try { await input.cowork.deleteRoom(input.roomId); }
      catch (error) {
        // An earlier explicit delete may have removed the remote room before
        // local filesystem cleanup failed. Never restore it or repeat creation.
        if (!(error instanceof CoworkProtocolError && error.code === 'not_found')) throw error;
      }
      const retained = getRoomRecord(input.roomId);
      if (retained?.workspace && !retained.task_id) {
        assertWorkspaceDeletable(retained.workspace, 'room', input.roomId);
        collectWorkspaceArchives(retained.workspace);
        deleteWorkspace(retained.workspace, 'room', input.roomId);
      }
      if (retained) await eraseMemberArtifacts('room', input.roomId, retained.member_seats, [input.roomId]);
      if (retained?.task_id) detachDeletedRoom(retained.task_id, input.roomId);
      deleteRoomRecord(input.roomId);
      return { room_id: input.roomId, deleted: true as const };
    } catch (error) {
      if (getRoomRecord(input.roomId)) setRoomCloseError(input.roomId, errorText(error),
        `Fix the cleanup error and explicitly retry room delete ${input.roomId} ${input.roomId}.`);
      throw error;
    }
  }, {}, CLOSE_LOCK_STALE_MS);
}

/** Recover only an authenticated seat tied to this exact room and issued invite.
 * Display names and the current daemon name inventory are never binding proof.
 */
async function recoverMemberCids(
  room: RoomOrchestrationRecord, cowork: Partial<Pick<CoworkAdapter, 'getRoom'>>,
): Promise<RoomOrchestrationRecord> {
  if (!room.member_seats.some(seat => !seat.identity_cid)) return room;
  const profile = room.member_seats.some(seat => seat.launch?.action_id) ? readClientProfile(process.env) : undefined;
  let remote: Awaited<ReturnType<CoworkAdapter['getRoom']>>;
  if (cowork.getRoom && room.room_identity_cid) {
    try { remote = await cowork.getRoom(room.room_id); }
    catch (error) {
      if (!(error instanceof CoworkProtocolError && error.code === 'not_found')) throw error;
    }
    if (remote && (remote.room_id !== room.room_id || remote.identity_cid.toLowerCase() !== room.room_identity_cid.toLowerCase()))
      throw new Error('Room identity mismatch during deletion recovery');
  }
  const seats = room.member_seats.map(seat => {
    let runtimeCid: string | undefined;
    if (profile && seat.launch?.action_id) {
      const dir = join(stateRoot(), 'private-ours', binderKey(profile.expectedInstanceId, seat.role_name));
      try {
        const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
        const instance = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
        if (state.name === seat.role_name && state.daemon === profile.expectedInstanceId
            && state.lifetime === 'temporary' && state.action === seat.launch.action_id
            && instance.role === seat.role_name && instance.temporary === true && instance.instance === state.instance)
          runtimeCid = state.cid;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const matches = seat.invite_id ? remote?.seats.filter(value => value.invite_id === seat.invite_id && value.role === seat.cowork_role) ?? [] : [];
    if (matches.length > 1) throw new Error('Ambiguous authenticated member identity during deletion recovery');
    const candidates = [seat.identity_cid, runtimeCid, matches[0]?.identity_cid].filter((v): v is string => !!v);
    if (candidates.some(cid => !/^[a-f0-9]{64}$/i.test(cid))) throw new Error('Invalid authenticated member CID');
    if (new Set(candidates.map(cid => cid.toLowerCase())).size > 1) throw new Error('Contradictory authenticated member CID evidence');
    return candidates.length ? { ...seat, identity_cid: candidates[0] } : seat;
  });
  return recordRetirementMemberCids(room.room_id, seats);
}
