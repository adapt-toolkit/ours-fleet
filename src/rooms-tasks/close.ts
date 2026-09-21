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
  deleteRoomRecord, getRoomRecord, listRoomRecords, setRoomCloseError,
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
  if (!supervisor || supervisor.role !== seat.role_name) {
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
    const before = listedIdentity(await client.listIdentities(), seat.role_name);
    if (!before) return;
    if (!seat.identity_cid) {
      throw new Error(
        `room member '${seat.role_name}' exists without a recorded authenticated CID; refusing removal`,
      );
    }
    if (before.cid?.toLowerCase() !== seat.identity_cid.toLowerCase()) {
      throw new Error(
        `room member '${seat.role_name}' identity CID mismatch: recorded ${seat.identity_cid}, found ${before.cid ?? 'none'}`,
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
    const after = listedIdentity(await client.listIdentities(), seat.role_name);
    if (after) {
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
    if (current.launch?.launch_id && current.launch.launch_id !== retirement.launch_id) {
      if (existsSync(agentDir(current.role_name, true)))
        throw new Error(`room member '${current.role_name}' has a replacement launch after retirement; retire that exact temporary role before retrying`);
      await assertMemberIdentityAbsent(current);
    }
    return;
  }
  if (!retirement) {
    if (!existsSync(agentDir(current.role_name, true)) && current.launch?.launch_id && current.launch.action_id) {
      const archived = tempArchiveForLaunch(current.role_name, current.launch.launch_id);
      const created = tempArchiveForCreationAction(current.role_name, current.launch.action_id);
      if (archived && created?.path === archived && created.launchId === current.launch.launch_id) {
        if (readFileSync(join(archived, '.identity'), 'utf8').trim() !== current.role_name)
          throw new Error(`room member '${current.role_name}' archive identity mismatch`);
        if (await tempSupervisorLiveness(archived) !== 'stopped')
          throw new Error(`room member '${current.role_name}' archived supervisor is not proven stopped`);
        // A terminated launch can archive itself before room retirement begins.
        // Accept its exact durable provenance only when no identity needs removal.
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
    if (current.launch?.state === 'failed' && !existsSync(agentDir(current.role_name, true))) {
      // A failure before applyRole (for example invite-secret validation) has
      // no supervisor to stop or archive. Settle only proven absence; this
      // path never removes an identity based on missing local evidence.
      await assertMemberIdentityAbsent(current);
      advanceMemberRetirement(roomId, current.role_name, 'identity_absent', 'failed-launch-absent');
      return;
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
    const ownership = await (deps.inspectMember ?? inspectMember)(current);
    room = advanceMemberRetirement(
      roomId, current.role_name, 'stop_requested', ownership.launchId,
    );
    current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
    retirement = current.retirement!;
  }

  if (retirement.phase === 'stop_requested') {
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
  cowork: Pick<CoworkAdapter, 'closeRoom'>;
  deps?: RoomCloseDeps;
}): Promise<RoomOrchestrationRecord> {
  const deps = input.deps ?? {};
  const lock = deps.lock ?? withFileLock;
  return lock(roomCloseLockPath(input.roomId), async () => {
    let room = beginRoomClose(input.roomId);
    if (room.state === 'closed') return room;
    try {
      if (room.close?.phase === 'retire_members') {
        for (const seat of room.member_seats) {
          await retireMember(input.roomId, seat, deps);
        }
        room = advanceRoomClose(input.roomId, 'close_cowork');
      }
      if (room.close?.phase === 'close_cowork') {
        await input.cowork.closeRoom(input.roomId);
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
  cowork: Pick<CoworkAdapter, 'closeRoom' | 'deleteRoom'>;
  deps?: RoomCloseDeps;
}): Promise<ManagedRoomDeleteResult> {
  await closeManagedRoom(input);
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
      deleteRoomRecord(input.roomId);
      return { room_id: input.roomId, deleted: true as const };
    } catch (error) {
      setRoomCloseError(input.roomId, errorText(error),
        `Fix the cleanup error and explicitly retry room delete ${input.roomId} ${input.roomId}.`);
      throw error;
    }
  }, {}, CLOSE_LOCK_STALE_MS);
}
