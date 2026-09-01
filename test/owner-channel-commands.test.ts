import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dispatchOwnerCommand, isOwnerCommandText, ownerCommandHelp, ownerCommands,
  type OwnerCommandContext,
} from '../src/owner-channel/commands.js';
import {
  OWNER_COMMENT_LABEL, ownerNotices, type OwnerCommentsState,
} from '../src/owner-channel/notices.js';
import type { SessionEvent, SessionSnapshot } from '../src/session/types.js';
import {
  blockTask as persistBlockTask,
  getTask as readTask, listTasks as readTasks, reviewTask as persistReviewTask,
  unblockTask as persistUnblockTask,
} from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { hashTemplate, listTemplates, resolveTemplate } from '../src/rooms-tasks/templates.js';
import { renderMarkdownResult, roomStatus, taskStatus } from '../src/rooms-tasks/markdown.js';
import { TaskRoomApplicationError, TaskRoomApplicationService } from '../src/application/task-room-service.js';

const STANDARD_TEMPLATES = {
  single: { name: 'single', version: 1, description: 'Solo agent',
    members: [{ slot: 'agent', role: 'Agent', count: 1, agent_template: 'Agent' }] },
  pair: { name: 'pair', version: 1, description: 'Review pair', members: [
    { slot: 'secretary', role: 'Secretary', count: 1, agent_template: 'Secretary' },
    { slot: 'critic', role: 'Critic', count: 1, agent_template: 'Critic' },
  ] },
  team: { name: 'team', version: 1, description: 'Delivery team', members: [
    { slot: 'architect', role: 'Architect', count: 1, agent_template: 'Architect' },
    { slot: 'developer', role: 'Developer', count: 1, agent_template: 'Developer' },
    { slot: 'tester', role: 'Tester', count: 1, agent_template: 'Tester' },
  ] },
};

function context(overrides: Partial<OwnerCommandContext> = {}): OwnerCommandContext & {
  replies: string[];
} {
  const replies: string[] = [];
  const snapshot: SessionSnapshot = { backend: 'acp', alive: true, readiness: 'idle' };
  const comments: OwnerCommentsState = { enabled: true, baseline: true, supported: true };
  const closeRoom = vi.fn(async (roomId: string) => { replies.push(`scheduled:${roomId}`); });
  return {
    replies,
    comments: () => comments,
    setComments: vi.fn((enabled: boolean) => {
      comments.enabled = enabled;
      return { ...comments };
    }),
    role: 'Coordinator',
    harness: 'claude-code',
    version: '9.9.9-test',
    snapshot: () => snapshot,
    interrupt: vi.fn(async () => undefined),
    runHarnessCommand: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    fleetList: vi.fn(async () => 'Coordinator: acp'),
    closeRoom,
    recoverRoom: vi.fn(async roomId => {
      const r = getRoomRecord(roomId);
      if (!r) { replies.push('⚠️ Room not found.'); return; }
      if (r.state === 'closing' || r.state === 'closed') { await closeRoom(roomId); return; }
      replies.push(renderMarkdownResult({ icon: '🛟', title: 'Room recovery', fields: [
        { label: 'Room', value: r.room_id, kind: 'code' },
        { label: 'Status', value: roomStatus(r.state), kind: 'markdown' },
        { label: 'Saga', value: r.saga.phase, kind: 'code' },
        ...(r.saga.error ? [{ label: 'Last error', value: 'Provisioning failure recorded; inspect role logs.' }] : []),
        ...(r.provisioning_detail ? [{ label: 'Detail', value: r.provisioning_detail }] : []),
      ], sections: [{ heading: 'Next step', items: [r.saga.error
        ? 'Run ours-fleet room recover from the CLI for full recovery.'
        : 'No recovery action is needed.'] }] }));
    }),
    terminalTask: vi.fn(async (taskId, kind) => { replies.push(`terminal:${taskId}:${kind}`); }),
    recoverTask: vi.fn(async taskId => {
      const task = readTask(taskId);
      const room = task.room_id ? getRoomRecord(task.room_id) : undefined;
      replies.push(renderMarkdownResult({ icon: '🛟', title: 'Task recovery', fields: [
        { label: 'Task', value: task.task_id, kind: 'code' },
        { label: 'Status', value: taskStatus(task.state), kind: 'markdown' },
        ...(room ? [{ label: 'Room', value: room.room_id, kind: 'code' as const },
          { label: 'Room status', value: roomStatus(room.state), kind: 'markdown' as const },
          { label: 'Saga', value: room.saga.phase, kind: 'code' as const }] : []),
      ], sections: [{ heading: 'Result', items: ['No automated recovery action is available.'] }] }));
    }),
    createTask: vi.fn(async input => {
      const { createTask } = await import('../src/rooms-tasks/task-state.js');
      return createTask({
        title: input.title, brief: input.brief, origin: input.origin,
        start: !input.backlog, no_room: input.noRoom,
        ...(input.template ? { template: { name: input.template, version: 1, content_hash: '' } } : {}),
      });
    }),
    startTask: vi.fn(async taskId => {
      const { startTask } = await import('../src/rooms-tasks/task-state.js');
      return startTask(taskId);
    }),
    listTasks: vi.fn(filter => {
      return readTasks(filter);
    }),
    groupedTasks: vi.fn(filter => new TaskRoomApplicationService().groupedTasks(filter)),
    listTaskLists: vi.fn(() => new TaskRoomApplicationService().listTaskLists()),
    createTaskList: vi.fn(name => new TaskRoomApplicationService().createTaskList({
      actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, name })),
    renameTaskList: vi.fn((name, newName) => new TaskRoomApplicationService().renameTaskList({
      actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, name, newName })),
    deleteTaskList: vi.fn((name, destination) => new TaskRoomApplicationService().deleteTaskList({
      actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, name, destination })),
    moveTask: vi.fn((taskId, list) => new TaskRoomApplicationService().moveTask({
      actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, taskId, list })),
    getTask: vi.fn(taskId => {
      const task = readTask(taskId);
      return { task, orchestration: task.room_id ? getRoomRecord(task.room_id) : undefined };
    }),
    blockTask: vi.fn((taskId, reason) => {
      return persistBlockTask(taskId, reason);
    }),
    unblockTask: vi.fn(taskId => {
      return persistUnblockTask(taskId);
    }),
    reviewTask: vi.fn(taskId => {
      return persistReviewTask(taskId);
    }),
    deleteTask: vi.fn(async (taskId: string) => {
      const app = new TaskRoomApplicationService();
      const accepted = await app.requestTaskDeletion({
        actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'f'.repeat(64) }, taskId,
      });
      if (accepted.status === 'already_absent') {
        replies.push(renderMarkdownResult({ icon: '🗑️', title: 'Task already absent',
          fields: [{ label: 'ID', value: taskId, kind: 'code' }] }));
        return;
      }
      const settled = await app.settleTaskDeletion({
        actor: { kind: 'internal_worker', surface: 'cli' }, taskId,
      });
      replies.push(renderMarkdownResult({
        icon: '🗑️', title: settled.deleted ? 'Task deleted' : 'Task deletion pending',
        fields: [{ label: 'ID', value: taskId, kind: 'code' }] }));
    }),
    listRoomQueries: vi.fn(async filter => (await import('../src/rooms-tasks/room-state.js'))
      .listRoomRecords().filter(room => room.state === 'active' || room.state === 'provisioning')
      .filter(room => !filter?.state || room.state === filter.state)
      .map(room => ({ ...room, identity_name: room.room_name, identity_cid: room.room_identity_cid ?? '',
        seats: [], role_briefings: {}, orchestration: room } as any))),
    getRoomQuery: vi.fn(async id => {
      const orchestration = getRoomRecord(id);
      if (!orchestration || orchestration.state === 'closing' || orchestration.state === 'closed')
        throw new TaskRoomApplicationError('room_not_found', 'room not found', { room: id });
      return { room: { ...orchestration, identity_name: orchestration.room_name,
        identity_cid: orchestration.room_identity_cid ?? '', seats: [], role_briefings: {} } as any,
      orchestration };
    }),
    listTemplateQueries: vi.fn(() => listTemplates(STANDARD_TEMPLATES)),
    getTemplateQuery: vi.fn(name => {
      const template = resolveTemplate(name, STANDARD_TEMPLATES);
      if (!template) throw new TaskRoomApplicationError(
        'template_not_found', 'template not found', { template: name });
      return { ...template, content_hash: hashTemplate(template) };
    }),
    createRoom: vi.fn(async input => {
      const { randomUUID } = await import('node:crypto');
      const { createRoomRecord } = await import('../src/rooms-tasks/room-state.js');
      const template = input.template ? resolveTemplate(input.template, STANDARD_TEMPLATES) : undefined;
      if (input.template && !template) throw new TaskRoomApplicationError(
        'template_not_found', 'template not found', { template: input.template });
      return createRoomRecord({ room_id: randomUUID().replace(/-/g, '').slice(0, 16),
        room_name: input.name, goal: input.goal,
        ...(template ? { template_snapshot: (await import('../src/rooms-tasks/templates.js')).snapshotTemplate(template) } : {}) });
    }),
    recentEvents: () => [],
    readWorklogTail: vi.fn(async () => undefined),
    reply: async text => { replies.push(text); },
    ...overrides,
  };
}

