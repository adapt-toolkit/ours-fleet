import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { stateRoot } from '../src/paths.js';
import { acceptTaskDeletion, settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { createTask, getTask, tasksDir } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { deleteManagedRoom } from '../src/rooms-tasks/close.js';
import { auditWorkspaceGit, deleteWorkspace } from '../src/rooms-tasks/workspace.js';
import { collectWorkspaceArchives } from '../src/rooms-tasks/workspace-artifacts.js';

let root: string, prior: string | undefined;
const actor = { kind: 'local_control', surface: 'cli' } as const;
const cowork = { closeRoom: async () => {}, deleteRoom: async () => {} };
function unlockFixture(path: string): void {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) unlockFixture(join(path, name));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-delete-permissions-'));
  prior = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (prior === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = prior;
  unlockFixture(root);
  rmSync(root, { recursive: true, force: true });
});
function lockedArtifact(workspace: string, mode: number): string {
  const path = join(workspace, 'evidence', 'docker-fixture', 'owner-locks');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'retired.sock'), 'synthetic artifact');
  expect(lstatSync(path).uid).toBe(process.getuid!());
  chmodSync(path, mode);
  return path;
}
function git(path: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init');
  git(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
}

describe.skipIf(process.platform !== 'linux')('explicit deletion with restrictive same-owner artifacts (Linux inode recovery)', () => {
  it.each([0o000, 0o300, 0o500, 0o600])('settles task deletion through directory mode %s', async mode => {
    const t = createTask({ title: 'retired Docker fixture', origin: { type: 'cli' } });
    lockedArtifact(t.workspace!.path, mode);
    await acceptTaskDeletion(t.task_id, actor);
    await expect(settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork })).resolves.toMatchObject({ deleted: true });
    expect(existsSync(t.workspace!.path)).toBe(false);
    expect(existsSync(join(tasksDir(), `${t.task_id}.json`))).toBe(false);
  });

  it('settles standalone room deletion through the same cleanup', async () => {
    const r = createRoomRecord({ room_id: 'restricted-room', room_name: 'restricted' });
    lockedArtifact(r.workspace!.path, 0o600);
    await deleteManagedRoom({ roomId: r.room_id, cowork });
    expect(getRoomRecord(r.room_id)).toBeUndefined();
    expect(existsSync(r.workspace!.path)).toBe(false);
  });

  it('resumes an already-renamed workspace without requiring removed Git metadata', async () => {
    const t = createTask({ title: 'interrupted deletion', origin: { type: 'cli' } });
    const locked = lockedArtifact(t.workspace!.path, 0o600);
    await acceptTaskDeletion(t.task_id, actor);
    const tomb = join(dirname(t.workspace!.path), `.${t.task_id}.${t.workspace!.token}.deleting`);
    renameSync(t.workspace!.path, tomb);
    rmSync(join(tomb, '.fleet-workspace.json'));
    writeFileSync(join(tomb, '.git'), 'gitdir: already-removed');
    await expect(settleTaskDeletion({ taskId: t.task_id, cowork: () => cowork })).resolves.toMatchObject({ deleted: true });
    expect(existsSync(tomb)).toBe(false);
    expect(existsSync(locked)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('keeps ordinary audit and task status read-only', () => {
    const t = createTask({ title: 'still retained', origin: { type: 'cli' } });
    const path = lockedArtifact(t.workspace!.path, 0o600);
    expect(() => auditWorkspaceGit(t.workspace!.path)).toThrow(/EACCES/);
    expect(getTask(t.task_id).task_id).toBe(t.task_id);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('validates the workspace marker before repairing nested artifact permissions', () => {
    const t = createTask({ title: 'wrong marker', origin: { type: 'cli' } });
    const path = lockedArtifact(t.workspace!.path, 0o600);
    writeFileSync(join(t.workspace!.path, '.fleet-workspace.json'), '{}');
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow(/marker mismatch/);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('recovers an unreadable same-owner workspace root after checking its marker', () => {
    const t = createTask({ title: 'restricted root', origin: { type: 'cli' } });
    lockedArtifact(t.workspace!.path, 0o600);
    chmodSync(t.workspace!.path, 0o000);
    deleteWorkspace(t.workspace!, 'task', t.task_id);
    expect(existsSync(t.workspace!.path)).toBe(false);
  });

  it('restores the original root mode when temporary marker access finds a mismatch', () => {
    const t = createTask({ title: 'restricted wrong marker', origin: { type: 'cli' } });
    const path = lockedArtifact(t.workspace!.path, 0o600);
    writeFileSync(join(t.workspace!.path, '.fleet-workspace.json'), '{}');
    chmodSync(t.workspace!.path, 0o000);
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow(/marker mismatch/);
    expect(lstatSync(t.workspace!.path).mode & 0o777).toBe(0o000);
    chmodSync(t.workspace!.path, 0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('does not follow an artifact symlink or change its target permissions', () => {
    const t = createTask({ title: 'artifact link', origin: { type: 'cli' } });
    const external = join(root, 'external'); mkdirSync(external);
    writeFileSync(join(external, 'keep'), 'keep'); chmodSync(external, 0o500);
    symlinkSync(external, join(t.workspace!.path, 'artifact-link'));
    lockedArtifact(t.workspace!.path, 0o600);
    deleteWorkspace(t.workspace!, 'task', t.task_id);
    expect(lstatSync(external).mode & 0o777).toBe(0o500);
    expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('keep');
  });

  it('reads a restrictive owned worktree pointer and deletes internal registrations', () => {
    const t = createTask({ title: 'owned Git pointer', origin: { type: 'cli' } });
    const source = join(t.workspace!.path, 'repo'); repo(source);
    const worktree = join(t.workspace!.path, 'worktree'); git(source, 'worktree', 'add', '--detach', worktree);
    chmodSync(join(worktree, '.git'), 0o000);
    deleteWorkspace(t.workspace!, 'task', t.task_id);
    expect(existsSync(t.workspace!.path)).toBe(false);
  });

  it('still refuses a restrictive Git pointer to an external repository', () => {
    const t = createTask({ title: 'foreign Git pointer', origin: { type: 'cli' } });
    const source = join(root, 'external-repo'); repo(source);
    const worktree = join(t.workspace!.path, 'worktree'); git(source, 'worktree', 'add', '--detach', worktree);
    const before = git(source, 'worktree', 'list', '--porcelain');
    chmodSync(join(worktree, '.git'), 0o000);
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow(/foreign git metadata/);
    expect(git(source, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(existsSync(t.workspace!.path)).toBe(true);
  });

  it('does not chmod a restrictive Git pointer hardlinked outside the workspace', () => {
    const t = createTask({ title: 'hardlinked metadata', origin: { type: 'cli' } });
    const external = join(root, 'external-pointer'); writeFileSync(external, 'gitdir: elsewhere');
    linkSync(external, join(t.workspace!.path, '.git')); chmodSync(external, 0o000);
    expect(() => deleteWorkspace(t.workspace!, 'task', t.task_id)).toThrow(/hardlink/);
    expect(lstatSync(external).mode & 0o777).toBe(0o000);
  });

  it.each([true, false])('repairs archived artifacts only after matching retirement evidence: %s', valid => {
    const t = createTask({ title: 'archive permission fixture', origin: { type: 'cli' } });
    const path = join(stateRoot(), 'recovery', 'temporary', 'retired-fixture');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'role.yaml'), stringify({ name: 'worker', roomMemberStartup: { workspace: t.workspace } }));
    writeFileSync(join(path, '.temp-supervisor.json'), JSON.stringify({ role: valid ? 'worker' : 'wrong-worker', launchId: 'launch-1' }));
    writeFileSync(join(path, 'termination.jsonl'), JSON.stringify({ version: 1, role: 'worker', launchId: 'launch-1', outcome: 'retired' }) + '\n');
    const artifact = lockedArtifact(path, 0o600);
    if (valid) {
      collectWorkspaceArchives(t.workspace!);
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(join(t.workspace!.path, '.fleet-retired-agents', 'retired-fixture', 'evidence', 'docker-fixture', 'owner-locks', 'retired.sock'), 'utf8')).toBe('synthetic artifact');
    } else {
      expect(() => collectWorkspaceArchives(t.workspace!)).toThrow(/launch ownership mismatch/);
      expect(lstatSync(artifact).mode & 0o777).toBe(0o600);
    }
  });
});
