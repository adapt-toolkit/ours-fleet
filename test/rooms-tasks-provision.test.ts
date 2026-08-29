import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  spawnTemp: vi.fn(),
  controlRequest: vi.fn(),
  tempLiveness: vi.fn(),
  secureArchive: vi.fn(),
  archiveForAction: vi.fn(),
}));

vi.mock('../src/spawn.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/spawn.js')>()),
  spawnTemp: mocks.spawnTemp,
}));
vi.mock('../src/session/control.js', () => ({ controlRequest: mocks.controlRequest }));
vi.mock('../src/temp-lifecycle.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/temp-lifecycle.js')>()),
  tempSupervisorLiveness: mocks.tempLiveness,
  secureStoppedTempArchive: mocks.secureArchive,
  tempArchiveForCreationAction: mocks.archiveForAction,
}));

import { provisionMembers } from '../src/rooms-tasks/provision.js';
import { spawnDryRun } from '../src/spawn.js';
import { createRoomRecord, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { createTask, getTask } from '../src/rooms-tasks/task-state.js';
import type {
  CoworkAdapter, CoworkRoomInfo, CoworkSeatInfo,
} from '../src/rooms-tasks/cowork-adapter.js';
import type { FleetConfig } from '../src/config.js';
import type { TemplateSnapshot } from '../src/rooms-tasks/types.js';
import { BUILTIN_TEMPLATES, snapshotTemplate } from '../src/rooms-tasks/templates.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV,
} from '../src/fleet-proxy.js';
import { inheritCallerSpawnDefaults } from '../src/fleet-proxy.js';
import type { ResolvedRole } from '../src/config.js';
import '../src/harness/codex.js';
import '../src/harness/claude-code.js';

let root: string;
let previousHome: string | undefined;
let previousProxyStateDir: string | undefined;
let previousProxyCaller: string | undefined;
let acceptSpawn: ((opts: Record<string, any>) => void) | undefined;

const caller = {
  name: 'Coordinator', harness: 'codex', session: 'acp', identity: 'Coordinator',
  cwd: '/work/project', model: 'gpt-test', sourceFile: '/fleet.yaml',
  permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
  permissionsDeclared: true,
  monitor: {
    mode: 'fleet', enabled: true, wake_sources: ['message_received'], batch_ms: 2_000,
    inject: 'notification', interrupt: true, turn_fail_threshold: 3,
  },
} satisfies ResolvedRole;

function cfg(overrides: Partial<FleetConfig> = {}): FleetConfig {
  return {
    roles: [], vars: {}, defaults: {}, files: ['test'], startStaggerMs: 0,
    diagnostics: [], watchdogs: [], loops: [], ...overrides,
  } as FleetConfig;
}

function template(count = 2): TemplateSnapshot {
  return {
    name: 'simple', version: 1, description: 'Simple room', content_hash: 'a'.repeat(64),
    contract: 'Implement, review, and report evidence.',
    members: [{ slot: 'developer', role: 'Developer', count, role_ref: 'Dev' }],
  };
}

function roomInfo(roomId: string, seats: CoworkSeatInfo[]): CoworkRoomInfo {
  return {
    room_id: roomId, identity_name: 'Room', identity_cid: 'room-cid',
    room_name: 'Room', state: seats.length ? 'active' : 'provisioning',
    seats, role_briefings: {},
  };
}

