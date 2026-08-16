import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeEdge, EDGE_LEGEND, layoutEdges, layoutTopology, nodeBox, nodeDestination, type Topology } from '../../web/src/topology-presentation.js';

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

describe('topology edge geometry', () => {
  // Every edge kind, across all three columns, plus a temporary child of an
  // agent — the shape the owner reported as detached and misrouted.
  const topology: Topology = {
    nodes: [
      { id: 'agent:Coordinator', kind: 'agent', label: 'Coordinator', status: 'ready' },
      { id: 'agent:Developer-3', kind: 'agent', label: 'Developer-3', status: 'ready', lifetime: 'temporary' },
      { id: 'watchdog:fleet-health', kind: 'watchdog', label: 'fleet-health', status: 'active' },
      { id: 'loop:coordinator-loop', kind: 'loop', label: 'coordinator-loop', status: 'active' },
    ],
    edges: [
      { id: 'spawned', kind: 'spawned', from: 'agent:Coordinator', to: 'agent:Developer-3', label: 'spawned' },
      { id: 'watches', kind: 'watches', from: 'watchdog:fleet-health', to: 'agent:Coordinator', label: 'watches' },
      { id: 'targets', kind: 'targets', from: 'loop:coordinator-loop', to: 'agent:Coordinator', label: 'targets' },
      { id: 'oversees', kind: 'oversees', from: 'agent:Coordinator', to: 'agent:Developer-3', label: 'oversees' },
    ],
    unknownLineage: [],
  };
  const layout = layoutTopology(topology);
  const byId = new Map(layout.nodes.map(node => [node.id, node]));
  const geometry = layoutEdges(topology.edges, layout.nodes);

  it('terminates both endpoints of every edge inside the cards they connect', () => {
    expect(geometry.map(edge => edge.id))
      .toEqual(['spawned', 'watches', 'targets', 'oversees']);
    for (const edge of geometry) {
      const source = topology.edges.find(candidate => candidate.id === edge.id)!;
      const from = nodeBox(byId.get(source.from)!);
      const to = nodeBox(byId.get(source.to)!);
      expect([edge.id, edge.x1 >= from.left && edge.x1 <= from.right]).toEqual([edge.id, true]);
      expect([edge.id, edge.y1 >= from.top && edge.y1 <= from.bottom]).toEqual([edge.id, true]);
      expect([edge.id, edge.x2 >= to.left && edge.x2 <= to.right]).toEqual([edge.id, true]);
      expect([edge.id, edge.y2 >= to.top && edge.y2 <= to.bottom]).toEqual([edge.id, true]);
    }
  });

  it('anchors on the card centre, because the card is translated up by half its height', () => {
    const coordinator = byId.get('agent:Coordinator')!;
    const spawned = geometry.find(edge => edge.id === 'spawned')!;
    // `.topology-node` carries transform: translateY(-50%), so the laid-out y
    // IS the vertical centre; any extra offset walks the line off the card.
    expect(spawned.y1).toBe(coordinator.y);
    expect(spawned.x1).toBe(coordinator.x + 75);
  });

  it('keeps a temporary spawn visibly attached to its parent card', () => {
    const spawned = geometry.find(edge => edge.id === 'spawned')!;
    const parent = byId.get('agent:Coordinator')!;
    const child = byId.get('agent:Developer-3')!;
    // Same column: a vertical segment joining the two agent cards, not a
    // stray drop somewhere else on the canvas.
    expect(spawned.x1).toBe(spawned.x2);
    expect(spawned.y1).toBe(parent.y);
    expect(spawned.y2).toBe(child.y);
    expect(spawned.y2).toBeGreaterThan(spawned.y1);
  });

  it('drops an edge whose endpoint is not laid out instead of drawing it loose', () => {
    expect(layoutEdges([
      { id: 'dangling', kind: 'oversees', from: 'agent:Coordinator', to: 'agent:Ghost', label: 'x' },
    ], layout.nodes)).toEqual([]);
  });

  it('draws edges in the cards own pixel space, never a rescaled viewBox', () => {
    // The cards are absolutely positioned in raw CSS pixels while the overlay
    // is stretched to `.topology-canvas` (min-width: 100%). A viewBox with
    // preserveAspectRatio="none" therefore rescales the x axis by
    // canvasWidth/viewBoxWidth and drags every edge off the cards on a wide
    // viewport. There is no DOM test environment here, so the contract is
    // pinned at the source.
    // Pinned on the component that actually renders the overlay; the read-only
    // FleetTopology it replaced is gone.
    const source = readFileSync(resolve('web/src/TopologyEditor.tsx'), 'utf8');
    expect(source).toMatch(/<svg\b/);
    expect(source).not.toMatch(/viewBox=/);
    expect(source).not.toMatch(/preserveAspectRatio=/);
  });
});
