import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  acknowledgeTaskProgress, acknowledgeTaskReview, beginTaskDeletionIntent, contributionUnread, createTask, getTask, tasksDir,
} from '../src/rooms-tasks/task-state.js';
import { appendTaskProgress, setTaskReviewMarkdown } from '../src/rooms-tasks/task-review.js';
import { listTaskContributions, readTaskContributions } from '../src/rooms-tasks/task-contributions.js';

const author = { kind: 'agent', role: 'dev-1', surface: 'mcp' } as const;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OURS_FLEET_HOME;
  mkdirSync('.test-artifacts', { recursive: true });
  process.env.OURS_FLEET_HOME = mkdtempSync(join('.test-artifacts', 'task-contributions-'));
});
afterEach(() => { if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous; });
const create = (title = 'Mission') => createTask({ title, origin: { type: 'cli' }, start: false });
const progress = (id: string, text: string) => appendTaskProgress(id, { text, author }).entry;
const review = (id: string, markdown: string) =>
  setTaskReviewMarkdown(id, { markdown, expectedMarkdown: getTask(id).review?.markdown ?? '', author });
const file = (id: string) => join(tasksDir(), `${id}.json`);
const all = (unread = false) => {
  const items = [];
  let page = listTaskContributions({ limit: 2, unread });
  items.push(...page.items);
  while (page.next_cursor) { page = listTaskContributions({ limit: 2, unread, before: page.next_cursor }); items.push(...page.items); }
  return items;
};

it('lists Progress and the current To review revision of every task newest first, with canonical read state', () => {
  const a = create('Alpha'), b = create('Beta');
  const first = progress(a.task_id, 'first   milestone\nline');
  review(b.task_id, '# Ready\n\nbody');
  const second = progress(a.task_id, 'second');
  acknowledgeTaskProgress(a.task_id, [first.id]);
  const items = all();
  expect(items.map(item => item.id)).toEqual([`p:${a.task_id}:${second.id}`, `r:${b.task_id}:1`, `p:${a.task_id}:${first.id}`]);
  expect(items[0]).toMatchObject({ kind: 'progress', task_id: a.task_id, mission_key: getTask(a.task_id).key, task_title: 'Alpha', excerpt: 'second', unread: true, entry_id: second.id });
  expect(items[1]).toMatchObject({ kind: 'review', task_title: 'Beta', excerpt: 'Ready', unread: true, revision: 1 });
  expect(items[2]).toMatchObject({ excerpt: 'first milestone line', unread: false });
  expect(listTaskContributions().unread_total).toBe(contributionUnread(getTask(a.task_id)).progress + 1);
  // The unread filter covers every page and task; a read row leaves it.
  expect(all(true).map(item => item.id)).toEqual([`p:${a.task_id}:${second.id}`, `r:${b.task_id}:1`]);
  // A new revision is a new item at the top; the older revision is gone.
  review(b.task_id, 'Second package');
  expect(all()[0]).toMatchObject({ id: `r:${b.task_id}:2`, excerpt: 'Second package' });
  expect(all().filter(item => item.kind === 'review')).toHaveLength(1);
});

it('a cursor is a position: it survives its own item being read or filtered out', () => {
  const task = create();
  const entries = ['one', 'two', 'three', 'four'].map(text => progress(task.task_id, text));
  const first = listTaskContributions({ limit: 2, unread: true });
  expect(first.items.map(item => item.entry_id)).toEqual([entries[3].id, entries[2].id]);
  acknowledgeTaskProgress(task.task_id, [entries[2].id, entries[3].id]);
  const next = listTaskContributions({ limit: 2, unread: true, before: first.next_cursor! });
  expect(next.items.map(item => item.entry_id)).toEqual([entries[1].id, entries[0].id]);
  expect(() => listTaskContributions({ before: 'not-a-cursor' })).toThrow('invalid cursor');
  expect(() => listTaskContributions({ limit: 101 })).toThrow();
});

