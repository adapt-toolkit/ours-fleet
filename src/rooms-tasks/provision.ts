import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse } from 'yaml';
import type { CoworkAdapter, CoworkSeatInfo } from './cowork-adapter.js';
import {
  advanceSaga, setSagaError, updateMemberSeats, updateMemberStartup,
  activateRoom, getRoomRecord,
} from './room-state.js';
import {
  activateTask, updateTaskMembers, blockTask, unblockTask, getTask,
} from './task-state.js';
import type {
  RoomOrchestrationRecord, RoomMemberSeat, TaskMemberRole,
  TemplateSnapshot, TemplateMemberSlot,
} from './types.js';
import { spawnTemp } from '../spawn.js';
import type { SpawnOpts } from '../spawn.js';
import { type FleetConfig, type RoomMemberStartup } from '../config.js';
import type { AgentDefinition } from '../config.js';
import { canonicalJson } from '../canonical-json.js';
import { readLaunchSnapshot, redactLaunchDefinition } from './launch-snapshot.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV,
  type ManagedFleetSpawnResult,
} from '../fleet-proxy.js';
import { controlRequest } from '../session/control.js';
import { SessionControlError } from '../session/types.js';
import { closeManagedRoom } from './close.js';
import { buildRoomMemberTask, sha256Text } from './member-startup.js';
import { agentDir } from '../paths.js';
import { readProvenance } from '../creation.js';
import {
  readTempSupervisor, secureStoppedTempArchive, tempArchiveForCreationAction,
  tempSupervisorLiveness,
} from '../temp-lifecycle.js';
import { recordFleetAuditPresentation } from '../fleet-command-audit.js';

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
  agentTemplate: string;
  agentTemplateHash?: string;
}

interface MemberSettings {
  definition: AgentDefinition;
  persona?: string;
  template: string;
  templateHash: string;
}

function selectionSummary(selection: AgentDefinition['brain'] | AgentDefinition['role']): string {
  if ('ref' in selection) return `ref:${selection.ref} (reference)`;
  return `inline:sha256:${createHash('sha256').update(canonicalJson(selection.inline)).digest('hex').slice(0, 16)} (inline)`;
}

function permissionSummary(definition: AgentDefinition): string | undefined {
  const permissions = definition.permissions;
  if (!permissions) return undefined;
  return `approval=${permissions.approval},filesystem=${permissions.filesystem},unattended=${permissions.unattended}`;
}

function launchDefinition(definition: AgentDefinition): {
  projection: Record<string, unknown>; fingerprint: string;
} {
  return {
    projection: redactLaunchDefinition(definition) as Record<string, unknown>,
    fingerprint: createHash('sha256').update(canonicalJson(definition)).digest('hex'),
  };
}

/**
 * Room commands run inside a managed role when invoked by an agent. Route that
 * launch through the role's authenticated supervisor so omitted settings use
 * the exact same inheritance contract as `ours-fleet spawn`. A standalone CLI
 * has no caller context and deliberately retains the normal Fleet fallback.
 */
interface RoomMemberSpawnResult {
  statePath: string;
  creationActionId: string;
  callerRole?: string;
}

async function spawnRoomMember(
  options: SpawnOpts, binPath: string,
): Promise<RoomMemberSpawnResult> {
  const stateDir = process.env[FLEET_PROXY_STATE_DIR_ENV];
  if (!stateDir) return {
    statePath: await spawnTemp(options, binPath),
    creationActionId: options.creationActionId!,
  };

  const response = await controlRequest(
    stateDir, { command: 'fleet_spawn', spawn: options }, 10 * 60_000,
  );
  if (!response.ok) {
    throw new SessionControlError(
      response.kind ?? 'backend', response.error ?? 'managed room member spawn failed',
    );
  }
  const result = response.result as ManagedFleetSpawnResult;
  const expectedCaller = process.env[FLEET_PROXY_CALLER_ENV];
  if (expectedCaller && result.caller !== expectedCaller) {
    throw new Error(
      `fleet proxy caller mismatch: expected '${expectedCaller}', got '${result.caller}'`,
    );
  }
  return {
    statePath: result.statePath,
    creationActionId: result.creationActionId,
    callerRole: result.caller,
  };
}

function shortId(id: string): string { return id.slice(0, 8); }

