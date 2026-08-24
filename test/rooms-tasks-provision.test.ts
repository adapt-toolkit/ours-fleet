import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock setup (vi.hoisted runs before vi.mock factories) ────────────────

const mocks = vi.hoisted(() => {
  const cidCounter = { n: 0 };
  const mockCreateIdentity = vi.fn().mockImplementation(async () => ({
    info: { cid: `cid-${String(++cidCounter.n).padStart(3, '0')}` },
  }));
  const mockReleaseLease = vi.fn().mockResolvedValue(undefined);
  const mockRemoveIdentity = vi.fn().mockResolvedValue(undefined);
  const mockAttachOursClient = vi.fn().mockResolvedValue({
    createIdentity: mockCreateIdentity,
    removeIdentity: mockRemoveIdentity,
    releaseLease: mockReleaseLease,
  });
  const mockSpawnTemp = vi.fn();
  return {
    cidCounter,
    mockAttachOursClient,
    mockCreateIdentity,
    mockRemoveIdentity,
    mockReleaseLease,
    mockSpawnTemp,
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
  tempSupervisorLiveness: vi.fn().mockResolvedValue('running'),
  secureStoppedTempArchive: vi.fn().mockResolvedValue('/archive/mock'),
}));

// ── Imports (resolved after mock interception) ──────────────────────────

import { provisionMembers, cleanupMembers } from '../src/rooms-tasks/provision.js';
import {
  createRoomRecord, getRoomRecord,
} from '../src/rooms-tasks/room-state.js';
import {
  createTask, getTask,
} from '../src/rooms-tasks/task-state.js';
import type { CoworkAdapter, CoworkSeatInfo } from '../src/rooms-tasks/cowork-adapter.js';
import type { RoomHistoryEvidence, TemplateSnapshot } from '../src/rooms-tasks/types.js';
import type { FleetConfig, ResolvedRole } from '../src/config.js';
import { sha256Text } from '../src/rooms-tasks/member-startup.js';

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
  initialSeats?: Array<{ cid: string; role: string }>;
  relayStatus?: 'queued' | 'send_failed';
  setBriefingFail?: boolean;
}): CoworkAdapter {
  invitesIssued = [];
  let inviteSeq = 0;
  let briefingSeq = 0;
  const admitted = new Map<string, string>();
  for (const seat of opts?.initialSeats ?? []) admitted.set(seat.cid, seat.role);
  const briefings = new Map<string, { text: string; version: number }>();
  return {
    available: vi.fn().mockResolvedValue(true),
    createRoom: vi.fn().mockResolvedValue({
      room_id: 'room-test', identity_name: 'room-id', identity_cid: 'room-cid',
    }),
    issueInvite: vi.fn().mockImplementation(async (_roomId, inviteOpts) => {
      if (opts?.issueInviteFail) throw new Error('invite issuance failed');
      const invite = `secret-invite-${++inviteSeq}`;
      invitesIssued.push(invite);
      return { invite, min_accepts: inviteOpts.min_accepts };
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
      if (opts?.seatsActive === false) return [];
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
      return records.filter(record => record.seq > after).slice(0, historyOpts?.limit ?? 200);
    }),
    getRoom: vi.fn().mockResolvedValue(undefined),
    listRooms: vi.fn().mockResolvedValue([]),
    closeRoom: vi.fn().mockResolvedValue(undefined),
    getSeats: vi.fn().mockImplementation(async () => {
      if (opts?.seatsActive === false) return [];
      return [...admitted].map(([identity_cid, role]) => ({
        identity_cid,
        role,
        seat_state: 'active' as const,
      }));
    }),
    recoverRoom: vi.fn().mockResolvedValue({
      room_id: 'room-test', identity_name: 'room-id', identity_cid: 'room-cid',
      room_name: 'Test', state: 'active', seats: [],
    }),
  };
}

function stateDir(): string { return join(dir, 'state'); }

function createProvisionRoom(input: Parameters<typeof createRoomRecord>[0]) {
  return createRoomRecord({ room_identity_cid: 'room-cid', ...input });
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
  vi.clearAllMocks();

  mocks.mockCreateIdentity.mockImplementation(async () => ({
    info: { cid: `cid-${String(++mocks.cidCounter.n).padStart(3, '0')}` },
  }));
  mocks.mockReleaseLease.mockResolvedValue(undefined);
  mocks.mockRemoveIdentity.mockResolvedValue(undefined);
  mocks.mockAttachOursClient.mockResolvedValue({
    createIdentity: mocks.mockCreateIdentity,
    removeIdentity: mocks.mockRemoveIdentity,
    releaseLease: mocks.mockReleaseLease,
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

  describe('serial role-group admission', () => {
    it('issues one invite per cowork role, not per member', async () => {
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

      expect(cowork.acceptInvite).toHaveBeenCalledTimes(3);
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

    it('rolls back all identities when cowork admission fails', async () => {
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

      const t = getTask(task.task_id);
      expect(t.state).toBe('failed');
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