it('the bulk read acknowledges exactly the captured cutoff: later appends and review revisions stay unread', () => {
  const a = create('Alpha'), b = create('Beta'), quiet = create('Quiet');
  progress(a.task_id, 'one'); progress(a.task_id, 'two');
  review(b.task_id, 'v1');
  const { cutoff } = listTaskContributions({ limit: 1 });
  expect(cutoff.map(item => item.task_id).sort()).toEqual([a.task_id, b.task_id].sort());
  expect(cutoff.some(item => item.task_id === quiet.task_id)).toBe(false);
  // Arrivals after the capture, including a review edit before its row was ever paged to.
  const late = progress(a.task_id, 'late');
  review(b.task_id, 'v2');
  const results = readTaskContributions(cutoff);
  expect(results).toEqual(expect.arrayContaining([
    { task_id: a.task_id, status: 'read', read: 2 }, { task_id: b.task_id, status: 'read', read: 1 },
  ]));
  expect(all(true).map(item => item.id).sort()).toEqual([`p:${a.task_id}:${late.id}`, `r:${b.task_id}:2`].sort());
  // Repeating the same cutoff changes nothing more.
  expect(readTaskContributions(cutoff).every(result => result.status === 'read' && result.read === 0)).toBe(true);
});

it('a cutoff that no longer matches its task, or names a revision it never had, reads nothing for that task only', () => {
  const a = create('Alpha'), b = create('Beta');
  const entry = progress(a.task_id, 'one');
  review(b.task_id, 'v1');
  expect(readTaskContributions([
    { task_id: a.task_id, progress: 1, progress_last: 'someone-else', review: 0 },
    { task_id: b.task_id, progress: 0, progress_last: null, review: 2 },
  ])).toEqual([{ task_id: a.task_id, status: 'changed' }, { task_id: b.task_id, status: 'changed' }]);
  expect(readTaskContributions([{ task_id: a.task_id, progress: 2, progress_last: null, review: 0 }])).toEqual([{ task_id: a.task_id, status: 'changed' }]);
  expect(contributionUnread(getTask(a.task_id))).toEqual({ progress: 1, review: false });
  expect(contributionUnread(getTask(b.task_id))).toEqual({ progress: 0, review: true });
  expect(readTaskContributions([{ task_id: a.task_id, progress: 1, progress_last: entry.id, review: 0 }])).toEqual([{ task_id: a.task_id, status: 'read', read: 1 }]);
  // An older acknowledgement never clears a newer revision, through either route.
  review(b.task_id, 'v2');
  expect(readTaskContributions([{ task_id: b.task_id, progress: 0, progress_last: null, review: 1 }])).toEqual([{ task_id: b.task_id, status: 'read', read: 1 }]);
  expect(contributionUnread(getTask(b.task_id)).review).toBe(true);
  expect(acknowledgeTaskReview(b.task_id, 2).review).toBe(false);
});

it('a task pending deletion or deleted lists nothing, counts nothing and is reported, without blocking other tasks', () => {
  const doomed = create('Doomed'), gone = create('Gone'), kept = create('Kept');
  for (const task of [doomed, gone, kept]) progress(task.task_id, 'entry');
  const { cutoff } = listTaskContributions();
  expect(listTaskContributions().unread_total).toBe(3);
  beginTaskDeletionIntent(doomed.task_id, { kind: 'local_control', surface: 'cli' });
  rmSync(file(gone.task_id));
  const page = listTaskContributions();
  expect(page.items.map(item => item.task_title)).toEqual(['Kept']);
  expect(page.unread_total).toBe(1);
  expect(readTaskContributions(cutoff)).toEqual(expect.arrayContaining([
    { task_id: doomed.task_id, status: 'deleting' }, { task_id: gone.task_id, status: 'gone' },
    { task_id: kept.task_id, status: 'read', read: 1 },
  ]));
});

it('completed and pre-upgrade tasks are listed with their saved state; the retained projection follows every record change', () => {
  const task = create();
  const old = progress(task.task_id, 'before upgrade');
  // An earlier release stored no read state: everything it had counts as read.
  const record = JSON.parse(readFileSync(file(task.task_id), 'utf8')); delete record.contribution_reads; record.state = 'done';
  writeFileSync(file(task.task_id), JSON.stringify(record));
  expect(all()).toEqual([expect.objectContaining({ entry_id: old.id, unread: false, task_state: 'done' })]);
  expect(listTaskContributions().unread_total).toBe(0);
  // Same size, rewritten in place: still observed.
  const same = JSON.parse(readFileSync(file(task.task_id), 'utf8')); same.title = 'Renamed!'.slice(0, record.title.length).padEnd(record.title.length, 'x');
  writeFileSync(file(task.task_id), JSON.stringify(same));
  expect(all()[0].task_title).toBe(same.title);
  // The first later change snapshots older entries read; only the new one is unread.
  const fresh = progress(task.task_id, 'after upgrade');
  expect(all(true).map(item => item.entry_id)).toEqual([fresh.id]);
  // A corrupt record is counted as unavailable, never as read or empty.
  writeFileSync(file(task.task_id), '{');
  expect(listTaskContributions()).toMatchObject({ items: [], unavailable: 1 });
});

