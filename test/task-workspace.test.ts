import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { stateRoot } from '../src/paths.js';
import { createTask, getTask, tasksDir, activateTask, reviewTask, completeTask, cancelTask, getDeletingTask } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, closeRoom, getRoomRecord, roomsDir } from '../src/rooms-tasks/room-state.js';
import { acceptTaskDeletion, settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { closeManagedRoom, deleteManagedRoom, deleteLegacyClosedRooms } from '../src/rooms-tasks/close.js';
import { planWorkspace, ensureWorkspace, deleteWorkspace, auditWorkspaceGit } from '../src/rooms-tasks/workspace.js';
import { collectWorkspaceArchives } from '../src/rooms-tasks/workspace-artifacts.js';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { CoworkProtocolError } from '../src/rooms-tasks/cowork-adapter.js';
import { provisionMembers } from '../src/rooms-tasks/provision.js';

let root: string;
let oldHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  oldHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});
const actor = { kind: 'local_control', surface: 'cli' } as const;
const cowork = { closeRoom: async () => {}, deleteRoom: async () => {} };
function task() { return createTask({ title: 'work', origin: { type: 'cli' } }); }
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repo(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init');
  git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
}
function archive(w: ReturnType<typeof planWorkspace>, name: string, launchId = 'launch-1') {
  const path = join(stateRoot(), 'recovery', 'temporary', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'role.yaml'), stringify({ name, roomMemberStartup: { workspace: w } }));
  writeFileSync(join(path, '.temp-supervisor.json'), JSON.stringify({ role: name, launchId }));
  writeFileSync(join(path, 'termination.jsonl'), JSON.stringify({ version: 1, role: name, launchId, outcome: 'retired' }) + '\n');
  writeFileSync(join(path, 'WORKLOG.md'), 'retain my evidence');
  return path;
}

