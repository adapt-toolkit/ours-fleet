import { describe, expect, it } from 'vitest';

import type { FleetConfig } from '../../src/config.js';
import { IMPLICIT_WATCH_LABEL, mergeTopology } from '../../src/web/topology-model.js';
import { emptyDraft, type TopologyDraft, type TopologyDraftRead } from '../../src/web/topology-draft-store.js';
import type { RuntimeRoleItem } from '../../src/web/topology.js';

const roleItem = (id: string, lifetime: 'permanent' | 'temporary' = 'permanent', mission?: string): RuntimeRoleItem => ({
  role: {
    id, lifetime, configured: lifetime === 'permanent', stateHealth: 'present' as const,
    detectedBackend: 'acp' as const, compatibility: { compatible: true }, problems: [],
    config: mission === undefined ? undefined : { mission },
  },
  status: {
    roleId: id, observedAt: '2026-08-05T00:00:00.000Z', overall: 'ready' as const,
    supervisor: { backend: 'none' as const, liveness: 'running' as const, detail: 'running' },
    session: { backend: 'acp' as const, reachability: 'online' as const, readiness: 'idle' as const, evidence: 'authoritative' as const },
    restart: { circuit: 'closed' as const, consecutiveImmediateFailures: 0, nextDelayMs: 0 },
    monitor: { mode: 'fleet' as const, health: 'armed' as const, stale: false },
    isolation: { degraded: false }, problems: [],
  },
} as unknown as RuntimeRoleItem);

const fleet = (overrides: Partial<FleetConfig> = {}): FleetConfig => ({
  roles: [], watchdogs: [], loops: [], vars: {}, defaults: {}, files: [],
  startStaggerMs: 0, diagnostics: [], ...overrides,
} as unknown as FleetConfig);

const role = (name: string, mission?: string, identity = name) =>
  ({ name, mission, identity, oversee: [] }) as unknown as FleetConfig['roles'][number];

const watchdog = (name: string, extra: Record<string, unknown> = {}) => ({
  name, coordinator: 'Alice', enabled: true, intervalMs: 600_000,
  watch: [], watchExplicit: true, identity: `Watchdog-${name}`, ...extra,
}) as unknown as FleetConfig['watchdogs'][number];

const loop = (name: string, roleNames: string[]) => ({
  name, roleNames, enabled: true, intervalMs: 3_600_000, prompt: 'p',
}) as unknown as FleetConfig['loops'][number];

const drafted = (draft: Partial<TopologyDraft> = {}, over: Partial<TopologyDraftRead> = {}): TopologyDraftRead => ({
  draft: { ...emptyDraft(), ...draft },
  revision: 'rev-1',
  writable: true,
  ...over,
});

const byId = (merged: { nodes: Array<{ id: string }> }, id: string) =>
  merged.nodes.find(node => node.id === id)!;

describe('merged topology read model', () => {
  it('keeps configured nodes authoritative and launchable', () => {
    const config = fleet({
      roles: [role('Alice', 'Ship safely')],
      watchdogs: [watchdog('health', { watch: ['Alice'] })],
      loops: [loop('nightly', ['Alice'])],
    });
    const merged = mergeTopology(config, [roleItem('Alice')], drafted());

    expect(merged.nodes.map(node => node.id)).toEqual(['agent:Alice', 'watchdog:health', 'loop:nightly']);
    for (const node of merged.nodes) {
      expect(node.origin).toBe('config');
      expect(node.valid).toBe(true);
      expect(node.complete).toBe(true);
      expect(node.launchable).toBe(true);
      expect(node.missing).toEqual([]);
    }
    expect(merged.problems).toEqual([]);
    expect(merged.draftRevision).toBe('rev-1');
    expect(merged.draftWritable).toBe(true);
  });

  it('flags a configured agent with no mission and withholds launchable', () => {
    const merged = mergeTopology(fleet({ roles: [role('Alice')] }), [roleItem('Alice')], drafted());
    const alice = byId(merged, 'agent:Alice');

    expect(alice.complete).toBe(false);
    expect(alice.launchable).toBe(false);
    expect(alice.missing.map(item => item.field)).toEqual(['mission']);
    expect(alice.missing[0].fix).toMatch(/one sentence/);
  });

  it('does not invent a gap for a role that exists only on disk', () => {
    const merged = mergeTopology(fleet(), [roleItem('Ghost')], drafted());
    expect(byId(merged, 'agent:Ghost')).toMatchObject({ complete: true, missing: [], launchable: true });
  });
});

