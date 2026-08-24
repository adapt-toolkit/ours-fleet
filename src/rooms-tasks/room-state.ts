import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import type {
  RoomOrchestrationRecord, RoomOrchestrationState, SagaCursor, SagaPhase,
  RoomMemberSeat, ProvisioningDetail,
  MemberRetirementPhase, RoomClosePhase,
  RoomRoleBriefingDefinition, RoomMemberLaunchState, RoomMemberBriefingState,
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
  goal?: string;
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
    goal: input.goal,
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

/** Remove a terminal orchestration record from the live room inventory. */
export function deleteRoomRecord(id: string): void {
  const path = roomPath(id);
  if (existsSync(path)) rmSync(path);
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

export function updateRoomRoleBriefing(
  id: string,
  role: string,
  definition: RoomRoleBriefingDefinition,
): RoomOrchestrationRecord {
  const r = readRoom(id);
  r.role_briefings = { ...(r.role_briefings ?? {}), [role]: definition };
  writeRoom(r);
  return r;
}

export function updateRoomHistoryCursor(id: string, cursor: number): RoomOrchestrationRecord {
  const r = readRoom(id);
  if (!Number.isSafeInteger(cursor) || cursor < (r.history_cursor ?? 0))
    throw new RoomStateError(`room ${id} history cursor cannot move backward`);
  r.history_cursor = cursor;
  writeRoom(r);
  return r;
}

const LAUNCH_ORDER: readonly RoomMemberLaunchState['state'][] = [
  'pending', 'intent', 'launched', 'stopped', 'failed',
];

const BRIEFING_ORDER: readonly RoomMemberBriefingState['state'][] = [
  'pending', 'relay_queued', 'relay_failed', 'acknowledged',
];

export function updateMemberStartup(
  id: string,
  roleName: string,
  update: {
    launch?: RoomMemberLaunchState;
    briefing?: RoomMemberBriefingState;
  },
): RoomOrchestrationRecord {
  const r = readRoom(id);
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
  if (update.briefing && seat.briefing
      && BRIEFING_ORDER.indexOf(update.briefing.state) < BRIEFING_ORDER.indexOf(seat.briefing.state)) {
    throw new RoomStateError(
      `room ${id} member ${roleName} briefing cannot move backward to ${update.briefing.state}`,
    );
  }
  if (update.launch) seat.launch = update.launch;
  if (update.briefing) seat.briefing = update.briefing;
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
  r.close = {
    phase: 'completed',
    accepted_at: r.close?.accepted_at ?? r.closed_at,
    ...(r.close?.first_failure ? { first_failure: r.close.first_failure } : {}),
    ...(r.close?.first_recovery_hint
      ? { first_recovery_hint: r.close.first_recovery_hint }
      : {}),
  };
  writeRoom(r);
  return r;
}

export function beginRoomClose(id: string): RoomOrchestrationRecord {
  const r = readRoom(id);
  if (r.state === 'closed') return r;
  const acceptedAt = r.close?.accepted_at ?? new Date().toISOString();
  r.state = 'closing';
  r.close = {
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
  writeRoom(r);
  return r;
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
  const r = readRoom(id);
  if (r.state !== 'closing') throw new RoomStateError(`room ${id} is not closing`);
  const seat = r.member_seats.find(candidate => candidate.role_name === roleName);
  if (!seat) throw new RoomStateError(`room ${id} has no recorded member ${roleName}`);
  const previous = seat.retirement;
  if (previous && previous.launch_id !== launchId) {
    throw new RoomStateError(
      `room ${id} member ${roleName} launch changed from ${previous.launch_id} to ${launchId}`,
    );
  }
  const nextIndex = RETIREMENT_ORDER.indexOf(phase);
  const previousIndex = previous ? RETIREMENT_ORDER.indexOf(previous.phase) : -1;
  if (nextIndex < previousIndex) {
    throw new RoomStateError(
      `room ${id} member ${roleName} retirement cannot move backward to ${phase}`,
    );
  }
  seat.retirement = {
    phase,
    launch_id: launchId,
    updated_at: new Date().toISOString(),
    ...(archivePath ?? previous?.archive_path
      ? { archive_path: archivePath ?? previous?.archive_path }
      : {}),
  };
  if (phase === 'identity_absent') seat.seat_state = 'removed';
  writeRoom(r);
  return r;
}

export function advanceRoomClose(id: string, phase: RoomClosePhase): RoomOrchestrationRecord {
  const r = readRoom(id);
  if (r.state === 'closed') return r;
  if (r.state !== 'closing' || !r.close) throw new RoomStateError(`room ${id} is not closing`);
  const order: readonly RoomClosePhase[] = ['retire_members', 'close_cowork', 'completed'];
  if (order.indexOf(phase) < order.indexOf(r.close.phase)) {
    throw new RoomStateError(`room ${id} close cannot move backward to ${phase}`);
  }
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
  writeRoom(r);
  return r;
}

export function setRoomCloseError(
  id: string, error: string, recoveryHint: string,
): RoomOrchestrationRecord {
  const r = readRoom(id);
  if ((r.state !== 'closing' && r.state !== 'closed') || !r.close)
    throw new RoomStateError(`room ${id} is not closing or awaiting deletion`);
  r.close.first_failure ??= error;
  r.close.first_recovery_hint ??= recoveryHint;
  r.close.error = error;
  const previousErrorAt = Date.parse(r.close.error_at ?? '');
  r.close.error_at = new Date(Math.max(
    Date.now(), Number.isFinite(previousErrorAt) ? previousErrorAt + 1 : 0,
  )).toISOString();
  r.close.recovery_hint = recoveryHint;
  writeRoom(r);
  return r;
}