describe('owner command registry', () => {
  it('recognizes only trimmed slash-prefixed text as a command attempt', () => {
    expect(isOwnerCommandText('/help')).toBe(true);
    expect(isOwnerCommandText('  /help  ')).toBe(true);
    expect(isOwnerCommandText('help')).toBe(false);
    expect(isOwnerCommandText('please run /compact')).toBe(false);
    expect(isOwnerCommandText('')).toBe(false);
  });

  it('renders every registered command with usage and description in help', () => {
    const help = ownerCommandHelp();
    for (const command of ownerCommands) {
      expect(help).toContain(command.usage ?? `/${command.name}`);
      expect(help).toContain(command.summary);
    }
    // The registry is the single source of truth for the deterministic set.
    for (const name of ['help', 'status', 'comments', 'interrupt', 'clear', 'compact', 'model',
      'restart', 'force-restart', 'ls', 'peek', 'worklog', 'version'])
      expect(ownerCommands.some(command => command.name === name)).toBe(true);
    expect(help).toContain('/commands');
  });

  it('makes /comments discoverable in help with its label and baseline semantics', () => {
    const help = ownerCommandHelp();
    expect(help).toContain('/comments [status|on|off]');
    expect(help).toContain(OWNER_COMMENT_LABEL);
    expect(help).toContain('fleet.yaml is the restart baseline');
  });

  it('prepends a caller error to help output when given', () => {
    const help = ownerCommandHelp('unknown command /deploy');
    expect(help).toContain('unknown command /deploy');
    expect(help).toContain('/help');
  });

  it('replies with help for /help and its /commands alias, case-insensitively', async () => {
    for (const text of ['/help', '/commands', '/HELP']) {
      const ctx = context();
      await dispatchOwnerCommand(text, ctx);
      expect(ctx.replies).toEqual([ownerCommandHelp()]);
    }
  });

  it('replies with help for an unknown command instead of forwarding', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/deploy prod now', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('/deploy');
    expect(ctx.replies[0]).toContain('/help');
    expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
    expect(ctx.restart).not.toHaveBeenCalled();
  });

  it('reports status from the session snapshot', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/status', ctx);
    expect(ctx.replies).toEqual([ownerNotices.status('Coordinator',
      { backend: 'acp', alive: true, readiness: 'idle' })]);
  });

  it('reports live-comment state for a bare /comments and for /comments status', async () => {
    for (const text of ['/comments', '/comments status', '/comments STATUS']) {
      const ctx = context();
      await dispatchOwnerCommand(text, ctx);
      expect(ctx.setComments).not.toHaveBeenCalled();
      expect(ctx.replies).toEqual([ownerNotices.comments(
        { enabled: true, baseline: true, supported: true })]);
    }
  });

  it('turns live comments off and back on without rewriting the baseline', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/comments off', ctx);
    expect(ctx.setComments).toHaveBeenCalledWith(false);
    expect(ctx.replies[0]).toContain('OFF');
    // The reply must state the unchanged fleet.yaml baseline and the restart rule.
    expect(ctx.replies[0]).toContain('fleet.yaml baseline: on, changed by /comments');
    expect(ctx.replies[0]).toContain('A restart returns to the baseline.');

    await dispatchOwnerCommand('/comments ON', ctx);
    expect(ctx.setComments).toHaveBeenLastCalledWith(true);
    expect(ctx.replies[1]).toContain('ON');
    expect(ctx.replies[1]).not.toContain('changed by /comments');

    // Status afterwards reflects the live value, not the baseline.
    await dispatchOwnerCommand('/comments off', ctx);
    await dispatchOwnerCommand('/comments status', ctx);
    expect(ctx.replies[3]).toContain('OFF');
  });

  it('reports a baseline-off channel truthfully', async () => {
    const ctx = context({ comments: () => ({ enabled: false, baseline: false, supported: true }) });
    await dispatchOwnerCommand('/comments status', ctx);
    expect(ctx.replies[0]).toContain('Live updates are OFF');
    expect(ctx.replies[0]).toContain('fleet.yaml baseline: off');
    expect(ctx.replies[0]).not.toContain('changed by /comments');
  });

  it('says the setting is inert when the backend never emits live comments', async () => {
    const ctx = context({ comments: () => ({ enabled: true, baseline: true, supported: false }) });
    await dispatchOwnerCommand('/comments status', ctx);
    expect(ctx.replies[0]).toContain('no effect here');
    expect(ctx.replies[0]).not.toContain(OWNER_COMMENT_LABEL);
  });

  it('returns help for a malformed /comments argument instead of guessing', async () => {
    for (const bad of ['enable', 'true', 'on off', 'off please', '1', '--on']) {
      const ctx = context();
      await dispatchOwnerCommand(`/comments ${bad}`, ctx);
      expect(ctx.setComments).not.toHaveBeenCalled();
      expect(ctx.replies).toHaveLength(1);
      expect(ctx.replies[0]).toContain('Invalid command');
      expect(ctx.replies[0]).toContain('/help');
    }
  });

  it('interrupts the active turn and confirms', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/interrupt', ctx);
    expect(ctx.interrupt).toHaveBeenCalledOnce();
    expect(ctx.replies).toEqual([ownerNotices.interrupted('Coordinator')]);
  });

  it('reports an interrupt failure without throwing', async () => {
    const ctx = context({ interrupt: vi.fn(async () => { throw new Error('boom'); }) });
    await dispatchOwnerCommand('/interrupt', ctx);
    expect(ctx.replies).toEqual([ownerNotices.interruptFailed('Coordinator')]);
  });

  it('passes /clear and /compact to the harness as raw slash text', async () => {
    for (const name of ['clear', 'compact']) {
      const ctx = context();
      await dispatchOwnerCommand(`/${name}`, ctx);
      expect(ctx.runHarnessCommand).toHaveBeenCalledOnce();
    expect(ctx.runHarnessCommand).toHaveBeenCalledWith(`/${name}`);
    }
  });

  it('passes /model with a valid id to the harness', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/model claude-sonnet-5', ctx);
    expect(ctx.runHarnessCommand).toHaveBeenCalledOnce();
    expect(ctx.runHarnessCommand).toHaveBeenCalledWith('/model claude-sonnet-5');
  });

  // codex-acp 1.1.7 executes only /compact locally; /clear and /model are not
  // builtins and would fall through tryHandleCommand into sendPrompt, i.e.
  // reach the model as an ordinary prompt. The registry must therefore refuse
  // to forward them on the codex harness instead of pretending they work.
  it('forwards only /compact on the codex harness', async () => {
    const ctx = context({ harness: 'codex' });
    await dispatchOwnerCommand('/compact', ctx);
    expect(ctx.runHarnessCommand).toHaveBeenCalledOnce();
    expect(ctx.runHarnessCommand).toHaveBeenCalledWith('/compact');
  });

  it('refuses /clear and /model on the codex harness with a truthful notice', async () => {
    for (const text of ['/clear', '/model claude-sonnet-5']) {
      const ctx = context({ harness: 'codex' });
      await dispatchOwnerCommand(text, ctx);
      expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
      expect(ctx.replies).toEqual(
        [ownerNotices.commandUnsupported(text.split(' ', 1)[0], 'codex')]);
    }
  });

  it('refuses all harness-forwarded commands on an unverified harness', async () => {
    for (const text of ['/clear', '/compact', '/model claude-sonnet-5']) {
      const ctx = context({ harness: 'mystery-harness' });
      await dispatchOwnerCommand(text, ctx);
      expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
      expect(ctx.replies).toHaveLength(1);
      expect(ctx.replies[0]).toContain('not supported');
    }
  });

  it('returns help for /model without an argument', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/model', ctx);
    expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Invalid command');
  });

  it('returns help for a malformed /model argument', async () => {
    for (const bad of ['claude sonnet', 'x'.repeat(200), 'a\nb', '$(rm -rf /)', '--flag']) {
      const ctx = context();
      await dispatchOwnerCommand(`/model ${bad}`, ctx);
      expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
      expect(ctx.replies).toHaveLength(1);
      expect(ctx.replies[0]).toContain('/help');
    }
  });

  it('returns help when a no-argument command is given arguments', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/clear everything', ctx);
    expect(ctx.runHarnessCommand).not.toHaveBeenCalled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('/help');
  });

  it('maps /restart and /force-restart to the fleet restart modes', async () => {
    const keep = context();
    await dispatchOwnerCommand('/restart', keep);
    expect(keep.restart).toHaveBeenCalledOnce();
    expect(keep.restart).toHaveBeenCalledWith('keep');
    const fresh = context();
    await dispatchOwnerCommand('/force-restart', fresh);
    expect(fresh.restart).toHaveBeenCalledOnce();
    expect(fresh.restart).toHaveBeenCalledWith('fresh');
  });

  it('relays the fleet listing for /ls', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/ls', ctx);
    expect(ctx.fleetList).toHaveBeenCalledOnce();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Coordinator: acp');
  });

  it('preserves the multi-line fleet listing for /ls exactly', async () => {
    const listing = 'Coordinator: acp (running)\nDeveloper-1: acp (running)\nWatchdog: acp (idle)';
    const ctx = context({ fleetList: vi.fn(async () => listing) });
    await dispatchOwnerCommand('/ls', ctx);
    expect(ctx.replies).toEqual([`📊 Fleet sessions:\n${listing}`]);
  });

  it('sanitizes non-newline control characters in /ls output', async () => {
    const listing = ['a', String.fromCharCode(7), 'b\r\nc', String.fromCharCode(0), 'd'].join('');
    const ctx = context({ fleetList: vi.fn(async () => listing) });
    await dispatchOwnerCommand('/ls', ctx);
    expect(ctx.replies).toEqual(['📊 Fleet sessions:\na b \nc d']);
  });

  it('reports the fleet version for /version', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/version', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('9.9.9-test');
  });

  it('tails the worklog for /worklog and reports when it is missing', async () => {
    const present = context({ readWorklogTail: vi.fn(async () => 'did a thing\ndid another') });
    await dispatchOwnerCommand('/worklog', present);
    expect(present.replies).toHaveLength(1);
    expect(present.replies[0]).toContain('did another');
    const missing = context();
    await dispatchOwnerCommand('/worklog', missing);
    expect(missing.replies).toHaveLength(1);
    expect(missing.replies[0].toLowerCase()).toContain('no worklog');
  });

  it('summarizes recent activity shapes for /peek without leaking text bodies', async () => {
    const events: SessionEvent[] = Array.from({ length: 22 }, (_, index) => ({
      version: 1, seq: index + 1, at: 't', kind: 'state', status: `state-${index + 1}`,
    }));
    events[2] = { version: 1, seq: 3, at: 't', kind: 'thought', text: 'SECRET old reasoning' };
    events[3] = { version: 1, seq: 4, at: 't', kind: 'thought', text: 'SECRET retained reasoning' };
    events[20] = { version: 1, seq: 21, at: 't', kind: 'tool_call', title: 'Read README.md' };
    events[21] = { version: 1, seq: 22, at: 't', kind: 'turn_stop', stopReason: 'end_turn' };
    const ctx = context({ recentEvents: limit => events.slice(-limit) });
    await dispatchOwnerCommand('/peek', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('thought');
    expect(ctx.replies[0]).toContain('tool_call');
    expect(ctx.replies[0]).toContain('Read README.md');
    expect(ctx.replies[0]).toContain('turn_stop');
    expect(ctx.replies[0]).not.toContain('(state-2)');
    expect(ctx.replies[0]).not.toContain('SECRET');
  });

  it('reports an empty /peek when there is no recent activity', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/peek', ctx);
    expect(ctx.replies).toHaveLength(1);
  });

  it('replies with a failure notice when a command effect throws', async () => {
    const ctx = context({ fleetList: vi.fn(async () => { throw new Error('spawn failed'); }) });
    // The dispatcher rethrows after the notice so the channel can log the cause.
    await expect(dispatchOwnerCommand('/ls', ctx)).rejects.toThrow('spawn failed');
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('⚠️');
    expect(ctx.replies[0]).not.toContain('spawn failed');
  });
});

