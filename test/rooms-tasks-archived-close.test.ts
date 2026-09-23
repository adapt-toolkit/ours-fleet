import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
import { closeManagedRoom } from '../src/rooms-tasks/close.js';
import { createRoomRecord, updateMemberSeats, getRoomRecord } from '../src/rooms-tasks/room-state.js';
import { stateRoot } from '../src/paths.js';
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
