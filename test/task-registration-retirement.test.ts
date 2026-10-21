import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const releaseOwner = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/agent-ours/service.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agent-ours/service.js')>(), releaseManagedAgent: releaseOwner,
}));
const daemon = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock('../src/client-profile.js', () => ({
  readClientProfile: () => ({ endpoint: 'http://fixture', expectedInstanceId: 'fixture', credentialPath: '/fixture' }),
}));
vi.mock('@ours.network/sdk/client', () => ({ attachOursClient: async () => ({
  listIdentities: daemon.list, removeIdentity: daemon.remove,
  releaseLease: async () => {}, close: async () => {},
}) }));
import { archiveTempState, prepareTempSupervisor, TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';
import { binderKey } from '../src/agent-ours/state.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { createTask, updateTaskRoom } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, getRoomRecord, updateMemberSeats } from '../src/rooms-tasks/room-state.js';
import { closeManagedRoom } from '../src/rooms-tasks/close.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-registration-retire-'));
  vi.stubEnv('OURS_FLEET_HOME', root); vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const task = createTask({ title: 'Lost member state', origin: { type: 'cli' }, start: false });
  const name = 'OwnedWorker', action = 'owned-action', launch = 'owned-launch', cid = 'ab'.repeat(32);
  const room = createRoomRecord({ room_id: 'owned-room', room_name: 'Owned',
    task_id: task.task_id, room_identity_cid: 'cd'.repeat(32) });
  updateTaskRoom(task.task_id, room.room_id, room.room_identity_cid!);
  updateMemberSeats(room.room_id, [{ role_name: name, identity_cid: cid, slot: 'dev',
    cowork_role: 'Developer', seat_state: 'active', launch: {
      state: 'launched', attempt: 1, action_id: action, launch_id: launch,
      task_supervised: true, updated_at: '',
    } }]);
  const permanent = agentDir('PersonalAssistant'); mkdirSync(permanent, { recursive: true });
  writeFileSync(join(permanent, '.identity'), 'PersonalAssistant');
  writeFileSync(join(permanent, '.session-id'), 'retained-permanent-conversation');
  let identities = [{ name, cid }, { name: 'PersonalAssistant', cid: 'ef'.repeat(32) }];
  const events: string[] = [];
  daemon.list.mockImplementation(async () => identities);
  daemon.remove.mockImplementation(async ({ name: removing }) => {
    events.push('remove-identity'); identities = identities.filter(row => row.name !== removing);
  });
  const closeRoom = vi.fn(async () => { events.push('close-room'); });
  return { task, room, name, action, launch, cid, permanent, events, closeRoom };
}

function restoreStoppedProof(f: ReturnType<typeof fixture>) {
  const dir = agentDir(f.name, true); mkdirSync(dir, { recursive: true });
  const supervisor = prepareTempSupervisor(dir, f.name, { taskId: f.task.task_id,
    roomId: f.room.room_id, roomIdentityCid: f.room.room_identity_cid!, creationActionId: f.action });
  writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...supervisor, launchId: f.launch,
    kind: 'fleet-managed', target: 'task-' + f.name, phase: 'stopped' }));
  writeFileSync(join(dir, '.identity'), f.name);
  writeFileSync(join(dir, 'role.yaml'), JSON.stringify({ name: f.name, identity: f.name }));
  writeFileSync(join(dir, 'creation.json'), JSON.stringify({ role: f.name, creationActionId: f.action }));
  const privateDir = join(stateRoot(), 'private-ours', binderKey('fixture', f.name)); mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, 'instance.json'), JSON.stringify({ instance: 'owned-runtime' }));
  // Registration tests delegate runtime retirement to its separately qualified
  // exact-owner seam. The production process gate uses the real SDK lease.
  releaseOwner.mockImplementation(async () => { f.events.push('release-owner'); });
  expect(archiveTempState(f.name, 'operator-stop', 'retired', 'restored exact fixture proof')).toBeTruthy();
}