it('serves the list and the bulk read only to an authenticated session, with the cutoff on the first page', async () => {
  const { buildWebServer } = await import('../src/web/server.js');
  const { WebAuth } = await import('../src/web/auth.js');
  const { TrustedDeviceStore } = await import('../src/web/device-store.js');
  const { TaskRoomApplicationService } = await import('../src/application/task-room-service.js');
  const task = create();
  const entries = ['one', 'two', 'three'].map(text => progress(task.task_id, text));
  const boundary = { origin: 'http://127.0.0.1:49273', host: '127.0.0.1:49273' };
  const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(join(process.env.OURS_FLEET_HOME!, 'auth')));
  const server = await buildWebServer({ taskRooms: new TaskRoomApplicationService(undefined) } as any, boundary, { auth });
  try {
    const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
    const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
    const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': exchange.json().csrfToken };
    const anonymous = { host: boundary.host, origin: boundary.origin };
    const get = (url: string, h: Record<string, string> = headers) => server.app.inject({ method: 'GET', url, headers: h });
    const read = (payload: unknown, h: Record<string, string> = headers) => server.app.inject({ method: 'POST', url: '/api/v1/contributions/read', headers: h, payload: payload as any });

    expect((await get('/api/v1/contributions', anonymous)).statusCode).toBe(401);
    const first = (await get('/api/v1/contributions?limit=2&unread=true')).json();
    expect(first).toMatchObject({ unread_total: 3, unavailable: 0, cutoff: [{ task_id: task.task_id, progress: 3, progress_last: entries[2].id, review: 0 }] });
    expect(first.items.map((item: any) => item.entry_id)).toEqual([entries[2].id, entries[1].id]);
    const second = (await get(`/api/v1/contributions?limit=2&unread=true&before=${first.next_cursor}`)).json();
    expect(second).not.toHaveProperty('cutoff');
    expect(second.items.map((item: any) => item.entry_id)).toEqual([entries[0].id]);
    for (const bad of ['limit=0', 'limit=101', 'limit=x', 'unread=yes', 'before=%7B'])
      expect((await get(`/api/v1/contributions?${bad}`)).statusCode).toBe(400);

    expect((await read({ cutoff: first.cutoff }, { host: boundary.host, origin: boundary.origin, cookie })).statusCode).toBe(403);
    for (const bad of [{}, { cutoff: 'x' }, { cutoff: [{ ...first.cutoff[0], extra: 1 }] }, { cutoff: [first.cutoff[0], first.cutoff[0]] },
      { cutoff: Array.from({ length: 201 }, (_, i) => ({ task_id: `0aaaaaaaa${String(i).padStart(8, '0')}`, progress: 0, progress_last: null, review: 0 })) }])
      expect((await read(bad)).statusCode).toBe(400);
    progress(task.task_id, 'late');
    const done = await read({ cutoff: first.cutoff });
    expect(done.json()).toEqual({ results: [{ task_id: task.task_id, status: 'read', read: 3 }] });
    expect((await get('/api/v1/contributions?unread=true')).json()).toMatchObject({ unread_total: 1, items: [{ excerpt: 'late' }] });
    expect((await read({ cutoff: [{ task_id: 'nope', progress: 0, progress_last: null, review: 0 }] })).statusCode).toBe(400);
    const absent = '0aaaaaaaa00000000';
    expect((await read({ cutoff: [{ task_id: absent, progress: 0, progress_last: null, review: 0 }] })).json().results).toEqual([{ task_id: absent, status: 'gone' }]);
  } finally { await server.app.close(); }
}, 30_000);