function expandMembers(
  template: TemplateSnapshot,
  prefix: string,
): ExpandedMember[] {
  const result: ExpandedMember[] = [];
  for (const slot of template.members) {
    for (let i = 1; i <= slot.count; i++) {
      result.push({
        name: `${prefix}-${slot.slot}-${i}`,
        slot: slot.slot,
        coworkRole: slot.role,
        agentTemplate: slot.agent_template,
        agentTemplateHash: slot.agent_template_hash,
      });
    }
  }
  return result;
}

function settingsFor(
  member: ExpandedMember, cfg: FleetConfig,
  sealed?: Record<string, import('../config.js').AgentTemplateDefinition>,
): MemberSettings {
  const definition = sealed?.[member.agentTemplate] ?? cfg.agentTemplates?.[member.agentTemplate];
  if (!definition) throw new Error(`Agent Template '${member.agentTemplate}' not found`);
  const role = definition.role;
  return {
    definition: structuredClone(definition) as AgentDefinition,
    ...('inline' in role && typeof role.inline.persona === 'string'
      ? { persona: role.inline.persona } : {}),
    template: member.agentTemplate,
    templateHash: member.agentTemplateHash
      ?? createHash('sha256').update(canonicalJson(definition)).digest('hex'),
  };
}

function roomTask(
  input: ProvisionMembersInput,
  member: ExpandedMember,
  settings: MemberSettings,
  members: ExpandedMember[],
  roomIdentityCid: string,
  ownerSeatCid: string | null,
): string {
  return buildRoomMemberTask({
    taskId: input.taskId,
    roomId: input.roomId,
    roomIdentityCid,
    ownerSeatCid,
    goal: input.goal,
    brief: input.brief,
    contract: input.template.contract,
    member: {
      role_name: member.name,
      cowork_role: member.coworkRole,
      persona: settings.persona,
    },
    roster: members.map(candidate => ({
      role_name: candidate.name,
      cowork_role: candidate.coworkRole,
    })),
  });
}

function launchMatches(
  dir: string,
  member: ExpandedMember,
  actionId: string,
  taskSha: string,
  roomId: string,
  roomIdentityCid: string,
  expectedInviteId?: string,
): boolean {
  const provenance = readProvenance(dir);
  if (provenance?.creationActionId !== actionId || provenance.role !== member.name) return false;
  try {
    const role = parse(readFileSync(`${dir}/role.yaml`, 'utf8')) as {
      identity?: unknown;
      mission?: unknown;
      roomMemberStartup?: Partial<RoomMemberStartup>;
    };
    const startup = role.roomMemberStartup;
    return role.identity === member.name
      && startup?.room_id === roomId
      && startup.room_identity_cid === roomIdentityCid
      && startup.identity_name === member.name
      && startup.role === member.coworkRole
      && sha256Text(startup.task ?? '') === taskSha
      && (expectedInviteId === undefined || startup.invite_id === expectedInviteId)
      && typeof startup.invite === 'string'
      && startup.invite.length > 0;
  } catch { return false; }
}