describe('workspace lifecycle', () => {
  it('records one stable path and marker across retry and a partial allocation', () => {
    const t = createTask({ title: 'work', origin: { type: 'cli' }, idempotency_key: 'same' });
    expect(t.workspace?.path).toBe(join(stateRoot(), 'workspaces', 'tasks', t.task_id));
    const saved = readFileSync(join(t.workspace!.path, '.fleet-workspace.json'), 'utf8');
    expect(createTask({ title: 'work', origin: { type: 'cli' }, idempotency_key: 'same' }).workspace).toEqual(t.workspace);
    const staging = join(dirname(t.workspace!.path), `.${t.task_id}.${t.workspace!.token}.provisioning`);
    renameSync(t.workspace!.path, staging);
    expect(createTask({ title: 'work', origin: { type: 'cli' }, idempotency_key: 'same' }).workspace).toEqual(t.workspace);
    expect(readFileSync(join(t.workspace!.path, '.fleet-workspace.json'), 'utf8')).toBe(saved);
    expect(existsSync(staging)).toBe(false);
  });

  it.each(['done', 'cancelled'] as const)('retains all artifacts after %s and linked room retirement/delete', async state => {
    const t = task();
    const artifact = join(t.workspace!.path, 'delivery.patch');
    writeFileSync(artifact, 'delivery');
    const archived = archive(t.workspace!, 'retired-worker');
    createRoomRecord({ room_id: 'retained-room', room_name: 'r', task_id: t.task_id });
    activateTask(t.task_id);
    if (state === 'done') { reviewTask(t.task_id); completeTask(t.task_id); }
    else cancelTask(t.task_id);
    await closeManagedRoom({ roomId: 'retained-room', cowork });
    await deleteLegacyClosedRooms({ cowork });
    await deleteManagedRoom({ roomId: 'retained-room', cowork });
    expect(getTask(t.task_id).state).toBe(state);
    expect(readFileSync(artifact, 'utf8')).toBe('delivery');
    expect(existsSync(archived)).toBe(true);
  });

  it('explicit task deletion removes workspace and every retired launch, preserving unrelated archives', async () => {
    const t = task();
    const first = archive(t.workspace!, 'worker-failed', 'old-launch');
    const second = archive(t.workspace!, 'worker-replacement', 'new-launch');
    const other = task();
    const foreign = archive(other.workspace!, 'foreign-worker');
    await acceptTaskDeletion(t.task_id, actor);
    await settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork });
    expect(existsSync(t.workspace!.path)).toBe(false);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(other.workspace!.path)).toBe(true);
    await expect(settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork })).resolves.toMatchObject({ deleted: false });
  });

  it('retains standalone room workspace on close and sweep; explicit delete owns removal', async () => {
    const r = createRoomRecord({ room_id: 'standalone', room_name: 'r' });
    await closeManagedRoom({ roomId: r.room_id, cowork });
    await deleteLegacyClosedRooms({ cowork });
    expect(existsSync(r.workspace!.path)).toBe(true);
    expect(getRoomRecord(r.room_id)).toBeDefined();
    await deleteManagedRoom({ roomId: r.room_id, cowork });
    expect(existsSync(r.workspace!.path)).toBe(false);
  });

  it('refuses provisioning after standalone retirement without re-creating workspace', async () => {
    const r = createRoomRecord({ room_id: 'retired', room_name: 'r' });
    closeRoom(r.room_id);
    await expect(provisionMembers({ roomId: r.room_id } as never)).rejects.toThrow('retired');
    await deleteManagedRoom({ roomId: r.room_id, cowork });
    await expect(provisionMembers({ roomId: r.room_id } as never)).rejects.toThrow('retired');
    expect(existsSync(r.workspace!.path)).toBe(false);
  });

  it.each(['cli', 'web'] as const)('uses common workspace lifecycle for %s', async surface => {
    const app = new TaskRoomApplicationService(undefined, { loadConfiguration: () => ({}) as never });
    const t = await app.createTask({ actor: { kind: 'local_control', surface }, title: 'parity', noRoom: true, backlog: true, origin: { type: surface } });
    expect(existsSync(t.workspace!.path)).toBe(true);
    await acceptTaskDeletion(t.task_id, { kind: 'local_control', surface });
    await settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork });
    expect(existsSync(t.workspace!.path)).toBe(false);
  });

  it('never adopts or deletes legacy cwd/outcome artifact paths', async () => {
    const t = task();
    const file = join(tasksDir(), `${t.task_id}.json`);
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.workspace;
    const foreign = join(root, 'user-project'); mkdirSync(foreign);
    legacy.outcome = { summary: 'legacy', artifacts: [foreign] };
    writeFileSync(file, JSON.stringify(legacy));
    await acceptTaskDeletion(t.task_id, actor);
    await settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork });
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(t.workspace!.path)).toBe(true);
  });

  it('recovers interruption after workspace rename, even after marker removal', async () => {
    const t = task();
    await acceptTaskDeletion(t.task_id, actor);
    const tomb = join(dirname(t.workspace!.path), `.${t.task_id}.${t.workspace!.token}.deleting`);
    renameSync(t.workspace!.path, tomb);
    rmSync(join(tomb, '.fleet-workspace.json'));
    writeFileSync(join(tomb, 'remaining'), 'artifact');
    await settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork });
    expect(existsSync(tomb)).toBe(false);
  });

  it('keeps record and artifacts retryable after unsafe path refusal', async () => {
    const t = task();
    const marker = join(t.workspace!.path, '.fleet-workspace.json');
    const saved = readFileSync(marker, 'utf8');
    writeFileSync(marker, '{}');
    await acceptTaskDeletion(t.task_id, actor);
    await expect(settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork })).rejects.toThrow('marker mismatch');
    expect(getDeletingTask(t.task_id).deletion?.error).toContain('marker mismatch');
    writeFileSync(marker, saved);
    await settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork });
    expect(existsSync(t.workspace!.path)).toBe(false);
  });
});

