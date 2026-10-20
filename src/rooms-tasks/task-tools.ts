import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  appendTaskProgress, detachTaskReviewArtifact, getTaskReview, listTaskProgress, publicProgressEntry, publicReview,
  setTaskReviewMarkdown, TaskReviewError, PROGRESS_TEXT_MAX, REVIEW_MARKDOWN_MAX,
} from './task-review.js';
import { getTask, TaskStateError } from './task-state.js';
import type { TaskContributionAuthor, TaskProgressEntry } from './types.js';

/** The task this agent belongs to, from supervisor launch records; never from tool arguments. */
export interface TaskToolBinding {
  taskId: string;
  role: string;
  identityCid?: string;
  /** Launched as a task-owned temporary member (layout participant). */
  taskOwned: boolean;
}

export const TASK_TOOL_NAMES = Object.freeze([
  'fleet_task_progress_list', 'fleet_task_progress_append',
  'fleet_task_review_show', 'fleet_task_review_set', 'fleet_task_review_detach',
] as const);

/** Compact JSON: a result is carried twice (text and structured) inside one bounded bridge frame. */
function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

export const PROGRESS_PAGE_MAX = 50;
/** Serialized entry bytes per page, well inside the bridge's frame limit even at maximal escaping. */
const PROGRESS_PAGE_BYTES = 200_000;

/** One chronological page of the log; `next_after` continues after the last returned entry. */
export function progressPage(entries: TaskProgressEntry[], input: { after?: string; limit?: number }): {
  progress: ReturnType<typeof publicProgressEntry>[]; total: number; next_after?: string;
} {
  const limit = input.limit ?? PROGRESS_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROGRESS_PAGE_MAX)
    throw new TaskReviewError('invalid_request', `limit must be 1..${PROGRESS_PAGE_MAX}`);
  let start = 0;
  if (input.after !== undefined) {
    start = entries.findIndex(entry => entry.id === input.after) + 1;
    if (!start) throw new TaskReviewError('invalid_request', 'after must be the id of an entry in this log');
  }
  const page: ReturnType<typeof publicProgressEntry>[] = [];
  let bytes = 0;
  for (const entry of entries.slice(start, start + limit)) {
    const visible = publicProgressEntry(entry), size = Buffer.byteLength(JSON.stringify(visible));
    if (page.length && bytes + size > PROGRESS_PAGE_BYTES) break;
    page.push(visible); bytes += size;
  }
  const end = start + page.length;
  return { progress: page, total: entries.length, ...(end < entries.length ? { next_after: entries[end - 1]!.id } : {}) };
}

function failure(code: string, message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }) }], isError: true };
}

/**
 * Confirm the binding against the task record: a listed member must match by
 * name and identity; an unlisted caller must be a task-owned launch.
 */
export function verifiedTaskAuthor(binding: TaskToolBinding): TaskContributionAuthor {
  const task = getTask(binding.taskId);
  const member = task.member_roles.find(item => item.name === binding.role);
  if (member ? (binding.identityCid && member.identity_cid !== binding.identityCid) : !binding.taskOwned)
    throw new TaskReviewError('conflict', `agent ${binding.role} is not a member of task ${binding.taskId}`);
  return { kind: 'agent', role: binding.role, ...(binding.identityCid ? { identity_cid: binding.identityCid } : {}), surface: 'mcp' };
}

/**
 * Task Progress and To review tools on the agent's own managed MCP endpoint.
 * The task and author come from the caller's supervisor, so an agent can only
 * read and write the task it was launched for. Review files are attached with
 * `ours-fleet task review-package <id> --attach <path>`, which reads the file
 * under the agent's own permissions.
 */
