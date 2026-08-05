import { describe, expect, it } from 'vitest';
import {
  fleetAgents, isInactive, isPastAgent, needsAttention, presentFleet,
} from '../../web/src/fleet-presentation.js';
import { deriveTopology, type RuntimeRoleItem } from '../../src/web/topology.js';
import type { FleetConfig } from '../../src/config.js';

const item = (
  id: string, overall: string, liveness = 'running', reachability = 'online',
  problems: Array<{ source?: string }> = [],
) => ({
  role: { id, config: { mission: `${id} mission` } },
  status: { overall, supervisor: { liveness }, session: { reachability }, problems },
});

/** Every agent in the fixture, as the graph would report it. */
const graphOf = (...ids: string[]) => ({
  nodes: ids.map(id => ({ kind: 'agent', label: id, origin: 'config' })),
});

describe('active-first fleet presentation', () => {
  const live = item('Live', 'ready');
  const warning = item('Warning', 'attention');
  const unknown = item('Unknown', 'unknown', 'unknown', 'unknown');
  const stopped = item('Stopped', 'offline', 'stopped', 'offline');
  const degradedStopped = item('DegradedStopped', 'attention', 'stopped', 'offline');
  const all = [live, warning, unknown, stopped, degradedStopped];
  // Live, Warning, Unknown and Stopped are the fleet; DegradedStopped is only in
  // the inventory because its state directory outlived it.
  const fleet = fleetAgents(graphOf('Live', 'Warning', 'Unknown', 'Stopped'));

  it('lists the fleet, including its stopped agents, and nothing else by default', () => {
    expect(presentFleet(all, { filter: '', fleet, showPast: false, attentionOnly: false })
      .map(value => value.role.id)).toEqual(['Unknown', 'Warning', 'Live', 'Stopped']);
  });

  it('reveals the agents the fleet no longer contains only on request', () => {
    expect(presentFleet(all, { filter: '', fleet, showPast: true, attentionOnly: false })
      .map(value => value.role.id)).toEqual([
        'Unknown', 'Warning', 'DegradedStopped', 'Live', 'Stopped',
      ]);
    expect(isPastAgent(degradedStopped, fleet)).toBe(true);
    expect(isPastAgent(stopped, fleet)).toBe(false);
  });

  it('does not count stopped/offline nodes as needing active attention', () => {
    expect(all.filter(needsAttention).map(value => value.role.id)).toEqual(['Warning', 'Unknown']);
    expect(isInactive(degradedStopped)).toBe(true);
    expect(presentFleet([warning, unknown, stopped], {
      filter: '', fleet, showPast: true, attentionOnly: true,
    }).map(value => value.role.id)).toEqual(['Unknown', 'Warning']);
  });

  it('matches filter text "watchdog" for items carrying a source: watchdog problem', () => {
    const flagged = item('Flagged', 'attention', 'running', 'online', [{ source: 'watchdog' }]);
    const plain = item('Plain', 'attention');
    expect(presentFleet([flagged, plain], {
      filter: 'watchdog', fleet: fleetAgents(graphOf('Flagged', 'Plain')),
      showPast: true, attentionOnly: false,
    }).map(value => value.role.id)).toEqual(['Flagged']);
  });
});

/**
 * The graph and the table below it must be the same collection of agents, and
 * not two rules that happen to agree today. Both are taken here from ONE
 * inventory: the server derives the graph from it, and the table is filtered by
 * the membership the graph reports.
 */
describe('graph and role list parity', () => {
  const runtime = (
    id: string, configured: boolean, live: boolean,
  ): RuntimeRoleItem => ({
    role: {
      id, lifetime: configured ? 'permanent' : 'temporary', configured,
      stateHealth: 'present', detectedBackend: 'acp',
      compatibility: { compatible: true }, problems: [],
    },
    status: {
      roleId: id, observedAt: '2026-08-05T00:00:00.000Z',
      overall: live ? 'ready' : 'offline',
      supervisor: { backend: 'none', liveness: live ? 'running' : 'stopped', detail: '' },
      session: {
        backend: 'acp', reachability: live ? 'online' : 'offline',
        readiness: live ? 'idle' : 'failed', evidence: 'authoritative',
      },
      restart: { circuit: 'closed', consecutiveImmediateFailures: 0, nextDelayMs: 0 },
      monitor: { mode: 'fleet', health: 'armed', stale: false },
      isolation: { degraded: false }, problems: [],
    },
  } as unknown as RuntimeRoleItem);

  const inventory = [
    runtime('Coordinator', true, true),
    runtime('Dormant', true, false),        // configured, never started
    runtime('LiveTemp', false, true),       // a temporary agent running now
    runtime('tmp-9f2c1a', false, false),    // a state directory that outlived its agent
    runtime('OldReviewer', false, false),
  ];
  const config = {
    roles: [{ name: 'Coordinator' }, { name: 'Dormant' }], watchdogs: [], loops: [],
  } as unknown as FleetConfig;

  const presentable = inventory.map(entry => ({
    role: { id: entry.role.id, config: {} }, status: entry.status,
  }));

  it('lists exactly the agents the graph draws', () => {
    const graph = deriveTopology(config, inventory);
    const fleet = fleetAgents(graph as never);
    const listed = presentFleet(presentable, {
      filter: '', fleet, showPast: false, attentionOnly: false,
    }).map(value => value.role.id);

    expect([...fleet].sort()).toEqual(['Coordinator', 'Dormant', 'LiveTemp']);
    expect(listed.sort()).toEqual(graph.nodes
      .filter(node => node.kind === 'agent').map(node => node.label).sort());
    // The identities the graph refused to draw are still in the inventory, one
    // toggle away, so they can be inspected and removed.
    expect(presentFleet(presentable, {
      filter: '', fleet, showPast: true, attentionOnly: false,
    }).map(value => value.role.id).sort())
      .toEqual(['Coordinator', 'Dormant', 'LiveTemp', 'OldReviewer', 'tmp-9f2c1a']);
  });

  it('adds sketches to the graph only, because a sketch is not a role yet', () => {
    const fleet = fleetAgents({
      nodes: [
        { kind: 'agent', label: 'Coordinator', origin: 'config' },
        { kind: 'agent', label: 'Sketch', origin: 'draft' },
        { kind: 'watchdog', label: 'nightwatch', origin: 'config' },
      ],
    });
    expect([...fleet]).toEqual(['Coordinator']);
  });
});
