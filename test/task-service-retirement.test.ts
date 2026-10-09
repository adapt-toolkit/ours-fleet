import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const calls = vi.hoisted(() => ({ exec: vi.fn(), identities: vi.fn(async () => []), remove: vi.fn(async () => {}) }));
vi.mock('../src/exec.js', () => ({ realExec: calls.exec }));
vi.mock('../src/client-profile.js', () => ({ readClientProfile: () => ({ endpoint: 'http://fixture', expectedInstanceId: 'fixture-daemon', credentialPath: '/fixture' }), clientConfigPath: () => '/fixture/profile' }));
vi.mock('@ours.network/sdk/client', () => ({ attachOursClient: async () => ({ listIdentities: calls.identities, removeIdentity: calls.remove, releaseLease: async () => {}, close: async () => {} }) }));
import { createTask, updateTaskRoom, beginTaskDeletionIntent, getDeletingTask } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, updateMemberSeats, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { closeManagedRoom } from '../src/rooms-tasks/close.js';
import { settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { taskSystemdUnit, assertTaskServicesAbsent } from '../src/task-supervisor-service.js';
import { memberKey, memberPath, readMember, registerMember } from '../src/supervisor/catalog.js';
import { retireTaskMemberService } from '../src/rooms-tasks/task-service-retirement.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { TaskLayouts } from '../src/application/task-layouts.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-service-retirement-')); vi.stubEnv('OURS_FLEET_HOME', root); vi.clearAllMocks();
  calls.exec.mockImplementation(async (_cmd, args) => ({ code: 0, stdout: args.includes('LoadState') ? 'not-found\n' : 'inactive\n', stderr: '' }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const task = createTask({ title: 'Retire missing state', start: false, origin: { type: 'cli' } });
  const name = 'MissingTaskWorker', action = 'original-action', launch = 'original-launch';
  const dir = agentDir(name, true);
  // Saved old native proof is deliberately seeded. New installs use the common
  // parent/catalog and never manufacture this legacy artifact.
  const taskOwner = { taskId: task.task_id, roomId: 'owned-room', roomIdentityCid: 'cd'.repeat(32), creationActionId: action };
  const bytes = '[Service]\nExecStart=/fixture/fleet _run-temp MissingTaskWorker\n';
  const unit = join(root, '.config', 'systemd', 'user', taskSystemdUnit(name));
  const owner = join(stateRoot(), 'task-supervisors', `${name}.json`);
  mkdirSync(join(unit, '..'), { recursive: true }); mkdirSync(join(owner, '..'), { recursive: true });
  writeFileSync(unit, bytes);
  writeFileSync(owner, JSON.stringify({ version: 1, role: name, taskOwner, launchId: launch,
    kind: 'systemd-persistent', target: taskSystemdUnit(name), fileHash: createHash('sha256').update(bytes).digest('hex') }));
  calls.exec.mockClear();
  const permanent = agentDir('PersonalAssistant'); mkdirSync(permanent, { recursive: true }); writeFileSync(join(permanent, '.session-id'), 'same-permanent-context');
  return { task, name, action, launch, dir, unit, owner, permanent, taskOwner };
}
it('removes a proven service before the missing-state room seat takes its identity-absence shortcut', async () => {
  const f = await fixture();
  createRoomRecord({ room_id: 'owned-room', room_name: 'Owned', task_id: f.task.task_id, room_identity_cid: 'cd'.repeat(32) });
  updateTaskRoom(f.task.task_id, 'owned-room', 'cd'.repeat(32));
  updateMemberSeats('owned-room', [{ role_name: f.name, identity_cid: 'ab'.repeat(32), slot: 'dev', cowork_role: 'Developer', seat_state: 'active',
    launch: { state: 'launched', attempt: 1, action_id: f.action, launch_id: f.launch, updated_at: '' } }]);
  await closeManagedRoom({ roomId: 'owned-room', cowork: { closeRoom: vi.fn(async () => {}) } });
  expect(existsSync(f.unit)).toBe(false); expect(existsSync(f.owner)).toBe(false);
  expect(getRoomRecord('owned-room')?.member_seats[0].retirement?.phase).toBe('identity_absent');
  expect(calls.exec).toHaveBeenCalledWith('systemctl', ['--user', 'disable', '--now', taskSystemdUnit(f.name)]);
  expect(readFileSync(join(f.permanent, '.session-id'), 'utf8')).toBe('same-permanent-context');
});
it('removes actual central registration with lost tmp state and rejects a foreign reappeared registration on closed retry', async () => {
  const f = await fixture(); rmSync(f.unit); rmSync(f.owner);
  await registerMember({ name: 'PersonalAssistant', kind: 'permanent', dir: f.permanent }, { initialDesired: 'stopped' });
  const permanent = readFileSync(memberPath(memberKey('PersonalAssistant', 'permanent')));
  await registerMember({ name: f.name, kind: 'task', dir: f.dir, taskOwner: f.taskOwner, launchId: f.launch });
  createRoomRecord({ room_id: 'owned-room', room_name: 'Owned', task_id: f.task.task_id, room_identity_cid: 'cd'.repeat(32) });
  updateTaskRoom(f.task.task_id, 'owned-room', 'cd'.repeat(32));
  updateMemberSeats('owned-room', [{ role_name: f.name, identity_cid: 'ab'.repeat(32), slot: 'dev', cowork_role: 'Developer', seat_state: 'active',
    launch: { state: 'launched', attempt: 1, action_id: f.action, launch_id: f.launch, task_supervised: true, updated_at: '' } }]);
  const closeRoom = vi.fn(async () => {});
  await closeManagedRoom({ roomId: 'owned-room', cowork: { closeRoom } });
  expect(readMember(memberKey(f.name, 'task'))).toBeUndefined();
  await registerMember({ name: f.name, kind: 'task', dir: f.dir, taskOwner: { ...f.taskOwner, creationActionId: 'foreign' }, launchId: 'foreign' });
  await expect(closeManagedRoom({ roomId: 'owned-room', cowork: { closeRoom } })).rejects.toThrow('OWNER_MISMATCH');
  expect(readMember(memberKey(f.name, 'task'))?.taskOwner?.creationActionId).toBe('foreign');
  expect(readFileSync(memberPath(memberKey('PersonalAssistant', 'permanent')))).toEqual(permanent);
  expect(closeRoom).toHaveBeenCalledTimes(1); expect(calls.remove).not.toHaveBeenCalled();
  expect(calls.exec.mock.calls.some(([cmd, args]) => cmd === 'systemctl' && args.includes('disable'))).toBe(false);
});
it('preserves cleanup evidence on manager failure and rejects a replaced service file', async () => {
  const f = await fixture(), expected = { taskId: f.task.task_id, creationActionId: f.action, launchId: f.launch };
  calls.exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'bus unavailable' });
  await expect(retireTaskMemberService(f.name, expected)).rejects.toThrow('TASK_SERVICE_DISABLE_FAILED');
  expect(existsSync(f.unit)).toBe(true); expect(existsSync(f.owner)).toBe(true);
  writeFileSync(f.unit, '[Service]\nExecStart=/unrelated/program\n'); calls.exec.mockClear();
  await expect(retireTaskMemberService(f.name, expected)).rejects.toThrow('TASK_SERVICE_FILE_MISMATCH');
  expect(calls.exec).not.toHaveBeenCalled(); expect(existsSync(f.owner)).toBe(true);
});
it('keeps a task deletion retryable when its lost room cursor cannot prove the surviving service action', async () => {
  const f = await fixture();
  const { updateTaskMembers } = await import('../src/rooms-tasks/task-state.js');
  updateTaskMembers(f.task.task_id, [{ name: f.name, identity_cid: 'ab'.repeat(32), cowork_role: 'Developer' }]);
  beginTaskDeletionIntent(f.task.task_id, { kind: 'local_control', surface: 'cli' });
  await expect(settleTaskDeletion({ taskId: f.task.task_id, cowork: { closeRoom: async () => {}, deleteRoom: async () => {} } })).rejects.toThrow('TASK_SERVICE_OWNER_MISMATCH');
  expect(getDeletingTask(f.task.task_id).deletion?.status).toBe('pending');
  expect(existsSync(f.unit)).toBe(true); expect(calls.remove).not.toHaveBeenCalled();
});
it('refuses to forget a lost layout run while its proven owned service survives', async () => {
  const f = await fixture();
  expect(() => assertTaskServicesAbsent(f.task.task_id)).toThrow('TASK_SERVICES_REMAIN');
  await expect(new TaskLayouts().closeAndForget({ task_id: f.task.task_id,
    layout: { name: 'retained', run_id: `task-${f.task.task_id}`, definition_hash: 'hash' } })).rejects.toThrow('TASK_SERVICES_REMAIN');
  expect(existsSync(f.unit)).toBe(true);
});
it('requires manager absence for a new boot-service intent whose local proof was lost, while preserving legacy compatibility', async () => {
  const f = await fixture(); rmSync(f.unit); rmSync(f.owner);
  calls.exec.mockResolvedValue({ code: 1, stdout: '', stderr: 'bus unavailable' });
  await expect(retireTaskMemberService(f.name, { taskId: f.task.task_id, creationActionId: f.action, taskSupervised: true })).rejects.toThrow('TASK_SERVICE_ABSENCE_UNPROVEN');
  calls.exec.mockClear();
  await retireTaskMemberService(f.name, { taskId: f.task.task_id });
  expect(calls.exec).not.toHaveBeenCalled();
});
