import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { readTempSupervisor, tempSupervisorLiveness, TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';
import { taskLiveReadiness, type LiveReadinessDeps } from '../src/rooms-tasks/live-readiness.js';
import type { TaskRecord, RoomOrchestrationRecord } from '../src/rooms-tasks/types.js';
import type { CoworkRoomInfo } from '../src/rooms-tasks/cowork-adapter.js';

function fixture() {
  const task = { task_id: 'task', state: 'active', room_id: 'room', room_identity_cid: 'room-cid' } as TaskRecord;
  const room = { room_id: 'room', task_id: 'task', room_identity_cid: 'room-cid', state: 'active',
    template_snapshot: { members: [{ count: 1 }] }, member_seats: [{
      role_name: 'dev', cowork_role: 'Developer', slot: 'dev', seat_state: 'active',
      identity_cid: 'dev-cid', invite_id: 'invite',
      launch: { state: 'launched', launch_id: 'launch' },
    }],
  } as RoomOrchestrationRecord;
  const remote = { room_id: 'room', identity_cid: 'room-cid', state: 'active', seats: [{
    display_name: 'dev', identity_cid: 'dev-cid', invite_id: 'invite', role: 'Developer', seat_state: 'active',
  }] } as CoworkRoomInfo;
  const cowork = { getRoom: vi.fn(async () => remote) };
  const deps: LiveReadinessDeps = {
    supervisor: vi.fn(() => ({ version: 1, role: 'dev', launchId: 'launch', phase: 'active', createdAt: '' })),
    liveness: vi.fn(async () => 'running'),
    readiness: vi.fn(() => ({ room: 'room', invite: 'invite', cid: 'dev-cid', generation: 1 })),
    control: vi.fn(async () => ({ version: 1, id: 'probe', ok: true, result: { alive: true, readiness: 'idle' } })),
  };
  return { task, room, remote, cowork, deps, check: () => taskLiveReadiness(task, room, cowork, deps) };
}

describe('live task readiness observations', () => {
  it.each(['idle', 'running', 'awaiting_permission'])('accepts healthy %s agents without confusing busy with offline', async readiness => {
    const f = fixture();
    f.deps.control = vi.fn(async () => ({ version: 1, id: 'probe', ok: true, result: { alive: true, readiness } }));
    await expect(f.check()).resolves.toBeUndefined();
    expect(f.deps.control).toHaveBeenCalledWith(expect.any(String), { command: 'status' }, 2000);
  });
  it.each(['stopped', 'unknown'] as const)('does not trust active launch metadata when liveness is %s', async live => {
    const f = fixture(); f.deps.liveness = vi.fn(async () => live);
    const before = JSON.stringify([f.task, f.room]);
    await expect(f.check()).resolves.toMatchObject({ state: live === 'stopped' ? 'degraded' : 'unknown',
      reason: live === 'stopped' ? 'supervisor_stopped' : 'supervisor_liveness_unknown' });
    expect(f.deps.control).not.toHaveBeenCalled();
    expect(JSON.stringify([f.task, f.room])).toBe(before);
  });
  it.each(['removed', 'pending', 'wrong-cid', 'wrong-invite', 'wrong-role', 'duplicate'])(
    'rejects %s remote seat despite stale saved readiness', async mutation => {
      const f = fixture();
      if (mutation === 'removed' || mutation === 'pending') f.remote.seats[0].seat_state = mutation;
      if (mutation === 'wrong-cid') f.remote.seats[0].identity_cid = 'replacement';
      if (mutation === 'wrong-invite') f.remote.seats[0].invite_id = 'replacement';
      if (mutation === 'wrong-role') f.remote.seats[0].role = 'Owner';
      if (mutation === 'duplicate') f.remote.seats.push({ ...f.remote.seats[0] });
      await expect(f.check()).resolves.toMatchObject({ state: 'degraded', reason: 'member_seat_mismatch' });
      expect(f.deps.control).not.toHaveBeenCalled();
    });
  it('does not mistake a missing expected member for an empty healthy room', async () => {
    const f = fixture(); f.room.member_seats = [];
    await expect(f.check()).resolves.toMatchObject({ reason: 'member_roster_mismatch' });
  });
  it('rejects room identity replacement and absent pinned Owner', async () => {
    const f = fixture(); f.remote.identity_cid = 'other';
    await expect(f.check()).resolves.toMatchObject({ reason: 'room_identity_or_state_mismatch' });
    f.remote.identity_cid = 'room-cid'; f.room.owner_seat_cid = 'owner';
    await expect(f.check()).resolves.toMatchObject({ reason: 'owner_seat_missing' });
  });
  it('does not adopt a different supervisor generation', async () => {
    const f = fixture(); f.room.member_seats[0].launch!.launch_id = 'old';
    await expect(f.check()).resolves.toMatchObject({ reason: 'supervisor_launch_mismatch' });
  });
  it('requires readiness pinned to the exact room, invite and member CID', async () => {
    const f = fixture(); f.deps.readiness = () => ({ room: 'other', invite: 'invite', cid: 'dev-cid', generation: 1 });
    await expect(f.check()).resolves.toMatchObject({ reason: 'member_readiness_mismatch' });
  });
  it('reports Cowork transport failure as unknown without leaking backend text', async () => {
    const f = fixture(); f.cowork.getRoom.mockRejectedValue(Error('private transport detail'));
    await expect(f.check()).resolves.toEqual({ state: 'unknown', reason: 'room_probe_unavailable', member: undefined });
  });
  it.each(['throw', 'negative', 'malformed'])('reports %s control response as unknown, not stopped', async result => {
    const f = fixture();
    f.deps.control = async () => {
      if (result === 'throw') throw Error('socket timeout');
      return { version: 1, id: 'probe', ok: result !== 'negative' };
    };
    await expect(f.check()).resolves.toMatchObject({ state: 'unknown', reason: result === 'throw' ? 'control_unavailable' : result === 'negative' ? 'control_unavailable' : 'agent_readiness_unknown' });
  });
  it.each([false, true])('rejects dead/failed agent beneath a live supervisor (alive=%s)', async alive => {
    const f = fixture(); f.deps.control = async () => ({ version: 1, id: 'probe', ok: true,
      result: { alive, readiness: 'failed' } });
    await expect(f.check()).resolves.toMatchObject({ state: 'degraded', reason: 'agent_not_ready' });
  });
});


it('reports a stopped second member in a two-agent room without altering retained state', async () => {
  const f = fixture();
  f.room.template_snapshot!.members.push({ ...f.room.template_snapshot!.members[0], slot: 'critic', role: 'Critic' });
  f.room.member_seats.push({ ...f.room.member_seats[0], role_name: 'critic', slot: 'critic', identity_cid: 'critic-cid',
    invite_id: 'critic-invite', cowork_role: 'Critic', launch: { ...f.room.member_seats[0].launch!, launch_id: 'critic-launch' } });
  f.remote.seats.push({ ...f.remote.seats[0], display_name: 'critic', identity_cid: 'critic-cid',
    invite_id: 'critic-invite', role: 'Critic' });
  f.deps.supervisor = dir => ({ version: 1, role: basename(dir),
    launchId: basename(dir) === 'dev' ? 'launch' : 'critic-launch', phase: 'active', createdAt: '' });
  f.deps.liveness = vi.fn(async dir => basename(dir) === 'dev' ? 'running' : 'stopped');
  const before = JSON.stringify([f.task, f.room, f.remote]);
  await expect(f.check()).resolves.toEqual({ state: 'degraded', reason: 'supervisor_stopped', member: 'critic' });
  expect(f.deps.control).toHaveBeenCalledTimes(1); // healthy first member was actually checked
  expect(f.deps.liveness).toHaveBeenCalledTimes(2);
  expect(JSON.stringify([f.task, f.room, f.remote])).toBe(before);
});

it('rejects an active saved systemd launch when its pre-reboot unit no longer exists', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-readiness-record-'));
  const path = join(dir, TEMP_SUPERVISOR_FILE);
  const record = JSON.stringify({ version: 1, role: 'dev', launchId: 'launch', phase: 'active',
    createdAt: '2026-01-01T00:00:00Z', kind: 'systemd-transient', target: 'ours-fleet-temp-dev.service', pid: 12345 });
  writeFileSync(path, record);
  const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'Unit could not be found.' }));
  f.deps.supervisor = () => readTempSupervisor(dir);
  f.deps.liveness = () => tempSupervisorLiveness(dir, { exec });
  try {
    await expect(f.check()).resolves.toMatchObject({ state: 'degraded', reason: 'supervisor_stopped' });
    expect(exec).toHaveBeenCalledWith('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', 'ours-fleet-temp-dev.service']);
    expect(f.deps.control).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(record);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
