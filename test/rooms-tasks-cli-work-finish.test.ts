import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// ── Mock setup (vi.hoisted runs before vi.mock factories) ────────────────

const mocks = vi.hoisted(() => ({
  createRoom: vi.fn(),
  closeRoom: vi.fn().mockResolvedValue(undefined),
  deleteRoom: vi.fn().mockResolvedValue(undefined),
  provisionMembers: vi.fn(),
  closeManagedRoom: vi.fn(),
  deleteManagedRoom: vi.fn().mockResolvedValue({ room_id: 'room', deleted: true }),
  launchFleetWorker: vi.fn(),
  recoverRoom: vi.fn(),
  getRoom: vi.fn(),
  listRooms: vi.fn(),
  markdownRender: vi.fn(),
}));

vi.mock('../src/rooms-tasks/cowork-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rooms-tasks/cowork-adapter.js')>();
  return {
    ...actual,
    createCoworkAdapter: () => ({
      createRoom: mocks.createRoom,
      closeRoom: mocks.closeRoom,
      deleteRoom: mocks.deleteRoom,
      recoverRoom: mocks.recoverRoom,
      getRoom: mocks.getRoom,
      listRooms: mocks.listRooms,
      getSeats: vi.fn().mockResolvedValue([]),
    }),
  };
});

vi.mock('../src/rooms-tasks/provision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rooms-tasks/provision.js')>();
  return {
    ...actual,
    provisionMembers: mocks.provisionMembers,
    getBinPath: () => '/usr/bin/true',
  };
});

vi.mock('../src/rooms-tasks/close.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rooms-tasks/close.js')>();
  return {
    ...actual,
    closeManagedRoom: mocks.closeManagedRoom,
    deleteManagedRoom: mocks.deleteManagedRoom,
  };
});

vi.mock('../src/rooms-tasks/external-worker.js', () => ({
  launchFleetWorker: mocks.launchFleetWorker,
}));

vi.mock('../src/rooms-tasks/markdown.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rooms-tasks/markdown.js')>();
  return {
    ...actual,
    renderMarkdownResult: (...args: Parameters<typeof actual.renderMarkdownResult>) => {
      mocks.markdownRender('result');
      return actual.renderMarkdownResult(...args);
    },
    renderMarkdownList: (...args: Parameters<typeof actual.renderMarkdownList>) => {
      mocks.markdownRender('list');
      return actual.renderMarkdownList(...args);
    },
    renderMarkdownFailure: (...args: Parameters<typeof actual.renderMarkdownFailure>) => {
      mocks.markdownRender('failure');
      return actual.renderMarkdownFailure(...args);
    },
  };
});

// ── Imports (resolved after mock interception) ──────────────────────────

import { registerRoomCommands, registerTaskCommands } from '../src/rooms-tasks/cli.js';
import {
  createTask, getTask, startTask, activateTask, reviewTask, completeTask, cancelTask, updateTaskRoom,
  updateTaskMembers,
} from '../src/rooms-tasks/task-state.js';
import {
  createRoomRecord, activateRoom, getRoomRecord, advanceSaga, updateMemberSeats,
  updateRoomRoleBriefing, setSagaError,
} from '../src/rooms-tasks/room-state.js';
import { CoworkUnavailableError } from '../src/rooms-tasks/cowork-adapter.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { acceptTaskTerminalIntent } from '../src/rooms-tasks/terminal.js';
import { writeV2Fixture } from './v2-fixture.js';
import { beginFleetAuditCollection, consumeFleetAuditCollection } from '../src/fleet-command-audit.js';

const ROOM_ID = '01hzyk8m0000000000000000aa';

let dir: string;
let origHome: string | undefined;
let cfgPath: string;
let out: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

class ExitError extends Error {}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  const cOpt = (cmd: Command) => cmd.option('-c, --configuration <file>', 'config file');
  registerTaskCommands(program, cOpt);
  registerRoomCommands(program, cOpt);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await makeProgram().parseAsync(['task', ...args, '-c', cfgPath], { from: 'user' });
}

async function runLocalTask(...args: string[]): Promise<void> {
  await makeProgram().parseAsync(['task', ...args], { from: 'user' });
}

async function runRoom(...args: string[]): Promise<void> {
  await makeProgram().parseAsync(['room', ...args, '-c', cfgPath], { from: 'user' });
}

function expectExactJson(value: unknown): void {
  expect(`${out.join('\n')}\n`).toBe(`${JSON.stringify(value, null, 2)}\n`);
  expect(mocks.markdownRender).not.toHaveBeenCalled();
}

function writeCustomTemplate(include = true): void {
  writeV2Fixture(cfgPath,
    'roles: {}\n'
    + 'rooms:\n'
    + '  owner:\n    expected_cid: ' + 'a'.repeat(64) + '\n'
    + '  defaults:\n    attach_owner: false\n'
    + (include ? [
      'room_templates:',
      '  durable:',
      '    version: 7',
      '    description: durable template',
      '    members:',
      '      - { slot: dev, role: Developer, count: 1, agent: { ref: Dev } }',
      '',
    ].join('\n') : ''));
}