export function registerTaskTools(
  server: McpServer, binding: () => TaskToolBinding | undefined, admit: () => Promise<() => void>,
): void {
  const run = async (operation: (bound: TaskToolBinding, author: TaskContributionAuthor) => unknown) => {
    let release: () => void;
    try { release = await admit(); }
    catch { return failure('runtime_not_ready', 'the managed runtime is not admitting tool calls right now; nothing was read or changed'); }
    try {
      const bound = binding();
      if (!bound) return failure('task_unavailable', 'this agent was not launched for a Fleet task');
      try { return result(operation(bound, verifiedTaskAuthor(bound))); }
      catch (error) {
        if (error instanceof TaskReviewError) return failure(error.code, error.message);
        if (error instanceof TaskStateError) return failure('task_unavailable', error.message);
        return failure('task_store_failed', 'the task could not be read or updated; nothing was changed');
      }
    } finally { release(); }
  };

  server.registerTool('fleet_task_progress_list', {
    description: 'Read the Progress milestone log of the task you were launched for, oldest first, one page at a time. '
      + 'When next_after is present, call again with after set to it for the following entries.',
    inputSchema: {
      after: z.string().optional().describe('Entry id from the previous page\'s next_after; omit for the first page.'),
      limit: z.number().int().optional().describe(`Maximum entries per page (1..${PROGRESS_PAGE_MAX}, default ${PROGRESS_PAGE_MAX}). Pages are also bounded in size.`),
    },
  }, async args => run(bound => ({ task_id: bound.taskId, ...progressPage(listTaskProgress(bound.taskId), args) })));

  server.registerTool('fleet_task_progress_append', {
    description: 'Append ONE significant, verified milestone to your task\'s Progress log (e.g. root cause found, PR opened with link, '
      + 'measured result with its scope, final deliverable ready). Not for routine status, handoffs or review chatter. '
      + 'Entries are permanent and shown to the Owner as written. Repeating a call with the same request_key and text returns the original entry.',
    inputSchema: {
      text: z.string().describe(`Free-form milestone text, kept exactly as written (max ${PROGRESS_TEXT_MAX} characters).`),
      request_key: z.string().optional().describe('Stable key for this milestone so a retried call cannot add it twice (e.g. "pr-opened-123").'),
    },
  }, async args => run((bound, author) => {
    const appended = appendTaskProgress(bound.taskId, { text: args.text, requestKey: args.request_key, author });
    return { task_id: bound.taskId, entry: publicProgressEntry(appended.entry), replayed: appended.replayed };
  }));

  server.registerTool('fleet_task_review_show', {
    description: 'Read your task\'s To review package: its Markdown and the retained files attached to it.',
    inputSchema: {},
  }, async () => run(bound => {
    const review = getTaskReview(bound.taskId);
    return { task_id: bound.taskId, review: review ? publicReview(review) : null };
  }));

  server.registerTool('fleet_task_review_set', {
    description: 'Replace the Markdown of your task\'s To review package: the self-contained material the Owner reviews without reading the room or task description '
      + '(outcome, clickable PR/spec links, validation and CI, independent verdict, limits, decisions needed). '
      + 'Pass the Markdown you last read as expected_markdown ("" when empty); a concurrent change is refused instead of overwritten.',
    inputSchema: {
      markdown: z.string().describe(`Review Markdown (max ${REVIEW_MARKDOWN_MAX} characters). Links use the same safe rules as task descriptions.`),
      expected_markdown: z.string().describe('The current Markdown as you last read it, or "" if there is none.'),
    },
  }, async args => run((bound, author) => ({
    task_id: bound.taskId,
    review: publicReview(setTaskReviewMarkdown(bound.taskId, { markdown: args.markdown, expectedMarkdown: args.expected_markdown, author })),
  })));

  server.registerTool('fleet_task_review_detach', {
    description: 'Remove one file from your task\'s To review package by artifact_id (from fleet_task_review_show).',
    inputSchema: { artifact_id: z.string() },
  }, async args => run((bound, author) => ({ task_id: bound.taskId, detached: detachTaskReviewArtifact(bound.taskId, args.artifact_id, { author }) })));
}
