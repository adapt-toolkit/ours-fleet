import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse } from 'yaml';
import {
  attachOursClient, type OursClient,
} from '@ours.network/sdk/client';
import type { CoworkAdapter } from './cowork-adapter.js';
import {
  advanceSaga, setSagaError, updateMemberSeats, updateMemberStartup,
  updateRoomRoleBriefing, activateRoom, getRoomRecord,
} from './room-state.js';
import {
  activateTask, updateTaskMembers, failTask, blockTask,
} from './task-state.js';
import type {
  RoomOrchestrationRecord, RoomMemberSeat, TaskMemberRole,
  TemplateSnapshot, TemplateMemberSlot, RoomHistoryEvidence,
} from './types.js';
import { spawnTemp } from '../spawn.js';
import { findRole, type FleetConfig, type RoomStartupGate } from '../config.js';
import { closeManagedRoom } from './close.js';
import {
  buildRoomMemberCharter, reconcileBriefingHistory, sha256Text,
} from './member-startup.js';
import { agentDir } from '../paths.js';
import { readProvenance } from '../creation.js';
import {
  readTempSupervisor, secureStoppedTempArchive, tempSupervisorLiveness,
} from '../temp-lifecycle.js';

export function getBinPath(): string {
  try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; }
}

export interface ProvisionMembersInput {
  cfg: FleetConfig;
  cowork: CoworkAdapter;
  roomId: string;
  taskId?: string;
  template: TemplateSnapshot;
  binPath: string;
  brief?: string;
  goal?: string;
  startupWait?: Partial<StartupWaitPolicy>;
}

