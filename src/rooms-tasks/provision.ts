import { readRoomReadiness } from '../agent-ours/service.js';
import { ensureWorkspace, validateWorkspace } from './workspace.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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
import { storedRoomLaunchPolicy } from './types.js';
import { spawnTemp } from '../spawn.js';
import type { SpawnOpts } from '../spawn.js';
import { type FleetConfig, type RoomMemberStartup } from '../config.js';
import type { AgentDefinition, ResolvedRole } from '../config.js';
import { effectivePermissionMode } from '../permissions.js';
import {
  selectionOrigin, summarizeResolvedLaunch, type AgentLaunchConfiguration,
} from '../lifecycle-summary.js';
import { canonicalJson } from '../canonical-json.js';
import { readLaunchSnapshot, redactLaunchDefinition } from './launch-snapshot.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV,
  type ManagedFleetSpawnResult,
} from '../fleet-proxy.js';
import { controlRequest } from '../session/control.js';
import { SessionControlError } from '../session/types.js';
import { closeManagedRoom, roomCloseLockPath, CLOSE_LOCK_STALE_MS } from './close.js';
import { withFileLock } from '../atomic-file.js';
import { TASK_OPERATION_LOCK_STALE_MS, taskOperationLockPath } from './terminal.js';
import { TaskStateError, taskDeletionState } from './task-state.js';
import { buildRoomMemberTask, sha256Text } from './member-startup.js';
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
  agentTemplate: string;
  launchDefinitionId: string;
  agentTemplateHash?: string;
  loopSource: 'agent-template' | 'cli' | 'omitted';
}

interface MemberSettings {
  definition: AgentDefinition;
  persona?: string;
  template: string;
  templateHash: string;
  loopSource: 'agent-template' | 'cli' | 'omitted';
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
  /** Launch configuration reported by the managed spawn boundary, when available. */
  configuration?: AgentLaunchConfiguration;
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
    ...(result.configuration ? { configuration: result.configuration } : {}),
  };
}

/**
 * Launch-boundary capture: the exact ResolvedRole the spawn persisted,
 * whitelisted into the operator-facing presentation. Capture is required for
 * every launched room member — launchMatches has already proved role.yaml
 * readable, and effectivePermissionMode is total over registered harnesses —
 * so a failure here is a capture defect and must surface, not degrade to the
 * legacy rendering.
 */
function presentationFromStatePath(
  statePath: string, settings: MemberSettings, coworkRole: string,
): AgentLaunchConfiguration {
  const resolved = parse(readFileSync(join(statePath, 'role.yaml'), 'utf8')) as ResolvedRole;
  return summarizeResolvedLaunch(resolved, {
    role: selectionOrigin(settings.definition.role),
    brain: selectionOrigin(settings.definition.brain),
    template: settings.template,
    permissionMode: effectivePermissionMode(resolved),
    missionFallback: coworkRole,
  });
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
        launchDefinitionId: slot.launch_definition_id ?? slot.agent_template,
        agentTemplateHash: slot.agent_template_hash,
        loopSource: slot.loop_source ?? 'omitted',
      });
    }
  }
  return result;
}

function settingsFor(
  member: ExpandedMember, cfg: FleetConfig,
  sealed?: Record<string, import('../config.js').AgentTemplateDefinition>,
): MemberSettings {
  const definition = sealed
    ? sealed[member.launchDefinitionId]
    : cfg.agentTemplates?.[member.agentTemplate];
  if (!definition) throw new Error(sealed
    ? `Sealed Agent definition '${member.launchDefinitionId}' not found`
    : `Agent Template '${member.agentTemplate}' not found`);
  const role = definition.role;
  return {
    definition: structuredClone(definition) as AgentDefinition,
    ...('inline' in role && typeof role.inline.persona === 'string'
      ? { persona: role.inline.persona } : {}),
    template: member.agentTemplate,
    templateHash: member.agentTemplateHash
      ?? createHash('sha256').update(canonicalJson(definition)).digest('hex'),
    loopSource: member.loopSource,
  };
}

