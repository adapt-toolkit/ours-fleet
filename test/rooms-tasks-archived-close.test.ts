import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({
  listIdentities: vi.fn(), removeIdentity: vi.fn(), liveness: vi.fn(),
}));
vi.mock('@ours.network/sdk/client', () => ({
  attachOursClient: async () => ({
    ...mocks, releaseLease: async () => {}, close: async () => {},
  }),
}));
vi.mock('../src/temp-lifecycle.js', async original => ({
  ...await original<typeof import('../src/temp-lifecycle.js')>(),
  tempSupervisorLiveness: mocks.liveness,
}));
import { createTask, beginTaskDeletionIntent, getDeletingTask, readTaskDeletionReceipt, tasksDir, updateTaskRoom } from '../src/rooms-tasks/task-state.js';
import { settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { closeManagedRoom } from '../src/rooms-tasks/close.js';
import { createRoomRecord, updateMemberSeats, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { stateRoot } from '../src/paths.js';
import * as workspaceArtifacts from '../src/rooms-tasks/workspace-artifacts.js';
import * as workspaceLifecycle from '../src/rooms-tasks/workspace.js';
import { stringify } from 'yaml';
const roomId = '01hzyk8m0000000000000000ab';
let root: string, prior: string | undefined, archive: string;
const cowork = { closeRoom: vi.fn(async () => {}) };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-archived-close-'));
  prior = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  mocks.listIdentities.mockReset().mockResolvedValue([]);
  mocks.removeIdentity.mockReset();
  mocks.liveness.mockReset().mockResolvedValue('stopped');
  cowork.closeRoom.mockClear();
  createRoomRecord({ room_id: roomId, room_name: 'Archived startup failure' });
  updateMemberSeats(roomId, [{
    role_name: 'member-1', slot: 'dev', cowork_role: 'Developer', seat_state: 'pending',
    launch: { state: 'launched', attempt: 1, action_id: 'action-1', launch_id: 'launch-1', updated_at: new Date().toISOString() },
  }]);
  archive = join(stateRoot(), 'recovery', 'temporary', 'archive-1');
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, '.identity'), 'member-1');
  writeFileSync(join(archive, '.temp-supervisor.json'), JSON.stringify({
    version: 1, role: 'member-1', launchId: 'launch-1', phase: 'active',
    createdAt: '2026-01-01T00:00:00Z', kind: 'systemd-transient', target: 'unit',
  }));
  writeFileSync(join(archive, 'creation.json'), JSON.stringify({ role: 'member-1', creationActionId: 'action-1' }));
  writeFileSync(join(archive, 'termination.jsonl'), JSON.stringify({ version: 1, role: 'member-1', launchId: 'launch-1', reason: 'startup-failure' }) + '\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prior === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = prior;
  rmSync(root, { recursive: true, force: true });
});
it('settles the exact archived startup failure without removing identities', async () => {
  await closeManagedRoom({ roomId, cowork });
  expect(getRoomRecord(roomId)?.member_seats[0].retirement).toMatchObject({
    phase: 'identity_absent', launch_id: 'launch-1', archive_path: archive,
  });
  expect(mocks.removeIdentity).not.toHaveBeenCalled();
  expect(cowork.closeRoom).toHaveBeenCalledOnce();
});
it.each(['running', 'unknown'])('refuses archived supervisor liveness %s', async state => {
  mocks.liveness.mockResolvedValue(state);
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/not proven stopped/);
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});
it('refuses a surviving identity even without a recorded CID', async () => {
  mocks.listIdentities.mockResolvedValue([{ name: 'member-1', cid: 'ab'.repeat(32) }]);
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/absence is not proven/);
  expect(mocks.removeIdentity).not.toHaveBeenCalled();
});
it.each(['.identity', 'creation.json', 'termination.jsonl'])('refuses broken archive proof %s', async name => {
  writeFileSync(join(archive, name), name === '.identity' ? 'other-member' : '{}');
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow();
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});
it('refuses to use the old archive when replacement live state exists', async () => {
  mkdirSync(join(stateRoot(), 'tmp', 'member-1'), { recursive: true });
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/no live Fleet temp-state identity proof/);
  expect(mocks.liveness).not.toHaveBeenCalled();
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});
it('refuses an archive for a different launch', async () => {
  const p = join(archive, '.temp-supervisor.json');
  writeFileSync(p, JSON.stringify({ version: 1, role: 'member-1', launchId: 'other-launch', phase: 'active', createdAt: '2026-01-01T00:00:00Z' }));
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/no live Fleet temp-state identity proof/);
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});
it('refuses replacement state created during the daemon absence check', async () => {
  mocks.listIdentities.mockImplementation(async () => {
    mkdirSync(join(stateRoot(), 'tmp', 'member-1'), { recursive: true });
    return [];
  });
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/changed during archived retirement proof/);
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});
it('refuses a launch changed during the daemon absence check', async () => {
  mocks.listIdentities.mockImplementation(async () => {
    const changed = getRoomRecord(roomId)!;
    changed.member_seats[0].launch!.launch_id = 'replacement';
    // Simulate an out-of-process writer predating the closing-state fence.
    writeFileSync(join(stateRoot(), 'rooms', roomId + '.json'), JSON.stringify(changed));
    return [];
  });
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/changed during archived retirement proof/);
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});
it('refuses the recorded CID surviving under another name', async () => {
  const seats = getRoomRecord(roomId)!.member_seats;
  seats[0].identity_cid = 'ab'.repeat(32);
  updateMemberSeats(roomId, seats);
  mocks.listIdentities.mockResolvedValue([{ name: 'other-name', cid: 'ab'.repeat(32) }]);
  await expect(closeManagedRoom({ roomId, cowork })).rejects.toThrow(/absence is not proven/);
  expect(cowork.closeRoom).not.toHaveBeenCalled();
});

