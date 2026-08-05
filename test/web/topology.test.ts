import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveTopology, isFleetMember, readSpawnLineage } from '../../src/web/topology.js';
import type { FleetConfig } from '../../src/config.js';
import type { RoleStatus } from '../../src/application/types.js';

const roleItem = (id: string, lifetime: 'permanent' | 'temporary' = 'permanent', parentRole?: string) => ({
  role: {
    id, lifetime, configured: lifetime === 'permanent', stateHealth: 'present' as const,
    detectedBackend: 'acp' as const, compatibility: { compatible: true }, problems: [],
    lineage: parentRole ? { parentRole, source: 'creation-provenance' as const } : undefined,
  },
  status: {
    roleId: id, observedAt: new Date().toISOString(), overall: 'ready' as const,
    supervisor: { backend: 'none' as const, liveness: 'running' as const, detail: 'running' },
    session: { backend: 'acp' as const, reachability: 'online' as const, readiness: 'idle' as const, evidence: 'authoritative' as const },
    restart: { circuit: 'closed' as const, consecutiveImmediateFailures: 0, nextDelayMs: 0 },
    monitor: { mode: 'fleet' as const, health: 'armed' as const, stale: false },
    isolation: { degraded: false }, problems: [],
  },
});

describe('fleet topology derivation', () => {
  it('derives oversight, watchdog, loop, and attributed spawn edges from facts', () => {
    const config = {
      roles: [{ name: 'Coordinator', oversee: [{ role: 'Worker', interval: '5m' }] }, { name: 'Worker' }],
      watchdogs: [{ name: 'nightwatch', enabled: true, intervalMs: 60_000, watch: ['Worker'] }],
      loops: [{ name: 'review', enabled: true, intervalMs: 120_000, roleNames: ['Coordinator'] }],
    } as unknown as FleetConfig;
    const topology = deriveTopology(config, [
      roleItem('Coordinator'), roleItem('Worker'), roleItem('TempReview', 'temporary', 'Worker'),
    ]);
    expect(topology.nodes.map(node => `${node.kind}:${node.label}`)).toEqual([
      'agent:Coordinator', 'agent:Worker', 'agent:TempReview', 'watchdog:nightwatch', 'loop:review',
    ]);
    expect(topology.edges.map(edge => `${edge.kind}:${edge.from}->${edge.to}`)).toEqual([
      'oversees:agent:Coordinator->agent:Worker',
      'watches:watchdog:nightwatch->agent:Worker',
      'targets:loop:review->agent:Coordinator',
      'spawned:agent:Worker->agent:TempReview',
    ]);
    expect(topology.unknownLineage).toEqual([]);
  });

  it('draws what it can read when oversee: was hand-edited into a shape the loader allows', () => {
    // The loader passes `oversee:` through unchecked, so a mapping, a scalar or
    // a bare-string entry reaches the graph. None of them may take it down —
    // the console would be unusable exactly when it is needed to fix them.
    for (const oversee of [{ role: 'Worker' }, 'Worker', ['Worker'], [{ interval: '5m' }], null]) {
      const config = {
        roles: [{ name: 'Coordinator', oversee }, { name: 'Worker' }], watchdogs: [], loops: [],
      } as unknown as FleetConfig;
      const topology = deriveTopology(config, [roleItem('Coordinator'), roleItem('Worker')]);
      expect(topology.nodes.map(node => node.id)).toEqual(['agent:Coordinator', 'agent:Worker']);
      expect(topology.edges).toEqual([]);
    }
  });

  it('does not invent lineage when provenance is absent or names a missing parent', () => {
    const topology = deriveTopology({ roles: [], watchdogs: [], loops: [] } as unknown as FleetConfig, [
      roleItem('Unattributed', 'temporary'), roleItem('Orphaned', 'temporary', 'Missing'),
    ]);
    expect(topology.edges).toEqual([]);
    expect(topology.unknownLineage).toEqual(['Orphaned', 'Unattributed']);
  });
});

/**
 * A role the inventory only knows because a state directory outlived it: not in
 * fleet.yaml, no live session, no live service. Every temporary agent this host
 * has ever run leaves one behind.
 */
const goneItem = (id: string, lifetime: 'temporary' | 'orphan' = 'temporary') => {
  const item = roleItem(id, 'temporary');
  return {
    role: { ...item.role, lifetime, configured: false },
    status: {
      ...item.status, overall: 'offline' as const,
      supervisor: { ...item.status.supervisor, liveness: 'stopped' as const, detail: 'inactive (dead)' },
      session: { ...item.status.session, reachability: 'offline' as const, readiness: 'failed' as const },
    },
  };
};

