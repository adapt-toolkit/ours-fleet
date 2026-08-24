import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachOursClient, type OursClient } from '@ours.network/sdk/client';

import { withFileLock } from '../atomic-file.js';
import { agentDir, stateRoot } from '../paths.js';
import {
  readTempSupervisor, secureStoppedTempArchive, stopTempSupervisor, tempSupervisorLiveness,
  type TempLifecycleDeps,
} from '../temp-lifecycle.js';
import type { CoworkAdapter } from './cowork-adapter.js';
import {
  advanceMemberRetirement, advanceRoomClose, beginRoomClose, closeRoom,
  getRoomRecord, setRoomCloseError,
} from './room-state.js';
import type { RoomMemberSeat, RoomOrchestrationRecord } from './types.js';

const CLOSE_LOCK_STALE_MS = 5 * 60_000;
const STOP_POLLS = 50;
const STOP_POLL_MS = 100;

function roomCloseLockPath(roomId: string): string {
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

async function inspectMember(seat: RoomMemberSeat): Promise<{ launchId: string }> {
  exactMemberIdentity(seat);
  const supervisor = readTempSupervisor(agentDir(seat.role_name, true));
  if (!supervisor || supervisor.role !== seat.role_name) {
    throw new Error(`room member '${seat.role_name}' has no exact Fleet supervisor ownership proof`);
  }
  return { launchId: supervisor.launchId };
}

async function waitForLivenessAbsent(
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
  const client = await attachOursClient({
    env: process.env,
    leaseToken: `ours-fleet-room-close-${process.pid}-${randomUUID()}`,
    clientPid: process.pid,
  });
  try { return await work(client); }
  finally { await client.releaseLease().catch(() => {}); }
}

function listedIdentity(
  rows: Awaited<ReturnType<OursClient['listIdentities']>>, name: string,
): { name: string; cid: string } | undefined {
  return rows.find(row => row.name === name);
}

async function removeExactMemberIdentity(seat: RoomMemberSeat): Promise<void> {
  await withIdentityClient(async client => {
    const before = listedIdentity(await client.listIdentities(), seat.role_name);
    if (!before) return;
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

async function retireMember(
  roomId: string, seat: RoomMemberSeat, deps: RoomCloseDeps,
): Promise<void> {
  let room = getRoomRecord(roomId)!;
  let current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
  let retirement = current.retirement;
  if (!retirement) {
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
          if (seat.retirement?.phase === 'identity_absent') continue;
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
        `Retry 'ours-fleet room close ${input.roomId} ${input.roomId}' or run room recover.`,
      );
      throw error;
    }
  }, {}, CLOSE_LOCK_STALE_MS);
}
