import { execFile, spawn } from 'node:child_process';

import type { InterruptOutcome, SessionEvent, SessionSnapshot } from '../session/types.js';
import type {
  RoomOrchestrationRecord, TaskOutcome, TaskRecord, TaskTerminalIntent,
  TaskListRecord,
} from '../rooms-tasks/types.js';
import { launchFleetWorker } from '../rooms-tasks/external-worker.js';
import { RoomStateError } from '../rooms-tasks/room-state.js';
import { TaskStateError } from '../rooms-tasks/task-state.js';
import {
  markdownCode, markdownProse, renderMarkdownFailure, renderMarkdownList,
  renderMarkdownResult, roomStatus, taskStatus,
} from '../rooms-tasks/markdown.js';
import { OWNER_COMMENT_LABEL, ownerNotices, type OwnerCommentsState } from './notices.js';
import { TaskRoomApplicationError } from '../application/task-room-service.js';
import type { CreateRoomRequest, CreateTaskRequest, TaskRoomApplicationService } from '../application/task-room-service.js';
import type { TaskState } from '../rooms-tasks/types.js';
import { TaskListError } from '../rooms-tasks/task-lists.js';
import { createTasksReport } from '../reports/index.js';

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
  recoverTask(taskId: string): Promise<void>;
}

/**
 * The narrow capability surface a command executor sees. Everything here is
 * already scoped to the one role whose channel received the message; commands
 * cannot name another agent or another recipient.
 */
export interface OwnerCommandContext {
  authenticatedCid?: string;
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
  recoverRoom(roomId: string): Promise<void>;
  /** Persist terminal intent, acknowledge it, then launch the external settle worker. */
  terminalTask(taskId: string, kind: TaskTerminalIntent['kind'], outcome?: TaskOutcome): Promise<void>;
  recoverTask(taskId: string): Promise<void>;
  createTask(input: Omit<CreateTaskRequest, 'actor'>): Promise<TaskRecord>;
  startTask(taskId: string): Promise<TaskRecord>;
  listTasks(filter?: { state?: TaskState | TaskState[]; list?: string }): TaskRecord[];
  groupedTasks(filter?: { state?: TaskState | TaskState[]; list?: string }): Array<{ list: TaskListRecord; tasks: TaskRecord[] }>;
  listTaskLists(): TaskListRecord[];
  createTaskList(name: string): Promise<TaskListRecord>;
  renameTaskList(name: string, newName: string): Promise<TaskListRecord>;
  deleteTaskList(name: string, destination?: string): Promise<{ deleted: TaskListRecord; moved: number; destination?: TaskListRecord }>;
  moveTask(taskId: string, list: string): Promise<TaskRecord>;
  getTask(taskId: string): { task: TaskRecord; orchestration: RoomOrchestrationRecord | undefined };
  blockTask(taskId: string, reason: string): TaskRecord;
  unblockTask(taskId: string): TaskRecord;
  reviewTask(taskId: string): TaskRecord;
  deleteTask(taskId: string): boolean;
  listRoomQueries(filter?: { state?: 'active' | 'provisioning' }): ReturnType<TaskRoomApplicationService['listRooms']>;
  getRoomQuery(id: string): ReturnType<TaskRoomApplicationService['getRoomDetail']>;
  listTemplateQueries(): ReturnType<TaskRoomApplicationService['listTemplates']>;
  getTemplateQuery(name: string): ReturnType<TaskRoomApplicationService['getTemplate']>;
  createRoom(input: Omit<CreateRoomRequest, 'actor'>): Promise<RoomOrchestrationRecord>;
  recentEvents(limit: number): SessionEvent[];
  readWorklogTail(maxChars: number): Promise<string | undefined>;
  reply(text: string): Promise<void>;
  replyHtml(filename: string, html: string): Promise<void>;
}

