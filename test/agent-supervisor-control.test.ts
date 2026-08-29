import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSupervisorControlAuthority } from '../src/agent-supervisor-control.js';

describe('AgentSupervisorControlAuthority', () => {
  it('issues exact-bound, active-only, non-serializable leases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-control-')); chmodSync(root, 0o700);
    const authority = new AgentSupervisorControlAuthority(root); let lease!: object;
    await authority.exclusive('agent-a', value => {
      lease = value; expect(authority.authenticate(value, 'agent-a')).toBe(true);
      expect(authority.authenticate(value, 'agent-b')).toBe(false);
      expect(JSON.stringify(value)).toBe('{}');
    });
    expect(authority.authenticate(lease, 'agent-a')).toBe(false);
  });
  it('serializes same Agent while allowing differently keyed control', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-control-')); chmodSync(root, 0o700);
    const authority = new AgentSupervisorControlAuthority(root); const order: string[] = [];
    let release!: () => void; const paused = new Promise<void>(done => { release = done; });
    const first = authority.exclusive('agent-a', async () => { order.push('a1'); await paused; order.push('a2'); });
    await new Promise(done => setTimeout(done, 10));
    const second = authority.exclusive('agent-a', () => { order.push('a3'); });
    const different = authority.exclusive('agent-b', () => { order.push('b'); });
    await different; expect(order).toContain('b'); expect(order).not.toContain('a3');
    release(); await Promise.all([first, second]); expect(order.indexOf('a3')).toBeGreaterThan(order.indexOf('a2'));
  });
  it('consumes only one immutable exact lifecycle binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-control-')); chmodSync(root, 0o700);
    const authority = new AgentSupervisorControlAuthority(root);
    const exact = { agentId: 'agent-a', operation: 'create' as const, priorGeneration: 0,
      targetGeneration: 1, actionId: 'action-1', planDigest: `sha256:${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'2'.repeat(64)}`, rootId: 'production-agent-creation' as const,
      publisherId: 'agent-supervisor-handoff' as const };
    await authority.exclusive('agent-a', lease => {
      expect(authority.bind(lease, exact)).toBe(true);
      expect(authority.bind(lease, exact)).toBe(false);
      expect(authority.consume(lease, { ...exact, targetGeneration: 2 })).toBe(false);
      expect(authority.consume(lease, { ...exact, priorGeneration: 1 })).toBe(false);
      expect(authority.consume(lease, { ...exact, actionId: 'wrong' })).toBe(false);
      expect(authority.consume(lease, { ...exact, planDigest: `sha256:${'3'.repeat(64)}` })).toBe(false);
      expect(authority.consume(lease, { ...exact, snapshotDigest: `sha256:${'4'.repeat(64)}` })).toBe(false);
      expect(authority.consume(lease, { ...exact, operation: 'resume' })).toBe(false);
      expect(authority.consume(lease, { ...exact, rootId: 'foreign-root' as never })).toBe(false);
      expect(authority.consume(lease, { ...exact, publisherId: 'foreign-publisher' as never })).toBe(false);
      expect(authority.consume(lease, exact)).toBe(true);
      expect(authority.consume(lease, exact)).toBe(false);
    }, 'create');
  });
});