async function retainRunningLaunch(input: {
  provision: ProvisionMembersInput;
  member: ExpandedMember;
  task: string;
  roomIdentityCid: string;
}): Promise<boolean> {
  const { provision, member, task, roomIdentityCid } = input;
  let seat = getRoomRecord(provision.roomId)!.member_seats
    .find(candidate => candidate.role_name === member.name)!;
  const dir = agentDir(member.name, true);
  const taskSha = sha256Text(task);

  if ((seat.launch?.state === 'intent' || seat.launch?.state === 'launched'
      || seat.launch?.state === 'failed') && existsSync(dir)) {
    if (!seat.launch.action_id || !launchMatches(
      dir, member, seat.launch.action_id, taskSha, provision.roomId,
      roomIdentityCid, seat.invite_id,
    )) {
      const provenance = readProvenance(dir);
      const adoptable = (seat.launch.state === 'intent' || seat.launch.state === 'failed')
        && Boolean(seat.launch.caller_role)
        && provenance?.surface === 'agent'
        && provenance.callerRole === seat.launch.caller_role
        && typeof provenance.creationActionId === 'string'
        && launchMatches(
          dir, member, provenance.creationActionId, taskSha, provision.roomId,
          roomIdentityCid, seat.invite_id,
        );
      if (!adoptable)
        throw new Error(`existing launch for ${member.name} does not match its durable intent`);
      updateMemberStartup(provision.roomId, member.name, { launch: {
        ...seat.launch, state: 'intent', action_id: provenance!.creationActionId!,
        updated_at: new Date().toISOString(),
      } });
      seat = getRoomRecord(provision.roomId)!.member_seats
        .find(candidate => candidate.role_name === member.name)!;
    }
    const supervisor = readTempSupervisor(dir);
    if (!supervisor || supervisor.role !== member.name)
      throw new Error(`existing launch for ${member.name} has mismatched supervisor metadata`);
    const live = await tempSupervisorLiveness(dir);
    if (live === 'unknown') throw new Error(`existing launch for ${member.name} has unknown liveness`);
    const retainedLaunch = seat.launch!;
    if (live === 'running') {
      updateMemberStartup(provision.roomId, member.name, { launch: {
        ...retainedLaunch, state: 'launched', launch_id: supervisor.launchId,
        updated_at: new Date().toISOString(),
      } });
      return true;
    }
    await secureStoppedTempArchive(member.name, supervisor.launchId);
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...retainedLaunch, state: 'stopped', launch_id: supervisor.launchId,
      updated_at: new Date().toISOString(),
    } });
    return false;
  }

  if (seat.launch?.state === 'launched' && !existsSync(dir)) {
    if (!seat.launch.launch_id || !seat.launch.action_id)
      throw new Error(`missing durable launch identity for disappeared ${member.name}`);
    const archive = await secureStoppedTempArchive(member.name, seat.launch.launch_id);
    if (!launchMatches(
      archive, member, seat.launch.action_id, taskSha, provision.roomId,
      roomIdentityCid, seat.invite_id,
    )) {
      throw new Error(`archive for disappeared ${member.name} does not match its durable intent`);
    }
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...seat.launch, state: 'stopped', updated_at: new Date().toISOString(),
    } });
    return false;
  }

  if (seat.launch?.state === 'intent' && !existsSync(dir)) {
    if (!seat.launch.action_id)
      throw new Error(`missing action ID for disappeared launch intent ${member.name}`);
    const archive = tempArchiveForCreationAction(member.name, seat.launch.action_id);
    if (!archive || !launchMatches(
      archive.path, member, seat.launch.action_id, taskSha, provision.roomId,
      roomIdentityCid, seat.invite_id,
    )) {
      throw new Error(
        `launch intent for ${member.name} has no exact live or terminated archive evidence`,
      );
    }
    updateMemberStartup(provision.roomId, member.name, { launch: {
      ...seat.launch, state: 'stopped', launch_id: archive.launchId,
      updated_at: new Date().toISOString(),
    } });
  }
  return false;
}

async function launchMember(input: {
  provision: ProvisionMembersInput;
  member: ExpandedMember;
  settings: MemberSettings;
  startup: RoomMemberStartup;
}): Promise<void> {
  const { provision, member, settings, startup } = input;
  const seat = getRoomRecord(provision.roomId)!.member_seats
    .find(candidate => candidate.role_name === member.name)!;
  const actionId = randomUUID();
  let effectiveActionId: string = actionId;
  const attempt = (seat.launch?.attempt ?? 0) + 1;
  const taskSha = sha256Text(startup.task);
  const effectiveAgentDefinition = structuredClone(settings.definition);
  const { projection: agentDefinition, fingerprint: agentFingerprint } =
    launchDefinition(effectiveAgentDefinition);
  const proxyCaller = process.env[FLEET_PROXY_STATE_DIR_ENV]
    ? process.env[FLEET_PROXY_CALLER_ENV] : undefined;
  updateMemberStartup(provision.roomId, member.name, { launch: {
    state: 'intent', attempt, action_id: actionId, mission_sha256: taskSha,
    agent_definition: agentDefinition, agent_fingerprint: agentFingerprint,
    agent_template: settings.template, agent_template_hash: settings.templateHash,
    ...(proxyCaller ? { caller_role: proxyCaller } : {}),
    updated_at: new Date().toISOString(),
  } });
  try {
    const launched = await spawnRoomMember({
      name: member.name,
      temp: true,
      identity: member.name,
      agentDefinition: settings.definition,
      surface: 'agent',
      creationActionId: actionId,
      roomMemberStartup: startup,
    }, provision.binPath);
    const launchedDir = launched.statePath;
    effectiveActionId = launched.creationActionId;
    if (launched.creationActionId !== actionId) {
      updateMemberStartup(provision.roomId, member.name, { launch: {
        state: 'intent', attempt, action_id: launched.creationActionId,
        mission_sha256: taskSha, agent_definition: agentDefinition,
        agent_fingerprint: agentFingerprint,
        agent_template: settings.template, agent_template_hash: settings.templateHash,
        updated_at: new Date().toISOString(),
        ...(launched.callerRole ? { caller_role: launched.callerRole } : {}),
      } });
    }
    const supervisor = readTempSupervisor(launchedDir);
    if (!supervisor || supervisor.role !== member.name || !launchMatches(
      launchedDir, member, launched.creationActionId, taskSha, provision.roomId,
      startup.room_identity_cid, startup.invite_id,
    )) {
      throw new Error(`new launch for ${member.name} did not persist matching provenance`);
    }
    updateMemberStartup(provision.roomId, member.name, { launch: {
      state: 'launched', attempt, action_id: launched.creationActionId, mission_sha256: taskSha,
      agent_definition: agentDefinition, agent_fingerprint: agentFingerprint,
      agent_template: settings.template, agent_template_hash: settings.templateHash,
      ...(launched.callerRole ? { caller_role: launched.callerRole } : {}),
      launch_id: supervisor.launchId, updated_at: new Date().toISOString(),
    } });
    recordFleetAuditPresentation({ kind: 'agent_started', id: member.name, name: member.name,
      lifetime: 'temporary', brain: selectionSummary(settings.definition.brain),
      role: selectionSummary(settings.definition.role), harness: 'resolved', session: 'acp',
      permissions: permissionSummary(settings.definition), parent: provision.roomId,
      actionId: launched.creationActionId, inherited: [] });
  } catch (error) {
    updateMemberStartup(provision.roomId, member.name, { launch: {
      state: 'failed', attempt, action_id: effectiveActionId, mission_sha256: taskSha,
      agent_definition: agentDefinition, agent_fingerprint: agentFingerprint,
      agent_template: settings.template, agent_template_hash: settings.templateHash,
      ...(proxyCaller ? { caller_role: proxyCaller } : {}),
      updated_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    } });
    recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Agent', id: member.name,
      state: 'failed', category: 'readiness_failed', eventId: effectiveActionId });
    throw error;
  }
}

