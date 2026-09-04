import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import {
  activateTask, completeTask, createTask, getTask, updateTaskMembers, updateTaskRoom,
} from '../src/rooms-tasks/task-state.js';
import {
  activateRoom, advanceSaga, closeRoom, createRoomRecord, getRoomRecord, setSagaError,
  updateMemberSeats, updateMemberStartup,
} from '../src/rooms-tasks/room-state.js';
import { acceptTaskTerminalIntent } from '../src/rooms-tasks/terminal.js';
import { snapshotTemplate } from '../src/rooms-tasks/templates.js';
import { readLaunchSnapshot } from '../src/rooms-tasks/launch-snapshot.js';
import type { FleetConfig } from '../src/config.js';
import { CoworkProtocolError, type CoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
import type { TemplateDefinition } from '../src/rooms-tasks/types.js';
import { writeV2Fixture } from './v2-fixture.js';
import {
  beginFleetAuditCollection, consumeFleetAuditCollection, setFleetAuditLifecycleCheckpoint,
} from '../src/fleet-command-audit.js';
import { deriveTaskRoomName } from '../src/rooms-tasks/task-room-name.js';

const definition: TemplateDefinition = {
  name: 'empty-team', version: 1, description: 'No members', members: [],
  contract: 'Execute the task.',
};

function config(): FleetConfig {
  return {
    roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
    watchdogs: [], loops: [], roomTemplates: { 'empty-team': definition },
    agentTemplates: { Dev: { role: { inline: {} }, brain: { inline: { harness: 'codex' } },
      permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' } } },
    resolveAgentDefinition: (id: string, value: any) => ({ name: id,
      harness: value.brain.inline.harness, permissions: value.permissions,
      monitor: { mode: 'fleet' }, session: 'acp' }),
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
  it.each([['single', 1], ['pair', 2], ['team', 3]] as const)(
    'emits only canonical created and ready lifecycle events for a %s launch',
    async (name, count) => {
      const members: TemplateDefinition = { name, version: 1, description: name,
        contract: 'Execute.', members: [{ slot: 'member', role: 'Developer', count, agent_template: 'Dev' }] };
      const cfg = { ...config(), roomTemplates: { [name]: members } } as FleetConfig;
      const h = cowork();
      const provision = vi.fn(async ({ roomId, taskId }: { roomId: string; taskId: string }) => {
        const seats = Array.from({ length: count }, (_, index) => ({
          role_name: `member-${index + 1}`, slot: 'member', cowork_role: 'Developer',
          identity_cid: `cid-${index + 1}`, seat_state: 'active' as const,
          launch: { state: 'launched' as const, attempt: 1, updated_at: new Date().toISOString() },
        }));
        updateMemberSeats(roomId, seats);
        updateTaskMembers(taskId, seats.map(seat => ({ name: seat.role_name,
          identity_cid: seat.identity_cid, slot: seat.slot, cowork_role: seat.cowork_role })));
        activateTask(taskId);
        return activateRoom(roomId);
      });
      const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
        cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
      beginFleetAuditCollection();
      const task = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
        title: `${name} launch`, template: name, origin: { type: 'cli' } });
      const events = consumeFleetAuditCollection().presentations ?? [];
      expect(task.state).toBe('active');
      expect(events.map(event => event.kind === 'room' ? event.operation : event.kind))
        .toEqual(['create', 'activate']);
      expect(events).toEqual([
        expect.objectContaining({ eventId: expect.stringMatching(/^room-created:/), memberCount: count }),
        expect.objectContaining({ eventId: expect.stringMatching(/^room-ready:/), memberCount: count }),
      ]);
    },
  );

  it('checkpoints created while the Room is visible but before member provisioning', async () => {
    const members: TemplateDefinition = { name: 'timing', version: 1, description: 'Timing',
      contract: 'Execute.', members: [{ slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' }] };
    const cfg = { ...config(), roomTemplates: { timing: members } } as FleetConfig;
    const h = cowork();
    const observed: Array<{ operation: string; roomState?: string }> = [];
    setFleetAuditLifecycleCheckpoint(async events => {
      observed.push(...events.map(event => ({ operation: event.kind === 'room' ? event.operation : event.kind,
        roomState: event.kind === 'room' ? getRoomRecord(event.id)?.state : undefined })));
    });
    try {
      const provision = vi.fn(async ({ roomId, taskId }: { roomId: string; taskId: string }) => {
        expect(observed).toEqual([{ operation: 'create', roomState: 'provisioning' }]);
        updateMemberSeats(roomId, [{ role_name: 'dev-1', slot: 'dev', cowork_role: 'Developer',
          identity_cid: 'cid-dev', seat_state: 'active', launch: {
            state: 'launched', attempt: 1, updated_at: new Date().toISOString() } }]);
        updateTaskMembers(taskId, [{ name: 'dev-1', identity_cid: 'cid-dev', slot: 'dev', cowork_role: 'Developer' }]);
        activateTask(taskId);
        return activateRoom(roomId);
      });
      const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
        cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
      beginFleetAuditCollection();
      await app.createTask({ actor: { kind: 'local_control', surface: 'cli' }, title: 'Timing',
        template: 'timing', origin: { type: 'cli' } });
      expect((consumeFleetAuditCollection().presentations ?? []).map(event =>
        event.kind === 'room' ? event.operation : event.kind)).toEqual(['activate']);
    } finally { setFleetAuditLifecycleCheckpoint(undefined); }
  });

  it('does not claim Room activation or Task work while member seats are still pending', async () => {
    const members: TemplateDefinition = { name: 'members', version: 1, description: 'Members',
      contract: 'Execute.', members: [{ slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' }] };
    const cfg = { ...config(), roomTemplates: { members } } as FleetConfig;
    const h = cowork();
    const provision = vi.fn(async ({ roomId }: { roomId: string }) => getRoomRecord(roomId)!);
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
      cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
    beginFleetAuditCollection();
    const task = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
      title: 'Waiting seats', template: 'members', origin: { type: 'cli' } });
    const events = consumeFleetAuditCollection().presentations ?? [];
    expect(task.state).toBe('provisioning');
    expect(events.filter(event => event.kind === 'room' && event.operation === 'activate')).toEqual([]);
    expect(events.filter(event => event.kind === 'task' && event.operation === 'work')).toEqual([]);
    expect(events).toEqual([expect.objectContaining({
      kind: 'room', operation: 'create', memberCount: 1,
    })]);
  });

  it('keeps a transient member failure resumable without Owner failure chatter', async () => {
    const members: TemplateDefinition = { name: 'members', version: 1, description: 'Members',
      contract: 'Execute.', members: [{ slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' }] };
    const cfg = { ...config(), roomTemplates: { members } } as FleetConfig;
    const snapshot = snapshotTemplate(members, cfg.agentTemplates);
    const task = createTask({ title: 'Failing start', origin: { type: 'cli' }, start: false,
      template: { name: snapshot.name, version: snapshot.version, content_hash: snapshot.content_hash } });
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
      cowork: () => cowork().adapter, binPath: () => '/fleet',
      provisionMembers: vi.fn(async () => { throw new Error('member launch failed'); }) as any });
    beginFleetAuditCollection();
    await expect(app.startTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id }))
      .resolves.toMatchObject({ state: 'provisioning', room_id: 'room-shared' });
    const failures = (consumeFleetAuditCollection().presentations ?? [])
      .filter(event => event.kind === 'lifecycle_failure');
    expect(failures).toEqual([]);
  });

  it('repairs created before ready after a crash between durable Room linkage and notification', async () => {
    const h = cowork();
    const app = service(h.adapter);
    const template = snapshotTemplate(definition, config().agentTemplates);
    const task = createTask({ title: 'Crash window', origin: { type: 'cli' }, start: true,
      template: { name: template.name, version: template.version, content_hash: template.content_hash } });
    const room = createRoomRecord({ room_id: 'room-after-crash', room_name: 'Crash window',
      room_identity_cid: 'room-cid', task_id: task.task_id, template_snapshot: template,
      room_policy: { anonymous: false } });
    updateTaskRoom(task.task_id, room.room_id, 'room-cid');
    activateRoom(room.room_id);
    activateTask(task.task_id);

    beginFleetAuditCollection();
    await expect(app.awaitTaskProvisioning({ actor: { kind: 'authenticated_owner',
      surface: 'messenger', cid: 'owner' }, taskId: task.task_id, waitMs: 0 }))
      .resolves.toMatchObject({ kind: 'ready' });
    expect(consumeFleetAuditCollection().presentations).toEqual([
      expect.objectContaining({ kind: 'room', operation: 'create', id: room.room_id,
        eventId: expect.stringMatching(/^room-created:/) }),
      expect.objectContaining({ kind: 'room', operation: 'activate', id: room.room_id,
        eventId: expect.stringMatching(/^room-ready:/) }),
    ]);
  });

  it('omits verbose seat launch presentations from the concise ready notice', async () => {
    const members: TemplateDefinition = { name: 'members', version: 1, description: 'Members',
      contract: 'Execute.', members: [{ slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' }] };
    const cfg = { ...config(), roomTemplates: { members } } as FleetConfig;
    const h = cowork();
    const presentation = {
      version: 1 as const, template: 'Dev',
      role: { kind: 'inline' as const, fingerprint: 'abcdefabcdef' },
      brain: { kind: 'inline' as const, fingerprint: '0f1e2d3c4b5a' },
      harness: 'codex', session: 'acp' as const, model: 'gpt-test', effort: 'medium',
      mission: 'Developer',
      approval: 'allow' as const, filesystem: 'unrestricted' as const, unattended: 'wait' as const,
      permissionMode: { fleetMode: 'allow' as const, nativeMode: 'full-access' },
      monitor: { mode: 'fleet' as const, interrupt: true },
    };
    const provision = vi.fn(async ({ roomId, taskId }: { roomId: string; taskId: string }) => {
      updateMemberSeats(roomId, [{ role_name: 'member-dev', slot: 'dev', cowork_role: 'Developer',
        identity_cid: 'cid-member-dev', seat_state: 'active' }]);
      updateMemberStartup(roomId, 'member-dev', { launch: {
        state: 'launched', attempt: 1, presentation, updated_at: new Date().toISOString() } });
      updateTaskMembers(taskId, [{ name: 'member-dev', identity_cid: 'cid-member-dev',
        slot: 'dev', cowork_role: 'Developer' }]);
      activateTask(taskId);
      return activateRoom(roomId);
    });
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => cfg,
      cowork: () => h.adapter, binPath: () => '/fleet', provisionMembers: provision as any });
    beginFleetAuditCollection();
    const task = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
      title: 'Configured', template: 'members', origin: { type: 'cli' } });
    const events = consumeFleetAuditCollection().presentations ?? [];
    expect(task.state).toBe('active');
    const activate = events.find(event => event.kind === 'room' && event.operation === 'activate') as
      Extract<typeof events[number], { kind: 'room' }>;
    expect(events.filter(event => event.kind === 'task')).toEqual([]);
    expect(activate).toMatchObject({ memberCount: 1, participants: [] });
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

  it('uses the template anonymous flag when no explicit override is supplied', async () => {
    const cfg = { ...config(), roomTemplates: {
      'empty-team': { ...definition, room: { anonymous: true } },
    } } as FleetConfig;
    const h = cowork();
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => cfg, cowork: () => h.adapter, binPath: () => '/fleet',
      provisionMembers: vi.fn(),
    });
    const result = await app.createTask({
      actor: { kind: 'local_control', surface: 'cli' }, title: 'Anonymous from template',
      template: 'empty-team', origin: { type: 'cli' },
    });

    expect(h.createRoom).toHaveBeenCalledWith(expect.objectContaining({ anonymous: true }));
    expect(result.execution_plan?.room_policy).toEqual({ anonymous: true });
  });

  it('lets an explicit CLI-style override disable template anonymity', async () => {
    const anonymousDefinition: TemplateDefinition = {
      ...definition, room: { anonymous: true },
    };
    const cfg = { ...config(), roomTemplates: { 'empty-team': anonymousDefinition } } as FleetConfig;
    const h = cowork();
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => cfg, cowork: () => h.adapter, binPath: () => '/fleet',
      provisionMembers: vi.fn(),
    });
    const result = await app.createTask({
      actor: { kind: 'local_control', surface: 'cli' }, title: 'Public override',
      template: 'empty-team', anonymous: false, origin: { type: 'cli' },
    });

    expect(h.createRoom).toHaveBeenCalledWith(expect.objectContaining({ anonymous: false }));
    expect(result.execution_plan?.room_policy).toEqual({ anonymous: false });
    expect(getRoomRecord(result.room_id!)?.room_policy).toEqual({ anonymous: false });
  });

  it('pins a sealed execution plan for template-only backlog creation and starts after config removal', async () => {
    const h = cowork();
    let current = config();
    const app = new TaskRoomApplicationService(undefined, {
      loadConfiguration: () => current, cowork: () => h.adapter, binPath: () => '/fleet',
      provisionMembers: vi.fn(),
    });
    const backlog = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
      title: 'Pinned backlog', template: 'empty-team', backlog: true, anonymous: true,
      origin: { type: 'cli' } });
    expect(backlog).toMatchObject({ state: 'backlog', execution_plan: {
      schema_version: 1, plan_hash: expect.any(String), room_policy: { anonymous: true }, snapshot: {
        name: 'empty-team', launch_snapshot_hash: expect.any(String),
      },
    } });
    current = { ...current, roomTemplates: {} };
    const started = await app.startTask({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: backlog.task_id, template: 'empty-team@1' });
    expect(started).toMatchObject({ state: 'active', room_id: 'room-shared',
      execution_plan: { plan_hash: backlog.execution_plan!.plan_hash, room_policy: { anonymous: true } } });
    expect(h.createRoom).toHaveBeenCalledOnce();
    expect(h.createRoom).toHaveBeenCalledWith(expect.objectContaining({ anonymous: true }));
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
    const members = { dev: { approval: 'allow' as const, loops: { progress: {
      interval: '1m', initial_delay: '0s', prompt: 'SEALED_IDEMPOTENT_LOOP',
    } } } };
    const active = await app.createTask({ actor: { kind: 'local_control', surface: 'cli' },
      title: 'Active plan', template: 'member-team', members, origin: { type: 'cli' } });
    expect(active.state).toBe('active');
    const sealedHash = active.execution_plan!.snapshot.launch_snapshot_hash!;
    expect(JSON.stringify(readLaunchSnapshot(sealedHash))).toContain('SEALED_IDEMPOTENT_LOOP');
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, template: 'member-team', members }))
      .resolves.toMatchObject({ status: 'already_active' });
    cfg = { ...cfg, roomTemplates: {}, agentTemplates: {} } as FleetConfig;
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, members }))
      .resolves.toMatchObject({ status: 'already_active' });
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, template: 'member-team@1' }))
      .resolves.toMatchObject({ status: 'already_active' });
    cfg = { ...config(), roomTemplates: { 'member-team': memberDefinition, 'empty-team': definition },
      agentTemplates: { Dev: { role: { inline: {} }, brain: { inline: { harness: 'codex' } },
        permissions: { approval: 'ask' } } }, resolveAgentDefinition: cfg.resolveAgentDefinition } as FleetConfig;
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, members: { dev: { approval: 'ask' } } }))
      .rejects.toMatchObject({ code: 'template_mismatch' });
    await expect(app.ensureTaskWork({ actor: { kind: 'local_control', surface: 'cli' },
      taskId: active.task_id, members: { dev: { approval: 'allow', loops: { progress: {
        interval: '2m', prompt: 'DIFFERENT_LOOP',
      } } } } }))
      .rejects.toMatchObject({ code: 'template_mismatch' });
    expect(JSON.stringify(readLaunchSnapshot(sealedHash))).toContain('SEALED_IDEMPOTENT_LOOP');
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

  it('keeps the canonical persisted name unchanged through recovery replay', async () => {
    const title = 'Fix inconsistent local/UTC chat timestamps in messenger-server';
    const h = cowork();
    const app = service(h.adapter);
    const task = await app.createTask({
      actor: { kind: 'local_control', surface: 'cli' }, title,
      template: 'empty-team', origin: { type: 'cli' },
    });
    const expected = deriveTaskRoomName(title, task.task_id);
    expect(task.title).toBe(title);
    expect(getRoomRecord('room-shared')?.room_name).toBe(expected);
    h.createRoom.mockClear();
    expect(await app.beginTaskRecovery({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    })).toMatchObject({ kind: 'final', result: { kind: 'no_op', room: { room_name: expected } } });
    expect(h.createRoom).not.toHaveBeenCalled();
    expect(getRoomRecord('room-shared')?.room_name).toBe(expected);
  });

  it('recovers a pre-room title validation failure through the canonical provision boundary', async () => {
    const title = 'Fix inconsistent local/UTC chat timestamps in messenger-server';
    const h = cowork();
    h.createRoom.mockRejectedValueOnce(new Error('generated room identity name is invalid'));
    const app = service(h.adapter);
    await expect(app.createTask({
      actor: { kind: 'local_control', surface: 'cli' }, title,
      template: 'empty-team', origin: { type: 'cli' },
    })).rejects.toThrow('generated room identity name is invalid');
    const task = app.listTasks()[0]!;
    expect(task.room_id).toBeUndefined();
    expect(task.execution_plan?.snapshot.launch_snapshot_hash).toEqual(expect.any(String));
    const recovery = await app.beginTaskRecovery({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    });
    const expected = deriveTaskRoomName(title, task.task_id);
    expect(recovery).toMatchObject({
      kind: 'final', result: {
        kind: 'provisioning_resumed', task: { title, room_id: 'room-shared' },
        room: { room_name: expected }, issues: [{ code: 'provisioning_resumed' }],
      },
    });
    expect(h.createRoom).toHaveBeenCalledTimes(2);
    expect(h.createRoom).toHaveBeenLastCalledWith(expect.objectContaining({ room_name: expected }));
    expect(getTask(task.task_id).title).toBe(title);
    expect(getRoomRecord('room-shared')?.room_name).toBe(expected);
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

  it('owns block, unblock, review, and delete state mutations', async () => {
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
    const accepted = await app.requestTaskDeletion({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    });
    expect(accepted.status).toBe('accepted');
    const settled = await app.settleTaskDeletion({
      actor: { kind: 'internal_worker', surface: 'cli' }, taskId: task.task_id,
    });
    expect(settled.deleted).toBe(true);
    expect(await app.requestTaskDeletion({
      actor: { kind: 'local_control', surface: 'cli' }, taskId: task.task_id,
    })).toEqual({ status: 'already_absent' });
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
    const template = snapshotTemplate(definition, config().agentTemplates);
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

  it('cleans a stale legacy room record when Cowork already deleted the room', async () => {
    const closed = createRoomRecord({ room_id: 'room-stale', room_name: 'Stale' });
    closeRoom(closed.room_id);
    const deleteRoom = vi.fn(async () => {
      throw new CoworkProtocolError('room.delete', 'room directory does not exist', 'not_found');
    });
    const listRooms = vi.fn(async () => [{ room_id: 'room-live', identity_name: 'Live',
      identity_cid: 'cid-live', room_name: 'Live', state: 'active' as const, seats: [], role_briefings: {} }]);
    const adapter = { ...cowork().adapter, deleteRoom, listRooms } as CoworkAdapter;

    await expect(service(adapter).listRooms()).resolves.toMatchObject([
      { room_id: 'room-live', orchestration: null },
    ]);
    expect(deleteRoom).toHaveBeenCalledWith('room-stale');
    expect(getRoomRecord('room-stale')).toBeUndefined();
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

  it('accepts room deletion without remote effects', async () => {
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

  it('runs the extracted complete provision flow for start', async () => {
    const template = snapshotTemplate(definition, config().agentTemplates);
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