function backlogTask() {
  return createTask({ title: 'Fix the parser', origin: { type: 'cli' }, no_room: true, start: false });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-cli-wf-'));
  origHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = dir;
  cfgPath = join(dir, 'fleet.yaml');
  writeV2Fixture(cfgPath,
    'roles: {}\n'
    + 'rooms:\n'
    + '  owner:\n    expected_cid: ' + 'a'.repeat(64) + '\n'
    + '  defaults:\n    attach_owner: false\n');
  out = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((line: unknown) => { out.push(String(line)); return true; });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new ExitError(); }) as never);

  mocks.createRoom.mockReset().mockResolvedValue({ room_id: ROOM_ID, identity_cid: 'c'.repeat(64) });
  mocks.recoverRoom.mockReset().mockResolvedValue({
    room_id: ROOM_ID, identity_name: 'room-id', identity_cid: 'c'.repeat(64),
    room_name: 'Fix the parser', state: 'active', seats: [], role_briefings: {},
  });
  mocks.getRoom.mockReset().mockResolvedValue({
    room_id: ROOM_ID, identity_name: 'room-id', identity_cid: 'c'.repeat(64),
    room_name: 'Fix the parser', state: 'active', seats: [], role_briefings: {},
  });
  mocks.listRooms.mockReset().mockResolvedValue([]);
  mocks.closeRoom.mockReset().mockResolvedValue(undefined);
  mocks.deleteRoom.mockReset().mockResolvedValue(undefined);
  mocks.closeManagedRoom.mockReset();
  mocks.deleteManagedRoom.mockReset().mockImplementation(async ({ roomId }: { roomId: string }) => {
    const { deleteRoomRecord } = await import('../src/rooms-tasks/room-state.js');
    deleteRoomRecord(roomId);
    return { room_id: roomId, deleted: true };
  });
  mocks.launchFleetWorker.mockReset().mockImplementation(async (args: string[]) => {
    if (args[0] === 'room' && args[1] === '_delete') {
      const roomId = args[2];
      setTimeout(() => {
        void mocks.deleteManagedRoom({
          roomId,
          cowork: { closeRoom: mocks.closeRoom, deleteRoom: mocks.deleteRoom },
        }).catch(() => undefined);
      }, 0);
      return;
    }
    if (args[0] !== 'task' || args[1] !== '_settle') return;
    const taskId = args[2];
    setTimeout(() => {
      void import('../src/rooms-tasks/terminal.js').then(({ settleTaskTerminalIntent }) =>
        settleTaskTerminalIntent({
          taskId,
          cowork: { closeRoom: mocks.closeRoom, deleteRoom: mocks.deleteRoom },
        }).catch(() => undefined));
    }, 0);
  });
  mocks.markdownRender.mockReset();
  // The real provisionMembers ends by activating the room and the task; the
  // fake preserves exactly that contract so the CLI's state flow is exercised.
  mocks.provisionMembers.mockReset().mockImplementation(async ({ roomId, taskId, template }:
    { roomId: string; taskId?: string; template?: { name?: string } }) => {
    if (template?.name === 'durable') {
      const member = { name: 'dev-1', identity_cid: 'd'.repeat(64), slot: 'dev', cowork_role: 'Developer' };
      updateMemberSeats(roomId, [{ role_name: member.name, identity_cid: member.identity_cid,
        slot: member.slot, cowork_role: member.cowork_role, seat_state: 'active', launch: {
          state: 'launched', attempt: 1, action_id: 'action-1', updated_at: '2026-08-30T00:00:00.000Z',
          agent_definition: { brain: { ref: 'codex' }, role: { ref: 'Developer' } },
        } }]);
      if (taskId) updateTaskMembers(taskId, [member]);
    }
    const record = activateRoom(roomId);
    if (taskId) activateTask(taskId);
    return record;
  });
});