function coworkHarness(options: { acceptOnSpawn?: boolean; failIssueAt?: number } = {}) {
  const seats: CoworkSeatInfo[] = [];
  const pending: Array<Record<string, any>> = [];
  let issued = 0;
  const issueInvite = vi.fn(async (_roomId: string, opts: {
    mode?: 'one_time' | 'public'; role: string; min_accepts: number;
  }) => {
    issued += 1;
    if (issued === options.failIssueAt) throw new Error('invite issuance failed');
    return {
      invite: `secret-invite-${issued}`,
      invite_id: `invite-${issued}`,
      min_accepts: opts.min_accepts,
    };
  });
  const revokeInvite = vi.fn().mockResolvedValue(undefined);
  const accept = (spawn: Record<string, any>) => {
    const startup = spawn.roomMemberStartup;
    const seat = {
      identity_cid: `cid-${startup.identity_name}`,
      display_name: startup.identity_name,
      invite_id: startup.invite_id,
      role: startup.role,
      seat_state: 'active' as const,
    };
    if (options.acceptOnSpawn === false) pending.push(seat);
    else seats.push(seat);
  };
  acceptSpawn = accept;
  const cowork: CoworkAdapter = {
    available: vi.fn().mockResolvedValue(true),
    createRoom: vi.fn().mockResolvedValue({
      room_id: 'unused', identity_name: 'Room', identity_cid: 'room-cid',
    }),
    acceptInvite: vi.fn(),
    issueInvite,
    revokeInvite,
    setRoleBriefing: vi.fn(),
    getHistory: vi.fn().mockResolvedValue({ records: [], raw_count: 0, next_after: 0 }),
    getRoom: vi.fn(async roomId => roomInfo(roomId, seats)),
    listRooms: vi.fn().mockResolvedValue([]),
    closeRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    getSeats: vi.fn().mockImplementation(async () => seats),
    recoverRoom: vi.fn(async roomId => roomInfo(roomId, seats)),
  };
  return {
    cowork,
    issueInvite,
    revokeInvite,
    acceptAll() { seats.push(...pending.splice(0)); },
  };
}

