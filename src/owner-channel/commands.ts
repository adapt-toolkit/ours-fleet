import { execFile, spawn } from 'node:child_process';

import type { InterruptOutcome, SessionEvent, SessionSnapshot } from '../session/types.js';
import type {
  RoomOrchestrationRecord, TaskOutcome, TaskRecord, TaskTerminalIntent,
} from '../rooms-tasks/types.js';
import { launchFleetWorker } from '../rooms-tasks/external-worker.js';
import { RoomStateError } from '../rooms-tasks/room-state.js';
import { TaskStateError } from '../rooms-tasks/task-state.js';
import {
  markdownCode, markdownProse, renderMarkdownFailure, renderMarkdownList,
  renderMarkdownResult, roomStatus, taskStatus,
} from '../rooms-tasks/markdown.js';
import { OWNER_COMMENT_LABEL, ownerNotices, type OwnerCommentsState } from './notices.js';

/**
 * Fleet-level effects a deterministic owner command may trigger. Production
 * uses the detached CLI (`fleetCliOps`); tests inject fakes so no command can
 * ever bounce a real service from the suite.
 */
export interface OwnerFleetOps {
  /** `ours-fleet restart` (keep) or `ours-fleet force-restart` (fresh) of this role. */
  restart(mode: 'keep' | 'fresh'): Promise<void>;
  /** `ours-fleet ls` output. */
  list(): Promise<string>;
  /** Start a room-close worker outside the caller role's supervisor lifecycle. */
  closeRoom(roomId: string): Promise<void>;
  /** Resume a task terminal intent outside the caller role's supervisor lifecycle. */
  settleTask(taskId: string): Promise<void>;
}

/**
 * The narrow capability surface a command executor sees. Everything here is
 * already scoped to the one role whose channel received the message; commands
 * cannot name another agent or another recipient.
 */
export interface OwnerCommandContext {
  role: string;
  /** Harness id of the role (e.g. 'claude-code', 'codex'); gates forwarding. */
  harness: string;
  version: string;
  snapshot(): SessionSnapshot;
  interrupt(): Promise<InterruptOutcome>;
  /**
   * Deliver raw slash text to the agent harness. Only commands the bundled
   * ACP adapter for `harness` verifiably executes locally may be forwarded
   * (see HARNESS_LOCAL_COMMANDS); anything else would reach the model as an
   * ordinary prompt. The channel sends the acceptance and outcome notices
   * itself.
   */
  runHarnessCommand(command: string): Promise<void>;
  restart(mode: 'keep' | 'fresh'): Promise<void>;
  /** Effective ACP live-comment relay state of this running channel. */
  comments(): OwnerCommentsState;
  /**
   * Change the RUNNING session's effective live-comment relaying. The fleet.yaml
   * baseline is never rewritten, so a restart returns to the declared value.
   */
  setComments(enabled: boolean): OwnerCommentsState;
  fleetList(): Promise<string>;
  /** Persist acceptance, acknowledge it, then launch the external close worker. */
  closeRoom(roomId: string): Promise<void>;
  /** Persist terminal intent, acknowledge it, then launch the external settle worker. */
  terminalTask(taskId: string, kind: TaskTerminalIntent['kind'], outcome?: TaskOutcome): Promise<void>;
  recentEvents(limit: number): SessionEvent[];
  readWorklogTail(maxChars: number): Promise<string | undefined>;
  reply(text: string): Promise<void>;
}

export interface OwnerCommand {
  /** Primary name without the leading slash. */
  name: string;
  aliases?: string[];
  /** Shown in help; defaults to `/<name>`. */
  usage?: string;
  /** One-line description shown in help. */
  summary: string;
  execute(ctx: OwnerCommandContext, args: string): Promise<void>;
}

/** A malformed invocation; the dispatcher answers it with annotated help. */
class OwnerCommandUsageError extends Error {}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPLY_MAX_CHARS = 3_500;

const taskListRecord = (task: TaskRecord): string =>
  `${taskStatus(task.state)} ${markdownCode(task.task_id)} — ${markdownProse(task.title)}`
  + (task.blocked ? ` — 🚧 Blocked: ${markdownProse(task.blocked.reason)}` : '');

const roomListRecord = (room: RoomOrchestrationRecord): string =>
  `${roomStatus(room.state)} ${markdownCode(room.room_id)} — ${markdownProse(room.room_name)}`
  + (room.task_id ? ` — Task ${markdownCode(room.task_id)}` : '');

