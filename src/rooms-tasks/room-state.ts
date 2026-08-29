import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { replaceFileAtomically } from '../atomic-file.js';
import { withFileLockSync } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  RoomOrchestrationRecord, RoomOrchestrationState, SagaCursor, SagaPhase,
  RoomMemberSeat, ProvisioningDetail,
  MemberRetirementPhase, RoomClosePhase,
  RoomRoleBriefingDefinition, RoomMemberLaunchState, CanonicalRoomMemberPlanBinding,
} from './types.js';

export const roomsDir = () => join(stateRoot(), 'rooms');

function roomPath(id: string): string { return join(roomsDir(), `${id}.json`); }
export function roomStateLockPath(id: string): string {
  return join(stateRoot(), 'locks', 'room-state', encodeURIComponent(id));
}
function mutateRoom(id: string, mutation: (room: ReceiptRoom) => void): RoomOrchestrationRecord {
  return withFileLockSync(roomStateLockPath(id), () => {
    const room = readRoom(id) as ReceiptRoom;
    mutation(room); writeRoom(room); return room;
  });
}

export class RoomStateError extends Error {}
export interface RoomEffectReceipt {
  version: 1; keyHash: string; principalHash: string; requestHash: string; operation: 'room.delete';
  resourceId: string; beforeDigest: string; afterDigest: string; disposition: 'accepted';
  result: { room: Pick<RoomOrchestrationRecord, 'room_id'|'room_name'|'state'> & {
      close: { phase: 'retire_members'; accepted_at: string } };
    settlementRequired: true }; acknowledged?: boolean;
}
export interface RoomEffectContext extends Omit<RoomEffectReceipt,
  'version'|'resourceId'|'afterDigest'|'disposition'|'result'|'acknowledged'> {}
export interface RoomRecoveryCursor {
  kind: 'close'|'provision'|'none'; state: RoomOrchestrationState; phase: string;
  step_index: number; detail?: ProvisioningDetail; bindingsDigest: string;
}
export interface RoomRecoveryReceipt {
  version: 1; keyHash: string; principalHash: string; requestHash: string; operation: 'room.recover';
  resourceId: string; beforeDigest: string; afterDigest: string; disposition: 'accepted';
  cursor: RoomRecoveryCursor;
  workerStatus: 'pending'|'checkpointed';
  result: { kind: 'deletion_worker_required'|'provisioning_worker_required'|'recovered';
    room_id: string; cursor: RoomRecoveryCursor; settlementRequired: boolean };
  acknowledged?: boolean;
}
export interface RoomRecoveryContext extends Omit<RoomRecoveryReceipt,
  'version'|'resourceId'|'afterDigest'|'disposition'|'cursor'|'workerStatus'|'result'|'acknowledged'> {}