describe('room delete', () => {
  async function activeRoom() {
    const { createRoomRecord } = await import('../src/rooms-tasks/room-state.js');
    const room = createRoomRecord({ room_id: ROOM_ID, room_name: 'Disposable room' });
    activateRoom(room.room_id);
    return room;
  }

  it('requires the room ID twice', async () => {
    await activeRoom();
    await expect(runRoom('delete', ROOM_ID)).rejects.toThrow("missing required argument 'confirm-id'");
    expect(getRoomRecord(ROOM_ID)).toBeDefined();
    expect(mocks.deleteManagedRoom).not.toHaveBeenCalled();
  });

  it('deletes the room and reports binary deletion', async () => {
    await activeRoom();
    await runRoom('delete', ROOM_ID, ROOM_ID);
    expect(getRoomRecord(ROOM_ID)).toBeUndefined();
    expect(mocks.deleteManagedRoom).toHaveBeenCalledWith(expect.objectContaining({ roomId: ROOM_ID }));
    expect(out.join('\n')).toContain('## 🗑️ Room deleted');
    expect(out.join('\n')).toContain(`**ID:** \`${ROOM_ID}\``);
    expect(out.join('\n')).not.toContain('closed');
  });

  it('keeps room close as a deprecated deletion alias', async () => {
    await activeRoom();
    await runRoom('close', ROOM_ID, ROOM_ID, '--json');
    expect(getRoomRecord(ROOM_ID)).toBeUndefined();
    expect(JSON.parse(out.join('\n'))).toMatchObject({ room_id: ROOM_ID, deleted: true });
  });

  it('room list migrates legacy closed state without touching an active room', async () => {
    const active = await activeRoom();
    const legacyId = '01hzyk8m0000000000000000bb';
    const { createRoomRecord, closeRoom } = await import('../src/rooms-tasks/room-state.js');
    createRoomRecord({ room_id: legacyId, room_name: 'Legacy closed room' });
    closeRoom(legacyId);
    mocks.listRooms.mockResolvedValue([
      {
        room_id: active.room_id, identity_name: 'active-room', identity_cid: 'c'.repeat(64),
        room_name: active.room_name, state: 'active', seats: [], role_briefings: {},
      },
      {
        room_id: legacyId, identity_name: 'legacy-room', identity_cid: 'd'.repeat(64),
        room_name: 'Legacy closed room', state: 'closed', seats: [], role_briefings: {},
      },
    ]);

    await runRoom('list');

    expect(mocks.deleteRoom).toHaveBeenCalledWith(legacyId);
    expect(getRoomRecord(legacyId)).toBeUndefined();
    expect(getRoomRecord(active.room_id)?.state).toBe('active');
    expect(out.join('\n')).toContain(active.room_id);
    expect(out.join('\n')).not.toContain(legacyId);
  });
});