const TASK_STATE_WORD = '(?:backlog|provisioning|active|review|done|cancelled|failed)';
const SAFE_ID_WORD = '[A-Za-z0-9_-]{1,128}';

function isKnownOwnerTaskState(message: string): boolean {
  return [
    new RegExp(`^cannot transition from '${TASK_STATE_WORD}' to '${TASK_STATE_WORD}'$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} has a pending '(?:done|cancelled)' terminal intent$`, 'u'),
    new RegExp(`^cannot (?:block|cancel) a '${TASK_STATE_WORD}' task$`, 'u'),
    /^task is not blocked$/u,
    new RegExp(`^task ${SAFE_ID_WORD} already has a conflicting '(?:done|cancelled)' terminal intent$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} is already in terminal state '${TASK_STATE_WORD}'$`, 'u'),
    new RegExp(`^cannot delete a '${TASK_STATE_WORD}' task; only 'done' tasks can be deleted$`, 'u'),
  ].some(pattern => pattern.test(message));
}

function isKnownOwnerRoomState(message: string): boolean {
  return [
    new RegExp(`^room ${SAFE_ID_WORD} is not closing$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} has no recorded member .{1,128}$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} close cannot move backward to [A-Za-z_]+$`, 'u'),
  ].some(pattern => pattern.test(message));
}

function ownerTaskFailure(error: unknown): {
  kind: 'not_found' | 'state' | 'unexpected'; detail?: string; action: string;
} {
  if (error instanceof TaskStateError) {
    const missing = /^task not found: ([A-Za-z0-9_-]{1,128})$/u.exec(error.message);
    if (missing) return {
      kind: 'not_found', detail: `Task ${missing[1]} was not found.`,
      action: 'Run /task list to find a valid task ID.',
    };
    if (isKnownOwnerTaskState(error.message)) return {
      kind: 'state', detail: 'The current task state does not allow that action.',
      action: 'Run /task show <id> to inspect the current task state.',
    };
  }
  return {
    kind: 'unexpected',
    action: 'Retry once; if it repeats, inspect the role logs.',
  };
}

function ownerRoomFailure(error: unknown): {
  kind: 'not_found' | 'state' | 'unexpected'; detail?: string; action: string;
} {
  if (error instanceof RoomStateError) {
    const missing = /^room not found: ([A-Za-z0-9_-]{1,128})$/u.exec(error.message);
    if (missing) return {
      kind: 'not_found', detail: `Room ${missing[1]} was not found.`,
      action: 'Run /room list to find a valid room ID.',
    };
    if (isKnownOwnerRoomState(error.message)) return {
      kind: 'state', detail: 'The current room state does not allow that action.',
      action: 'Run /room show <id> to inspect the current room state.',
    };
  }
  return {
    kind: 'unexpected',
    action: 'Retry once; if it repeats, inspect the role logs.',
  };
}

const taskAction = (
  title: string, task: TaskRecord, fields: Parameters<typeof renderMarkdownResult>[0]['fields'] = [],
): string => renderMarkdownResult({
  icon: '📋', title,
  fields: [
    { label: 'ID', value: task.task_id, kind: 'code' },
    { label: 'Status', value: taskStatus(task.state), kind: 'markdown' },
    ...fields,
  ],
});

const roomAction = (
  title: string, room: RoomOrchestrationRecord,
  fields: Parameters<typeof renderMarkdownResult>[0]['fields'] = [],
): string => renderMarkdownResult({
  icon: '🏠', title,
  fields: [
    { label: 'ID', value: room.room_id, kind: 'code' },
    { label: 'Status', value: roomStatus(room.state), kind: 'markdown' },
    ...fields,
  ],
});

const strip = (value: unknown, max: number): string =>
  String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** Like `strip`, but keeps newlines so multi-line listings stay readable. */
const stripMultiline = (value: unknown, max: number): string =>
  String(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max);

/**
 * Commands each harness's bundled ACP adapter verifiably executes locally,
 * pinned by test/acp-adapter-commands.test.ts against the shipped adapter
 * artifacts. claude-agent-acp routes slash commands into the Claude SDK,
 * which runs its builtins (/clear, /compact, /model) without a model turn;
 * codex-acp intercepts only /compact — /clear and /model are not builtins
 * and would fall through into sendPrompt, i.e. reach the model as an
 * ordinary prompt. Unlisted harnesses forward nothing.
 */
