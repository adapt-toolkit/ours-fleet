/**
 * Progress entries and To review revisions of every task as one newest-first notification list,
 * with the canonical read state of each task record. Nothing is copied: the task records stay the
 * only read truth, and the per-task routes and the bulk read below change the same markers.
 *
 * The projection is retained in this process. Each request lists the task directory and stats each
 * record; only a record whose inode, size or time changed is read again (every write replaces the
 * file atomically). Room history and other services are never consulted.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acknowledgeTaskContributionsThrough, contributionUnread, getTask, reviewRevision, tasksDir, TaskStateError } from './task-state.js';
import { TaskReviewError } from './task-review.js';
import type { TaskRecord } from './types.js';

const TASK_FILE = /^([0-9a-z]{9}[0-9a-f]{8})\.json$/;
const EXCERPT_MAX = 200;
export const CONTRIBUTION_PAGE_MAX = 100;
export const CONTRIBUTION_CUTOFF_MAX = 200;

export interface ContributionItem {
  /** `p:<task>:<entry>` or `r:<task>:<revision>`: a new review revision is a new item. */
  id: string;
  kind: 'progress' | 'review';
  task_id: string;
  mission_key?: string;
  task_title: string;
  task_state: TaskRecord['state'];
  at: string;
  excerpt: string;
  unread: boolean;
  entry_id?: string;
  revision?: number;
}
/** What one task had when it was listed; the bulk read acknowledges nothing beyond it. */
export interface ContributionCutoff { task_id: string; progress: number; progress_last: string | null; review: number }

interface Projected { stamp: string; items: Array<ContributionItem & { order: number }>; unread: number; cutoff?: ContributionCutoff }
let cache: { dir: string; tasks: Map<string, Projected>; index?: Array<ContributionItem & { order: number }> } | undefined;

