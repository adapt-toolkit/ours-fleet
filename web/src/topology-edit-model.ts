/**
 * The rules behind every canvas gesture, kept free of React and the DOM so they
 * can be tested directly.
 *
 * Everything here edits the *sketch* — the draft sidecar. Nothing here writes
 * configuration: turning a sketch into configuration is a separate, reviewed
 * step, and starting it is a third one.
 */

export type NodeKind = 'agent' | 'watchdog' | 'loop';
export type DraftEdgeKind = 'oversees' | 'watches' | 'targets';
export type DraftFieldValue = string | number | boolean;

export interface DraftNode {
  id: string;
  kind: NodeKind;
  fields: Record<string, DraftFieldValue>;
}
export interface DraftEdge { kind: DraftEdgeKind; from: string; to: string }
export interface DraftPosition { x: number; y: number }

export interface TopologyDraft {
  version: number;
  positions: Record<string, DraftPosition>;
  drafts: { nodes: DraftNode[]; edges: DraftEdge[] };
  tutorial: { step: number; dismissed: boolean };
}

/** Mirrors the server's ROLE_NAME_RE, so a sketch cannot be named unpromotable. */
export const NAME_RE = /^[A-Za-z0-9_-]+$/;
/** Mirrors the sidecar's coordinate bound. */
export const MAX_COORDINATE = 100_000;

export const KIND_LABEL: Record<NodeKind, string> = {
  agent: 'agent', watchdog: 'watchdog', loop: 'interval',
};

export const emptyDraft = (): TopologyDraft => ({
  version: 1, positions: {}, drafts: { nodes: [], edges: [] }, tutorial: { step: 0, dismissed: false },
});

export const nodeId = (kind: NodeKind, name: string): string => `${kind}:${name}`;
export const nodeName = (id: string): string => id.slice(id.indexOf(':') + 1);
export const nodeKind = (id: string): NodeKind => id.slice(0, id.indexOf(':')) as NodeKind;

/**
 * Which edge a connection would create, or why it cannot be made.
 *
 * Every connection points AT an agent: a watchdog watches agents, an interval
 * delivers to agents, an agent oversees agents. `spawned` is runtime provenance
 * and is never drawn by hand.
 */
export function edgeFor(from: NodeKind, to: NodeKind): DraftEdgeKind | undefined {
  if (to !== 'agent') return undefined;
  return from === 'agent' ? 'oversees' : from === 'watchdog' ? 'watches' : 'targets';
}

export interface ConnectRefusal { error: string }
const refuse = (error: string): ConnectRefusal => ({ error });
const isRefusal = (value: unknown): value is ConnectRefusal =>
  typeof value === 'object' && value !== null && 'error' in value;

export interface ConnectContext {
  /** Every node currently on the canvas, drafted or configured. */
  kinds: Map<string, NodeKind>;
  /** Ids that are sketches; only a sketch may own a hand-drawn edge. */
  draftIds: Set<string>;
}

/**
 * Add a connection, or explain why not.
 *
 * A hand-drawn edge is stored on the sketch that owns it, so the source must be
 * a draft. Connecting two pieces of live configuration is a configuration edit
 * and belongs in the reviewed configuration editor, not on the sketch pad.
 */
export function connect(
  draft: TopologyDraft, from: string, to: string, context: ConnectContext,
): TopologyDraft | ConnectRefusal {
  if (from === to) return refuse('A node cannot connect to itself.');
  const fromKind = context.kinds.get(from);
  const toKind = context.kinds.get(to);
  if (!fromKind || !toKind) return refuse('That node is no longer on the canvas.');
  if (!context.draftIds.has(from))
    return refuse(`${nodeName(from)} is already part of the fleet. Edit its connections in the configuration editor.`);
  const kind = edgeFor(fromKind, toKind);
  if (!kind)
    return refuse(`A ${KIND_LABEL[fromKind]} cannot connect to a ${KIND_LABEL[toKind]}. Connections always point at an agent.`);
  if (draft.drafts.edges.some(edge => edge.kind === kind && edge.from === from && edge.to === to)) return draft;
  return { ...draft, drafts: { ...draft.drafts, edges: [...draft.drafts.edges, { kind, from, to }] } };
}

/**
 * What connecting two nodes should actually do, or why it cannot be done.
 *
 * Two different writes hide behind one gesture. A sketch owns its own edges, so
 * connecting from one is a local change to the sidecar. An agent that is already
 * in the fleet owns nothing local: the only place its oversight can live is
 * `oversee:` in fleet.yaml, so that gesture is a reviewed configuration write
 * and is named as such here rather than being guessed at in the component.
 */
export type ConnectionPlan =
  | { action: 'draft'; draft: TopologyDraft }
  | { action: 'oversee'; from: string; to: string }
  | ConnectRefusal;

