/**
 * Explicit removal of a Done task's working folder. Every fixture lives in a
 * disposable OURS_FLEET_HOME; the outside directories that must survive are
 * siblings inside the same temporary root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { stateRoot, tmpRoot } from '../src/paths.js';
import {
  activateTask, cancelTask, completeTask, createTask, getTask, reviewTask, tasksDir, beginTaskTerminalIntent,
} from '../src/rooms-tasks/task-state.js';
import { createRoomRecord } from '../src/rooms-tasks/room-state.js';
import { acceptTaskDeletion, settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { assertCwdNotInRemovedTaskFolder, processesUsing, reaches, userManagerUse, removeTaskWorkspace, workingFilesSummary } from '../src/rooms-tasks/workspace-removal.js';
import { spawnTemp } from '../src/spawn.js';
import { writeV2Fixture } from './v2-fixture.js';
import {
  appendTaskProgress, attachTaskReviewArtifact, openTaskWorkspaceFile, readTaskReviewArtifact, setTaskReviewMarkdown,
} from '../src/rooms-tasks/task-review.js';
import { registerMember } from '../src/supervisor/catalog.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { buildWebServer } from '../src/web/server.js';
import { WebAuth } from '../src/web/auth.js';
import { TrustedDeviceStore } from '../src/web/device-store.js';

let root: string;
let oldHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-removal-'));
  oldHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

const actor = { kind: 'local_control', surface: 'web' } as const;
const author = { kind: 'local_control', surface: 'cli' } as const;
/**
 * The real process check, with uncertainty limited to this test's own children: a
 * developer or CI host has unrelated unreadable processes (containers, a user manager)
 * that strict removal rightly refuses on, but they are not this suite's fixtures.
 * Proven use is never filtered.
 */