export const HARNESS_LOCAL_COMMANDS: Record<string, readonly string[]> = {
  'claude-code': ['clear', 'compact', 'model'],
  codex: ['compact'],
};

/**
 * Forward raw slash text to the harness only when the bundled adapter for
 * this role's harness verifiably executes it locally; otherwise answer with
 * a truthful refusal so the text can never reach the model as a prompt.
 */
const forwardHarnessCommand = (ctx: OwnerCommandContext, raw: string): Promise<void> => {
  const name = raw.slice(1).split(/\s+/, 1)[0];
  if (!(HARNESS_LOCAL_COMMANDS[ctx.harness] ?? []).includes(name))
    return ctx.reply(ownerNotices.commandUnsupported(`/${name}`, ctx.harness));
  return ctx.runHarnessCommand(raw);
};

/** Keep the LAST characters — tails are more useful than heads for logs. */
const tail = (value: string, max: number): string => {
  const points = Array.from(value);
  return points.length <= max ? value : `…${points.slice(-max).join('')}`;
};

const noArgs = (usage: string, run: (ctx: OwnerCommandContext) => Promise<void>) =>
  async (ctx: OwnerCommandContext, args: string): Promise<void> => {
    if (args) throw new OwnerCommandUsageError(`${usage} takes no arguments`);
    await run(ctx);
  };

/**
 * The single source of truth for the deterministic owner-channel command set:
 * /help renders exactly this table, so adding an entry here is the whole
 * registration step for a new command.
 */
