import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { writeV2Fixture } from './v2-fixture.js';
import { RoomLayoutDefinitions, ABSENT_REVISION } from '../src/application/room-layout-definitions.js';
import { TaskLayouts, layoutDefinitionHash, taskBriefPath, taskScopedDefinition } from '../src/application/task-layouts.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { RoomLayoutService, layoutRunPath } from '../src/rooms-tasks/layout-service.js';
import { getTask } from '../src/rooms-tasks/task-state.js';

let root: string, config: string, layoutsDir: string, previous: string | undefined, previousUmask: number;
const LAYOUT = { version: 1, description: 'Two rooms', participants: { dev: { agent_template: 'Agent' }, qa: { agent_template: 'Agent' } },
  rooms: { design: { goal: 'Design it', members: ['dev', 'qa'], contract: 'Agree first' }, delivery: { goal: 'Ship it', members: ['dev'] } } };

beforeEach(() => {
  previousUmask = process.umask(0o022);
  previous = process.env.OURS_FLEET_HOME;
  root = mkdtempSync(join(tmpdir(), 'task-layouts-')); process.env.OURS_FLEET_HOME = root;
  config = join(root, 'fleet.yaml');
  writeV2Fixture(config, { roles: {}, rooms: { owner: { expected_cid: '0'.repeat(64) }, defaults: { attach_owner: false } } });
  layoutsDir = join(root, 'fleet', 'room_layouts'); mkdirSync(layoutsDir, { mode: 0o700 });
});
afterEach(() => {
  if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous;
  rmSync(root, { recursive: true, force: true });
  process.umask(previousUmask);
});
const writeLayout = (name: string, body: unknown = LAYOUT) =>
  writeFileSync(join(layoutsDir, `${name}.yaml`), typeof body === 'string' ? body : stringify(body), { mode: 0o600 });

describe('room layout definitions (web authoring)', () => {
  it('creates, lists, conflicts on stale revisions and deletes', async () => {
    const defs = new RoomLayoutDefinitions(config);
    const saved = await defs.save('work', ABSENT_REVISION, LAYOUT);
    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
    const [entry] = defs.list();
    expect(entry).toMatchObject({ name: 'work', revision: saved.revision, issues: [] });
    expect('definition' in entry && entry.definition.rooms.design.members).toEqual(['dev', 'qa']);
    await expect(defs.save('work', ABSENT_REVISION, LAYOUT)).rejects.toThrow(/changed since it was loaded/);
    await expect(defs.remove('work', 'f'.repeat(64))).rejects.toThrow(/changed since it was loaded/);
    expect(await defs.remove('work', saved.revision)).toEqual({ name: 'work', deleted: true });
    expect(defs.list()).toEqual([]);
  });

  it('rejects invalid definitions, bad names and unknown agent templates before writing', async () => {
    const defs = new RoomLayoutDefinitions(config);
    await expect(defs.save('work', ABSENT_REVISION, { ...LAYOUT, rooms: { a: { goal: 'x', members: ['ghost'] } } })).rejects.toThrow(/unknown participant/);
    await expect(defs.save('../escape', ABSENT_REVISION, LAYOUT)).rejects.toThrow(/layout name/);
    await expect(defs.save('work', ABSENT_REVISION, { ...LAYOUT, participants: { dev: { agent_template: 'Missing' }, qa: { agent_template: 'Agent' } } }))
      .rejects.toThrow(/agent template not found: Missing/);
    expect(existsSync(join(layoutsDir, 'work.yaml'))).toBe(false);
    expect(defs.validate({ version: 2 }).issues[0]).toMatch(/version must be 1|unknown field|mapping/);
  });

  it('reports a broken file per entry and never reads untrusted entries', async () => {
    writeLayout('good');
    writeLayout('broken', 'invalid: [');
    writeFileSync(join(root, 'elsewhere.yaml'), stringify(LAYOUT));
    symlinkSync(join(root, 'elsewhere.yaml'), join(layoutsDir, 'linked.yaml'));
    execFileSync('mkfifo', [join(layoutsDir, 'pipe.yaml')]);
    const entries = Object.fromEntries(new RoomLayoutDefinitions(config).list().map(entry => [entry.name, entry]));
    expect(entries.good).toMatchObject({ issues: [] });
    expect(entries.broken).toMatchObject({ error: expect.any(String) });
    expect(entries.broken.revision).toMatch(/^[0-9a-f]{64}$/);
    // Would block forever if the FIFO were opened; symlink is never followed.
    expect(entries.pipe).toMatchObject({ revision: ABSENT_REVISION, error: expect.stringMatching(/untrusted/) });
    expect(entries.linked).toMatchObject({ revision: ABSENT_REVISION, error: expect.stringMatching(/untrusted/) });
  });

  it('lets a valid layout resolve while an unrelated sibling is broken', () => {
    writeLayout('good');
    writeLayout('broken', 'invalid: [');
    expect(new RoomLayoutService(config).definition('good').rooms.delivery.goal).toBe('Ship it');
    expect(() => new RoomLayoutService(config).definition('broken')).toThrow();
    expect(() => new RoomLayoutService(config).definition('absent')).toThrow(/not found/);
  });
});