function excerpt(text: string): string {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  return points.length > EXCERPT_MAX ? points.slice(0, EXCERPT_MAX - 1).join('') + '…' : points.join('');
}
function reviewExcerpt(task: TaskRecord): string {
  const line = task.review?.markdown.split('\n').map(text => text.replace(/^\s*(?:#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)*/, '').trim()).find(Boolean);
  if (line) return excerpt(line);
  const files = task.review?.artifacts.length ?? 0;
  return files ? `${files} attached ${files === 1 ? 'file' : 'files'}` : 'The review request was cleared.';
}
const time = (at: string) => { const value = Date.parse(at); return Number.isFinite(value) ? value : 0; };

function project(task: TaskRecord, stamp: string): Projected {
  const base = {
    task_id: task.task_id, ...(task.key ? { mission_key: task.key } : {}), task_title: task.title, task_state: task.state,
  };
  const reads = task.contribution_reads, seen = new Set(reads?.progress_read);
  const items: Projected['items'] = (task.progress ?? []).map(entry => ({
    ...base, id: `p:${task.task_id}:${entry.id}`, kind: 'progress', at: entry.at, order: time(entry.at),
    excerpt: excerpt(entry.text), unread: !!reads && !seen.has(entry.id), entry_id: entry.id,
  }));
  const unread = contributionUnread(task);
  if (task.review) {
    const revision = reviewRevision(task.review);
    items.push({ ...base, id: `r:${task.task_id}:${revision}`, kind: 'review', at: task.review.updated_at,
      order: time(task.review.updated_at), excerpt: reviewExcerpt(task), unread: unread.review, revision });
  }
  const progress = task.progress ?? [];
  return { stamp, items, unread: unread.progress + (unread.review ? 1 : 0),
    ...(unread.progress || unread.review ? { cutoff: { task_id: task.task_id, progress: progress.length,
      progress_last: progress.at(-1)?.id ?? null, review: reviewRevision(task.review) } } : {}) };
}

/** Bring the retained projection up to date with the task directory; returns the tasks not readable now. */
function refresh(): number {
  const dir = tasksDir();
  if (cache?.dir !== dir) cache = { dir, tasks: new Map() };
  const current = cache;
  let names: string[];
  try { names = readdirSync(dir); } catch { names = []; }
  const present = new Set<string>();
  let unavailable = 0;
  for (const name of names) {
    const id = TASK_FILE.exec(name)?.[1];
    if (!id) continue;
    try {
      // Writes replace the record by rename: a new inode, and a change time in nanoseconds.
      const stat = statSync(join(dir, name), { bigint: true });
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      present.add(id);
      if (current.tasks.get(id)?.stamp === stamp) continue;
      const task = getTask(id);
      current.index = undefined;
      // A task pending deletion lists nothing and counts nothing.
      if (task.deletion?.status === 'pending') current.tasks.set(id, { stamp, items: [], unread: 0 });
      else current.tasks.set(id, project(task, stamp));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof TaskStateError && /not found/.test(error.message))) continue;
      present.add(id);
      unavailable++;
      if (current.tasks.delete(id)) current.index = undefined;
    }
  }
  for (const id of current.tasks.keys()) if (!present.has(id)) { current.tasks.delete(id); current.index = undefined; }
  return unavailable;
}

function index() {
  return cache!.index ??= [...cache!.tasks.values()].flatMap(task => task.items)
    .sort((a, b) => b.order - a.order || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function encodeCursor(item: { order: number; id: string }): string {
  return Buffer.from(JSON.stringify([item.order, item.id])).toString('base64url');
}
function decodeCursor(cursor: string): { order: number; id: string } {
  try {
    const [order, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof order === 'number' && Number.isFinite(order) && typeof id === 'string' && id.length <= 200) return { order, id };
  } catch { /* invalid below */ }
  throw new TaskReviewError('invalid_request', 'invalid cursor');
}

/**
 * One page, newest first. The cursor is a position, not an item: it stays valid when the item it
 * names is read, filtered out or deleted. `cutoff` lists every task with unread items as listed;
 * `unavailable` counts task records that could not be read.
 */
export function listTaskContributions(options: { before?: string; limit?: number; unread?: boolean } = {}): {
  items: ContributionItem[]; next_cursor: string | null; unread_total: number; cutoff: ContributionCutoff[]; unavailable: number;
} {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTRIBUTION_PAGE_MAX)
    throw new TaskReviewError('invalid_request', `limit must be 1-${CONTRIBUTION_PAGE_MAX}`);
  const after = options.before === undefined ? undefined : decodeCursor(options.before);
  const unavailable = refresh();
  const page: Array<ContributionItem & { order: number }> = [];
  let more = false;
  for (const item of index()) {
    if (after && (item.order > after.order || (item.order === after.order && item.id >= after.id))) continue;
    if (options.unread && !item.unread) continue;
    if (page.length === limit) { more = true; break; }
    page.push(item);
  }
  const tasks = [...cache!.tasks.values()];
  return {
    items: page.map(({ order: _order, ...item }) => item),
    next_cursor: more ? encodeCursor(page.at(-1)!) : null,
    unread_total: tasks.reduce((sum, task) => sum + task.unread, 0),
    cutoff: tasks.flatMap(task => task.cutoff ? [task.cutoff] : []),
    unavailable,
  };
}

export type ContributionReadResult = { task_id: string } & (
  { status: 'read'; read: number } | { status: 'changed' | 'gone' | 'deleting' });

/** Read every task of a captured cutoff up to that cutoff, each under its own lock; one task's outcome never blocks another. */
export function readTaskContributions(cutoff: ContributionCutoff[]): ContributionReadResult[] {
  return cutoff.map(({ task_id, progress, progress_last, review }) => {
    try {
      const read = acknowledgeTaskContributionsThrough(task_id, { progress, progressLast: progress_last, review });
      return read === 'changed' ? { task_id, status: 'changed' } : { task_id, status: 'read', read };
    } catch (error) {
      if (error instanceof TaskStateError && /pending deletion/.test(error.message)) return { task_id, status: 'deleting' };
      if (error instanceof TaskStateError && /not found/.test(error.message)) return { task_id, status: 'gone' };
      throw error;
    }
  });
}
