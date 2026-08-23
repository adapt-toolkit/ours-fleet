import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
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
  const mockSpawnTemp = vi.fn().mockResolvedValue('mock-pid');
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

// ── Imports (resolved after mock interception) ──────────────────────────

import { provisionMembers, cleanupMembers } from '../src/rooms-tasks/provision.js';
import {
  createRoomRecord, getRoomRecord,
} from '../src/rooms-tasks/room-state.js';
import {
  createTask, getTask,
} from '../src/rooms-tasks/task-state.js';
import type { CoworkAdapter, CoworkSeatInfo } from '../src/rooms-tasks/cowork-adapter.js';
import type { TemplateSnapshot } from '../src/rooms-tasks/types.js';
import type { FleetConfig, ResolvedRole } from '../src/config.js';

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
}): CoworkAdapter {
  invitesIssued = [];
  let inviteSeq = 0;
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
      return { seat_cid: acceptOpts.expected_cid, seat_state: 'active' as const };
    }),
    getRoom: vi.fn().mockResolvedValue(undefined),
    listRooms: vi.fn().mockResolvedValue([]),
    closeRoom: vi.fn().mockResolvedValue(undefined),
    getSeats: vi.fn().mockImplementation(async () => {
      if (opts?.seatsActive === false) return [];
      return Array.from({ length: 10 }, (_, i) => ({
        identity_cid: `cid-${String(i + 1).padStart(3, '0')}`,
        role: 'Developer',
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
  mocks.mockSpawnTemp.mockResolvedValue('mock-pid');
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
      createRoomRecord({ room_id: 'room-1', room_name: 'Room 1', task_id: task.task_id });

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
      createRoomRecord({ room_id: 'room-2', room_name: 'Standalone' });

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
      createRoomRecord({ room_id: 'room-exp', room_name: 'Expand', task_id: task.task_id });

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
      createRoomRecord({ room_id: 'room-grp', room_name: 'Group' });

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
      createRoomRecord({ room_id: 'room-sec', room_name: 'Secure' });
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
      createRoomRecord({ room_id: 'room-wait', room_name: 'Wait' });

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
  });

  describe('failure rollback', () => {
    it('rolls back created identities when later identity creation fails', async () => {
      mocks.mockCreateIdentity
        .mockResolvedValueOnce({ info: { cid: 'cid-ok-1' } })
        .mockRejectedValueOnce(new Error('SDK unavailable'));

      const template = makeTemplate();
      const cowork = mockCoworkAdapter();
      const task = createTask({ title: 'Fail', origin: { type: 'cli' } });
      createRoomRecord({ room_id: 'room-fail', room_name: 'Fail', task_id: task.task_id });

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
      createRoomRecord({ room_id: 'room-admit', room_name: 'Admit', task_id: task.task_id });

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
    it('includes goal, brief, contract, roster, and rules in spawned mission', async () => {
      const template = makeTemplate([
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ]);
      const cowork = mockCoworkAdapter();
      createRoomRecord({ room_id: 'room-brief', room_name: 'Brief' });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-brief',
        template,
        binPath: '/usr/bin/ours-fleet',
        brief: 'Implement feature X',
        goal: 'Ship feature X',
      });

      expect(mocks.mockSpawnTemp).toHaveBeenCalledTimes(1);
      const spawnCall = mocks.mockSpawnTemp.mock.calls[0];
      const spawnOpts = spawnCall[0] as { mission: string; temp: boolean; identity: string };
      expect(spawnOpts.temp).toBe(true);
      expect(spawnOpts.mission).toContain('Ship feature X');
      expect(spawnOpts.mission).toContain('Implement feature X');
      expect(spawnOpts.mission).toContain('Preserve evidence');
      expect(spawnOpts.mission).toContain('Roster:');
      expect(spawnOpts.mission).toContain('cid-001');
      expect(spawnOpts.mission).toContain('Owner seat');
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
      createRoomRecord({ room_id: 'room-ovr', room_name: 'Override' });

      await provisionMembers({
        cfg: minimalCfg(),
        cowork,
        roomId: 'room-ovr',
        template,
        binPath: '/usr/bin/ours-fleet',
      });

      const spawnOpts = mocks.mockSpawnTemp.mock.calls[0][0] as Record<string, unknown>;
      expect(spawnOpts.model).toBe('claude-opus-4-6');
      expect(spawnOpts.persona).toBe('Custom persona');
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
      createRoomRecord({ room_id: 'room-ref', room_name: 'Ref' });

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
    it('removes member identities and closes room record', async () => {
      const rec = createRoomRecord({ room_id: 'room-clean', room_name: 'Clean' });
      const { updateMemberSeats } = await import('../src/rooms-tasks/room-state.js');
      updateMemberSeats('room-clean', [
        { role_name: 'mem-1', identity_cid: 'c1', slot: 'dev', cowork_role: 'Developer', seat_state: 'active' },
        { role_name: 'mem-2', identity_cid: 'c2', slot: 'dev', cowork_role: 'Developer', seat_state: 'active' },
      ]);

      const cowork = mockCoworkAdapter();
      await cleanupMembers({
        roomId: 'room-clean',
        closeCoworkRoom: true,
        cowork,
      });

      const room = getRoomRecord('room-clean')!;
      expect(room.state).toBe('closed');
      expect(cowork.closeRoom).toHaveBeenCalledWith('room-clean');
    });

    it('handles missing room record without throwing', async () => {
      await expect(cleanupMembers({ roomId: 'nonexistent' })).resolves.toBeUndefined();
    });

    it('skips cowork close when not configured', async () => {
      createRoomRecord({ room_id: 'room-skip', room_name: 'Skip' });
      const cowork = mockCoworkAdapter();

      await cleanupMembers({ roomId: 'room-skip' });

      expect(cowork.closeRoom).not.toHaveBeenCalled();
      const room = getRoomRecord('room-skip')!;
      expect(room.state).toBe('closed');
    });
  });
});
