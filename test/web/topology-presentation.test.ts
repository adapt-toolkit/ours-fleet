import { describe, expect, it } from 'vitest';
import { describeEdge, EDGE_LEGEND, layoutTopology, nodeDestination, type Topology } from '../../web/src/topology-presentation.js';

describe('topology presentation', () => {
  const topology: Topology = {
    nodes: [
      { id: 'agent:Parent', kind: 'agent', label: 'Parent', status: 'ready' },
      { id: 'agent:Child', kind: 'agent', label: 'Child', status: 'ready', lifetime: 'temporary' },
      { id: 'agent:Grandchild', kind: 'agent', label: 'Grandchild', status: 'ready', lifetime: 'temporary' },
      { id: 'watchdog:watch', kind: 'watchdog', label: 'watch', status: 'active' },
      { id: 'loop:loop', kind: 'loop', label: 'loop', status: 'active' },
    ],
    edges: [
      { id: 'spawned', kind: 'spawned', from: 'agent:Parent', to: 'agent:Child', label: 'spawned' },
      { id: 'spawned-2', kind: 'spawned', from: 'agent:Child', to: 'agent:Grandchild', label: 'spawned' },
    ],
    unknownLineage: [],
  };

  it('places an attributed temporary child directly after its parent', () => {
    const agents = layoutTopology(topology).nodes.filter(node => node.kind === 'agent');
    expect(agents.map(node => node.label)).toEqual(['Parent', 'Child', 'Grandchild']);
    expect(agents[1].y).toBeGreaterThan(agents[0].y);
  });

  it('navigates agents and watchdogs but keeps loops informational', () => {
    expect(nodeDestination(topology.nodes[0])).toEqual({ kind: 'agent', id: 'Parent' });
    expect(nodeDestination(topology.nodes[3])).toEqual({ kind: 'watchdog', id: 'watch' });
    expect(nodeDestination(topology.nodes[4])).toBeUndefined();
  });

  it('defines an accessible explanation for every edge style and fallback direction', () => {
    expect(EDGE_LEGEND.map(item => item.kind)).toEqual(['oversees', 'watches', 'targets', 'spawned']);
    expect(describeEdge(topology.edges[0], 'agent:Child')).toContain('incoming from agent:Parent');
    expect(EDGE_LEGEND.every(item => item.description.length > 20)).toBe(true);
  });
});
