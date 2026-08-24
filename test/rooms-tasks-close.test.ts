import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdk = vi.hoisted(() => ({
  listIdentities: vi.fn(),
  removeIdentity: vi.fn(),
  releaseLease: vi.fn(async () => undefined),
}));

vi.mock('@ours.network/sdk/client', () => ({
  attachOursClient: vi.fn(async () => sdk),
}));

import { closeManagedRoom, type RoomCloseDeps } from '../src/rooms-tasks/close.js';
import {
  activateRoom, createRoomRecord, getRoomRecord, updateMemberSeats,
} from '../src/rooms-tasks/room-state.js';

const ROOM_ID = '01hzyk8m0000000000000000aa';
const CID = 'ab'.repeat(32);

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ours-fleet-room-close-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  createRoomRecord({ room_id: ROOM_ID, room_name: 'Close me' });
  updateMemberSeats(ROOM_ID, [{
    role_name: 'member-1', identity_cid: CID, slot: 'dev',
    cowork_role: 'Developer', seat_state: 'active',
  }]);
  activateRoom(ROOM_ID);
  sdk.listIdentities.mockReset().mockResolvedValue([]);
  sdk.removeIdentity.mockReset().mockResolvedValue(undefined);
  sdk.releaseLease.mockClear();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const calls: string[] = [];
  const deps: RoomCloseDeps = {
    inspectMember: vi.fn(async seat => {
      calls.push(`inspect:${seat.role_name}`);
      return { launchId: 'launch-1' };
    }),
    requestStop: vi.fn(async role => { calls.push(`stop:${role}`); }),
    waitForLivenessAbsent: vi.fn(async role => { calls.push(`absent:${role}`); }),
    secureArchive: vi.fn(async role => {
      calls.push(`archive:${role}`);
      return `/recovery/${role}-launch-1`;
    }),
    removeIdentity: vi.fn(async seat => { calls.push(`identity:${seat.role_name}`); }),
  };
  const cowork = {
    closeRoom: vi.fn(async (roomId: string) => { calls.push(`cowork:${roomId}`); }),
  };
  return { calls, deps, cowork };
}

