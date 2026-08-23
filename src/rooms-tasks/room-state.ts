import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  RoomOrchestrationRecord, RoomOrchestrationState, SagaCursor, SagaPhase,
  RoomMemberSeat, ProvisioningDetail,
} from './types.js';

export const roomsDir = () => join(stateRoot(), 'rooms');

function roomPath(id: string): string { return join(roomsDir(), `${id}.json`); }

export class RoomStateError extends Error {}

function readRoom(id: string): RoomOrchestrationRecord {
  const p = roomPath(id);
  if (!existsSync(p)) throw new RoomStateError(`room not found: ${id}`);
  return JSON.parse(readFileSync(p, 'utf8')) as RoomOrchestrationRecord;
}

function writeRoom(record: RoomOrchestrationRecord): void {
  mkdirSync(roomsDir(), { recursive: true });
  replaceFileAtomically(roomPath(record.room_id), JSON.stringify(record, null, 2) + '\n');
}

export interface CreateRoomInput {
  room_id: string;
  room_name: string;
  room_identity_cid?: string;
  task_id?: string;
  template_snapshot?: import('./types.js').TemplateSnapshot;
}

export function createRoomRecord(input: CreateRoomInput): RoomOrchestrationRecord {
  const existing = getRoomRecord(input.room_id);
  if (existing) return existing;

  const record: RoomOrchestrationRecord = {
    room_id: input.room_id,
    room_name: input.room_name,
    room_identity_cid: input.room_identity_cid,
    task_id: input.task_id,
    template_snapshot: input.template_snapshot,
    saga: { phase: 'persist_intent', step_index: 0 },
    member_seats: [],
    state: 'provisioning',
    created_at: new Date().toISOString(),
  };
  writeRoom(record);
  return record;
}

export function getRoomRecord(id: string): RoomOrchestrationRecord | undefined {
  try { return readRoom(id); } catch { return undefined; }
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
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RoomOrchestrationRecord;
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
  const r = readRoom(id);
  r.saga = { phase, step_index: stepIndex ?? 0 };
  if (detail) r.provisioning_detail = detail;
  else delete r.provisioning_detail;
  writeRoom(r);
  return r;
}

export function setSagaError(
  id: string,
  error: string,
  hint?: string,
  detail?: ProvisioningDetail,
): RoomOrchestrationRecord {
  const r = readRoom(id);
  r.saga.error = error;
  r.saga.recovery_hint = hint;
  if (detail) r.provisioning_detail = detail;
  writeRoom(r);
  return r;
}

export function setRoomIdentity(
  id: string,
  roomIdentityCid: string,
): RoomOrchestrationRecord {
  const r = readRoom(id);
  r.room_identity_cid = roomIdentityCid;
  writeRoom(r);
  return r;
}

export function setOwnerSeat(
  id: string,
  ownerSeatCid: string,
  inviteFingerprint: string,
): RoomOrchestrationRecord {
  const r = readRoom(id);
  r.owner_seat_cid = ownerSeatCid;
  r.owner_invite_fingerprint = inviteFingerprint;
  writeRoom(r);
  return r;
}

export function updateMemberSeats(
  id: string,
  seats: RoomMemberSeat[],
): RoomOrchestrationRecord {
  const r = readRoom(id);
  r.member_seats = seats;
  writeRoom(r);
  return r;
}

export function activateRoom(id: string): RoomOrchestrationRecord {
  const r = readRoom(id);
  r.state = 'active';
  r.saga = { phase: 'completed', step_index: 0 };
  delete r.provisioning_detail;
  r.activated_at = new Date().toISOString();
  writeRoom(r);
  return r;
}

export function closeRoom(id: string): RoomOrchestrationRecord {
  const r = readRoom(id);
  if (r.state === 'closed') return r;
  r.state = 'closed';
  r.closed_at = new Date().toISOString();
  writeRoom(r);
  return r;
}
