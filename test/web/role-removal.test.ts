import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleRemovalService } from '../../src/application/role-removal-service.js';
import { agentDir } from '../../src/paths.js';
import { makeTempSupervisorLauncher, prepareTempSupervisor } from '../../src/temp-lifecycle.js';

const previous = process.env.OURS_FLEET_HOME;
afterEach(() => previous === undefined ? delete process.env.OURS_FLEET_HOME : process.env.OURS_FLEET_HOME = previous);

function fixture(roles: string): { root: string; calls: string[]; service: RoleRemovalService } {
  const root = mkdtempSync(join(tmpdir(), 'role-removal-'));
  process.env.OURS_FLEET_HOME = root;
  writeFileSync(join(root, 'fleet.yaml'), `roles:\n${roles}`);
  const calls: string[] = [];
  const backend: any = {
    id: 'test', async uninstall(name: string) { calls.push(name); return { removed: true, detail: 'removed' }; },
  };
  return { root, calls, service: new RoleRemovalService({
    configPath: join(root, 'fleet.yaml'), ops: { backend, binPath: '/bin/true', log() {} },
  }) };
}

describe('safe web role removal', () => {
  it('requires exact-case typed confirmation and preserves hand-written configuration with recovery', async () => {
    const { root, calls, service } = fixture('  Worker: { harness: codex }\n');
    mkdirSync(agentDir('Worker'), { recursive: true });
    writeFileSync(join(agentDir('Worker'), 'WORKLOG.md'), 'recover me');
    expect(() => service.preview('worker')).toThrow(/case-sensitive.*Worker/);
    await expect(service.remove({ role: 'Worker', confirmation: 'worker' })).rejects.toMatchObject({ code: 'invalid_request' });
    const result = await service.remove({ role: 'Worker', confirmation: 'Worker' });
    expect(calls).toEqual(['Worker']);
    expect(result.recoveryPath).toContain('-Worker');
    expect(existsSync(join(result.recoveryPath, 'state', 'WORKLOG.md'))).toBe(true);
    expect(existsSync(join(root, 'fleet.yaml'))).toBe(true);
  });

  it('fails closed on case-fold collisions and cleans orphaned failed-start state', async () => {
    const collision = fixture('  Coordinator: {}\n  coordinator: {}\n');
    expect(() => collision.service.preview('coordinator')).toThrow(/case-fold collision/);
    const orphan = fixture('  Stable: {}\n');
    mkdirSync(agentDir('dangling'), { recursive: true });
    writeFileSync(join(agentDir('dangling'), 'briefing.md'), 'minimal');
    const result = await orphan.service.remove({ role: 'dangling', confirmation: 'dangling' });
    expect(orphan.calls).toEqual(['dangling']);
    expect(existsSync(agentDir('dangling'))).toBe(false);
    expect(existsSync(join(result.recoveryPath, 'orphan-state', 'briefing.md'))).toBe(true);
  });

  it('protects the current control role and requires coordinator impact acknowledgement', async () => {
    const { root, service } = fixture('  Coordinator: {}\n  Worker: { coordinator: Coordinator }\n');
    const self = new RoleRemovalService({ configPath: join(root, 'fleet.yaml'), ops: (service as any).options.ops, currentControlRole: 'Coordinator' });
    await expect(self.remove({ role: 'Coordinator', confirmation: 'Coordinator', coordinatorAcknowledged: true }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.remove({ role: 'Coordinator', confirmation: 'Coordinator' }))
      .rejects.toMatchObject({ code: 'prerequisite_unavailable' });
  });

  it('stops and archives a state-backed temporary role through the exact temp lifecycle', async () => {
    const { root, calls, service } = fixture('  Stable: {}\n');
    const state = agentDir('Temp', true);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'role.yaml'), 'name: Temp\nharness: codex\nsession: acp\n');
    writeFileSync(join(state, 'WORKLOG.md'), 'temporary evidence');
    prepareTempSupervisor(state, 'Temp');
    await makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd',
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    })('/bin/ours-fleet', ['_run-temp', 'Temp'], state);
    (service as any).options.ops.exec = async () => ({ stdout: '', stderr: '', code: 0 });
    (service as any).options.ops.sleep = async () => {};

    const result = await service.remove({ role: 'Temp', confirmed: true });

    expect(calls).toEqual([]); // permanent backend is not used for a temp supervisor
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(result.recoveryPath, 'state', 'WORKLOG.md'))).toBe(true);
    expect(existsSync(join(root, '.ours-fleet', 'recovery', 'temporary'))).toBe(true);
  });
});