describe('deterministic managed room close', () => {
  it('checkpoints exact retirement before Cowork and terminal close', async () => {
    const f = fixture();
    const closed = await closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps });
    expect(closed.state).toBe('closed');
    expect(f.calls).toEqual([
      'inspect:member-1', 'stop:member-1', 'absent:member-1',
      'archive:member-1', 'identity:member-1', `cowork:${ROOM_ID}`,
    ]);
    expect(closed.member_seats[0]).toMatchObject({
      seat_state: 'removed',
      retirement: {
        phase: 'identity_absent', launch_id: 'launch-1',
        archive_path: '/recovery/member-1-launch-1',
      },
    });
    expect(closed.close).toMatchObject({ phase: 'completed' });
  });

  it('does not advance past an accepted stop until liveness is proven absent', async () => {
    const f = fixture();
    f.deps.waitForLivenessAbsent = vi.fn(async () => { throw new Error('still running'); });
    await expect(closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps }))
      .rejects.toThrow('still running');
    const room = getRoomRecord(ROOM_ID)!;
    expect(room.state).toBe('closing');
    expect(room.member_seats[0].retirement?.phase).toBe('stop_requested');
    expect(room.close).toMatchObject({ phase: 'retire_members', error: 'still running' });
    expect(f.cowork.closeRoom).not.toHaveBeenCalled();
  });

  it('retries from the last durable member checkpoint without repeating retirement effects', async () => {
    const f = fixture();
    f.deps.removeIdentity = vi.fn()
      .mockRejectedValueOnce(new Error('identity lease still draining'))
      .mockImplementationOnce(async seat => { f.calls.push(`identity:${seat.role_name}`); });
    await expect(closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps }))
      .rejects.toThrow('identity lease still draining');
    expect(getRoomRecord(ROOM_ID)!.member_seats[0].retirement?.phase).toBe('archive_secured');

    await closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps });
    expect(f.deps.inspectMember).toHaveBeenCalledTimes(1);
    expect(f.deps.requestStop).toHaveBeenCalledTimes(1);
    expect(f.deps.waitForLivenessAbsent).toHaveBeenCalledTimes(1);
    expect(f.deps.secureArchive).toHaveBeenCalledTimes(1);
    expect(f.deps.removeIdentity).toHaveBeenCalledTimes(2);
    expect(f.cowork.closeRoom).toHaveBeenCalledTimes(1);
  });

  it('keeps closing after Cowork failure and retries only the idempotent Cowork boundary', async () => {
    const f = fixture();
    f.cowork.closeRoom
      .mockRejectedValueOnce(new Error('cowork unavailable'))
      .mockResolvedValueOnce(undefined);
    await expect(closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps }))
      .rejects.toThrow('cowork unavailable');
    let room = getRoomRecord(ROOM_ID)!;
    expect(room.state).toBe('closing');
    expect(room.close?.phase).toBe('close_cowork');
    expect(room.member_seats[0].retirement?.phase).toBe('identity_absent');

    room = await closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps });
    expect(room.state).toBe('closed');
    expect(f.deps.requestStop).toHaveBeenCalledTimes(1);
    expect(f.deps.removeIdentity).toHaveBeenCalledTimes(1);
    expect(f.cowork.closeRoom).toHaveBeenCalledTimes(2);
  });

  it('preserves first close failure across re-acceptance, progress, and a later failure', async () => {
    const f = fixture();
    f.deps.waitForLivenessAbsent = vi.fn()
      .mockRejectedValueOnce(new Error('first liveness failure'))
      .mockResolvedValueOnce(undefined);
    await expect(closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps }))
      .rejects.toThrow('first liveness failure');
    const { acceptManagedRoomClose } = await import('../src/rooms-tasks/close.js');
    let room = await acceptManagedRoomClose(ROOM_ID);
    expect(room.close).toMatchObject({
      error: 'first liveness failure', first_failure: 'first liveness failure',
    });

    f.cowork.closeRoom.mockRejectedValueOnce(new Error('later Cowork failure'));
    await expect(closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps }))
      .rejects.toThrow('later Cowork failure');
    room = getRoomRecord(ROOM_ID)!;
    expect(room.close).toMatchObject({
      phase: 'close_cowork',
      error: 'later Cowork failure',
      first_failure: 'first liveness failure',
    });
    expect(room.close?.first_recovery_hint).toContain('ours-fleet room close');
  });

  it('serializes concurrent duplicate close calls and performs effects once', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.deps.requestStop = vi.fn(async role => {
      f.calls.push(`stop:${role}`);
      entered();
      await gate;
    });
    const first = closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps });
    await started;
    const duplicate = closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps });
    release();
    const [one, two] = await Promise.all([first, duplicate]);
    expect(one.state).toBe('closed');
    expect(two.state).toBe('closed');
    expect(f.deps.requestStop).toHaveBeenCalledTimes(1);
    expect(f.deps.removeIdentity).toHaveBeenCalledTimes(1);
    expect(f.cowork.closeRoom).toHaveBeenCalledTimes(1);
  });

  it('refuses to remove a same-name identity whose CID is not the room-owned CID', async () => {
    const f = fixture();
    delete f.deps.removeIdentity;
    sdk.listIdentities.mockResolvedValue([{
      name: 'member-1', cid: 'cd'.repeat(32), kind: 'role', temp: null, session: null,
    }]);
    await expect(closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps }))
      .rejects.toThrow(/CID mismatch/);
    expect(sdk.removeIdentity).not.toHaveBeenCalled();
    expect(getRoomRecord(ROOM_ID)!.member_seats[0].retirement?.phase).toBe('archive_secured');
  });

  it('accepts NO_SUCH_IDENTITY only after the exact recorded CID was observed and absence confirmed', async () => {
    const f = fixture();
    delete f.deps.removeIdentity;
    sdk.listIdentities
      .mockResolvedValueOnce([{
        name: 'member-1', cid: CID, kind: 'role', temp: null, session: null,
      }])
      .mockResolvedValue([]);
    sdk.removeIdentity.mockRejectedValue(
      Object.assign(new Error('gone concurrently'), { name: 'OursError', code: 'NO_SUCH_IDENTITY' }),
    );

    const closed = await closeManagedRoom({ roomId: ROOM_ID, cowork: f.cowork, deps: f.deps });
    expect(closed.state).toBe('closed');
    expect(sdk.removeIdentity).toHaveBeenCalledWith({ name: 'member-1' });
    expect(sdk.listIdentities).toHaveBeenCalledTimes(3);
  });
});