export function planConnection(
  draft: TopologyDraft, from: string, to: string, context: ConnectContext,
): ConnectionPlan {
  const fromKind = context.kinds.get(from);
  const toKind = context.kinds.get(to);
  if (!fromKind || !toKind) return refuse('That node is no longer on the canvas.');
  if (from === to)
    return refuse(fromKind === 'agent'
      ? `${nodeName(from)} cannot oversee itself. Choose a different agent.`
      : 'A node cannot connect to itself.');

  if (context.draftIds.has(from)) {
    const result = connect(draft, from, to, context);
    return isRefusal(result) ? result : { action: 'draft', draft: result };
  }

  if (fromKind !== 'agent')
    return refuse(`${nodeName(from)} is already part of the fleet. Edit its connections in the configuration editor.`);
  if (toKind !== 'agent')
    return refuse(`Oversight points at an agent. Choose an agent for ${nodeName(from)} to oversee.`);
  if (context.draftIds.has(to))
    return refuse(`${nodeName(to)} is still a sketch. Add it to the fleet first — oversight is written into fleet.yaml, which cannot name a sketch.`);
  return { action: 'oversee', from: nodeName(from), to: nodeName(to) };
}

export function disconnect(draft: TopologyDraft, edge: DraftEdge): TopologyDraft {
  return {
    ...draft,
    drafts: {
      ...draft.drafts,
      edges: draft.drafts.edges.filter(candidate =>
        !(candidate.kind === edge.kind && candidate.from === edge.from && candidate.to === edge.to)),
    },
  };
}

/** First free `Agent1`, `Agent2`, … that collides with nothing already on the canvas. */
export function nextName(kind: NodeKind, taken: Iterable<string>): string {
  const stem = kind === 'agent' ? 'Agent' : kind === 'watchdog' ? 'Watchdog' : 'Interval';
  const used = new Set(taken);
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}${index}`;
    if (!used.has(nodeId(kind, candidate))) return candidate;
  }
}

export function addNode(
  draft: TopologyDraft, kind: NodeKind, name: string, position?: DraftPosition,
): TopologyDraft {
  const id = nodeId(kind, name);
  if (draft.drafts.nodes.some(node => node.id === id)) return draft;
  return {
    ...draft,
    positions: position ? { ...draft.positions, [id]: clampPosition(position) } : draft.positions,
    drafts: { ...draft.drafts, nodes: [...draft.drafts.nodes, { id, kind, fields: {} }] },
  };
}

/** Remove a sketch and every connection that touched it — dangling edges help nobody. */
export function removeNode(draft: TopologyDraft, id: string): TopologyDraft {
  const positions = { ...draft.positions };
  delete positions[id];
  return {
    ...draft,
    positions,
    drafts: {
      nodes: draft.drafts.nodes.filter(node => node.id !== id),
      edges: draft.drafts.edges.filter(edge => edge.from !== id && edge.to !== id),
    },
  };
}

export function setField(
  draft: TopologyDraft, id: string, key: string, value: DraftFieldValue | undefined,
): TopologyDraft {
  return {
    ...draft,
    drafts: {
      ...draft.drafts,
      nodes: draft.drafts.nodes.map(node => {
        if (node.id !== id) return node;
        const fields = { ...node.fields };
        if (value === undefined || value === '') delete fields[key];
        else fields[key] = value;
        return { ...node, fields };
      }),
    },
  };
}

export interface RenameRefusal { error: string }

/** Rename a sketch, carrying its edges and position with it. */
export function renameNode(
  draft: TopologyDraft, id: string, name: string, taken: Iterable<string>,
): TopologyDraft | RenameRefusal {
  if (!NAME_RE.test(name))
    return refuse('Use letters, numbers, hyphens and underscores only.');
  const next = nodeId(nodeKind(id), name);
  if (next === id) return draft;
  if (new Set(taken).has(next)) return refuse(`${name} is already taken.`);

  const positions = { ...draft.positions };
  if (positions[id]) { positions[next] = positions[id]; delete positions[id]; }
  return {
    ...draft,
    positions,
    drafts: {
      nodes: draft.drafts.nodes.map(node => (node.id === id ? { ...node, id: next } : node)),
      edges: draft.drafts.edges.map(edge => ({
        ...edge,
        from: edge.from === id ? next : edge.from,
        to: edge.to === id ? next : edge.to,
      })),
    },
  };
}

export function moveNode(draft: TopologyDraft, id: string, position: DraftPosition): TopologyDraft {
  return { ...draft, positions: { ...draft.positions, [id]: clampPosition(position) } };
}

/** Drop positions for nodes that no longer exist, so the sidecar cannot grow forever. */
export function prunePositions(draft: TopologyDraft, live: Iterable<string>): TopologyDraft {
  const known = new Set(live);
  const positions = Object.fromEntries(
    Object.entries(draft.positions).filter(([id]) => known.has(id)));
  return Object.keys(positions).length === Object.keys(draft.positions).length
    ? draft : { ...draft, positions };
}

function clampPosition(position: DraftPosition): DraftPosition {
  const clamp = (value: number) =>
    Math.round(Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, Number.isFinite(value) ? value : 0)));
  return { x: clamp(position.x), y: clamp(position.y) };
}

export { isRefusal };