function mockManagedSpawns(): void {
  mocks.controlRequest.mockImplementation(async (_stateDir, request) => {
    const inherited = inheritCallerSpawnDefaults(
      caller, request.spawn as Record<string, any>, '/fleet.yaml',
    );
    const creationActionId = `supervisor-${inherited.options.creationActionId}`;
    const options = {
      ...inherited.options, creationActionId, callerRole: caller.name,
    };
    const statePath = await mocks.spawnTemp(options, '/usr/bin/ours-fleet');
    return {
      ok: true,
      result: {
        caller: caller.name, role: options.name, lifetime: 'temporary', statePath,
        harness: options.harness, session: options.session,
        model: options.model, monitor: options.monitorConfig,
        inherited: inherited.inherited, creationActionId,
      },
    };
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-simple-room-'));
  previousHome = process.env.OURS_FLEET_HOME;
  previousProxyStateDir = process.env[FLEET_PROXY_STATE_DIR_ENV];
  previousProxyCaller = process.env[FLEET_PROXY_CALLER_ENV];
  process.env.OURS_FLEET_HOME = root;
  delete process.env[FLEET_PROXY_STATE_DIR_ENV];
  delete process.env[FLEET_PROXY_CALLER_ENV];
  acceptSpawn = undefined;
  vi.clearAllMocks();
  mocks.tempLiveness.mockResolvedValue('running');
  mocks.spawnTemp.mockImplementation(async (opts: Record<string, any>) => {
    const dir = join(root, '.ours-fleet', 'tmp', opts.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'role.yaml'), JSON.stringify({
      identity: opts.identity,
      mission: opts.mission,
      roomMemberStartup: opts.roomMemberStartup,
    }));
    writeFileSync(join(dir, 'creation.json'), JSON.stringify({
      creationActionId: opts.creationActionId, role: opts.name,
      surface: opts.surface, callerRole: opts.callerRole,
    }));
    writeFileSync(join(dir, '.temp-supervisor.json'), JSON.stringify({
      version: 1, role: opts.name, launchId: `launch-${opts.name}`,
      createdAt: new Date().toISOString(), phase: 'launching',
    }));
    acceptSpawn?.(opts);
    return dir;
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  if (previousProxyStateDir === undefined) delete process.env[FLEET_PROXY_STATE_DIR_ENV];
  else process.env[FLEET_PROXY_STATE_DIR_ENV] = previousProxyStateDir;
  if (previousProxyCaller === undefined) delete process.env[FLEET_PROXY_CALLER_ENV];
  else process.env[FLEET_PROXY_CALLER_ENV] = previousProxyCaller;
  rmSync(root, { recursive: true, force: true });
});

describe('simple Cowork room member startup', () => {
  it('issues one one-time invite per temporary agent and activates from authenticated seats', async () => {
    const task = createTask({ title: 'Ship', origin: { type: 'cli' } });
    createRoomRecord({
      room_id: 'room-1', room_name: 'Room', room_identity_cid: 'room-cid', task_id: task.task_id,
    });
    const h = coworkHarness();
    const result = await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-1', taskId: task.task_id,
      template: template(2), binPath: '/usr/bin/ours-fleet',
      goal: 'Ship the simple flow', brief: 'No ACK gate.',
    });

    expect(result.state).toBe('active');
    expect(result.member_seats.map(seat => seat.identity_cid)).toEqual(
      result.member_seats.map(seat => `cid-${seat.role_name}`),
    );
    expect(h.issueInvite).toHaveBeenCalledTimes(2);
    for (const call of h.issueInvite.mock.calls) {
      expect(call[1]).toEqual({ mode: 'one_time', role: 'Developer', min_accepts: 1 });
    }
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(2);
    expect(getTask(task.task_id)).toMatchObject({ state: 'active' });
    expect(getTask(task.task_id).member_roles).toHaveLength(2);
  });

  it('puts identity name, invite, role, and full task in the agent-owned startup payload', async () => {
    createRoomRecord({ room_id: 'room-payload', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-payload', template: template(1),
      binPath: '/usr/bin/ours-fleet', goal: 'Implement it', brief: 'Keep it simple.',
    });
    const spawn = mocks.spawnTemp.mock.calls[0][0];
    expect(spawn.identity).toBe('room-room-pay-developer-1');
    expect(spawn.roomMemberStartup).toMatchObject({
      identity_name: 'room-room-pay-developer-1',
      invite_id: 'invite-1', invite: 'secret-invite-1', role: 'Developer',
    });
    expect(spawn.roomMemberStartup.task).toContain('Goal: Implement it');
    expect(spawn.roomMemberStartup.task).toContain('Brief: Keep it simple.');
    expect(spawn.roomMemberStartup.task).toContain('Collaboration contract:');
    expect(spawn.mission).toBe(spawn.roomMemberStartup.task);
  });

  it('waits for seat acceptance without reissuing or relaunching a live member', async () => {
    createRoomRecord({ room_id: 'room-wait', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness({ acceptOnSpawn: false });
    const input = {
      cfg: cfg(), cowork: h.cowork, roomId: 'room-wait', template: template(1),
      binPath: '/usr/bin/ours-fleet',
      startupWait: { timeoutMs: 0, now: () => 1 },
    };
    const waiting = await provisionMembers(input);
    expect(waiting).toMatchObject({
      state: 'provisioning', provisioning_detail: 'waiting_seats',
      saga: { phase: 'wait_seats' },
    });
    h.acceptAll();
    const active = await provisionMembers(input);
    expect(active.state).toBe('active');
    expect(h.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(1);
  });

  it('matches the seat by exact identity name, role, and invite id', async () => {
    createRoomRecord({ room_id: 'room-spoof', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    acceptSpawn = (spawn: Record<string, any>) => {
      const startup = spawn.roomMemberStartup;
      const info = roomInfo('room-spoof', [{
        identity_cid: 'attacker', display_name: startup.identity_name,
        invite_id: startup.invite_id, role: 'Owner', seat_state: 'active',
      }]);
      vi.mocked(h.cowork.recoverRoom).mockResolvedValue(info);
    };
    await expect(provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-spoof', template: template(1),
      binPath: '/usr/bin/ours-fleet',
    })).rejects.toThrow('has role Owner; expected Developer');
  });

  it('revokes a freshly issued invite when its member launch fails', async () => {
    createRoomRecord({ room_id: 'room-fail', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    mocks.spawnTemp.mockRejectedValueOnce(new Error('launch failed'));
    await expect(provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-fail', template: template(1),
      binPath: '/usr/bin/ours-fleet',
    })).rejects.toThrow('launch failed');
    expect(h.revokeInvite).toHaveBeenCalledWith('room-fail', 'invite-1');
    expect(getRoomRecord('room-fail')?.member_seats[0].launch?.state).toBe('failed');
  });

  it('does not persist invite secrets in Fleet room orchestration state', async () => {
    createRoomRecord({ room_id: 'room-secret', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-secret', template: template(1),
      binPath: '/usr/bin/ours-fleet',
    });
    const roomFile = join(root, '.ours-fleet', 'rooms', 'room-secret.json');
    expect(readFileSync(roomFile, 'utf8')).not.toContain('secret-invite-1');
    expect(readFileSync(roomFile, 'utf8')).toContain('invite-1');
  });

  it('preserves role harness, model, cwd, and persona overrides', async () => {
    createRoomRecord({ room_id: 'room-override', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    const tpl = template(1);
    tpl.members[0].overrides = {
      harness: 'codex', model: 'gpt-test', cwd: '/workspace', persona: 'Review carefully.',
    };
    await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-override', template: tpl,
      binPath: '/usr/bin/ours-fleet',
    });
    expect(mocks.spawnTemp.mock.calls[0][0]).toMatchObject({
      harness: 'codex', model: 'gpt-test', cwd: '/workspace',
    });
    expect(mocks.spawnTemp.mock.calls[0][0].roomMemberStartup.task)
      .toContain('Role persona:\nReview carefully.');
  });

  it.each(['pair', 'team'] as const)(
    'routes every %s member through authenticated direct-spawn inheritance',
    async templateName => {
      process.env[FLEET_PROXY_STATE_DIR_ENV] = '/state/Coordinator';
      process.env[FLEET_PROXY_CALLER_ENV] = 'Coordinator';
      const selected = BUILTIN_TEMPLATES.find(candidate => candidate.name === templateName)!;
      const tpl = snapshotTemplate(selected);
      createRoomRecord({
        room_id: `room-${templateName}`, room_name: 'Room', room_identity_cid: 'room-cid',
      });
      const h = coworkHarness();
      mockManagedSpawns();

      await provisionMembers({
        cfg: cfg(), cowork: h.cowork, roomId: `room-${templateName}`, template: tpl,
        binPath: '/usr/bin/ours-fleet',
      });

      expect(mocks.controlRequest).toHaveBeenCalledTimes(tpl.members.length);
      for (const [stateDir, request] of mocks.controlRequest.mock.calls) {
        expect(stateDir).toBe('/state/Coordinator');
        expect(request).toMatchObject({
          command: 'fleet_spawn',
          spawn: { temp: true, surface: 'agent', creationActionId: expect.any(String) },
        });
      }
      for (const [spawn] of mocks.spawnTemp.mock.calls) {
        expect(spawn).toMatchObject({
          harness: 'codex', session: 'acp', model: 'gpt-test', cwd: '/work/project',
          coordinator: 'Coordinator', approval: 'allow', filesystem: 'unrestricted',
          unattended: 'wait', monitorConfig: { mode: 'fleet', interrupt: true },
          callerRole: 'Coordinator', inheritedFromCaller: [
            'harness', 'session', 'cwd', 'coordinator', 'approval', 'filesystem',
            'unattended', 'monitorConfig', 'model',
          ],
        });
      }
    },
  );

  it('uses direct temporary spawn safely when authenticated caller context is absent', async () => {
    createRoomRecord({
      room_id: 'room-standalone', room_name: 'Room', room_identity_cid: 'room-cid',
    });
    const h = coworkHarness();
    await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-standalone', template: template(1),
      binPath: '/usr/bin/ours-fleet',
    });
    expect(mocks.controlRequest).not.toHaveBeenCalled();
    expect(mocks.spawnTemp).toHaveBeenCalledOnce();
    expect(mocks.spawnTemp.mock.calls[0][0]).toMatchObject({ surface: 'agent' });
    expect(mocks.spawnTemp.mock.calls[0][0]).not.toHaveProperty('callerRole');
    expect(mocks.spawnTemp.mock.calls[0][0]).not.toHaveProperty('inheritedFromCaller');
    const fallback = spawnDryRun({
      ...mocks.spawnTemp.mock.calls[0][0], name: 'fallback-preview', identity: 'fallback-preview',
    }).resolvedRole;
    expect(fallback).toMatchObject({
      harness: 'claude-code', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      monitor: { mode: 'fleet' },
    });
  });

  it('keeps explicit member settings ahead of caller inheritance and suppresses cross-harness model', async () => {
    process.env[FLEET_PROXY_STATE_DIR_ENV] = '/state/Coordinator';
    process.env[FLEET_PROXY_CALLER_ENV] = 'Coordinator';
    const tpl = template(1);
    tpl.members[0].overrides = {
      harness: 'claude-code', cwd: '/explicit',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
    };
    createRoomRecord({
      room_id: 'room-explicit', room_name: 'Room', room_identity_cid: 'room-cid',
    });
    const h = coworkHarness();
    mockManagedSpawns();

    await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-explicit', template: tpl,
      binPath: '/usr/bin/ours-fleet',
    });

    const spawn = mocks.spawnTemp.mock.calls[0][0];
    expect(spawn).toMatchObject({
      harness: 'claude-code', session: 'acp', cwd: '/explicit', coordinator: 'Coordinator',
      approval: 'ask', filesystem: 'workspace', unattended: 'deny',
      monitorConfig: { mode: 'fleet', interrupt: true },
    });
    expect(spawn.model).toBeUndefined();
    expect(spawn.inheritedFromCaller).toEqual([
      'session', 'coordinator', 'monitorConfig',
    ]);
  });

  it('adopts supervisor provenance after a crash before the spawn response', async () => {
    process.env[FLEET_PROXY_STATE_DIR_ENV] = '/state/Coordinator';
    process.env[FLEET_PROXY_CALLER_ENV] = 'Coordinator';
    createRoomRecord({
      room_id: 'room-crash', room_name: 'Room', room_identity_cid: 'room-cid',
    });
    const h = coworkHarness({ acceptOnSpawn: false });
    let supervisorAction = '';
    mocks.controlRequest.mockImplementationOnce(async (_stateDir, request) => {
      const inherited = inheritCallerSpawnDefaults(
        caller, request.spawn as Record<string, any>, '/fleet.yaml',
      );
      supervisorAction = `supervisor-${inherited.options.creationActionId}`;
      await mocks.spawnTemp({
        ...inherited.options, creationActionId: supervisorAction, callerRole: caller.name,
      }, '/usr/bin/ours-fleet');
      throw new Error('simulated process loss before control response');
    });
    const input = {
      cfg: cfg(), cowork: h.cowork, roomId: 'room-crash', template: template(1),
      binPath: '/usr/bin/ours-fleet', startupWait: { timeoutMs: 0, now: () => 1 },
    };
    await expect(provisionMembers(input)).rejects.toThrow('simulated process loss');

    expect(getRoomRecord('room-crash')!.member_seats[0].launch).toMatchObject({
      state: 'failed', caller_role: 'Coordinator',
    });
    mocks.controlRequest.mockReset();
    mockManagedSpawns();

    await provisionMembers(input);

    expect(mocks.controlRequest).not.toHaveBeenCalled();
    expect(getRoomRecord('room-crash')!.member_seats[0].launch).toMatchObject({
      state: 'launched', action_id: supervisorAction, caller_role: 'Coordinator',
    });
  });
});
