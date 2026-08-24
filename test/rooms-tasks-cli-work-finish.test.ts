import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// ── Mock setup (vi.hoisted runs before vi.mock factories) ────────────────

const mocks = vi.hoisted(() => ({
  createRoom: vi.fn(),
  closeRoom: vi.fn().mockResolvedValue(undefined),
  provisionMembers: vi.fn(),
  closeManagedRoom: vi.fn().mockResolvedValue({ state: 'closed' }),
  launchFleetWorker: vi.fn(),
  recoverRoom: vi.fn(),
  getRoom: vi.fn(),
}));

vi.mock('../src/rooms-tasks/cowork-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rooms-tasks/cowork-adapter.js')>();
  return {
    ...actual,
    createCoworkAdapter: () => ({
      createRoom: mocks.createRoom,
      closeRoom: mocks.closeRoom,
      recoverRoom: mocks.recoverRoom,
      getRoom: mocks.getRoom,
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
  return { ...actual, closeManagedRoom: mocks.closeManagedRoom };
});

vi.mock('../src/rooms-tasks/external-worker.js', () => ({
  launchFleetWorker: mocks.launchFleetWorker,
}));

// ── Imports (resolved after mock interception) ──────────────────────────

import { registerRoomCommands, registerTaskCommands } from '../src/rooms-tasks/cli.js';
import { createTask, getTask, activateTask, reviewTask, cancelTask } from '../src/rooms-tasks/task-state.js';
import {
  activateRoom, getRoomRecord, advanceSaga, updateMemberSeats, updateRoomRoleBriefing,
} from '../src/rooms-tasks/room-state.js';
import { CoworkUnavailableError } from '../src/rooms-tasks/cowork-adapter.js';

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

function writeCustomTemplate(include = true): void {
  writeFileSync(cfgPath,
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
      '      - { slot: dev, role: Developer, count: 1, role_ref: Dev }',
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
  writeFileSync(cfgPath,
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
  mocks.closeRoom.mockReset().mockResolvedValue(undefined);
  mocks.closeManagedRoom.mockReset().mockResolvedValue({ state: 'closed' });
  mocks.launchFleetWorker.mockReset().mockImplementation(async (args: string[]) => {
    if (args[0] !== 'task' || args[1] !== '_settle') return;
    const taskId = args[2];
    setTimeout(() => {
      void import('../src/rooms-tasks/terminal.js').then(({ settleTaskTerminalIntent }) =>
        settleTaskTerminalIntent({
          taskId,
          cowork: { closeRoom: mocks.closeRoom },
        }).catch(() => undefined));
    }, 0);
  });
  // The real provisionMembers ends by activating the room and the task; the
  // fake preserves exactly that contract so the CLI's state flow is exercised.
  mocks.provisionMembers.mockReset().mockImplementation(async ({ roomId, taskId }: { roomId: string; taskId?: string }) => {
    const record = activateRoom(roomId);
    if (taskId) activateTask(taskId);
    return record;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
  else delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

// ── task work ────────────────────────────────────────────────────────────

describe('task work', () => {
  it('takes a backlog task to active with a provisioned room', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    const after = getTask(t.task_id);
    expect(after.state).toBe('active');
    expect(after.room_id).toBe(ROOM_ID);
    expect(getRoomRecord(ROOM_ID)!.task_id).toBe(t.task_id);
    expect(out.join('\n')).toContain(`Room: ${ROOM_ID}`);
  });

  it('defaults to the single template when none is configured or stored', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    expect(out.join('\n')).toContain('Template: single@1');
    expect(mocks.provisionMembers).toHaveBeenCalledWith(
      expect.objectContaining({ template: expect.objectContaining({ name: 'single' }) }));
  });

  it('honours an explicit --template over the default', async () => {
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'team');
    expect(out.join('\n')).toContain('Template: team@1');
    expect(mocks.provisionMembers).toHaveBeenCalledWith(
      expect.objectContaining({ template: expect.objectContaining({ name: 'team' }) }));
  });

  it('is idempotent on an already-active task: reports and provisions nothing', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    mocks.createRoom.mockClear();
    await run('work', t.task_id);
    expect(out.join('\n')).toContain('already has an active room');
    expect(mocks.createRoom).not.toHaveBeenCalled();
    expect(getTask(t.task_id).room_id).toBe(ROOM_ID);
  });

  it('reports already_active in --json without re-provisioning', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    out = [];
    await run('work', t.task_id, '--json');
    const payload = JSON.parse(out.join('\n'));
    expect(payload.status).toBe('already_active');
    expect(payload.task.task_id).toBe(t.task_id);
  });

  it('task and room show expose per-seat launch, relay, ACK, and rejection evidence', async () => {
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
    await runLocalTask('show', t.task_id, '--json');
    const taskPayload = JSON.parse(out.join('\n'));
    expect(taskPayload.orchestration.member_seats[0].briefing.state).toBe('relay_queued');

    out = [];
    await runRoom('show', ROOM_ID);
    const text = out.join('\n');
    expect(text).toContain('launch=launched briefing=relay_queued');
    expect(text).toContain('briefing_message=briefing-2 relay=relay-2 ack=pending');
    expect(text).toContain('reason=owner_seat_cid mismatch');
    expect(text).toContain(`Developer v2 configured sha256:${'f'.repeat(64)}`);
  });

  it('refuses a terminal-state task', async () => {
    const t = backlogTask();
    cancelTask(t.task_id);
    await expect(run('work', t.task_id)).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain("terminal state 'cancelled'");
    expect(mocks.createRoom).not.toHaveBeenCalled();
  });

  it('errors on an unknown template', async () => {
    const t = backlogTask();
    await expect(run('work', t.task_id, '--template', 'nope')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('template not found: nope');
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
    expect(out.join('\n')).toContain('no longer matches team@1');
    expect(getTask(t.task_id).state).toBe('backlog');
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
      advanceSaga(roomId, 'wait_briefing_acks', 8, 'waiting_briefing_acks');
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
      advanceSaga(roomId, 'wait_briefing_acks', 8, 'waiting_briefing_acks');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'durable');
    writeCustomTemplate(false);
    out = [];
    await run('recover', t.task_id, '--json');
    const payload = JSON.parse(out.join('\n'));
    expect(payload.task.state).toBe('active');
    expect(payload.room.state).toBe('active');
    expect(mocks.provisionMembers).toHaveBeenLastCalledWith(expect.objectContaining({
      template: expect.objectContaining({ name: 'durable', version: 7 }),
    }));
  });

  it('room recover uses the task-bound durable snapshot after config removal', async () => {
    writeCustomTemplate(true);
    mocks.provisionMembers.mockImplementationOnce(async ({ roomId }: { roomId: string }) => {
      advanceSaga(roomId, 'wait_briefing_acks', 8, 'waiting_briefing_acks');
      return getRoomRecord(roomId)!;
    });
    const t = backlogTask();
    await run('work', t.task_id, '--template', 'durable');
    writeCustomTemplate(false);
    await runRoom('recover', ROOM_ID, '--json');
    expect(mocks.provisionMembers).toHaveBeenLastCalledWith(expect.objectContaining({
      template: expect.objectContaining({ name: 'durable', version: 7 }),
    }));
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
    expect(out.join('\n')).toContain("does not match room");
    expect(getTask(t.task_id).template?.name).toBe('single');

    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');
  });

  it('rejects a conflicting --template against an already-active room', async () => {
    const t = backlogTask();
    await run('work', t.task_id);
    expect(getTask(t.task_id).state).toBe('active');

    await expect(run('work', t.task_id, '--template', 'team')).rejects.toThrow(ExitError);
    expect(out.join('\n')).toContain('does not match room');
    expect(getTask(t.task_id).template?.name).toBe('single');

    out = [];
    await run('work', t.task_id, '--template', 'single');
    expect(out.join('\n')).toContain('already has an active room');
    await run('work', t.task_id);
    expect(out.join('\n')).toContain('already has an active room');
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

  it('takes an active task through review to done and closes its room', async () => {
    const t = await activeTask();
    await run('finish', t.task_id);
    expect(getTask(t.task_id).state).toBe('done');
    expect(mocks.closeManagedRoom).toHaveBeenCalledWith(
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
    expect(out.join('\n')).toContain("terminal state 'done'");
  });

  it('refuses a backlog task: nothing to finish', async () => {
    const t = backlogTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    expect(getTask(t.task_id).state).toBe('backlog');
  });

  it('does not report successful finish when deterministic room close fails', async () => {
    mocks.closeManagedRoom.mockRejectedValue(new Error('room close failed'));
    const t = await activeTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    expect(getTask(t.task_id)).toMatchObject({
      state: 'review', terminal_intent: { status: 'pending', error: 'room close failed' },
    });
    expect(out.join('\n')).toContain('room close failed');
  });

  it('the hidden worker durably records failures after terminal acceptance', async () => {
    mocks.closeManagedRoom.mockRejectedValue(new Error('hidden worker failed'));
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

  it('task recover resumes a pending terminal intent to convergence', async () => {
    mocks.closeManagedRoom.mockRejectedValueOnce(new Error('room close failed'));
    const t = await activeTask();
    await expect(run('finish', t.task_id)).rejects.toThrow(ExitError);
    mocks.closeManagedRoom.mockResolvedValue({ state: 'closed' });
    out = [];
    await run('recover', t.task_id);
    expect(getTask(t.task_id)).toMatchObject({
      state: 'done', terminal_intent: {
        status: 'settled', first_failure: 'room close failed',
        first_recovery_hint: `Retry 'ours-fleet task recover ${t.task_id}'.`,
      },
    });
    expect(out.join('\n')).toContain(`Task ${t.task_id} · done`);
  });

  it('emits the finished task as --json', async () => {
    const t = await activeTask();
    out = [];
    await run('finish', t.task_id, '--json');
    const payload = JSON.parse(out.join('\n'));
    expect(payload.task.state).toBe('done');
  });
});