function roomTask(
  input: ProvisionMembersInput,
  member: ExpandedMember,
  settings: MemberSettings,
  members: ExpandedMember[],
  roomIdentityCid: string,
  ownerSeatCid: string | null,
  anonymous: boolean,
): string {
  return buildRoomMemberTask({
    workspace: getRoomRecord(input.roomId)?.workspace?.path,
    taskId: input.taskId,
    roomId: input.roomId,
    roomIdentityCid,
    ownerSeatCid,
    anonymous,
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
  member: Pick<ExpandedMember, 'name' | 'coworkRole'>,
  actionId: string,
  taskSha: string,
  roomId: string,
  roomIdentityCid: string,
  expectedInviteId?: string,
  anonymous = false,
): boolean {
  const provenance = readProvenance(dir);
  if (provenance?.creationActionId !== actionId || provenance.role !== member.name) return false;
  try {
    const role = parse(readFileSync(`${dir}/role.yaml`, 'utf8')) as {
      identity?: unknown;
      cwd?: unknown;
      mission?: unknown;
      roomMemberStartup?: Partial<RoomMemberStartup>;
    };
    const startup = role.roomMemberStartup;
    const workspace = getRoomRecord(roomId)?.workspace;
    if (workspace && (role.cwd !== workspace.path
      || JSON.stringify(startup?.workspace) !== JSON.stringify(workspace))) return false;
    return role.identity === member.name
      && startup?.room_id === roomId
      && startup.room_identity_cid === roomIdentityCid
      && startup.identity_name === member.name
      && startup.role === member.coworkRole
      && (startup.anonymous ?? false) === anonymous
      && sha256Text(startup.task ?? '') === taskSha
      && (expectedInviteId === undefined || startup.invite_id === expectedInviteId)
      && startup.invite === '';
  } catch { return false; }
}

async function retainRunningLaunch(input: {
  provision: ProvisionMembersInput;
  member: ExpandedMember;
  settings: MemberSettings;
  task: string;
  roomIdentityCid: string;
}): Promise<boolean> {
  const { provision, member, settings, task, roomIdentityCid } = input;
  let seat = getRoomRecord(provision.roomId)!.member_seats
    .find(candidate => candidate.role_name === member.name)!;
  const dir = agentDir(member.name, true);
  const taskSha = sha256Text(task);
  const anonymous = storedRoomLaunchPolicy(
    getRoomRecord(provision.roomId)?.room_policy).anonymous;

  if ((seat.launch?.state === 'intent' || seat.launch?.state === 'launched'
      || seat.launch?.state === 'failed') && existsSync(dir)) {
    if (!seat.launch.action_id || !launchMatches(
      dir, member, seat.launch.action_id, taskSha, provision.roomId,
      roomIdentityCid, seat.invite_id, anonymous,
    )) {
      const provenance = readProvenance(dir);
      const adoptable = (seat.launch.state === 'intent' || seat.launch.state === 'failed')
        && Boolean(seat.launch.caller_role)
        && provenance?.surface === 'agent'
        && provenance.callerRole === seat.launch.caller_role
        && typeof provenance.creationActionId === 'string'
        && launchMatches(
          dir, member, provenance.creationActionId, taskSha, provision.roomId,
          roomIdentityCid, seat.invite_id, anonymous,
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
      // A crash between spawn and the seat update (or a pre-upgrade launch)
      // can retain a running member without a captured presentation; backfill
      // it from the same persisted resolved role the match was proved against.
      const presentation = retainedLaunch.presentation
        ?? presentationFromStatePath(dir, settings, member.coworkRole);
      updateMemberStartup(provision.roomId, member.name, { launch: {
        ...retainedLaunch, state: 'launched', launch_id: supervisor.launchId,
        presentation, updated_at: new Date().toISOString(),
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
      roomIdentityCid, seat.invite_id, anonymous,
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
      roomIdentityCid, seat.invite_id, anonymous,
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
  // provisionMembers holds the task and room lifecycle locks through every launch.
  assertProvisioningOpen(input.provision);
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
      ...(settings.loopSource === 'cli' && settings.definition.loops === undefined
        ? { noLoops: true } : {}),
      loopSource: settings.loopSource,
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
      startup.room_identity_cid, startup.invite_id, startup.anonymous ?? false,
    )) {
      throw new Error(`new launch for ${member.name} did not persist matching provenance`);
    }
    const presentation: AgentLaunchConfiguration = launched.configuration
      ? { ...launched.configuration, template: settings.template,
        ...(launched.configuration.mission ? {} : { mission: member.coworkRole }) }
      : presentationFromStatePath(launchedDir, settings, member.coworkRole);
    updateMemberStartup(provision.roomId, member.name, { launch: {
      state: 'launched', attempt, action_id: launched.creationActionId, mission_sha256: taskSha,
      agent_definition: agentDefinition, agent_fingerprint: agentFingerprint,
      agent_template: settings.template, agent_template_hash: settings.templateHash,
      presentation,
      ...(launched.callerRole ? { caller_role: launched.callerRole } : {}),
      launch_id: supervisor.launchId, updated_at: new Date().toISOString(),
    } });
  } catch (error) {
    updateMemberStartup(provision.roomId, member.name, { launch: {
      state: 'failed', attempt, action_id: effectiveActionId, mission_sha256: taskSha,
      agent_definition: agentDefinition, agent_fingerprint: agentFingerprint,
      agent_template: settings.template, agent_template_hash: settings.templateHash,
      ...(proxyCaller ? { caller_role: proxyCaller } : {}),
      updated_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    } });
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
  roomId: string, members: ExpandedMember[], observed: CoworkSeatInfo[], ownerSeatCid?: string,
): { complete: boolean; seats: RoomMemberSeat[] } {
  const current = getRoomRecord(roomId)!;
  let complete = !ownerSeatCid || observed.some(seat =>
    seat.identity_cid.toLowerCase() === ownerSeatCid.toLowerCase()
      && seat.seat_state === 'active');
  const seats = current.member_seats.map(seat => {
    const member = members.find(candidate => candidate.name === seat.role_name)!;
    const readiness = readRoomReadiness(current.room_identity_cid!, member.name);
    if (!readiness || readiness.room !== roomId || readiness.invite !== seat.invite_id) { complete = false; return seat; }
    const found = exactCoworkSeat(observed, member, seat.invite_id);
    if (found && found.identity_cid !== readiness.cid) throw new Error('Cowork seat CID does not match supervisor provisioned identity');
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

function assertCoworkRoomPolicy(
  room: Awaited<ReturnType<CoworkAdapter['recoverRoom']>>,
  expectedAnonymous: boolean,
): void {
  if ((room.anonymous ?? false) !== expectedAnonymous)
    throw new Error(`Cowork anonymity (${String(room.anonymous ?? false)}) does not match Fleet's durable Room policy (${String(expectedAnonymous)})`);
}

function assertProvisioningOpen(input: ProvisionMembersInput): void {
  if (input.taskId && getTask(input.taskId).terminal_intent)
    throw new Error(`task ${input.taskId} has an accepted terminal intent; refusing to provision members`);
  const room = getRoomRecord(input.roomId);
  if (room?.state === 'closing' || room?.state === 'closed')
    throw new Error(`room ${input.roomId} is ${room.state}; refusing to provision members`);
}

export async function provisionMembers(input: ProvisionMembersInput): Promise<RoomOrchestrationRecord> {
  // Same lock order as terminal/deletion settlement. Serialize concurrent retries
  // and standalone retirement as well as member publication. Seat waits are bounded.
  const run = () => withFileLock(roomCloseLockPath(input.roomId), () => {
    assertProvisioningOpen(input);
    if (!getRoomRecord(input.roomId))
      throw new Error(`room ${input.roomId} is missing; refusing provisioning`);
    return provisionMembersUnlocked(input);
  }, {}, CLOSE_LOCK_STALE_MS);
  return input.taskId
    ? withFileLock(taskOperationLockPath(input.taskId), run, {}, TASK_OPERATION_LOCK_STALE_MS)
    : run();
}

async function provisionMembersUnlocked(input: ProvisionMembersInput): Promise<RoomOrchestrationRecord> {
  const { cfg, cowork, roomId, taskId, template } = input;
  // The common task-operation lock protects this epoch through all member launches.
  if (taskId && taskDeletionState(taskId) !== 'none')
    throw new Error(`task ${taskId} is pending deletion; refusing to provision members`);
  const prefix = taskId ? shortId(taskId) : `room-${shortId(roomId)}`;
  const members = expandMembers(template, prefix);
  // Resolve every Agent before persisting launch intent or touching Cowork membership.
  const sealed = template.launch_snapshot_hash
    ? readLaunchSnapshot(template.launch_snapshot_hash) : undefined;
  const settings = new Map(members.map(member => [member.name, settingsFor(member, cfg, sealed)]));
  const existing = getRoomRecord(roomId);
  if (!existing?.room_identity_cid)
    throw new Error(`room ${roomId} has no pinned room identity CID`);
  if (existing.workspace) {
    validateWorkspace(existing.workspace, taskId ? 'task' : 'room', taskId ?? roomId);
    ensureWorkspace(existing.workspace);
    for (const setting of settings.values()) setting.definition.cwd = existing.workspace.path;
  }
  const roomIdentityCid = existing.room_identity_cid;
  const ownerSeatCid = existing.owner_seat_cid ?? null;
  const roomPolicy = storedRoomLaunchPolicy(existing.room_policy);

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
    roomPolicy.anonymous,
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
    assertCoworkRoomPolicy(initialRoom, roomPolicy.anonymous);
    reconcileMemberSeats(roomId, members, initialRoom.seats, existing.owner_seat_cid);
    for (const member of members) {
      const task = tasks.get(member.name)!;
      const currentSeat = getRoomRecord(roomId)!.member_seats
        .find(seat => seat.role_name === member.name)!;
      if (currentSeat.seat_state === 'active') {
        if (!await retainRunningLaunch({
          provision: input, member, settings: settings.get(member.name)!, task, roomIdentityCid,
        })) {
          throw new Error(`active Cowork seat ${member.name} has no matching live Fleet launch`);
        }
        continue;
      }
      if (await retainRunningLaunch({
        provision: input, member, settings: settings.get(member.name)!, task, roomIdentityCid,
      })) continue;

      // A previous failed launch keeps its invite pointer durably. Never
      // overwrite that requirement until the supported revoke has succeeded;
      // a transport failure must fence subsequent invite issuance too.
      if (currentSeat.invite_id) {
        const observed = await cowork.getRoom(roomId);
        if (!observed || observed.identity_cid !== roomIdentityCid)
          throw new Error('cannot verify room before failed-attempt invite cleanup');
        if (observed.seats.some(seat => seat.invite_id === currentSeat.invite_id
          && seat.seat_state !== 'removed'))
          throw new Error('failed-attempt invite has an admitted seat; reconcile before replacing the member');
        await cowork.revokeInvite(roomId, currentSeat.invite_id);
      }

      const issued = await cowork.issueInvite(roomId, {
        mode: 'one_time', role: member.coworkRole, min_accepts: 1,
      });
      try {
        assertProvisioningOpen(input);
        const seats = getRoomRecord(roomId)!.member_seats.map(seat =>
          seat.role_name === member.name ? { ...seat, invite_id: issued.invite_id } : seat);
        updateMemberSeats(roomId, seats);
        await launchMember({
          provision: input,
          member,
          settings: settings.get(member.name)!,
          startup: {
            workspace: existing.workspace,
            room_id: roomId,
            room_identity_cid: roomIdentityCid,
            identity_name: member.name,
            invite_id: issued.invite_id,
            invite: issued.invite,
            role: member.coworkRole,
            task,
            owner_seat_cid: ownerSeatCid,
            anonymous: roomPolicy.anonymous,
          },
        });
      } catch (error) {
        try {
          await cowork.revokeInvite(roomId, issued.invite_id);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError],
            'member launch failed and invite cleanup is unresolved; retry must revoke the retained requirement first');
        }
        throw error;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setSagaError(roomId, reason,
      'Member invite or launch failed. Inspect role logs, then retry with `task start`.', 'member_failed');
    if (taskId) {
      // A deletion-pending (or already-terminal) task rejects the block
      // overlay; the original launch failure must still propagate.
      try { blockTask(taskId, reason); } catch (blockError) {
        if (!(blockError instanceof TaskStateError)) throw blockError;
      }
    }
    throw error;
  }

  advanceSaga(roomId, 'wait_seats', 5);
  const deadline = policy.now() + policy.timeoutMs;
  let delay = policy.initialDelayMs;
  for (;;) {
    const remote = await cowork.recoverRoom(roomId);
    assertCoworkRoomPolicy(remote, roomPolicy.anonymous);
    const reconciled = reconcileMemberSeats(roomId, members, remote.seats, ownerSeatCid ?? undefined);
    if (reconciled.complete && remote.state === 'active') break;
    if (policy.now() >= deadline) {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    }
    advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
    await policy.sleep(delay);
    delay = Math.min(policy.maxDelayMs, Math.max(delay + 1, delay * 2));
  }

  // Admission alone is insufficient: every expected member must still have
  // the exact live launch that owns its authenticated Cowork seat.
  for (const member of members) {
    if (!await retainRunningLaunch({
      provision: input, member, settings: settings.get(member.name)!,
      task: tasks.get(member.name)!, roomIdentityCid,
    })) throw new Error(`active Cowork seat ${member.name} has no matching live Fleet launch`);
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

/** Reconcile proven, admitted launches without any spawn, archive, invite or recovery path. */
export async function reconcileExistingTaskMembers(input: {
  taskId: string;
  checkOnly?: boolean;
  cowork: Pick<CoworkAdapter, 'getRoom'>;
  expectedLaunches: ReadonlyArray<{ role_name: string; launch_id: string; identity_cid: string }>;
}): Promise<RoomOrchestrationRecord> {
  return withFileLock(taskOperationLockPath(input.taskId), async () => {
    const task = getTask(input.taskId);
    if (!['provisioning', 'active'].includes(task.state) || task.terminal_intent || taskDeletionState(input.taskId) !== 'none'
      || !task.room_id) throw new Error('task is not open for existing-member reconciliation');
    const roomId = task.room_id;
    return withFileLock(roomCloseLockPath(roomId), async () => {
      const current = getRoomRecord(roomId);
      if (!current || !['provisioning', 'active'].includes(current.state) || current.close
        || current.task_id !== input.taskId || !current.room_identity_cid
        || task.room_identity_cid !== current.room_identity_cid)
        throw new Error('room is not open for existing-member reconciliation');
      const names = new Set(input.expectedLaunches.map(seat => seat.role_name));
      if (!names.size || names.size !== input.expectedLaunches.length
        || current.member_seats.length !== names.size
        || current.member_seats.some(seat => !names.has(seat.role_name)))
        throw new Error('expected launch roster does not match the persisted room');
      const remote = await input.cowork.getRoom(roomId);
      if (!remote || remote.room_id !== roomId || remote.identity_cid !== current.room_identity_cid
        || remote.state !== 'active') throw new Error('Cowork room is not the exact active room');
      assertCoworkRoomPolicy(remote, storedRoomLaunchPolicy(current.room_policy).anonymous);
      if (current.owner_seat_cid && !remote.seats.some(seat =>
        seat.identity_cid === current.owner_seat_cid && seat.seat_state === 'active'))
        throw new Error('expected Owner seat is not active');
      const seats: RoomMemberSeat[] = [];
      for (const seat of current.member_seats) {
        const expected = input.expectedLaunches.find(item => item.role_name === seat.role_name)!;
        const launch = seat.launch;
        if (seat.seat_state === 'removed' || !seat.invite_id || launch?.state !== 'launched'
          || launch.launch_id !== expected.launch_id || !launch.action_id || !launch.mission_sha256
          || (seat.identity_cid && seat.identity_cid !== expected.identity_cid))
          throw new Error('persisted member launch does not match reconciliation evidence');
        const dir = agentDir(seat.role_name, true);
        if (!launchMatches(dir, { name: seat.role_name, coworkRole: seat.cowork_role },
          launch.action_id, launch.mission_sha256, roomId, current.room_identity_cid,
          seat.invite_id, storedRoomLaunchPolicy(current.room_policy).anonymous))
          throw new Error('member startup provenance mismatch');
        const supervisor = readTempSupervisor(dir);
        if (!supervisor || supervisor.role !== seat.role_name || supervisor.launchId !== expected.launch_id
          || await tempSupervisorLiveness(dir) !== 'running')
          throw new Error('expected member supervisor is not running');
        const ready = readRoomReadiness(current.room_identity_cid, seat.role_name);
        const matches = remote.seats.filter(item => item.display_name === seat.role_name
          && item.seat_state !== 'removed');
        const found = matches[0];
        if (!ready || ready.room !== roomId || ready.invite !== seat.invite_id
          || ready.cid !== expected.identity_cid || matches.length !== 1 || !found
          || found.identity_cid !== expected.identity_cid || found.role !== seat.cowork_role
          || found.seat_state !== 'active' || found.invite_id !== seat.invite_id)
          throw new Error('member readiness or authenticated Cowork seat mismatch');
        seats.push({ ...seat, identity_cid: expected.identity_cid, seat_state: 'active' });
      }
      if (input.checkOnly) return current;
      // No mutation until the complete roster has passed; these writes are replayable
      // under the same task/room lifecycle locks if interrupted between files.
      updateMemberSeats(roomId, seats);
      updateTaskMembers(input.taskId, seats.map(seat => ({ name: seat.role_name,
        identity_cid: seat.identity_cid!, slot: seat.slot, cowork_role: seat.cowork_role })));
      if (getTask(input.taskId).blocked) unblockTask(input.taskId);
      if (current.state !== 'active') advanceSaga(roomId, 'activate', 6);
      const activated = current.state === 'active' ? getRoomRecord(roomId)! : activateRoom(roomId);
      if (task.state !== 'active') activateTask(input.taskId);
      return activated;
    }, {}, TASK_OPERATION_LOCK_STALE_MS);
  }, {}, TASK_OPERATION_LOCK_STALE_MS);
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
