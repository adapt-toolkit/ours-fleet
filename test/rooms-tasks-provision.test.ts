import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cpSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock setup (vi.hoisted runs before vi.mock factories) ────────────────

const mocks = vi.hoisted(() => {
  const cidCounter = { n: 0 };
  const identities = new Map<string, string>();
  const mockCreateIdentity = vi.fn();
  const mockReleaseLease = vi.fn().mockResolvedValue(undefined);
  const mockRemoveIdentity = vi.fn().mockResolvedValue(undefined);
  const onRedeem = vi.fn();
  const mockAttachOursClient = vi.fn();
  const mockSpawnTemp = vi.fn();
  const mockTempLiveness = vi.fn().mockResolvedValue('running');
  const mockSecureArchive = vi.fn();
  const mockArchiveForAction = vi.fn();
  return {
    cidCounter,
    identities,
    onRedeem,
    mockAttachOursClient,
    mockCreateIdentity,
    mockRemoveIdentity,
    mockReleaseLease,
    mockSpawnTemp,
    mockTempLiveness,
    mockSecureArchive,
    mockArchiveForAction,
  };
});

vi.mock('@ours.network/sdk/client', () => ({
  attachOursClient: mocks.mockAttachOursClient,
}));

vi.mock('../src/spawn.js', () => ({
  spawnTemp: mocks.mockSpawnTemp,
}));

vi.mock('../src/temp-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/temp-lifecycle.js')>()),
  tempSupervisorLiveness: mocks.mockTempLiveness,
  secureStoppedTempArchive: mocks.mockSecureArchive,
  tempArchiveForCreationAction: mocks.mockArchiveForAction,
}));

// ── Imports (resolved after mock interception) ──────────────────────────

import { provisionMembers, cleanupMembers } from '../src/rooms-tasks/provision.js';
import {
  createRoomRecord, getRoomRecord, updateMemberSeats, updateRoomRoleBriefing,
} from '../src/rooms-tasks/room-state.js';
import {
  createTask, getTask,
} from '../src/rooms-tasks/task-state.js';
import type { CoworkAdapter, CoworkSeatInfo } from '../src/rooms-tasks/cowork-adapter.js';
import type { RoomHistoryEvidence, TemplateSnapshot } from '../src/rooms-tasks/types.js';
import type { FleetConfig, ResolvedRole } from '../src/config.js';
import {
  buildRoomMemberCharter, sha256Text,
} from '../src/rooms-tasks/member-startup.js';

// ── Helpers ─────────────────────────────────────────────────────────────

let dir: string;
let origHome: string | undefined;

function minimalCfg(overrides?: Partial<FleetConfig>): FleetConfig {
  return {
    roles: [],
    vars: {},
    defaults: {},
    files: ['test'],
    startStaggerMs: 0,
    diagnostics: [],
    watchdogs: [],
    loops: [],
    ...overrides,
  } as FleetConfig;
}

function makeTemplate(members: TemplateSnapshot['members'] = [
  { slot: 'developer', role: 'Developer', count: 2, role_ref: 'Dev' },
]): TemplateSnapshot {
  return {
    name: 'test-template',
    version: 1,
    description: 'Test template',
    members,
    content_hash: 'a'.repeat(64),
    contract: 'Work in the room. Preserve evidence.',
  };
}

let invitesIssued: string[];

