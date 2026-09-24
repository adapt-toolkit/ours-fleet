import { privateRuntimeRoot, storeRoomSecret } from '../src/agent-ours/service.js';
import { atomicPrivateWrite, binderKey } from '../src/agent-ours/state.js';
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

import { provisionMembers, reconcileExistingTaskMembers } from '../src/rooms-tasks/provision.js';
import { roomCloseLockPath } from '../src/rooms-tasks/close.js';
import { taskOperationLockPath } from '../src/rooms-tasks/terminal.js';
import { withFileLock } from '../src/atomic-file.js';
import { beginFleetAuditCollection, consumeFleetAuditCollection } from '../src/fleet-command-audit.js';
import { spawnDryRun } from '../src/spawn.js';
import { activateRoom, beginRoomClose, createRoomRecord, getRoomRecord, setOwnerSeat } from '../src/rooms-tasks/room-state.js';
import { beginTaskTerminalIntent, createTask, getTask, updateTaskRoom } from '../src/rooms-tasks/task-state.js';
import type {
  CoworkAdapter, CoworkRoomInfo, CoworkSeatInfo,
} from '../src/rooms-tasks/cowork-adapter.js';
import type { FleetConfig } from '../src/config.js';
import type { TemplateDefinition, TemplateSnapshot } from '../src/rooms-tasks/types.js';
import { prepareExecutionPlan } from '../src/rooms-tasks/member-overrides.js';
import { sealTemplateSnapshot, snapshotTemplate } from '../src/rooms-tasks/templates.js';
import {
  FLEET_PROXY_CALLER_ENV, FLEET_PROXY_STATE_DIR_ENV,
} from '../src/fleet-proxy.js';
import { inheritCallerSpawnDefaults } from '../src/fleet-proxy.js';
import type { ResolvedRole } from '../src/config.js';
import '../src/harness/codex.js';
import '../src/harness/claude-code.js';
import { writeV2Fixture } from './v2-fixture.js';

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
  agentSelections: { brain: { ref: 'codex' }, role: { ref: 'Coordinator' } },
  monitor: {
    mode: 'fleet', enabled: true, wake_sources: ['message_received'], batch_ms: 2_000,
    inject: 'notification', interrupt: true, turn_fail_threshold: 3,
  },
} satisfies ResolvedRole;

function cfg(overrides: Partial<FleetConfig> = {}): FleetConfig {
  const worker = {
    brain: { inline: { harness: 'codex' } }, role: { inline: { persona: 'Developer' } },
  } as const;
  return {
    roles: [], vars: {}, defaults: {}, files: ['test'], startStaggerMs: 0,
    agentTemplates: Object.fromEntries(
      ['LocalCoordinator', 'Developer', 'Critic']
        .map(name => [name, structuredClone(worker)])),
    diagnostics: [], watchdogs: [], loops: [], ...overrides,
  } as FleetConfig;
}

function template(count = 2): TemplateSnapshot {
  return {
    name: 'simple', version: 1, description: 'Simple room', content_hash: 'a'.repeat(64),
    contract: 'Implement, review, and report evidence.',
    members: [{ slot: 'developer', role: 'Developer', count, agent_template: 'Developer' }],
  };
}

function roomInfo(roomId: string, seats: CoworkSeatInfo[], anonymous = false): CoworkRoomInfo {
  return {
    room_id: roomId, identity_name: 'Room', identity_cid: 'room-cid',
    room_name: 'Room', state: seats.length ? 'active' : 'provisioning', anonymous,
    seats, role_briefings: {},
  };
}