describe('graph membership', () => {
  /** In the inventory only because its state directory outlived it. */
  const departed = (id: string): RuntimeRoleItem => {
    const item = roleItem(id, 'temporary');
    return {
      role: { ...item.role, configured: false },
      status: {
        ...item.status, overall: 'offline',
        supervisor: { ...item.status.supervisor, liveness: 'stopped' },
        session: { ...item.status.session, reachability: 'offline', readiness: 'failed' },
      },
    } as unknown as RuntimeRoleItem;
  };

  it('draws the fleet agents plus sketches, and no other identity', () => {
    const inventory = [
      roleItem('Alice', 'permanent', 'Ship safely'),
      roleItem('LiveTemp', 'temporary'),
      departed('tmp-1a2b3c'), departed('OldReviewer'),
    ];
    const merged = mergeTopology(fleet({ roles: [role('Alice', 'Ship safely')] }), inventory, drafted({
      drafts: { nodes: [{ id: 'agent:Sketch', kind: 'agent', fields: { mission: 'Try things' } }], edges: [] },
    } as Partial<TopologyDraft>));

    expect(merged.nodes.map(node => node.id))
      .toEqual(['agent:Alice', 'agent:LiveTemp', 'agent:Sketch']);
    // The drafts are the only nodes the role inventory does not carry.
    const inventoryIds = new Set(inventory.map(item => item.role.id));
    for (const node of merged.nodes.filter(candidate => candidate.kind === 'agent'))
      expect(node.origin === 'draft' || inventoryIds.has(node.label)).toBe(true);
  });
});

describe('draft completeness', () => {
  const withDrafts = (nodes: unknown[], edges: unknown[] = [], config = fleet()) =>
    mergeTopology(config, [], drafted({ drafts: { nodes, edges } as TopologyDraft['drafts'] }));

  it('an agent is complete with a name and a mission, and never launchable', () => {
    const merged = withDrafts([
      { id: 'agent:Blank', kind: 'agent', fields: {} },
      { id: 'agent:Ready', kind: 'agent', fields: { mission: 'Review pull requests' } },
      { id: 'agent:Spaces', kind: 'agent', fields: { mission: '   ' } },
    ]);

    expect(byId(merged, 'agent:Blank')).toMatchObject({ origin: 'draft', complete: false, launchable: false });
    expect(byId(merged, 'agent:Blank').missing.map(item => item.field)).toEqual(['mission']);
    expect(byId(merged, 'agent:Spaces').complete).toBe(false);
    expect(byId(merged, 'agent:Ready')).toMatchObject({
      complete: true, valid: true, launchable: false, detail: 'Review pull requests',
    });
  });

  it('a watchdog is complete with a name and a coordinator', () => {
    const merged = withDrafts([
      { id: 'watchdog:blank', kind: 'watchdog', fields: {} },
      { id: 'watchdog:ready', kind: 'watchdog', fields: { coordinator: 'Alice' } },
    ]);

    expect(byId(merged, 'watchdog:blank').missing.map(item => item.field)).toEqual(['coordinator']);
    expect(byId(merged, 'watchdog:blank').missing[0].why).toMatch(/refuses to load/);
    expect(byId(merged, 'watchdog:ready')).toMatchObject({ complete: true, detail: 'Reports to Alice' });
  });

  it('an interval is complete with a name, a target and a prompt', () => {
    const config = fleet({ roles: [role('Alice', 'm')] });
    const merged = mergeTopology(config, [roleItem('Alice', 'permanent', 'm')], drafted({
      drafts: {
        nodes: [
          { id: 'loop:blank', kind: 'loop', fields: {} },
          { id: 'loop:noPrompt', kind: 'loop', fields: {} },
          { id: 'loop:ready', kind: 'loop', fields: { prompt: 'status?' } },
        ],
        edges: [
          { kind: 'targets', from: 'loop:noPrompt', to: 'agent:Alice' },
          { kind: 'targets', from: 'loop:ready', to: 'agent:Alice' },
        ],
      } as TopologyDraft['drafts'],
    }));

    expect(byId(merged, 'loop:blank').missing.map(item => item.field)).toEqual(['roles', 'prompt']);
    expect(byId(merged, 'loop:noPrompt').missing.map(item => item.field)).toEqual(['prompt']);
    expect(byId(merged, 'loop:ready').complete).toBe(true);
  });

  it('explains when a connection points at an agent that is still a draft', () => {
    const merged = withDrafts(
      [
        { id: 'watchdog:health', kind: 'watchdog', fields: { coordinator: 'Alice' } },
        { id: 'agent:Sketch', kind: 'agent', fields: { mission: 'm' } },
      ],
      [{ kind: 'watches', from: 'watchdog:health', to: 'agent:Sketch' }],
    );
    const health = byId(merged, 'watchdog:health');

    expect(health.complete).toBe(false);
    expect(health.missing.map(item => item.field)).toEqual(['watch']);
    expect(health.missing[0].fix).toContain('Sketch');
  });

  it('blocks a draft whose name the fleet already uses, mirroring the config layer', () => {
    const config = fleet({
      roles: [role('Alice', 'm'), role('Bot', 'm', 'Watchdog-taken')],
      watchdogs: [watchdog('health')],
    });
    const merged = mergeTopology(config, [], drafted({
      drafts: {
        nodes: [
          { id: 'agent:health', kind: 'agent', fields: { mission: 'm' } },
          { id: 'watchdog:Alice', kind: 'watchdog', fields: { coordinator: 'Alice' } },
          { id: 'watchdog:taken', kind: 'watchdog', fields: { coordinator: 'Alice' } },
          { id: 'loop:Alice', kind: 'loop', fields: { prompt: 'p' } },
        ],
        edges: [],
      } as TopologyDraft['drafts'],
    }));

    expect(byId(merged, 'agent:health')).toMatchObject({ valid: false, complete: false });
    expect(byId(merged, 'agent:health').missing[0].why).toContain('a watchdog');
    expect(byId(merged, 'watchdog:Alice')).toMatchObject({ valid: false });
    expect(byId(merged, 'watchdog:taken').missing[0].why).toContain('Watchdog-taken');
    // Loop names share no namespace with roles or watchdogs, so this one is fine.
    expect(byId(merged, 'loop:Alice')).toMatchObject({ valid: true, complete: false });
    expect(byId(merged, 'loop:Alice').missing.map(item => item.field)).toEqual(['roles']);
  });
});