function mockCoworkAdapter(opts?: {
  seatsActive?: boolean;
  issueInviteFail?: boolean;
  acceptInviteFail?: boolean;
  acknowledgeBriefings?: boolean;
  initialSeats?: Array<{ cid: string; role: string; invite_id?: string }>;
  relayStatus?: 'queued' | 'send_failed';
  setBriefingFail?: boolean;
  initialRoleBriefings?: Array<{ role: string; text: string; version: number }>;
  historyPrefixRawCount?: number;
  endlessRawBacklog?: boolean;
  observedInviteId?: string;
}): CoworkAdapter {
  invitesIssued = [];
  let inviteSeq = 0;
  let briefingSeq = 0;
  const admitted = new Map<string, string>();
  const admittedInvites = new Map<string, string>();
  const inviteRoles = new Map<string, { inviteId: string; role: string }>();
  for (const seat of opts?.initialSeats ?? []) {
    admitted.set(seat.cid, seat.role);
    admittedInvites.set(seat.cid, seat.invite_id ?? 'invite-1');
  }
  const briefings = new Map<string, { text: string; version: number }>();
  for (const briefing of opts?.initialRoleBriefings ?? [])
    briefings.set(briefing.role, { text: briefing.text, version: briefing.version });
  return {
    available: vi.fn().mockResolvedValue(true),
    createRoom: vi.fn().mockResolvedValue({
      room_id: 'room-test', room_name: 'Test', identity_name: 'room-id', identity_cid: 'room-cid',
    }),
    issueInvite: vi.fn().mockImplementation(async (_roomId, inviteOpts) => {
      if (opts?.issueInviteFail) throw new Error('invite issuance failed');
      const invite = `secret-invite-${++inviteSeq}`;
      const inviteId = `invite-${inviteSeq}`;
      invitesIssued.push(invite);
      inviteRoles.set(invite, { inviteId, role: inviteOpts.role });
      mocks.onRedeem.mockImplementation((name: string, redeemed: string) => {
        const metadata = inviteRoles.get(redeemed);
        if (!metadata) throw new Error('unexpected invite redemption');
        const cid = mocks.identities.get(name) ?? 'cid-001';
        admitted.set(cid, metadata.role);
        admittedInvites.set(cid, opts?.observedInviteId ?? metadata.inviteId);
        return metadata.inviteId;
      });
      return { invite, invite_id: inviteId, min_accepts: inviteOpts.min_accepts };
    }),
    acceptInvite: vi.fn().mockImplementation(async (_roomId, _invite, acceptOpts) => {
      if (opts?.acceptInviteFail) throw new Error('accept failed');
      admitted.set(acceptOpts.expected_cid, acceptOpts.role);
      return { seat_cid: acceptOpts.expected_cid, seat_state: 'active' as const };
    }),
    setRoleBriefing: vi.fn().mockImplementation(async (_roomId, briefing) => {
      if (opts?.setBriefingFail) throw new Error('briefing configuration failed');
      const version = (briefings.get(briefing.role)?.version ?? 0) + 1;
      briefings.set(briefing.role, { text: briefing.text, version });
      return {
        role: briefing.role, text: briefing.text, version,
        updated_at: '2026-08-24T00:00:00.000Z',
      };
    }),
    getHistory: vi.fn().mockImplementation(async (roomId, historyOpts) => {
      if (opts?.seatsActive === false) return {
        records: [], raw_count: 0, next_after: historyOpts?.after ?? 0,
      };
      const records: RoomHistoryEvidence[] = [];
      let seq = 0;
      for (const [cid, role] of admitted) {
        const persisted = getRoomRecord(roomId)?.role_briefings?.[role];
        const briefing = briefings.get(role) ?? (persisted?.version ? {
          text: persisted.text, version: persisted.version,
        } : undefined);
        if (!briefing) continue;
        const messageId = `briefing-${role}-${cid}`;
        const intentId = `intent-${role}-${cid}`;
        records.push({
          kind: 'message', seq: ++seq, record_id: `record-${seq}`,
          at: '2026-08-24T00:00:00.000Z', message_id: messageId,
          category: 'role_briefing',
          author: { identity: 'room-cid', display_name: 'Room', role: 'room' },
          text: briefing.text, recipient_identities: [cid],
          briefing_role: role, briefing_version: briefing.version,
        });
        records.push({
          kind: 'relay_intent', seq: ++seq, record_id: intentId,
          at: '2026-08-24T00:00:01.000Z', message_id: messageId,
          recipient_identity: cid,
        });
        records.push({
          kind: 'relay_result', seq: ++seq, record_id: `record-${seq}`,
          at: '2026-08-24T00:00:02.000Z', intent_record_id: intentId,
          message_id: messageId, recipient_identity: cid,
          status: opts?.relayStatus ?? 'queued',
          ...(opts?.relayStatus === 'send_failed' ? {} : { wire_id: `wire-${cid}` }),
        });
        if (opts?.acknowledgeBriefings !== false) {
          records.push({
            kind: 'message', seq: ++seq, record_id: `record-${seq}`,
            at: '2026-08-24T00:00:03.000Z', message_id: `ack-${cid}`,
            category: 'chat',
            author: { identity: cid, display_name: cid, role },
            text: JSON.stringify({
              kind: 'fleet_room_briefing_ack', schema_version: 1,
              room_id: roomId, room_identity_cid: 'room-cid',
              briefing_role: role, briefing_version: briefing.version,
              briefing_sha256: sha256Text(briefing.text),
              briefing_message_id: messageId, owner_seat_cid: null,
              accepted: true, applied: true, profile_applied: true,
            }),
            recipient_identities: ['room-cid'],
          });
        }
      }
      const after = historyOpts?.after ?? 0;
      if (opts?.endlessRawBacklog) return {
        records: [], raw_count: 200, next_after: after + 200,
      };
      const prefix = opts?.historyPrefixRawCount ?? 0;
      if (after < prefix) return {
        records: [], raw_count: Math.min(historyOpts?.limit ?? 200, prefix - after),
        next_after: prefix,
      };
      const shifted = records.map(record => ({ ...record, seq: record.seq + prefix }));
      const page = shifted.filter(record => record.seq > after).slice(0, historyOpts?.limit ?? 200);
      return {
        records: page, raw_count: page.length,
        next_after: page.at(-1)?.seq ?? after,
      };
    }),
    getRoom: vi.fn().mockImplementation(async roomId => {
      const persisted = getRoomRecord(roomId)?.role_briefings ?? {};
      const roles = new Set([...briefings.keys(), ...Object.keys(persisted)]);
      return {
        room_id: roomId, identity_name: 'room-id', identity_cid: 'room-cid',
        room_name: 'Test', state: 'active' as const,
        seats: [...admitted].map(([identity_cid, role]) => ({
          identity_cid, role, seat_state: 'active' as const,
          invite_id: admittedInvites.get(identity_cid),
        })),
        role_briefings: Object.fromEntries([...roles].flatMap(role => {
          const briefing = briefings.get(role);
          const local = persisted[role];
          const version = briefing?.version ?? local?.version;
          return version ? [[role, {
            role, text: briefing?.text ?? local.text, version,
            updated_at: '2026-08-24T00:00:00.000Z',
          }]] : [];
        })),
      };
    }),
    listRooms: vi.fn().mockResolvedValue([]),
    closeRoom: vi.fn().mockResolvedValue(undefined),
    getSeats: vi.fn().mockImplementation(async () => {
      if (opts?.seatsActive === false) return [];
      return [...admitted].map(([identity_cid, role]) => ({
        identity_cid,
        role,
        seat_state: 'active' as const,
        invite_id: admittedInvites.get(identity_cid),
      }));
    }),
    recoverRoom: vi.fn().mockImplementation(async roomId => ({
      room_id: roomId, identity_name: 'room-id', identity_cid: 'room-cid',
      room_name: 'Test', state: 'active',
      seats: [...admitted].map(([identity_cid, role]) => ({
        identity_cid, role, seat_state: 'active' as const,
        invite_id: admittedInvites.get(identity_cid),
      })),
      role_briefings: {},
    })),
  };
}

