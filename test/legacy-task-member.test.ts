import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { gatewayFixture } from './gateway-fixture.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { binderKey } from '../src/agent-ours/state.js';
import { createTask, startTask, updateTaskRoom, beginTaskDeletionIntent } from '../src/rooms-tasks/task-state.js';
import { createRoomRecord, updateMemberSeats } from '../src/rooms-tasks/room-state.js';
import { adoptLegacyTaskMember } from '../src/rooms-tasks/legacy-task-member.js';
import { prepareTempSupervisor, readTempSupervisor } from '../src/temp-lifecycle.js';
import { readClientProfile } from '../src/client-profile.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-task-'));
  vi.stubEnv('OURS_FLEET_HOME', root);
  vi.stubEnv('OURS_CONFIG', gatewayFixture(root).env.OURS_CONFIG);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const task = createTask({ title: 'Retained', start: false, origin: { type: 'cli' } });
  startTask(task.task_id);
  const name = 'LegacyDeveloper', cid = 'ab'.repeat(32), roomCid = 'cd'.repeat(32), roomId = 'legacy-room', action = 'original-action';
  updateTaskRoom(task.task_id, roomId, roomCid);
  const room = createRoomRecord({ room_id: roomId, room_name: 'Retained', room_identity_cid: roomCid, task_id: task.task_id });
  const dir = agentDir(name, true); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.yaml'), stringify({ name, identity: name, session: 'acp', cwd: room.workspace?.path, roomMemberStartup: {
    room_id: roomId, room_identity_cid: roomCid, identity_name: name, invite_id: 'consumed', invite: '', role: 'Developer',
    workspace: room.workspace,
  } }));
  writeFileSync(join(dir, '.identity'), name); writeFileSync(join(dir, '.acp-session-id'), 'same-conversation');
  writeFileSync(join(dir, 'creation.json'), JSON.stringify({ role: name, creationActionId: action }));
  const supervisor = prepareTempSupervisor(dir, name);
  updateMemberSeats(roomId, [{ role_name: name, identity_cid: cid, slot: 'dev', cowork_role: 'Developer', seat_state: 'active', invite_id: 'consumed',
    launch: { action_id: action, launch_id: supervisor.launchId, state: 'launched', attempt: 1, updated_at: '' } }]);
  const daemon = readClientProfile(process.env).expectedInstanceId, privateDir = join(stateRoot(), 'private-ours', binderKey(daemon, name));
  mkdirSync(privateDir, { recursive: true });
  const state = { version: 1, instance: 'same-instance', name, daemon, lifetime: 'temporary', action, cid, phase: 'RECOVERING',
    room: { id: roomId, cid: roomCid, agentCid: cid, action: 'consumed', seat: 'Developer' } };
  writeFileSync(join(privateDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(privateDir, 'instance.json'), JSON.stringify({ instance: 'same-instance', role: name, temporary: true }));
  writeFileSync(join(privateDir, 'owner.json'), JSON.stringify({ instance: 'same-instance', token: 'fixture-owner' }));
  mkdirSync(join(stateRoot(), 'private-ours', 'launches'), { recursive: true });
  writeFileSync(join(stateRoot(), 'private-ours', 'launches', binderKey('temporary', name) + '.json'), JSON.stringify({ role: name, identity: name, action }));
  return { dir, task, name, supervisor, privateDir, state,
    owner: { taskId: task.task_id, roomId, roomIdentityCid: roomCid, creationActionId: action },
    deps: { liveness: vi.fn(async () => 'stopped' as const), verifyIdentity: vi.fn(async () => {}) } };
}
it('adopts only metadata and preserves original launch, conversation, identity and runtime bytes', async () => {
  const f = fixture(), runtime = readFileSync(join(f.privateDir, 'state.json'));
  expect(await adoptLegacyTaskMember(f.owner, f.name, f.deps)).toBe('adopted');
  expect(readTempSupervisor(f.dir)?.launchId).toBe(f.supervisor.launchId);
  expect(readFileSync(join(f.dir, '.acp-session-id'), 'utf8')).toBe('same-conversation');
  expect(readFileSync(join(f.privateDir, 'state.json'))).toEqual(runtime);
  expect(parse(readFileSync(join(f.dir, 'role.yaml'), 'utf8')).roomMemberStartup.task_id).toBe(f.task.task_id);
  expect(await adoptLegacyTaskMember(f.owner, f.name, f.deps)).toBe('already-durable');
  expect(f.deps.verifyIdentity).toHaveBeenCalledTimes(1);
});
it('leaves a live transient unchanged and never verifies/reattaches its identity', async () => {
  const f = fixture(), before = readFileSync(join(f.dir, 'role.yaml'));
  f.deps.liveness.mockResolvedValue('running' as never);
  expect(await adoptLegacyTaskMember(f.owner, f.name, f.deps)).toBe('running-legacy');
  expect(readFileSync(join(f.dir, 'role.yaml'))).toEqual(before);
  expect(f.deps.verifyIdentity).not.toHaveBeenCalled();
});
it('heals a crash after role snapshot update without rotating any identity or launch', async () => {
  const f = fixture();
  await expect(adoptLegacyTaskMember(f.owner, f.name, { ...f.deps, beforeOwnerCommit: () => { throw Error('crash'); } })).rejects.toThrow('crash');
  expect(await adoptLegacyTaskMember(f.owner, f.name, f.deps)).toBe('adopted');
  expect(readTempSupervisor(f.dir)?.launchId).toBe(f.supervisor.launchId);
});
it.each(['deleted', 'action', 'retired-runtime', 'wrong-cid', 'unknown-liveness', 'permanent',
  'runtime-cid', 'runtime-owner', 'runtime-instance', 'conversation', 'room-action', 'wrong-daemon'])('refuses unsafe migration: %s', async mode => {
  const f = fixture();
  if (mode === 'deleted') beginTaskDeletionIntent(f.task.task_id, { kind: 'local_control', surface: 'cli' });
  if (mode === 'action') f.owner.creationActionId = 'wrong-action';
  if (mode === 'retired-runtime') writeFileSync(join(f.privateDir, 'state.json'), JSON.stringify({ ...f.state, phase: 'RELEASED' }));
  if (mode === 'wrong-cid') f.deps.verifyIdentity.mockRejectedValue(Error('LEGACY_TASK_MEMBER_IDENTITY_MISMATCH'));
  if (mode === 'unknown-liveness') f.deps.liveness.mockResolvedValue('unknown' as never);
  if (mode === 'permanent') mkdirSync(agentDir(f.name), { recursive: true });
  if (mode === 'runtime-cid') writeFileSync(join(f.privateDir, 'state.json'), JSON.stringify({ ...f.state, cid: 'ef'.repeat(32) }));
  if (mode === 'runtime-owner') writeFileSync(join(f.privateDir, 'owner.json'), JSON.stringify({ instance: 'replacement', token: 'fixture-owner' }));
  if (mode === 'runtime-instance') writeFileSync(join(f.privateDir, 'instance.json'), JSON.stringify({ instance: 'replacement', role: f.name, temporary: true }));
  if (mode === 'conversation') rmSync(join(f.dir, '.acp-session-id'));
  if (mode === 'room-action') writeFileSync(join(f.privateDir, 'state.json'), JSON.stringify({ ...f.state, room: { ...f.state.room, action: 'new-invite' } }));
  if (mode === 'wrong-daemon') writeFileSync(join(f.privateDir, 'state.json'), JSON.stringify({ ...f.state, daemon: 'different-daemon' }));
  const before = readFileSync(join(f.dir, 'role.yaml'));
  await expect(adoptLegacyTaskMember(f.owner, f.name, f.deps)).rejects.toThrow();
  expect(readFileSync(join(f.dir, 'role.yaml'))).toEqual(before);
});
