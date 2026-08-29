import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse } from 'yaml';
import type { CoworkAdapter, CoworkSeatInfo } from './cowork-adapter.js';
import {
  advanceSaga, setSagaError, updateMemberSeats, updateMemberStartup,
  acknowledgeCheckpointedRoomRecovery, activateRoom, checkpointRoomRecovery, getRoomRecord,
  getRoomRecoveryReceipt, roomRecoveryDetail, bindCanonicalMemberPlan,
} from './room-state.js';
import {
  activateTask, updateTaskMembers, blockTask, unblockTask, getTask,
} from './task-state.js';
import type {
  RoomOrchestrationRecord, RoomMemberSeat, TaskMemberRole,
  TemplateSnapshot, TemplateMemberSlot,
} from './types.js';
import { spawnDryRun, spawnTemp } from '../spawn.js';
import type { SpawnOpts } from '../spawn.js';
import { findRole, type FleetConfig, type RoomMemberStartup } from '../config.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV,
  type ManagedFleetSpawnResult,
} from '../fleet-proxy.js';
import { controlRequest } from '../session/control.js';
import { SessionControlError } from '../session/types.js';
import { closeManagedRoom } from './close.js';
import { buildRoomMemberTask, sha256Text } from './member-startup.js';
import { agentDir, stateRoot } from '../paths.js';
import { daemonIdentityProvisioner, readProvenance } from '../creation.js';
import { createAgentProductionRuntime } from '../agent-production-runtime.js';
import {
  readTempSupervisor, secureStoppedTempArchive, tempArchiveForCreationAction,
  tempSupervisorLiveness,
} from '../temp-lifecycle.js';
import { withFileLock } from '../atomic-file.js';
import type { ConfigResourceSnapshot } from '../config-resource-loader.js';
import type { ExplicitBrainRoomTemplateMemberSpec } from '../config-resources.js';
import { reserveCanonicalRoomMemberPlan } from './member-plan.js';

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
  canonical?: Readonly<{
    snapshot: ConfigResourceSnapshot;
    templateId: string;
    members: readonly Readonly<ExplicitBrainRoomTemplateMemberSpec>[];
  }>;
  recoveryHooks?: { afterInviteIntent?(): void; afterInviteEffect?(): void };
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
  overrides?: TemplateMemberSlot['overrides'];
  canonical?: Readonly<ExplicitBrainRoomTemplateMemberSpec>;
  ordinal: number;
}

interface MemberSettings {
  model?: string;
  harness?: string;
  cwd?: string;
  persona?: string;
  approval?: SpawnOpts['approval'];
  filesystem?: SpawnOpts['filesystem'];
  unattended?: SpawnOpts['unattended'];
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
  canonical?: Readonly<{ runtime: ReturnType<typeof createAgentProductionRuntime> }>,
): Promise<RoomMemberSpawnResult> {
  const stateDir = process.env[FLEET_PROXY_STATE_DIR_ENV];
  if (!stateDir || canonical) {
    const runtime = canonical?.runtime ?? createAgentProductionRuntime({ trustedStateRoot: stateRoot(),
      identityProvisioner: daemonIdentityProvisioner() });
    const legacyPlan = canonical ? undefined : Object.freeze({ origin: 'direct' as const, options,
      preview: spawnDryRun(options) });
    return { statePath: await spawnTemp(options, binPath, undefined, {
      temporaryAgentCreation: { execute: async () => {
        if (!canonical) return runtime.create({ plan: legacyPlan!, actionId: options.creationActionId! });
        const resumed = runtime.resumeTemporaryComposition({
          agentId: options.name, actionId: options.creationActionId!,
        });
        return Object.freeze({ state: 'reserved' as const, agentId: resumed.handoff.agentId,
          generation: resumed.handoff.generation, actionId: resumed.handoff.actionId,
          lifetime: 'temporary' as const, completion: 'deferred' as const });
      } },
    }), creationActionId: options.creationActionId! };
  }

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
  canonical?: ProvisionMembersInput['canonical'],
): ExpandedMember[] {
  const result: ExpandedMember[] = [];
  const slots = canonical?.members ?? template.members;
  let ordinal = 0;
  for (const slot of slots) {
    for (let i = 1; i <= slot.count; i++) {
      ordinal += 1;
      result.push({
        name: `${prefix}-${slot.slot}-${i}`,
        slot: slot.slot,
        coworkRole: slot.role,
        roleRef: 'role_ref' in slot ? slot.role_ref : slot.role,
        ...('overrides' in slot ? { overrides: slot.overrides } : {}),
        ...(canonical ? { canonical: slot as ExplicitBrainRoomTemplateMemberSpec } : {}),
        ordinal,
      });
    }
  }
  return result;
}