function stateDir(): string { return join(dir, 'state'); }

function createProvisionRoom(input: Parameters<typeof createRoomRecord>[0]) {
  return createRoomRecord({ room_identity_cid: 'room-cid', ...input });
}

function archivedCopy(roleName: string): string {
  const live = join(dir, '.ours-fleet', 'tmp', roleName);
  const archive = join(dir, '.ours-fleet', 'archive', `archive-${roleName}`);
  mkdirSync(join(dir, '.ours-fleet', 'archive'), { recursive: true });
  cpSync(live, archive, { recursive: true });
  rmSync(live, { recursive: true, force: true });
  return archive;
}

function allStateFiles(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!require('node:fs').existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(stateDir());
  return files;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-prov-'));
  origHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = dir;
  mocks.cidCounter.n = 0;
  mocks.identities.clear();
  vi.clearAllMocks();

  mocks.mockCreateIdentity.mockImplementation(async ({ name }: { name: string }) => {
    const cid = `cid-${String(++mocks.cidCounter.n).padStart(3, '0')}`;
    mocks.identities.set(name, cid);
    return { info: { cid } };
  });
  mocks.mockReleaseLease.mockResolvedValue(undefined);
  mocks.mockRemoveIdentity.mockResolvedValue(undefined);
  mocks.mockAttachOursClient.mockImplementation(async () => {
    let boundName = '';
    return {
      createIdentity: mocks.mockCreateIdentity,
      removeIdentity: mocks.mockRemoveIdentity,
      releaseLease: mocks.mockReleaseLease,
      chooseIdentity: vi.fn(async ({ name }: { name: string }) => {
        boundName = name;
        return { name, cid: mocks.identities.get(name) ?? 'cid-001' };
      }),
      addContact: vi.fn(async ({ invite }: { invite: string }) => {
        mocks.onRedeem(boundName, invite);
        return { cid: 'room-cid', display: 'Room' };
      }),
    };
  });
  mocks.mockSpawnTemp.mockImplementation(async (opts) => {
    const roleDir = join(dir, '.ours-fleet', 'tmp', opts.name);
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'role.yaml'), JSON.stringify({
      identity: opts.identity, mission: opts.mission, roomStartupGate: opts.roomStartupGate,
    }));
    writeFileSync(join(roleDir, 'creation.json'), JSON.stringify({
      creationActionId: opts.creationActionId, role: opts.name,
    }));
    writeFileSync(join(roleDir, '.temp-supervisor.json'), JSON.stringify({
      version: 1, role: opts.name, launchId: `launch-${opts.name}`,
      createdAt: new Date().toISOString(), phase: 'launching',
    }));
    return roleDir;
  });
  mocks.mockTempLiveness.mockResolvedValue('running');
  mocks.mockSecureArchive.mockReset();
  mocks.mockArchiveForAction.mockReset();
});