export interface StartupWaitPolicy {
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

interface ExpandedMember {
  name: string;
  slot: string;
  coworkRole: string;
  roleRef: string;
  cid: string;
  overrides?: TemplateMemberSlot['overrides'];
}

interface MemberSettings {
  model?: string;
  harness?: string;
  cwd?: string;
  persona?: string;
}

function shortId(id: string): string { return id.slice(0, 8); }

function expandMembers(
  template: TemplateSnapshot,
  prefix: string,
): Omit<ExpandedMember, 'cid'>[] {
  const result: Omit<ExpandedMember, 'cid'>[] = [];
  for (const slot of template.members) {
    for (let i = 1; i <= slot.count; i++) {
      result.push({
        name: `${prefix}-${slot.slot}-${i}`,
        slot: slot.slot,
        coworkRole: slot.role,
        roleRef: slot.role_ref,
        overrides: slot.overrides,
      });
    }
  }
  return result;
}

async function createMemberIdentity(
  name: string,
  bio: string,
): Promise<{ cid: string; client: OursClient }> {
  const client = await attachOursClient({
    env: process.env,
    leaseToken: `ours-fleet-member-create-${process.pid}-${randomUUID()}`,
    clientPid: process.pid,
  });
  try {
    const result = await client.createIdentity({
      name,
      bio,
      exposeLocal: true,
      localAutoAccept: true,
    });
    return { cid: result.info.cid, client };
  } finally {
    await client.releaseLease();
  }
}

async function removeMemberIdentity(name: string): Promise<void> {
  try {
    const client = await attachOursClient({
      env: process.env,
      leaseToken: `ours-fleet-member-cleanup-${process.pid}-${randomUUID()}`,
      clientPid: process.pid,
    });
    try {
      await client.removeIdentity({ name });
    } finally {
      await client.releaseLease();
    }
  } catch { /* best-effort cleanup */ }
}

function settingsFor(member: ExpandedMember, cfg: FleetConfig): MemberSettings {
  let refRole;
  try { refRole = findRole(cfg, member.roleRef); } catch { /* no ref role */ }
  return {
    model: member.overrides?.model ?? refRole?.model,
    harness: member.overrides?.harness ?? refRole?.harness,
    cwd: member.overrides?.cwd ?? refRole?.cwd,
    persona: member.overrides?.persona ?? refRole?.persona,
  };
}

async function roomHistory(cowork: CoworkAdapter, roomId: string): Promise<RoomHistoryEvidence[]> {
  const records: RoomHistoryEvidence[] = [];
  let after = 0;
  for (let page = 0; page < 100; page++) {
    const next = await cowork.getHistory(roomId, { after, limit: 200 });
    if (next.length === 0) return records;
    records.push(...next);
    const cursor = Math.max(...next.map(record => record.seq));
    if (cursor <= after) throw new Error('Cowork room history cursor did not advance');
    after = cursor;
  }
  throw new Error('Cowork room history exceeded 100 bounded pages');
}

function startupMission(gate: RoomStartupGate): string {
  return [
    'Complete the dedicated room startup gate in briefing.md before readiness.',
    `Expected room ${gate.room_id} (${gate.room_identity_cid}), role ${gate.briefing_role},`,
    `briefing version ${gate.briefing_version}, sha256 ${gate.briefing_sha256}.`,
  ].join(' ');
}

function launchMatches(
  dir: string, member: ExpandedMember, actionId: string, missionSha: string,
  gate: RoomStartupGate,
): boolean {
  const provenance = readProvenance(dir);
  if (provenance?.creationActionId !== actionId || provenance.role !== member.name) return false;
  try {
    const role = parse(readFileSync(`${dir}/role.yaml`, 'utf8')) as {
      identity?: unknown; mission?: unknown; roomStartupGate?: unknown;
    };
    return role.identity === member.name
      && typeof role.mission === 'string'
      && sha256Text(role.mission) === missionSha
      && JSON.stringify(role.roomStartupGate) === JSON.stringify(gate);
  } catch { return false; }
}

async function ensureLaunch(input: {
  provision: ProvisionMembersInput;
  member: ExpandedMember;
  settings: MemberSettings;
  gate: RoomStartupGate;
}): Promise<void> {
  const { provision, member, settings, gate } = input;
  let seat = getRoomRecord(provision.roomId)!.member_seats
    .find(candidate => candidate.role_name === member.name)!;
  const mission = startupMission(gate);
  const missionSha = sha256Text(mission);
  const dir = agentDir(member.name, true);

  if ((seat.launch?.state === 'intent' || seat.launch?.state === 'launched') && existsSync(dir)) {
    if (!seat.launch.action_id || !launchMatches(
      dir, member, seat.launch.action_id, seat.launch.mission_sha256 ?? '', gate)) {
      throw new Error(`existing launch for ${member.name} does not match its durable intent`);
    }
    const supervisor = readTempSupervisor(dir);
    if (!supervisor) throw new Error(`existing launch for ${member.name} has no supervisor metadata`);
    const live = await tempSupervisorLiveness(dir);
    if (live === 'unknown') throw new Error(`existing launch for ${member.name} has unknown liveness`);
    if (live === 'running') {
      updateMemberStartup(provision.roomId, member.name, { launch: {
        ...seat.launch, state: 'launched', launch_id: supervisor.launchId,
        updated_at: new Date().toISOString(),
      } });
      return;
    }
    await secureStoppedTempArchive(member.name, supervisor.launchId);
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...seat.launch, state: 'stopped', launch_id: supervisor.launchId,
      updated_at: new Date().toISOString(),
    } });
    seat = getRoomRecord(provision.roomId)!.member_seats
      .find(candidate => candidate.role_name === member.name)!;
  } else if (seat.launch?.state === 'launched' && !existsSync(dir)) {
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...seat.launch, state: 'stopped', updated_at: new Date().toISOString(),
    } });
    seat = getRoomRecord(provision.roomId)!.member_seats
      .find(candidate => candidate.role_name === member.name)!;
  }

  const actionId = seat.launch?.state === 'intent' && seat.launch.action_id
    ? seat.launch.action_id : randomUUID();
  const attempt = seat.launch?.state === 'intent'
    ? seat.launch.attempt : (seat.launch?.attempt ?? 0) + 1;
  updateMemberStartup(provision.roomId, member.name, { launch: {
    state: 'intent', attempt, action_id: actionId, mission_sha256: missionSha,
    updated_at: new Date().toISOString(),
  } });
  const launchedDir = await spawnTemp({
    name: member.name, temp: true, identity: member.name, mission,
    model: settings.model, harness: settings.harness, cwd: settings.cwd,
    surface: 'agent', creationActionId: actionId, roomStartupGate: gate,
  }, provision.binPath);
  const supervisor = readTempSupervisor(launchedDir);
  if (!supervisor || !launchMatches(launchedDir, member, actionId, missionSha, gate)) {
    throw new Error(`new launch for ${member.name} did not persist matching provenance`);
  }
  updateMemberStartup(provision.roomId, member.name, { launch: {
    state: 'launched', attempt, action_id: actionId, mission_sha256: missionSha,
    launch_id: supervisor.launchId, updated_at: new Date().toISOString(),
  } });
}