function settingsFor(member: ExpandedMember, cfg: FleetConfig): MemberSettings {
  let refRole;
  try { refRole = findRole(cfg, member.roleRef); } catch { /* no ref role */ }
  const permissions = member.overrides?.permissions;
  return {
    model: member.overrides?.model ?? refRole?.model,
    harness: member.overrides?.harness ?? refRole?.harness,
    cwd: member.overrides?.cwd ?? refRole?.cwd,
    persona: member.overrides?.persona ?? refRole?.persona,
    approval: permissions?.approval as SpawnOpts['approval'],
    filesystem: permissions?.filesystem as SpawnOpts['filesystem'],
    unattended: permissions?.unattended as SpawnOpts['unattended'],
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
      && typeof role.mission === 'string'
      && sha256Text(role.mission) === taskSha
      && startup?.room_id === roomId
      && startup.room_identity_cid === roomIdentityCid
      && startup.identity_name === member.name
      && startup.role === member.coworkRole
      && startup.task === role.mission
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
  canonicalRuntime?: ReturnType<typeof createAgentProductionRuntime>;
}): Promise<void> {
  const { provision, member, settings, startup } = input;
  const seat = getRoomRecord(provision.roomId)!.member_seats
    .find(candidate => candidate.role_name === member.name)!;
  const actionId = seat.plan_binding?.action_id ?? randomUUID();
  let effectiveActionId: string = actionId;
  const attempt = (seat.launch?.attempt ?? 0) + 1;
  const taskSha = sha256Text(startup.task);
  const proxyCaller = process.env[FLEET_PROXY_STATE_DIR_ENV]
    ? process.env[FLEET_PROXY_CALLER_ENV] : undefined;
  updateMemberStartup(provision.roomId, member.name, { launch: {
    state: 'intent', attempt, action_id: actionId, mission_sha256: taskSha,
    ...(proxyCaller ? { caller_role: proxyCaller } : {}),
    updated_at: new Date().toISOString(),
  } });
  try {
    const launched = await spawnRoomMember({
      name: member.name,
      temp: true,
      identity: member.name,
      mission: startup.task,
      model: settings.model,
      harness: settings.harness,
      cwd: settings.cwd,
      approval: settings.approval,
      filesystem: settings.filesystem,
      unattended: settings.unattended,
      surface: 'agent',
      creationActionId: actionId,
      roomMemberStartup: startup,
    }, provision.binPath, input.canonicalRuntime ? { runtime: input.canonicalRuntime } : undefined);
    const launchedDir = launched.statePath;
    effectiveActionId = launched.creationActionId;
    if (launched.creationActionId !== actionId) {
      updateMemberStartup(provision.roomId, member.name, { launch: {
        state: 'intent', attempt, action_id: launched.creationActionId,
        mission_sha256: taskSha, updated_at: new Date().toISOString(),
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
      ...(launched.callerRole ? { caller_role: launched.callerRole } : {}),
      launch_id: supervisor.launchId, updated_at: new Date().toISOString(),
    } });
  } catch (error) {
    updateMemberStartup(provision.roomId, member.name, { launch: {
      state: 'failed', attempt, action_id: effectiveActionId, mission_sha256: taskSha,
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

async function provisionMembersLocked(
  input: ProvisionMembersInput,
): Promise<RoomOrchestrationRecord> {
  const { cfg, cowork, roomId, taskId, template } = input;
  const prefix = taskId ? shortId(taskId) : `room-${shortId(roomId)}`;
  const members = expandMembers(template, prefix, input.canonical);
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
    updateMemberSeats(roomId, members.map(member => ({
      role_name: member.name,
      slot: member.slot,
      cowork_role: member.coworkRole,
      seat_state: 'pending' as const,
      launch: { state: 'pending' as const, attempt: 0, updated_at: new Date().toISOString() },
    })));
  }

  const runtime = createAgentProductionRuntime({ trustedStateRoot: stateRoot(),
    identityProvisioner: daemonIdentityProvisioner() });
  const settings = new Map(members.map(member => [member.name, settingsFor(member, cfg)]));
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
      let currentSeat = getRoomRecord(roomId)!.member_seats
        .find(seat => seat.role_name === member.name)!;
      if (input.canonical) {
        if (!currentSeat.plan_binding) {
          const binding = await reserveCanonicalRoomMemberPlan(runtime, {
            snapshot: input.canonical.snapshot, templateId: input.canonical.templateId,
            member: member.canonical!, roomId, ...(taskId ? { taskId } : {}),
            memberId: member.name, identityName: member.name, ordinal: member.ordinal,
            actionId: randomUUID(), issuedAt: Date.now(),
          });
          await bindCanonicalMemberPlan(roomId, member.name, binding);
          currentSeat = getRoomRecord(roomId)!.member_seats
            .find(seat => seat.role_name === member.name)!;
        }
        const binding = currentSeat.plan_binding;
        if (!binding) throw new Error(`canonical member ${member.name} has no durable plan binding`);
        const resumed = runtime.resumeTemporaryComposition({
          agentId: binding.agent_id, actionId: binding.action_id,
        });
        if (resumed.handoff.generation !== binding.generation
            || resumed.handoff.planDigest !== binding.plan_digest
            || resumed.handoff.snapshotDigest !== binding.snapshot_digest
            || resumed.handoff.reservationDigest !== binding.reservation_digest
            || resumed.handoff.handoffDigest !== binding.handoff_digest
            || resumed.handoff.authorizationRevision !== binding.authorization_revision)
          throw new Error(`stored AgentPlan for ${member.name} does not match its durable seat binding`);
        settings.set(member.name, {
          harness: resumed.plan.brain.harness,
          model: resumed.plan.brain.model,
          cwd: resumed.plan.runtime?.scheduling?.cwd,
          persona: resumed.plan.role.effective.persona,
          approval: resumed.plan.permissions.approval as SpawnOpts['approval'],
          filesystem: resumed.plan.permissions.filesystem as SpawnOpts['filesystem'],
          unattended: resumed.plan.permissions.unattended as SpawnOpts['unattended'],
        });
      }
      if (currentSeat.seat_state === 'active') {
        if (!await retainRunningLaunch({
          provision: input, member, task, roomIdentityCid,
        })) {
          throw new Error(`active Cowork seat ${member.name} has no matching live Fleet launch`);
        }
        continue;
      }
      if (currentSeat.invite_attempt?.phase === 'invite_attempting'
          || (currentSeat.invite_attempt?.phase === 'invite_recorded'
            && currentSeat.launch?.state === 'pending')) {
        const seats = getRoomRecord(roomId)!.member_seats.map(seat => seat.role_name === member.name
          ? { ...seat, invite_attempt: { ...currentSeat.invite_attempt!,
            phase: 'invite_outcome_unknown' as const, updated_at: new Date().toISOString() } } : seat);
        updateMemberSeats(roomId, seats);
        throw new Error(`invite outcome for ${member.name} is unknown; automatic retry is disabled`);
      }
      if (currentSeat.invite_attempt?.phase === 'invite_outcome_unknown')
        throw new Error(`invite outcome for ${member.name} is unknown; automatic retry is disabled`);
      if (await retainRunningLaunch({ provision: input, member, task, roomIdentityCid })) continue;

      const inviteActionId = randomUUID();
      const inviteRequest = { room_id: roomId, role: member.coworkRole, mode: 'one_time' as const,
        min_accepts: 1 as const };
      updateMemberSeats(roomId, getRoomRecord(roomId)!.member_seats.map(seat =>
        seat.role_name === member.name ? { ...seat, invite_attempt: { phase: 'invite_attempting' as const,
          action_id: inviteActionId, request_digest: sha256Text(JSON.stringify(inviteRequest)),
          ...inviteRequest, updated_at: new Date().toISOString(),
          ...('keyHash' in input && typeof input.keyHash === 'string'
            ? { recovery_key_hash: input.keyHash } : {}) } } : seat));
      let issued;
      try {
        input.recoveryHooks?.afterInviteIntent?.();
        issued = await cowork.issueInvite(roomId, {
          mode: 'one_time', role: member.coworkRole, min_accepts: 1,
        });
        if (!issued || typeof issued.invite_id !== 'string' || !issued.invite_id
            || typeof issued.invite !== 'string' || !issued.invite || issued.min_accepts !== 1)
          throw new Error(`invalid invite receipt for ${member.name}`);
        input.recoveryHooks?.afterInviteEffect?.();
      } catch (error) {
        updateMemberSeats(roomId, getRoomRecord(roomId)!.member_seats.map(seat =>
          seat.role_name === member.name ? { ...seat, invite_attempt: { ...seat.invite_attempt!,
            phase: 'invite_outcome_unknown' as const, updated_at: new Date().toISOString() } } : seat));
        throw error;
      }
      updateMemberSeats(roomId, getRoomRecord(roomId)!.member_seats.map(seat =>
        seat.role_name === member.name ? { ...seat, invite_id: issued.invite_id,
          invite_attempt: { ...seat.invite_attempt!, phase: 'invite_recorded' as const,
            updated_at: new Date().toISOString() } } : seat));
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
          ...(input.canonical ? { canonicalRuntime: runtime } : {}),
        });
      } catch (error) {
        await cowork.revokeInvite(roomId, issued.invite_id).catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    const ambiguous = getRoomRecord(roomId)?.member_seats
      .find(seat => seat.invite_attempt?.phase === 'invite_outcome_unknown');
    const reason = ambiguous
      ? `invite outcome for ${ambiguous.role_name} is unknown; automatic retry is disabled`
      : error instanceof Error ? error.message : String(error);
    const hint = ambiguous
      ? 'Manually clean up or recreate the failed room/member before starting a new operation.'
      : 'Member invite or launch failed. Retry with `task recover`.';
    setSagaError(roomId, reason, hint, 'member_failed');
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

export async function provisionMembers(
  input: ProvisionMembersInput,
): Promise<RoomOrchestrationRecord> {
  return withFileLock(
    `${stateRoot()}/rooms/${encodeURIComponent(input.roomId)}.provision.lock`,
    () => provisionMembersLocked(input),
  );
}

/** Receipt-selected provisioning worker. Admission must already be durably journaled. */
export async function settleManagedRoomProvisionRecovery(input: ProvisionMembersInput & {
  keyHash: string; principalHash: string; requestHash: string;
  recoveryHooks?: { afterDurableState?(): void; afterCheckpoint?(): void };
}): Promise<RoomOrchestrationRecord> {
  return withFileLock(
    `${stateRoot()}/rooms/${encodeURIComponent(input.roomId)}.provision.lock`,
    async () => {
      const receipt = getRoomRecoveryReceipt(input.roomId, input.keyHash);
      if (!receipt || receipt.cursor.kind !== 'provision'
          || receipt.principalHash !== input.principalHash || receipt.requestHash !== input.requestHash)
        throw new Error('room recovery provisioning worker is unavailable');
      const currentCursor = roomRecoveryDetail(input.roomId).cursor;
      if (currentCursor.kind === 'provision'
          && currentCursor.bindingsDigest !== receipt.cursor.bindingsDigest)
        throw new Error('room recovery provisioning bindings changed');
      if (receipt.workerStatus === 'checkpointed') {
        acknowledgeCheckpointedRoomRecovery(input.roomId, input.keyHash);
        return getRoomRecord(input.roomId)!;
      }
      const room = await provisionMembersLocked(input);
      if (room.state !== 'active') return room;
      input.recoveryHooks?.afterDurableState?.();
      checkpointRoomRecovery(input.roomId, input.keyHash, { kind: 'provision',
        principalHash: input.principalHash, requestHash: input.requestHash });
      input.recoveryHooks?.afterCheckpoint?.();
      acknowledgeCheckpointedRoomRecovery(input.roomId, input.keyHash);
      return room;
    },
  );
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