function coworkHarness(options: { acceptOnSpawn?: boolean; failIssueAt?: number; anonymous?: boolean } = {}) {
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
    const readyRoot=join(privateRuntimeRoot(),'room-inputs');mkdirSync(readyRoot,{recursive:true});
    atomicPrivateWrite(join(readyRoot,binderKey(startup.room_identity_cid,spawn.name)+'.ready.json'),{room:startup.room_id,invite:startup.invite_id,cid:`cid-${startup.identity_name}`,generation:1});
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
    setRoleCommands: vi.fn(),
    getHistory: vi.fn().mockResolvedValue({ records: [], raw_count: 0, next_after: 0 }),
    getRoom: vi.fn(async roomId => roomInfo(roomId, seats, options.anonymous)),
    listRooms: vi.fn().mockResolvedValue([]),
    closeRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    getSeats: vi.fn().mockImplementation(async () => seats),
    recoverRoom: vi.fn(async roomId => roomInfo(roomId, seats, options.anonymous)),
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
  writeV2Fixture(join(root, 'fleet.yaml'), {});
  delete process.env[FLEET_PROXY_STATE_DIR_ENV];
  delete process.env[FLEET_PROXY_CALLER_ENV];
  acceptSpawn = undefined;
  vi.clearAllMocks();
  mocks.tempLiveness.mockResolvedValue('running');
  mocks.spawnTemp.mockImplementation(async (opts: Record<string, any>) => {
    const dir = join(root, '.ours-fleet', 'tmp', opts.name);
    mkdirSync(dir, { recursive: true });
    // The persisted role.yaml is the exact ResolvedRole a real spawn writes;
    // launch presentation capture reads it back, so keep the fake realistic.
    const definition = opts.agentDefinition ?? {};
    writeFileSync(join(dir, 'role.yaml'), JSON.stringify({
      name: opts.name,
      identity: opts.identity,
      cwd: definition.cwd,
      harness: definition.brain?.inline?.harness ?? 'codex',
      session: 'acp',
      ...(definition.brain?.inline?.model !== undefined ? { model: definition.brain.inline.model } : {}),
      ...(definition.brain?.inline?.effort !== undefined ? { effort: definition.brain.inline.effort } : {}),
      ...(definition.role?.inline?.mission !== undefined ? { mission: definition.role.inline.mission } : {}),
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait',
        ...(definition.permissions ?? {}) },
      permissionsDeclared: Boolean(definition.permissions),
      monitor: { mode: 'fleet', enabled: true, wake_sources: ['message_received'], batch_ms: 2_000,
        inject: 'notification', interrupt: true, turn_fail_threshold: 3 },
      ...(definition.isolation ? { isolation: definition.isolation } : {}),
      sourceFile: '(temp)',
      roomMemberStartup: {...opts.roomMemberStartup,invite:''},
    }));
    writeFileSync(join(dir, 'creation.json'), JSON.stringify({
      creationActionId: opts.creationActionId, role: opts.name,
      brainSummary: 'ref:B (explicit)', roleSummary: 'ref:R (explicit)',
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
  it.each(['room', 'task'])('rechecks terminal ownership after waiting for the %s provisioning lock', async boundary => {
    const task = createTask({ title: 'Waiting launch', origin: { type: 'cli' } });
    createRoomRecord({ room_id: 'room-lock-race', room_name: 'Room', room_identity_cid: 'room-cid', task_id: task.task_id });
    updateTaskRoom(task.task_id, 'room-lock-race', 'room-cid');
    const h = coworkHarness();
    let locked!: () => void, unlock!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const held = withFileLock(boundary === 'room' ? roomCloseLockPath('room-lock-race') : taskOperationLockPath(task.task_id), async () => { locked(); await release; });
    await ready;
    const pending = provisionMembers({ cfg: cfg(), cowork: h.cowork, roomId: 'room-lock-race', taskId: task.task_id,
      template: template(1), binPath: '/usr/bin/ours-fleet' });
    const rejected = expect(pending).rejects.toThrow(/closing|terminal/);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(h.issueInvite).not.toHaveBeenCalled();
      if (boundary === 'room') beginRoomClose('room-lock-race');
      else beginTaskTerminalIntent(task.task_id, { kind: 'cancelled', roomId: 'room-lock-race' });
    } finally { unlock(); }
    await held;
    await rejected;
    expect(h.issueInvite).not.toHaveBeenCalled();
    expect(mocks.spawnTemp).not.toHaveBeenCalled();
  });

  it.each(['room-close', 'task-cancel'])('never launches after %s is accepted while issuing an invite', async mode => {
    const task = createTask({ title: 'Cancel race', origin: { type: 'cli' } });
    createRoomRecord({ room_id: 'room-cancel-race', room_name: 'Room', room_identity_cid: 'room-cid', task_id: task.task_id });
    updateTaskRoom(task.task_id, 'room-cancel-race', 'room-cid');
    const h = coworkHarness();
    const issue = h.issueInvite.getMockImplementation()!;
    h.issueInvite.mockImplementation(async (...args) => {
      const result = await issue(...args);
      if (mode === 'room-close') beginRoomClose('room-cancel-race');
      else beginTaskTerminalIntent(task.task_id, { kind: 'cancelled', roomId: 'room-cancel-race' });
      return result;
    });
    await expect(provisionMembers({ cfg: cfg(), cowork: h.cowork, roomId: 'room-cancel-race', taskId: task.task_id,
      template: template(1), binPath: '/usr/bin/ours-fleet' })).rejects.toThrow(/closing|terminal/);
    expect(mocks.spawnTemp).not.toHaveBeenCalled();
    expect(h.revokeInvite).toHaveBeenCalledWith('room-cancel-race', 'invite-1');
  });

  it('does not become ready until the configured Owner seat is active', async () => {
    createRoomRecord({ room_id: 'room-owner-gate', room_name: 'Room', room_identity_cid: 'room-cid' });
    setOwnerSeat('room-owner-gate', 'owner-cid', 'fingerprint');
    let ownerActive = false;
    const seats = (): CoworkSeatInfo[] => [{
      identity_cid: 'owner-cid', display_name: 'Owner', invite_id: 'owner-invite', role: 'Owner',
      seat_state: ownerActive ? 'active' : 'pending',
    }];
    const cowork = { ...coworkHarness().cowork,
      recoverRoom: vi.fn(async roomId => roomInfo(roomId, seats())),
    } as CoworkAdapter;
    const input = { cfg: cfg(), cowork, roomId: 'room-owner-gate', template: template(0),
      binPath: '/usr/bin/ours-fleet', startupWait: { timeoutMs: 0, now: () => 1 } };

    expect((await provisionMembers(input)).state).toBe('provisioning');
    expect(getRoomRecord('room-owner-gate')?.provisioning_detail).toBe('waiting_seats');
    ownerActive = true;
    expect((await provisionMembers(input)).state).toBe('active');
  });

  it('issues one one-time invite per temporary agent and activates from authenticated seats', async () => {
    const task = createTask({ title: 'Ship', origin: { type: 'cli' } });
    createRoomRecord({
      room_id: 'room-1', room_name: 'Room', room_identity_cid: 'room-cid', task_id: task.task_id,
    });
    const h = coworkHarness();
    beginFleetAuditCollection();
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
    expect(consumeFleetAuditCollection().presentations ?? []).toEqual([]);
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
    expect(spawn).not.toHaveProperty('mission');
  });

  it('carries the durable anonymous-room flag into the temporary identity startup payload', async () => {
    createRoomRecord({
      room_id: 'room-anonymous', room_name: 'Room', room_identity_cid: 'room-cid',
      room_policy: { anonymous: true },
    });
    const h = coworkHarness({ anonymous: true });
    await provisionMembers({
      cfg: cfg(), cowork: h.cowork, roomId: 'room-anonymous', template: template(1),
      binPath: '/usr/bin/ours-fleet', goal: 'Implement it', brief: 'Keep it simple.',
    });

    expect(mocks.spawnTemp.mock.calls[0][0].roomMemberStartup).toMatchObject({ anonymous: true });
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

  it('relaunches a stopped member from the sealed loop snapshot after mutable template drift', async () => {
    const launchCfg = cfg();
    launchCfg.agentTemplates!.Developer.loops = {
      progress: { interval: '1m', prompt: 'SEALED_RETRY_LOOP' },
    };
    const base = snapshotTemplate({
      name: 'retry', version: 1, description: 'Retry fixture',
      members: [{ slot: 'developer', role: 'Developer', count: 1,
        agent_template: 'Developer' }],
    }, launchCfg.agentTemplates);
    const sealed = sealTemplateSnapshot({ ...base, members: base.members.map(member => ({
      ...member, loop_source: 'agent-template' as const,
    })) }, launchCfg.agentTemplates!);
    createRoomRecord({
      room_id: 'room-loop-retry', room_name: 'Room', room_identity_cid: 'room-cid',
      template_snapshot: sealed,
    });
    const h = coworkHarness({ acceptOnSpawn: false });
    const input = { cfg: launchCfg, cowork: h.cowork, roomId: 'room-loop-retry',
      template: sealed, binPath: '/usr/bin/ours-fleet',
      startupWait: { timeoutMs: 0, now: () => 1 } };
    await provisionMembers(input);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(1);

    launchCfg.agentTemplates!.Developer.loops = {
      progress: { interval: '2m', prompt: 'MUTATED_TEMPLATE_LOOP' },
    };
    mocks.tempLiveness.mockResolvedValueOnce('stopped');
    await provisionMembers(input);

    expect(mocks.spawnTemp).toHaveBeenCalledTimes(2);
    for (const [spawn] of mocks.spawnTemp.mock.calls) expect(spawn).toMatchObject({
      loopSource: 'agent-template', agentDefinition: { loops: {
        progress: { interval: '1m', prompt: 'SEALED_RETRY_LOOP' },
      } },
    });
    expect(JSON.stringify(mocks.spawnTemp.mock.calls)).not.toContain('MUTATED_TEMPLATE_LOOP');
  });

  it('fails safely when a pending seat Agent definition drifts before recovery', async () => {
    createRoomRecord({ room_id: 'room-drift', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness({ acceptOnSpawn: false });
    const input = { cfg: cfg(), cowork: h.cowork, roomId: 'room-drift', template: template(1),
      binPath: '/usr/bin/ours-fleet', startupWait: { timeoutMs: 0, now: () => 1 } };
    await provisionMembers(input);
    const driftedCfg = cfg({ agentTemplates: { Developer: {
      brain: { inline: { harness: 'codex', model: 'different-model' } }, role: { inline: {} },
    } } });
    await expect(provisionMembers({ ...input, cfg: driftedCfg }))
      .rejects.toThrow(/Agent definition drift.*durable launch intent/);
    expect(h.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(1);
  });

  it('matches the seat by exact identity name, role, and invite id', async () => {
    createRoomRecord({ room_id: 'room-spoof', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    acceptSpawn = (spawn: Record<string, any>) => {
      const startup = spawn.roomMemberStartup;
    const readyRoot=join(privateRuntimeRoot(),'room-inputs');mkdirSync(readyRoot,{recursive:true});
    atomicPrivateWrite(join(readyRoot,binderKey(startup.room_identity_cid,spawn.name)+'.ready.json'),{room:startup.room_id,invite:startup.invite_id,cid:`cid-${startup.identity_name}`,generation:1});
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

  it('retries a failed launch with a new invite without colliding with its retained secret', async () => {
    createRoomRecord({ room_id: 'room-retry-secret', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    const spawn = mocks.spawnTemp.getMockImplementation()!;
    let attempt = 0;
    mocks.spawnTemp.mockImplementation(async (opts: Record<string, any>) => {
      storeRoomSecret({ name: opts.name, identity: opts.identity, roomMemberStartup: opts.roomMemberStartup } as ResolvedRole);
      if (++attempt === 1) throw new Error('launch failed before supervisor');
      return spawn(opts);
    });
    const input = { cfg: cfg(), cowork: h.cowork, roomId: 'room-retry-secret', template: template(1), binPath: '/usr/bin/ours-fleet' };
    await expect(provisionMembers(input)).rejects.toThrow('launch failed before supervisor');
    expect(h.revokeInvite).toHaveBeenCalledWith('room-retry-secret', 'invite-1');
    const result = await provisionMembers(input);
    expect(result.state).toBe('active');
    expect(result.member_seats[0].invite_id).toBe('invite-2');
    expect(result.member_seats[0].launch?.attempt).toBe(2);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(2);
  });

  it('does not activate Fleet from admitted seats while Cowork still has unmet requirements', async () => {
    const task = createTask({ title: 'Wait for activation', origin: { type: 'cli' } });
    const roomId = 'room-cowork-provisioning';
    createRoomRecord({ room_id: roomId, room_name: 'Room', room_identity_cid: 'room-cid', task_id: task.task_id });
    const h = coworkHarness();
    const recover = vi.mocked(h.cowork.recoverRoom).getMockImplementation()!;
    vi.mocked(h.cowork.recoverRoom).mockImplementation(async id => ({ ...await recover(id), state: 'provisioning' }));
    const input = { cfg: cfg(), cowork: h.cowork, roomId, taskId: task.task_id,
      template: template(1), binPath: '/fleet', startupWait: { timeoutMs: 0 } };
    const waiting = await provisionMembers(input);
    expect(waiting.state).toBe('provisioning');
    expect(getTask(task.task_id).state).toBe('provisioning');
    expect(waiting.member_seats[0].seat_state).toBe('active');
    vi.mocked(h.cowork.recoverRoom).mockImplementation(recover);
    expect((await provisionMembers(input)).state).toBe('active');
    expect(h.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(1);
    expect(h.revokeInvite).not.toHaveBeenCalled();
  });

  it.each(['pending', 'active'] as const)('refuses to revoke or replace a failed invite with an admitted %s seat', async seatState => {
    const roomId = 'room-admitted-cleanup';
    createRoomRecord({ room_id: roomId, room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    mocks.spawnTemp.mockRejectedValueOnce(new Error('launch failed'));
    h.revokeInvite.mockRejectedValueOnce(new Error('cleanup failed'));
    const input = { cfg: cfg(), cowork: h.cowork, roomId, template: template(1), binPath: '/fleet' };
    let failure: any;
    try { await provisionMembers(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual(['launch failed', 'cleanup failed']);
    const before = getRoomRecord(roomId)!.member_seats[0];
    vi.mocked(h.cowork.getRoom).mockResolvedValue(roomInfo(roomId, [{
      display_name: before.role_name, identity_cid: 'late-admitted-cid', invite_id: before.invite_id,
      role: before.cowork_role, seat_state: seatState,
    }]));
    vi.clearAllMocks();
    await expect(provisionMembers(input)).rejects.toThrow(/admitted seat/);
    expect(h.revokeInvite).not.toHaveBeenCalled();
    expect(h.issueInvite).not.toHaveBeenCalled();
    expect(mocks.spawnTemp).not.toHaveBeenCalled();
    expect(getRoomRecord(roomId)!.member_seats[0].invite_id).toBe(before.invite_id);
  });

  it('revokes the retained invite after asynchronous supervisor failure before replacement', async () => {
    const roomId = 'room-async-failure';
    createRoomRecord({ room_id: roomId, room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness({ acceptOnSpawn: false });
    const input = { cfg: cfg(), cowork: h.cowork, roomId, template: template(1),
      binPath: '/fleet', startupWait: { timeoutMs: 0 } };
    await provisionMembers(input);
    expect(getRoomRecord(roomId)!.member_seats[0].launch!.state).toBe('launched');
    expect(h.revokeInvite).not.toHaveBeenCalled();
    mocks.tempLiveness.mockResolvedValueOnce('stopped');
    h.revokeInvite.mockRejectedValueOnce(new Error('cleanup offline'));
    await expect(provisionMembers(input)).rejects.toThrow('cleanup offline');
    expect(h.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(1);
    expect(getRoomRecord(roomId)!.member_seats[0].invite_id).toBe('invite-1');
    await provisionMembers(input);
    expect(h.revokeInvite).toHaveBeenLastCalledWith(roomId, 'invite-1');
    expect(h.issueInvite).toHaveBeenCalledTimes(2);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(2);
    const revokeOrder = h.revokeInvite.mock.invocationCallOrder.at(-1)!;
    expect(revokeOrder).toBeLessThan(h.issueInvite.mock.invocationCallOrder.at(-1)!);
  });

  it('does not overwrite a failed attempt invite until revocation succeeds on retry', async () => {
    createRoomRecord({ room_id: 'room-revoke-retry', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    mocks.spawnTemp.mockRejectedValueOnce(new Error('launch failed'));
    h.revokeInvite.mockRejectedValueOnce(new Error('revoke transport unavailable'));
    const input = { cfg: cfg(), cowork: h.cowork, roomId: 'room-revoke-retry',
      template: template(1), binPath: '/fleet' };
    await expect(provisionMembers(input)).rejects.toThrow();
    expect(getRoomRecord(input.roomId)!.member_seats[0].invite_id).toBe('invite-1');
    h.revokeInvite.mockRejectedValueOnce(new Error('revoke still unavailable'));
    await expect(provisionMembers(input)).rejects.toThrow();
    expect(h.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(1);
    expect(getRoomRecord(input.roomId)!.member_seats[0].invite_id).toBe('invite-1');
    await provisionMembers(input);
    expect(h.revokeInvite).toHaveBeenLastCalledWith(input.roomId, 'invite-1');
    expect(h.issueInvite).toHaveBeenCalledTimes(2);
    expect(getRoomRecord(input.roomId)!.member_seats[0].invite_id).toBe('invite-2');
    expect(getRoomRecord(input.roomId)!.state).toBe('active');
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

  it('persists only a structural Agent projection, never secret-capable values', async () => {
    createRoomRecord({ room_id: 'room-redact', room_name: 'Room', room_identity_cid: 'room-cid' });
    const base = template(1);
    const redactedDefinition = {
      brain: { inline: { harness: 'codex', harness_options: { endpoint: 'brain-sentinel' } } },
      role: { inline: { persona: 'safe' } }, env: { ENDPOINT: 'env-sentinel' },
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
    };
    const { content_hash: _hash, ...definition } = base;
    const tpl = snapshotTemplate(definition, { Developer: redactedDefinition });
    expect(JSON.stringify(tpl)).not.toContain('brain-sentinel');
    expect(JSON.stringify(tpl)).not.toContain('env-sentinel');
    await provisionMembers({ cfg: cfg({ agentTemplates: { Developer: redactedDefinition } }), cowork: coworkHarness().cowork, roomId: 'room-redact',
      template: tpl, binPath: '/usr/bin/ours-fleet' });
    const state = readFileSync(join(root, '.ours-fleet', 'rooms', 'room-redact.json'), 'utf8');
    expect(state).not.toContain('brain-sentinel');
    expect(state).not.toContain('env-sentinel');
    expect(state).toContain('agent_fingerprint');
    expect(state).toContain('<redacted>');
    expect(state).toContain('agent_template_hash');
    expect(state).toContain('permissions');
  });

  it('serializes concurrent member provisioning into one workspace and one launch per member', async () => {
    const room = createRoomRecord({ room_id: 'room-concurrent', room_name: 'r', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    const input = { cfg: cfg(), cowork: h.cowork, roomId: room.room_id, template: template(2), binPath: '/fleet' };
    await Promise.all([provisionMembers(input), provisionMembers(input)]);
    expect(mocks.spawnTemp).toHaveBeenCalledTimes(2);
    expect(h.issueInvite).toHaveBeenCalledTimes(2);
    for (const [spawn] of mocks.spawnTemp.mock.calls) {
      expect(spawn.agentDefinition.cwd).toBe(room.workspace!.path);
      expect(spawn.roomMemberStartup.workspace).toEqual(room.workspace);
      expect(spawn.roomMemberStartup.task).toContain(room.workspace!.path);
    }
  });

  it('preserves the canonical room Agent definition', async () => {
    createRoomRecord({ room_id: 'room-override', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    const tpl = template(1);
    const exactDefinition = {
      brain: { inline: { harness: 'codex', model: 'gpt-test' } },
      role: { inline: { persona: 'Review carefully.' } }, cwd: '/workspace',
    };
    await provisionMembers({
      cfg: cfg({ agentTemplates: { Developer: exactDefinition } }), cowork: h.cowork, roomId: 'room-override', template: tpl,
      binPath: '/usr/bin/ours-fleet',
    });
    expect(mocks.spawnTemp.mock.calls[0][0]).toMatchObject({
      agentDefinition: { brain: { inline: { harness: 'codex', model: 'gpt-test' } },
        role: { inline: { persona: 'Review carefully.' } }, cwd: getRoomRecord('room-override')!.workspace!.path },
    });
    expect(mocks.spawnTemp.mock.calls[0][0].roomMemberStartup.task)
      .toContain('Role persona:\nReview carefully.');
  });

  it('provisions the exact sealed member override instead of the base Agent Template', async () => {
    const definition: TemplateDefinition = {
      name: 'overridden', version: 1, description: 'Override fixture',
      members: [{ slot: 'developer', role: 'Developer', count: 1, agent_template: 'Developer' }],
    };
    const base = {
      brain: { inline: { harness: 'claude-code', effort: 'high' } },
      role: { inline: { persona: 'Developer' } },
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
    } as const;
    const configuration = cfg({
      agentTemplates: { Developer: base },
      brainPresets: { Fast: { harness: 'codex', model: 'gpt-test', effort: 'medium' } },
      resolveAgentDefinition: (id: string, value: any) => ({
        name: id, harness: value.brain.inline.harness, session: 'acp',
        role: value.role, brain: value.brain, permissions: value.permissions,
        monitor: { mode: 'fleet' },
      }),
    } as Partial<FleetConfig>);
    const prepared = prepareExecutionPlan(definition, configuration, {
      developer: {
        brain: 'Fast', approval: 'allow', filesystem: 'unrestricted', unattended: 'wait',
      },
    });
    const sealed = sealTemplateSnapshot(
      prepared.snapshot, configuration.agentTemplates!, prepared.launchDefinitions,
    );
    createRoomRecord({
      room_id: 'room-sealed-override', room_name: 'Room', room_identity_cid: 'room-cid',
      template_snapshot: sealed,
    });

    beginFleetAuditCollection();
    await provisionMembers({
      cfg: configuration, cowork: coworkHarness().cowork, roomId: 'room-sealed-override',
      template: sealed, binPath: '/usr/bin/ours-fleet',
    });

    expect(mocks.spawnTemp.mock.calls[0][0]).toMatchObject({
      agentDefinition: {
        brain: { inline: { harness: 'codex', model: 'gpt-test', effort: 'medium' } },
        permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
      },
    });
    expect(getRoomRecord('room-sealed-override')?.member_seats[0]?.launch?.agent_definition)
      .toMatchObject({
        brain: { inline: { harness: 'codex', model: 'gpt-test', effort: 'medium' } },
        permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
      });

    // The mixed-override launch presentation reports the exact resolved values
    // from the persisted role, with the sealed launch-definition label and
    // Inline origins remain durable for inspection, but member spawns are not
    // separate Owner lifecycle notices during room provisioning.
    const seat = getRoomRecord('room-sealed-override')!.member_seats[0]!;
    const presentation = seat.launch?.presentation;
    expect(presentation).toMatchObject({
      version: 1,
      template: seat.launch?.agent_template,
      role: { kind: 'inline' },
      brain: { kind: 'inline' },
      harness: 'codex', session: 'acp', model: 'gpt-test', effort: 'medium',
      mission: 'Developer',
      approval: 'allow', filesystem: 'unrestricted', unattended: 'wait',
      permissionMode: { fleetMode: expect.any(String), nativeMode: expect.any(String) },
      monitor: { mode: 'fleet', interrupt: true },
    });
    expect((presentation?.role as { fingerprint?: string }).fingerprint).toMatch(/^[a-f0-9]{12}$/u);
    expect((presentation?.brain as { fingerprint?: string }).fingerprint).toMatch(/^[a-f0-9]{12}$/u);
    expect(JSON.stringify(presentation)).not.toContain(root);
    expect(consumeFleetAuditCollection().presentations ?? []).toEqual([]);
  });

  it.each(['pair', 'team'] as const)(
    'routes every %s member through authenticated direct-spawn inheritance',
    async templateName => {
      process.env[FLEET_PROXY_STATE_DIR_ENV] = '/state/Coordinator';
      process.env[FLEET_PROXY_CALLER_ENV] = 'Coordinator';
      const roles = templateName === 'pair'
        ? ['Developer', 'Critic'] : ['LocalCoordinator', 'Developer', 'Critic'];
      const selected = {
        name: templateName, version: 1, description: `${templateName} fixture`,
        members: roles.map(role => ({
          slot: role === 'LocalCoordinator' ? 'local_coordinator' : role.toLowerCase(),
          role, count: 1, agent_template: role,
        })),
      };
      const launchCfg = cfg();
      for (const definition of Object.values(launchCfg.agentTemplates!)) definition.loops = {
        progress: { interval: '1m', prompt: `${templateName} sealed progress` },
      };
      const baseSnapshot = snapshotTemplate(selected, launchCfg.agentTemplates);
      const tpl = { ...baseSnapshot, members: baseSnapshot.members.map(member => ({
        ...member, loop_source: 'agent-template' as const,
      })) };
      createRoomRecord({
        room_id: `room-${templateName}`, room_name: 'Room', room_identity_cid: 'room-cid',
      });
      const h = coworkHarness();
      mockManagedSpawns();

      await provisionMembers({
        cfg: launchCfg, cowork: h.cowork, roomId: `room-${templateName}`, template: tpl,
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
          agentDefinition: launchCfg.agentTemplates?.[spawn.roomMemberStartup.role],
          loopSource: 'agent-template', callerRole: 'Coordinator', inheritedFromCaller: [],
        });
      }
    },
  );

  it('seals the default team continuity loop only onto LocalCoordinator', async () => {
    process.env[FLEET_PROXY_STATE_DIR_ENV] = '/state/Coordinator';
    process.env[FLEET_PROXY_CALLER_ENV] = 'Coordinator';
    const selected: TemplateDefinition = {
      name: 'team', version: 1, description: 'Default team fixture',
      members: ['LocalCoordinator', 'Developer', 'Critic'].map(role => ({
        slot: role === 'LocalCoordinator' ? 'local_coordinator' : role.toLowerCase(),
        role, count: 1, agent_template: role,
      })),
    };
    const launchCfg = cfg();
    launchCfg.agentTemplates!.LocalCoordinator.loops = {
      continuity: { interval: '15m', prompt: 'DEFAULT_CONTINUITY_CANARY' },
    };
    const baseSnapshot = snapshotTemplate(selected, launchCfg.agentTemplates);
    const tpl = { ...baseSnapshot, members: baseSnapshot.members.map(member => ({
      ...member,
      loop_source: member.role === 'LocalCoordinator'
        ? 'agent-template' as const : 'omitted' as const,
    })) };
    createRoomRecord({ room_id: 'room-team-continuity', room_name: 'Room', room_identity_cid: 'room-cid' });
    const h = coworkHarness();
    mockManagedSpawns();

    await provisionMembers({
      cfg: launchCfg, cowork: h.cowork, roomId: 'room-team-continuity', template: tpl,
      binPath: '/usr/bin/ours-fleet',
    });

    const spawns = mocks.spawnTemp.mock.calls.map(([spawn]) => spawn);
    const local = spawns.find(spawn => spawn.roomMemberStartup.role === 'LocalCoordinator');
    expect(local).toMatchObject({ loopSource: 'agent-template', agentDefinition: { loops: {
      continuity: { interval: '15m', prompt: 'DEFAULT_CONTINUITY_CANARY' },
    } } });
    for (const role of ['Developer', 'Critic']) {
      const spawn = spawns.find(candidate => candidate.roomMemberStartup.role === role);
      expect(spawn?.loopSource).toBe('omitted');
      expect(spawn?.agentDefinition.loops).toBeUndefined();
    }
  });

  it('uses direct temporary spawn safely when authenticated caller context is absent', async () => {
    createRoomRecord({
      room_id: 'room-standalone', room_name: 'Room', room_identity_cid: 'room-cid',
    });
    const h = coworkHarness();
    const singleCfg = cfg();
    singleCfg.agentTemplates!.Developer.loops = {
      progress: { interval: '1m', prompt: 'single sealed progress' },
    };
    const singleTemplate = { ...template(1), members: template(1).members.map(member => ({
      ...member, loop_source: 'agent-template' as const,
    })) };
    await provisionMembers({
      cfg: singleCfg, cowork: h.cowork, roomId: 'room-standalone', template: singleTemplate,
      binPath: '/usr/bin/ours-fleet',
    });
    expect(mocks.controlRequest).not.toHaveBeenCalled();
    expect(mocks.spawnTemp).toHaveBeenCalledOnce();
    expect(mocks.spawnTemp.mock.calls[0][0]).toMatchObject({ surface: 'agent',
      loopSource: 'agent-template', agentDefinition: { loops: {
        progress: { interval: '1m', prompt: 'single sealed progress' },
      } } });
    expect(mocks.spawnTemp.mock.calls[0][0]).not.toHaveProperty('callerRole');
    expect(mocks.spawnTemp.mock.calls[0][0]).not.toHaveProperty('inheritedFromCaller');
    const fallback = spawnDryRun({
      ...mocks.spawnTemp.mock.calls[0][0], name: 'fallback-preview', identity: 'fallback-preview',
    }).resolvedRole;
    expect(fallback).toMatchObject({
      harness: 'codex', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      monitor: { mode: 'fleet' },
    });
  });

  it('keeps the exact canonical member definition ahead of caller inheritance', async () => {
    process.env[FLEET_PROXY_STATE_DIR_ENV] = '/state/Coordinator';
    process.env[FLEET_PROXY_CALLER_ENV] = 'Coordinator';
    const tpl = template(1);
    const explicitDefinition = {
      brain: { inline: { harness: 'claude-code' } }, role: { inline: {} }, cwd: '/explicit',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
    };
    createRoomRecord({
      room_id: 'room-explicit', room_name: 'Room', room_identity_cid: 'room-cid',
    });
    const h = coworkHarness();
    mockManagedSpawns();

    await provisionMembers({
      cfg: cfg({ agentTemplates: { Developer: explicitDefinition } }), cowork: h.cowork, roomId: 'room-explicit', template: tpl,
      binPath: '/usr/bin/ours-fleet',
    });

    const spawn = mocks.spawnTemp.mock.calls[0][0];
    expect(spawn).toMatchObject({
      agentDefinition: { brain: { inline: { harness: 'claude-code' } }, role: { inline: {} },
        cwd: getRoomRecord('room-explicit')!.workspace!.path, permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' } },
    });
    expect(spawn.inheritedFromCaller).toEqual([]);
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
    beginFleetAuditCollection();
    await expect(provisionMembers(input)).rejects.toThrow('simulated process loss');

    expect(getRoomRecord('room-crash')!.member_seats[0].launch).toMatchObject({
      state: 'failed', caller_role: 'Coordinator',
    });
    expect(consumeFleetAuditCollection().presentations ?? []).toEqual([]);
    mocks.controlRequest.mockReset();
    mockManagedSpawns();

    await provisionMembers(input);

    expect(mocks.controlRequest).not.toHaveBeenCalled();
    expect(getRoomRecord('room-crash')!.member_seats[0].launch).toMatchObject({
      state: 'launched', action_id: supervisorAction, caller_role: 'Coordinator',
    });
    // The crash left no captured presentation; retaining the running launch
    // must backfill it from the same persisted resolved role it matched.
    expect(getRoomRecord('room-crash')!.member_seats[0].launch!.presentation).toMatchObject({
      version: 1, role: { kind: 'inline' }, brain: { kind: 'inline' },
      harness: 'codex', session: 'acp', mission: 'Developer',
      approval: 'ask', filesystem: 'workspace', unattended: 'wait',
      permissionMode: { fleetMode: expect.any(String), nativeMode: expect.any(String) },
      monitor: { mode: 'fleet', interrupt: true },
    });
  });
});


describe('existing-member reconciliation without launch effects', () => {
  async function pending() {
    const task = createTask({ title: 'Recover', origin: { type: 'cli' } });
    const roomId = 'room-existing-only';
    createRoomRecord({ room_id: roomId, room_name: 'Room', room_identity_cid: 'room-cid', task_id: task.task_id });
    updateTaskRoom(task.task_id, roomId, 'room-cid');
    const h = coworkHarness({ acceptOnSpawn: false });
    await provisionMembers({ cfg: cfg(), cowork: h.cowork, roomId, taskId: task.task_id,
      template: template(2), binPath: '/fleet', startupWait: { timeoutMs: 0 } });
    h.acceptAll();
    const expectedLaunches = getRoomRecord(roomId)!.member_seats.map(seat => ({
      role_name: seat.role_name, launch_id: seat.launch!.launch_id!, identity_cid: `cid-${seat.role_name}`,
    }));
    vi.clearAllMocks();
    return { h, roomId, task, input: { taskId: task.task_id, cowork: h.cowork, expectedLaunches } };
  }
  function noLifecycle(h: ReturnType<typeof coworkHarness>) {
    expect(mocks.spawnTemp).not.toHaveBeenCalled();
    expect(mocks.controlRequest).not.toHaveBeenCalled();
    expect(mocks.secureArchive).not.toHaveBeenCalled();
    expect(h.issueInvite).not.toHaveBeenCalled();
    expect(h.revokeInvite).not.toHaveBeenCalled();
    expect(h.cowork.recoverRoom).not.toHaveBeenCalled();
  }
  it('activates only proven existing seats and safely repeats after completion', async () => {
    const f = await pending();
    const before = getRoomRecord(f.roomId)!.member_seats.map(seat => seat.launch);
    const prior = getRoomRecord(f.roomId);
    await reconcileExistingTaskMembers({ ...f.input, checkOnly: true });
    expect(getRoomRecord(f.roomId)).toEqual(prior);
    expect(getTask(f.task.task_id).member_roles).toEqual([]);
    const result = await reconcileExistingTaskMembers(f.input);
    expect(result.state).toBe('active');
    expect(result.member_seats.every(seat => seat.seat_state === 'active')).toBe(true);
    expect(result.member_seats.map(seat => seat.launch)).toEqual(before);
    expect(getTask(f.task.task_id).member_roles).toHaveLength(2);
    expect(getTask(f.task.task_id).state).toBe('active');
    const completedRoom = getRoomRecord(f.roomId);
    const completedTask = getTask(f.task.task_id);
    await reconcileExistingTaskMembers(f.input);
    expect(getRoomRecord(f.roomId)).toEqual(completedRoom);
    expect(getTask(f.task.task_id)).toEqual(completedTask);
    noLifecycle(f.h);
  });
  it('resumes interruption after room activation without rewriting activation evidence', async () => {
    const f = await pending();
    const active = activateRoom(f.roomId);
    await reconcileExistingTaskMembers(f.input);
    expect(getRoomRecord(f.roomId)!.activated_at).toBe(active.activated_at);
    expect(getRoomRecord(f.roomId)!.saga.phase).toBe('completed');
    expect(getTask(f.task.task_id).state).toBe('active');
    noLifecycle(f.h);
  });
  it.each(['task', 'room'])('rechecks terminal fences after waiting for the %s lock', async boundary => {
    const f = await pending();
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = withFileLock(boundary === 'task' ? taskOperationLockPath(f.task.task_id)
      : roomCloseLockPath(f.roomId), async () => { acquired(); await gate; });
    await ready;
    const reconciliation = reconcileExistingTaskMembers(f.input);
    const rejected = expect(reconciliation).rejects.toThrow(/not open/);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (boundary === 'task') beginTaskTerminalIntent(f.task.task_id, { kind: 'cancelled', roomId: f.roomId });
    else beginRoomClose(f.roomId);
    const before = getRoomRecord(f.roomId);
    release();
    await held;
    await rejected;
    expect(getRoomRecord(f.roomId)).toEqual(before);
    expect(getTask(f.task.task_id).member_roles).toEqual([]);
    noLifecycle(f.h);
  });
  it.each(['stopped', 'unknown', 'cid', 'launch', 'roster', 'remote', 'terminal'])(
    'refuses %s evidence without changing room seats or launching replacements', async failure => {
      const f = await pending();
      if (failure === 'stopped' || failure === 'unknown') mocks.tempLiveness.mockResolvedValue(failure);
      if (failure === 'cid') f.input.expectedLaunches[1].identity_cid = 'wrong-cid';
      if (failure === 'launch') f.input.expectedLaunches[1].launch_id = 'wrong-launch';
      if (failure === 'roster') f.input.expectedLaunches.pop();
      if (failure === 'remote') vi.mocked(f.h.cowork.getRoom).mockResolvedValue(undefined);
      if (failure === 'terminal') beginTaskTerminalIntent(f.task.task_id, { kind: 'cancelled', roomId: f.roomId });
      const before = getRoomRecord(f.roomId);
      await expect(reconcileExistingTaskMembers(f.input)).rejects.toThrow();
      expect(getRoomRecord(f.roomId)).toEqual(before);
      expect(getTask(f.task.task_id).member_roles).toEqual([]);
      noLifecycle(f.h);
    });
});
