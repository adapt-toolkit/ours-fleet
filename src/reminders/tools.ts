import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ReminderError, type ReminderStore } from './store.js';

/**
 * What the agent's managed MCP endpoint needs from its runner. Absent until
 * the runner has bound the store to this exact runtime instance and identity.
 */
export interface ReminderToolBackend {
  store: ReminderStore;
  /** Re-arm the dispatcher after a schedule change. */
  changed(): void;
}

export const REMINDER_TOOL_NAMES = Object.freeze([
  'fleet_reminder_create', 'fleet_reminder_list', 'fleet_reminder_update',
  'fleet_reminder_cancel', 'fleet_reminder_inspect', 'fleet_reminder_ack',
] as const);

const schedule = {
  local_time: z.string().describe('Calendar date and wall-clock time WITHOUT an offset, e.g. "2027-01-20T16:00". Always a real date: resolve "tomorrow" yourself.'),
  time_zone: z.string().describe('IANA zone the time is meant in, e.g. "Europe/London", "America/New_York" or "UTC". Use the zone of the person or task, not a guess.'),
  fold: z.union([z.literal(0), z.literal(1)]).optional().describe('Only for a wall time that occurs twice when clocks go back: 0 = first occurrence, 1 = second.'),
  late_window_seconds: z.number().int().optional().describe('How late the wake may still be delivered if this agent or the host was offline or busy at the due time (60..604800, default 3600). After it the reminder expires without a wake.'),
};

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function failure(code: string, message: string) {
  const value = { error: code, message };
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: true };
}

/**
 * Register the self-reminder tools on the agent's own fixed-identity MCP
 * server. No argument names an agent, identity or recipient: the server is the
 * caller's own supervisor, so every operation is implicitly self-scoped.
 */
export function registerReminderTools(
  server: McpServer, backend: () => ReminderToolBackend | undefined,
  /** The endpoint's runtime admission; nothing is read or changed unless it admits. */
  admit: () => Promise<() => void>,
): void {
  const run = async (operation: (target: ReminderToolBackend) => unknown, mutates: boolean) => {
    let release: () => void;
    try { release = await admit(); }
    catch {
      return failure('runtime_not_ready',
        'the managed runtime is not admitting tool calls right now; nothing was read or changed');
    }
    try {
      const target = backend();
      if (!target) return failure('reminders_unavailable',
        'self-reminders are not available in this session (the supervisor has not bound them, or this session cannot take scheduled prompts)');
      try {
        const value = operation(target);
        if (mutates) target.changed();
        return result(value);
      } catch (error) {
        if (error instanceof ReminderError) return failure(error.code, error.message);
        return failure('reminder_store_failed', 'the reminder could not be recorded; nothing was changed');
      }
    } finally { release(); }
  };

  server.registerTool('fleet_reminder_create', {
    description: 'Schedule a one-time reminder that wakes YOU (this agent) at a future date and time. '
      + 'It sends nothing to anyone: when due, Fleet starts a turn for you with the reminder, and you decide what to do. '
      + 'Use it to come back to something later instead of polling or waiting. Repeating a call with the same request_key '
      + 'and input returns the existing reminder instead of creating another.',
    inputSchema: {
      request_key: z.string().describe('Stable key for this scheduling decision, so a retried call cannot create a duplicate (e.g. "release-check-2027-01-20").'),
      title: z.string().describe('Short label shown in the wake (max 200 characters).'),
      note: z.string().optional().describe('Private context for your future self: what to check and why (max 4000 characters). Returned by inspect, not in the wake text.'),
      ...schedule,
    },
  }, async args => run(({ store }) => store.create(args.request_key, args), true));

  server.registerTool('fleet_reminder_list', {
    description: 'List your own reminders. state: "open" (default: scheduled or delivered but not acknowledged), "closed", or "all". '
      + 'Pages with limit (1..100, default 50) and after (the id from the previous page).',
    inputSchema: {
      state: z.enum(['open', 'closed', 'all']).optional(),
      limit: z.number().int().optional(),
      after: z.string().optional(),
    },
  }, async args => run(({ store }) => store.list(args), false));

  server.registerTool('fleet_reminder_update', {
    description: 'Change one of your reminders, e.g. to postpone it. Pass the id and the revision you last saw '
      + '(expected_revision) plus only the fields to change. Any wake already issued for the old revision becomes void.',
    inputSchema: {
      id: z.string(),
      expected_revision: z.number().int(),
      title: z.string().optional(),
      note: z.string().optional(),
      local_time: schedule.local_time.optional(),
      time_zone: schedule.time_zone.optional(),
      fold: schedule.fold,
      late_window_seconds: schedule.late_window_seconds,
    },
  }, async ({ id, expected_revision, ...changes }) =>
    run(({ store }) => store.update(id, expected_revision, changes), true));

  server.registerTool('fleet_reminder_cancel', {
    description: 'Cancel one of your reminders (id + expected_revision). A wake already waiting for it will not be delivered.',
    inputSchema: { id: z.string(), expected_revision: z.number().int() },
  }, async ({ id, expected_revision }) => run(({ store }) => store.cancel(id, expected_revision), true));

  server.registerTool('fleet_reminder_inspect', {
    description: 'Read the reminder behind a [fleet-reminder] wake, including its note, and whether the wake is still current and eligible.',
    inputSchema: { event_id: z.string() },
  }, async ({ event_id }) => run(({ store }) => store.inspect(event_id), false));

  server.registerTool('fleet_reminder_ack', {
    description: 'Record that you handled a [fleet-reminder] wake (event_id + revision from the wake). '
      + 'It closes the reminder and sends nothing; it does not claim any external action happened. Safe to repeat.',
    inputSchema: { event_id: z.string(), expected_revision: z.number().int() },
  }, async ({ event_id, expected_revision }) => run(({ store }) => store.ack(event_id, expected_revision), true));
}