const dormantItem = (id: string) => {
  const item = roleItem(id);
  return { role: item.role, status: { ...goneItem(id).status, roleId: id } as RoleStatus };
};

describe('topology membership', () => {
  const config = { roles: [{ name: 'Coordinator' }, { name: 'Dormant' }], watchdogs: [], loops: [] } as unknown as FleetConfig;

  it('draws the fleet, not every identity a state directory outlived', () => {
    const inventory = [
      roleItem('Coordinator'),
      dormantItem('Dormant'),
      roleItem('LiveTemp', 'temporary', 'Coordinator'),
      goneItem('DeadTemp'),
      goneItem('StrayIdentity', 'orphan'),
    ];
    const topology = deriveTopology(config, inventory);
    expect(topology.nodes.map(node => node.id)).toEqual([
      'agent:Coordinator', 'agent:Dormant', 'agent:LiveTemp',
    ]);
    // Configured-but-stopped stays: it is fleet configuration, and hiding it
    // would make an agent vanish the moment it was added. A finished temporary
    // agent and a stray state directory are inventory, not topology.
    expect(topology.nodes.some(node => node.label === 'DeadTemp')).toBe(false);
    expect(topology.nodes.some(node => node.label === 'StrayIdentity')).toBe(false);
  });

  it('never draws a node the role inventory does not carry', () => {
    const inventory = [roleItem('Coordinator'), dormantItem('Dormant'), goneItem('DeadTemp')];
    const drawn = deriveTopology(config, inventory)
      .nodes.filter(node => node.kind === 'agent').map(node => node.label);
    const listed = inventory.map(item => item.role.id);
    expect(listed).toEqual(expect.arrayContaining(drawn));
    expect(drawn.every(label => inventory.some(item =>
      item.role.id === label && isFleetMember(item)))).toBe(true);
  });

  it('drops edges and lineage that only a departed role justified', () => {
    const withOversight = {
      roles: [{ name: 'Coordinator', oversee: [{ role: 'DeadTemp', interval: '5m' }] }],
      watchdogs: [{ name: 'nightwatch', enabled: true, intervalMs: 60_000, watch: ['DeadTemp'] }],
      loops: [{ name: 'review', enabled: true, intervalMs: 60_000, roleNames: ['DeadTemp'] }],
    } as unknown as FleetConfig;
    const topology = deriveTopology(withOversight, [
      roleItem('Coordinator'), goneItem('DeadTemp'), roleItem('Child', 'temporary', 'DeadTemp'),
    ]);
    expect(topology.edges).toEqual([]);
    // The child is live, so it is drawn — with its parentage reported as unknown
    // rather than pointing at a node nobody can see.
    expect(topology.nodes.map(node => node.id)).toEqual(['agent:Coordinator', 'agent:Child', 'watchdog:nightwatch', 'loop:review']);
    expect(topology.unknownLineage).toEqual(['Child']);
  });

  it('counts a live session or a live service as membership, and nothing else', () => {
    const live = roleItem('Live', 'temporary');
    expect(isFleetMember(live)).toBe(true);
    expect(isFleetMember({
      role: live.role,
      status: { ...live.status, session: { ...live.status.session, reachability: 'offline' } } as RoleStatus,
    })).toBe(true);   // supervisor still running
    expect(isFleetMember(goneItem('DeadTemp'))).toBe(false);
    expect(isFleetMember({ ...goneItem('Configured'), role: { ...goneItem('Configured').role, configured: true } })).toBe(true);
  });
});

describe('spawn lineage reader', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('reads only the bounded typed callerRole field', () => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-lineage-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'creation.json'), JSON.stringify({
      version: 1, lifetime: 'temporary', callerRole: 'Coordinator', settings: { env: 'do-not-read' },
    }), { mode: 0o600 });
    expect(readSpawnLineage(dir)).toEqual({ parentRole: 'Coordinator', source: 'creation-provenance' });
    writeFileSync(join(dir, 'creation.json'), JSON.stringify({
      version: 1, lifetime: 'temporary', callerRole: '../escape',
    }), { mode: 0o600 });
    expect(readSpawnLineage(dir)).toBeUndefined();
  });
});