describe('workspace deletion safety', () => {
  it.each(['../escape', '/', '/home', 'foreign'])('rejects forged workspace path %s', path => {
    const t = task();
    expect(() => deleteWorkspace({ ...t.workspace!, path }, 'task', t.task_id)).toThrow('ownership/path');
    expect(existsSync(t.workspace!.path)).toBe(true);
  });
  it('rejects traversal owner IDs and owner/token mismatches', () => {
    expect(() => planWorkspace('task', '../escape')).toThrow('owner ID');
    const t = task();
    expect(() => deleteWorkspace(t.workspace!, 'room', t.task_id)).toThrow();
    expect(() => deleteWorkspace({ ...t.workspace!, token: 'b'.repeat(36) }, 'task', t.task_id)).toThrow();
  });
  it.each(['workspace', 'parent'] as const)('refuses symlinked %s', kind => {
    const t = task();
    const p = kind === 'workspace' ? t.workspace!.path : dirname(t.workspace!.path);
    const moved = p + '-original'; renameSync(p, moved); symlinkSync(moved, p);
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow('unsafe directory');
    expect(existsSync(moved)).toBe(true);
  });
  it('unlinks ordinary artifact symlinks without following the target', () => {
    const t = task();
    const foreign = join(root, 'foreign.txt'); writeFileSync(foreign, 'keep');
    symlinkSync(foreign, join(t.workspace!.path, 'artifact-link'));
    deleteWorkspace(t.workspace!, 'task', t.task_id);
    expect(readFileSync(foreign, 'utf8')).toBe('keep');
  });
  it('deletes dirty internal worktrees and all their repository registrations', () => {
    const t = task();
    const source = join(t.workspace!.path, 'dependency'); repo(source);
    const worktree = join(t.workspace!.path, 'workers', 'dev'); mkdirSync(dirname(worktree));
    git(source, 'worktree', 'add', '--detach', worktree);
    writeFileSync(join(worktree, 'dirty'), 'retain until explicit delete');
    expect(() => auditWorkspaceGit(t.workspace!.path)).not.toThrow();
    deleteWorkspace(t.workspace!, 'task', t.task_id);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
  });
  it('refuses external common git metadata without pruning unrelated registrations', () => {
    const t = task();
    const external = join(root, 'external'); repo(external);
    const worktree = join(t.workspace!.path, 'bad');
    git(external, 'worktree', 'add', '--detach', worktree);
    const before = git(external, 'worktree', 'list', '--porcelain');
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow('foreign git metadata');
    expect(git(external, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(existsSync(worktree)).toBe(true);
  });
  it('refuses internal repositories whose worktree registry points outside', () => {
    const t = task();
    const source = join(t.workspace!.path, 'repo'); repo(source);
    const outside = join(root, 'outside'); git(source, 'worktree', 'add', '--detach', outside);
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow('foreign git metadata');
    expect(existsSync(join(outside, '.git'))).toBe(true);
  });
  it('refuses a symlinked worktree registry before damaging an external checkout', () => {
    const t = task();
    const source = join(t.workspace!.path, 'repo'); repo(source);
    const outside = join(root, 'outside'); git(source, 'worktree', 'add', '--detach', outside);
    const registry = join(source, '.git', 'worktrees');
    const moved = join(root, 'foreign-registry'); renameSync(registry, moved); symlinkSync(moved, registry);
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow('symlink git metadata');
    expect(existsSync(join(source, '.git', 'HEAD'))).toBe(true);
    expect(existsSync(join(outside, '.git'))).toBe(true);
  });
  it('reports local deletion failure and later explicitly cleans an already-absent remote room', async () => {
    const r = createRoomRecord({ room_id: 'retry-room', room_name: 'r' });
    const marker = join(r.workspace!.path, '.fleet-workspace.json');
    const original = readFileSync(marker, 'utf8'); writeFileSync(marker, '{}');
    let calls = 0;
    const remote = { closeRoom: async () => {}, deleteRoom: async () => {
      if (++calls > 1) throw new CoworkProtocolError('room.delete', 'absent', 'not_found');
    } };
    await expect(deleteManagedRoom({ roomId: r.room_id, cowork: remote })).rejects.toThrow('marker mismatch');
    expect(getRoomRecord(r.room_id)?.close?.error).toContain('marker mismatch');
    writeFileSync(marker, original);
    await deleteManagedRoom({ roomId: r.room_id, cowork: remote });
    expect(existsSync(r.workspace!.path)).toBe(false);
    expect(getRoomRecord(r.room_id)).toBeUndefined();
    expect(calls).toBe(2);
  });
  it('rejects idempotent creation replay during deletion without recreating the workspace', async () => {
    const input = { title: 'replay', origin: { type: 'cli' as const }, idempotency_key: 'replay' };
    const t = createTask(input);
    await acceptTaskDeletion(t.task_id, actor);
    deleteWorkspace(t.workspace!, 'task', t.task_id);
    expect(() => createTask(input)).toThrow('pending deletion');
    expect(existsSync(t.workspace!.path)).toBe(false);
  });
  it('refuses symlink Git control files', () => {
    const t = task();
    symlinkSync(join(root, 'foreign'), join(t.workspace!.path, '.git'));
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow('symlink git metadata');
  });
  it('collects archived state atomically and retries collection without losing ownership', () => {
    const t = task(); const original = archive(t.workspace!, 'worker');
    collectWorkspaceArchives(t.workspace!);
    expect(existsSync(original)).toBe(false);
    expect(readFileSync(join(t.workspace!.path, '.fleet-retired-agents', 'worker', 'WORKLOG.md'), 'utf8')).toBe('retain my evidence');
    expect(() => collectWorkspaceArchives(t.workspace!)).not.toThrow();
  });
  it('refuses mismatching archive launch evidence and preserves all archives', () => {
    const t = task(); const original = archive(t.workspace!, 'worker');
    writeFileSync(join(original, '.temp-supervisor.json'), JSON.stringify({ role: 'stranger', launchId: 'launch-1' }));
    expect(() => collectWorkspaceArchives(t.workspace!)).toThrow('launch ownership mismatch');
    expect(existsSync(original)).toBe(true);
  });
});
