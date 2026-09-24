import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sdk = vi.hoisted(() => ({ listIdentities: vi.fn(), removeIdentity: vi.fn(), releaseLease: vi.fn(), close: vi.fn(), profile: vi.fn() }));
vi.mock('@ours.network/sdk/client', () => ({ attachOursClient: async () => sdk }));
vi.mock('../src/client-profile.js', () => ({ readClientProfile: sdk.profile }));
vi.mock('../src/temp-lifecycle.js', async original => ({ ...await original<typeof import('../src/temp-lifecycle.js')>(), tempSupervisorLiveness: async () => 'stopped' }));
import { closeManagedRoom, deleteManagedRoom } from '../src/rooms-tasks/close.js';
import { createRoomRecord, updateMemberSeats, getRoomRecord, beginRoomClose, advanceMemberRetirement } from '../src/rooms-tasks/room-state.js';
import { CoworkProtocolError } from '../src/rooms-tasks/cowork-adapter.js';
import { stateRoot } from '../src/paths.js';
import { eraseMemberArtifacts } from '../src/rooms-tasks/erasure.js';
import { createTask, beginTaskDeletionIntent, readTaskDeletionReceipt, updateTaskRoom } from '../src/rooms-tasks/task-state.js';
import { settleTaskDeletion } from '../src/rooms-tasks/deletion.js';
import { binderKey } from '../src/agent-ours/state.js';
import * as roomState from '../src/rooms-tasks/room-state.js';
import * as atomic from '../src/atomic-file.js';
import type { RoomMemberSeat, MemberRetirementPhase } from '../src/rooms-tasks/types.js';
let home: string, prior: string | undefined;
const id = 'room-delete-fixture', cid = 'ab'.repeat(32), roomCid = 'cd'.repeat(32);
const seat = (): RoomMemberSeat => ({ role_name: 'member-1', slot: 'dev', cowork_role: 'Developer', seat_state: 'pending',
  launch: { state: 'failed', attempt: 1, action_id: 'action-1', launch_id: 'launch-1', updated_at: '2026-01-01' } });
const cowork = () => ({ closeRoom: vi.fn(async () => {}), deleteRoom: vi.fn(async () => {}) });
function write(path: string, value: unknown) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-erase-')); prior = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = home;
  sdk.profile.mockReset().mockReturnValue(undefined);
  sdk.listIdentities.mockReset().mockResolvedValue([]); sdk.removeIdentity.mockReset().mockResolvedValue(undefined);
  sdk.releaseLease.mockResolvedValue(undefined); sdk.close.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); if (prior === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = prior; rmSync(home, { recursive: true, force: true }); });

it.each([undefined, 'stop_requested', 'liveness_absent', 'archive_secured', 'identity_absent'] as const)(
  'deletes absent members at retirement phase %s and converges on repeat', async phase => {
    createRoomRecord({ room_id: id, room_name: 'erase' }); updateMemberSeats(id, [seat()]);
    if (phase) { beginRoomClose(id); advanceMemberRetirement(id, 'member-1', phase, 'launch-1'); }
    const remote = cowork(); await deleteManagedRoom({ roomId: id, cowork: remote });
    expect(getRoomRecord(id)).toBeUndefined();
    await deleteManagedRoom({ roomId: id, cowork: remote });
    expect(sdk.removeIdentity).not.toHaveBeenCalled();
  });