it('retires registration but refuses identity removal without launch proof, then retries from its restored exact archive', async () => {
  const f = fixture();
  const retire = vi.fn(async () => { f.events.push('retire-registration'); });
  const input = { roomId: f.room.room_id, cowork: { closeRoom: f.closeRoom }, deps: { retireTaskService: retire } };
  await expect(closeManagedRoom(input)).rejects.toThrow('MEMBER_RUNTIME_RETIREMENT_SOURCE_MISSING');
  expect(daemon.remove).not.toHaveBeenCalled(); expect(releaseOwner).not.toHaveBeenCalled(); expect(f.closeRoom).not.toHaveBeenCalled();
  expect(f.events).toEqual(['retire-registration']);
  expect(getRoomRecord(f.room.room_id)?.member_seats[0].retirement).toBeUndefined();
  restoreStoppedProof(f); await closeManagedRoom(input);
  expect(retire).toHaveBeenCalledWith(f.name, {
    taskId: f.task.task_id, creationActionId: f.action, launchId: f.launch, taskSupervised: true,
  });
  expect(f.events).toEqual(['retire-registration', 'retire-registration', 'release-owner', 'remove-identity', 'close-room']);
  expect(getRoomRecord(f.room.room_id)?.member_seats[0].retirement?.phase).toBe('identity_absent');
  expect(releaseOwner).toHaveBeenCalledWith(expect.objectContaining({ name: f.name, identity: f.name }), { cid: f.cid, action: f.action });
  expect(daemon.remove).toHaveBeenCalledTimes(1);
  expect(daemon.remove).toHaveBeenCalledWith({ name: f.name });
  expect(readFileSync(join(f.permanent, '.session-id'), 'utf8')).toBe('retained-permanent-conversation');
});

it('keeps missing-state cleanup retryable when registration retirement cannot establish quiescence', async () => {
  const f = fixture();
  const retire = vi.fn(async () => { f.events.push('retire-registration'); })
    .mockRejectedValueOnce(Error('TASK_REGISTRATION_PROCESS_UNKNOWN'));
  const input = { roomId: f.room.room_id, cowork: { closeRoom: f.closeRoom }, deps: { retireTaskService: retire } };
  await expect(closeManagedRoom(input)).rejects.toThrow('TASK_REGISTRATION_PROCESS_UNKNOWN');
  expect(daemon.remove).not.toHaveBeenCalled(); expect(f.closeRoom).not.toHaveBeenCalled();
  expect(getRoomRecord(f.room.room_id)?.member_seats[0].retirement).toBeUndefined();
  restoreStoppedProof(f); await closeManagedRoom(input);
  expect(retire).toHaveBeenCalledTimes(2);
  expect(f.events).toEqual(['retire-registration', 'release-owner', 'remove-identity', 'close-room']);
  expect(getRoomRecord(f.room.room_id)?.member_seats[0].retirement?.phase).toBe('identity_absent');
  expect(readFileSync(join(f.permanent, '.session-id'), 'utf8')).toBe('retained-permanent-conversation');
});

it('rechecks retained registrations when retrying a room that already recorded closure', async () => {
  const f = fixture(), retire = vi.fn(async () => {}); restoreStoppedProof(f);
  const input = { roomId: f.room.room_id, cowork: { closeRoom: f.closeRoom }, deps: { retireTaskService: retire } };
  await closeManagedRoom(input);
  expect(getRoomRecord(f.room.room_id)?.state).toBe('closed');
  retire.mockRejectedValueOnce(Error('TASK_REGISTRATION_OWNER_MISMATCH'));
  await expect(closeManagedRoom(input)).rejects.toThrow('TASK_REGISTRATION_OWNER_MISMATCH');
  expect(retire).toHaveBeenCalledTimes(2);
  expect(retire.mock.calls[1]).toEqual([f.name, {
    taskId: f.task.task_id, creationActionId: f.action, launchId: f.launch, taskSupervised: true,
  }]);
  expect(daemon.remove).toHaveBeenCalledTimes(1); expect(f.closeRoom).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(f.permanent, '.session-id'), 'utf8')).toBe('retained-permanent-conversation');
});
