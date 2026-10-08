import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sdk = vi.hoisted(() => ({ listIdentities: vi.fn(), removeIdentity: vi.fn(), releaseLease: vi.fn(async () => {}), close: vi.fn(async () => {}) }));
vi.mock('@ours.network/sdk/client', () => ({ attachOursClient: vi.fn(async () => sdk) }));
vi.mock('../src/client-profile.js', () => ({ readClientProfile: () => ({ endpoint: 'http://isolated.test', expectedInstanceId: 'fixture-daemon', credentialPath: '/fixture' }) }));
import { agentDir, stateRoot } from '../src/paths.js';
import { binderKey } from '../src/agent-ours/state.js';
import { prepareTempSupervisor, TEMP_SUPERVISOR_FILE, tempArchiveForCreationAction } from '../src/temp-lifecycle.js';
import { layoutOwnedMemberName, retireOwnedLayoutMember, ownedLayoutRetirementSeats } from '../src/rooms-tasks/layout-member-retirement.js';
import { eraseMemberArtifacts } from '../src/rooms-tasks/erasure.js';
import type { RoomLayoutState } from '../src/rooms-tasks/layout.js';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'task-layout-retire-')); vi.stubEnv('OURS_FLEET_HOME', root); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const runId = 'task-owned', key = 'worker', name = layoutOwnedMemberName(runId, key), cid = 'ab'.repeat(32), action = `${runId}:${key}`;
  const dir = agentDir(name, true); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.identity'), name); writeFileSync(join(dir, 'creation.json'), JSON.stringify({ role: name, creationActionId: action }));
  const supervisor = prepareTempSupervisor(dir, name);
  writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), JSON.stringify({ ...supervisor, kind: 'systemd-transient', target: 'isolated-layout.service', phase: 'active' }));
  const privateDir = join(stateRoot(), 'private-ours', binderKey('fixture-daemon', name)); mkdirSync(privateDir, { recursive: true });
  const runtime = { instance: 'original-instance', name, daemon: 'fixture-daemon', lifetime: 'temporary', action, cid };
  writeFileSync(join(privateDir, 'state.json'), JSON.stringify(runtime));
  writeFileSync(join(privateDir, 'instance.json'), JSON.stringify({ instance: runtime.instance, role: name, temporary: true }));
  const permanent = agentDir('PersonalAssistant'); mkdirSync(permanent, { recursive: true }); writeFileSync(join(permanent, '.identity'), 'PersonalAssistant');
  writeFileSync(join(permanent, '.session-id'), 'permanent-conversation');
  let rows = [{ name, cid }]; sdk.listIdentities.mockImplementation(async () => rows);
  sdk.removeIdentity.mockImplementation(async ({ name: removing }) => { rows = rows.filter(row => row.name !== removing); });
  const exec = vi.fn(async (cmd: string, args: string[]) => ({ code: 0, stdout: args.includes('show') ? 'inactive\n' : '', stderr: '' }));
  const instance = { supervisor: stateRoot(), agent: name, temporary: true, launch: runtime.instance, cid, session: 'original-conversation' };
  return { runId, key, name, cid, dir, privateDir, runtime, permanent, exec, instance };
}
it('stops and archives the exact owned factory launch before removing identity and artifacts, preserving a borrowed permanent binding', async () => {
  const f = await fixture();
  await retireOwnedLayoutMember(f.instance, f.runId, f.key, { exec: f.exec });
  expect(f.exec).toHaveBeenCalledWith('systemctl', ['--user', 'stop', 'isolated-layout.service']);
  expect(existsSync(f.dir)).toBe(false); expect(sdk.removeIdentity).toHaveBeenCalledWith({ name: f.name });
  const archive = tempArchiveForCreationAction(f.name, `${f.runId}:${f.key}`)!;
  const state = { participants: { worker: { owned: true, retired: true, instance: f.instance },
    borrowed: { owned: false, retired: false, instance: { ...f.instance, agent: 'PersonalAssistant', temporary: false } } } } as unknown as RoomLayoutState;
  const seats = ownedLayoutRetirementSeats(state, f.runId);
  expect(seats.map(seat => seat.role_name)).toEqual([f.name]);
  await eraseMemberArtifacts('task', 'owned', seats, []);
  expect(existsSync(archive.path)).toBe(false); expect(existsSync(f.privateDir)).toBe(false);
  expect(readFileSync(join(f.permanent, '.session-id'), 'utf8')).toBe('permanent-conversation');
  await retireOwnedLayoutMember(f.instance, f.runId, f.key, { exec: f.exec });
  expect(sdk.removeIdentity).toHaveBeenCalledTimes(1);
});
it.each(['replacement', 'cid', 'permanent', 'borrowed', 'unsafe-proof'])('refuses destructive cleanup when ownership is not exact: %s', async mode => {
  const f = await fixture();
  if (mode === 'replacement') writeFileSync(join(f.privateDir, 'state.json'), JSON.stringify({ ...f.runtime, instance: 'replacement' }));
  if (mode === 'cid') writeFileSync(join(f.privateDir, 'state.json'), JSON.stringify({ ...f.runtime, cid: 'cd'.repeat(32) }));
  if (mode === 'permanent') mkdirSync(agentDir(f.name), { recursive: true });
  if (mode === 'borrowed') f.instance.temporary = false;
  if (mode === 'unsafe-proof') { rmSync(join(f.privateDir, 'state.json')); symlinkSync(join(f.permanent, '.session-id'), join(f.privateDir, 'state.json')); }
  await expect(retireOwnedLayoutMember(f.instance, f.runId, f.key, { exec: f.exec })).rejects.toThrow();
  expect(f.exec).not.toHaveBeenCalled(); expect(sdk.removeIdentity).not.toHaveBeenCalled(); expect(existsSync(f.dir)).toBe(true);
});
it('retries an identity-removal failure from the exact archive without restopping a replacement', async () => {
  const f = await fixture(); sdk.removeIdentity.mockRejectedValueOnce(Error('response lost'));
  await expect(retireOwnedLayoutMember(f.instance, f.runId, f.key, { exec: f.exec })).rejects.toThrow('response lost');
  expect(existsSync(f.dir)).toBe(false);
  await retireOwnedLayoutMember(f.instance, f.runId, f.key, { exec: f.exec });
  expect(f.exec.mock.calls.filter(([, args]) => args.includes('stop'))).toHaveLength(1);
});
