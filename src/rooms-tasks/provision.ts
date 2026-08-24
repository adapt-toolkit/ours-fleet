import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse } from 'yaml';
import {
  attachOursClient, type OursClient,
} from '@ours.network/sdk/client';
import type { CoworkAdapter } from './cowork-adapter.js';
import {
  advanceSaga, setSagaError, updateMemberSeats, updateMemberStartup,
  updateRoomRoleBriefing, updateRoomHistoryCursor, activateRoom, getRoomRecord,
} from './room-state.js';
import {
  activateTask, updateTaskMembers, failTask, blockTask, unblockTask, getTask,
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
  readTempSupervisor, secureStoppedTempArchive, tempArchiveForCreationAction,
  tempSupervisorLiveness,
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

async function redeemRoomInviteAsMember(
  member: ExpandedMember, invite: string, roomIdentityCid: string,
): Promise<void> {
  const client = await attachOursClient({
    env: process.env,
    leaseToken: `ours-fleet-member-admit-${process.pid}-${randomUUID()}`,
    clientPid: process.pid,
  });
  try {
    const bound = await client.chooseIdentity({ name: member.name, force: false });
    if (bound.cid.toLowerCase() !== member.cid.toLowerCase()) {
      throw new Error(
        `member ${member.name} identity CID mismatch: expected ${member.cid}, found ${bound.cid}`,
      );
    }
    const added = await client.addContact({ invite });
    if (added.cid.toLowerCase() !== roomIdentityCid.toLowerCase()) {
      throw new Error(
        `member ${member.name} invite resolved to ${added.cid}; expected room ${roomIdentityCid}`,
      );
    }
  } finally {
    await client.releaseLease().catch(() => {});
  }
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

async function roomHistory(cowork: CoworkAdapter, roomId: string): Promise<{
  records: RoomHistoryEvidence[]; cursor: number; exhausted: boolean;
}> {
  const records: RoomHistoryEvidence[] = [];
  let after = getRoomRecord(roomId)?.history_cursor ?? 0;
  for (let page = 0; page < 100; page++) {
    const next = await cowork.getHistory(roomId, { after, limit: 200 });
    records.push(...next.records);
    if (next.raw_count === 0) return { records, cursor: after, exhausted: true };
    if (next.next_after <= after) throw new Error('Cowork room history cursor did not advance');
    after = next.next_after;
    if (next.raw_count < 200) return { records, cursor: after, exhausted: true };
  }
  return { records, cursor: after, exhausted: false };
}

async function assertCurrentRoleBriefings(
  cowork: CoworkAdapter, roomId: string,
  definitions: Map<string, { text: string; sha256: string; version?: number }>,
): Promise<void> {
  const room = await cowork.getRoom(roomId);
  if (!room) throw new Error(`Cowork room ${roomId} is missing during briefing verification`);
  for (const [role, expected] of definitions) {
    const current = room.role_briefings[role];
    if (!current || current.text !== expected.text
        || sha256Text(current.text) !== expected.sha256
        || (expected.version !== undefined && current.version !== expected.version)) {
      throw new Error(`Cowork current role briefing drift for ${role}`);
    }
  }
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
    if (!supervisor || supervisor.role !== member.name)
      throw new Error(`existing launch for ${member.name} has mismatched supervisor metadata`);
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
    if (!seat.launch.launch_id || !seat.launch.action_id)
      throw new Error(`missing durable launch identity for disappeared ${member.name}`);
    const archive = await secureStoppedTempArchive(member.name, seat.launch.launch_id);
    if (!launchMatches(archive, member, seat.launch.action_id, missionSha, gate))
      throw new Error(`archive for disappeared ${member.name} does not match its durable intent`);
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...seat.launch, state: 'stopped', updated_at: new Date().toISOString(),
    } });
    seat = getRoomRecord(provision.roomId)!.member_seats
      .find(candidate => candidate.role_name === member.name)!;
  } else if (seat.launch?.state === 'intent' && !existsSync(dir)) {
    if (!seat.launch.action_id)
      throw new Error(`missing action ID for disappeared launch intent ${member.name}`);
    const archive = tempArchiveForCreationAction(member.name, seat.launch.action_id);
    if (!archive || !launchMatches(
      archive.path, member, seat.launch.action_id, missionSha, gate)) {
      throw new Error(
        `launch intent for ${member.name} has no exact live or terminated archive evidence`);
    }
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...seat.launch, state: 'stopped', launch_id: archive.launchId,
      updated_at: new Date().toISOString(),
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
  if (!supervisor || supervisor.role !== member.name
      || !launchMatches(launchedDir, member, actionId, missionSha, gate)) {
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
    // create_members saga phase
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
  const remoteRoom = await cowork.getRoom(roomId);
  if (!remoteRoom) throw new Error(`Cowork room ${roomId} is missing during briefing configuration`);
  for (const [role, definition] of definitions) {
    const current = getRoomRecord(roomId)!.role_briefings?.[role];
    const attempt = (current?.attempts ?? 0) + 1;
    updateRoomRoleBriefing(roomId, role, {
      role, ...definition, ...(current?.version ? { version: current.version } : {}),
      state: 'pending', attempts: attempt,
      updated_at: new Date().toISOString(),
    });
    try {
      const remote = remoteRoom.role_briefings[role];
      if (remote && (remote.text !== definition.text
          || sha256Text(remote.text) !== definition.sha256
          || (current?.version !== undefined && remote.version !== current.version))) {
        throw new Error(`Cowork current role briefing drift for ${role}`);
      }
      if (!remote && current?.version !== undefined)
        throw new Error(`Cowork current role briefing is missing for ${role}`);
      const configured = remote ?? await cowork.setRoleBriefing(roomId, {
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
        role, ...definition, ...(current?.version ? { version: current.version } : {}),
        state: 'failed', attempts: attempt,
        updated_at: new Date().toISOString(),
        last_error: error instanceof Error ? error.message : String(error),
      });
      setSagaError(roomId, error instanceof Error ? error.message : String(error),
        'Role briefing configuration failed. Retry task or room recover.', 'member_failed');
      if (taskId) blockTask(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  advanceSaga(roomId, 'join_role_groups', 5);
  try {
    const observedSeats = await cowork.getSeats(roomId);
    for (const member of members) {
      const observed = observedSeats.find(seat => seat.identity_cid === member.cid
        && seat.seat_state !== 'removed');
      if (observed && observed.role !== member.coworkRole)
        throw new Error(`Cowork seat ${member.cid} has role ${observed.role}; expected ${member.coworkRole}`);
    }
    const admitted = new Set(observedSeats
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
        await redeemRoomInviteAsMember(member, invite, existing.room_identity_cid);
      }
      // Reconciliation attributes newly authenticated contacts to the one live
      // invite. Complete this group before another role descriptor is minted.
      const reconciled = await cowork.recoverRoom(roomId);
      for (const member of group) {
        const seat = reconciled.seats.find(candidate =>
          candidate.identity_cid === member.cid && candidate.seat_state !== 'removed');
        if (!seat) {
          throw new Error(`Cowork did not authenticate member ${member.name} after invite redemption`);
        }
        if (seat.role !== coworkRole) {
          throw new Error(`Cowork seat ${member.cid} has role ${seat.role}; expected ${coworkRole}`);
        }
      }
    }
  } catch (error) {
    setSagaError(roomId, error instanceof Error ? error.message : String(error),
      'Role-group admission failed. Retry with `task recover`.', 'member_failed');
    if (taskId) blockTask(taskId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (taskId && getTask(taskId).blocked) unblockTask(taskId);

  advanceSaga(roomId, 'wait_seats', 6);
  const coworkSeats = await cowork.getSeats(roomId);
  const memberCids = new Set(members.map(m => m.cid));
  const allActive = [...memberCids].every(cid =>
    coworkSeats.some(s => s.identity_cid === cid
      && s.role === members.find(member => member.cid === cid)?.coworkRole
      && s.seat_state === 'active'),
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
      const currentRoom = getRoomRecord(roomId)!;
      const definition = currentRoom.role_briefings![member.coworkRole];
      const previous = currentRoom.member_seats
        .find(seat => seat.role_name === member.name)!.briefing;
      const result = reconcileBriefingHistory(history.records, {
        roomId, roomIdentityCid: existing.room_identity_cid,
        ownerSeatCid: existing.owner_seat_cid ?? null,
        memberCid: member.cid, role: member.coworkRole,
        version: definition.version!, sha256: definition.sha256,
      }, previous);
      if (result.drift) {
        setSagaError(roomId, result.drift,
          'Cowork role briefing history drifted; inspect current room briefing state.', 'uncertain');
        if (taskId) blockTask(taskId, result.drift);
        throw new Error(result.drift);
      }
      updateMemberStartup(roomId, member.name, { briefing: result.briefing });
      allAcknowledged &&= result.briefing.state === 'acknowledged';
      relayFailed ||= result.briefing.state === 'relay_failed';
    }
    updateRoomHistoryCursor(roomId, history.cursor);
    if (!history.exhausted) {
      const reason = 'Cowork history backlog exceeded 20,000 raw records in one pass; '
        + 'cursor progress was preserved, retry recovery to continue.';
      setSagaError(roomId, reason, reason, 'uncertain');
      throw new Error(reason);
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

  const finalDefinitions = new Map([...definitions].map(([role, definition]) => {
    const persisted = getRoomRecord(roomId)!.role_briefings![role];
    return [role, { ...definition, version: persisted.version }];
  }));
  try {
    await assertCurrentRoleBriefings(cowork, roomId, finalDefinitions);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setSagaError(roomId, reason,
      'Cowork current role briefing drifted before activation; inspect room state.', 'uncertain');
    if (taskId) blockTask(taskId, reason);
    throw error;
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
