export type MissingRequirement = { field: string; why: string; fix: string };

export type TopologyNode = {
  id: string; kind: 'agent' | 'watchdog' | 'loop'; label: string; status: string;
  lifetime?: string; href?: string; detail?: string;
  /** Present once the server serves the merged draft/config model. */
  origin?: 'draft' | 'config';
  valid?: boolean;
  complete?: boolean;
  launchable?: boolean;
  missing?: MissingRequirement[];
  position?: { x: number; y: number };
  enabled?: boolean;
  fields?: Record<string, string | number | boolean>;
};
export type TopologyEdge = {
  id: string; kind: 'oversees' | 'watches' | 'targets' | 'spawned';
  from: string; to: string; label: string;
  origin?: 'draft' | 'config';
  implicit?: boolean;
  dangling?: boolean;
};
export type Topology = {
  nodes: TopologyNode[]; edges: TopologyEdge[]; unknownLineage: string[];
  problems?: Array<{ code: string; severity: string; detail: string }>;
  draftRevision?: string;
  draftWritable?: boolean;
};

/**
 * What the node's badge says. Sketching is free, adding to the fleet is a
 * reviewed write, and starting a process is a third, explicit action — the badge
 * has to make which one is available obvious at a glance.
 */
export type NodeBadge = {
  tone: 'draft-incomplete' | 'draft-ready' | 'configured' | 'running';
  text: string;
  detail: string;
};

export function badgeFor(node: TopologyNode): NodeBadge {
  const missing = node.missing ?? [];
  const detail = missing.map(item => `${item.why} ${item.fix}`).join(' ');
  if (node.origin === 'draft') {
    return missing.length
      ? { tone: 'draft-incomplete', text: `Draft · needs ${missing.map(item => item.field).join(', ')}`, detail }
      : { tone: 'draft-ready', text: 'Draft · ready to add', detail: 'Nothing runs until you add it to the fleet.' };
  }
  if (missing.length)
    return { tone: 'draft-incomplete', text: `Configured · needs ${missing.map(item => item.field).join(', ')}`, detail };
  if (node.status === 'ready' || node.status === 'active')
    return { tone: 'running', text: node.status, detail: 'Running.' };
  return { tone: 'configured', text: `Configured · ${node.status}`, detail: 'In the fleet configuration.' };
}

/** A sketch is never launchable, and neither is anything still missing a field. */
export const canLaunch = (node: TopologyNode): boolean => node.launchable === true;
export const canPromote = (node: TopologyNode): boolean =>
  node.origin === 'draft' && node.complete === true && node.valid !== false;

export const EDGE_LEGEND: Array<{ kind: TopologyEdge['kind']; label: string; description: string }> = [
  { kind: 'oversees', label: 'Oversight', description: 'A coordinator is responsible for checking this agent.' },
  { kind: 'watches', label: 'Watchdog', description: 'A watchdog checks this agent on its configured interval.' },
  { kind: 'targets', label: 'Scheduled loop', description: 'A scheduled loop sends recurring work to this agent.' },
  { kind: 'spawned', label: 'Temporary spawn', description: 'This agent was created by another agent; dashed mint shows its runtime parent.' },
];

export function describeEdge(edge: TopologyEdge, nodeId?: string): string {
  const legend = EDGE_LEGEND.find(item => item.kind === edge.kind)!;
  const direction = nodeId === edge.to ? `incoming from ${edge.from}`
    : nodeId === edge.from ? `outgoing to ${edge.to}` : `${edge.from} to ${edge.to}`;
  return `${legend.label}: ${direction}. ${legend.description}`;
}

export interface PositionedNode extends TopologyNode { x: number; y: number }

export function layoutTopology(topology: Topology): { nodes: PositionedNode[]; height: number } {
  const agents = topology.nodes.filter(node => node.kind === 'agent');
  const watchdogs = topology.nodes.filter(node => node.kind === 'watchdog');
  const loops = topology.nodes.filter(node => node.kind === 'loop');
  const spawned = new Map(topology.edges.filter(edge => edge.kind === 'spawned')
    .map(edge => [edge.to, edge.from]));
  const children = new Map<string, TopologyNode[]>();
  for (const node of agents) {
    const parent = spawned.get(node.id);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const orderedAgents: TopologyNode[] = [];
  const visited = new Set<string>();
  const visit = (node: TopologyNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id); orderedAgents.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const root of agents.filter(node => !spawned.has(node.id))) visit(root);
  // A corrupt/cyclic provenance chain cannot hide a node from the fallback.
  for (const node of agents) visit(node);
  const rows = Math.max(orderedAgents.length, watchdogs.length, loops.length, 1);
  const height = Math.max(360, rows * 112 + 70);
  const place = (values: TopologyNode[], x: number): PositionedNode[] => values.map((node, index) => ({
    ...node, x, y: 62 + index * ((height - 110) / Math.max(values.length, 1)),
  }));
  return { nodes: [...place(watchdogs, 80), ...place(orderedAgents, 410), ...place(loops, 750)], height };
}

/**
 * The derived three-column layout, with any position the owner dragged winning.
 *
 * Falling back to the derived slot means a fleet that has never been arranged
 * still renders as a readable graph rather than a pile at the origin, so
 * dragging stays optional.
 */
export function layoutInteractive(topology: Topology): { nodes: PositionedNode[]; height: number } {
  const derived = layoutTopology(topology);
  let lowest = derived.height;
  const nodes = derived.nodes.map(node => {
    if (!node.position) return node;
    lowest = Math.max(lowest, node.position.y + NODE_HEIGHT);
    return { ...node, x: node.position.x, y: node.position.y };
  });
  return { nodes, height: Math.max(derived.height, lowest + 40) };
}

/** Card box in CSS pixels — mirrors `.topology-node` width/min-height in styles.css. */
export const NODE_WIDTH = 150;
export const NODE_HEIGHT = 62;

/**
 * Where an edge must terminate, in the SAME CSS-pixel space the cards are
 * positioned in. `.topology-node` carries `transform: translateY(-50%)`, so a
 * node's `y` is already the card's vertical centre — offsetting it again moves
 * the endpoint off the card.
 */
export function edgeAnchor(node: PositionedNode): { x: number; y: number } {
  return { x: node.x + NODE_WIDTH / 2, y: node.y };
}

export function nodeBox(node: PositionedNode): {
  left: number; right: number; top: number; bottom: number;
} {
  return {
    left: node.x, right: node.x + NODE_WIDTH,
    top: node.y - NODE_HEIGHT / 2, bottom: node.y + NODE_HEIGHT / 2,
  };
}

export interface EdgeGeometry {
  id: string; kind: TopologyEdge['kind']; label: string;
  x1: number; y1: number; x2: number; y2: number;
}

/** Resolve every edge whose endpoints both exist onto its two card anchors. */
export function layoutEdges(edges: TopologyEdge[], nodes: PositionedNode[]): EdgeGeometry[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return edges.flatMap(edge => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return [];
    const start = edgeAnchor(from);
    const end = edgeAnchor(to);
    return [{
      id: edge.id, kind: edge.kind, label: edge.label,
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
    }];
  });
}

export function nodeDestination(node: TopologyNode): { kind: 'agent' | 'watchdog'; id: string } | undefined {
  if (node.kind === 'agent') return { kind: 'agent', id: node.label };
  if (node.kind === 'watchdog') return { kind: 'watchdog', id: node.label };
  return undefined;
}