// ── Task/Room/Template subcommands ──────────────────────────────

describe('owner-channel task subcommands', () => {
  let dir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-oc-'));
    origHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = dir;
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
    else delete process.env.OURS_FLEET_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  async function createTestTask(start = false) {
    const { createTask } = await import('../src/rooms-tasks/task-state.js');
    return createTask({
      title: 'test task',
      template: { name: 'dev', version: 1, content_hash: 'abc' },
      origin: { type: 'cli' },
      start,
    });
  }

  it('snapshots the Markdown task lifecycle integration surface', async () => {
    const t = await createTestTask();
    const replies: string[] = [];
    for (const command of [
      `/task show ${t.task_id}`,
      `/task start ${t.task_id}`,
    ]) {
      const ctx = context();
      await dispatchOwnerCommand(command, ctx);
      replies.push(...ctx.replies);
    }
    const { activateTask } = await import('../src/rooms-tasks/task-state.js');
    activateTask(t.task_id);
    for (const command of [
      `/task block ${t.task_id} waiting on *dependency*`,
      `/task unblock ${t.task_id}`,
      `/task review ${t.task_id}`,
      '/task list all',
      `/task recover ${t.task_id}`,
    ]) {
      const ctx = context();
      await dispatchOwnerCommand(command, ctx);
      replies.push(...ctx.replies);
    }
    expect(replies.map(reply => reply
      .replaceAll(t.task_id, '<TASK_ID>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<ISO_DATE>')))
      .toMatchSnapshot();
  });

  it('/task <id> shows task details (backward compat)', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(t.task_id);
    expect(ctx.replies[0]).toContain('test task');
  });

  it('supports every list operation including names with spaces via multiline grammar', async () => {
    const task = await createTestTask();
    const commands = [
      '/task list-create\nPersonal Stuff',
      '/task list-rename\nPersonal Stuff\nTeam Work',
      `/task move ${task.task_id}\nTeam Work`,
      '/task list --group-by-list\nTeam Work',
      '/task list-delete\nTeam Work\ndefault',
    ];
    for (const command of commands) {
      const ctx = context(); await dispatchOwnerCommand(command, ctx);
      expect(ctx.replies[0]).not.toContain('Unexpected failure');
    }
    expect(readTask(task.task_id).list_name).toBe('default');
  });

  it('returns stable owner-channel errors for duplicate and unsafe non-empty deletion', async () => {
    const task = await createTestTask();
    for (const command of ['/task list-create\nOwner Work', `/task move ${task.task_id}\nOwner Work`])
      await dispatchOwnerCommand(command, context());
    const duplicate = context();
    await dispatchOwnerCommand('/task list-create\nOwner Work', duplicate);
    expect(duplicate.replies[0]).toContain('task list already exists: Owner Work');
    const unsafe = context();
    await dispatchOwnerCommand('/task list-delete\nOwner Work', unsafe);
    expect(unsafe.replies[0]).toContain("is not empty; destination is required");
    expect(readTask(task.task_id).list_name).toBe('Owner Work');
  });

  it('/task show <id> shows task details', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task show ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(t.task_id);
  });

  it('/task show delegates detail lookup to the shared service callback', async () => {
    const t = await createTestTask();
    const getTask = vi.fn(() => ({ task: t, orchestration: undefined }));
    const ctx = context({ getTask });
    await dispatchOwnerCommand(`/task show ${t.task_id}`, ctx);
    expect(getTask).toHaveBeenCalledWith(t.task_id);
  });

  it('/task start <id> transitions backlog → provisioning', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task start ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Provisioning');
  });

  it('/task start delegates to and awaits the shared full-provision callback', async () => {
    const t = await createTestTask();
    const full = { ...t, state: 'active' as const, room_id: 'room-1', room_identity_cid: 'cid-1' };
    const startTask = vi.fn(async () => full);
    const ctx = context({ startTask });
    await dispatchOwnerCommand(`/task start ${t.task_id}`, ctx);
    expect(startTask).toHaveBeenCalledWith(t.task_id);
    expect(ctx.replies[0]).toContain('Active');
  });

  it('/task block <id> <reason> blocks an active task', async () => {
    const t = await createTestTask();
    const { startTask, activateTask } = await import('../src/rooms-tasks/task-state.js');
    startTask(t.task_id);
    activateTask(t.task_id);
    const ctx = context();
    await dispatchOwnerCommand(`/task block ${t.task_id} waiting on deps`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('blocked');
    expect(ctx.replies[0]).toContain('waiting on deps');
  });

  it('delegates block, unblock, and review mutations to shared service callbacks', async () => {
    const t = await createTestTask();
    const blockTask = vi.fn(() => ({ ...t, state: 'blocked' as const, blocked_reason: 'deps' }));
    const unblockTask = vi.fn(() => ({ ...t, state: 'active' as const }));
    const reviewTask = vi.fn(() => ({ ...t, state: 'review' as const }));
    const ctx = context({ blockTask, unblockTask, reviewTask });
    await dispatchOwnerCommand(`/task block ${t.task_id} deps`, ctx);
    await dispatchOwnerCommand(`/task unblock ${t.task_id}`, ctx);
    await dispatchOwnerCommand(`/task review ${t.task_id}`, ctx);
    expect(blockTask).toHaveBeenCalledWith(t.task_id, 'deps');
    expect(unblockTask).toHaveBeenCalledWith(t.task_id);
    expect(reviewTask).toHaveBeenCalledWith(t.task_id);
  });

  it('/task unblock <id> unblocks a blocked task', async () => {
    const t = await createTestTask();
    const { startTask, activateTask, blockTask } = await import('../src/rooms-tasks/task-state.js');
    startTask(t.task_id);
    activateTask(t.task_id);
    blockTask(t.task_id, 'waiting');
    const ctx = context();
    await dispatchOwnerCommand(`/task unblock ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('unblocked');
  });

  it('/task review <id> moves to review', async () => {
    const t = await createTestTask();
    const { startTask, activateTask } = await import('../src/rooms-tasks/task-state.js');
    startTask(t.task_id);
    activateTask(t.task_id);
    const ctx = context();
    await dispatchOwnerCommand(`/task review ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('review');
  });

  it('/task done <id> completes a task', async () => {
    const t = await createTestTask();
    const { startTask, activateTask, reviewTask } = await import('../src/rooms-tasks/task-state.js');
    startTask(t.task_id);
    activateTask(t.task_id);
    reviewTask(t.task_id);
    const ctx = context();
    await dispatchOwnerCommand(`/task done ${t.task_id} ship it`, ctx);
    expect(ctx.terminalTask).toHaveBeenCalledWith(t.task_id, 'done', { summary: 'ship it' });
    expect(ctx.replies).toEqual([`terminal:${t.task_id}:done`]);
  });

  it('keeps arbitrary task effect errors generic and never exposes their text', async () => {
    const secret = 'cannot connect using /secret/path token=canary-token';
    const ctx = context({ terminalTask: vi.fn(async () => { throw new Error(secret); }) });
    await dispatchOwnerCommand('/task done task-safe-id', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Command failed');
    expect(ctx.replies[0]).not.toContain('cannot connect');
    expect(ctx.replies[0]).not.toContain('/secret/path');
    expect(ctx.replies[0]).not.toContain('canary-token');
  });

  it('/task cancel requires ID twice', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task cancel ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('destructive');
  });

  it('/task cancel <id> <id> cancels a task', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task cancel ${t.task_id} ${t.task_id}`, ctx);
    expect(ctx.terminalTask).toHaveBeenCalledWith(t.task_id, 'cancelled');
    expect(ctx.replies).toEqual([`terminal:${t.task_id}:cancelled`]);
  });

  it('/task delete requires the exact task ID twice', async () => {
    const t = await createTestTask();
    const deleteTask = vi.fn(() => true);
    const ctx = context({ deleteTask });
    await dispatchOwnerCommand(`/task delete ${t.task_id} different-id`, ctx);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('destructive');
  });

  it('/task delete rejects trailing confirmation tokens', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task delete ${t.task_id} ${t.task_id} extra`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('destructive');
  });

  it('/task delete removes a done task and reports a repeat as already absent', async () => {
    const t = await createTestTask(true);
    const { activateTask, reviewTask, completeTask, getTask } =
      await import('../src/rooms-tasks/task-state.js');
    activateTask(t.task_id);
    reviewTask(t.task_id);
    completeTask(t.task_id);

    const first = context();
    await dispatchOwnerCommand(`/task delete ${t.task_id} ${t.task_id}`, first);
    expect(first.replies[0]).toContain('## 🗑️ Task deleted');
    expect(first.replies[0]).toContain(t.task_id);
    expect(() => getTask(t.task_id)).toThrow(/not found/);

    const retry = context();
    await dispatchOwnerCommand(`/task delete ${t.task_id} ${t.task_id}`, retry);
    expect(retry.replies[0]).toContain('## 🗑️ Task already absent');
    expect(retry.replies[0]).toContain(t.task_id);
  });

  it('/task recover reschedules an accepted pending terminal intent', async () => {
    const t = await createTestTask();
    const {
      activateTask, reviewTask, startTask, updateTaskRoom,
    } = await import('../src/rooms-tasks/task-state.js');
    const { acceptTaskTerminalIntent } = await import('../src/rooms-tasks/terminal.js');
    startTask(t.task_id);
    activateTask(t.task_id);
    reviewTask(t.task_id);
    updateTaskRoom(t.task_id, 'room-terminal-recover', 'c'.repeat(64));
    await acceptTaskTerminalIntent({
      taskId: t.task_id,
      kind: 'done',
      roomId: 'room-terminal-recover',
      outcome: { summary: 'recover me' },
    });
    const ctx = context();
    await dispatchOwnerCommand(`/task recover ${t.task_id}`, ctx);
    expect(ctx.recoverTask).toHaveBeenCalledWith(t.task_id);
  });

  it('/task start without id returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task start', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });

  it('/task block without reason returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task block abc123', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });

  it('/task reports error for nonexistent task', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task show nonexistent', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('⚠️');
  });

  it('/task create creates a task in provisioning by default', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create my new task', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('created');
    expect(ctx.replies[0]).toContain('Provisioning');
  });

  it('/task create --backlog creates a task in backlog', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create --backlog backlog task', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('created');
    expect(ctx.replies[0]).toContain('backlog');
  });

  it('/task create parses transport syntax into the shared create request', async () => {
    const created = await createTestTask();
    const createTask = vi.fn(async () => created);
    const ctx = context({ createTask });
    await dispatchOwnerCommand(
      '/task create --backlog --template=dev Parsed title\nDetailed brief', ctx,
    );
    expect(createTask).toHaveBeenCalledWith({
      title: 'Parsed title', origin: { type: 'owner_channel' }, backlog: true,
      template: 'dev', noRoom: false, brief: 'Detailed brief',
    });
  });

  it('/task create --template=dev includes template in reply', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create --template=dev templated task', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('**Template:** `dev`');
  });

  it('/task create without title returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });

  it('/task create --no-room sets no_room on task record', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create --no-room manual task', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('**Room:** Not requested');
    const { listTasks } = await import('../src/rooms-tasks/task-state.js');
    const tasks = listTasks();
    const t = tasks.find(t => t.title === 'manual task');
    expect(t).toBeDefined();
    expect(t!.no_room).toBe(true);
  });

  it('/task create with multi-line brief stores brief on task record', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create Fix parser\nThis is the detailed brief.\nSecond line of brief.', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('created');
    const { listTasks } = await import('../src/rooms-tasks/task-state.js');
    const tasks = listTasks();
    const t = tasks.find(t => t.title === 'Fix parser');
    expect(t).toBeDefined();
    expect(t!.brief).toBe('This is the detailed brief.\nSecond line of brief.');
  });

  it('/task create --no-room --backlog with multi-line brief stores all fields', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task create --no-room --backlog Complex task\nBrief line 1\nBrief line 2', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Backlog');
    expect(ctx.replies[0]).toContain('**Room:** Not requested');
    const { listTasks } = await import('../src/rooms-tasks/task-state.js');
    const tasks = listTasks();
    const t = tasks.find(t => t.title === 'Complex task');
    expect(t).toBeDefined();
    expect(t!.no_room).toBe(true);
    expect(t!.brief).toBe('Brief line 1\nBrief line 2');
    expect(t!.state).toBe('backlog');
  });

  it('/task list shows all tasks', async () => {
    await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand('/task list', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('test task');
  });

  it('/task list backlog filters to backlog state', async () => {
    await createTestTask(); // backlog by default
    const ctx = context();
    await dispatchOwnerCommand('/task list backlog', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Backlog');
    expect(ctx.replies[0]).toContain('test task');
  });

  it('/task list parses its state label before delegating to the shared service callback', async () => {
    const listTasks = vi.fn(() => []);
    const ctx = context({ listTasks });
    await dispatchOwnerCommand('/task list backlog', ctx);
    expect(listTasks).toHaveBeenCalledWith({ state: 'backlog' });
  });

  it('/task list blocked shows no blocked tasks when none exist', async () => {
    await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand('/task list blocked', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('No blocked');
  });

  it('/task recover <id> shows task state', async () => {
    const t = await createTestTask();
    const ctx = context();
    await dispatchOwnerCommand(`/task recover ${t.task_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(t.task_id);
    expect(ctx.replies[0]).toContain('Backlog');
  });

  it('/task recover without id returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/task recover', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });

  it('does not expose CLI-only work or finish as Messenger task actions', async () => {
    for (const name of ['work', 'finish']) {
      const createTask = vi.fn(); const startTask = vi.fn(); const recoverTask = vi.fn();
      const ctx = context({ createTask, startTask, recoverTask,
        getTask: vi.fn(() => { throw new Error('not a supported action'); }) });
      await dispatchOwnerCommand(`/task ${name} some-id`, ctx);
      expect(createTask).not.toHaveBeenCalled();
      expect(startTask).not.toHaveBeenCalled();
      expect(recoverTask).not.toHaveBeenCalled();
    }
  });
});

describe('owner-channel room subcommands', () => {
  let dir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-oc-'));
    origHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = dir;
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
    else delete process.env.OURS_FLEET_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  async function createTestRoom(id?: string) {
    const { randomUUID } = await import('node:crypto');
    const { createRoomRecord } = await import('../src/rooms-tasks/room-state.js');
    return createRoomRecord({
      room_id: id ?? randomUUID().replace(/-/g, '').slice(0, 16),
      room_name: 'test room',
    });
  }

  it('snapshots the Markdown room list/show/recovery integration surface', async () => {
    const r = await createTestRoom('room-snapshot');
    const replies: string[] = [];
    for (const command of ['/room list', `/room show ${r.room_id}`, `/room recover ${r.room_id}`]) {
      const ctx = context();
      await dispatchOwnerCommand(command, ctx);
      replies.push(...ctx.replies);
    }
    expect(replies.map(reply => reply
      .replaceAll(r.room_id, '<ROOM_ID>')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<ISO_DATE>')))
      .toMatchSnapshot();
  });

  it('/room <id> shows room details (backward compat)', async () => {
    const r = await createTestRoom();
    const ctx = context();
    await dispatchOwnerCommand(`/room ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(r.room_id);
    expect(ctx.replies[0]).toContain('test room');
  });

  it('/room show <id> shows room details', async () => {
    const r = await createTestRoom();
    const ctx = context();
    await dispatchOwnerCommand(`/room show ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(r.room_id);
  });

  it('/room show and recover redact stored saga diagnostics', async () => {
    const r = await createTestRoom();
    const secret = 'stack at /secret/path token=canary-token';
    const { setSagaError } = await import('../src/rooms-tasks/room-state.js');
    setSagaError(r.room_id, secret, secret, 'member_failed');
    for (const command of [`/room show ${r.room_id}`, `/room recover ${r.room_id}`]) {
      const ctx = context();
      await dispatchOwnerCommand(command, ctx);
      expect(ctx.replies).toHaveLength(1);
      expect(ctx.replies[0]).toContain('inspect role logs');
      expect(ctx.replies[0]).not.toContain('/secret/path');
      expect(ctx.replies[0]).not.toContain('canary-token');
    }
  });

  it('keeps arbitrary room effect errors generic and never exposes their text', async () => {
    const r = await createTestRoom();
    const { activateRoom } = await import('../src/rooms-tasks/room-state.js');
    activateRoom(r.room_id);
    const secret = 'cannot connect using /secret/path token=canary-token';
    const ctx = context({ closeRoom: vi.fn(async () => { throw new Error(secret); }) });
    await dispatchOwnerCommand(`/room close ${r.room_id} ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('Command failed');
    expect(ctx.replies[0]).not.toContain('/secret/path');
    expect(ctx.replies[0]).not.toContain('canary-token');
  });

  it('/room close requires ID twice', async () => {
    const r = await createTestRoom();
    const ctx = context();
    await dispatchOwnerCommand(`/room close ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('destructive');
  });

  it('/room delete requires ID twice', async () => {
    const r = await createTestRoom();
    const ctx = context();
    await dispatchOwnerCommand(`/room delete ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('destructive');
  });

  it('/room delete <id> <id> delegates to the durable external delete path', async () => {
    const r = await createTestRoom();
    const { activateRoom } = await import('../src/rooms-tasks/room-state.js');
    activateRoom(r.room_id);
    const ctx = context();
    await dispatchOwnerCommand(`/room delete ${r.room_id} ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toBe(`scheduled:${r.room_id}`);
    expect(ctx.closeRoom).toHaveBeenCalledWith(r.room_id);
  });

  it('/room close <id> <id> delegates to the durable external close path', async () => {
    const r = await createTestRoom();
    const { activateRoom } = await import('../src/rooms-tasks/room-state.js');
    activateRoom(r.room_id);
    const ctx = context();
    await dispatchOwnerCommand(`/room close ${r.room_id} ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toBe(`scheduled:${r.room_id}`);
    expect(ctx.closeRoom).toHaveBeenCalledWith(r.room_id);
  });

  it('/room reports error for nonexistent room', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room show nonexistent', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('⚠️');
  });

  it('/room create creates a room', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room create --template=team my room', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('created');
    expect(ctx.replies[0]).toContain('**Template:** `team`');
  });

  it('parses Messenger room create into the shared request', async () => {
    const room = createRoomRecord({ room_id: 'room-delegate', room_name: 'Parsed room' });
    const createRoom = vi.fn(async () => room);
    const ctx = context({ createRoom });
    await dispatchOwnerCommand('/room create --template=team Parsed room\nTrailing goal', ctx);
    expect(createRoom).toHaveBeenCalledWith({
      name: 'Parsed room', template: 'team', goal: 'Trailing goal',
    });
  });

  it('/room create without name returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room create', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });

  it('/room create --template=team persists template_snapshot', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room create --template=team My Dev Room', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('created');
    expect(ctx.replies[0]).toContain('**Template:** `team`');
    const { listRoomRecords } = await import('../src/rooms-tasks/room-state.js');
    const rooms = listRoomRecords();
    const r = rooms.find(r => r.room_name === 'My Dev Room');
    expect(r).toBeDefined();
    expect(r!.template_snapshot).toBeDefined();
    expect(r!.template_snapshot!.name).toBe('team');
    expect(r!.template_snapshot!.content_hash).toBeTruthy();
  });

  it('/room create with unknown template returns error', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room create --template=nonexistent My Room', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('unknown template');
  });

  it('/room create with multi-line goal stores goal on room record', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room create --template=team Goal Room\nFix the parser bug.\nSecond goal line.', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('created');
    const { listRoomRecords } = await import('../src/rooms-tasks/room-state.js');
    const rooms = listRoomRecords();
    const r = rooms.find(r => r.room_name === 'Goal Room');
    expect(r).toBeDefined();
    expect(r!.goal).toBe('Fix the parser bug.\nSecond goal line.');
    expect(r!.template_snapshot).toBeDefined();
  });

  it('/room list shows rooms', async () => {
    await createTestRoom();
    const ctx = context();
    await dispatchOwnerCommand('/room list', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('test room');
  });

  it('/room list active filters to active rooms', async () => {
    const r = await createTestRoom();
    const { activateRoom } = await import('../src/rooms-tasks/room-state.js');
    activateRoom(r.room_id);
    const ctx = context();
    await dispatchOwnerCommand('/room list active', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('test room');
  });

  it('/room list and show hide legacy closed room records', async () => {
    const r = await createTestRoom();
    const { closeRoom } = await import('../src/rooms-tasks/room-state.js');
    closeRoom(r.room_id);
    const listCtx = context();
    await dispatchOwnerCommand('/room list', listCtx);
    expect(listCtx.replies).toEqual(['## 🏠 Rooms\n\nNo rooms found.']);
    const showCtx = context();
    await dispatchOwnerCommand(`/room show ${r.room_id}`, showCtx);
    expect(showCtx.replies[0]).toContain('## ⚠️ Not found');
  });

  it('delegates /rooms alias and all supported room list filters', async () => {
    const listRoomQueries = vi.fn(async () => []);
    for (const command of ['/rooms', '/room list active', '/room list provisioning', '/room list all']) {
      const ctx = context({ listRoomQueries });
      await dispatchOwnerCommand(command, ctx);
    }
    expect(listRoomQueries.mock.calls).toEqual([
      [], [{ state: 'active' }], [{ state: 'provisioning' }], [undefined],
    ]);
  });

  it('rejects invalid Messenger room filters without querying', async () => {
    const listRoomQueries = vi.fn(async () => []);
    const ctx = context({ listRoomQueries });
    await dispatchOwnerCommand('/room list closed', ctx);
    expect(listRoomQueries).not.toHaveBeenCalled();
    expect(ctx.replies[0]).toContain('Invalid command');
  });

  it('does not misclassify unexpected room query failures as not found', async () => {
    const ctx = context({ getRoomQuery: vi.fn(async () => { throw new Error('cowork unavailable'); }) });
    await dispatchOwnerCommand('/room show room-id', ctx);
    expect(ctx.replies[0]).toContain('Command failed');
    expect(ctx.replies[0]).not.toContain('Not found');
  });

  it('/room recover migrates a legacy closed record through deletion', async () => {
    const r = await createTestRoom();
    const { closeRoom } = await import('../src/rooms-tasks/room-state.js');
    closeRoom(r.room_id);
    const ctx = context();
    await dispatchOwnerCommand(`/room recover ${r.room_id}`, ctx);
    expect(ctx.closeRoom).toHaveBeenCalledWith(r.room_id);
  });

  it('/room recover <id> shows room saga state', async () => {
    const r = await createTestRoom();
    const ctx = context();
    await dispatchOwnerCommand(`/room recover ${r.room_id}`, ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain(r.room_id);
    expect(ctx.replies[0]).toContain('**Saga:**');
  });

  it('/room recover nonexistent returns not found', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room recover nonexistent', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('⚠️');
  });

  it('/room recover without id returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/room recover', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });
});