afterEach(() => {
  if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
  else delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('provision saga', () => {
  describe('provisionMembers — happy path', () => {
    it('creates identities, admits to cowork, spawns agents, activates room+task', async () => {
      const template = makeTemplate();
      const cowork = mockCoworkAdapter();
      const task = createTask({ title: 'Test', origin: { type: 'cli' } });
      createProvisionRoom({ room_id: 'room-1', room_name: 'Room 1', task_id: task.task_id });

      const result = await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-1',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
        brief: 'Test brief',
        goal: 'Test goal',
      });

      expect(result.state).toBe('active');
      expect(result.saga.phase).toBe('completed');
      expect(result.member_seats).toHaveLength(2);
      expect(result.member_seats[0].identity_cid).toBe('cid-001');
      expect(result.member_seats[1].identity_cid).toBe('cid-002');
      expect(result.member_seats[0].seat_state).toBe('active');

      const t = getTask(task.task_id);
      expect(t.state).toBe('active');
      expect(t.member_roles).toHaveLength(2);
      expect(t.member_roles[0].identity_cid).toBe('cid-001');

      expect(mocks.mockCreateIdentity).toHaveBeenCalledTimes(2);
      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(2);
    });

    it('works for standalone room without task', async () => {
      const template = makeTemplate([
        { slot: 'analyst', role: 'Analyst', count: 1, role_ref: 'Analyst' },
      ]);
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-2', room_name: 'Standalone' });

      const result = await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-2',
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(result.state).toBe('active');
      expect(result.member_seats).toHaveLength(1);
    });
  });

  describe('template expansion', () => {
    it('expands members with correct names and counts', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 2, role_ref: 'Dev' },
        { slot: 'reviewer', role: 'Reviewer', count: 1, role_ref: 'Rev' },
      ]);
      const cowork = mockCoworkAdapter();
      const task = createTask({ title: 'Expand', origin: { type: 'cli' } });
      createProvisionRoom({ room_id: 'room-exp', room_name: 'Expand', task_id: task.task_id });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-exp',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      const room = getRoomRecord('room-exp')!;
      expect(room.member_seats).toHaveLength(3);
      const names = room.member_seats.map(s => s.role_name);
      expect(names).toEqual(expect.arrayContaining([
        expect.stringContaining('-dev-1'),
        expect.stringContaining('-dev-2'),
        expect.stringContaining('-reviewer-1'),
      ]));

      const t = getTask(task.task_id);
      expect(t.member_roles).toHaveLength(3);
    });
  });

  describe('concurrent exact-provenance admission', () => {
    it('admits a multi-role team concurrently with one exact invite per role', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 2, role_ref: 'Dev' },
        { slot: 'reviewer', role: 'Reviewer', count: 1, role_ref: 'Rev' },
      ]);
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-grp', room_name: 'Group' });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-grp',
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(cowork.issueInvite).toHaveBeenCalledTimes(2);
      const devCall = (cowork.issueInvite as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => (c[1] as { role: string }).role === 'Developer',
      );
      expect(devCall).toBeDefined();
      expect((devCall![1] as { min_accepts: number }).min_accepts).toBe(2);

      expect(cowork.acceptInvite).not.toHaveBeenCalled();
      expect(mocks.onRedeem).toHaveBeenCalledTimes(3);
      const issueOrder = (cowork.issueInvite as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      const redeemOrder = mocks.onRedeem.mock.invocationCallOrder;
      const reconcileOrder = (cowork.recoverRoom as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      expect(issueOrder[1]).toBeLessThan(redeemOrder[0]);
      expect(redeemOrder.at(-1)).toBeLessThan(reconcileOrder[0]);
    });

    it('admits a two-role pair without serializing either invite', async () => {
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-pair', room_name: 'Pair' });

      await provisionMembers({
        cfg: minimalCfg(), cowork, roomId: 'room-pair',
        template: makeTemplate([
          { slot: 'builder', role: 'Builder', count: 1, role_ref: 'Build' },
          { slot: 'reviewer', role: 'Reviewer', count: 1, role_ref: 'Review' },
        ]),
        binPath: '/usr/bin/ours-fleet',
      });

      const issues = (cowork.issueInvite as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      const redeems = mocks.onRedeem.mock.invocationCallOrder;
      expect(issues).toHaveLength(2);
      expect(issues[1]).toBeLessThan(redeems[0]);
      expect(cowork.recoverRoom).toHaveBeenCalledTimes(1);
    });

    it('rejects Cowork observation whose authenticated origin is another invite', async () => {
      const cowork = mockCoworkAdapter({ observedInviteId: 'different-invite' });
      createProvisionRoom({ room_id: 'room-origin-mismatch', room_name: 'Mismatch' });

      await expect(provisionMembers({
        cfg: minimalCfg(), cowork, roomId: 'room-origin-mismatch', template: makeTemplate(),
        binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow(/admission provenance mismatch/);
    });
  });

  describe('invite security', () => {
    it('invite material never appears in persisted state files', async () => {
      const template = makeTemplate();
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-sec', room_name: 'Secure' });
      const task = createTask({ title: 'Secure', origin: { type: 'cli' } });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-sec',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(invitesIssued.length).toBeGreaterThan(0);
      for (const filePath of allStateFiles()) {
        const content = readFileSync(filePath, 'utf8');
        for (const invite of invitesIssued) {
          expect(content).not.toContain(invite);
        }
      }
    });
  });

  describe('wait_seats — seats not yet active', () => {
    it('returns early with waiting_seats detail', async () => {
      const template = makeTemplate();
      const cowork = mockCoworkAdapter({ seatsActive: false });
      createProvisionRoom({ room_id: 'room-wait', room_name: 'Wait' });

      const result = await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-wait',
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(result.state).toBe('provisioning');
      expect(result.provisioning_detail).toBe('waiting_seats');
      expect(result.saga.phase).toBe('wait_seats');
      expect(mocks.mockSpawnTemp).not.toHaveBeenCalled();
    });

    it('resumes from wait_seats without recreating identities or reissuing invites', async () => {
      const template = makeTemplate();
      const task = createTask({ title: 'Resume', origin: { type: 'cli' } });
      createProvisionRoom({ room_id: 'room-resume', room_name: 'Resume', task_id: task.task_id });

      const first = mockCoworkAdapter({ seatsActive: false });
      const waiting = await provisionMembers({
        cfg: minimalCfg(),
        cowork: first,
        roomId: 'room-resume',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
      });
      expect(waiting.saga.phase).toBe('wait_seats');
      expect(mocks.mockCreateIdentity).toHaveBeenCalledTimes(2);
      const persisted = waiting.member_seats.map(s => s.identity_cid);

      const second = mockCoworkAdapter({
        initialSeats: persisted.map(cid => ({ cid, role: 'Developer' })),
      });
      const resumed = await provisionMembers({
        cfg: minimalCfg(),
        cowork: second,
        roomId: 'room-resume',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(resumed.state).toBe('active');
      expect(resumed.saga.phase).toBe('completed');
      expect(resumed.member_seats.map(s => s.identity_cid)).toEqual(persisted);
      expect(resumed.member_seats.every(s => s.seat_state === 'active')).toBe(true);
      // The retained identities, seats and invitations are reused, not redone.
      expect(mocks.mockCreateIdentity).toHaveBeenCalledTimes(2);
      expect(second.issueInvite).not.toHaveBeenCalled();
      expect(second.acceptInvite).not.toHaveBeenCalled();
      // Agents launch exactly once, on the run that saw the seats go active.
      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(2);
      expect(getTask(task.task_id).state).toBe('active');
    });
  });

  describe('briefing readiness gate', () => {
    it('advances through a fully filtered raw history page to later ACK evidence', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const cowork = mockCoworkAdapter({ historyPrefixRawCount: 200 });
      createProvisionRoom({ room_id: 'room-paged', room_name: 'Paged' });
      const result = await provisionMembers({
        cfg: minimalCfg(), cowork, roomId: 'room-paged', template,
        binPath: '/usr/bin/ours-fleet',
      });
      expect(result.state).toBe('active');
      expect(result.history_cursor).toBeGreaterThan(200);
    });

    it('fails visibly while preserving cursor progress across an oversized raw backlog', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-backlog', room_name: 'Backlog' });
      await expect(provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({ endlessRawBacklog: true }),
        roomId: 'room-backlog', template, binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow('history backlog exceeded 20,000 raw records');
      const room = getRoomRecord('room-backlog')!;
      expect(room.history_cursor).toBe(20_000);
      expect(room.provisioning_detail).toBe('uncertain');
      expect(room.saga.error).toContain('cursor progress was preserved');
    });

    it('adopts an exact remote role definition after a crash before local version persist', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-remote-adopt', room_name: 'Remote adopt' });
      const text = buildRoomMemberCharter({
        roomId: 'room-remote-adopt', roomIdentityCid: 'room-cid', ownerSeatCid: null,
        contract: template.contract,
        member: { role_name: 'room-room-rem-dev-1', cowork_role: 'Developer', identity_cid: 'cid-001' },
        roster: [{ role_name: 'room-room-rem-dev-1', cowork_role: 'Developer', identity_cid: 'cid-001' }],
      });
      updateMemberSeats('room-remote-adopt', [{
        role_name: 'room-room-rem-dev-1', identity_cid: 'cid-001', slot: 'dev',
        cowork_role: 'Developer', seat_state: 'pending',
      }]);
      updateRoomRoleBriefing('room-remote-adopt', 'Developer', {
        role: 'Developer', text, sha256: sha256Text(text), state: 'pending',
        attempts: 1, updated_at: '2026-08-24T00:00:00.000Z',
      });
      const cowork = mockCoworkAdapter({
        initialRoleBriefings: [{ role: 'Developer', text, version: 4 }],
      });
      const result = await provisionMembers({
        cfg: minimalCfg(), cowork, roomId: 'room-remote-adopt', template,
        binPath: '/usr/bin/ours-fleet',
      });
      expect(result.role_briefings?.Developer.version).toBe(4);
      expect(cowork.setRoleBriefing).not.toHaveBeenCalled();
    });

    it('fails closed when current Cowork role briefing drifted externally', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-drift', room_name: 'Drift' });
      let clock = 0;
      const waiting = await provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({ acknowledgeBriefings: false }),
        roomId: 'room-drift', template, binPath: '/usr/bin/ours-fleet',
        startupWait: {
          timeoutMs: 1, initialDelayMs: 1, maxDelayMs: 1,
          now: () => clock, sleep: async ms => { clock += ms; },
        },
      });
      const cid = waiting.member_seats[0].identity_cid;
      await expect(provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({
          initialSeats: [{ cid, role: 'Developer' }],
          initialRoleBriefings: [{ role: 'Developer', text: 'external drift', version: 2 }],
        }),
        roomId: 'room-drift', template, binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow('Cowork current role briefing drift');
    });

    it('fails closed when an expected CID occupies the wrong Cowork role', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-role-spoof', room_name: 'Role spoof' });
      await expect(provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({
          initialSeats: [{ cid: 'cid-001', role: 'Owner' }],
        }),
        roomId: 'room-role-spoof', template, binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow(/has role Owner; expected Developer/);
    });

    it('requires and verifies an exact archive before replacing a disappeared launch', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-launch-archive', room_name: 'Launch archive' });
      let clock = 0;
      const waiting = await provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({ acknowledgeBriefings: false }),
        roomId: 'room-launch-archive', template, binPath: '/usr/bin/ours-fleet',
        startupWait: {
          timeoutMs: 1, initialDelayMs: 1, maxDelayMs: 1,
          now: () => clock, sleep: async ms => { clock += ms; },
        },
      });
      const seat = waiting.member_seats[0];
      const archive = archivedCopy(seat.role_name);
      mocks.mockSecureArchive.mockResolvedValueOnce(archive);
      const recovered = await provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({
          initialSeats: [{ cid: seat.identity_cid, role: seat.cowork_role }],
          historyPrefixRawCount: waiting.history_cursor ?? 0,
        }),
        roomId: 'room-launch-archive', template, binPath: '/usr/bin/ours-fleet',
      });
      expect(recovered.state).toBe('active');
      expect(mocks.mockSecureArchive).toHaveBeenCalledWith(
        seat.role_name, seat.launch?.launch_id,
      );
      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(2);
      expect(recovered.member_seats[0].launch?.attempt).toBe(2);
    });

    it('fails closed on an intent whose live directory disappeared without exact archive proof', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-intent-gap', room_name: 'Intent gap' });
      const roleName = 'room-room-int-dev-1';
      const text = buildRoomMemberCharter({
        roomId: 'room-intent-gap', roomIdentityCid: 'room-cid', ownerSeatCid: null,
        contract: template.contract,
        member: { role_name: roleName, cowork_role: 'Developer', identity_cid: 'cid-001' },
        roster: [{ role_name: roleName, cowork_role: 'Developer', identity_cid: 'cid-001' }],
      });
      updateMemberSeats('room-intent-gap', [{
        role_name: roleName, identity_cid: 'cid-001', slot: 'dev',
        cowork_role: 'Developer', seat_state: 'active', admission_invite_id: 'invite-1',
        launch: {
          state: 'intent', attempt: 1, action_id: 'action-crash',
          mission_sha256: '0'.repeat(64), updated_at: '2026-08-24T00:00:00.000Z',
        },
        briefing: { role: 'Developer', state: 'pending', rejected_ack_count: 0 },
      }]);
      updateRoomRoleBriefing('room-intent-gap', 'Developer', {
        role: 'Developer', text, sha256: sha256Text(text), version: 1,
        state: 'configured', attempts: 1, updated_at: '2026-08-24T00:00:00.000Z',
      });
      await expect(provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({
          initialSeats: [{ cid: 'cid-001', role: 'Developer' }],
          initialRoleBriefings: [{ role: 'Developer', text, version: 1 }],
        }),
        roomId: 'room-intent-gap', template, binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow('no exact live or terminated archive evidence');
      expect(mocks.mockArchiveForAction).toHaveBeenCalledWith(roleName, 'action-crash');
      expect(mocks.mockSpawnTemp).not.toHaveBeenCalled();
    });

    it('recovers an intent from one exact terminated creation-action archive', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      createProvisionRoom({ room_id: 'room-intent-archive', room_name: 'Intent archive' });
      const roleName = 'room-room-int-dev-1';
      const text = buildRoomMemberCharter({
        roomId: 'room-intent-archive', roomIdentityCid: 'room-cid', ownerSeatCid: null,
        contract: template.contract,
        member: { role_name: roleName, cowork_role: 'Developer', identity_cid: 'cid-001' },
        roster: [{ role_name: roleName, cowork_role: 'Developer', identity_cid: 'cid-001' }],
      });
      const gate = {
        room_id: 'room-intent-archive', room_identity_cid: 'room-cid',
        briefing_role: 'Developer', briefing_version: 1,
        briefing_sha256: sha256Text(text), owner_seat_cid: null,
      };
      const mission = 'Complete the dedicated room startup gate in briefing.md before readiness. '
        + `Expected room ${gate.room_id} (${gate.room_identity_cid}), role Developer, `
        + `briefing version 1, sha256 ${gate.briefing_sha256}.`;
      await mocks.mockSpawnTemp({
        name: roleName, identity: roleName, mission, roomStartupGate: gate,
        creationActionId: 'action-archived',
      });
      const archive = archivedCopy(roleName);
      mocks.mockSpawnTemp.mockClear();
      mocks.mockArchiveForAction.mockReturnValueOnce({ path: archive, launchId: `launch-${roleName}` });
      updateMemberSeats('room-intent-archive', [{
        role_name: roleName, identity_cid: 'cid-001', slot: 'dev',
        cowork_role: 'Developer', seat_state: 'active', admission_invite_id: 'invite-1',
        launch: {
          state: 'intent', attempt: 1, action_id: 'action-archived',
          mission_sha256: sha256Text(mission), updated_at: '2026-08-24T00:00:00.000Z',
        },
        briefing: { role: 'Developer', state: 'pending', rejected_ack_count: 0 },
      }]);
      updateRoomRoleBriefing('room-intent-archive', 'Developer', {
        role: 'Developer', text, sha256: sha256Text(text), version: 1,
        state: 'configured', attempts: 1, updated_at: '2026-08-24T00:00:00.000Z',
      });
      const result = await provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({
          initialSeats: [{ cid: 'cid-001', role: 'Developer' }],
          initialRoleBriefings: [{ role: 'Developer', text, version: 1 }],
        }),
        roomId: 'room-intent-archive', template, binPath: '/usr/bin/ours-fleet',
      });
      expect(result.state).toBe('active');
      expect(result.member_seats[0].launch?.attempt).toBe(2);
      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(1);
      const retriedAction = mocks.mockSpawnTemp.mock.calls[0][0].creationActionId;
      expect(retriedAction).not.toBe('action-archived');
    });

    it('keeps a timed-out ACK wait nonterminal and resumes without relaunching', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const task = createTask({ title: 'ACK recovery', origin: { type: 'cli' } });
      createProvisionRoom({
        room_id: 'room-ack-wait', room_name: 'ACK wait', task_id: task.task_id,
      });
      let clock = 0;
      const first = mockCoworkAdapter({ acknowledgeBriefings: false });
      const waiting = await provisionMembers({
        cfg: minimalCfg(), cowork: first, roomId: 'room-ack-wait', taskId: task.task_id,
        template, binPath: '/usr/bin/ours-fleet',
        startupWait: {
          timeoutMs: 1, initialDelayMs: 1, maxDelayMs: 1,
          now: () => clock, sleep: async ms => { clock += ms; },
        },
      });

      expect(waiting.state).toBe('provisioning');
      expect(waiting.saga.phase).toBe('wait_briefing_acks');
      expect(waiting.provisioning_detail).toBe('waiting_briefing_acks');
      expect(waiting.member_seats[0].briefing?.state).toBe('relay_queued');
      expect(getTask(task.task_id).state).toBe('provisioning');
      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(1);

      const cid = waiting.member_seats[0].identity_cid;
      const second = mockCoworkAdapter({ initialSeats: [{ cid, role: 'Developer' }] });
      const resumed = await provisionMembers({
        cfg: minimalCfg(), cowork: second, roomId: 'room-ack-wait', taskId: task.task_id,
        template, binPath: '/usr/bin/ours-fleet',
      });
      expect(resumed.state).toBe('active');
      expect(resumed.member_seats[0].briefing?.state).toBe('acknowledged');
      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(1);
    });

    it('blocks on terminal Cowork send_failed evidence', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const task = createTask({ title: 'Relay failure', origin: { type: 'cli' } });
      createProvisionRoom({
        room_id: 'room-relay-fail', room_name: 'Relay failure', task_id: task.task_id,
      });

      const result = await provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter({ relayStatus: 'send_failed' }),
        roomId: 'room-relay-fail', taskId: task.task_id, template,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(result.state).toBe('provisioning');
      expect(result.saga.phase).toBe('wait_briefing_acks');
      expect(result.provisioning_detail).toBe('briefing_delivery_failed');
      expect(result.member_seats[0].briefing?.state).toBe('relay_failed');
      expect(getTask(task.task_id).state).toBe('provisioning');
      expect(getTask(task.task_id).blocked?.reason).toContain('terminal send_failed');
    });

    it('persists a retryable configure_briefings failure before admission', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const cowork = mockCoworkAdapter({ setBriefingFail: true });
      createProvisionRoom({ room_id: 'room-config-fail', room_name: 'Config failure' });

      await expect(provisionMembers({
        cfg: minimalCfg(), cowork, roomId: 'room-config-fail', template,
        binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow('briefing configuration failed');
      const room = getRoomRecord('room-config-fail')!;
      expect(room.saga.phase).toBe('configure_briefings');
      expect(room.role_briefings?.Developer.state).toBe('failed');
      expect(room.role_briefings?.Developer.attempts).toBe(1);
      expect(cowork.issueInvite).not.toHaveBeenCalled();
    });
  });

  describe('failure rollback', () => {
    it('rolls back created identities when later identity creation fails', async () => {
      mocks.mockCreateIdentity
        .mockResolvedValueOnce({ info: { cid: 'cid-ok-1' } })
        .mockRejectedValueOnce(new Error('SDK unavailable'));

      const template = makeTemplate();
      const cowork = mockCoworkAdapter();
      const task = createTask({ title: 'Fail', origin: { type: 'cli' } });
      createProvisionRoom({ room_id: 'room-fail', room_name: 'Fail', task_id: task.task_id });

      await expect(provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-fail',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow('SDK unavailable');

      const room = getRoomRecord('room-fail')!;
      expect(room.saga.error).toBe('SDK unavailable');
      expect(room.provisioning_detail).toBe('member_failed');

      const t = getTask(task.task_id);
      expect(t.state).toBe('failed');
      expect(t.outcome!.summary).toBe('SDK unavailable');

      const removeCalls = mocks.mockAttachOursClient.mock.results
        .filter((r: { type: string }) => r.type === 'return');
      const removeCallArgs = (mocks.mockRemoveIdentity as ReturnType<typeof vi.fn>).mock.calls;
      expect(removeCallArgs.length).toBeGreaterThanOrEqual(1);
    });

    it('retains durable identities and resumes when cowork admission fails', async () => {
      const template = makeTemplate();
      const cowork = mockCoworkAdapter({ issueInviteFail: true });
      const task = createTask({ title: 'Admit fail', origin: { type: 'cli' } });
      createProvisionRoom({ room_id: 'room-admit', room_name: 'Admit', task_id: task.task_id });

      await expect(provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-admit',
        taskId: task.task_id,
        template,
        binPath: '/usr/bin/ours-fleet',
      })).rejects.toThrow('invite issuance failed');

      const room = getRoomRecord('room-admit')!;
      expect(room.saga.error).toBe('invite issuance failed');
      expect(room.provisioning_detail).toBe('member_failed');
      expect(room.member_seats).toHaveLength(2);

      const t = getTask(task.task_id);
      expect(t.state).toBe('provisioning');
      expect(t.blocked?.reason).toBe('invite issuance failed');
      expect(mocks.mockRemoveIdentity).not.toHaveBeenCalled();

      const recovered = await provisionMembers({
        cfg: minimalCfg(), cowork: mockCoworkAdapter(), roomId: 'room-admit',
        taskId: task.task_id, template, binPath: '/usr/bin/ours-fleet',
      });
      expect(recovered.state).toBe('active');
      expect(mocks.mockCreateIdentity).toHaveBeenCalledTimes(2);
      expect(getTask(task.task_id).blocked).toBeUndefined();
    });
  });

  describe('member briefing content', () => {
    it('stores the full charter in Cowork and launches with only gate coordinates', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-brief', room_name: 'Brief' });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-brief',
        template,
        binPath: '/usr/bin/ours-fleet',
        brief: 'Implement feature X',
        goal: 'Ship feature X',
      });

      expect(cowork.setRoleBriefing).toHaveBeenCalledTimes(1);
      const briefingCall = (cowork.setRoleBriefing as ReturnType<typeof vi.fn>).mock.calls[0];
      const briefing = (briefingCall[1] as { text: string }).text;
      expect(briefing).toContain('Ship feature X');
      expect(briefing).toContain('Implement feature X');
      expect(briefing).toContain('Preserve evidence');
      expect(briefing).toContain('Roster:');
      expect(briefing).toContain('cid-001');
      expect(briefing).toContain('Authenticated Owner seat: none');

      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(1);
      const spawnCall = mocks.mockSpawnTemp.mock.calls[0];
      const spawnOpts = spawnCall[0] as { mission: string; temp: boolean; identity: string };
      expect(spawnOpts.temp).toBe(true);
      expect(spawnOpts.mission).toContain('dedicated room startup gate');
      expect(spawnOpts.mission).toContain('room-brief (room-cid)');
      expect(spawnOpts.mission).not.toContain('Ship feature X');
    });
  });

  describe('role overrides', () => {
    it('applies template overrides to spawnTemp', async () => {
      const template = makeTemplate([
        {
          slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev',
          overrides: { model: 'claude-opus-4-6', persona: 'Custom persona' },
        },
      ]);
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-ovr', room_name: 'Override' });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-ovr',
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      const spawnOpts = mocks.mockSpawnTemp.mock.calls[0][0] as Record<string, unknown>;
      expect(spawnOpts.model).toBe('claude-opus-4-6');
      expect(spawnOpts.persona).toBeUndefined();
      const briefingCall = (cowork.setRoleBriefing as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((briefingCall[1] as { text: string }).text).toContain('Role persona:\nCustom persona');
    });

    it('falls back to findRole config when no template override', async () => {
      const refRole = {
        name: 'Dev',
        harness: 'claude-code',
        session: 'cli',
        permissions: {},
        permissionsDeclared: false,
        identity: 'Dev',
        model: 'claude-sonnet-4-6',
        sourceFile: 'test.yaml',
        monitor: { enabled: false, interval_ms: 0 },
      } as unknown as ResolvedRole;
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const cowork = mockCoworkAdapter();
      createProvisionRoom({ room_id: 'room-ref', room_name: 'Ref' });

      await provisionMembers({
        cfg: minimalCfg({ roles: [refRole] }),
        cowork,
        roomId: 'room-ref',
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      const spawnOpts = mocks.mockSpawnTemp.mock.calls[0][0] as Record<string, unknown>;
      expect(spawnOpts.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('cleanupMembers', () => {
    it('handles missing room record without throwing', async () => {
      await expect(cleanupMembers({ roomId: 'nonexistent' })).resolves.toBeUndefined();
    });

    it('refuses the legacy partial cleanup path without Cowork', async () => {
      createRoomRecord({ room_id: 'room-skip', room_name: 'Skip' });
      const cowork = mockCoworkAdapter();

      await expect(cleanupMembers({ roomId: 'room-skip' }))
        .rejects.toThrow(/deterministic room-close saga/i);

      expect(cowork.closeRoom).not.toHaveBeenCalled();
      const room = getRoomRecord('room-skip')!;
      expect(room.state).toBe('provisioning');
    });
  });
});