it.each(['none', 'identity', 'archive', 'replacement', 'unknown'])('resumes deletion after room unlink with fresh proof (%s)', async obstruction => {
  const task = createTask({ title: 'Archived failure cleanup' });
  updateTaskRoom(task.task_id, roomId);
  const room = getRoomRecord(roomId)!;
  room.task_id = task.task_id;
  writeFileSync(join(stateRoot(), 'rooms', roomId + '.json'), JSON.stringify(room));
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  const remote = { closeRoom: async () => {}, deleteRoom: async () => {} };
  mocks.listIdentities.mockImplementation(async () => {
    if (!getRoomRecord(roomId)) throw new Error('simulated crash after room unlink');
    return [];
  });
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote }))
    .rejects.toThrow(/simulated crash after room unlink/);
  expect(getRoomRecord(roomId)).toBeUndefined();
  expect(getDeletingTask(task.task_id).deletion?.archived_absences).toEqual([
    expect.objectContaining({ name: 'member-1', launch_id: 'launch-1', action_id: 'action-1', archive_path: archive }),
  ]);
  expect(existsSync(join(tasksDir(), task.task_id + '.json'))).toBe(true);
  mocks.listIdentities.mockResolvedValue([]);
  if (obstruction === 'identity') mocks.listIdentities.mockResolvedValue([{ name: 'member-1', cid: 'ab'.repeat(32) }]);
  if (obstruction === 'archive') writeFileSync(join(archive, '.identity'), 'wrong-owner');
  if (obstruction === 'replacement') mkdirSync(join(stateRoot(), 'tmp', 'member-1'), { recursive: true });
  if (obstruction === 'unknown') mocks.liveness.mockResolvedValue('unknown');
  if (obstruction !== 'none') {
    await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).rejects.toThrow();
    expect(existsSync(join(tasksDir(), task.task_id + '.json'))).toBe(true);
    expect(readTaskDeletionReceipt(task.task_id)?.result).toBeUndefined();
    expect(mocks.removeIdentity).not.toHaveBeenCalled();
    return;
  }
  expect((await settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).deleted).toBe(true);
  expect(existsSync(join(tasksDir(), task.task_id + '.json'))).toBe(false);
  expect(readTaskDeletionReceipt(task.task_id)).toMatchObject({
    result: 'deleted',
    archived_absences: [expect.objectContaining({ name: 'member-1', archive_path: archive })],
  });
  expect(mocks.removeIdentity).not.toHaveBeenCalled();
});

// Exercise real #179 archived-absence proofs with PR176-owned recovery artifacts.
it.each(['before collection', 'collection', 'workspace deletion'] as const)('resumes after a crash following %s consumed archive evidence', async seam => {
  const task = createTask({ title: 'Owned archived failure cleanup' });
  updateTaskRoom(task.task_id, roomId);
  const room = getRoomRecord(roomId)!;
  room.task_id = task.task_id;
  room.workspace = task.workspace;
  writeFileSync(join(stateRoot(), 'rooms', roomId + '.json'), JSON.stringify(room));
  writeFileSync(join(archive, 'role.yaml'), stringify({ name: 'member-1', roomMemberStartup: { workspace: task.workspace } }));
  writeFileSync(join(archive, 'termination.jsonl'), JSON.stringify({ version: 1, role: 'member-1', launchId: 'launch-1', outcome: 'failed' }) + '\n');
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  const remote = { closeRoom: async () => {}, deleteRoom: async () => {} };
  if (seam === 'before collection') {
    vi.spyOn(workspaceArtifacts, 'collectWorkspaceArchives').mockImplementationOnce(() => {
      throw new Error('crash after checkpoint');
    });
  } else if (seam === 'collection') {
    const collect = workspaceArtifacts.collectWorkspaceArchives;
    vi.spyOn(workspaceArtifacts, 'collectWorkspaceArchives').mockImplementationOnce(w => {
      collect(w); throw new Error('crash after collection');
    });
  } else {
    const remove = workspaceLifecycle.deleteWorkspace;
    vi.spyOn(workspaceLifecycle, 'deleteWorkspace').mockImplementationOnce((...args) => {
      remove(...args); throw new Error('crash after workspace deletion');
    });
  }
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).rejects.toThrow('crash after');
  expect(existsSync(archive)).toBe(seam === 'before collection');
  if (seam === 'before collection') {
    writeFileSync(join(archive, '.identity'), 'wrong-owner');
    await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).rejects.toThrow('ownership proof mismatch');
    writeFileSync(join(archive, '.identity'), 'member-1');
    mocks.liveness.mockResolvedValue('unknown');
    await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).rejects.toThrow('absence is not proven');
    mocks.liveness.mockResolvedValue('stopped');
  }
  expect(getDeletingTask(task.task_id).deletion?.workspace_cleanup_started_at).toBeTruthy();
  expect(readTaskDeletionReceipt(task.task_id)?.result).toBeUndefined();
  // Consuming old artifacts never grants permission to ignore replacement state.
  const live = join(stateRoot(), 'tmp', 'member-1');
  mkdirSync(live, { recursive: true });
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).rejects.toThrow('replacement live state');
  rmSync(live, { recursive: true });
  mocks.listIdentities.mockResolvedValue([{ name: 'member-1', cid: 'ab'.repeat(32) }]);
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).rejects.toThrow('absence is not proven');
  mocks.listIdentities.mockResolvedValue([]);
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork: () => remote })).resolves.toMatchObject({ deleted: true });
  expect(existsSync(task.workspace!.path)).toBe(false);
  expect(readTaskDeletionReceipt(task.task_id)?.result).toBe('deleted');
});