describe('owner-channel template subcommands', () => {
  it('/template show <name> shows template details', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/template show team', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('team');
    expect(ctx.replies[0]).toContain('Developer');
  });

  it('/template <name> shows template details (backward compat)', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/template team@1', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('team');
  });

  it('/template list lists all templates', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/template list', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('team');
    expect(ctx.replies[0]).toContain('pair');
  });

  it('Messenger template list consumes configured templates from the shared query', async () => {
    const configured = { name: 'configured', version: 9, description: 'Configured template',
      members: [], builtin: false } as any;
    const listTemplateQueries = vi.fn(() => [configured]);
    const ctx = context({ listTemplateQueries });
    await dispatchOwnerCommand('/template list', ctx);
    expect(listTemplateQueries).toHaveBeenCalledOnce();
    expect(ctx.replies[0]).toContain('configured@9');
  });

  it('/template show reports not found', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/template show nonexistent', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('not found');
  });

  it('does not turn unexpected template query failures into not found', async () => {
    const ctx = context({ getTemplateQuery: vi.fn(() => { throw new Error('config unreadable'); }) });
    await expect(dispatchOwnerCommand('/template show team', ctx)).rejects.toThrow('config unreadable');
    expect(ctx.replies[0]).toContain('could not be executed');
    expect(ctx.replies[0]).not.toContain('template not found');
  });

  it('/template show without name returns usage', async () => {
    const ctx = context();
    await dispatchOwnerCommand('/template show', ctx);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toContain('usage');
  });
});
