import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hook = vi.hoisted(() => ({ target: '', parked: '', outside: '', armed: false, phase: '', visits: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const replace = () => {
    hook.armed = false;
    fs.renameSync(hook.target, hook.parked);
    fs.symlinkSync(hook.outside, hook.target);
  };
  return { ...fs,
    readdirSync(path: string, options: { withFileTypes: true }) {
      const entries = fs.readdirSync(path, options);
      if (hook.armed && hook.phase === 'traversal' && fs.statSync(path).ino === fs.lstatSync(hook.target).ino) replace();
      return entries;
    },
    fstatSync(fd: number) {
      const entry = fs.fstatSync(fd);
      if (hook.armed && hook.phase === 'Git audit' && entry.ino === fs.lstatSync(hook.target).ino && ++hook.visits === 2) replace();
      return entry;
    },
    fchmodSync(fd: number, mode: number) {
      fs.fchmodSync(fd, mode);
      if (hook.armed && hook.phase === 'preparation' && fs.fstatSync(fd).ino === fs.lstatSync(hook.target).ino) replace();
    },
  };
});
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { auditWorkspaceGit, deleteWorkspace, ensureWorkspace, planWorkspace } from '../src/rooms-tasks/workspace.js';

let root: string | undefined;
const priorHome = process.env.OURS_FLEET_HOME;
function unlock(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) unlock(join(path, name));
}
afterEach(() => {
  hook.armed = false;
  if (priorHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = priorHome;
  if (root) { unlock(root); rmSync(root, { recursive: true }); root = undefined; }
});

describe.skipIf(process.platform !== 'linux')('pinned deletion traversal', () => {
  it.each(['preparation', 'Git audit', 'traversal'] as const)('refuses a replaced directory during %s without repairing outside descendants', phase => {
    root = mkdtempSync(join(tmpdir(), 'fleet-delete-replacement-'));
    process.env.OURS_FLEET_HOME = root;
    const w = planWorkspace('task', 'injected-replacement');
    ensureWorkspace(w);
    hook.target = join(w.path, 'artifact');
    hook.parked = join(root, 'original-owned-artifact');
    hook.outside = join(root, 'outside');
    const child = join(hook.outside, 'outside-child');
    mkdirSync(hook.target); mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'payload'), 'outside sentinel');
    chmodSync(child, 0o500); chmodSync(hook.target, 0o500);
    hook.phase = phase; hook.visits = 0; hook.armed = true;
    const action = phase === 'Git audit'
      ? () => auditWorkspaceGit(w.path, { forDeletion: true })
      : () => deleteWorkspace(w, 'task', w.id);
    expect(action).toThrow(/entry changed/);
    expect(hook.armed).toBe(false);
    expect(readFileSync(join(child, 'payload'), 'utf8')).toBe('outside sentinel');
    expect(lstatSync(child).mode & 0o777).toBe(0o500);
    expect(existsSync(w.path)).toBe(true);
  });
});