describe('public task/room failure presentation', () => {
  function expectMarkdownFailure(text: string): void {
    expect(text).toMatch(/^## ⚠️ /u);
    expect(text).toContain('### Next step');
    expect(text).not.toMatch(/^error:/mu);
    expect(text).not.toContain('/secret/path');
  }

  it('formats task cancel and delete confirmation mismatches as actionable Markdown', async () => {
    for (const command of ['cancel', 'delete']) {
      out = [];
      await expect(run(command, 'task-a', 'task-b')).rejects.toThrow(ExitError);
      expectMarkdownFailure(out.join('\n'));
      expect(out.join('\n')).toContain('Repeat the same task ID twice.');
    }
  });

  it('formats room delete and deprecated close confirmation mismatches as actionable Markdown', async () => {
    for (const command of ['delete', 'close']) {
      out = [];
      await expect(runRoom(command, 'room-a', 'room-b')).rejects.toThrow(ExitError);
      expectMarkdownFailure(out.join('\n'));
      expect(out.join('\n')).toContain('Repeat the same room ID twice.');
    }
  });

  it('formats room show, open, and members not-found failures as actionable Markdown', async () => {
    mocks.getRoom.mockResolvedValue(null);
    for (const command of ['show', 'open', 'members']) {
      out = [];
      await expect(runRoom(command, 'missing-room')).rejects.toThrow(ExitError);
      expectMarkdownFailure(out.join('\n'));
      expect(out.join('\n')).toContain('Run ours-fleet room list');
    }
  });
});

describe('canonical proxied Task/Room audit metadata', () => {
  it.each([false, true])('captures real task create/start transitions (json=%s)', async json => {
    writeCustomTemplate();
    beginFleetAuditCollection();
    await run('create', '--title', 'Audited task', '--backlog', '--template', 'durable',
      ...(json ? ['--json'] : []));
    const created = consumeFleetAuditCollection();
    expect(created.presentation).toMatchObject({ kind: 'task', operation: 'create',
      title: 'Audited task', previousState: 'none', newState: 'backlog', agents: [] });
    const id = (created.presentation as { id: string }).id;

    out = [];
    beginFleetAuditCollection();
    await run('start', id, ...(json ? ['--json'] : []));
    expect(consumeFleetAuditCollection()).toMatchObject({
      resourceIds: { task: id, room: ROOM_ID },
      presentation: { kind: 'task', operation: 'start', id, title: 'Audited task',
        previousState: 'backlog', newState: 'active', template: 'durable@7', roomId: ROOM_ID,
        agents: [{ name: expect.any(String), brain: expect.any(String), role: expect.any(String) }] },
    });
  });

  it.each([false, true])('captures cancellation and truthful task deletion (json=%s)', async json => {
    const cancellable = backlogTask();
    beginFleetAuditCollection();
    await runLocalTask('cancel', cancellable.task_id, cancellable.task_id, ...(json ? ['--json'] : []));
    expect(consumeFleetAuditCollection().presentation).toMatchObject({ kind: 'task',
      operation: 'cancel', id: cancellable.task_id, previousState: 'backlog', newState: 'cancelled' });

    const done = backlogTask();
    startTask(done.task_id); activateTask(done.task_id); reviewTask(done.task_id); completeTask(done.task_id);
    beginFleetAuditCollection();
    await runLocalTask('delete', done.task_id, done.task_id, ...(json ? ['--json'] : []));
    expect(consumeFleetAuditCollection().presentation).toMatchObject({ kind: 'task',
      operation: 'delete', id: done.task_id, previousState: 'done', newState: 'deleted' });
  });

  it.each([false, true])('captures room create/recover/delete metadata (json=%s)', async json => {
    writeCustomTemplate();
    beginFleetAuditCollection();
    await runRoom('create', '--name', 'Audited room', '--template', 'durable', ...(json ? ['--json'] : []));
    expect(consumeFleetAuditCollection()).toMatchObject({
      resourceIds: { room: ROOM_ID },
      presentation: { kind: 'room', operation: 'create', id: ROOM_ID,
        previousState: 'none', newState: 'active', template: 'durable@7',
        participants: [{ name: expect.any(String), role: expect.any(String) }] },
    });

    out = [];
    beginFleetAuditCollection();
    await runRoom('recover', ROOM_ID, ...(json ? ['--json'] : []));
    expect(consumeFleetAuditCollection().presentation).toMatchObject({ kind: 'room',
      operation: 'recover', id: ROOM_ID, previousState: 'active', newState: 'active',
      template: 'durable@7', participants: [{ name: expect.any(String), role: expect.any(String) }] });

    out = [];
    beginFleetAuditCollection();
    await runRoom('delete', ROOM_ID, ROOM_ID, ...(json ? ['--json'] : []));
    expect(consumeFleetAuditCollection().presentation).toMatchObject({ kind: 'room',
      operation: 'delete', id: ROOM_ID, previousState: 'active', newState: 'deleted',
      template: 'durable@7', participants: [{ name: expect.any(String), role: expect.any(String) }] });
  });

  it('classifies proxied JSON validation separately from unexpected runtime failure', async () => {
    beginFleetAuditCollection();
    await expect(runLocalTask('show', 'definitely-missing', '--json')).rejects.toThrow(ExitError);
    expect(consumeFleetAuditCollection().failure).toEqual({ class: 'validation', effect: 'not_started' });

    mocks.getRoom.mockRejectedValueOnce(new Error('backend exploded'));
    beginFleetAuditCollection();
    await expect(runRoom('show', ROOM_ID, '--json')).rejects.toThrow(ExitError);
    expect(consumeFleetAuditCollection().failure).toEqual({ class: 'runtime', effect: 'unknown' });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
  else delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

// ── task work ────────────────────────────────────────────────────────────

describe('task title to Cowork room naming', () => {
  const unicodeTitle = 'Релиз 🚀 — 東京 / naïve café';

  function expectExactRoomName(): void {
    expect(mocks.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      room_name: unicodeTitle,
    }));
    expect(getRoomRecord(ROOM_ID)?.room_name).toBe(unicodeTitle);
  }

  it('preserves an immediate task create title exactly', async () => {
    await run('create', '--title', unicodeTitle, '--json');
    expect(JSON.parse(out.join('\n')).task.title).toBe(unicodeTitle);
    expectExactRoomName();
  });

  it('preserves a backlog title exactly when task start creates its room', async () => {
    await run('create', '--title', unicodeTitle, '--backlog', '--json');
    const taskId = JSON.parse(out.join('\n')).task.task_id as string;
    out = [];
    mocks.createRoom.mockClear();
    await run('start', taskId, '--json');
    expect(JSON.parse(out.join('\n')).task.title).toBe(unicodeTitle);
    expectExactRoomName();
  });

  it('preserves a backlog title exactly when task work creates its room', async () => {
    const task = createTask({
      title: unicodeTitle, origin: { type: 'cli' }, no_room: true, start: false,
    });
    await run('work', task.task_id, '--json');
    expect(JSON.parse(out.join('\n')).task.title).toBe(unicodeTitle);
    expectExactRoomName();
  });
});

describe('decomposed task title to Cowork room naming', () => {
  const decomposedTitle = 'Cafe\u0301 release — A\u030Angstro\u0308m';

  function expectExactDecomposedRoomName(): void {
    expect(decomposedTitle).not.toBe(decomposedTitle.normalize('NFC'));
    expect(mocks.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      room_name: decomposedTitle,
    }));
    expect(getRoomRecord(ROOM_ID)?.room_name).toBe(decomposedTitle);
  }

  it('preserves decomposed code points through task create and room create', async () => {
    await run('create', '--title', decomposedTitle, '--json');
    expect(JSON.parse(out.join('\n')).task.title).toBe(decomposedTitle);
    expectExactDecomposedRoomName();
  });

  it('preserves decomposed code points when task start creates the room', async () => {
    await run('create', '--title', decomposedTitle, '--backlog', '--json');
    const taskId = JSON.parse(out.join('\n')).task.task_id as string;
    out = [];
    mocks.createRoom.mockClear();
    await run('start', taskId, '--json');
    expect(JSON.parse(out.join('\n')).task.title).toBe(decomposedTitle);
    expectExactDecomposedRoomName();
  });

  it('preserves decomposed code points when task work creates the room', async () => {
    const task = createTask({
      title: decomposedTitle, origin: { type: 'cli' }, no_room: true, start: false,
    });
    await run('work', task.task_id, '--json');
    expect(JSON.parse(out.join('\n')).task.title).toBe(decomposedTitle);
    expectExactDecomposedRoomName();
  });
});

describe('task work', () => {
  it('takes a backlog task to active with a provisioned room', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    const after = getTask(t.task_id);
    expect(after.state).toBe('active');
    expect(after.room_id).toBe(ROOM_ID);
    expect(getRoomRecord(ROOM_ID)!.task_id).toBe(t.task_id);
    expect(out.join('\n')).toContain(`**Room:** \`${ROOM_ID}\``);
  });

  it('defaults to the single template when none is configured or stored', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    expect(out.join('\n')).toContain('**Template:** `single@1`');
    expect(mocks.provisionMembers).toHaveBeenCalledWith(
      expect.objectContaining({ template: expect.objectContaining({ name: 'single' }) }));
  });

  it('honours an explicit --template over the default', async () => {
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'team');
    expect(out.join('\n')).toContain('**Template:** `team@1`');
    expect(mocks.provisionMembers).toHaveBeenCalledWith(
      expect.objectContaining({ template: expect.objectContaining({ name: 'team' }) }));
  });

  it('is idempotent on an already-active task: reports and provisions nothing', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    mocks.createRoom.mockClear();
    await run('work', t.task_id);
    expect(out.join('\n')).toContain('## 📋 Task already active');
    expect(mocks.createRoom).not.toHaveBeenCalled();
    expect(getTask(t.task_id).room_id).toBe(ROOM_ID);
  });

  it('reports already_active in --json without re-provisioning', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    out = [];
    mocks.markdownRender.mockClear();
    await run('work', t.task_id, '--json');
    const payload = JSON.parse(out.join('\n'));
    expect(payload.status).toBe('already_active');
    expect(payload.task.task_id).toBe(t.task_id);
    expectExactJson({ schema_version: 1, task: getTask(t.task_id), status: 'already_active' });
  });

  it('task and room show expose per-seat launch and authenticated seat evidence', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    updateRoomRoleBriefing(ROOM_ID, 'Developer', {
      role: 'Developer', text: 'charter', sha256: 'f'.repeat(64), version: 2,
      state: 'configured', attempts: 1, updated_at: '2026-08-24T00:00:00.000Z',
    });
    updateMemberSeats(ROOM_ID, [{
      role_name: 'dev-1', identity_cid: 'd'.repeat(64), slot: 'dev',
      cowork_role: 'Developer', seat_state: 'active',
      launch: {
        state: 'launched', attempt: 1, action_id: 'action-1', launch_id: 'launch-1',
        mission_sha256: 'e'.repeat(64), updated_at: '2026-08-24T00:00:00.000Z',
      },
      briefing: {
        role: 'Developer', state: 'relay_queued', message_id: 'briefing-2',
        relay_result_record_id: 'relay-2', rejected_ack_count: 1,
        last_rejected_ack_seq: 9, last_rejected_ack_reason: 'owner_seat_cid mismatch',
      },
    }]);
    out = [];
    mocks.markdownRender.mockClear();
    await runLocalTask('show', t.task_id, '--json');
    const taskPayload = JSON.parse(out.join('\n'));
    expect(taskPayload.orchestration.member_seats[0].briefing.state).toBe('relay_queued');
    expectExactJson({
      schema_version: 1, task: getTask(t.task_id), orchestration: getRoomRecord(ROOM_ID),
    });

    out = [];
    await runRoom('show', ROOM_ID);
    const text = out.join('\n');
    expect(text).toContain('seat active, launch launched');
    expect(text).not.toContain('briefing relay\\_queued');
    expect(text).not.toContain('acknowledgement');
    expect(text).not.toContain('sha256:');
    expect(text).toContain('`Developer` — version `2` — configured');
  });

  it('redacts stored saga errors and recovery hints from local human output', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    const secret = 'cannot connect using /secret/path token=canary-token';
    setSagaError(ROOM_ID, secret, secret, 'member_failed');
    out = [];
    await runRoom('show', ROOM_ID);
    await runRoom('recover', ROOM_ID);
    const text = out.join('\n');
    expect(text).toContain('inspect role logs');
    expect(text).not.toContain('/secret/path');
    expect(text).not.toContain('canary-token');
  });

  it('refuses a terminal-state task', async () => {
    const t = backlogTask();
    cancelTask(t.task_id);
    await expect(run('work', t.task_id)).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('## ⚠️ Action not allowed');
    expect(out.join('\n')).toContain('already in a terminal state');
    expect(mocks.createRoom).not.toHaveBeenCalled();
  });

  it('errors on an unknown template', async () => {
    const t = backlogTask();
    await expect(run('work', t.task_id, '--template', 'nope')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('## ⚠️ Not found');
    expect(out.join('\n')).toContain('ours-fleet template list');
  });

  it('blocks the task and errors when cowork is unavailable', async () => {
    mocks.createRoom.mockRejectedValue(new CoworkUnavailableError('socket missing'));
    const t = backlogTask();
    await expect(run('work', t.task_id)).rejects.toThrow(ExitError);
    const after = getTask(t.task_id);
    expect(after.state).toBe('provisioning');
    expect(after.blocked?.reason).toContain('unavailable');
  });

  it('retries provisioning for a blocked provisioning task', async () => {
    mocks.createRoom.mockRejectedValueOnce(new CoworkUnavailableError('socket missing'));
    const t = backlogTask();
    await expect(run('work', t.task_id)).rejects.toThrow(ExitError);
    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');
  });

  it('persists the selected template snapshot on the task before provisioning', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    const after = getTask(t.task_id);
    expect(after.template?.name).toBe('single');
    expect(after.template?.version).toBe(1);
    expect(after.template?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-pins the task to an explicit --template override', async () => {
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'team');
    const after = getTask(t.task_id);
    expect(after.template?.name).toBe('team');
    expect(after.template?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a stored template whose snapshot has drifted, like task start', async () => {
    const t = createTask({
      title: 'Fix the parser',
      origin: { type: 'cli' },
      start: false,
      template: { name: 'team', version: 1, content_hash: 'f'.repeat(64) },
    });
    await expect(run('work', t.task_id)).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('template snapshot no longer matches the recorded template');
    expect(getTask(t.task_id).state).toBe('backlog');
    expect(mocks.createRoom).not.toHaveBeenCalled();
  });

  it('preserves the versioned CLI task-start drift error contract', async () => {
    const t = createTask({
      title: 'Drifted start', origin: { type: 'cli' }, start: false,
      template: { name: 'team', version: 7, content_hash: 'f'.repeat(64) },
    });
    await expect(run('start', t.task_id, '--json')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('team@7');
    expect(getTask(t.task_id).state).toBe('provisioning');
    expect(mocks.createRoom).not.toHaveBeenCalled();
  });

  it('resumes a room stuck in waiting_seats: second work reaches active', async () => {
    // First provisioning run ends with seats pending, exactly as the real
    // provisionMembers does when getSeats reports inactive members.
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('provisioning');
    expect(getRoomRecord(ROOM_ID)!.saga.phase).toBe('wait_seats');

    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');
    expect(mocks.createRoom).toHaveBeenCalledTimes(1);
    expect(mocks.provisionMembers).toHaveBeenCalledTimes(2);
    expect(mocks.provisionMembers).toHaveBeenLastCalledWith(
      expect.objectContaining({ roomId: ROOM_ID, taskId: t.task_id }));
  });

  it('work recovery uses the durable room snapshot after config template removal', async () => {
    writeCustomTemplate(true);
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'durable');
    writeCustomTemplate(false);
    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');
    expect(mocks.provisionMembers).toHaveBeenLastCalledWith(expect.objectContaining({
      template: expect.objectContaining({ name: 'durable', version: 7 }),
    }));
  });

  it('task recover refreshes output and uses the durable room snapshot after config drift', async () => {
    writeCustomTemplate(true);
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'durable');
    writeCustomTemplate(false);
    out = [];
    mocks.markdownRender.mockClear();
    await run('recover', t.task_id, '--json');
    const payload = JSON.parse(out.join('\n'));
    expect(payload.task.state).toBe('active');
    expect(payload.room.state).toBe('active');
    expect(mocks.provisionMembers).toHaveBeenLastCalledWith(expect.objectContaining({
      template: expect.objectContaining({ name: 'durable', version: 7 }),
    }));
    expectExactJson({
      schema_version: 1, task: getTask(t.task_id), room: getRoomRecord(ROOM_ID),
      recovery_actions: ['Provisioning resumed successfully'],
    });
  });

  it('room recover uses the task-bound durable snapshot after config removal', async () => {
    writeCustomTemplate(true);
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'durable');
    writeCustomTemplate(false);
    out = [];
    mocks.markdownRender.mockClear();
    await runRoom('recover', ROOM_ID, '--json');
    expect(mocks.provisionMembers).toHaveBeenLastCalledWith(expect.objectContaining({
      template: expect.objectContaining({ name: 'durable', version: 7 }),
    }));
    expect(mocks.markdownRender).not.toHaveBeenCalled();
  });

  it('refuses to resume a waiting room under a different --template', async () => {
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('provisioning');

    await expect(run('work', t.task_id, '--template', 'team')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('does not match the room’s provisioned template');
    expect(getTask(t.task_id).template?.name).toBe('single');

    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');
  });

  it('rejects a conflicting --template against an already-active room', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');

    await expect(run('work', t.task_id, '--template', 'team')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('does not match the room’s provisioned template');
    expect(getTask(t.task_id).template?.name).toBe('single');

    out = [];
    await run('work', t.task_id, '--template', 'single');
    expect(out.join('\n')).toContain('## 📋 Task already active');
    await run('work', t.task_id);
    expect(out.join('\n')).toContain('## 📋 Task already active');
  });

  it('reports a non-resumable room instead of silently stranding the task', async () => {
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_seats', 5, 'waiting_seats');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id);
    advanceSaga(ROOM_ID, 'create_room', 1);
    await expect(run('work', t.task_id)).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('task recover');
  });
});