it('tolerates already-absent remote close and deletion', async () => {
  createRoomRecord({ room_id: id, room_name: 'erase' });
  const remote = { closeRoom: vi.fn(async () => { throw new CoworkProtocolError('close', 'gone', 'not_found'); }), deleteRoom: vi.fn(async () => { throw new CoworkProtocolError('close', 'gone', 'not_found'); }) };
  await deleteManagedRoom({ roomId: id, cowork: remote }); await deleteManagedRoom({ roomId: id, cowork: remote });
  expect(getRoomRecord(id)).toBeUndefined();
});
it('does not report corrupt local state as already deleted', async () => {
  writeFileSync(join(stateRoot(), '..', 'irrelevant'), 'unrelated');
  mkdirSync(join(stateRoot(), 'rooms'), { recursive: true }); writeFileSync(join(stateRoot(), 'rooms', id + '.json'), '{');
  const remote = cowork(); await expect(deleteManagedRoom({ roomId: id, cowork: remote })).rejects.toThrow();
  expect(remote.deleteRoom).not.toHaveBeenCalled();
});
it.each(['valid', 'wrong-room', 'ambiguous', 'different-invite'] as const)('recovers only pinned authenticated seats: %s', async mode => {
  createRoomRecord({ room_id: id, room_name: 'erase', room_identity_cid: roomCid });
  updateMemberSeats(id, [{ ...seat(), invite_id: 'invite-1' }]);
  sdk.listIdentities.mockImplementation(async () => sdk.removeIdentity.mock.calls.length ? [] : [{ name: 'member-1', cid }]);
  const matching = { identity_cid: cid, role: 'Developer', invite_id: mode === 'different-invite' ? 'other' : 'invite-1', display_name: 'untrusted', seat_state: 'active' as const };
  const remote = { ...cowork(), getRoom: vi.fn(async () => ({ room_id: id, identity_cid: mode === 'wrong-room' ? 'ef'.repeat(32) : roomCid, identity_name: 'r', room_name: 'r', state: 'closing' as const, anonymous: false, role_briefings: {}, seats: mode === 'ambiguous' ? [matching, matching] : [matching] })) };
  if (mode === 'valid') { await closeManagedRoom({ roomId: id, cowork: remote }); expect(getRoomRecord(id)?.member_seats[0].identity_cid).toBe(cid); expect(sdk.removeIdentity).toHaveBeenCalledWith({ name: 'member-1' }); }
  else { await expect(closeManagedRoom({ roomId: id, cowork: remote })).rejects.toThrow(); expect(sdk.removeIdentity).not.toHaveBeenCalled(); }
});
it('preserves a replacement identity when only its name matches', async () => {
  createRoomRecord({ room_id: id, room_name: 'erase' }); updateMemberSeats(id, [{ ...seat(), identity_cid: cid }]);
  sdk.listIdentities.mockResolvedValue([{ name: 'member-1', cid: 'ef'.repeat(32) }]);
  await expect(deleteManagedRoom({ roomId: id, cowork: cowork() })).rejects.toThrow(/CID mismatch/);
  expect(sdk.removeIdentity).not.toHaveBeenCalled(); expect(getRoomRecord(id)).toBeDefined();
});
function archive(): string {
  const path = join(stateRoot(), 'recovery', 'temporary', 'exact-archive');
  write(join(path, '.temp-supervisor.json'), { version: 1, role: 'member-1', launchId: 'launch-1' });
  write(join(path, 'creation.json'), { role: 'member-1', creationActionId: 'action-1' });
  writeFileSync(join(path, '.identity'), 'member-1');
  writeFileSync(join(path, 'WORKLOG.md'), 'owned private contents');
  return path;
}
it.each(['before-rename', 'after-rename', 'after-remove'] as const)('resumes artifact erasure after crash %s and preserves a replacement', async boundary => {
  const path = archive(), foreign = join(stateRoot(), 'recovery', 'temporary', 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'sentinel'), 'keep');
  const original = atomic.replaceFileAtomically;
  let crashed = false;
  vi.spyOn(atomic, 'replaceFileAtomically').mockImplementation((target, contents, ...rest) => {
    if (target.endsWith(`room-${id}.json`) && !crashed) {
      const manifest = JSON.parse(contents);
      const phase = manifest.phases[path];
      if ((boundary === 'before-rename' && !phase) || (boundary === 'after-rename' && phase === 'renamed') || (boundary === 'after-remove' && phase === 'removed')) {
        crashed = true;
        if (boundary === 'before-rename') original(target, contents, ...rest);
        throw new Error('simulated crash');
      }
    }
    original(target, contents, ...rest);
  });
  await expect(eraseMemberArtifacts('room', id, [seat()], [id])).rejects.toThrow('simulated crash');
  if (existsSync(path)) rmSync(path, { recursive: true });
  mkdirSync(path); writeFileSync(join(path, 'replacement'), 'keep replacement');
  vi.restoreAllMocks();
  if (boundary === 'before-rename') await expect(eraseMemberArtifacts('room', id, [seat()], [id])).rejects.toThrow(/ownership changed/);
  else await eraseMemberArtifacts('room', id, [seat()], [id]);
  expect(readFileSync(join(path, 'replacement'), 'utf8')).toBe('keep replacement'); expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('keep');
});
it('erases legacy archives, owned private launch/readiness data and exact termination rows', async () => {
  const path = archive(), root = join(stateRoot(), 'private-ours');
  write(join(root, 'launches', 'owned.json'), { role: 'member-1', identity: 'member-1', action: 'action-1' });
  write(join(root, 'launches', 'foreign.json'), { role: 'member-1', identity: 'member-1', action: 'other-action' });
  write(join(root, 'room-inputs', 'owned.ready.json'), { room: id, invite: 'invite-1', cid, generation: 1 });
  write(join(root, 'room-inputs', 'foreign.ready.json'), { room: 'other', invite: 'invite-1', cid, generation: 1 });
  const journal = join(stateRoot(), 'recovery', 'temporary', 'terminations.jsonl');
  writeFileSync(journal, JSON.stringify({ role: 'member-1', launchId: 'launch-1' }) + '\n' + JSON.stringify({ role: 'member-1', launchId: 'other-launch' }) + '\n');
  await eraseMemberArtifacts('room', id, [{ ...seat(), identity_cid: cid, invite_id: 'invite-1' }], [id]);
  expect(existsSync(path)).toBe(false); expect(existsSync(join(root, 'launches', 'owned.json'))).toBe(false);
  expect(existsSync(join(root, 'room-inputs', 'owned.ready.json'))).toBe(false);
  expect(existsSync(join(root, 'launches', 'foreign.json'))).toBe(true); expect(existsSync(join(root, 'room-inputs', 'foreign.ready.json'))).toBe(true);
  expect(readFileSync(journal, 'utf8')).not.toContain('"launch-1"'); expect(readFileSync(journal, 'utf8')).toContain('other-launch');
});
it('settles task deletion with absent CID/temp/archive and erases its recovery receipt', async () => {
  const task = createTask({ title: 'private title', origin: { type: 'cli' } });
  createRoomRecord({ room_id: id, room_name: 'r', task_id: task.task_id }); updateTaskRoom(task.task_id, id, roomCid); updateMemberSeats(id, [seat()]);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  await settleTaskDeletion({ taskId: task.task_id, cowork });
  expect(readTaskDeletionReceipt(task.task_id)).toBeUndefined();
  expect(getRoomRecord(id)).toBeUndefined();
});

