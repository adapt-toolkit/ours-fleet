import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsMock = vi.hoisted(() => ({ unlinkSync: vi.fn() }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.unlinkSync.mockImplementation(actual.unlinkSync);
  return { ...actual, unlinkSync: fsMock.unlinkSync };
});

import {
  activateTask, beginTaskDeletionIntent, completeTask, createTask, getTask,
  reviewTask, unlinkDeletedTask,
} from '../src/rooms-tasks/task-state.js';

describe('deletion unlink race', () => {
  let dir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-task-delete-race-'));
    originalHome = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = dir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.OURS_FLEET_HOME;
    else process.env.OURS_FLEET_HOME = originalHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats an ENOENT unlink race as an idempotent no-op', () => {
    const task = createTask({ title: 'Done', origin: { type: 'cli' } });
    activateTask(task.task_id);
    reviewTask(task.task_id);
    completeTask(task.task_id);
    beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
    fsMock.unlinkSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('lost delete race'), { code: 'ENOENT' });
    });

    expect(unlinkDeletedTask(task.task_id)).toBe(false);
    expect(getTask(task.task_id).state).toBe('done');
  });
});