describe('task-scoped layout snapshots', () => {
  it('hashes only the authorable source and scopes contracts to the task brief file', () => {
    writeLayout('work');
    const source = new RoomLayoutService(config).definition('work');
    const hash = layoutDefinitionHash(source);
    expect(layoutDefinitionHash({ ...source, sourceFile: '/elsewhere.yaml' })).toBe(hash);
    const task = { task_id: '000000000aaaaaaaa', title: 'Ship', brief: 'Original brief',
      workspace: { version: 1 as const, owner: 'task' as const, id: 'x', path: '/work/space', token: 't' } };
    const scoped = taskScopedDefinition(structuredClone(source), task);
    expect(scoped.rooms.design.contract).toContain(`Current task brief: ${taskBriefPath(task)}`);
    expect(taskBriefPath(task)).toMatch(/\/layouts\/task-000000000aaaaaaaa\.brief\.md$/);
    expect(scoped.rooms.design.contract).toContain('Room contract:\nAgree first');
    expect(scoped.rooms.design.contract).not.toContain('Original brief');
    expect(layoutDefinitionHash(scoped)).not.toBe(hash);
    expect(layoutDefinitionHash(source)).toBe(hash); // the source is not mutated
  });
});

describe('layout tasks', () => {
  const launches: string[][] = [];
  const service = () => new TaskRoomApplicationService(config, {
    taskLayouts: new TaskLayouts(config, { launch: async args => { launches.push(args); } }),
  });
  const actor = { kind: 'local_control' as const, surface: 'web' as const };
  beforeEach(() => { launches.length = 0; writeLayout('work'); });

  it('creates an active task with a task-scoped run and a sanitized read model', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Ship', brief: 'Do it', layout: 'work', origin: { type: 'web' } });
    expect(task.state).toBe('active');
    expect(task.layout).toEqual({ name: 'work', run_id: `task-${task.task_id}`,
      definition_hash: layoutDefinitionHash(new RoomLayoutService(config).definition('work')) });
    expect(task.room_id).toBeUndefined();
    const run = JSON.parse(readFileSync(layoutRunPath(task.layout!.run_id), 'utf8'));
    expect(run.definition.rooms.delivery.contract).toContain(`Task ${task.task_id}: Ship`);
    expect(run.agent_templates.Agent.cwd).toBe(task.workspace!.path);
    expect(readFileSync(taskBriefPath(task)!, 'utf8')).toContain('Do it');
    const view = app.taskLayout(task.task_id);
    expect(view.rooms.map(room => [room.key, room.state])).toEqual([['design', 'declared'], ['delivery', 'declared']]);
    expect(JSON.stringify(view)).not.toMatch(/agent_templates|fingerprint|session|launch/);
    expect(app.taskProvisioningOutcome(task.task_id).kind).toBe('ready');
  });

  it('keeps backlog tasks run-free until start, then snapshots the unchanged source', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Later', layout: 'work', backlog: true, origin: { type: 'web' } });
    expect(task.state).toBe('backlog');
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(false);
    const started = await app.startTask({ actor, taskId: task.task_id });
    expect(started.state).toBe('active');
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(true);
  });

  it('blocks rather than silently snapshotting a layout edited before run creation', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Later', layout: 'work', backlog: true, origin: { type: 'web' } });
    writeLayout('work', { ...LAYOUT, description: 'Edited' });
    await expect(app.startTask({ actor, taskId: task.task_id })).rejects.toThrow(/changed before this task's layout run was created/);
    const current = getTask(task.task_id);
    expect(current.state).toBe('provisioning');
    expect(current.blocked?.reason).toMatch(/layout run could not be created/);
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(false);
  });

  it('includes the selected layout in idempotency and rejects mixed task modes', async () => {
    const app = service();
    writeLayout('other', { ...LAYOUT, description: 'Other' });
    const first = await app.createTask({ actor, title: 'Once', layout: 'work', idempotencyKey: 'k1', origin: { type: 'web' } });
    const again = await app.createTask({ actor, title: 'Once', layout: 'work', idempotencyKey: 'k1', origin: { type: 'web' } });
    expect(again.task_id).toBe(first.task_id);
    await expect(app.createTask({ actor, title: 'Once', layout: 'other', idempotencyKey: 'k1', origin: { type: 'web' } }))
      .rejects.toThrow(/different execution plan/);
    await expect(app.createTask({ actor, title: 'Mixed', layout: 'work', noRoom: true, origin: { type: 'web' } }))
      .rejects.toThrow(/cannot be combined/);
    await expect(app.createTask({ actor, title: 'Missing', layout: 'absent', origin: { type: 'web' } })).rejects.toThrow(/not found/);
  });

  it('launches room operations as workers, guards state and records worker failures', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    const accepted = await app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design' });
    expect(accepted).toMatchObject({ operation: 'open', room: 'design', status: 'launching' });
    expect(launches).toEqual([['task', '_layout', task.task_id, 'open', 'design', '--operation-id', accepted.id]]);
    await expect(app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'delivery' }))
      .rejects.toThrow(/already in progress/);
    await expect(app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'close-room', room: 'nope' }))
      .rejects.toThrow(/unknown layout room/);
    const backlog = await app.createTask({ actor, title: 'Later', layout: 'work', backlog: true, origin: { type: 'web' } });
    await expect(app.launchTaskLayoutOperation({ actor, taskId: backlog.task_id, operation: 'open', room: 'design' }))
      .rejects.toThrow(/start the task before opening rooms/);
    const failing = new TaskRoomApplicationService(config, {
      taskLayouts: new TaskLayouts(config, { launch: async () => { throw Error('no systemd'); } }) });
    const other = await failing.createTask({ actor, title: 'Fail', layout: 'work', origin: { type: 'web' } });
    await expect(failing.launchTaskLayoutOperation({ actor, taskId: other.task_id, operation: 'open', room: 'design' })).rejects.toThrow(/no systemd/);
    expect(failing.taskLayout(other.task_id).operation).toMatchObject({ status: 'failed', error: expect.stringMatching(/worker failed to start/) });
  });

  it('closes the run when cancelled, and even while an open is still in progress', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    await app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design' });
    const plan = await app.cancelTask({ actor, taskId: task.task_id });
    expect(plan.task.state).toBe('cancelled');
    expect(launches.at(-1)?.slice(0, 4)).toEqual(['task', '_layout', task.task_id, 'close']);
    await expect(app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design' })).rejects.toThrow(/closing/);
    await expect(app.runTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design' })).rejects.toThrow(/closing or closed/);
    // The close worker itself: nothing was opened, so the run closes cleanly.
    const view = await app.runTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'close' });
    expect(view).toMatchObject({ closed: true, operation: { operation: 'close', status: 'succeeded' } });
  });

  it('rewrites the brief file on description edits so later rooms read the current brief', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Ship', brief: 'v1', layout: 'work', origin: { type: 'web' } });
    app.editTaskDescription({ actor, taskId: task.task_id, brief: 'v2', expectedBrief: 'v1' });
    expect(readFileSync(taskBriefPath(task)!, 'utf8')).toContain('v2');
  });

  it('closes and forgets the run before task deletion completes', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    await app.requestTaskDeletion({ actor, taskId: task.task_id });
    const closeAndForget = vi.spyOn(TaskLayouts.prototype, 'closeAndForget');
    const result = await app.settleTaskDeletion({ actor: { kind: 'internal_worker', surface: 'cli' }, taskId: task.task_id });
    expect(result.deleted).toBe(true);
    expect(closeAndForget).toHaveBeenCalledOnce();
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(false);
  });

  it('keeps deletion pending when layout cleanup fails', async () => {
    const app = service();
    const task = await app.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    await app.requestTaskDeletion({ actor, taskId: task.task_id });
    vi.spyOn(TaskLayouts.prototype, 'closeAndForget').mockRejectedValueOnce(Error('cleanup incomplete'));
    await expect(app.settleTaskDeletion({ actor: { kind: 'internal_worker', surface: 'cli' }, taskId: task.task_id })).rejects.toThrow(/cleanup incomplete/);
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(true);
  });
});