it.each(['owned', 'wrong-action', 'wrong-daemon', 'wrong-instance', 'contradictory'] as const)('recovers early OWNED runtime journal with no identity pin: %s', async mode => {
  const daemon = '11111111-1111-1111-1111-111111111111';
  sdk.profile.mockReturnValue({ expectedInstanceId: daemon, endpoint: 'http://unused', credentialPath: '/unused' });
  createRoomRecord({ room_id: id, room_name: 'erase', room_identity_cid: roomCid });
  updateMemberSeats(id, [{ ...seat(), invite_id: 'invite-1' }]);
  const dir = join(stateRoot(), 'private-ours', binderKey(daemon, 'member-1'));
  write(join(dir, 'state.json'), { version: 1, phase: 'OWNED', name: 'member-1', cid, lifetime: 'temporary',
    action: mode === 'wrong-action' ? 'other' : 'action-1', daemon: mode === 'wrong-daemon' ? 'other' : daemon, instance: 'instance-1' });
  write(join(dir, 'instance.json'), { role: 'member-1', temporary: true, instance: mode === 'wrong-instance' ? 'other' : 'instance-1' });
  sdk.listIdentities.mockImplementation(async () => sdk.removeIdentity.mock.calls.length ? [] : [{ name: 'member-1', cid }]);
  const remote = { ...cowork(), getRoom: vi.fn(async () => mode === 'contradictory' ? { room_id: id, identity_cid: roomCid, identity_name: 'r', room_name: 'r', state: 'closing' as const, anonymous: false, role_briefings: {}, seats: [{ identity_cid: 'ef'.repeat(32), role: 'Developer', invite_id: 'invite-1', display_name: 'r', seat_state: 'active' as const }] } : undefined) };
  if (mode === 'owned') { await closeManagedRoom({ roomId: id, cowork: remote }); expect(getRoomRecord(id)?.member_seats[0].identity_cid).toBe(cid); }
  else { await expect(closeManagedRoom({ roomId: id, cowork: remote })).rejects.toThrow(); expect(sdk.removeIdentity).not.toHaveBeenCalled(); }
});
it('resumes task erasure after archives are removed but before room record unlink', async () => {
  const task = createTask({ title: 'private', origin: { type: 'cli' } });
  createRoomRecord({ room_id: id, room_name: 'r', task_id: task.task_id }); updateTaskRoom(task.task_id, id, roomCid);
  updateMemberSeats(id, [seat()]); const path = archive();
  writeFileSync(join(path, 'termination.jsonl'), JSON.stringify({ version: 1, role: 'member-1', launchId: 'launch-1' }) + '\n');
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  vi.spyOn(roomState, 'deleteRoomRecord').mockImplementationOnce(() => { throw new Error('crash before room unlink'); });
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork })).rejects.toThrow('crash before room unlink');
  expect(existsSync(path)).toBe(false); expect(getRoomRecord(id)).toBeDefined();
  vi.restoreAllMocks();
  sdk.releaseLease.mockResolvedValue(undefined); sdk.close.mockResolvedValue(undefined); sdk.listIdentities.mockResolvedValue([]);
  await settleTaskDeletion({ taskId: task.task_id, cowork });
  expect(getRoomRecord(id)).toBeUndefined(); expect(readTaskDeletionReceipt(task.task_id)).toBeUndefined();
});