describe('watchdog watch semantics', () => {
  it('marks a configured implicit watchdog and relabels its edges', () => {
    const config = fleet({
      roles: [role('Alice', 'm'), role('Bob', 'm')],
      watchdogs: [watchdog('all', { watch: ['Alice', 'Bob'], watchExplicit: false })],
    });
    const merged = mergeTopology(config, [roleItem('Alice'), roleItem('Bob')], drafted());
    const watches = merged.edges.filter(edge => edge.kind === 'watches');

    expect(watches).toHaveLength(2);
    for (const edge of watches) {
      expect(edge.implicit).toBe(true);
      expect(edge.label).toBe(IMPLICIT_WATCH_LABEL);
      expect(edge.origin).toBe('config');
    }
  });

  it('keeps an explicit configured watch list scoped and labelled as-is', () => {
    const config = fleet({
      roles: [role('Alice', 'm'), role('Bob', 'm')],
      watchdogs: [watchdog('scoped', { watch: ['Alice'], watchExplicit: true })],
    });
    const merged = mergeTopology(config, [roleItem('Alice'), roleItem('Bob')], drafted());
    const watches = merged.edges.filter(edge => edge.kind === 'watches');

    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ to: 'agent:Alice', implicit: false, label: 'watches' });
  });

  it('draws a standalone draft watchdog against every persistent agent', () => {
    const config = fleet({ roles: [role('Alice', 'm')] });
    const merged = mergeTopology(config, [roleItem('Alice'), roleItem('Temp', 'temporary')], drafted({
      drafts: {
        nodes: [
          { id: 'watchdog:health', kind: 'watchdog', fields: { coordinator: 'Alice' } },
          { id: 'agent:Sketch', kind: 'agent', fields: { mission: 'm' } },
        ],
        edges: [],
      } as TopologyDraft['drafts'],
    }));
    const watches = merged.edges.filter(edge => edge.kind === 'watches');

    expect(watches.map(edge => edge.to).sort()).toEqual(['agent:Alice', 'agent:Sketch']);
    expect(watches.every(edge => edge.implicit && edge.origin === 'draft')).toBe(true);
    expect(watches.every(edge => edge.label === IMPLICIT_WATCH_LABEL)).toBe(true);
  });

  it('scopes a draft watchdog that was created from an agent, and covers no one else', () => {
    const config = fleet({ roles: [role('Alice', 'm'), role('Bob', 'm')] });
    const merged = mergeTopology(config, [roleItem('Alice'), roleItem('Bob')], drafted({
      drafts: {
        nodes: [{ id: 'watchdog:forAlice', kind: 'watchdog', fields: { coordinator: 'Alice' } }],
        edges: [{ kind: 'watches', from: 'watchdog:forAlice', to: 'agent:Alice' }],
      } as TopologyDraft['drafts'],
    }));
    const watches = merged.edges.filter(edge => edge.kind === 'watches');

    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ to: 'agent:Alice', implicit: false, origin: 'draft' });
  });
});

