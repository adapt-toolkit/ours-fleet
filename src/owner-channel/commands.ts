import { execFile, spawn } from 'node:child_process';

import type { InterruptOutcome, SessionEvent, SessionSnapshot } from '../session/types.js';
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
      return ctx.reply(ownerCommandHelp(error.message));
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
  };
}