it('settles a task with a room member and an already-absent orphan member cursor', async () => {
  const task = createTask({ title: 'mixed membership', origin: { type: 'cli' } });
  createRoomRecord({ room_id: id, room_name: 'r', task_id: task.task_id });
  updateTaskRoom(task.task_id, id, roomCid);
  updateMemberSeats(id, [{ ...seat(), identity_cid: cid }]);
  const taskPath = join(stateRoot(), 'tasks', task.task_id + '.json');
  const stored = JSON.parse(readFileSync(taskPath, 'utf8'));
  stored.member_roles = [{ name: 'orphan-member', identity_cid: 'ef'.repeat(32), role: 'Critic' }];
  write(taskPath, stored);
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  await expect(settleTaskDeletion({ taskId: task.task_id, cowork })).resolves.toMatchObject({ deleted: true });
});
it('heals receipt after task unlink through repeated acceptance', async () => {
  const task = createTask({ title: 'private receipt title', origin: { type: 'cli' } });
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  rmSync(join(stateRoot(), 'tasks', task.task_id + '.json'));
  expect(beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' }).status).toBe('already_absent');
  expect(readTaskDeletionReceipt(task.task_id)).toBeUndefined();
});

it('actual CLI repeated deletion heals a receipt left after task unlink', async () => {
  const task = createTask({ title: 'private CLI receipt', origin: { type: 'cli' } });
  beginTaskDeletionIntent(task.task_id, { kind: 'local_control', surface: 'cli' });
  rmSync(join(stateRoot(), 'tasks', task.task_id + '.json'));
  await promisify(execFile)(process.execPath, ['dist/cli.js', 'task', 'delete', task.task_id, task.task_id, '--json'], {
    env: { ...process.env, OURS_FLEET_HOME: home }, timeout: 15000,
  });
  expect(readTaskDeletionReceipt(task.task_id)).toBeUndefined();
});