it('summarizes layout rooms for task listings without exposing run internals', async () => {
  writeLayout('work');
  const app = new TaskRoomApplicationService(config, { taskLayouts: new TaskLayouts(config, { launch: async () => {} }) });
  const task = await app.createTask({ actor: { kind: 'local_control', surface: 'web' }, title: 'Ship', layout: 'work', origin: { type: 'web' } });
  expect(app.withLayoutRooms(task).layout_rooms).toEqual([{ key: 'design', state: 'declared' }, { key: 'delivery', state: 'declared' }]);
  expect(app.getTask(task.task_id).task.layout_rooms).toHaveLength(2);
  rmSync(layoutRunPath(task.layout!.run_id));
  writeFileSync(layoutRunPath(task.layout!.run_id), 'not json', { mode: 0o600 });
  expect(app.withLayoutRooms(task).layout_rooms).toEqual([]);
});

describe('layout task races and worker boundaries', () => {
  const actor = { kind: 'local_control' as const, surface: 'web' as const };
  const worker = { kind: 'internal_worker' as const, surface: 'cli' as const };
  const app = () => new TaskRoomApplicationService(config, { taskLayouts: new TaskLayouts(config, { launch: async () => {} }) });
  beforeEach(() => writeLayout('work'));

  it('refuses a run file that does not carry this task\'s provenance', async () => {
    const a = app();
    const first = await a.createTask({ actor, title: 'One', layout: 'work', origin: { type: 'web' } });
    const second = await a.createTask({ actor, title: 'Two', layout: 'work', backlog: true, origin: { type: 'web' } });
    // Plant the first task's run under the second task's run ID.
    writeFileSync(layoutRunPath(second.layout!.run_id), readFileSync(layoutRunPath(first.layout!.run_id)), { mode: 0o600 });
    await expect(a.startTask({ actor, taskId: second.task_id })).rejects.toThrow(/does not match this task's pinned layout/);
  });

  it('snapshots the verified source even if the file changes during creation', async () => {
    const a = app();
    const task = await a.createTask({ actor, title: 'Later', layout: 'work', backlog: true, origin: { type: 'web' } });
    const definition = RoomLayoutService.prototype.definition;
    const spy = vi.spyOn(RoomLayoutService.prototype, 'definition').mockImplementationOnce(function (this: RoomLayoutService, name: string) {
      const verified = definition.call(this, name);
      writeLayout('work', { ...LAYOUT, description: 'Edited during creation' });
      return verified;
    });
    await a.startTask({ actor, taskId: task.task_id });
    spy.mockRestore();
    const run = JSON.parse(readFileSync(layoutRunPath(task.layout!.run_id), 'utf8'));
    expect(run.definition.description).toBe('Two rooms');
  });

  it('serializes concurrent launches so only one open is accepted', async () => {
    const a = app();
    const task = await a.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    const results = await Promise.allSettled(['design', 'delivery'].map(room =>
      a.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason))).toEqual([expect.stringMatching(/already in progress/)]);
  });

  it('enforces open preconditions inside the directly callable worker', async () => {
    const a = app();
    const backlog = await a.createTask({ actor, title: 'Later', layout: 'work', backlog: true, origin: { type: 'web' } });
    await expect(a.runTaskLayoutOperation({ actor: worker, taskId: backlog.task_id, operation: 'open', room: 'design' })).rejects.toThrow(/start the task/);
    expect(existsSync(layoutRunPath(backlog.layout!.run_id))).toBe(false);
    const deleting = await a.createTask({ actor, title: 'Gone', layout: 'work', origin: { type: 'web' } });
    await a.requestTaskDeletion({ actor, taskId: deleting.task_id });
    await expect(a.runTaskLayoutOperation({ actor: worker, taskId: deleting.task_id, operation: 'open', room: 'design' })).rejects.toThrow(/being deleted/);
  });

  it('does not recreate a run removed by deletion when a stale open worker proceeds', async () => {
    const layouts = new TaskLayouts(config, { launch: async () => {} });
    const a = new TaskRoomApplicationService(config, { taskLayouts: layouts });
    const task = await a.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    await layouts.closeAndForget(task);           // deletion cleanup wins the race
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(false);
    await a.requestTaskDeletion({ actor, taskId: task.task_id });
    // The worker admitted earlier now runs: it re-reads the task under the lock and refuses.
    await expect(layouts.run(getTask(task.task_id), 'open', 'design')).rejects.toThrow(/being deleted/);
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(false);
  });

  it('keeps the brief outside the agent-writable workspace', async () => {
    const task = await app().createTask({ actor, title: 'Ship', brief: 'secret plan', layout: 'work', origin: { type: 'web' } });
    expect(taskBriefPath(task).startsWith(task.workspace!.path)).toBe(false);
    expect(existsSync(join(task.workspace!.path, '.ours-task'))).toBe(false);
  });
});