export const ownerCommands: OwnerCommand[] = [
  {
    name: 'help', aliases: ['commands'],
    summary: 'list all deterministic owner-channel commands (alias: /commands)',
    execute: async ctx => ctx.reply(ownerCommandHelp()),
  },
  {
    name: 'status', summary: "report the agent's session state",
    execute: noArgs('/status', async ctx =>
      ctx.reply(ownerNotices.status(ctx.role, ctx.snapshot()))),
  },
  {
    name: 'comments', usage: '/comments [status|on|off]',
    summary: `report or change relaying of the agent's live "${OWNER_COMMENT_LABEL}" `
      + 'messages for this session (fleet.yaml is the restart baseline)',
    execute: async (ctx, args) => {
      const action = args.toLowerCase() || 'status';
      if (!['status', 'on', 'off'].includes(action))
        throw new OwnerCommandUsageError('usage: /comments [status|on|off]');
      await ctx.reply(ownerNotices.comments(
        action === 'status' ? ctx.comments() : ctx.setComments(action === 'on')));
    },
  },
  {
    name: 'interrupt', summary: "cancel the agent's active turn",
    execute: noArgs('/interrupt', async ctx => {
      let outcome: InterruptOutcome;
      // Only a cancellation that never reached the session is a failure. A
      // forced recovery stopped the turn: say so, and say it plainly.
      try { outcome = await ctx.interrupt(); }
      catch { return ctx.reply(ownerNotices.interruptFailed(ctx.role)); }
      await ctx.reply(outcome?.state === 'forced'
        ? ownerNotices.interruptForced(ctx.role)
        : ownerNotices.interrupted(ctx.role));
    }),
  },
  {
    name: 'clear', summary: "clear the agent's session context",
    execute: noArgs('/clear', ctx => forwardHarnessCommand(ctx, '/clear')),
  },
  {
    name: 'compact', summary: "compact the agent's session context",
    execute: noArgs('/compact', ctx => forwardHarnessCommand(ctx, '/compact')),
  },
  {
    name: 'model', usage: '/model <model-id>',
    summary: 'switch the model the agent runs on',
    execute: async (ctx, args) => {
      if (!args) throw new OwnerCommandUsageError('usage: /model <model-id>');
      if (!MODEL_ID.test(args))
        throw new OwnerCommandUsageError('model id must be alphanumeric with . _ : - only');
      await forwardHarnessCommand(ctx, `/model ${args}`);
    },
  },
  {
    name: 'restart', summary: 'restart the agent, resuming its context',
    execute: noArgs('/restart', ctx => ctx.restart('keep')),
  },
  {
    name: 'force-restart', summary: 'restart the agent FRESH (context wiped)',
    execute: noArgs('/force-restart', ctx => ctx.restart('fresh')),
  },
  {
    name: 'ls', summary: 'list running fleet sessions',
    execute: noArgs('/ls', async ctx =>
      ctx.reply(`📊 Fleet sessions:\n${tail(stripMultiline(await ctx.fleetList(), 10_000), REPLY_MAX_CHARS)}`)),
  },
  {
    name: 'peek', summary: 'summarize recent session activity (event shapes only, no content)',
    execute: noArgs('/peek', async ctx => {
      const lines = ctx.recentEvents(20).map(event => ['·', event.kind,
        ...(event.title !== undefined ? [strip(event.title, 80)] : []),
        ...(event.status !== undefined ? [`(${strip(event.status, 40)})`] : []),
        ...(event.stopReason !== undefined ? [`(${strip(event.stopReason, 40)})`] : []),
      ].join(' '));
      await ctx.reply(lines.length
        ? tail(`📊 Recent activity for ${ctx.role}:\n${lines.join('\n')}`, REPLY_MAX_CHARS)
        : `📊 No recent session activity recorded for ${ctx.role}.`);
    }),
  },
  {
    name: 'worklog', summary: "tail the agent's worklog",
    execute: noArgs('/worklog', async ctx => {
      const worklog = await ctx.readWorklogTail(REPLY_MAX_CHARS);
      await ctx.reply(worklog
        ? `📊 Worklog tail for ${ctx.role}:\n${worklog}`
        : `ℹ️ No worklog found for ${ctx.role}.`);
    }),
  },
  {
    name: 'version', summary: 'report the fleet version',
    execute: noArgs('/version', async ctx => ctx.reply(`ℹ️ ours-fleet ${ctx.version}`)),
  },
  {
    name: 'tasks', usage: '/tasks [state]',
    summary: 'list tasks (optionally filter by state)',
    execute: async (ctx, args) => {
      const { listTasks } = await import('../rooms-tasks/task-state.js');
      const stateFilter = args?.trim() || undefined;
      const tasks = listTasks(stateFilter && stateFilter !== 'all' ? { state: stateFilter as any } : undefined);
      await ctx.reply(renderMarkdownList({
        icon: '📋', title: 'Tasks', empty: 'No tasks found.',
        records: tasks.map(taskListRecord),
      }));
    },
  },
  {
    name: 'task',
    usage: '/task <create|list|show|start|block|unblock|review|done|cancel|delete|recover> ...',
    summary: 'task lifecycle subcommands',
    execute: async (ctx, args) => {
      if (!args) throw new OwnerCommandUsageError('usage: /task <subcommand> <id>');
      const argLines = args.trim().split('\n');
      const firstLineTokens = argLines[0].trim().split(/\s+/);
      const sub = firstLineTokens[0];
      const rest = firstLineTokens.slice(1);
      const trailingLines = argLines.slice(1).join('\n').trim() || undefined;

      const showTask = async (id: string) => {
        const { getTask } = await import('../rooms-tasks/task-state.js');
        const t = getTask(id);
        await ctx.reply(renderMarkdownResult({
          icon: '📋', title: 'Task details',
          fields: [
            { label: 'ID', value: t.task_id, kind: 'code' },
            { label: 'Title', value: t.title },
            { label: 'Status', value: taskStatus(t.state), kind: 'markdown' },
            ...(t.blocked ? [{ label: 'Blocked', value: t.blocked.reason }] : []),
            ...(t.template ? [{ label: 'Template', value: `${t.template.name}@${t.template.version}`, kind: 'code' as const }] : []),
            ...(t.room_id ? [{ label: 'Room', value: t.room_id, kind: 'code' as const }] : []),
            { label: 'Origin', value: t.origin.type },
            { label: 'Created', value: t.created_at, kind: 'code' },
          ],
        }));
      };

      try {
        switch (sub) {
          case 'create': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task create [--backlog] [--template=<name>|--no-room] <title>');
            const backlog = rest.includes('--backlog');
            const tplFlag = rest.find(r => r.startsWith('--template='));
            const template = tplFlag ? tplFlag.slice('--template='.length) : undefined;
            const noRoom = rest.includes('--no-room');
            const titleParts = rest.filter(r => r !== '--backlog' && !r.startsWith('--template=') && r !== '--no-room');
            if (!titleParts.length) throw new OwnerCommandUsageError('usage: /task create [--backlog] [--template=<name>|--no-room] <title>');
            const { createTask } = await import('../rooms-tasks/task-state.js');
            const t = createTask({
              title: titleParts.join(' '),
              origin: { type: 'owner_channel' as const },
              start: !backlog,
              ...(template ? { template: { name: template, version: 1, content_hash: '' } } : {}),
              ...(noRoom ? { no_room: true } : {}),
              ...(trailingLines ? { brief: trailingLines } : {}),
            });
            await ctx.reply(taskAction('Task created', t, [
              { label: 'Title', value: t.title },
              ...(template ? [{ label: 'Template', value: template, kind: 'code' as const }] : []),
              ...(noRoom ? [{ label: 'Room', value: 'Not requested' }] : []),
            ]));
            break;
          }
          case 'list': {
            const { listTasks } = await import('../rooms-tasks/task-state.js');
            const filter = rest[0];
            const stateMap: Record<string, string | string[]> = {
              backlog: 'backlog', active: 'active', blocked: 'active',
              done: 'done', all: ['backlog', 'provisioning', 'active', 'review', 'done', 'cancelled', 'failed'],
            };
            const stateFilter = filter && stateMap[filter]
              ? { state: stateMap[filter] as any }
              : undefined;
            const tasks = listTasks(stateFilter);
            if (filter === 'blocked') {
              const blocked = tasks.filter(t => t.blocked);
              await ctx.reply(renderMarkdownList({
                icon: '🚧', title: 'Blocked tasks', empty: 'No blocked tasks found.',
                records: blocked.map(taskListRecord),
              }));
              break;
            }
            await ctx.reply(renderMarkdownList({
              icon: '📋', title: 'Tasks', empty: 'No tasks found.',
              records: tasks.map(taskListRecord),
            }));
            break;
          }
          case 'show': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task show <id>');
            await showTask(rest[0]);
            break;
          }
          case 'start': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task start <id>');
            const { startTask } = await import('../rooms-tasks/task-state.js');
            const t = startTask(rest[0]);
            await ctx.reply(taskAction('Task started', t));
            break;
          }
          case 'block': {
            if (!rest[0] || !rest[1]) throw new OwnerCommandUsageError('usage: /task block <id> <reason>');
            const { blockTask } = await import('../rooms-tasks/task-state.js');
            const reason = rest.slice(1).join(' ');
            const t = blockTask(rest[0], reason);
            await ctx.reply(taskAction('Task blocked', t, [{ label: 'Reason', value: reason }]));
            break;
          }
          case 'unblock': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task unblock <id>');
            const { unblockTask } = await import('../rooms-tasks/task-state.js');
            const t = unblockTask(rest[0]);
            await ctx.reply(taskAction('Task unblocked', t));
            break;
          }
          case 'review': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task review <id>');
            const { reviewTask } = await import('../rooms-tasks/task-state.js');
            const t = reviewTask(rest[0]);
            await ctx.reply(taskAction('Task ready for review', t));
            break;
          }
          case 'done': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task done <id> [summary]');
            const summary = rest.slice(1).join(' ') || undefined;
            await ctx.terminalTask(rest[0], 'done', summary ? { summary } : undefined);
            break;
          }
          case 'cancel': {
            if (rest.length < 2 || rest[0] !== rest[1])
              throw new OwnerCommandUsageError('destructive: /task cancel <id> <id> — provide the task ID twice');
            await ctx.terminalTask(rest[0], 'cancelled');
            break;
          }
          case 'delete': {
            if (rest.length !== 2 || rest[0] !== rest[1])
              throw new OwnerCommandUsageError('destructive: /task delete <id> <id> — provide the task ID twice');
            const { deleteTask } = await import('../rooms-tasks/task-state.js');
            const deleted = deleteTask(rest[0]);
            await ctx.reply(renderMarkdownResult({
              icon: '🗑️', title: deleted ? 'Task deleted' : 'Task already absent',
              fields: [{ label: 'ID', value: rest[0], kind: 'code' }],
            }));
            break;
          }
          case 'recover': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task recover <id>');
            const { getTask } = await import('../rooms-tasks/task-state.js');
            const { getRoomRecord } = await import('../rooms-tasks/room-state.js');
            const t = getTask(rest[0]);
            if (t.terminal_intent?.status === 'pending') {
              await ctx.terminalTask(t.task_id, t.terminal_intent.kind, t.terminal_intent.outcome);
              break;
            }
            const room = t.room_id ? getRoomRecord(t.room_id) : undefined;
            const hints: string[] = [];
            if (t.state === 'provisioning' && room) {
              if (room.provisioning_detail === 'waiting_cowork') hints.push('Cowork socket unreachable');
              if (room.provisioning_detail === 'waiting_owner_invite') hints.push('Owner invite missing or invalid');
              if (room.provisioning_detail === 'owner_cid_mismatch') hints.push('Owner CID mismatch');
              if (room.provisioning_detail === 'member_failed') hints.push(`Member failed at step ${room.saga.step_index}`);
            }
            await ctx.reply(renderMarkdownResult({
              icon: '🛟', title: 'Task recovery',
              fields: [
                { label: 'Task', value: t.task_id, kind: 'code' },
                { label: 'Status', value: taskStatus(t.state), kind: 'markdown' },
                ...(room ? [
                  { label: 'Room', value: room.room_id, kind: 'code' as const },
                  { label: 'Room status', value: roomStatus(room.state), kind: 'markdown' as const },
                  { label: 'Saga', value: room.saga.phase, kind: 'code' as const },
                ] : []),
              ],
              sections: hints.length
                ? [{ heading: 'Next steps', items: hints }]
                : [{ heading: 'Result', items: ['No automated recovery action is available.'] }],
            }));
            break;
          }
          default:
            // bare /task <id> → show
            await showTask(sub);
        }
      } catch (e) {
        if (e instanceof OwnerCommandUsageError) throw e;
        const failure = ownerTaskFailure(e);
        await ctx.reply(renderMarkdownFailure({
          kind: failure.kind,
          subject: `/task ${sub}`,
          ...(failure.detail ? { detail: failure.detail } : {}),
          action: failure.action,
        }));
      }
    },
  },
  {
    name: 'rooms', summary: 'list rooms',
    execute: noArgs('/rooms', async ctx => {
      const { listRoomRecords } = await import('../rooms-tasks/room-state.js');
      const rooms = listRoomRecords().filter(
        room => room.state === 'active' || room.state === 'provisioning',
      );
      await ctx.reply(renderMarkdownList({
        icon: '🏠', title: 'Rooms', empty: 'No rooms found.',
        records: rooms.map(roomListRecord),
      }));
    }),
  },
  {
    name: 'room',
    usage: '/room <create|list|show|delete|close|recover> ...',
    summary: 'room lifecycle subcommands',
    execute: async (ctx, args) => {
      if (!args) throw new OwnerCommandUsageError('usage: /room <subcommand> <id>');
      const argLines = args.trim().split('\n');
      const firstLineTokens = argLines[0].trim().split(/\s+/);
      const sub = firstLineTokens[0];
      const rest = firstLineTokens.slice(1);
      const roomTrailingLines = argLines.slice(1).join('\n').trim() || undefined;

      const showRoom = async (id: string) => {
        const { getRoomRecord } = await import('../rooms-tasks/room-state.js');
        const r = getRoomRecord(id);
        if (!r || r.state === 'closing' || r.state === 'closed') return ctx.reply(renderMarkdownFailure({
          kind: 'not_found', subject: `/room show ${id}`,
          detail: `Room ${id} was not found.`, action: 'Run /room list to find a valid room ID.',
        }));
        await ctx.reply(renderMarkdownResult({
          icon: '🏠', title: 'Room details',
          fields: [
            { label: 'ID', value: r.room_id, kind: 'code' },
            { label: 'Name', value: r.room_name },
            { label: 'Status', value: roomStatus(r.state), kind: 'markdown' },
            { label: 'Saga', value: `${r.saga.phase} (step ${r.saga.step_index})` },
            ...(r.task_id ? [{ label: 'Task', value: r.task_id, kind: 'code' as const }] : []),
            ...(r.provisioning_detail ? [{ label: 'Detail', value: r.provisioning_detail }] : []),
            ...(r.saga.error ? [{ label: 'Last error', value: 'Provisioning failure recorded; inspect role logs.' }] : []),
            { label: 'Created', value: r.created_at, kind: 'code' },
          ],
        }));
      };

      try {
        switch (sub) {
          case 'create': {
            const tplFlag = rest.find(r => r.startsWith('--template='));
            const templateName = tplFlag?.slice('--template='.length);
            const nameParts = rest.filter(r => !r.startsWith('--'));
            if (!nameParts.length) throw new OwnerCommandUsageError('usage: /room create --template=<name> <room name>');
            const { randomUUID } = await import('node:crypto');
            const { createRoomRecord } = await import('../rooms-tasks/room-state.js');
            const { resolveTemplate, snapshotTemplate } = await import('../rooms-tasks/templates.js');
            let templateSnapshot: import('../rooms-tasks/types.js').TemplateSnapshot | undefined;
            if (templateName) {
              const tpl = resolveTemplate(templateName, {});
              if (!tpl) throw new OwnerCommandUsageError(`unknown template: ${templateName}`);
              templateSnapshot = snapshotTemplate(tpl);
            }
            const r = createRoomRecord({
              room_id: randomUUID().replace(/-/g, '').slice(0, 16),
              room_name: nameParts.join(' '),
              ...(templateSnapshot ? { template_snapshot: templateSnapshot } : {}),
              ...(roomTrailingLines ? { goal: roomTrailingLines } : {}),
            });
            await ctx.reply(roomAction('Room created', r, [
              { label: 'Name', value: r.room_name },
              ...(templateName ? [{ label: 'Template', value: templateName, kind: 'code' as const }] : []),
            ]));
            break;
          }
          case 'list': {
            const { listRoomRecords } = await import('../rooms-tasks/room-state.js');
            const filter = rest[0];
            let rooms = listRoomRecords().filter(
              room => room.state === 'active' || room.state === 'provisioning',
            );
            if (filter === 'active') rooms = rooms.filter(r => r.state === 'active');
            await ctx.reply(renderMarkdownList({
              icon: '🏠', title: 'Rooms', empty: 'No rooms found.',
              records: rooms.map(roomListRecord),
            }));
            break;
          }
          case 'show': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /room show <id>');
            await showRoom(rest[0]);
            break;
          }
          case 'delete':
          case 'close': {
            if (rest.length < 2 || rest[0] !== rest[1])
              throw new OwnerCommandUsageError(
                `destructive: /room ${sub} <id> <id> — provide the room ID twice`,
              );
            await ctx.closeRoom(rest[0]);
            break;
          }
          case 'recover': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /room recover <id>');
            const { getRoomRecord } = await import('../rooms-tasks/room-state.js');
            const r = getRoomRecord(rest[0]);
            if (!r) {
              await ctx.reply(renderMarkdownFailure({
                kind: 'not_found', subject: `/room recover ${rest[0]}`,
                detail: `Room ${rest[0]} was not found.`, action: 'Run /room list to find a valid room ID.',
              }));
              break;
            }
            if (r.state === 'closing' || r.state === 'closed') {
              await ctx.closeRoom(r.room_id);
              break;
            }
            await ctx.reply(renderMarkdownResult({
              icon: '🛟', title: 'Room recovery',
              fields: [
                { label: 'Room', value: r.room_id, kind: 'code' },
                { label: 'Status', value: roomStatus(r.state), kind: 'markdown' },
                { label: 'Saga', value: r.saga.phase, kind: 'code' },
                ...(r.saga.error ? [{ label: 'Last error', value: 'Provisioning failure recorded; inspect role logs.' }] : []),
                ...(r.provisioning_detail ? [{ label: 'Detail', value: r.provisioning_detail }] : []),
              ],
              sections: [{ heading: 'Next step', items: [r.saga.error
                ? 'Run ours-fleet room recover from the CLI for full recovery.'
                : 'No recovery action is needed.'] }],
            }));
            break;
          }
          default:
            // bare /room <id> → show
            await showRoom(sub);
        }
      } catch (e) {
        if (e instanceof OwnerCommandUsageError) throw e;
        const failure = ownerRoomFailure(e);
        await ctx.reply(renderMarkdownFailure({
          kind: failure.kind,
          subject: `/room ${sub}`,
          ...(failure.detail ? { detail: failure.detail } : {}),
          action: failure.action,
        }));
      }
    },
  },
  {
    name: 'templates', aliases: ['template-list'],
    summary: 'list available room templates',
    execute: noArgs('/templates', async ctx => {
      const { listTemplates } = await import('../rooms-tasks/templates.js');
      const templates = listTemplates({});
      if (!templates.length) return ctx.reply('📐 No templates.');
      const lines = templates.map(t => {
        const tag = t.builtin ? ' (built-in)' : '';
        return `${t.name}@${t.version}${tag}  ${t.description}`;
      });
      await ctx.reply(`📐 Templates:\n${lines.join('\n')}`);
    }),
  },
  {
    name: 'template',
    usage: '/template <show|list> <name[@version]>',
    summary: 'template subcommands (show, list)',
    execute: async (ctx, args) => {
      if (!args) throw new OwnerCommandUsageError('usage: /template show <name[@version]>');
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      const showTemplate = async (nameStr: string) => {
        const { resolveTemplate } = await import('../rooms-tasks/templates.js');
        const t = resolveTemplate(nameStr, {});
        if (!t) return ctx.reply(`⚠️ template not found: ${nameStr}`);
        const lines = [
          `📐 Template: ${t.name}@${t.version}`,
          `Description: ${t.description}`,
          ...(t.builtin ? ['Source: built-in'] : []),
          ...(t.contract ? [`Contract: ${t.contract}`] : []),
          'Members:',
          ...t.members.map(m =>
            `  ${m.slot} (${m.role}) ×${m.count} → role_ref: ${m.role_ref}`),
        ];
        await ctx.reply(lines.join('\n'));
      };

      switch (sub) {
        case 'show': {
          if (!parts[1]) throw new OwnerCommandUsageError('usage: /template show <name[@version]>');
          await showTemplate(parts[1]);
          break;
        }
        case 'list': {
          const { listTemplates } = await import('../rooms-tasks/templates.js');
          const templates = listTemplates({});
          if (!templates.length) return ctx.reply('📐 No templates.');
          const lines = templates.map(t => {
            const tag = t.builtin ? ' (built-in)' : '';
            return `${t.name}@${t.version}${tag}  ${t.description}`;
          });
          await ctx.reply(`📐 Templates:\n${lines.join('\n')}`);
          break;
        }
        default:
          // bare /template <name> → show
          await showTemplate(sub);
      }
    },
  },
];