const RECEIPTS = Symbol('management-room-effect-receipts');
type StoredReceipt = RoomEffectReceipt | RoomRecoveryReceipt;
type ReceiptRoom = RoomOrchestrationRecord & { [RECEIPTS]?: StoredReceipt[] };
type StoredRoom = RoomOrchestrationRecord & { _management_receipts?: StoredReceipt[] };
const MAX_EFFECT_RECEIPTS = 16;
const ROOM_NAME_MAX_CODE_POINTS = 160;
const ROOM_NAME_MAX_BYTES = 640;
export interface RoomDeletionTombstone {
  version: 1; roomId: string; keyHash: string; principalHash: string; requestHash: string;
  cursorDigest: string; bindingsDigest: string; resultDigest: string;
  phase: 'local_delete_pending'|'deleted'; acknowledged?: true;
}
function tombstonePath(id: string, keyHash: string): string {
  return join(roomsDir(), `.deleted-${encodeURIComponent(id)}-${keyHash}.json`);
}
function syncRoomsDir(): void {
  const fd = openSync(roomsDir(), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readRoom(id: string): RoomOrchestrationRecord {
  const p = roomPath(id);
  if (!existsSync(p)) throw new RoomStateError(`room not found: ${id}`);
  const { _management_receipts: receipts, ...visible } = JSON.parse(readFileSync(p, 'utf8')) as StoredRoom;
  const room = visible as ReceiptRoom;
  if (receipts) Object.defineProperty(room, RECEIPTS, { value: receipts, writable: true, configurable: true });
  return room;
}

function writeRoom(record: RoomOrchestrationRecord): void {
  mkdirSync(roomsDir(), { recursive: true });
  const stored = { ...record } as StoredRoom; const receipts = (record as ReceiptRoom)[RECEIPTS];
  if (receipts?.length) stored._management_receipts = receipts;
  replaceFileAtomically(roomPath(record.room_id), JSON.stringify(stored, null, 2) + '\n');
}

const digest = (value: unknown): string => {
  const canonical = (child: unknown): string => Array.isArray(child) ? `[${child.map(canonical).join(',')}]`
    : child && typeof child === 'object' ? `{${Object.entries(child as Record<string, unknown>)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(child);
  return createHash('sha256').update(canonical(value)).digest('hex');
};

function getRoomEffectReceiptUnlocked(id: string, keyHash: string): RoomEffectReceipt | undefined {
  const receipts = (readRoom(id) as ReceiptRoom)[RECEIPTS];
  if (receipts === undefined) return undefined;
  if (!Array.isArray(receipts) || receipts.length > MAX_EFFECT_RECEIPTS)
    throw new RoomStateError('invalid room effect receipts');
  for (const receipt of receipts) validateStoredReceipt(id, receipt);
  const found = receipts.find(item => item.keyHash === keyHash);
  return found?.operation === 'room.delete' ? found : undefined;
}

export function getRoomEffectReceipt(id: string, keyHash: string): RoomEffectReceipt | undefined {
  return withFileLockSync(roomStateLockPath(id), () => getRoomEffectReceiptUnlocked(id, keyHash));
}

function validateRoomEffectReceipt(id: string, value: unknown): asserts value is RoomEffectReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RoomStateError('invalid room effect receipt');
  const receipt = value as RoomEffectReceipt;
  const hex = /^[a-f0-9]{64}$/u; const room = receipt?.result?.room;
  const acceptedAt = room?.close?.accepted_at;
  const canonicalTimestamp = typeof acceptedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(acceptedAt)
    && !Number.isNaN(new Date(acceptedAt).valueOf()) && new Date(acceptedAt).toISOString() === acceptedAt;
  if (receipt.version !== 1 || !hex.test(receipt.keyHash) || !hex.test(receipt.principalHash)
      || !hex.test(receipt.requestHash) || !hex.test(receipt.beforeDigest) || !hex.test(receipt.afterDigest)
      || receipt.operation !== 'room.delete' || receipt.resourceId !== id || receipt.disposition !== 'accepted'
      || (receipt.acknowledged !== undefined && receipt.acknowledged !== true)
      || Object.keys(receipt).some(key => !['version', 'keyHash', 'principalHash', 'requestHash',
        'operation', 'resourceId', 'beforeDigest', 'afterDigest', 'disposition', 'result',
        'acknowledged'].includes(key))
      || receipt.result?.settlementRequired !== true || !room
      || Object.keys(receipt.result).some(key => !['room', 'settlementRequired'].includes(key))
      || Object.keys(room).some(key => !['room_id', 'room_name', 'state', 'close'].includes(key))
      || room.room_id !== id || typeof room.room_name !== 'string' || !room.room_name.length
      || Array.from(room.room_name).length > ROOM_NAME_MAX_CODE_POINTS
      || Buffer.byteLength(room.room_name, 'utf8') > ROOM_NAME_MAX_BYTES || room.state !== 'closing'
      || !room.close || Object.keys(room.close).some(key => !['phase', 'accepted_at'].includes(key))
      || room.close.phase !== 'retire_members' || typeof room.close.accepted_at !== 'string'
      || !canonicalTimestamp
      || digest(receipt.result) !== receipt.afterDigest)
    throw new RoomStateError('invalid room effect receipt');
}

function validateStoredReceipt(id: string, value: unknown): asserts value is StoredReceipt {
  if (value && typeof value === 'object' && !Array.isArray(value)
      && (value as { operation?: unknown }).operation === 'room.recover') {
    validateRoomRecoveryReceipt(id, value); return;
  }
  validateRoomEffectReceipt(id, value);
}

function recoveryCursor(room: RoomOrchestrationRecord): RoomRecoveryCursor {
  const bindings = room.member_seats.map(seat => ({ role: seat.role_name, invite: seat.invite_id,
    inviteAttempt: seat.invite_attempt && { phase: seat.invite_attempt.phase,
      action: seat.invite_attempt.action_id, recoveryKey: seat.invite_attempt.recovery_key_hash,
      request: seat.invite_attempt.request_digest, room: seat.invite_attempt.room_id,
      role: seat.invite_attempt.role, mode: seat.invite_attempt.mode,
      minAccepts: seat.invite_attempt.min_accepts, updatedAt: seat.invite_attempt.updated_at },
    plan: seat.plan_binding && { agent: seat.plan_binding.agent_id, action: seat.plan_binding.action_id,
      generation: seat.plan_binding.generation },
    launch: seat.launch && { action: seat.launch.action_id, attempt: seat.launch.attempt,
      state: seat.launch.state } }));
  if (room.state === 'closing' || room.state === 'closed') return { kind: 'close', state: room.state,
    phase: room.close?.phase ?? 'completed', step_index: 0, bindingsDigest: digest(bindings) };
  if (room.state === 'provisioning') return { kind: 'provision', state: room.state,
    phase: room.saga.phase, step_index: room.saga.step_index,
    ...(room.provisioning_detail ? { detail: room.provisioning_detail } : {}),
    bindingsDigest: digest(bindings) };
  return { kind: 'none', state: room.state, phase: room.saga.phase,
    step_index: room.saga.step_index, bindingsDigest: digest(bindings) };
}

export function roomRecoveryDetail(id: string): { room_id: string; cursor: RoomRecoveryCursor } {
  const room = getRoomRecord(id); if (!room) throw new RoomStateError(`room not found: ${id}`);
  return { room_id: id, cursor: recoveryCursor(room) };
}

export function beginRoomRecovery(id: string, effect: RoomRecoveryContext): RoomRecoveryReceipt {
  let published!: RoomRecoveryReceipt;
  mutateRoom(id, room => {
    const before = { room_id: id, cursor: recoveryCursor(room) };
    if (digest(before) !== effect.beforeDigest) throw new RoomStateError('room recovery state changed');
    const prior = (room[RECEIPTS] ?? []).filter(item => !item.acknowledged);
    if (!prior.some(item => item.keyHash === effect.keyHash) && prior.length >= MAX_EFFECT_RECEIPTS)
      throw new RoomStateError('room effect receipt capacity reached');
    const cursor = before.cursor;
    const result: RoomRecoveryReceipt['result'] = { kind: cursor.kind === 'close'
      ? 'deletion_worker_required' : cursor.kind === 'provision'
        ? 'provisioning_worker_required' : 'recovered', room_id: id, cursor,
      settlementRequired: cursor.kind !== 'none' };
    published = { version: 1, ...effect, resourceId: id, cursor,
      workerStatus: cursor.kind === 'none' ? 'checkpointed' : 'pending',
      afterDigest: digest(result), disposition: 'accepted', result };
    Object.defineProperty(room, RECEIPTS, { value: [...prior.filter(item => item.keyHash !== effect.keyHash), published],
      writable: true, configurable: true });
  });
  return published;
}

function validateRoomRecoveryReceipt(id: string, value: unknown): asserts value is RoomRecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomStateError('invalid room recovery receipt');
  const receipt = value as RoomRecoveryReceipt; const hex = /^[a-f0-9]{64}$/u; const cursor = receipt.cursor;
  const receiptKeys = ['version', 'keyHash', 'principalHash', 'requestHash', 'operation', 'resourceId',
    'beforeDigest', 'afterDigest', 'disposition', 'cursor', 'workerStatus', 'result', 'acknowledged'];
  const cursorKeys = ['kind', 'state', 'phase', 'step_index', 'detail', 'bindingsDigest'];
  const details = ['waiting_cowork', 'waiting_owner_invite', 'owner_cid_mismatch', 'member_failed',
    'waiting_seats', 'uncertain'];
  if (Object.keys(receipt).some(key => !receiptKeys.includes(key))
      || receipt.version !== 1 || receipt.operation !== 'room.recover' || receipt.resourceId !== id
      || receipt.disposition !== 'accepted' || !hex.test(receipt.keyHash) || !hex.test(receipt.principalHash)
      || !hex.test(receipt.requestHash) || !hex.test(receipt.beforeDigest) || !hex.test(receipt.afterDigest)
      || (receipt.acknowledged !== undefined && receipt.acknowledged !== true) || !cursor
      || typeof cursor !== 'object' || Array.isArray(cursor)
      || Object.keys(cursor).some(key => !cursorKeys.includes(key))
      || !['pending', 'checkpointed'].includes(receipt.workerStatus)
      || (cursor.kind === 'none' && receipt.workerStatus !== 'checkpointed')
      || !['close', 'provision', 'none'].includes(cursor.kind)
      || !['provisioning', 'active', 'closing', 'closed'].includes(cursor.state)
      || (cursor.kind === 'close' && !['closing', 'closed'].includes(cursor.state))
      || (cursor.kind === 'provision' && cursor.state !== 'provisioning')
      || (cursor.kind === 'none' && cursor.state !== 'active')
      || typeof cursor.phase !== 'string' || cursor.phase.length < 1 || cursor.phase.length > 64
      || !Number.isSafeInteger(cursor.step_index)
      || cursor.step_index < 0 || !hex.test(cursor.bindingsDigest) || receipt.result?.room_id !== id
      || (cursor.detail !== undefined && (cursor.kind !== 'provision' || !details.includes(cursor.detail)))
      || !receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)
      || Object.keys(receipt.result).some(key => !['kind', 'room_id', 'cursor', 'settlementRequired'].includes(key))
      || digest(receipt.result.cursor) !== digest(cursor)
      || receipt.result.settlementRequired !== (cursor.kind !== 'none')
      || receipt.result.kind !== (cursor.kind === 'close' ? 'deletion_worker_required'
        : cursor.kind === 'provision' ? 'provisioning_worker_required' : 'recovered')
      || digest(receipt.result) !== receipt.afterDigest) throw new RoomStateError('invalid room recovery receipt');
}

export function getRoomRecoveryReceipt(id: string, keyHash: string): RoomRecoveryReceipt | undefined {
  return withFileLockSync(roomStateLockPath(id), () => {
    const receipts = (readRoom(id) as ReceiptRoom)[RECEIPTS];
    if (!receipts) return undefined;
    if (!Array.isArray(receipts) || receipts.length > MAX_EFFECT_RECEIPTS) throw new RoomStateError('invalid room effect receipts');
    for (const receipt of receipts) validateStoredReceipt(id, receipt);
    const found = receipts.find(item => item.keyHash === keyHash);
    return found?.operation === 'room.recover' ? found : undefined;
  });
}

export function acknowledgeCheckpointedRoomRecovery(id: string, keyHash: string): void {
  withFileLockSync(roomStateLockPath(id), () => {
    const receipt = getRoomEffectReceiptUnlocked(id, keyHash);
    if (receipt) return;
    const receipts = (readRoom(id) as ReceiptRoom)[RECEIPTS] ?? [];
    for (const item of receipts) validateStoredReceipt(id, item);
    const recovery = receipts.find(item => item.keyHash === keyHash);
    if (recovery?.operation === 'room.recover' && recovery.workerStatus === 'checkpointed')
      acknowledgeRoomEffectReceiptUnlocked(id, keyHash);
  });
}

export function checkpointRoomRecovery(id: string, keyHash: string, expected: {
  principalHash: string; requestHash: string; kind: 'provision';
}): void {
  withFileLockSync(roomStateLockPath(id), () => {
    const room = readRoom(id) as ReceiptRoom; const receipts = room[RECEIPTS] ?? [];
    if (!Array.isArray(receipts) || receipts.length > MAX_EFFECT_RECEIPTS)
      throw new RoomStateError('invalid room effect receipts');
    for (const receipt of receipts) validateStoredReceipt(id, receipt);
    const index = receipts.findIndex(item => item.keyHash === keyHash);
    const receipt = receipts[index];
    if (receipt?.operation !== 'room.recover' || receipt.workerStatus !== 'pending'
        || receipt.cursor.kind !== expected.kind || receipt.principalHash !== expected.principalHash
        || receipt.requestHash !== expected.requestHash)
      throw new RoomStateError('room recovery worker is unavailable');
    const next = [...receipts]; next[index] = { ...receipt, workerStatus: 'checkpointed' };
    Object.defineProperty(room, RECEIPTS, { value: next, writable: true, configurable: true }); writeRoom(room);
  });
}

function validateDeletionTombstone(value: unknown, id: string, keyHash: string): RoomDeletionTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomStateError('invalid room deletion tombstone');
  const item = value as RoomDeletionTombstone; const hex = /^[a-f0-9]{64}$/u;
  if (Object.keys(item).some(key => !['version', 'roomId', 'keyHash', 'principalHash', 'requestHash',
    'cursorDigest', 'bindingsDigest', 'resultDigest', 'phase', 'acknowledged'].includes(key))
      || item.version !== 1 || item.roomId !== id || item.keyHash !== keyHash
      || !hex.test(item.keyHash) || !hex.test(item.principalHash) || !hex.test(item.requestHash)
      || !hex.test(item.cursorDigest) || !hex.test(item.bindingsDigest) || !hex.test(item.resultDigest)
      || !['local_delete_pending', 'deleted'].includes(item.phase)
      || (item.phase === 'local_delete_pending' && item.acknowledged !== undefined)
      || (item.phase === 'deleted' && item.acknowledged !== true))
    throw new RoomStateError('invalid room deletion tombstone');
  return item;
}

export function getAuthenticatedRoomDeletionTombstone(id: string, keyHash: string, expected: {
  principalHash: string; requestHash: string;
}): RoomDeletionTombstone | undefined {
  return withFileLockSync(roomStateLockPath(id), () => {
    const path = tombstonePath(id, keyHash); if (!existsSync(path)) return undefined;
    const tombstone = validateDeletionTombstone(JSON.parse(readFileSync(path, 'utf8')), id, keyHash);
    if (tombstone.principalHash !== expected.principalHash || tombstone.requestHash !== expected.requestHash)
      throw new RoomStateError('room deletion evidence conflicts');
    return tombstone;
  });
}

export function publishRoomDeletionTombstoneAndUnlink(id: string, keyHash: string, hooks: {
  afterTombstonePublication?(): void; afterRoomUnlink?(): void; afterDirectorySync?(): void;
} = {}): RoomDeletionTombstone {
  return withFileLockSync(roomStateLockPath(id), () => {
    const path = tombstonePath(id, keyHash);
    const existing = existsSync(path)
      ? validateDeletionTombstone(JSON.parse(readFileSync(path, 'utf8')), id, keyHash) : undefined;
    const room = getRoomRecord(id) as ReceiptRoom | undefined;
    let tombstone = existing;
    if (!tombstone) {
      if (!room) throw new RoomStateError(`room not found: ${id}`);
      const receipts = room[RECEIPTS] ?? [];
      for (const receipt of receipts) validateStoredReceipt(id, receipt);
      const receipt = receipts.find(item => item.keyHash === keyHash);
      if (receipt?.operation !== 'room.recover' || receipt.cursor.kind !== 'close'
          || receipt.workerStatus !== 'pending') throw new RoomStateError('room recovery worker is unavailable');
      tombstone = { version: 1, roomId: id, keyHash, principalHash: receipt.principalHash,
        requestHash: receipt.requestHash, cursorDigest: digest(receipt.cursor),
        bindingsDigest: receipt.cursor.bindingsDigest, resultDigest: receipt.afterDigest,
        phase: 'local_delete_pending' };
      replaceFileAtomically(path, JSON.stringify(tombstone, null, 2) + '\n');
      hooks.afterTombstonePublication?.();
    } else if (room) {
      const receipt = (room[RECEIPTS] ?? []).find(item => item.keyHash === keyHash);
      if (receipt?.operation !== 'room.recover' || digest(receipt.cursor) !== tombstone.cursorDigest
          || receipt.principalHash !== tombstone.principalHash || receipt.requestHash !== tombstone.requestHash
          || receipt.afterDigest !== tombstone.resultDigest) throw new RoomStateError('room deletion evidence conflicts');
    }
    if (room) { rmSync(roomPath(id)); hooks.afterRoomUnlink?.(); }
    syncRoomsDir(); hooks.afterDirectorySync?.(); return tombstone;
  });
}

export function completeRoomDeletionTombstone(id: string, keyHash: string): RoomDeletionTombstone {
  return withFileLockSync(roomStateLockPath(id), () => {
    if (existsSync(roomPath(id))) throw new RoomStateError('room deletion is not locally complete');
    const path = tombstonePath(id, keyHash);
    const current = validateDeletionTombstone(JSON.parse(readFileSync(path, 'utf8')), id, keyHash);
    const completed: RoomDeletionTombstone = { ...current, phase: 'deleted', acknowledged: true };
    replaceFileAtomically(path, JSON.stringify(completed, null, 2) + '\n'); return completed;
  });
}

export function gcAcknowledgedRoomDeletionTombstone(id: string, keyHash: string): boolean {
  return withFileLockSync(roomStateLockPath(id), () => {
    const path = tombstonePath(id, keyHash); if (!existsSync(path)) return false;
    const current = validateDeletionTombstone(JSON.parse(readFileSync(path, 'utf8')), id, keyHash);
    if (current.phase !== 'deleted' || current.acknowledged !== true) return false;
    rmSync(path); syncRoomsDir(); return true;
  });
}

function acknowledgeRoomEffectReceiptUnlocked(id: string, keyHash: string): void {
  const room = readRoom(id) as ReceiptRoom; const receipts = room[RECEIPTS] ?? [];
  if (!Array.isArray(receipts) || receipts.length > MAX_EFFECT_RECEIPTS)
    throw new RoomStateError('invalid room effect receipts');
  for (const receipt of receipts) validateStoredReceipt(id, receipt);
  const index = receipts.findIndex(item => item.keyHash === keyHash);
  if (index < 0 || receipts[index]!.acknowledged) return;
  const next = [...receipts]; next[index] = { ...next[index]!, acknowledged: true };
  Object.defineProperty(room, RECEIPTS, { value: next, writable: true, configurable: true }); writeRoom(room);
}

export function acknowledgeRoomEffectReceipt(id: string, keyHash: string): void {
  withFileLockSync(roomStateLockPath(id), () => acknowledgeRoomEffectReceiptUnlocked(id, keyHash));
}

export interface CreateRoomInput {
  room_id: string;
  room_name: string;
  goal?: string;
  room_identity_cid?: string;
  task_id?: string;
  template_snapshot?: import('./types.js').TemplateSnapshot;
}

export function createRoomRecord(input: CreateRoomInput): RoomOrchestrationRecord {
  return withFileLockSync(roomStateLockPath(input.room_id), () => {
    const existing = getRoomRecord(input.room_id);
    if (existing) return existing;
    const record: RoomOrchestrationRecord = {
      room_id: input.room_id, room_name: input.room_name, goal: input.goal,
      room_identity_cid: input.room_identity_cid, task_id: input.task_id,
      template_snapshot: input.template_snapshot,
      saga: { phase: 'persist_intent', step_index: 0 }, member_seats: [], state: 'provisioning',
      created_at: new Date().toISOString(),
    };
    writeRoom(record); return record;
  });
}

export function getRoomRecord(id: string): RoomOrchestrationRecord | undefined {
  try { return readRoom(id); } catch { return undefined; }
}

/** Remove a terminal orchestration record from the live room inventory. */
export function deleteRoomRecord(id: string): void {
  withFileLockSync(roomStateLockPath(id), () => {
    const path = roomPath(id); if (existsSync(path)) rmSync(path);
  });
}

export function listRoomRecords(filter?: {
  state?: RoomOrchestrationState | RoomOrchestrationState[];
}): RoomOrchestrationRecord[] {
  const dir = roomsDir();
  if (!existsSync(dir)) return [];
  const states = filter?.state
    ? (Array.isArray(filter.state) ? filter.state : [filter.state])
    : undefined;
  const rooms: RoomOrchestrationRecord[] = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const r = readRoom(f.slice(0, -5));
      if (!states || states.includes(r.state)) rooms.push(r);
    } catch { /* skip corrupt */ }
  }
  return rooms.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function advanceSaga(
  id: string,
  phase: SagaPhase,
  stepIndex?: number,
  detail?: ProvisioningDetail,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    r.saga = { phase, step_index: stepIndex ?? 0 };
    if (detail) r.provisioning_detail = detail; else delete r.provisioning_detail;
  });
}

export function setSagaError(
  id: string,
  error: string,
  hint?: string,
  detail?: ProvisioningDetail,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    r.saga.error = error; r.saga.recovery_hint = hint;
    if (detail) r.provisioning_detail = detail;
  });
}

export function setRoomIdentity(
  id: string,
  roomIdentityCid: string,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => { r.room_identity_cid = roomIdentityCid; });
}

export function setOwnerSeat(
  id: string,
  ownerSeatCid: string,
  inviteFingerprint: string,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    r.owner_seat_cid = ownerSeatCid; r.owner_invite_fingerprint = inviteFingerprint;
  });
}

export function updateMemberSeats(
  id: string,
  seats: RoomMemberSeat[],
): RoomOrchestrationRecord {
  return mutateRoom(id, r => { r.member_seats = seats; });
}

export function updateRoomRoleBriefing(
  id: string,
  role: string,
  definition: RoomRoleBriefingDefinition,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    r.role_briefings = { ...(r.role_briefings ?? {}), [role]: definition };
  });
}

export function updateRoomHistoryCursor(id: string, cursor: number): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    if (!Number.isSafeInteger(cursor) || cursor < (r.history_cursor ?? 0))
      throw new RoomStateError(`room ${id} history cursor cannot move backward`);
    r.history_cursor = cursor;
  });
}

const LAUNCH_ORDER: readonly RoomMemberLaunchState['state'][] = [
  'pending', 'intent', 'launched', 'stopped', 'failed',
];

export function updateMemberStartup(
  id: string,
  roleName: string,
  update: { launch?: RoomMemberLaunchState },
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    const seat = r.member_seats.find(candidate => candidate.role_name === roleName);
    if (!seat) throw new RoomStateError(`room ${id} has no recorded member ${roleName}`);
    if (update.launch && seat.launch
      && LAUNCH_ORDER.indexOf(update.launch.state) < LAUNCH_ORDER.indexOf(seat.launch.state)
      && !(seat.launch.state === 'stopped' && update.launch.state === 'intent')
      && !(seat.launch.state === 'failed' && update.launch.state === 'intent')) {
      throw new RoomStateError(
        `room ${id} member ${roleName} launch cannot move backward to ${update.launch.state}`,
      );
    }
    if (update.launch) seat.launch = update.launch;
  });
}

const PLAN_BINDING_FIELDS = [
  'kind', 'agent_id', 'generation', 'action_id', 'plan_digest', 'snapshot_digest',
  'brain_digest', 'role_id', 'reservation_digest', 'handoff_digest',
  'authorization_revision', 'identity_ownership',
] as const;

const samePlanBinding = (
  left: CanonicalRoomMemberPlanBinding, right: CanonicalRoomMemberPlanBinding,
): boolean => PLAN_BINDING_FIELDS.every(field => left[field] === right[field]);

export async function bindCanonicalMemberPlan(
  id: string, roleName: string, binding: CanonicalRoomMemberPlanBinding,
): Promise<RoomOrchestrationRecord> {
  return mutateRoom(id, r => {
    if (r.state !== 'provisioning')
      throw new RoomStateError(`room ${id} cannot bind a member plan while ${r.state}`);
    const seat = r.member_seats.find(candidate => candidate.role_name === roleName);
    if (!seat) throw new RoomStateError(`room ${id} has no recorded member ${roleName}`);
    if (seat.plan_binding) {
      if (!samePlanBinding(seat.plan_binding, binding))
        throw new RoomStateError(`room ${id} member ${roleName} plan binding conflicts`);
      return;
    }
    if (seat.launch && (seat.launch.state !== 'pending' || seat.launch.attempt !== 0))
      throw new RoomStateError(`room ${id} member ${roleName} cannot bind a plan after launch intent`);
    seat.plan_binding = structuredClone(binding);
  });
}

export function activateRoom(id: string): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    r.state = 'active'; r.saga = { phase: 'completed', step_index: 0 };
    delete r.provisioning_detail; r.activated_at = new Date().toISOString();
  });
}

export function closeRoom(id: string): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    if (r.state === 'closed') return;
    r.state = 'closed'; r.closed_at = new Date().toISOString();
    r.close = { phase: 'completed', accepted_at: r.close?.accepted_at ?? r.closed_at,
      ...(r.close?.first_failure ? { first_failure: r.close.first_failure } : {}),
      ...(r.close?.first_recovery_hint ? { first_recovery_hint: r.close.first_recovery_hint } : {}) };
  });
}

export function beginRoomClose(id: string, effect?: RoomEffectContext): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    if (r.state === 'closed') return;
    const acceptedAt = r.close?.accepted_at ?? new Date().toISOString();
    r.state = 'closing'; r.close = {
    phase: r.close?.phase ?? 'retire_members',
    accepted_at: acceptedAt,
    ...(r.close?.error ? { error: r.close.error } : {}),
    ...(r.close?.error_at ? { error_at: r.close.error_at } : {}),
    ...(r.close?.recovery_hint ? { recovery_hint: r.close.recovery_hint } : {}),
    ...(r.close?.first_failure ? { first_failure: r.close.first_failure } : {}),
    ...(r.close?.first_recovery_hint
      ? { first_recovery_hint: r.close.first_recovery_hint }
      : {}),
    };
    if (effect) {
      const prior = (r[RECEIPTS] ?? []).filter(item => !item.acknowledged);
      if (!prior.some(item => item.keyHash === effect.keyHash) && prior.length >= MAX_EFFECT_RECEIPTS)
        throw new RoomStateError('room effect receipt capacity reached');
      const result: RoomEffectReceipt['result'] = { room: { room_id: r.room_id, room_name: r.room_name,
        state: 'closing', close: { phase: 'retire_members', accepted_at: r.close!.accepted_at } },
        settlementRequired: true };
      const receipt: RoomEffectReceipt = { version: 1, ...effect, resourceId: id,
        afterDigest: digest(result), disposition: 'accepted', result };
      Object.defineProperty(r, RECEIPTS, { value: [...prior.filter(item => item.keyHash !== effect.keyHash), receipt],
        writable: true, configurable: true });
    }
  });
}

const RETIREMENT_ORDER: readonly MemberRetirementPhase[] = [
  'stop_requested', 'liveness_absent', 'archive_secured', 'identity_absent',
];

export function advanceMemberRetirement(
  id: string,
  roleName: string,
  phase: MemberRetirementPhase,
  launchId: string,
  archivePath?: string,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    if (r.state !== 'closing') throw new RoomStateError(`room ${id} is not closing`);
    const seat = r.member_seats.find(candidate => candidate.role_name === roleName);
    if (!seat) throw new RoomStateError(`room ${id} has no recorded member ${roleName}`);
    const previous = seat.retirement;
    if (previous && previous.launch_id !== launchId) throw new RoomStateError(
      `room ${id} member ${roleName} launch changed from ${previous.launch_id} to ${launchId}`);
    const nextIndex = RETIREMENT_ORDER.indexOf(phase);
    const previousIndex = previous ? RETIREMENT_ORDER.indexOf(previous.phase) : -1;
    if (nextIndex < previousIndex) throw new RoomStateError(
      `room ${id} member ${roleName} retirement cannot move backward to ${phase}`);
    seat.retirement = { phase, launch_id: launchId, updated_at: new Date().toISOString(),
      ...(archivePath ?? previous?.archive_path
        ? { archive_path: archivePath ?? previous?.archive_path } : {}) };
    if (phase === 'identity_absent') seat.seat_state = 'removed';
  });
}

export function advanceRoomClose(id: string, phase: RoomClosePhase): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    if (r.state === 'closed') return;
    if (r.state !== 'closing' || !r.close) throw new RoomStateError(`room ${id} is not closing`);
    const order: readonly RoomClosePhase[] = ['retire_members', 'close_cowork', 'completed'];
    if (order.indexOf(phase) < order.indexOf(r.close.phase))
      throw new RoomStateError(`room ${id} close cannot move backward to ${phase}`);
    const progressed = order.indexOf(phase) > order.indexOf(r.close.phase);
    r.close = {
    phase,
    accepted_at: r.close.accepted_at,
    ...(!progressed && r.close.error ? { error: r.close.error } : {}),
    ...(!progressed && r.close.error_at ? { error_at: r.close.error_at } : {}),
    ...(!progressed && r.close.recovery_hint
      ? { recovery_hint: r.close.recovery_hint }
      : {}),
    ...(r.close.first_failure ? { first_failure: r.close.first_failure } : {}),
    ...(r.close.first_recovery_hint
      ? { first_recovery_hint: r.close.first_recovery_hint }
      : {}),
    };
  });
}

export function setRoomCloseError(
  id: string, error: string, recoveryHint: string,
): RoomOrchestrationRecord {
  return mutateRoom(id, r => {
    if ((r.state !== 'closing' && r.state !== 'closed') || !r.close)
      throw new RoomStateError(`room ${id} is not closing or awaiting deletion`);
    r.close.first_failure ??= error; r.close.first_recovery_hint ??= recoveryHint;
    r.close.error = error;
    const previousErrorAt = Date.parse(r.close.error_at ?? '');
    r.close.error_at = new Date(Math.max(
      Date.now(), Number.isFinite(previousErrorAt) ? previousErrorAt + 1 : 0,
    )).toISOString();
    r.close.recovery_hint = recoveryHint;
  });
}
