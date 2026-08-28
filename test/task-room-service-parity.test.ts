import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { loadConfigResourceSnapshotFromDocuments } from '../src/config-resource-loader.js';

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

function canonicalSnapshot() {
  const doc = (relativePath: string, text: string) => ({ relativePath, bytes: Buffer.from(text) });
  return loadConfigResourceSnapshotFromDocuments({
    bootstrapFile: '/cfg/fleet.yaml', configDir: '/cfg/fleet.conf.d',
    bootstrapBytes: Buffer.from('schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n'),
    documents: [
      doc('roles.d/dev.yaml', 'kind: Role\nversion: 1\nid: Developer\nspec: {}\n'),
      doc('brains.d/dev.yaml', 'kind: Brain\nversion: 1\nid: dev\nspec: {harness: codex, model: test, effort: medium, session: acp}\n'),
      doc('room-templates.d/empty.yaml', 'kind: RoomTemplate\nversion: 1\nid: empty-team\nspec:\n  version: 1\n  description: Canonical team\n  contract: Execute the task.\n  members:\n    - {slot: dev, role: Developer, count: 1, brain: {template: dev}, permissions: {approval: ask, filesystem: workspace, unattended: deny}}\n'),
      doc('room-templates.d/members.yaml', 'kind: RoomTemplate\nversion: 1\nid: members\nspec:\n  version: 1\n  description: Members\n  contract: Contract\n  members:\n    - {slot: dev, role: Developer, count: 1, brain: {template: dev}, permissions: {approval: ask, filesystem: workspace, unattended: deny}}\n'),
    ],
  });
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
    loadResourceSnapshot: canonicalSnapshot,
    provisionMembers: vi.fn(async ({ roomId, taskId }) => {
      const room = activateRoom(roomId);
      if (taskId) activateTask(taskId);
      return room;
    }),
  });
}

describe('task create/start surface parity', () => {
  it('rejects linked legacy rooms before active or provisioning task mutation', async () => {
    for (const state of ['active', 'provisioning'] as const) {
      const roomId = `legacy-${state}`;
      const legacy = snapshotTemplate(definition);
      const task = createTask({ title: `Legacy ${state}`, origin: { type: 'cli' }, start: true,
        room_id: roomId, template: { name: legacy.name, version: legacy.version,
          content_hash: legacy.content_hash } });
      if (state === 'active') activateTask(task.task_id);
      createRoomRecord({ room_id: roomId, room_name: roomId, task_id: task.task_id,
        room_identity_cid: 'room-cid', template_snapshot: legacy });
      const beforeTask = structuredClone(getTask(task.task_id));
      const beforeRoom = structuredClone(getRoomRecord(roomId));
      await expect(service(cowork().adapter).ensureTaskWork({
        actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
      })).rejects.toThrow(/recovery\/close-only/u);
      expect(getTask(task.task_id)).toEqual(beforeTask);
      expect(getRoomRecord(roomId)).toEqual(beforeRoom);
    }
  });

  it('rejects a dangling room reference before task mutation', async () => {
    const task = createTask({ title: 'Dangling', origin: { type: 'cli' }, start: false,
      room_id: 'missing-room', template: { name: 'empty-team', version: 1,
        content_hash: 'f'.repeat(64) } });
    const before = structuredClone(getTask(task.task_id));
    await expect(service(cowork().adapter).ensureTaskWork({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    })).rejects.toMatchObject({ code: 'task_non_resumable',
      fields: { task: task.task_id, room: 'missing-room' } });
    expect(getTask(task.task_id)).toEqual(before);
    expect(getRoomRecord('missing-room')).toBeUndefined();
  });

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

  it('rejects a legacy durable room before considering an explicit work override', async () => {
    const template = snapshotTemplate(definition);
    const task = createTask({ title: 'Pinned work', origin: { type: 'cli' }, start: true,
      room_id: 'room-pinned-work', template: { name: template.name, version: template.version,
        content_hash: template.content_hash } });
    createRoomRecord({ room_id: 'room-pinned-work', room_name: task.title, task_id: task.task_id,
      template_snapshot: template });
    const app = service(cowork().adapter);
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: task.task_id, template: 'does-not-exist' }))
      .rejects.toMatchObject({ code: 'task_non_resumable',
        fields: { task: task.task_id, room: 'room-pinned-work' } });
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
        { slot: 'dev', role: 'Developer', count: 1, role_ref: 'Dev' },
      ] };
    const cfg = { ...config(), roomTemplates: { members: memberTemplate } } as FleetConfig;
    const h = cowork();
    const provision = vi.fn(async ({ roomId }: { roomId: string }) => getRoomRecord(roomId)!);
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
      loadResourceSnapshot: canonicalSnapshot,
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
    const templateHash = canonicalSnapshot().sources.find(source =>
      source.kind === 'RoomTemplate' && source.id === 'empty-team')!.sha256;
    const task = createTask({
      title: 'Backlog', origin: { type: 'cli' }, start: false,
      template: { name: 'empty-team', version: 1, content_hash: templateHash },
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