async function ownerTaskReport(ctx: OwnerCommandContext) {
  return createTasksReport({
    viewer: { surface: 'messenger', authenticatedCid: ctx.authenticatedCid ?? 'owner-command-context', roomCids: [] },
    collect: () => {
      return { lists: ctx.listTaskLists(), tasks: ctx.listTasks() };
    },
    source: { name: 'ours-fleet', version: ctx.version },
  });
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
  + ` — List ${markdownCode(task.list_name ?? 'default')}`
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
  kind: 'not_found' | 'state' | 'usage' | 'unexpected'; detail?: string; action: string;
} {
  if (error instanceof TaskListError) return {
    kind: error.code === 'list_not_found' ? 'not_found'
      : error.code === 'invalid_name' ? 'usage' : 'state',
    detail: error.message,
    action: error.code === 'list_not_found' ? 'Run /task lists to find a valid list.'
      : 'Choose a valid list name or an explicit different destination.',
  };
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
  if (error instanceof TaskRoomApplicationError
      && (error.code === 'room_not_found' || error.code === 'room_record_not_found')) return {
    kind: 'not_found', detail: `Room ${error.fields.room} was not found.`,
    action: 'Run /room list to find a valid room ID.',
  };
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
    name: 'tasks', usage: '/tasks [state|html]',
    summary: 'list tasks, or attach the HTML report with /tasks html',
    execute: async (ctx, args) => {
      const stateFilter = args?.trim() || undefined;
      if (stateFilter === 'html') {
        const artifact = await ownerTaskReport(ctx);
        await ctx.replyHtml(artifact.metadata.filename, artifact.html);
        await ctx.reply(`HTML report attached: ${artifact.metadata.filename}`);
        return;
      }
      if (stateFilter && /\s/u.test(stateFilter)) throw new OwnerCommandUsageError('usage: /tasks [state|html]');
      const tasks = ctx.listTasks(stateFilter && stateFilter !== 'all' ? { state: stateFilter as any } : undefined);
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
        const { task: t } = ctx.getTask(id);
        await ctx.reply(renderMarkdownResult({
          icon: '📋', title: 'Task details',
          fields: [
            { label: 'ID', value: t.task_id, kind: 'code' },
            { label: 'Title', value: t.title },
            { label: 'Status', value: taskStatus(t.state), kind: 'markdown' },
            { label: 'List', value: t.list_name ?? 'default', kind: 'code' },
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
            const listFlag = rest.find(r => r.startsWith('--list='));
            const list = listFlag?.slice('--list='.length);
            const titleParts = rest.filter(r => r !== '--backlog' && !r.startsWith('--template=')
              && !r.startsWith('--list=') && r !== '--no-room');
            if (!titleParts.length) throw new OwnerCommandUsageError('usage: /task create [--backlog] [--template=<name>|--no-room] <title>');
            const t = await ctx.createTask({
              title: titleParts.join(' '), origin: { type: 'owner_channel' },
              backlog, template, noRoom, brief: trailingLines, list,
            });
            await ctx.reply(taskAction('Task created', t, [
              { label: 'Title', value: t.title },
              ...(template ? [{ label: 'Template', value: template, kind: 'code' as const }] : []),
              ...(noRoom ? [{ label: 'Room', value: 'Not requested' }] : []),
            ]));
            break;
          }
          case 'list': {
            if (rest.some(value => value.startsWith('--')
              && value !== '--group-by-list' && !value.startsWith('--list=')))
              throw new OwnerCommandUsageError('usage: /task list [state] [--list=<name>] [--group-by-list]');
            const listFlag = rest.find(r => r.startsWith('--list='));
            const list = trailingLines ?? listFlag?.slice('--list='.length);
            const grouped = rest.includes('--group-by-list');
            const filter = rest.find(r => !r.startsWith('--'));
            const stateMap: Record<string, string | string[]> = {
              backlog: 'backlog', active: 'active', blocked: 'active',
              done: 'done', all: ['backlog', 'provisioning', 'active', 'review', 'done', 'cancelled', 'failed'],
            };
            const stateFilter = filter && stateMap[filter]
              ? { state: stateMap[filter] as any }
              : undefined;
            const combined = { ...(stateFilter ?? {}), ...(list ? { list } : {}) };
            const tasks = ctx.listTasks(combined);
            if (filter === 'blocked') {
              const blocked = tasks.filter(t => t.blocked);
              await ctx.reply(renderMarkdownList({
                icon: '🚧', title: 'Blocked tasks', empty: 'No blocked tasks found.',
                records: blocked.map(taskListRecord),
              }));
              break;
            }
            if (grouped) {
              const groups = ctx.groupedTasks(combined);
              await ctx.reply(groups.map(group => renderMarkdownList({
                icon: '📋', title: `Tasks — ${group.list.name}`, empty: 'No tasks found.',
                records: group.tasks.map(taskListRecord),
              })).join('\n\n'));
              break;
            }
            await ctx.reply(renderMarkdownList({
              icon: '📋', title: 'Tasks', empty: 'No tasks found.',
              records: tasks.map(taskListRecord),
            }));
            break;
          }
          case 'lists': {
            if (rest.length || trailingLines) throw new OwnerCommandUsageError('usage: /task lists');
            const lists = ctx.listTaskLists();
            await ctx.reply(renderMarkdownList({ icon: '📚', title: 'Task lists', empty: 'No task lists found.',
              records: lists.map(list => `${markdownCode(list.name)}${list.built_in ? ' — built-in' : ''}`) }));
            break;
          }
          case 'list-create': {
            const name = trailingLines ?? rest.join(' ');
            if (!name) throw new OwnerCommandUsageError('usage: /task list-create\n<name>');
            const list = await ctx.createTaskList(name);
            await ctx.reply(renderMarkdownResult({ icon: '📚', title: 'Task list created', fields: [{ label: 'Name', value: list.name }] }));
            break;
          }
          case 'list-rename': {
            const names = argLines.slice(1).map(line => line.trim()).filter(Boolean);
            const current = names.length === 2 ? names[0] : rest[0];
            const next = names.length === 2 ? names[1] : rest[1];
            if (!current || !next) throw new OwnerCommandUsageError('usage: /task list-rename\n<name>\n<new-name>');
            const list = await ctx.renameTaskList(current, next);
            await ctx.reply(renderMarkdownResult({ icon: '📚', title: 'Task list renamed', fields: [{ label: 'Name', value: list.name }] }));
            break;
          }
          case 'list-delete': {
            const names = argLines.slice(1).map(line => line.trim()).filter(Boolean);
            const name = names[0] ?? rest[0];
            const destination = names[1] ?? rest.find(r => r.startsWith('--move-to='))?.slice('--move-to='.length);
            if (!name) throw new OwnerCommandUsageError('usage: /task list-delete\n<name>\n[move-to-name]');
            const result = await ctx.deleteTaskList(name, destination);
            await ctx.reply(renderMarkdownResult({ icon: '🗑️', title: 'Task list deleted', fields: [
              { label: 'Name', value: result.deleted.name }, { label: 'Tasks moved', value: String(result.moved) },
            ] }));
            break;
          }
          case 'move': {
            const destination = trailingLines ?? rest.find(r => r.startsWith('--list='))?.slice('--list='.length);
            if (!rest[0] || !destination) throw new OwnerCommandUsageError('usage: /task move <id> --list=<name>');
            await showTask((await ctx.moveTask(rest[0], destination)).task_id);
            break;
          }
          case 'show': {
            if (rest.length !== 1 || rest[0].startsWith('--'))
              throw new OwnerCommandUsageError('usage: /task show <id>');
            await showTask(rest[0]);
            break;
          }
          case 'start': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task start <id>');
            const t = await ctx.startTask(rest[0]);
            await ctx.reply(taskAction('Task started', t));
            break;
          }
          case 'block': {
            if (!rest[0] || !rest[1]) throw new OwnerCommandUsageError('usage: /task block <id> <reason>');
            const reason = rest.slice(1).join(' ');
            const t = ctx.blockTask(rest[0], reason);
            await ctx.reply(taskAction('Task blocked', t, [{ label: 'Reason', value: reason }]));
            break;
          }
          case 'unblock': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task unblock <id>');
            const t = ctx.unblockTask(rest[0]);
            await ctx.reply(taskAction('Task unblocked', t));
            break;
          }
          case 'review': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task review <id>');
            const t = ctx.reviewTask(rest[0]);
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
            const deleted = ctx.deleteTask(rest[0]);
            await ctx.reply(renderMarkdownResult({
              icon: '🗑️', title: deleted ? 'Task deleted' : 'Task already absent',
              fields: [{ label: 'ID', value: rest[0], kind: 'code' }],
            }));
            break;
          }
          case 'recover': {
            if (!rest[0]) throw new OwnerCommandUsageError('usage: /task recover <id>');
            await ctx.recoverTask(rest[0]);
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
      const rooms = await ctx.listRoomQueries();
      await ctx.reply(renderMarkdownList({
        icon: '🏠', title: 'Rooms', empty: 'No rooms found.',
        records: rooms.map(room =>
          `${roomStatus(room.state)} ${markdownCode(room.room_id)} — ${markdownProse(room.room_name)}`
          + (room.orchestration?.task_id ? ` — Task ${markdownCode(room.orchestration.task_id)}` : '')),
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
        let detail;
        try { detail = await ctx.getRoomQuery(id); }
        catch (error) {
          if (!(error instanceof TaskRoomApplicationError && error.code === 'room_not_found')) throw error;
          return ctx.reply(renderMarkdownFailure({ kind: 'not_found', subject: `/room show ${id}`,
            detail: `Room ${id} was not found.`, action: 'Run /room list to find a valid room ID.' }));
        }
        const { room, orchestration: r } = detail;
        await ctx.reply(renderMarkdownResult({
          icon: '🏠', title: 'Room details',
          fields: [
            { label: 'ID', value: room.room_id, kind: 'code' },
            { label: 'Name', value: room.room_name },
            { label: 'Status', value: roomStatus(room.state), kind: 'markdown' },
            ...(r ? [{ label: 'Saga', value: `${r.saga.phase} (step ${r.saga.step_index})` }] : []),
            ...(r?.task_id ? [{ label: 'Task', value: r.task_id, kind: 'code' as const }] : []),
            ...(r?.provisioning_detail ? [{ label: 'Detail', value: r.provisioning_detail }] : []),
            ...(r?.saga.error ? [{ label: 'Last error', value: 'Provisioning failure recorded; inspect role logs.' }] : []),
            ...(r ? [{ label: 'Created', value: r.created_at, kind: 'code' as const }] : []),
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
            let r;
            try { r = await ctx.createRoom({ name: nameParts.join(' '), template: templateName,
              goal: roomTrailingLines }); }
            catch (error) {
              if (error instanceof TaskRoomApplicationError && error.code === 'template_not_found')
                throw new OwnerCommandUsageError(`unknown template: ${templateName}`);
              throw error;
            }
            await ctx.reply(roomAction('Room created', r, [
              { label: 'Name', value: r.room_name },
              ...(templateName ? [{ label: 'Template', value: templateName, kind: 'code' as const }] : []),
            ]));
            break;
          }
          case 'list': {
            const filter = rest[0];
            if (filter && !['active', 'provisioning', 'all'].includes(filter))
              throw new OwnerCommandUsageError('usage: /room list [active|provisioning|all]');
            const rooms = await ctx.listRoomQueries(
              filter === 'active' || filter === 'provisioning' ? { state: filter } : undefined);
            await ctx.reply(renderMarkdownList({
              icon: '🏠', title: 'Rooms', empty: 'No rooms found.',
              records: rooms.map(room =>
                `${roomStatus(room.state)} ${markdownCode(room.room_id)} — ${markdownProse(room.room_name)}`
                + (room.orchestration?.task_id ? ` — Task ${markdownCode(room.orchestration.task_id)}` : '')),
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
            await ctx.recoverRoom(rest[0]);
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
      const templates = ctx.listTemplateQueries();
      if (!templates.length) return ctx.reply('📐 No templates.');
      const lines = templates.map(t =>
        `${t.name}@${t.version}  ${t.description}  [file: ${t.sourceFile ?? 'manifest'}]`);
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
        let t;
        try { t = ctx.getTemplateQuery(nameStr); }
        catch (error) {
          if (!(error instanceof TaskRoomApplicationError && error.code === 'template_not_found')) throw error;
          return ctx.reply(`⚠️ template not found: ${nameStr}`);
        }
        const lines = [
          `📐 Template: ${t.name}@${t.version}`,
          `Description: ${t.description}`,
          `Source: ${t.sourceFile ?? 'manifest'}`,
          ...(t.contract ? [`Contract: ${t.contract}`] : []),
          'Members:',
          ...t.members.map(m => `  ${m.slot} (${m.role}) ×${m.count} → `
            + `Agent Template: ${m.agent_template}`),
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
          const templates = ctx.listTemplateQueries();
          if (!templates.length) return ctx.reply('📐 No templates.');
          const lines = templates.map(t =>
            `${t.name}@${t.version}  ${t.description}  [file: ${t.sourceFile ?? 'manifest'}]`);
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
    recoverTask: taskId => launchFleetWorker(
      ['task', '_recover', taskId], `task-recover-${taskId}`, configPath,
    ),
  };
}
