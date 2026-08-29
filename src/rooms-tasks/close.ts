import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachOursClient, type OursClient } from '@ours.network/sdk/client';

import { withFileLock } from '../atomic-file.js';
import { agentDir, stateRoot } from '../paths.js';
import { daemonIdentityProvisioner } from '../creation.js';
import { createAgentProductionRuntime } from '../agent-production-runtime.js';
import {
  readTempSupervisor, secureStoppedTempArchive, stopTempSupervisor, tempSupervisorLiveness,
  type TempLifecycleDeps,
} from '../temp-lifecycle.js';
import type { CoworkAdapter } from './cowork-adapter.js';
import {
  advanceMemberRetirement, advanceRoomClose, beginRoomClose, closeRoom,
  acknowledgeRoomEffectReceipt, deleteRoomRecord, getRoomEffectReceipt,
  completeRoomDeletionTombstone, getAuthenticatedRoomDeletionTombstone, getRoomRecord,
  getRoomRecoveryReceipt, listRoomRecords,
  publishRoomDeletionTombstoneAndUnlink, setRoomCloseError,
} from './room-state.js';
import type { RoomEffectContext } from './room-state.js';
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

function authenticateCanonicalBinding(seat: RoomMemberSeat): void {
  if (seat.plan_binding) {
    const binding = seat.plan_binding;
    const runtime = createAgentProductionRuntime({
      trustedStateRoot: stateRoot(), identityProvisioner: daemonIdentityProvisioner(),
    });
    const { handoff, plan } = runtime.resumeTemporaryComposition({
      agentId: binding.agent_id, actionId: binding.action_id,
    });
    const exact = handoff.agentId === binding.agent_id
      && plan.agentId === binding.agent_id
      && seat.role_name === binding.agent_id
      && handoff.generation === binding.generation
      && handoff.actionId === binding.action_id
      && handoff.planDigest === binding.plan_digest
      && handoff.snapshotDigest === binding.snapshot_digest
      && handoff.reservationDigest === binding.reservation_digest
      && handoff.handoffDigest === binding.handoff_digest
      && handoff.authorizationRevision === binding.authorization_revision
      && binding.kind === 'canonical_agent_plan'
      && binding.identity_ownership === 'create_temporary'
      && plan.identity.ownership === binding.identity_ownership
      && plan.role.id === binding.role_id
      && plan.adapter.brainDigest === binding.brain_digest;
    if (!exact)
      throw new Error(`room member '${seat.role_name}' canonical AgentPlan authority mismatch`);
  }
}

async function inspectMember(seat: RoomMemberSeat): Promise<{ launchId: string }> {
  authenticateCanonicalBinding(seat);
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

async function retireMember(
  roomId: string, seat: RoomMemberSeat, deps: RoomCloseDeps,
): Promise<void> {
  let room = getRoomRecord(roomId)!;
  let current = room.member_seats.find(candidate => candidate.role_name === seat.role_name)!;
  let retirement = current.retirement;
  if (!retirement) {
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
export function acceptManagedRoomClose(roomId: string, effect?: RoomEffectContext): Promise<RoomOrchestrationRecord> {
  return withFileLock(
    roomCloseLockPath(roomId),
    () => beginRoomClose(roomId, effect),
    {},
    CLOSE_LOCK_STALE_MS,
  );
}

export function getManagedRoomCloseReceipt(roomId: string, keyHash: string) {
  return withFileLock(roomCloseLockPath(roomId), () => getRoomEffectReceipt(roomId, keyHash), {},
    CLOSE_LOCK_STALE_MS);
}

export function acknowledgeManagedRoomCloseReceipt(roomId: string, keyHash: string,
  hooks: { beforeState?(): void | Promise<void> } = {}): Promise<void> {
  return withFileLock(roomCloseLockPath(roomId), async () => {
    await hooks.beforeState?.(); acknowledgeRoomEffectReceipt(roomId, keyHash);
  }, {},
    CLOSE_LOCK_STALE_MS);
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
    const before = getRoomRecord(input.roomId);
    for (const seat of before?.member_seats ?? []) {
      if (seat.plan_binding && !seat.retirement) authenticateCanonicalBinding(seat);
    }
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
        `Retry 'ours-fleet room delete ${input.roomId} ${input.roomId}' or run room recover.`,
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
    await input.cowork.deleteRoom(room.room_id);
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
  try {
    await input.cowork.deleteRoom(input.roomId);
  } catch (error) {
    setRoomCloseError(
      input.roomId,
      errorText(error),
      `Retry 'ours-fleet room delete ${input.roomId} ${input.roomId}' or run room recover.`,
    );
    throw error;
  }
  deleteRoomRecord(input.roomId);
  return { room_id: input.roomId, deleted: true };
}

/** Receipt-selected close worker. The caller must already have a completed acceptance journal. */
export async function settleManagedRoomRecovery(input: {
  roomId: string; keyHash: string; principalHash: string; requestHash: string;
  cowork: Pick<CoworkAdapter, 'closeRoom'|'deleteRoom'>; deps?: RoomCloseDeps;
  recoveryHooks?: { afterCoworkDelete?(): void; afterTombstonePublication?(): void;
    afterRoomUnlink?(): void; afterDirectorySync?(): void };
}): Promise<{ room_id: string; deleted: true }> {
  const deps = input.deps ?? {};
  return withFileLock(roomCloseLockPath(input.roomId), async () => {
    const retained = getAuthenticatedRoomDeletionTombstone(input.roomId, input.keyHash, input);
    if (retained) {
      if (retained.phase === 'local_delete_pending') {
        publishRoomDeletionTombstoneAndUnlink(input.roomId, input.keyHash);
        completeRoomDeletionTombstone(input.roomId, input.keyHash);
      }
      return { room_id: input.roomId, deleted: true };
    }
    const receipt = getRoomRecoveryReceipt(input.roomId, input.keyHash);
    if (!receipt || receipt.cursor.kind !== 'close' || receipt.workerStatus !== 'pending'
        || receipt.principalHash !== input.principalHash || receipt.requestHash !== input.requestHash)
      throw new Error('room recovery close worker is unavailable');
    await closeManagedRoom({ roomId: input.roomId, cowork: input.cowork,
      deps: { ...deps, lock: async (_path, work) => work() } });
    await input.cowork.deleteRoom(input.roomId);
    input.recoveryHooks?.afterCoworkDelete?.();
    publishRoomDeletionTombstoneAndUnlink(input.roomId, input.keyHash, input.recoveryHooks);
    completeRoomDeletionTombstone(input.roomId, input.keyHash);
    return { room_id: input.roomId, deleted: true };
  }, {}, CLOSE_LOCK_STALE_MS);
}