/** Trimmed slash-prefixed text is a command attempt and is never forwarded. */
export const isOwnerCommandText = (text: string): boolean => text.trim().startsWith('/');

export function ownerCommandHelp(error?: string): string {
  const table = ownerCommands
    .map(command => `${command.usage ?? `/${command.name}`} — ${command.summary}`)
    .join('\n');
  return `${error ? `⚠️ ${error}\n\n` : ''}🧭 Deterministic owner-channel commands `
    + '(handled by fleet; never sent to the agent as a prompt):\n'
    + `${table}\n`
    + 'Messages without a leading "/" reach the agent unchanged. '
    + 'Unknown or malformed commands return this help.';
}

/**
 * Execute one authenticated owner command. `text` must already be trimmed,
 * slash-prefixed, and from an authorized owner CID — the channel enforces the
 * authority boundary before dispatch ever sees the message.
 */
export async function dispatchOwnerCommand(
  text: string, ctx: OwnerCommandContext,
): Promise<void> {
  const trimmed = text.trim();
  const token = trimmed.split(/\s+/, 1)[0];
  const name = token.slice(1).toLowerCase();
  const args = trimmed.slice(token.length).trim();
  const command = ownerCommands.find(entry =>
    entry.name === name || entry.aliases?.includes(name));
  if (!command) return ctx.reply(ownerCommandHelp(`unknown command ${strip(token, 60)}`));
  try {
    await command.execute(ctx, args);
  } catch (error) {
    if (error instanceof OwnerCommandUsageError)
      return ctx.reply(renderMarkdownFailure({
        kind: 'usage', subject: token, detail: error.message,
        action: `Use ${command.usage ?? `/${command.name}`} or run /help.`,
      }));
    // The failure notice carries no internal detail; the channel logs it.
    await ctx.reply(ownerNotices.commandFailed(command.usage ?? `/${command.name}`));
    throw error;
  }
}

/**
 * Production fleet effects: the detached ours-fleet CLI. The restart child is
 * detached and unreferenced because a successful restart kills this very
 * process; the reply and the durable wire record must already be on disk.
 */
export function fleetCliOps(role: string, configPath?: string): OwnerFleetOps {
  const cli = (args: string[]): string[] =>
    [process.argv[1], ...args, ...(configPath ? ['-c', configPath] : [])];
  return {
    restart: mode => new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        cli([mode === 'fresh' ? 'force-restart' : 'restart', role]),
        { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    }),
    list: () => new Promise((resolve, reject) => {
      execFile(process.execPath, [process.argv[1], 'ls'],
        { timeout: 15_000, maxBuffer: 256 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
    }),
    closeRoom: roomId => launchFleetWorker(
      ['room', '_delete', roomId], `room-delete-${roomId}`, configPath,
    ),
    settleTask: taskId => launchFleetWorker(
      ['task', '_settle', taskId], `task-settle-${taskId}`, configPath,
    ),
  };
}
