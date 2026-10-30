import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Seam: directory sync fails while `failSync` is set, as on a platform or disk that cannot make a rename durable.
const seam = vi.hoisted(() => ({ failSync: false, only: undefined as string | undefined, durableWrites: [] as string[] }));
vi.mock('../src/atomic-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/atomic-file.js')>();
  const failing = (dir: string) => { if (seam.failSync && (!seam.only || dir.endsWith(seam.only))) throw Object.assign(new Error(`fsync ${dir}: EIO`), { code: 'EIO' }); actual.fsyncDirectory(dir); };
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
vi.mock('../src/client-profile.js', () => ({ readClientProfile: () => ({ expectedInstanceId: 'shared-daemon' }) }));
vi.mock('../src/session/control.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/session/control.js')>(),
  controlRequest: vi.fn(async (_dir: string, request: any) => ({ ok: true,
    result: { supervisor: 'local', agent: request.layout.agent, launch: 'launch', cid: 'cid', session: 'session' } })) }));
vi.mock('../src/spawn.js', () => ({ spawnTemp: vi.fn(async () => {}) }));
const { allocateTaskMemberNames, createTask, migrateMissionKeysLocked } = await import('../src/rooms-tasks/task-state.js');
const { readMissionKeyRegistry } = await import('../src/rooms-tasks/mission-keys.js');
const { NativeLayoutSupervisor } = await import('../src/rooms-tasks/layout-service.js');
const { requestMemberAddition, memberAddition } = await import('../src/rooms-tasks/add-member.js');
const { spawnTemp } = await import('../src/spawn.js');
const { stateRoot } = await import('../src/paths.js');
const { EMPTY_TASK_LAYOUT, EMPTY_TASK_ROOM } = await import('../src/rooms-tasks/empty-layout.js');
const { loadConfig } = await import('../src/config.js');
const { writeV2Fixture } = await import('./v2-fixture.js');

let root: string, previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mission-durable-'));
  previousHome = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = root;
  seam.failSync = false; seam.only = undefined; seam.durableWrites = []; vi.mocked(spawnTemp).mockClear();
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

/** A keyed task whose row names a layout run, as task layout creation leaves it. */
function layoutTask(layoutName = 'work', state = 'backlog') {
  const task = createTask({ title: 'Layout durability', origin: { type: 'cli' }, start: false });
  const runId = `task-${task.task_id}`;
  const path = join(stateRoot(), 'tasks', `${task.task_id}.json`);
  const row = JSON.parse(readFileSync(path, 'utf8'));
  row.layout = { name: layoutName, run_id: runId, definition_hash: 'h' }; row.state = state;
  writeFileSync(path, JSON.stringify(row));
  return { task, runId, path };
}

it('a layout launch never spawns while its allocation is not known durable, first attempt or retry', async () => {
  const { task, runId, path } = layoutTask();
  const supervisor = new NativeLayoutSupervisor(undefined, runId, { Agent: {} as never });
  const labels = [{ label: 'Architect', source: 'template_ref' as const }];
  seam.failSync = true;
  await expect(supervisor.spawn('arch', 'Agent', undefined, labels)).rejects.toThrow(/EIO/);
  // The rename landed: the allocation is visible on the row, but not confirmed durable.
  expect(JSON.parse(readFileSync(path, 'utf8')).member_naming.allocations[`layout:${runId}:arch`].name).toBe(`${task.key}-Architect`);
  await expect(supervisor.spawn('arch', 'Agent', undefined, labels)).rejects.toThrow(/EIO/);
  expect(spawnTemp).not.toHaveBeenCalled();
  seam.failSync = false;
  await supervisor.spawn('arch', 'Agent', undefined, labels);
  expect(vi.mocked(spawnTemp).mock.calls.map(([options]) => options.name)).toEqual([`${task.key}-Architect`]);
  expect(JSON.parse(readFileSync(path, 'utf8')).member_naming.counters.architect).toBe(1);
});

it('an empty-layout member addition accepts nothing and launches nothing until its name is durable', async () => {
  const config = join(root, 'fleet.yaml');
  writeV2Fixture(config, {});
  const agent = { name: 'Coordinator', harness: 'codex', session: 'acp', identity: 'Coordinator', cwd: root, model: 'gpt-test',
    sourceFile: config, permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' }, permissionsDeclared: true };
  const cfg = { ...loadConfig(config), rolePresets: { Reviewer: { mission: 'Review' } }, brainPresets: { test: { harness: 'codex' } },
    resolveAgentDefinition: () => agent };
  const { task } = layoutTask(EMPTY_TASK_LAYOUT, 'active');
  const addMember = vi.fn(async () => {});
  const layouts = { view: () => ({ rooms: [{ key: EMPTY_TASK_ROOM, state: 'active' }], participants: [] }), addMember } as never;
  const input = { taskId: task.task_id, request: { requestId: 'durable-add-0001', slot: 'reviewer', role: 'Reviewer', brain: 'test', agentTemplate: 'Agent' },
    cfg: cfg as never, binPath: '/fleet', layouts };
  seam.failSync = true;
  await expect(requestMemberAddition(input)).rejects.toThrow(/EIO/);
  await expect(requestMemberAddition(input)).rejects.toThrow(/EIO/);
  expect(addMember).not.toHaveBeenCalled();
  expect(() => memberAddition(task.task_id, 'durable-add-0001')).toThrow(/not found/);
  seam.failSync = false;
  expect((await requestMemberAddition(input)).roleId).toBe(`${task.key}-Reviewer`);
  expect(addMember).toHaveBeenCalledTimes(1);
});

it('migration completes only after every repaired row is durable, also when a retry finds the row already keyed', () => {
  const task = createTask({ title: 'Old row', origin: { type: 'cli' }, start: false });
  const fleet = join(root, '.ours-fleet');
  const path = join(fleet, 'tasks', `${task.task_id}.json`);
  // As an earlier release wrote it.
  const row = JSON.parse(readFileSync(path, 'utf8'));
  delete row.key; delete row.member_naming; delete row.key_from_migration; writeFileSync(path, JSON.stringify(row));
  rmSync(join(fleet, 'mission-keys'), { recursive: true, force: true });
  // Only the tasks directory cannot be synced: the registry, receipt and ledger are durable.
  seam.failSync = true; seam.only = '/tasks';
  expect(() => migrateMissionKeysLocked()).toThrow(/tasks: EIO/);
  expect(readMissionKeyRegistry()?.keys_migrated).toBeFalsy();
  // The keyed row is visible now, so a retry has nothing to rewrite, yet it must still confirm the directory.
  expect(JSON.parse(readFileSync(path, 'utf8')).key).toBe('MSN-1');
  expect(() => migrateMissionKeysLocked()).toThrow(/tasks: EIO/);
  expect(readMissionKeyRegistry()?.keys_migrated).toBeFalsy();
  seam.failSync = false;
  migrateMissionKeysLocked();
  expect(readMissionKeyRegistry()?.keys_migrated).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8')).key).toBe('MSN-1');
});
