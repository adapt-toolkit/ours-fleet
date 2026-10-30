import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Seam: directory sync fails while `failSync` is set, as on a platform or disk that cannot make a rename durable.
const seam = vi.hoisted(() => ({ failSync: false, durableWrites: [] as string[] }));
vi.mock('../src/atomic-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/atomic-file.js')>();
  const failing = (dir: string) => { if (seam.failSync) throw Object.assign(new Error(`fsync ${dir}: EIO`), { code: 'EIO' }); actual.fsyncDirectory(dir); };
  return {
    ...actual,
    fsyncDirectory: failing,
    replaceFileAtomically: (...args: Parameters<typeof actual.replaceFileAtomically>) => {
      const [path, contents, mode, deps, options] = args;
      if (options?.durable) seam.durableWrites.push(path);
      return actual.replaceFileAtomically(path, contents, mode, { ...deps, fsyncDirectory: failing }, options);
    },
  };
});
const { allocateTaskMemberNames, createTask } = await import('../src/rooms-tasks/task-state.js');

let root: string, previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mission-durable-'));
  previousHome = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = root;
  seam.failSync = false; seam.durableWrites = [];
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const request = (allocationKey: string) => ({ allocationKey, candidates: [{ label: 'Developer', source: 'room_role' as const }] });

it('persists a new role ordinal durably and fails before launch when the directory sync fails', () => {
  const task = createTask({ title: 'Durable names', origin: { type: 'cli' }, start: false });
  const row = join(root, '.ours-fleet', 'tasks', `${task.task_id}.json`);
  seam.durableWrites = [];
  expect(allocateTaskMemberNames(task.task_id, [request('initial:developer:1')])).toEqual(['MSN-1-Developer']);
  expect(seam.durableWrites).toEqual([row]);

  seam.failSync = true;
  const launched: string[] = [];
  const attempt = () => { const names = allocateTaskMemberNames(task.task_id, [request('add:second')]); launched.push(...names!); };
  expect(attempt).toThrow(/EIO/);
  expect(launched).toEqual([]);
  // The rename landed but is not known durable: a retry while the sync still fails also refuses to launch.
  expect(attempt).toThrow(/EIO/);
  expect(launched).toEqual([]);

  seam.failSync = false;
  attempt();
  expect(launched).toEqual(['MSN-1-Developer-2']);
  expect(JSON.parse(readFileSync(row, 'utf8')).member_naming.counters.developer).toBe(2);
});