// ── task finish ──────────────────────────────────────────────────────────

describe('task finish', () => {
  async function activeTask() {
    const t = backlogTask();
    await run('work', t.task_id);
    return getTask(t.task_id);
  }

  it('takes an active task through review to done and deletes its room', async () => {
    const t = await activeTask();
    await run('finish', t.task_id);
    expect(getTask(t.task_id).state).toBe('done');
    expect(mocks.deleteManagedRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_ID }));
  });

  it('finishes a task already in review', async () => {
    const t = await activeTask();
    reviewTask(t.task_id);
    await run('finish', t.task_id);
    expect(getTask(t.task_id).state).toBe('done');
  });

  it('persists the --summary as the task outcome', async () => {
    const t = await activeTask();
    await run('finish', t.task_id, '--summary', 'shipped the fix');
    expect(getTask(t.task_id).outcome?.summary).toBe('shipped the fix');
  });

  it('reads --summary-file for the outcome', async () => {
    const t = await activeTask();
    const file = join(dir, 'summary.txt');
    writeFileSync(file, 'summary from file');
    await run('finish', t.task_id, '--summary-file', file);
    expect(getTask(t.task_id).outcome?.summary).toBe('summary from file');
  });

  it('refuses a task already in a terminal state', async () => {
    const t = await activeTask();
    await run('finish', t.task_id);
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('## ⚠️ Action not allowed');
    expect(out.join('\n')).toContain('already in a terminal state');
  });

  it('refuses a backlog task: nothing to finish', async () => {
    const t = backlogTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    expect(getTask(t.task_id).state).toBe('backlog');
  });

  it('does not report successful finish when deterministic room close fails', async () => {
    mocks.deleteManagedRoom.mockRejectedValue(new Error('room delete failed'));
    const t = await activeTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    expect(getTask(t.task_id)).toMatchObject({
      state: 'review', terminal_intent: { status: 'pending', error: 'room delete failed' },
    });
    expect(out.join('\n')).toContain('## ⚠️ Command failed');
    expect(out.join('\n')).not.toContain('room delete failed');
  });

  it('the hidden worker durably records failures after terminal acceptance', async () => {
    mocks.deleteManagedRoom.mockRejectedValue(new Error('hidden worker failed'));
    const t = await activeTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    out = [];
    await expect(run('_settle', t.task_id)).rejects.toThrow(ExitError);
    expect(getTask(t.task_id)).toMatchObject({
      state: 'review',
      terminal_intent: {
        status: 'pending',
        first_failure: 'hidden worker failed',
        first_recovery_hint: `Retry 'ours-fleet task recover ${t.task_id}'.`,
        error: 'hidden worker failed',
        recovery_hint: `External settle worker failed. Retry task recover ${t.task_id}.`,
      },
    });
  });

  it('the hidden worker delegates settlement exactly once to the application service', async () => {
    const t = await activeTask();
    const settleTask = vi.spyOn(TaskRoomApplicationService.prototype, 'settleTask')
      .mockResolvedValue({ ...t, state: 'done' });
    await run('_settle', t.task_id);
    expect(settleTask).toHaveBeenCalledOnce();
    expect(settleTask).toHaveBeenCalledWith({
      actor: { kind: 'internal_worker', surface: 'cli' }, taskId: t.task_id,
    });
  });

  it('the recovery worker orders begin, settlement, then continuation', async () => {
    const t = backlogTask();
    const begin = vi.spyOn(TaskRoomApplicationService.prototype, 'beginTaskRecovery')
      .mockResolvedValue({ kind: 'terminal_worker_required', taskId: t.task_id });
    const settle = vi.spyOn(TaskRoomApplicationService.prototype, 'settleTask').mockResolvedValue(t);
    const continuation = vi.spyOn(TaskRoomApplicationService.prototype, 'continueTaskRecovery')
      .mockResolvedValue({ kind: 'no_op', task: t, room: undefined, issues: [] });
    await run('_recover', t.task_id);
    expect(begin).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(continuation).toHaveBeenCalledWith({
      actor: { kind: 'internal_worker', surface: 'cli' }, taskId: t.task_id, terminalTimedOut: false,
    });
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(settle.mock.invocationCallOrder[0]);
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(continuation.mock.invocationCallOrder[0]);
  });

  it('the recovery worker records settlement failure and never continues', async () => {
    mocks.deleteManagedRoom.mockRejectedValue(new Error('recovery settle failed'));
    const t = await activeTask();
    reviewTask(t.task_id);
    await acceptTaskTerminalIntent({ taskId: t.task_id, kind: 'done', roomId: t.room_id });
    const continuation = vi.spyOn(TaskRoomApplicationService.prototype, 'continueTaskRecovery');
    await expect(run('_recover', t.task_id)).rejects.toThrow(ExitError);
    expect(continuation).not.toHaveBeenCalled();
    expect(getTask(t.task_id)).toMatchObject({ terminal_intent: {
      status: 'pending', error: 'recovery settle failed',
      recovery_hint: `External settle worker failed. Retry task recover ${t.task_id}.`,
    } });
  });

  it('records a CLI settlement-worker launch failure through durable terminal state', async () => {
    mocks.launchFleetWorker.mockRejectedValueOnce(new Error('worker spawn failed'));
    const t = createTask({
      title: 'Cancel launch failure', origin: { type: 'cli' }, start: false, room_id: ROOM_ID,
    });
    await expect(run('cancel', t.task_id, t.task_id)).rejects.toThrow(ExitError);
    expect(getTask(t.task_id)).toMatchObject({
      terminal_intent: {
        status: 'pending', error: 'worker spawn failed',
        recovery_hint: `External settle worker failed to start. Retry task recover ${t.task_id}.`,
      },
    });
  });

  it('task recover resumes a pending terminal intent to convergence', async () => {
    mocks.deleteManagedRoom.mockRejectedValueOnce(new Error('room delete failed'));
    const t = await activeTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    mocks.deleteManagedRoom.mockImplementation(async ({ roomId }: { roomId: string }) => {
      const { deleteRoomRecord } = await import('../src/rooms-tasks/room-state.js');
      deleteRoomRecord(roomId);
      return { room_id: roomId, deleted: true };
    });
    out = [];
    await run('recover', t.task_id);
    expect(getTask(t.task_id)).toMatchObject({
      state: 'done', terminal_intent: {
        status: 'settled', first_failure: 'room delete failed',
        first_recovery_hint: `Retry 'ours-fleet task recover ${t.task_id}'.`,
      },
    });
    expect(out.join('\n')).toContain(`**Task:** \`${t.task_id}\``);
    expect(out.join('\n')).toContain('✅ Done');
  });

  it('emits the finished task as --json', async () => {
    const t = await activeTask();
    out = [];
    mocks.markdownRender.mockClear();
    await run('finish', t.task_id, '--json');
    const payload = JSON.parse(out.join('\n'));
    expect(payload.task.state).toBe('done');
    expectExactJson({ schema_version: 1, task: getTask(t.task_id) });
  });
});

