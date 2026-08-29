import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentSupervisorControlAuthority } from '../src/agent-supervisor-control.js';
import { AgentManagementService, type HandoffAdmission } from '../src/application/agent-management-service.js';
import type { AgentSupervisorHandoff } from '../src/agent-supervisor-handoff.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';

const handoff = (id = 'agent-a'): AgentSupervisorHandoff => ({ schemaVersion: 1, kind: 'AgentSupervisorHandoff',
  agentId: id, actionId: 'action', generation: 1, planDigest: `sha256:${'1'.repeat(64)}`,
  snapshotDigest: `sha256:${'2'.repeat(64)}`, reservationDigest: `sha256:${'3'.repeat(64)}`,
  authorizationRevision: 'revision', lifetime: 'persistent', identityEvidenceDigest: `sha256:${'4'.repeat(64)}`,
  locatorDigest: `sha256:${'5'.repeat(64)}`, canonicalDir: `/state/${id}/generation-1`,
  planBytesDigest: `sha256:${'6'.repeat(64)}`, handoffDigest: `sha256:${'7'.repeat(64)}` });

function fixture(admission: HandoffAdmission, state: 'running'|'stopped'|'unknown' = 'running', created = true) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-agent-management-')); chmodSync(root, 0o700);
  const calls: string[] = [];
  const backend: SupervisorBackend = { id: 'systemd', init: async () => [],
    install: async id => { calls.push(`install:${id}`); return { created, detail: 'installed' }; },
    start: async id => { calls.push(`start:${id}`); }, stop: async id => { calls.push(`stop:${id}`); },
    restart: async id => { calls.push(`restart:${id}`); }, status: async () => '',
    liveness: async id => { calls.push(`liveness:${id}`); return { state, detail: state }; },
    uninstall: async id => { calls.push(`uninstall:${id}`); return { removed: true, detail: 'removed' }; },
    logsArgs: () => ({ cmd: '', args: [] }) };
  const startInitial = vi.fn(async (id: string) => handoff(id));
  const startExisting = vi.fn(async () => undefined);
  const retire = vi.fn(async () => undefined);
  const reconfigure = vi.fn(async () => handoff());
  return { calls, backend, startInitial, startExisting, retire, reconfigure, service: new AgentManagementService({
    control: new AgentSupervisorControlAuthority(root), backend, binPath: '/fleet', readHandoff: () => admission,
    startInitial, startExisting, retire, reconfigure,
  }) };
}

describe('AgentManagementService', () => {
  it('distinguishes absent initial start from exact existing resume', async () => {
    const initial = fixture({ state: 'missing' }); await initial.service.execute({ operation: 'agent.start', id: 'agent-a' });
    expect(initial.startInitial).toHaveBeenCalledOnce(); expect(initial.startExisting).not.toHaveBeenCalled();
    const existing = fixture({ state: 'present', handoff: handoff() });
    await existing.service.execute({ operation: 'agent.start', id: 'agent-a' });
    expect(existing.startInitial).not.toHaveBeenCalled();
    expect(existing.startExisting).toHaveBeenCalledWith(handoff(), expect.any(Object));
  });
  it.each([{ state: 'corrupt', detail: 'bad' } as HandoffAdmission,
    { state: 'present', handoff: handoff() } as HandoffAdmission])(
    'makes no supervisor effect for corrupt handoff or unknown liveness', async admission => {
      const item = fixture(admission, admission.state === 'corrupt' ? 'stopped' : 'unknown');
      await expect(item.service.execute({ operation: 'agent.start', id: 'agent-a' })).rejects.toThrow();
      expect(item.calls.some(call => call.startsWith('install:') || call.startsWith('start:'))).toBe(false);
    });
  it('rolls back only registration created by this start', async () => {
    for (const created of [true, false]) {
      const item = fixture({ state: 'present', handoff: handoff() }, 'stopped', created);
      item.backend.start = async () => { throw new Error('start failed'); };
      await expect(item.service.execute({ operation: 'agent.start', id: 'agent-a' })).rejects.toThrow('start failed');
      expect(item.calls.includes('uninstall:agent-a')).toBe(created);
    }
  });
  it.each(['stopped', 'unknown'] as const)('fails when post-start liveness is %s', async state => {
    const item = fixture({ state: 'present', handoff: handoff() }, 'stopped'); let observations = 0;
    item.backend.liveness = async id => { item.calls.push(`liveness:${id}`); observations += 1;
      return { state: observations === 1 ? 'stopped' : state, detail: state }; };
    await expect(item.service.execute({ operation: 'agent.start', id: 'agent-a' })).rejects.toThrow();
    expect(item.calls).toContain('start:agent-a');
  });
  it('fails backend-none without attempting install or start', async () => {
    const item = fixture({ state: 'present', handoff: handoff() }, 'stopped');
    item.backend.id = 'none';
    await expect(item.service.execute({ operation: 'agent.start', id: 'agent-a' })).rejects.toThrow(/backend none/u);
    expect(item.calls).toEqual(['liveness:agent-a']);
  });
  it('retires authenticated publication before uninstall under the operation identity', async () => {
    const item = fixture({ state: 'present', handoff: handoff() }, 'running');
    await expect(item.service.execute({ operation: 'agent.retire', id: 'agent-a' },
      { operationId: 'retire-op' })).resolves.toMatchObject({ desired: 'retired' });
    expect(item.retire).toHaveBeenCalledWith(handoff(), 'retire-op', expect.any(Object));
    expect(item.calls).toEqual(['liveness:agent-a', 'stop:agent-a', 'uninstall:agent-a']);
  });
  it('reconfigures one exact generation and restarts under the durable operation identity', async () => {
    const item = fixture({ state: 'present', handoff: handoff() }, 'running');
    await expect(item.service.execute({ operation: 'agent.reconfigure', id: 'agent-a', expectedDigest: 'digest' },
      { operationId: 'reconfigure-op' })).resolves.toMatchObject({ observed: 'running' });
    expect(item.reconfigure).toHaveBeenCalledWith('agent-a', 'digest', 'reconfigure-op', expect.any(Object));
    expect(item.calls).toContain('restart:agent-a');
  });
});
