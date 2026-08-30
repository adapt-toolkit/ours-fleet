import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveTopology, readSpawnLineage } from '../../src/web/topology.js';
import type { FleetConfig } from '../../src/config.js';

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
      roles: [{ name: 'Coordinator', oversee: [{ agent: 'Worker', interval: '5m' }] }, { name: 'Worker' }],
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

  it('does not invent lineage when provenance is absent or names a missing parent', () => {
    const topology = deriveTopology({ roles: [], watchdogs: [], loops: [] } as unknown as FleetConfig, [
      roleItem('Unattributed', 'temporary'), roleItem('Orphaned', 'temporary', 'Missing'),
    ]);
    expect(topology.edges).toEqual([]);
    expect(topology.unknownLineage).toEqual(['Orphaned', 'Unattributed']);
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