function exactCoworkSeat(
  observed: CoworkSeatInfo[], member: ExpandedMember, expectedInviteId?: string,
): CoworkSeatInfo | undefined {
  const named = observed.filter(seat =>
    seat.display_name === member.name && seat.seat_state !== 'removed');
  if (named.length > 1)
    throw new Error(`Cowork has multiple live seats named ${member.name}`);
  const seat = named[0];
  if (!seat) return undefined;
  if (seat.role !== member.coworkRole)
    throw new Error(`Cowork seat ${member.name} has role ${seat.role}; expected ${member.coworkRole}`);
  if (expectedInviteId && seat.invite_id !== expectedInviteId) {
    throw new Error(
      `Cowork seat ${member.name} used invite ${seat.invite_id}; expected ${expectedInviteId}`,
    );
  }
  return seat;
}

function reconcileMemberSeats(
  roomId: string, members: ExpandedMember[], observed: CoworkSeatInfo[],
): { complete: boolean; seats: RoomMemberSeat[] } {
  const current = getRoomRecord(roomId)!;
  let complete = true;
  const seats = current.member_seats.map(seat => {
    const member = members.find(candidate => candidate.name === seat.role_name)!;
    const found = exactCoworkSeat(observed, member, seat.invite_id);
    if (!found || found.seat_state !== 'active') {
      complete = false;
      return seat;
    }
    return {
      ...seat,
      identity_cid: found.identity_cid,
      invite_id: found.invite_id,
      seat_state: 'active' as const,
    };
  });
  updateMemberSeats(roomId, seats);
  return { complete, seats };
}