const fixturePids = new Set<string>();
const deps = {
  permanentCwds: [] as string[],
  processesUsing: (path: string, context: Parameters<typeof processesUsing>[1]) => {
    const use = processesUsing(path, context);
    return { users: use.users, unverified: use.unverified.filter(entry => fixturePids.has(entry.token.split(':')[0])) };
  },
};
const cowork = { closeRoom: async () => {}, deleteRoom: async () => {} };

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repo(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial');
}
function doneTask(title = 'work') {
  const t = createTask({ title, brief: 'keep this description', origin: { type: 'cli' } });
  activateTask(t.task_id); reviewTask(t.task_id); completeTask(t.task_id);
  return getTask(t.task_id);
}
function patchTask(id: string, change: (task: any) => void) {
  const path = join(tasksDir(), `${id}.json`);
  const task = JSON.parse(readFileSync(path, 'utf8'));
  change(task);
  writeFileSync(path, JSON.stringify(task));
}
function tempAgent(name: string, role: Record<string, unknown>, supervisor?: Record<string, unknown>) {
  const dir = join(tmpRoot(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.yaml'), stringify({ name, ...role }));
  writeFileSync(join(dir, '.temp-supervisor.json'), JSON.stringify({ version: 1, role: name, launchId: 'l1', ...supervisor }));
  return dir;
}
function archive(w: NonNullable<ReturnType<typeof getTask>['workspace']>, name: string) {
  const path = join(stateRoot(), 'recovery', 'temporary', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'role.yaml'), stringify({ name, roomMemberStartup: { workspace: w } }));
  writeFileSync(join(path, '.temp-supervisor.json'), JSON.stringify({ role: name, launchId: 'launch-1' }));
  writeFileSync(join(path, 'termination.jsonl'), JSON.stringify({ version: 1, role: name, launchId: 'launch-1', outcome: 'retired' }) + '\n');
  writeFileSync(join(path, 'WORKLOG.md'), 'retain my evidence');
  return path;
}
const refused = (taskId: string, pattern: RegExp, extra = deps) =>
  expect(removeTaskWorkspace(taskId, actor, extra)).rejects.toThrow(pattern);

describe('removing a Done task working folder', () => {
  it('removes only the folder and keeps the card, Progress, To review bytes and agent archives', async () => {
    const t = createTask({ title: 'deliver', brief: 'original requirements', origin: { type: 'cli' } });
    const w = t.workspace!;
    repo(join(w.path, 'checkout'));
    writeFileSync(join(w.path, 'checkout', 'uncommitted.txt'), 'scratch');
    writeFileSync(join(w.path, 'report.md'), 'retained bytes');
    activateTask(t.task_id);
    appendTaskProgress(t.task_id, { text: 'milestone', author });
    setTaskReviewMarkdown(t.task_id, { markdown: `See ${w.path}/report.md`, expectedMarkdown: '', author });
    const { artifact } = await attachTaskReviewArtifact(t.task_id, {
      name: 'report.md', source: await openTaskWorkspaceFile(getTask(t.task_id), join(w.path, 'report.md')), author,
    });
    reviewTask(t.task_id); completeTask(t.task_id);
    const evidence = archive(w, 'retired-worker');
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'x');
    const before = getTask(t.task_id);

    const outcome = await removeTaskWorkspace(t.task_id, actor, deps);
    expect(outcome.result).toBe('removed');
    expect(outcome.mentions).toEqual(['to_review']);
    expect(existsSync(w.path)).toBe(false);
    expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([]);

    const after = getTask(t.task_id);
    expect(after).toMatchObject({
      state: 'done', title: 'deliver', brief: 'original requirements', key: before.key,
      created_at: before.created_at, ended_at: before.ended_at, workspace: w,
    });
    expect(after.progress?.map(entry => entry.text)).toEqual(['milestone']);
    expect(after.review?.markdown).toBe(before.review?.markdown);
    expect((await readTaskReviewArtifact(t.task_id, artifact.id)).bytes.toString()).toBe('retained bytes');
    expect(readFileSync(join(evidence, 'WORKLOG.md'), 'utf8')).toBe('retain my evidence');
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('x');
    expect(workingFilesSummary(after)).toMatchObject({ state: 'removed', removed_at: expect.any(String) });
    expect(after.workspace_removal?.actor).toEqual(actor);

    // Repeat is harmless and honest; a create replay or file attach never recreates the folder.
    const again = await removeTaskWorkspace(t.task_id, actor, deps);
    expect(again.result).toBe('already_removed');
    expect(again.task.workspace_removal).toEqual(after.workspace_removal);
    await expect(openTaskWorkspaceFile(getTask(t.task_id), join(w.path, 'report.md'))).rejects.toThrow(/were removed/);
    expect(existsSync(w.path)).toBe(false);
  });

  it('refuses to launch an agent into a removed folder, which would recreate it', async () => {
    const t = doneTask();
    const kept = doneTask();
    await removeTaskWorkspace(t.task_id, actor, deps);
    const alias = join(root, 'alias-to-removed'); symlinkSync(t.workspace!.path, alias);
    for (const cwd of [t.workspace!.path, join(t.workspace!.path, 'checkout'), join(t.workspace!.path, '..x'), join(alias, 'sub')])
      expect(() => assertCwdNotInRemovedTaskFolder(cwd)).toThrow(/working files of task .* were removed/);
    for (const cwd of [kept.workspace!.path, join(root, 'elsewhere'), join(stateRoot(), 'workspaces', 'tasks', 'unknown'), undefined])
      expect(() => assertCwdNotInRemovedTaskFolder(cwd)).not.toThrow();
    writeV2Fixture(join(root, 'fleet.yaml'), { roles: {} });
    await expect(spawnTemp({ name: 'Late', cwd: t.workspace!.path,
      brain: { inline: { harness: 'claude-code', model: 'm' } }, role: { inline: { mission: 'x' } } } as any, '/b/ours-fleet', () => {}))
      .rejects.toThrow(/were removed/);
    expect(existsSync(t.workspace!.path)).toBe(false);
  });

  it('does not recreate the folder on an idempotent create replay', async () => {
    const t = createTask({ title: 'work', origin: { type: 'cli' }, idempotency_key: 'replay' });
    activateTask(t.task_id); reviewTask(t.task_id); completeTask(t.task_id);
    await removeTaskWorkspace(t.task_id, actor, deps);
    expect(createTask({ title: 'work', origin: { type: 'cli' }, idempotency_key: 'replay' }).task_id).toBe(t.task_id);
    expect(existsSync(t.workspace!.path)).toBe(false);
  });

  it.each([
    ['backlog', () => createTask({ title: 'b', origin: { type: 'cli' }, start: false })],
    ['active', () => { const t = createTask({ title: 'a', origin: { type: 'cli' } }); activateTask(t.task_id); return t; }],
    ['review', () => { const t = createTask({ title: 'r', origin: { type: 'cli' } }); activateTask(t.task_id); reviewTask(t.task_id); return t; }],
    ['cancelled', () => { const t = createTask({ title: 'c', origin: { type: 'cli' } }); cancelTask(t.task_id); return t; }],
  ])('refuses a %s task on the server', async (state, make) => {
    const t = make();
    await refused(t.task_id, new RegExp(`only a Done task's working files can be removed; this task is ${state}`));
    expect(existsSync(join(t.workspace!.path, '.fleet-workspace.json'))).toBe(true);
    expect(getTask(t.task_id).workspace_removal).toBeUndefined();
  });

  it('refuses pending completion, pending deletion, an open room and a missing workspace record', async () => {
    const settling = createTask({ title: 's', origin: { type: 'cli' } });
    activateTask(settling.task_id); reviewTask(settling.task_id);
    beginTaskTerminalIntent(settling.task_id, { kind: 'done' });
    patchTask(settling.task_id, task => { task.state = 'done'; });
    await refused(settling.task_id, /completion of the task is still being settled/);

    const roomed = doneTask();
    createRoomRecord({ room_id: 'live-room', room_name: 'r', task_id: roomed.task_id });
    await refused(roomed.task_id, /room live-room of this task is still open/);
    expect(existsSync(roomed.workspace!.path)).toBe(true);

    const legacy = doneTask();
    patchTask(legacy.task_id, task => { delete task.workspace; });
    await refused(legacy.task_id, /no Fleet-owned working folder/);
    expect(existsSync(legacy.workspace!.path)).toBe(true);

    const deleting = doneTask();
    await acceptTaskDeletion(deleting.task_id, { kind: 'local_control', surface: 'cli' });
    await expect(removeTaskWorkspace(deleting.task_id, actor, deps)).rejects.toThrow();
    expect(existsSync(deleting.workspace!.path)).toBe(true);
  });

  it('refuses while any agent may still use the folder, failing closed on unreadable state', async () => {
    const t = doneTask();
    const path = t.workspace!.path;
    const live = tempAgent('worker', { cwd: path });
    await refused(t.task_id, /agent worker works in this folder/);
    rmSync(live, { recursive: true });

    const nested = tempAgent('nested', { cwd: join(path, 'checkout') });
    await refused(t.task_id, /agent nested works in this folder/);
    rmSync(nested, { recursive: true });

    // Detached member roles do not hide an unretired owner.
    patchTask(t.task_id, task => { task.member_roles = []; });
    const owned = tempAgent('owned', { cwd: join(root, 'elsewhere') }, { taskOwner: { taskId: t.task_id, creationActionId: 'a' } });
    await refused(t.task_id, /agent owned of this mission has not been retired/);
    rmSync(owned, { recursive: true });

    const broken = join(tmpRoot(), 'broken'); mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'role.yaml'), ': not yaml : [');
    await refused(t.task_id, /agent broken has unreadable state/);
    rmSync(broken, { recursive: true });

    await registerMember({ name: 'registered', kind: 'task', dir: join(tmpRoot(), 'registered'), launchId: 'l', taskOwner: { taskId: t.task_id, creationActionId: 'a' } });
    await refused(t.task_id, /agent registered of this mission is still registered/);
    rmSync(join(stateRoot(), 'supervisor'), { recursive: true });

    await refused(t.task_id, /permanent agent is configured to work in this folder/, { permanentCwds: [undefined, path] });
    await refused(t.task_id, /configuration cannot be read/, {} as typeof deps);
    expect(existsSync(join(path, '.fleet-workspace.json'))).toBe(true);

    // Unknown supervisor ownership is not absence of ownership.
    const unknown = tempAgent('unknown', { cwd: join(root, 'elsewhere') });
    writeFileSync(join(unknown, '.temp-supervisor.json'), '{ not json');
    await refused(t.task_id, /agent unknown has unreadable state/);
    rmSync(unknown, { recursive: true });

    const bare = tempAgent('bare', { cwd: join(root, 'elsewhere') });
    rmSync(join(bare, '.temp-supervisor.json'));
    await refused(t.task_id, /agent bare has unreadable state.*missing \.temp-supervisor\.json/);
    writeFileSync(join(bare, '.temp-supervisor.json'), JSON.stringify({ version: 1, role: 'bare' }));
    await refused(t.task_id, /agent bare has unreadable state.*invalid \.temp-supervisor\.json/);
    rmSync(bare, { recursive: true });

    const linkedState = join(root, 'linked-state'); mkdirSync(linkedState);
    symlinkSync(linkedState, join(tmpRoot(), 'linked'));
    await refused(t.task_id, /agent state linked is a symlink/);
    rmSync(join(tmpRoot(), 'linked'));

    // A permanent agent started from any configuration records its cwd in its state.
    const permanentDir = join(stateRoot(), 'agents', 'Keeper'); mkdirSync(permanentDir, { recursive: true });
    writeFileSync(join(permanentDir, '.cwd'), `${path}\n`);
    await refused(t.task_id, /permanent agent Keeper works in this folder/);
    writeFileSync(join(permanentDir, '.cwd'), `${join(root, 'elsewhere')}\n`);

    // Component containment: `..checkout` is a descendant, not a parent.
    const dotted = tempAgent('dotted', { cwd: join(path, '..checkout') });
    await refused(t.task_id, /agent dotted works in this folder/);
    rmSync(dotted, { recursive: true });

    // A symlink alias outside the folder that resolves into it.
    mkdirSync(join(path, 'checkout'));
    const alias = join(root, 'alias');
    symlinkSync(join(path, 'checkout'), alias);
    const aliased = tempAgent('aliased', { cwd: join(alias, 'sub') });
    await refused(t.task_id, /agent aliased works in this folder/);
    rmSync(aliased, { recursive: true });
    await refused(t.task_id, /permanent agent is configured to work in this folder/, { permanentCwds: [alias] });
    rmSync(alias);

    // An unreadable room record has an unknown owner.
    mkdirSync(join(stateRoot(), 'rooms'), { recursive: true });
    writeFileSync(join(stateRoot(), 'rooms', 'corrupt.json'), '{ truncated');
    await refused(t.task_id, /room record corrupt.json cannot be read/);
    writeFileSync(join(stateRoot(), 'rooms', 'corrupt.json'), '[]');
    await refused(t.task_id, /room record corrupt.json is invalid/);
    rmSync(join(stateRoot(), 'rooms', 'corrupt.json'));

    // Refusals restore the record: nothing claims a removal started.
    expect(getTask(t.task_id).workspace_removal).toBeUndefined();

    // An unrelated agent elsewhere does not block.
    tempAgent('unrelated', { cwd: join(root, 'elsewhere') });
    expect((await removeTaskWorkspace(t.task_id, actor, deps)).result).toBe('removed');
  });

  it('restores the folder and refuses when any process entered it before the rename', async () => {
    const t = doneTask();
    const path = t.workspace!.path;
    mkdirSync(join(path, 'checkout'));
    const child = spawn('sleep', ['30'], { cwd: join(path, 'checkout'), stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      await expect(removeTaskWorkspace(t.task_id, actor, deps)).rejects.toThrow(new RegExp(`process .*${child.pid}.* is using the folder`));
      expect(existsSync(join(path, '.fleet-workspace.json'))).toBe(true);
      expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([t.task_id]);
      expect(getTask(t.task_id).workspace_removal).toBeUndefined();
    } finally {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    // A process of ours that hides its entries (non-dumpable) is unknown use, not absence.
    const hidden = spawn('python3', ['-c', 'import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print("ready", flush=True); time.sleep(30)'],
      { cwd: path, stdio: ['ignore', 'pipe', 'ignore'] });
    fixturePids.add(String(hidden.pid));
    try {
      await new Promise(resolve => hidden.stdout!.once('data', resolve));
      expect(() => readlinkSync(`/proc/${hidden.pid}/cwd`)).toThrow(/EACCES/);
      await expect(removeTaskWorkspace(t.task_id, actor, deps)).rejects.toThrow(new RegExp(`1 process\\(es\\) of this user cannot be checked for use of the folder: ${hidden.pid} python3`));
      expect(existsSync(join(path, '.fleet-workspace.json'))).toBe(true);
      expect(getTask(t.task_id).workspace_removal).toBeUndefined();
    } finally {
      hidden.kill();
      await new Promise(resolve => hidden.once('exit', resolve));
    }
    expect((await removeTaskWorkspace(t.task_id, actor, deps)).result).toBe('removed');

    // A process check that cannot run restores the folder too.
    const other = doneTask();
    await expect(removeTaskWorkspace(other.task_id, actor, { ...deps, processesUsing: () => { throw Error('proc unavailable'); } }))
      .rejects.toThrow(/processes using the folder cannot be checked/);
    expect(existsSync(join(other.workspace!.path, '.fleet-workspace.json'))).toBe(true);
  });

  it('excludes an unreadable process only when its mount table cannot reach the folder', () => {
    const target = { device: '8:1', inside: '/home/u/.ours-fleet/workspaces/tasks/t1' };
    const line = (device: string, root: string, point: string) => `1 2 ${device} ${root} ${point} rw - ext4 /dev/sda1 rw`;
    // A container: overlay root plus binds of unrelated host paths on the same disk.
    expect(reaches([line('0:241', '/', '/'), line('8:1', '/var/lib/docker/volumes/v/_data', '/var/lib/ours'),
      line('8:1', '/home/u/.ours-fleet/workspaces/tasks/t10', '/w')].join('\n'), target)).toBe(false);
    for (const root of ['/', '/home/u', '/home/u/.ours-fleet/workspaces/tasks/t1', '/home/u/.ours-fleet/workspaces/tasks/t1/sub', '/home/u/.ours-fleet/workspaces/tasks/t1/..x'])
      expect(reaches(line('8:1', root, '/mnt'), target)).toBe(true);
    expect(reaches(line('8:2', '/', '/'), target)).toBe(false);
    expect(reaches(line('8:1', '/home/u/odd\\040name', '/m'), { device: '8:1', inside: '/home/u/odd name/x' })).toBe(true);
  });

  it("excludes the user service manager only when its own records name nothing in the folder", () => {
    const folder = '/home/u/.ours-fleet/workspaces/tasks/t1';
    const roots = [`/home/u/.ours-fleet/workspaces/tasks/.t1.tok.deleting`, folder];
    const units = (extra = '') => `Id=a.service\nNFileDescriptorStore=0\n\nId=b.socket\nNFileDescriptorStore=0\nListen=/run/user/1/s (Stream)\n${extra}`;
    const fake = (cwd: string, show: string, stores: Record<string, unknown> = {}) => (command: string, args: string[]) => {
      if (command === 'systemctl' && args[0] === 'show') return `${cwd}\n`;
      if (command === 'systemctl') return show;
      if (args[2] in stores) return JSON.stringify(stores[args[2]]);
      throw Error('File descriptor store not enabled');
    };
    expect(userManagerUse(1, roots, fake('', units()))).toBeUndefined();
    expect(userManagerUse(1, roots, fake(`-${folder}/sub`, units()))).toMatch(/works in/);
    expect(userManagerUse(1, roots, fake('', units(`\nId=c.socket\nNFileDescriptorStore=0\nListen=${folder}/x.sock (Stream)\n`)))).toMatch(/c.socket listens on/);
    const stored = units(`\nId=d.service\nNFileDescriptorStore=2\n`);
    expect(userManagerUse(1, roots, fake('', stored, { 'd.service': [{ type: 'socket' }, { type: 'regular', path: '/tmp/x' }] }))).toBeUndefined();
    expect(userManagerUse(1, roots, fake('', stored, { 'd.service': [{ type: 'directory', path: `${roots[0]}/sub (deleted)` }] }))).toMatch(/d.service stores/);
    expect(userManagerUse(1, roots, fake('', stored, { 'd.service': [{ type: 'regular' }] }))).toMatch(/path is unknown/);
    expect(userManagerUse(1, roots, fake('', stored))).toMatch(/records cannot be read/);
    expect(userManagerUse(1, roots, fake('', ''))).toMatch(/units cannot be listed/);
    expect(userManagerUse(1, roots, () => { throw Error('Failed to connect to bus'); })).toMatch(/records cannot be read \(Failed to connect to bus\)/);
  });

  it('requires a layout task to have finished closing its rooms and retiring its agents', async () => {
    const t = doneTask();
    const runId = `task-${t.task_id}`;
    patchTask(t.task_id, task => { task.layout = { name: 'team', run_id: runId, definition_hash: 'h' }; });
    await refused(t.task_id, /layout state cannot be read/);
    const run = join(stateRoot(), 'layouts', `${runId}.json`);
    mkdirSync(join(stateRoot(), 'layouts'), { recursive: true });
    const write = (state: object) => writeFileSync(run, JSON.stringify({ participants: {}, ...state }));
    write({ closed: false });
    await refused(t.task_id, /still being closed/);
    write({ closed: true, uncertain: 'room creation outcome unknown' });
    await refused(t.task_id, /still being closed/);
    write({ closed: true, participants: { dev: { owned: true, instance: { agent: 'x' } } } });
    await refused(t.task_id, /mission agent dev has not been retired/);
    write({ closed: true, participants: { dev: { owned: true, instance: { agent: 'x' }, retired: true } } });
    expect((await removeTaskWorkspace(t.task_id, actor, deps)).result).toBe('removed');
  });

  it('refuses mismatched ownership, symlink escape and foreign Git metadata without touching outside targets', async () => {
    const mismatch = doneTask();
    writeFileSync(join(mismatch.workspace!.path, '.fleet-workspace.json'), JSON.stringify({ ...mismatch.workspace, token: '00000000-0000-0000-0000-000000000000' }));
    await refused(mismatch.task_id, /ownership marker mismatch/);
    expect(existsSync(mismatch.workspace!.path)).toBe(true);
    expect(workingFilesSummary(getTask(mismatch.task_id))).toMatchObject({ state: 'failed', error: expect.stringMatching(/marker mismatch/) });

    const linked = doneTask();
    const target = join(root, 'target'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'outside');
    renameSync(join(linked.workspace!.path, '.fleet-workspace.json'), join(target, '.fleet-workspace.json'));
    rmSync(linked.workspace!.path, { recursive: true });
    symlinkSync(target, linked.workspace!.path);
    await refused(linked.task_id, /unsafe directory/);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('outside');

    const custom = doneTask();
    patchTask(custom.task_id, task => { task.workspace.path = target; });
    await refused(custom.task_id, /not this task's Fleet-owned folder/);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('outside');

    const foreign = doneTask();
    const external = join(root, 'external-repo'); repo(external);
    git(external, 'worktree', 'add', '-q', join(foreign.workspace!.path, 'wt'));
    await refused(foreign.task_id, /foreign git metadata/);
    expect(existsSync(join(foreign.workspace!.path, 'wt'))).toBe(true);
    expect(git(external, 'worktree', 'list')).toContain('wt');
  });

  it('records an already-missing folder honestly and keeps the task', async () => {
    const t = doneTask();
    rmSync(t.workspace!.path, { recursive: true });
    const outcome = await removeTaskWorkspace(t.task_id, actor, deps);
    expect(outcome.result).toBe('already_missing');
    expect(outcome.task).toMatchObject({ state: 'done', brief: 'keep this description', workspace_removal: { already_missing: true } });
    expect((await removeTaskWorkspace(t.task_id, actor, deps)).result).toBe('already_removed');
  });

  it('reports an unconfirmed removal as removing and resumes its tombstone on retry', async () => {
    const t = doneTask();
    const w = t.workspace!;
    writeFileSync(join(w.path, 'big.bin'), 'data');
    patchTask(t.task_id, task => { task.workspace_removal = { started_at: new Date().toISOString(), actor }; });
    renameSync(w.path, join(root, '.ours-fleet', 'workspaces', 'tasks', `.${t.task_id}.${w.token}.deleting`));
    expect(workingFilesSummary(getTask(t.task_id))).toMatchObject({ state: 'removing' });
    const outcome = await removeTaskWorkspace(t.task_id, actor, deps);
    expect(outcome.result).toBe('removed');
    expect(outcome.task.workspace_removal?.already_missing).toBeUndefined();
    expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([]);
  });

  it.each([
    ['a busy refusal', () => ({ users: ['4242'], unverified: [] }), /process 4242 is using the folder; .*kept for retry/],
    ['an unverifiable process', () => ({ users: [], unverified: [{ token: '4243:1', description: '4243 worker' }] }), /cannot be checked for use of the folder: 4243 worker; .*kept for retry/],
    ['a failed process inspection', () => { throw Error('proc unavailable'); }, /processes using the folder cannot be checked .*kept for retry/],
  ])('keeps a resumed partial tombstone in place after %s, so a retry can still finish it', async (_name, processesUsing, refusal) => {
    const t = doneTask();
    const w = t.workspace!;
    writeFileSync(join(w.path, 'rest.bin'), 'data');
    const tomb = join(stateRoot(), 'workspaces', 'tasks', `.${t.task_id}.${w.token}.deleting`);
    patchTask(t.task_id, task => { task.workspace_removal = { started_at: new Date().toISOString(), actor }; });
    renameSync(w.path, tomb);
    rmSync(join(tomb, '.fleet-workspace.json')); // a partial rm already consumed the marker

    await expect(removeTaskWorkspace(t.task_id, actor, { ...deps, processesUsing })).rejects.toThrow(refusal);
    expect(existsSync(w.path)).toBe(false);
    expect(readFileSync(join(tomb, 'rest.bin'), 'utf8')).toBe('data');
    expect(workingFilesSummary(getTask(t.task_id))).toMatchObject({ state: 'failed', error: expect.stringMatching(/folder/) });

    const outcome = await removeTaskWorkspace(t.task_id, actor, { ...deps, processesUsing: () => ({ users: [], unverified: [] }) });
    expect(outcome.result).toBe('removed');
    expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([]);
  });

  it('records a partial failure and completes on retry once the cause is fixed', async () => {
    const t = doneTask();
    const locked = join(t.workspace!.path, 'locked');
    mkdirSync(locked); writeFileSync(join(locked, 'file'), 'x');
    const other = mkdtempSync(join(root, 'other-'));
    // A foreign-owned entry cannot be simulated without root; a hardlinked
    // Git pointer is the guarded deletion's own refusal for an unsafe entry.
    mkdirSync(join(t.workspace!.path, 'repo', '.git'), { recursive: true });
    writeFileSync(join(t.workspace!.path, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(t.workspace!.path, 'repo', '.git', 'commondir'), other);
    await refused(t.task_id, /foreign git metadata/);
    expect(workingFilesSummary(getTask(t.task_id)).state).toBe('failed');
    rmSync(join(t.workspace!.path, 'repo'), { recursive: true });
    chmodSync(locked, 0o000);
    const outcome = await removeTaskWorkspace(t.task_id, actor, deps);
    expect(outcome.result).toBe('removed');
    expect(workingFilesSummary(outcome.task).state).toBe('removed');
    expect(existsSync(other)).toBe(true);
  });

  it('serializes with deletion and keeps full deletion working after removal', async () => {
    const t = doneTask();
    const evidence = archive(t.workspace!, 'retired-worker');
    await removeTaskWorkspace(t.task_id, actor, deps);
    expect(existsSync(evidence)).toBe(true);
    await acceptTaskDeletion(t.task_id, { kind: 'local_control', surface: 'cli' });
    expect((await settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork })).deleted).toBe(true);
    expect(() => getTask(t.task_id)).toThrow();
    expect(existsSync(evidence)).toBe(false);
    expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([]);

    // An interrupted removal's tombstone does not block deletion.
    const interrupted = doneTask();
    const w = interrupted.workspace!;
    archive(w, 'other-worker');
    patchTask(interrupted.task_id, task => { task.workspace_removal = { started_at: new Date().toISOString(), actor }; });
    renameSync(w.path, join(stateRoot(), 'workspaces', 'tasks', `.${interrupted.task_id}.${w.token}.deleting`));
    await acceptTaskDeletion(interrupted.task_id, { kind: 'local_control', surface: 'cli' });
    expect((await settleTaskDeletion({ taskId: interrupted.task_id, cowork: () => cowork })).deleted).toBe(true);
    expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([]);

    // Concurrent requests serialize on the task-operation lock: one consistent outcome.
    const raced = doneTask();
    const results = await Promise.allSettled([
      removeTaskWorkspace(raced.task_id, actor, deps),
      acceptTaskDeletion(raced.task_id, { kind: 'local_control', surface: 'cli' }),
    ]);
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') expect(existsSync(raced.workspace!.path)).toBe(false);
    else expect(existsSync(raced.workspace!.path)).toBe(true);
    expect((await settleTaskDeletion({ taskId: raced.task_id, cowork: () => cowork })).deleted).toBe(true);
    expect(readdirNames(join(stateRoot(), 'workspaces', 'tasks'))).toEqual([]);
  });
});