describe('operation status ownership', () => {
  const actor = { kind: 'local_control' as const, surface: 'web' as const };
  beforeEach(() => writeLayout('work'));

  it('never lets a superseded open worker overwrite the terminal close status', async () => {
    const launches: string[][] = [];
    const layouts = new TaskLayouts(config, { launch: async args => { launches.push(args); } });
    const app = new TaskRoomApplicationService(config, { taskLayouts: layouts });
    const task = await app.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    const open = await app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design' });
    await app.cancelTask({ actor, taskId: task.task_id });
    const closeId = launches.at(-1)!.at(-1)!;
    expect(closeId).not.toBe(open.id);
    // The admitted open worker runs late and fails its preconditions; its status write is discarded.
    await expect(app.runTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design', operationId: open.id })).rejects.toThrow();
    expect(layouts.readOperation(task.layout!.run_id)).toMatchObject({ id: closeId, operation: 'close', status: 'launching' });
    await app.runTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'close', operationId: closeId });
    expect(layouts.readOperation(task.layout!.run_id)).toMatchObject({ id: closeId, status: 'succeeded' });
  });

  it('does not resurrect an operation record removed by deletion', async () => {
    const layouts = new TaskLayouts(config, { launch: async () => {} });
    const app = new TaskRoomApplicationService(config, { taskLayouts: layouts });
    const task = await app.createTask({ actor, title: 'Ship', layout: 'work', origin: { type: 'web' } });
    const open = await app.launchTaskLayoutOperation({ actor, taskId: task.task_id, operation: 'open', room: 'design' });
    await app.requestTaskDeletion({ actor, taskId: task.task_id });
    await layouts.closeAndForget(task);
    await expect(layouts.run(getTask(task.task_id), 'open', 'design', open.id)).rejects.toThrow(/being deleted/);
    expect(layouts.readOperation(task.layout!.run_id)).toBeUndefined();
    expect(existsSync(layoutRunPath(task.layout!.run_id))).toBe(false);
  });
});