export async function provisionMembers(
  input: ProvisionMembersInput,
): Promise<RoomOrchestrationRecord> {
  const { cfg, cowork, roomId, taskId, template } = input;
  const prefix = taskId ? shortId(taskId) : `room-${shortId(roomId)}`;
  const members = expandMembers(template, prefix);
  // Resolve every Agent before persisting launch intent or touching Cowork membership.
  const sealed = template.launch_snapshot_hash
    ? readLaunchSnapshot(template.launch_snapshot_hash) : undefined;
  const settings = new Map(members.map(member => [member.name, settingsFor(member, cfg, sealed)]));
  const existing = getRoomRecord(roomId);
  if (!existing?.room_identity_cid)
    throw new Error(`room ${roomId} has no pinned room identity CID`);
  const roomIdentityCid = existing.room_identity_cid;
  const ownerSeatCid = existing.owner_seat_cid ?? null;

  const persistedNames = new Set(existing.member_seats.map(seat => seat.role_name));
  const resuming = members.length > 0
    && members.every(member => persistedNames.has(member.name));
  if (!resuming) {
    advanceSaga(roomId, 'create_members', 3);
    updateMemberSeats(roomId, members.map(member => {
      const memberSettings = settings.get(member.name)!;
      const evidence = launchDefinition(memberSettings.definition);
      return ({
      role_name: member.name,
      slot: member.slot,
      cowork_role: member.coworkRole,
      seat_state: 'pending' as const,
      launch: { state: 'pending' as const, attempt: 0,
        agent_definition: evidence.projection, agent_fingerprint: evidence.fingerprint,
        agent_template: memberSettings.template,
        agent_template_hash: memberSettings.templateHash,
        updated_at: new Date().toISOString() },
    }); }));
  } else {
    for (const member of members) {
      const seat = existing.member_seats.find(candidate => candidate.role_name === member.name)!;
      const evidence = launchDefinition(settings.get(member.name)!.definition);
      if (!seat.launch?.agent_fingerprint || seat.launch.agent_fingerprint !== evidence.fingerprint)
        throw new Error(`Agent definition drift for ${member.name}; durable launch intent does not match current configuration`);
    }
  }

  const tasks = new Map(members.map(member => [member.name, roomTask(
    input, member, settings.get(member.name)!, members, roomIdentityCid, ownerSeatCid,
  )]));
  const policy: StartupWaitPolicy = {
    timeoutMs: input.startupWait?.timeoutMs ?? 60_000,
    initialDelayMs: input.startupWait?.initialDelayMs ?? 250,
    maxDelayMs: input.startupWait?.maxDelayMs ?? 2_000,
    now: input.startupWait?.now ?? Date.now,
    sleep: input.startupWait?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };

  advanceSaga(roomId, 'join_role_groups', 4);
  try {
    const initialRoom = await cowork.recoverRoom(roomId);
    reconcileMemberSeats(roomId, members, initialRoom.seats);
    for (const member of members) {
      const task = tasks.get(member.name)!;
      const currentSeat = getRoomRecord(roomId)!.member_seats
        .find(seat => seat.role_name === member.name)!;
      if (currentSeat.seat_state === 'active') {
        if (!await retainRunningLaunch({
          provision: input, member, task, roomIdentityCid,
        })) {
          throw new Error(`active Cowork seat ${member.name} has no matching live Fleet launch`);
        }
        continue;
      }
      if (await retainRunningLaunch({ provision: input, member, task, roomIdentityCid })) continue;

      const issued = await cowork.issueInvite(roomId, {
        mode: 'one_time', role: member.coworkRole, min_accepts: 1,
      });
      const seats = getRoomRecord(roomId)!.member_seats.map(seat =>
        seat.role_name === member.name ? { ...seat, invite_id: issued.invite_id } : seat);
      updateMemberSeats(roomId, seats);
      try {
        await launchMember({
          provision: input,
          member,
          settings: settings.get(member.name)!,
          startup: {
            room_id: roomId,
            room_identity_cid: roomIdentityCid,
            identity_name: member.name,
            invite_id: issued.invite_id,
            invite: issued.invite,
            role: member.coworkRole,
            task,
            owner_seat_cid: ownerSeatCid,
          },
        });
      } catch (error) {
        await cowork.revokeInvite(roomId, issued.invite_id).catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setSagaError(roomId, reason,
      'Member invite or launch failed. Retry with `task recover`.', 'member_failed');
    if (taskId) blockTask(taskId, reason);
    throw error;
  }

  advanceSaga(roomId, 'wait_seats', 5);
  const deadline = policy.now() + policy.timeoutMs;
  let delay = policy.initialDelayMs;
  for (;;) {
    const remote = await cowork.recoverRoom(roomId);
    const reconciled = reconcileMemberSeats(roomId, members, remote.seats);
    if (reconciled.complete) break;
    if (policy.now() >= deadline) {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    }
    advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
    await policy.sleep(delay);
    delay = Math.min(policy.maxDelayMs, Math.max(delay + 1, delay * 2));
  }

  if (taskId) {
    const taskMembers: TaskMemberRole[] = getRoomRecord(roomId)!.member_seats.map(seat => {
      if (!seat.identity_cid)
        throw new Error(`active room member ${seat.role_name} has no authenticated identity CID`);
      return {
        name: seat.role_name,
        identity_cid: seat.identity_cid,
        slot: seat.slot,
        cowork_role: seat.cowork_role,
      };
    });
    updateTaskMembers(taskId, taskMembers);
    if (getTask(taskId).blocked) unblockTask(taskId);
  }

  advanceSaga(roomId, 'activate', 6);
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