describe('HTTP API', () => {
  it('removes working files through an authenticated request and reads the state back', async () => {
    const t = doneTask();
    const active = createTask({ title: 'active', origin: { type: 'cli' } });
    const boundary = { origin: 'http://127.0.0.1:49273', host: '127.0.0.1:49273' };
    const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(join(root, 'auth')));
    let unverified = [{ token: '4244:1', description: '4244 worker' }];
    const service = new TaskRoomApplicationService(undefined, { loadConfiguration: () => ({ roles: [] }) as any,
      processesUsing: (path, context) => ({ users: processesUsing(path, context).users, unverified }) });
    const server = await buildWebServer({ taskRooms: service } as any, boundary, { auth });
    try {
      const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange', headers: { host: boundary.host, origin: boundary.origin, authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
      const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? []).map(v => v.split(';')[0]).join('; ');
      const headers = { host: boundary.host, origin: boundary.origin, cookie, 'x-csrf-token': exchange.json().csrfToken };
      const post = (id: string, h: Record<string, string> = headers) =>
        server.app.inject({ method: 'POST', url: `/api/v1/tasks/${id}/working-files/remove`, headers: h, payload: {} });

      expect((await post(t.task_id, { host: boundary.host, origin: boundary.origin })).statusCode).toBe(401);
      expect((await server.app.inject({ method: 'GET', url: `/api/v1/tasks/${t.task_id}`, headers })).json().task.working_files).toEqual({ state: 'present' });
      const refusedResponse = await post(active.task_id);
      expect(refusedResponse.statusCode).toBe(409);
      expect(refusedResponse.json().error.message).toMatch(/only a Done task/);

      // Strict: use that cannot be checked refuses, with the folder restored.
      const unknown = await post(t.task_id);
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error.message).toMatch(/cannot be checked for use of the folder: 4244 worker/);
      expect(existsSync(join(t.workspace!.path, '.fleet-workspace.json'))).toBe(true);
      unverified = [];

      const removed = await post(t.key!);
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ result: 'removed', task: { task_id: t.task_id, state: 'done', working_files: { state: 'removed' } } });
      expect(existsSync(t.workspace!.path)).toBe(false);
      expect((await post(t.task_id)).json().result).toBe('already_removed');
      const listed = (await server.app.inject({ method: 'GET', url: '/api/v1/tasks', headers })).json().tasks.find((item: any) => item.task_id === t.task_id);
      expect(listed.working_files).toMatchObject({ state: 'removed' });
    } finally { await server.app.close(); }
  });
});

function readdirNames(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}
