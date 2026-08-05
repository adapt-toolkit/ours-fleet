export type TopologyNode = {
  id: string; kind: 'agent' | 'watchdog' | 'loop'; label: string; status: string;
  lifetime?: string; href?: string; detail?: string;
};
export type TopologyEdge = {
  id: string; kind: 'oversees' | 'watches' | 'targets' | 'spawned';
  from: string; to: string; label: string;
};
export type Topology = { nodes: TopologyNode[]; edges: TopologyEdge[]; unknownLineage: string[] };

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

export function nodeDestination(node: TopologyNode): { kind: 'agent' | 'watchdog'; id: string } | undefined {
  if (node.kind === 'agent') return { kind: 'agent', id: node.label };
  if (node.kind === 'watchdog') return { kind: 'watchdog', id: node.label };
  return undefined;
}