// ── task delete ──────────────────────────────────────────────────────────

describe('task delete', () => {
  function doneTask() {
    const t = createTask({ title: 'Completed work', origin: { type: 'cli' } });
    updateTaskRoom(t.task_id, ROOM_ID, 'c'.repeat(64));
    createRoomRecord({ room_id: ROOM_ID, room_name: 'Archived room', task_id: t.task_id });
    activateTask(t.task_id);
    reviewTask(t.task_id);
    return completeTask(t.task_id);
  }

  it('requires the exact task ID twice before looking up the task', async () => {
    await expect(run('delete', 'missing-task', 'different-id')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('The two task IDs must match.');
  });

  it('deletes a done task without closing a room', async () => {
    const t = doneTask();
    await run('delete', t.task_id, t.task_id);
    expect(() => getTask(t.task_id)).toThrow(/not found/);
    expect(out.join('\n')).toContain('## 🗑️ Task deleted');
    expect(out.join('\n')).toContain(t.task_id);
    expect(mocks.closeManagedRoom).not.toHaveBeenCalled();
    expect(mocks.closeRoom).not.toHaveBeenCalled();
    expect(getRoomRecord(ROOM_ID)).toMatchObject({ task_id: t.task_id });
  });

  it('reports repeat deletion as an idempotent already-absent result', async () => {
    const t = doneTask();
    await run('delete', t.task_id, t.task_id);
    out = [];
    mocks.markdownRender.mockClear();
    await run('delete', t.task_id, t.task_id, '--json');
    expectExactJson({ schema_version: 1, task_id: t.task_id, deleted: false });
  });
});

describe('internal room deletion workers', () => {
  it.each(['_delete', '_close'])('%s delegates settlement exactly once', async alias => {
    const settle = vi.spyOn(TaskRoomApplicationService.prototype, 'settleRoomDeletion')
      .mockResolvedValueOnce({ room_id: ROOM_ID, deleted: true });
    await runRoom(alias, ROOM_ID, '--json');
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      actor: { kind: 'internal_worker', surface: 'cli' }, roomId: ROOM_ID,
    });
    settle.mockRestore();
  });

  it('records the durable recovery hint when settlement fails', async () => {
    const settle = vi.spyOn(TaskRoomApplicationService.prototype, 'settleRoomDeletion')
      .mockRejectedValueOnce(new Error('remote delete unavailable'));
    const record = vi.spyOn(TaskRoomApplicationService.prototype, 'recordRoomSettlementError')
      .mockResolvedValueOnce(undefined as never);
    await expect(runRoom('_delete', ROOM_ID)).rejects.toThrow(ExitError);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      actor: { kind: 'internal_worker', surface: 'cli' }, roomId: ROOM_ID,
      error: 'remote delete unavailable',
      recoveryHint: `External delete worker failed. Retry room delete ${ROOM_ID} ${ROOM_ID}.`,
    }));
    settle.mockRestore();
    record.mockRestore();
  });
});
