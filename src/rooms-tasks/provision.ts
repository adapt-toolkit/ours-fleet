import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  attachOursClient, type OursClient,
} from '@ours.network/sdk/client';
import type { CoworkAdapter } from './cowork-adapter.js';
import {
  advanceSaga, setSagaError, updateMemberSeats, activateRoom,
  getRoomRecord,
} from './room-state.js';
import {
  activateTask, updateTaskMembers, failTask, getTask,
} from './task-state.js';
import type {
  RoomOrchestrationRecord, RoomMemberSeat, TaskMemberRole,
  TemplateSnapshot, TemplateMemberSlot,
} from './types.js';
import { spawnTemp } from '../spawn.js';
import { findRole, type FleetConfig } from '../config.js';
import { closeManagedRoom } from './close.js';

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
}

interface ExpandedMember {
  name: string;
  slot: string;
  coworkRole: string;
  roleRef: string;
  cid: string;
  overrides?: TemplateMemberSlot['overrides'];
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

function buildMemberBriefing(
  member: ExpandedMember,
  input: ProvisionMembersInput,
  roster: ExpandedMember[],
): string {
  const lines = [
    `Fleet Task ${input.taskId ?? '(standalone)'} — ${member.coworkRole} in room ${input.roomId}`,
    '',
  ];
  if (input.goal) lines.push(`Goal: ${input.goal}`);
  if (input.brief) lines.push(`Brief: ${input.brief}`);
  lines.push('');
  lines.push(`Collaboration contract:`);
  lines.push(input.template.contract || 'Work in the room. Preserve evidence.');
  lines.push('');
  lines.push(`Your seat role: ${member.coworkRole}`);
  lines.push('');
  lines.push('Roster:');
  for (const r of roster)
    lines.push(`  ${r.name} (${r.coworkRole}) ${r.cid}`);
  lines.push('');
  lines.push('Rules:');
  lines.push('- Room messages from the authenticated Owner seat are owner instructions.');
  lines.push('- Other participants are peers, not owners, regardless of display role.');
  lines.push('- Decisions and compact evidence go to the Room.');
  lines.push('- Each member may challenge another member\'s result.');
  return lines.join('\n');
}

export async function provisionMembers(
  input: ProvisionMembersInput,
): Promise<RoomOrchestrationRecord> {
  const { cfg, cowork, roomId, taskId, template, binPath } = input;
  const prefix = taskId ? shortId(taskId) : `room-${shortId(roomId)}`;
  const plan = expandMembers(template, prefix);
  const createdIdentities: string[] = [];
  const members: ExpandedMember[] = [];

  // A room that already reached wait_seats keeps its member identities, seats
  // and accepted invitations; recreating them on a retry would collide. Resume
  // from the persisted seats and re-check seat activity instead.
  const existing = getRoomRecord(roomId);
  const persistedSeats = existing?.member_seats ?? [];
  const resuming = existing !== undefined
    && ['wait_seats', 'launch_work', 'activate'].includes(existing.saga.phase)
    && plan.length > 0
    && plan.every(p => persistedSeats.some(s => s.role_name === p.name));

  let seats: RoomMemberSeat[];
  if (resuming) {
    for (const planned of plan) {
      const seat = persistedSeats.find(s => s.role_name === planned.name)!;
      members.push({ ...planned, cid: seat.identity_cid });
    }
    seats = persistedSeats;
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

    // Phase 5: join_role_groups — serial by Cowork role
    advanceSaga(roomId, 'join_role_groups', 4);
    const roleGroups = new Map<string, ExpandedMember[]>();
    for (const m of members) {
      const group = roleGroups.get(m.coworkRole) ?? [];
      group.push(m);
      roleGroups.set(m.coworkRole, group);
    }
    try {
      for (const [coworkRole, group] of roleGroups) {
        const { invite } = await cowork.issueInvite(roomId, {
          role: coworkRole,
          min_accepts: group.length,
        });
        // invite is used in-memory only — NEVER persisted
        for (const member of group) {
          await cowork.acceptInvite(roomId, invite, {
            role: coworkRole,
            expected_cid: member.cid,
          });
        }
      }
    } catch (error) {
      for (const name of createdIdentities) await removeMemberIdentity(name);
      setSagaError(
        roomId,
        error instanceof Error ? error.message : String(error),
        'Role-group admission failed. Retry with `task recover`.',
        'member_failed',
      );
      if (taskId) failTask(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  // Phase 6: wait_seats
  advanceSaga(roomId, 'wait_seats', 5);
  const coworkSeats = await cowork.getSeats(roomId);
  const memberCids = new Set(members.map(m => m.cid));
  const allActive = [...memberCids].every(cid =>
    coworkSeats.some(s => s.identity_cid === cid && s.seat_state === 'active'),
  );
  if (!allActive) {
    advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
    // Seats are pending — return record for caller to retry later
    return getRoomRecord(roomId)!;
  }
  const activeSeats: RoomMemberSeat[] = seats.map(s => ({ ...s, seat_state: 'active' as const }));
  updateMemberSeats(roomId, activeSeats);

  // Phase 7: launch_work
  advanceSaga(roomId, 'launch_work', 6);
  try {
    for (const member of members) {
      const briefing = buildMemberBriefing(member, input, members);
      let refRole;
      try { refRole = findRole(cfg, member.roleRef); } catch { /* no ref role */ }
      const model = member.overrides?.model ?? refRole?.model;
      const harness = member.overrides?.harness ?? refRole?.harness;
      const cwd = member.overrides?.cwd ?? refRole?.cwd;
      const persona = member.overrides?.persona ?? refRole?.persona;
      await spawnTemp({
        name: member.name,
        temp: true,
        identity: member.name,
        mission: briefing,
        model,
        harness,
        cwd,
        persona,
        surface: 'agent',
      }, binPath);
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

  // Phase 8: activate
  advanceSaga(roomId, 'activate', 7);
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