export async function provisionMembers(
  input: ProvisionMembersInput,
): Promise<RoomOrchestrationRecord> {
  const { cfg, cowork, roomId, taskId, template, binPath } = input;
  const prefix = taskId ? shortId(taskId) : `room-${shortId(roomId)}`;
  const plan = expandMembers(template, prefix);
  const createdIdentities: string[] = [];
  const members: ExpandedMember[] = [];

  const existing = getRoomRecord(roomId);
  if (!existing?.room_identity_cid)
    throw new Error(`room ${roomId} has no pinned room identity CID`);
  const persistedSeats = existing?.member_seats ?? [];
  const resuming = plan.length > 0
    && plan.every(p => persistedSeats.some(s => s.role_name === p.name));

  let seats: RoomMemberSeat[];
  if (resuming) {
    for (const planned of plan) {
      const seat = persistedSeats.find(s => s.role_name === planned.name)!;
      members.push({ ...planned, cid: seat.identity_cid });
    }
    seats = persistedSeats.map(seat => ({
      ...seat,
      launch: seat.launch ?? {
        state: 'pending', attempt: 0, updated_at: existing.created_at,
      },
      briefing: seat.briefing ?? {
        role: seat.cowork_role, state: 'pending', rejected_ack_count: 0,
      },
    }));
    updateMemberSeats(roomId, seats);
  } else {
    // Phase 4: create_members
    advanceSaga(roomId, 'create_members', 3);
    try {
      for (const planned of plan) {
        const bio = `Fleet task member: ${planned.coworkRole} for ${taskId ?? roomId}`;
        const { cid } = await createMemberIdentity(planned.name, bio);
        createdIdentities.push(planned.name);
        members.push({ ...planned, cid });
      }
    } catch (error) {
      for (const name of createdIdentities) await removeMemberIdentity(name);
      setSagaError(
        roomId,
        error instanceof Error ? error.message : String(error),
        'Member identity creation failed. Retry with `task recover`.',
        'member_failed',
      );
      if (taskId) failTask(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    }

    seats = members.map(m => ({
      role_name: m.name,
      identity_cid: m.cid,
      slot: m.slot,
      cowork_role: m.coworkRole,
      seat_state: 'pending' as const,
      launch: { state: 'pending' as const, attempt: 0, updated_at: new Date().toISOString() },
      briefing: {
        role: m.coworkRole, state: 'pending' as const, rejected_ack_count: 0,
      },
    }));
    updateMemberSeats(roomId, seats);
    if (taskId) {
      const taskMembers: TaskMemberRole[] = members.map(m => ({
        name: m.name,
        identity_cid: m.cid,
        slot: m.slot,
        cowork_role: m.coworkRole,
      }));
      updateTaskMembers(taskId, taskMembers);
    }

  }

  const settings = new Map(members.map(member => [member.name, settingsFor(member, cfg)]));
  const roster = members.map(member => ({
    role_name: member.name, cowork_role: member.coworkRole, identity_cid: member.cid,
  }));
  const definitions = new Map<string, { text: string; sha256: string }>();
  for (const member of members) {
    const durable = getRoomRecord(roomId)!.role_briefings?.[member.coworkRole];
    const text = durable?.text ?? buildRoomMemberCharter({
        taskId, roomId, roomIdentityCid: existing.room_identity_cid,
        ownerSeatCid: existing.owner_seat_cid ?? null,
        goal: input.goal, brief: input.brief, contract: template.contract,
        member: { ...roster.find(role => role.role_name === member.name)!,
          persona: settings.get(member.name)?.persona },
        roster,
      });
    const sha256 = sha256Text(text);
    if (durable && durable.sha256 !== sha256)
      throw new Error(`persisted role briefing hash mismatch for ${member.coworkRole}`);
    const known = definitions.get(member.coworkRole);
    if (known && known.text !== text) {
      throw new Error(
        `members sharing Cowork role ${member.coworkRole} produced different briefing bytes`);
    }
    definitions.set(member.coworkRole, { text, sha256 });
  }

  advanceSaga(roomId, 'configure_briefings', 4);
  for (const [role, definition] of definitions) {
    const current = getRoomRecord(roomId)!.role_briefings?.[role];
    if (current?.state === 'configured' && current.text === definition.text
        && current.sha256 === definition.sha256 && current.version) continue;
    const attempt = (current?.attempts ?? 0) + 1;
    updateRoomRoleBriefing(roomId, role, {
      role, ...definition, state: 'pending', attempts: attempt,
      updated_at: new Date().toISOString(),
    });
    try {
      const configured = await cowork.setRoleBriefing(roomId, {
        role, text: definition.text,
      });
      if (configured.text !== definition.text)
        throw new Error(`Cowork returned different briefing bytes for role ${role}`);
      updateRoomRoleBriefing(roomId, role, {
        role, ...definition, version: configured.version, state: 'configured',
        attempts: attempt, updated_at: configured.updated_at,
      });
    } catch (error) {
      updateRoomRoleBriefing(roomId, role, {
        role, ...definition, state: 'failed', attempts: attempt,
        updated_at: new Date().toISOString(),
        last_error: error instanceof Error ? error.message : String(error),
      });
      setSagaError(roomId, error instanceof Error ? error.message : String(error),
        'Role briefing configuration failed. Retry task or room recover.', 'member_failed');
      throw error;
    }
  }

  advanceSaga(roomId, 'join_role_groups', 5);
  try {
    const admitted = new Set((await cowork.getSeats(roomId))
      .filter(seat => seat.seat_state !== 'removed').map(seat => seat.identity_cid));
    const roleGroups = new Map<string, ExpandedMember[]>();
    for (const member of members.filter(candidate => !admitted.has(candidate.cid))) {
      roleGroups.set(member.coworkRole, [
        ...(roleGroups.get(member.coworkRole) ?? []), member,
      ]);
    }
    for (const [coworkRole, group] of roleGroups) {
      const { invite } = await cowork.issueInvite(roomId, {
        role: coworkRole, min_accepts: group.length,
      });
      for (const member of group) {
        await cowork.acceptInvite(roomId, invite, {
          role: coworkRole, expected_cid: member.cid,
        });
      }
    }
  } catch (error) {
    for (const name of createdIdentities) await removeMemberIdentity(name);
    setSagaError(roomId, error instanceof Error ? error.message : String(error),
      'Role-group admission failed. Retry with `task recover`.', 'member_failed');
    if (taskId) failTask(taskId, error instanceof Error ? error.message : String(error));
    throw error;
  }

  advanceSaga(roomId, 'wait_seats', 6);
  const coworkSeats = await cowork.getSeats(roomId);
  const memberCids = new Set(members.map(m => m.cid));
  const allActive = [...memberCids].every(cid =>
    coworkSeats.some(s => s.identity_cid === cid && s.seat_state === 'active'),
  );
  if (!allActive) {
    advanceSaga(roomId, 'wait_seats', 6, 'waiting_seats');
    // Seats are pending — return record for caller to retry later
    return getRoomRecord(roomId)!;
  }
  const activeSeats: RoomMemberSeat[] = seats.map(s => ({ ...s, seat_state: 'active' as const }));
  updateMemberSeats(roomId, activeSeats);

  advanceSaga(roomId, 'launch_work', 7);
  try {
    for (const member of members) {
      const definition = getRoomRecord(roomId)!.role_briefings?.[member.coworkRole];
      if (!definition?.version) throw new Error(`role ${member.coworkRole} briefing is not configured`);
      await ensureLaunch({
        provision: input, member, settings: settings.get(member.name)!,
        gate: {
          room_id: roomId, room_identity_cid: existing.room_identity_cid,
          briefing_role: member.coworkRole, briefing_version: definition.version,
          briefing_sha256: definition.sha256,
          owner_seat_cid: existing.owner_seat_cid ?? null,
        },
      });
    }
  } catch (error) {
    setSagaError(
      roomId,
      error instanceof Error ? error.message : String(error),
      'Member launch failed. Some agents may be running. Retry with `task recover`.',
      'member_failed',
    );
    throw error;
  }

  const policy: StartupWaitPolicy = {
    timeoutMs: input.startupWait?.timeoutMs ?? 60_000,
    initialDelayMs: input.startupWait?.initialDelayMs ?? 250,
    maxDelayMs: input.startupWait?.maxDelayMs ?? 2_000,
    now: input.startupWait?.now ?? Date.now,
    sleep: input.startupWait?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };
  const deadline = policy.now() + policy.timeoutMs;
  let delay = policy.initialDelayMs;
  for (;;) {
    const history = await roomHistory(cowork, roomId);
    let allAcknowledged = true;
    let relayFailed = false;
    for (const member of members) {
      const definition = getRoomRecord(roomId)!.role_briefings![member.coworkRole];
      const result = reconcileBriefingHistory(history, {
        roomId, roomIdentityCid: existing.room_identity_cid,
        ownerSeatCid: existing.owner_seat_cid ?? null,
        memberCid: member.cid, role: member.coworkRole,
        version: definition.version!, sha256: definition.sha256,
      });
      updateMemberStartup(roomId, member.name, { briefing: result.briefing });
      allAcknowledged &&= result.briefing.state === 'acknowledged';
      relayFailed ||= result.briefing.state === 'relay_failed';
    }
    if (relayFailed) {
      const reason = 'Cowork recorded terminal send_failed for a role briefing; '
        + 'same-version redelivery requires Cowork support or seat replacement.';
      advanceSaga(roomId, 'wait_briefing_acks', 8, 'briefing_delivery_failed');
      setSagaError(roomId, reason, reason, 'briefing_delivery_failed');
      if (taskId) blockTask(taskId, reason);
      return getRoomRecord(roomId)!;
    }
    if (allAcknowledged) break;
    if (policy.now() >= deadline) {
      advanceSaga(roomId, 'wait_briefing_acks', 8, 'waiting_briefing_acks');
      return getRoomRecord(roomId)!;
    }
    advanceSaga(roomId, 'wait_briefing_acks', 8, 'waiting_briefing_acks');
    await policy.sleep(delay);
    delay = Math.min(policy.maxDelayMs, Math.max(delay + 1, delay * 2));
  }

  advanceSaga(roomId, 'activate', 9);
  const record = activateRoom(roomId);
  if (taskId) activateTask(taskId);
  return record;
}

export async function cleanupMembers(input: {
  roomId: string;
  taskId?: string;
  closeCoworkRoom?: boolean;
  cowork?: CoworkAdapter;
}): Promise<void> {
  const room = getRoomRecord(input.roomId);
  if (!room) return;
  if (!input.closeCoworkRoom || !input.cowork) {
    throw new Error('member cleanup requires the shared deterministic room-close saga and Cowork adapter');
  }
  await closeManagedRoom({ roomId: input.roomId, cowork: input.cowork });
}
