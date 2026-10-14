import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const calls = vi.hoisted(() => ({ exec: vi.fn(), identities: vi.fn(async () => []), remove: vi.fn(async () => {}) }));
vi.mock('../src/exec.js', () => ({ realExec: calls.exec }));
vi.mock('../src/client-profile.js', () => ({ readClientProfile: () => ({ endpoint: 'http://fixture', expectedInstanceId: 'fixture-daemon', credentialPath: '/fixture' }), clientConfigPath: () => '/fixture/profile' }));
vi.mock('@ours.network/sdk/client', () => ({ attachOursClient: async () => ({ listIdentities: calls.identities, removeIdentity: calls.remove, releaseLease: async () => {}, close: async () => {} }) }));
import { createTask, updateTaskRoom, beginTaskDeletionIntent, getDeletingTask } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, updateMemberSeats, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { closeManagedRoom } from '../src/rooms-tasks/close.js';
import { settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { memberKey, memberPath, readMember, registerMember, assertTaskRegistrationsAbsent } from '../src/supervisor/catalog.js';
import { retireTaskMemberService } from '../src/rooms-tasks/task-service-retirement.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { prepareTempSupervisor, TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';
import { eraseMemberArtifacts } from '../src/rooms-tasks/erasure.js';
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
  const taskOwner = { taskId: task.task_id, roomId: 'owned-room', roomIdentityCid: 'cd'.repeat(32), creationActionId: action };
  await registerMember({ name, kind: 'task', dir, taskOwner, launchId: launch });
  calls.exec.mockClear();
  const permanent = agentDir('PersonalAssistant'); mkdirSync(permanent, { recursive: true }); writeFileSync(join(permanent, '.session-id'), 'same-permanent-context');
  return { task, name, action, launch, dir, permanent, taskOwner };
}

it('removes actual central registration with lost tmp state and rejects a foreign reappeared registration on closed retry', async () => {
  const f = await fixture();
  await registerMember({ name: 'PersonalAssistant', kind: 'permanent', dir: f.permanent }, { initialDesired: 'stopped' });
  const permanent = readFileSync(memberPath(memberKey('PersonalAssistant', 'permanent')));
  createRoomRecord({ room_id: 'owned-room', room_name: 'Owned', task_id: f.task.task_id, room_identity_cid: 'cd'.repeat(32) });
  updateTaskRoom(f.task.task_id, 'owned-room', 'cd'.repeat(32));
  updateMemberSeats('owned-room', [{ role_name: f.name, identity_cid: 'ab'.repeat(32), slot: 'dev', cowork_role: 'Developer', seat_state: 'active',
    launch: { state: 'launched', attempt: 1, action_id: f.action, launch_id: f.launch, task_supervised: true, updated_at: '' } }]);
  const bad = join(stateRoot(), 'recovery/temporary/unsupported'); mkdirSync(bad, { recursive: true });
  const unsupported = prepareTempSupervisor(bad, 'Unsupported');
  const bytes = JSON.stringify({ ...unsupported, kind: 'newer-kind' });
  writeFileSync(join(bad, TEMP_SUPERVISOR_FILE), bytes);
  const closeRoom = vi.fn(async () => {});
  calls.identities.mockImplementationOnce(async () => {
    expect(readMember(memberKey(f.name, 'task'))).toBeUndefined();
    return [];
  });
  await closeManagedRoom({ roomId: 'owned-room', cowork: { closeRoom } });
  expect(calls.identities).toHaveBeenCalledTimes(1);
  expect(readMember(memberKey(f.name, 'task'))).toBeUndefined();
  await eraseMemberArtifacts('task', f.task.task_id, getRoomRecord('owned-room')!.member_seats, ['owned-room']);
  expect(readFileSync(join(bad, TEMP_SUPERVISOR_FILE), 'utf8')).toBe(bytes);
  await registerMember({ name: f.name, kind: 'task', dir: f.dir, taskOwner: { ...f.taskOwner, creationActionId: 'foreign' }, launchId: 'foreign' });
  await expect(closeManagedRoom({ roomId: 'owned-room', cowork: { closeRoom } })).rejects.toThrow('OWNER_MISMATCH');
  expect(readMember(memberKey(f.name, 'task'))?.taskOwner?.creationActionId).toBe('foreign');
  expect(readFileSync(memberPath(memberKey('PersonalAssistant', 'permanent')))).toEqual(permanent);
  expect(closeRoom).toHaveBeenCalledTimes(1); expect(calls.remove).not.toHaveBeenCalled();
  expect(calls.exec.mock.calls.some(([cmd, args]) => cmd === 'systemctl' && args.includes('disable'))).toBe(false);
});

it('keeps a task deletion retryable when its lost room cursor cannot prove the surviving registration action', async () => {
  const f = await fixture();
  const { updateTaskMembers } = await import('../src/rooms-tasks/task-state.js');
  updateTaskMembers(f.task.task_id, [{ name: f.name, identity_cid: 'ab'.repeat(32), cowork_role: 'Developer' }]);
  beginTaskDeletionIntent(f.task.task_id, { kind: 'local_control', surface: 'cli' });
  await expect(settleTaskDeletion({ taskId: f.task.task_id, cowork: { closeRoom: async () => {}, deleteRoom: async () => {} } })).rejects.toThrow('TASK_SERVICE_OWNER_MISMATCH');
  expect(getDeletingTask(f.task.task_id).deletion?.status).toBe('pending');
  expect(readMember(memberKey(f.name, 'task'))?.taskOwner).toEqual(f.taskOwner); expect(calls.remove).not.toHaveBeenCalled();
});
it('refuses to forget a lost layout run while its owned catalog registration survives', async () => {
  const f = await fixture();
  expect(() => assertTaskRegistrationsAbsent(f.task.task_id)).toThrow('TASK_SERVICES_REMAIN');
  await expect(new TaskLayouts().closeAndForget({ task_id: f.task.task_id,
    layout: { name: 'retained', run_id: `task-${f.task.task_id}`, definition_hash: 'hash' } })).rejects.toThrow('TASK_SERVICES_REMAIN');
  expect(readMember(memberKey(f.name, 'task'))?.taskOwner).toEqual(f.taskOwner);
});
it('does not invent native services when the task registration is already absent or the member is legacy transient', async () => {
  const f = await fixture();
  await retireTaskMemberService(f.name, { taskId: f.task.task_id, creationActionId: f.action, taskSupervised: true });
  calls.exec.mockClear();
  await retireTaskMemberService(f.name, { taskId: f.task.task_id, creationActionId: f.action, taskSupervised: true });
  await retireTaskMemberService(f.name, { taskId: f.task.task_id });
  expect(calls.exec).not.toHaveBeenCalled();
});