describe('drafts overlaid on configuration', () => {
  it('supports several intervals delivering to one agent', () => {
    const config = fleet({ roles: [role('Alice', 'm')], loops: [loop('morning', ['Alice'])] });
    const merged = mergeTopology(config, [roleItem('Alice')], drafted({
      drafts: {
        nodes: [
          { id: 'loop:evening', kind: 'loop', fields: { prompt: 'p' } },
          { id: 'loop:weekly', kind: 'loop', fields: { prompt: 'p' } },
        ],
        edges: [
          { kind: 'targets', from: 'loop:evening', to: 'agent:Alice' },
          { kind: 'targets', from: 'loop:weekly', to: 'agent:Alice' },
        ],
      } as TopologyDraft['drafts'],
    }));

    expect(merged.edges.filter(edge => edge.kind === 'targets' && edge.to === 'agent:Alice')).toHaveLength(3);
    expect(byId(merged, 'loop:evening').complete).toBe(true);
    expect(byId(merged, 'loop:weekly').complete).toBe(true);
  });

  it('attaches stored positions and drops positions for nodes that vanished', () => {
    const config = fleet({ roles: [role('Alice', 'm')] });
    const merged = mergeTopology(config, [roleItem('Alice')], drafted({
      positions: { 'agent:Alice': { x: 410, y: 62 }, 'agent:Gone': { x: 1, y: 2 } },
    }));

    expect(byId(merged, 'agent:Alice').position).toEqual({ x: 410, y: 62 });
    expect(merged.nodes.map(node => node.id)).not.toContain('agent:Gone');
  });

  it('reports a draft the configuration has since claimed instead of shadowing it', () => {
    const config = fleet({ roles: [role('Alice', 'Ship safely')] });
    const merged = mergeTopology(config, [roleItem('Alice', 'permanent', 'Ship safely')], drafted({
      drafts: {
        nodes: [{ id: 'agent:Alice', kind: 'agent', fields: { mission: 'stale sketch' } }],
        edges: [],
      } as TopologyDraft['drafts'],
    }));

    expect(merged.nodes.filter(node => node.id === 'agent:Alice')).toHaveLength(1);
    expect(byId(merged, 'agent:Alice')).toMatchObject({ origin: 'config', detail: 'Ship safely' });
    expect(merged.problems).toEqual([expect.objectContaining({ code: 'draft_conflicts_with_config' })]);
    expect(merged.problems[0].detail).toContain('agent:Alice');
  });

  it('keeps a draft edge whose endpoint disappeared, marked dangling', () => {
    const merged = mergeTopology(fleet(), [], drafted({
      drafts: {
        nodes: [{ id: 'watchdog:health', kind: 'watchdog', fields: { coordinator: 'Alice' } }],
        edges: [{ kind: 'watches', from: 'watchdog:health', to: 'agent:Removed' }],
      } as TopologyDraft['drafts'],
    }));
    const edge = merged.edges.find(candidate => candidate.to === 'agent:Removed')!;

    expect(edge).toMatchObject({ dangling: true, origin: 'draft' });
    expect(merged.edges.filter(candidate => !candidate.dangling)).toEqual([]);
  });

  it('passes the draft store problems through without blocking the graph', () => {
    const merged = mergeTopology(fleet({ roles: [role('Alice', 'm')] }), [roleItem('Alice')], drafted({}, {
      problem: { code: 'draft_corrupt', severity: 'warning', detail: 'unreadable', source: 'topology.json' },
      writable: false,
    }));

    expect(merged.nodes).toHaveLength(1);
    expect(merged.problems).toEqual([expect.objectContaining({ code: 'draft_corrupt' })]);
    expect(merged.draftWritable).toBe(false);
  });

  it('carries enabled state for configured and drafted automation', () => {
    const config = fleet({
      roles: [role('Alice', 'm')],
      watchdogs: [watchdog('off', { enabled: false, watch: ['Alice'] })],
      loops: [loop('on', ['Alice'])],
    });
    const merged = mergeTopology(config, [roleItem('Alice')], drafted({
      drafts: {
        nodes: [{ id: 'loop:draftOff', kind: 'loop', fields: { prompt: 'p', enabled: false } }],
        edges: [{ kind: 'targets', from: 'loop:draftOff', to: 'agent:Alice' }],
      } as TopologyDraft['drafts'],
    }));

    expect(byId(merged, 'watchdog:off').enabled).toBe(false);
    expect(byId(merged, 'loop:on').enabled).toBe(true);
    expect(byId(merged, 'loop:draftOff').enabled).toBe(false);
    expect(byId(merged, 'agent:Alice').enabled).toBeUndefined();
  });
});
