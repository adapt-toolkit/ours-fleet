import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import {
  activateTask, completeTask, createTask, getTask,
} from '../src/rooms-tasks/task-state.js';
import {
  activateRoom, advanceSaga, closeRoom, createRoomRecord, getRoomRecord, setSagaError,
} from '../src/rooms-tasks/room-state.js';
import { acceptTaskTerminalIntent } from '../src/rooms-tasks/terminal.js';
import { snapshotTemplate } from '../src/rooms-tasks/templates.js';
import type { FleetConfig } from '../src/config.js';
import type { CoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
import type { TemplateDefinition } from '../src/rooms-tasks/types.js';
import { writeV2Fixture } from './v2-fixture.js';

const definition: TemplateDefinition = {
  name: 'empty-team', version: 1, description: 'No members', members: [],
  contract: 'Execute the task.',
};

function config(): FleetConfig {
  return {
    roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
    watchdogs: [], loops: [], roomTemplates: { 'empty-team': definition },
    rooms: { owner: { role: 'Owner' }, defaults: { attach_owner: false } },
  } as FleetConfig;
}

function cowork() {
  const createRoom = vi.fn(async () => ({
    room_id: 'room-shared', identity_name: 'Room', identity_cid: 'room-cid',
  }));
  return {
    createRoom,
    adapter: {
      createRoom,
      acceptInvite: vi.fn(), issueInvite: vi.fn(), revokeInvite: vi.fn(),
      setRoleBriefing: vi.fn(), getHistory: vi.fn(), getRoom: vi.fn(), listRooms: vi.fn(),
      closeRoom: vi.fn(), deleteRoom: vi.fn(), getSeats: vi.fn(), recoverRoom: vi.fn(),
      available: vi.fn(),
    } as unknown as CoworkAdapter,
  };
}

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-task-service-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function service(fake: CoworkAdapter): TaskRoomApplicationService {
  return new TaskRoomApplicationService(undefined, {
    loadConfiguration: config, cowork: () => fake, binPath: () => '/fleet',
    provisionMembers: vi.fn(),
  });
}

describe('task create/start surface parity', () => {
  it('runs the extracted complete provision flow for create', async () => {
    const h = cowork();
    const result = await service(h.adapter).createTask({
      actor: { kind: 'local_control', surface: 'cli' },
      title: 'Ship', template: 'empty-team', origin: { type: 'cli' },
    });
    expect(result).toMatchObject({ state: 'active', room_id: 'room-shared', room_identity_cid: 'room-cid' });
    expect(getRoomRecord('room-shared')).toMatchObject({ task_id: result.task_id, state: 'active' });
    expect(h.createRoom).toHaveBeenCalledOnce();
  });

  it('pins a sealed execution plan for template-only backlog creation and starts after config removal', async () => {
    const h = cowork();
    let current = config();
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => current, cowork: () => h.adapter, binPath: () => '/fleet',
      provisionMembers: vi.fn(),
    });
    const backlog = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
      title: 'Pinned backlog', template: 'empty-team', backlog: true, origin: { type: 'cli' } });
    expect(backlog).toMatchObject({ state: 'backlog', execution_plan: {
      schema_version: 1, plan_hash: expect.any(String), snapshot: {
        name: 'empty-team', launch_snapshot_hash: expect.any(String),
      },
    } });
    current = { ...current, roomTemplates: {} };
    const started = await app.startTask({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: backlog.task_id });
    expect(started).toMatchObject({ state: 'active', room_id: 'room-shared',
      execution_plan: { plan_hash: backlog.execution_plan!.plan_hash } });
    expect(h.createRoom).toHaveBeenCalledOnce();
  });

  it('compares the complete active plan when either template or members is supplied', async () => {
    const memberDefinition: TemplateDefinition = { name: 'member-team', version: 1,
      description: 'Member team', members: [
        { slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' },
      ] };
    let cfg = { ...config(), roomTemplates: { 'member-team': memberDefinition, 'empty-team': definition }, agentTemplates: {
      Dev: { role: { inline: {} }, brain: { inline: { harness: 'codex' } },
        permissions: { approval: 'ask' } },
    }, resolveAgentDefinition: (id: string, value: any) => ({ name: id,
      harness: value.brain.inline.harness, harness_options: value.brain.inline.harness_options,
      permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
      monitor: { mode: 'fleet' }, session: 'acp' }) } as unknown as FleetConfig;
    const h = cowork();
    const provision = vi.fn(async ({ roomId, taskId }: { roomId: string; taskId?: string }) => {
      const room = activateRoom(roomId); if (taskId) activateTask(taskId); return room;
    });
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
      cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
    const members = { dev: { approval: 'allow' as const } };
    const active = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
      title: 'Active plan', template: 'member-team', members, origin: { type: 'cli' } });
    expect(active.state).toBe('active');
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, template: 'member-team', members }))
      .resolves.toMatchObject({ status: 'already_active' });
    cfg = { ...cfg, roomTemplates: {}, agentTemplates: {} } as FleetConfig;
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, members }))
      .resolves.toMatchObject({ status: 'already_active' });
    cfg = { ...config(), roomTemplates: { 'member-team': memberDefinition, 'empty-team': definition },
      agentTemplates: { Dev: { role: { inline: {} }, brain: { inline: { harness: 'codex' } },
        permissions: { approval: 'ask' } } }, resolveAgentDefinition: cfg.resolveAgentDefinition } as FleetConfig;
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, members: { dev: { approval: 'ask' } } }))
      .rejects.toMatchObject({ code: 'template_mismatch' });
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, template: 'empty-team' }))
      .rejects.toMatchObject({ code: 'template_mismatch' });
    expect(h.createRoom).toHaveBeenCalledOnce();
  });

  it('rejects full-resolution member policy errors before task transition, snapshots, or Cowork', async () => {
    const configPath = join(root, 'fleet.yaml');
    writeV2Fixture(configPath, { roles: {}, rooms: { owner: { role: 'Owner' },
      defaults: { attach_owner: false } }, room_templates: { members: { version: 1,
      description: 'members', members: [{ slot: 'dev', role: 'Developer', count: 1,
        agent_template: 'Dev' }] } } });
    const templatePath = join(root, 'fleet', 'agent_templates', 'Dev.yaml');
    writeFileSync(templatePath, [
      'role: { inline: { mission: work } }',
      'brain: { inline: { harness: codex, session: acp, model: gpt-5.6-sol } }',
      'permissions: { approval: allow, filesystem: unrestricted, unattended: wait }', '',
    ].join('\n'), { mode: 0o600 }); chmodSync(templatePath, 0o600);
    const h = cowork();
    const app = new TaskRoomApplicationService(configPath, { cowork: () => h.adapter,
      binPath: () => '/fleet', provisionMembers: vi.fn() });
    const invalid = [
      { brain: { inline: { harness: 'codex', session: 'invalid' } } },
      { monitor: { mode: 'invalid' } },
      { brain: { inline: { harness: 'codex', session: 'acp', model: 'gpt-5.6-sol',
        harness_options: { approval: 'never' } } }, permissions: {
        approval: 'ask', filesystem: 'workspace', unattended: 'wait' } },
      { permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' } },
    ];
    for (const overrides of invalid) {
      const task = createTask({ title: 'Invalid member', origin: { type: 'cli' }, start: false });
      await expect(app.startTask({ actor: { kind: 'local_control', surface: 'cli' },
        taskId: task.task_id, template: 'members', members: { dev: { overrides: overrides as any } } }))
        .rejects.toThrow();
      expect(getTask(task.task_id).state).toBe('backlog');
      expect(getTask(task.task_id).execution_plan).toBeUndefined();
      expect(existsSync(join(root, 'launch-snapshots'))).toBe(false);
    }
    expect(h.createRoom).not.toHaveBeenCalled();
  });

  it('owns normalized list/detail reads including linked orchestration', async () => {
    const h = cowork();
    const app = service(h.adapter);
    const active = await app.createTask({
      actor: { kind: 'local_control', surface: 'cli' }, title: 'Linked',
      template: 'empty-team', origin: { type: 'cli' },
    });
    createTask({ title: 'Backlog', origin: { type: 'cli' }, start: false });
    expect(app.listTasks({ state: 'active' }).map(task => task.task_id)).toEqual([active.task_id]);
    expect(app.getTask(active.task_id)).toEqual({
      task: active, orchestration: getRoomRecord('room-shared'),
    });
  });

  it('owns block, unblock, review, and delete state mutations', () => {
    const app = service(cowork().adapter);
    const task = createTask({ title: 'Lifecycle', origin: { type: 'cli' }, start: true });
    activateTask(task.task_id);
    expect(app.blockTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id, reason: 'deps',
    }).blocked?.reason).toBe('deps');
    expect(app.unblockTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    }).blocked).toBeUndefined();
    expect(app.reviewTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    }).state).toBe('review');
    completeTask(task.task_id);
    expect(app.deleteTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    })).toBe(true);
    expect(app.deleteTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    })).toBe(false);
  });

  it('uses configured done policy while cancellation always settles a linked room', async () => {
    const app = service(cowork().adapter);
    const done = createTask({
      title: 'Done policy', origin: { type: 'cli' }, start: true, room_id: 'room-done',
    });
    activateTask(done.task_id);
    app.reviewTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId: done.task_id });
    const completion = await app.completeTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: done.task_id,
    });
    expect(completion).toMatchObject({ settlementRequired: false, task: { state: 'done' } });

    const cancelled = createTask({
      title: 'Cancel policy', origin: { type: 'cli' }, start: false, room_id: 'room-cancel',
    });
    const cancellation = await app.cancelTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: cancelled.task_id,
    });
    expect(cancellation).toMatchObject({
      settlementRequired: true,
      task: { state: 'backlog', terminal_intent: { kind: 'cancelled', room_id: 'room-cancel' } },
    });
  });

  it('refuses internal settlement before constructing Cowork when rooms config is absent', async () => {
    const task = createTask({
      title: 'Pending cancel', origin: { type: 'cli' }, start: false, room_id: 'room-pending',
    });
    await acceptTaskTerminalIntent({
      taskId: task.task_id, kind: 'cancelled', roomId: task.room_id,
    });
    const coworkFactory = vi.fn();
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => ({
        roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
        watchdogs: [], loops: [], roomTemplates: {},
      } as FleetConfig),
      cowork: coworkFactory,
    });
    await expect(app.settleTask({
      actor: { kind: 'internal_worker', surface: 'cli' }, taskId: task.task_id,
    })).rejects.toThrow('rooms: configuration is required before creating or querying rooms');
    expect(coworkFactory).not.toHaveBeenCalled();
  });

  it('continues timed-out terminal recovery into provisioning and replaces issues on success', async () => {
    const template = snapshotTemplate(definition);
    const task = createTask({ title: 'Compound recovery', origin: { type: 'cli' }, start: true,
      room_id: 'room-compound', template: { name: template.name, version: template.version,
        content_hash: template.content_hash } });
    createRoomRecord({ room_id: 'room-compound', room_name: task.title, task_id: task.task_id,
      template_snapshot: template });
    advanceSaga('room-compound', 'create_room', 1);
    advanceSaga('room-compound', 'attach_owner', 2);
    advanceSaga('room-compound', 'create_members', 3);
    await acceptTaskTerminalIntent({ taskId: task.task_id, kind: 'cancelled', roomId: 'room-compound' });
    const provision = vi.fn(async () => getRoomRecord('room-compound')!);
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: config,
      cowork: () => cowork().adapter, binPath: () => '/fleet', provisionMembers: provision });
    expect(await app.beginTaskRecovery({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id })).toMatchObject({ kind: 'terminal_worker_required' });
    const result = await app.continueTaskRecovery({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id, terminalTimedOut: true });
    expect(provision).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: 'provisioning_resumed',
      issues: [{ code: 'provisioning_resumed' }] });
    await expect(app.continueTaskRecovery({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id, terminalTimedOut: true }))
      .rejects.toThrow('task recovery continuation requires a matching begin');
  });

  it('preserves exact recovery errors for missing and mismatched durable templates', async () => {
    const template = snapshotTemplate(definition);
    for (const mismatch of [false, true]) {
      const roomId = mismatch ? 'room-mismatch' : 'room-missing';
      const task = createTask({ title: roomId, origin: { type: 'cli' }, start: true, room_id: roomId,
        template: { name: template.name, version: template.version,
          content_hash: mismatch ? 'wrong' : template.content_hash } });
      createRoomRecord({ room_id: roomId, room_name: roomId, task_id: task.task_id,
        ...(mismatch ? { template_snapshot: template } : {}) });
      advanceSaga(roomId, 'create_room', 1); advanceSaga(roomId, 'attach_owner', 2);
      advanceSaga(roomId, 'create_members', 3);
      const app = service(cowork().adapter);
      await expect(app.beginTaskRecovery({ actor: { kind: 'local_control', surface: 'cli' },
        taskId: task.task_id })).rejects.toThrow(mismatch
        ? `task ${task.task_id} template reference does not match room ${roomId}'s durable snapshot`
        : `room ${roomId} has no durable template snapshot`);
    }
  });

  it('returns the exact caught missing-rooms resume failure without Cowork or provision effects', async () => {
    const template = snapshotTemplate(definition);
    const task = createTask({ title: 'No rooms config', origin: { type: 'cli' }, start: true,
      room_id: 'room-no-config', template: { name: template.name, version: template.version,
        content_hash: template.content_hash } });
    createRoomRecord({ room_id: 'room-no-config', room_name: task.title, task_id: task.task_id,
      template_snapshot: template });
    advanceSaga('room-no-config', 'create_room', 1); advanceSaga('room-no-config', 'attach_owner', 2);
    advanceSaga('room-no-config', 'create_members', 3);
    const coworkFactory = vi.fn(); const provision = vi.fn();
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => ({
      roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
      watchdogs: [], loops: [], roomTemplates: {},
    } as FleetConfig), cowork: coworkFactory, provisionMembers: provision });
    const begin = await app.beginTaskRecovery({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id });
    expect(begin).toMatchObject({ kind: 'final', result: { kind: 'provisioning_resume_failed',
      issues: [{ code: 'resume_failed',
        error: 'rooms: configuration is required before creating or querying rooms' }] } });
    expect(coworkFactory).not.toHaveBeenCalled(); expect(provision).not.toHaveBeenCalled();
  });

  it('owns CLI work provisioning and finish linked-room policy', async () => {
    const h = cowork(); const app = service(h.adapter);
    const backlog = createTask({ title: 'Work use case', origin: { type: 'cli' }, start: false });
    const worked = await app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: backlog.task_id, template: 'empty-team' });
    expect(worked).toMatchObject({ status: 'ready', task: { state: 'active', room_id: 'room-shared' } });
    app.reviewTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId: backlog.task_id });
    const finish = await app.finishTask({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: backlog.task_id, outcome: { summary: 'done' } });
    expect(finish).toMatchObject({ settlementRequired: true,
      task: { state: 'review', terminal_intent: { kind: 'done', room_id: 'room-shared' } } });
  });

  it('rejects an explicit unknown work template even when a durable room snapshot exists', async () => {
    const template = snapshotTemplate(definition);
    const task = createTask({ title: 'Pinned work', origin: { type: 'cli' }, start: true,
      room_id: 'room-pinned-work', template: { name: template.name, version: template.version,
        content_hash: template.content_hash } });
    createRoomRecord({ room_id: 'room-pinned-work', room_name: task.title, task_id: task.task_id,
      template_snapshot: template });
    const app = service(cowork().adapter);
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id, template: 'does-not-exist' }))
      .rejects.toMatchObject({ code: 'template_not_found', fields: { template: 'does-not-exist' } });
  });

  it('finish preserves active-to-review before linked acceptance', async () => {
    const app = service(cowork().adapter);
    const task = createTask({ title: 'Finish active', origin: { type: 'cli' }, start: true });
    activateTask(task.task_id);
    const result = await app.finishTask({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id });
    expect(result).toMatchObject({ settlementRequired: false, task: { state: 'done' } });
  });

  it('loads configured templates and cleans legacy rooms before live room listing', async () => {
    const closed = createRoomRecord({ room_id: 'room-legacy', room_name: 'Legacy' });
    closeRoom(closed.room_id);
    const deleteRoom = vi.fn(async () => undefined);
    const listRooms = vi.fn(async () => [{ room_id: 'room-live', identity_name: 'Live',
      identity_cid: 'cid-live', room_name: 'Live', state: 'active' as const, seats: [], role_briefings: {} }]);
    const adapter = { ...cowork().adapter, deleteRoom, listRooms } as CoworkAdapter;
    const app = service(adapter);
    expect(app.listTemplates().some(template => template.name === 'empty-team')).toBe(true);
    const rooms = await app.listRooms();
    expect(rooms).toMatchObject([{ room_id: 'room-live', orchestration: null }]);
    expect(deleteRoom).toHaveBeenCalledWith('room-legacy');
    expect(deleteRoom.mock.invocationCallOrder[0]).toBeLessThan(listRooms.mock.invocationCallOrder[0]);
    expect(getRoomRecord('room-legacy')).toBeUndefined();
  });

  it('creates standalone rooms with config-before-file ordering and file-over-brief', async () => {
    const missing = join(root, 'missing-brief.md');
    const invalid = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => { throw new Error('invalid config first'); },
    });
    await expect(invalid.createRoom({ actor: { kind: 'local_control', surface: 'cli' },
      name: 'Room', briefFile: missing })).rejects.toThrow('invalid config first');

    const briefFile = join(root, 'brief.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(briefFile, 'brief from file');
    const h = cowork();
    const result = await service(h.adapter).createRoom({
      actor: { kind: 'local_control', surface: 'cli' }, name: 'Standalone',
      brief: 'inline', briefFile, goal: 'Goal', template: 'empty-team',
    });
    expect(h.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      room_name: 'Standalone', goal: 'Goal', briefing: 'brief from file',
    }));
    expect(result).toMatchObject({ room_id: 'room-shared', state: 'active' });
    expect(result.task_id).toBeUndefined();
  });

  it('uses effective Cowork goal but preserves raw standalone goal and brief for members', async () => {
    const memberTemplate: TemplateDefinition = { name: 'members', version: 1,
      description: 'Members', contract: 'Contract', members: [
        { slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' },
      ] };
    const cfg = { ...config(), roomTemplates: { members: memberTemplate }, agentTemplates: {
      Dev: { role: { inline: {} }, brain: { inline: { harness: 'codex' } } },
    } } as FleetConfig;
    const h = cowork();
    const provision = vi.fn(async ({ roomId }: { roomId: string }) => getRoomRecord(roomId)!);
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
      cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
    await app.createRoom({ actor: { kind: 'local_control', surface: 'cli' }, name: 'Room name',
      template: 'members', goal: '  raw goal  ', brief: ' raw brief ' });
    expect(h.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      goal: 'raw goal', briefing: 'raw brief',
    }));
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      goal: '  raw goal  ', brief: ' raw brief ', taskId: undefined,
    }));
  });

  it('accepts room deletion without remote effects and recovery returns a worker plan', async () => {
    const room = createRoomRecord({ room_id: 'room-delete-plan', room_name: 'Delete plan' });
    activateRoom(room.room_id);
    const h = cowork();
    const app = service(h.adapter);
    const accepted = await app.requestRoomDeletion({
      actor: { kind: 'local_control', surface: 'cli' }, roomId: room.room_id,
    });
    expect(accepted).toMatchObject({ settlementRequired: true, room: { state: 'closing' } });
    expect(h.adapter.closeRoom).not.toHaveBeenCalled();
    expect(h.adapter.deleteRoom).not.toHaveBeenCalled();
    expect(await app.recoverRoom({ actor: { kind: 'local_control', surface: 'cli' },
      roomId: room.room_id })).toEqual({ kind: 'deletion_worker_required', roomId: room.room_id });
    expect(h.adapter.recoverRoom).not.toHaveBeenCalled();
  });

  it('constructs Cowork before tracked-room lookup and keeps repeated deletion acceptance first-wins', async () => {
    const construct = vi.fn(() => cowork().adapter);
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: config,
      cowork: construct, binPath: () => '/fleet', provisionMembers: vi.fn() });
    await expect(app.requestRoomDeletion({ actor: { kind: 'local_control', surface: 'cli' },
      roomId: 'missing-room' })).rejects.toMatchObject({ code: 'room_record_not_found' });
    expect(construct).toHaveBeenCalledOnce();

    const room = createRoomRecord({ room_id: 'room-repeat-delete', room_name: 'Repeat delete' });
    activateRoom(room.room_id);
    const first = await app.requestRoomDeletion({ actor: { kind: 'local_control', surface: 'cli' },
      roomId: room.room_id });
    const second = await app.requestRoomDeletion({ actor: { kind: 'local_control', surface: 'cli' },
      roomId: room.room_id });
    expect(second.room).toEqual(first.room);
    expect(second.room.state).toBe('closing');
  });

  it('reconciles the owner seat from an existing seat or accepts the configured invite', async () => {
    const expected = 'A'.repeat(64);
    const cfg = { ...config(), ownerInvite: 'invite', ownerInviteFingerprint: 'fingerprint',
      rooms: { owner: { role: 'Owner', expected_cid: expected }, defaults: { attach_owner: false } } } as FleetConfig;
    for (const existing of [true, false]) {
      const id = `owner-recovery-${existing}`;
      createRoomRecord({ room_id: id, room_name: id });
      advanceSaga(id, 'attach_owner', 2);
      setSagaError(id, 'owner unavailable', 'retry owner', 'waiting_owner_invite');
      const h = cowork();
      h.adapter.recoverRoom = vi.fn(async () => ({ room_id: id, state: 'active' })) as any;
      h.adapter.getSeats = vi.fn(async () => existing
        ? [{ identity_cid: expected.toLowerCase(), seat_state: 'joined' }] : []) as any;
      h.adapter.acceptInvite = vi.fn(async () => ({ seat_cid: expected })) as any;
      const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
        cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: vi.fn() });
      await app.recoverRoom({ actor: { kind: 'local_control', surface: 'cli' }, roomId: id });
      expect(getRoomRecord(id)).toMatchObject({
        owner_seat_cid: existing ? expected.toLowerCase() : expected,
        saga: { phase: 'create_members' },
      });
      expect(h.adapter.acceptInvite).toHaveBeenCalledTimes(existing ? 0 : 1);
    }
  });

  it('replaces diagnostics on successful provisioning resume and retains them on failure', async () => {
    const template = snapshotTemplate(definition);
    for (const succeeds of [true, false]) {
      const id = `resume-${succeeds}`;
      createRoomRecord({ room_id: id, room_name: id, template_snapshot: template });
      advanceSaga(id, 'create_members', 3);
      setSagaError(id, 'member launch failed', 'inspect members', 'waiting_seats');
      const h = cowork();
      h.adapter.recoverRoom = vi.fn(async () => ({ room_id: id, state: 'active' })) as any;
      const provision = succeeds ? vi.fn(async () => getRoomRecord(id)!)
        : vi.fn(async () => { throw new Error('launch still unavailable'); });
      const app = new TaskRoomApplicationService(undefined, { loadConfiguration: config,
        cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
      const result = await app.recoverRoom({ actor: { kind: 'local_control', surface: 'cli' }, roomId: id });
      if (succeeds) expect(result).toMatchObject({ kind: 'provisioning_resumed',
        issues: ['Provisioning resumed successfully'] });
      else {
        expect(result.kind).toBe('provisioning_resume_failed');
        expect(result.issues).toEqual(expect.arrayContaining([
          'A provisioning failure is recorded; inspect role logs for diagnostics.',
          'Recovery guidance is recorded; inspect role logs for diagnostics.',
          'Inspect temporary member logs for invite acceptance, then re-run recover',
          'Resume failed: launch still unavailable',
        ]));
      }
    }
  });

  it('reports non-resumable provisioning diagnostics without provisioning effects', async () => {
    const id = 'nonresumable-room';
    createRoomRecord({ room_id: id, room_name: id });
    setSagaError(id, 'create failed', 'inspect Cowork', 'waiting_cowork');
    const h = cowork();
    h.adapter.recoverRoom = vi.fn(async () => ({ room_id: id, state: 'active' })) as any;
    const provision = vi.fn();
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: config,
      cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision });
    const result = await app.recoverRoom({ actor: { kind: 'local_control', surface: 'cli' }, roomId: id });
    expect(result).toMatchObject({ kind: 'recovered' });
    expect(result.issues).toContain('Check ours-cowork service status');
    expect(provision).not.toHaveBeenCalled();
  });

  it('runs the extracted complete provision flow for start', async () => {
    const template = snapshotTemplate(definition);
    const task = createTask({
      title: 'Backlog', origin: { type: 'cli' }, start: false,
      template: { name: template.name, version: template.version, content_hash: template.content_hash },
    });
    const h = cowork();
    const result = await service(h.adapter).startTask({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    });
    expect(result).toMatchObject({ state: 'active', room_id: 'room-shared', room_identity_cid: 'room-cid' });
    expect(getTask(task.task_id)).toEqual(result);
    expect(getRoomRecord('room-shared')?.task_id).toBe(task.task_id);
  });

  it('preserves explicit no-room create semantics', async () => {
    const h = cowork();
    const result = await service(h.adapter).createTask({
      actor: { kind: 'local_control', surface: 'cli' }, title: 'Solo', noRoom: true,
      origin: { type: 'cli' },
    });
    expect(result).toMatchObject({ state: 'provisioning', no_room: true });
    expect(result.room_id).toBeUndefined();
    expect(h.createRoom).not.toHaveBeenCalled();
  });
});
