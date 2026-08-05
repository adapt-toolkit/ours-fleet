import type { FleetConfig } from '../config.js';
import type { Problem } from '../application/types.js';
import {
  type RuntimeRoleItem, type TopologyEdge, type TopologyNode, deriveTopology,
} from './topology.js';
import type {
  DraftFieldValue, DraftNode, DraftPosition, TopologyDraftRead,
} from './topology-draft-store.js';

/**
 * The console's read model: authoritative configuration overlaid with the
 * sketches and canvas positions from the draft sidecar.
 *
 * `deriveTopology` stays a pure function of resolved config plus the runtime
 * role list — this layer calls it and annotates the result, so the derivation
 * and its tests keep their meaning. Everything drafts add is additive.
 */

export type NodeOrigin = 'draft' | 'config';

/** One actionable reason a node is not yet ready, phrased for the owner. */
export interface MissingRequirement {
  field: string;
  why: string;
  fix: string;
}

export interface MergedTopologyNode extends TopologyNode {
  origin: NodeOrigin;
  /** Would `loadConfig` accept this node's name today. */
  valid: boolean;
  /** Meets the bar for being added to the fleet. */
  complete: boolean;
  /**
   * Whether a process may be started for this node. A draft is never launchable,
   * and not because the UI hides a button: a draft is in no file the supervisor
   * or `ours-fleet up` reads.
   */
  launchable: boolean;
  missing: MissingRequirement[];
  position?: DraftPosition;
  enabled?: boolean;
  /** Sketched values, on draft nodes only — what promotion writes. */
  fields?: Record<string, DraftFieldValue>;
}

export interface MergedTopologyEdge extends TopologyEdge {
  origin: NodeOrigin;
  /** A watchdog with no `watch:` list watches every agent, including later ones. */
  implicit: boolean;
  /** An endpoint that no longer exists — kept visible rather than swallowed. */
  dangling: boolean;
}

export interface MergedTopology {
  nodes: MergedTopologyNode[];
  edges: MergedTopologyEdge[];
  unknownLineage: string[];
  problems: Problem[];
  draftRevision: string;
  draftWritable: boolean;
}

export const IMPLICIT_WATCH_LABEL = 'watches all agents (default)';

const AGENT_MISSION: MissingRequirement = {
  field: 'mission',
  why: 'An agent without a mission has nothing to do and reads as noise on the canvas.',
  fix: 'Write one sentence about this agent\'s job.',
};
const WATCHDOG_COORDINATOR: MissingRequirement = {
  field: 'coordinator',
  why: 'A watchdog reports to exactly one coordinator; the fleet refuses to load without it.',
  fix: 'Name the agent this watchdog reports to.',
};
const LOOP_PROMPT: MissingRequirement = {
  field: 'prompt',
  why: 'An interval delivers a prompt on a schedule; there is nothing to deliver yet.',
  fix: 'Write the prompt this interval should send.',
};
const LOOP_TARGET: MissingRequirement = {
  field: 'roles',
  why: 'An interval needs at least one agent to deliver its prompt to.',
  fix: 'Connect this interval to an agent.',
};

/**
 * Merge configuration and drafts into the graph the console renders.
 *
 * Drift is surfaced, never silently repaired: a draft whose name is now taken
 * by real configuration is reported as a problem rather than shadowing it, a
 * draft edge to a vanished node is kept and marked dangling, and a position for
 * a node that no longer exists is simply dropped.
 */
export function mergeTopology(
  config: FleetConfig,
  roles: RuntimeRoleItem[],
  draft: TopologyDraftRead,
): MergedTopology {
  const snapshot = deriveTopology(config, roles);
  const problems: Problem[] = draft.problem ? [draft.problem] : [];

  const configIds = new Set(snapshot.nodes.map(node => node.id));
  const shadowed = draft.draft.drafts.nodes.filter(node => configIds.has(node.id));
  if (shadowed.length)
    problems.push({
      code: 'draft_conflicts_with_config',
      severity: 'warning',
      source: 'topology.json',
      detail: `${shadowed.map(node => node.id).join(', ')} now exist${shadowed.length === 1 ? 's' : ''} in the fleet configuration; rename the draft to keep sketching it`,
    });

  const draftNodes = draft.draft.drafts.nodes.filter(node => !configIds.has(node.id));
  const draftEdges = draft.draft.drafts.edges;

  const nodes: MergedTopologyNode[] = [
    ...snapshot.nodes.map(node => configNode(node, config)),
    ...draftNodes.map(node => draftNode(node, draftEdges, draftNodes, config)),
  ];

  const known = new Map(nodes.map(node => [node.id, node]));
  const implicitConfigWatchdogs = new Set(
    config.watchdogs.filter(watchdog => !watchdog.watchExplicit).map(watchdog => `watchdog:${watchdog.name}`));

  const edges: MergedTopologyEdge[] = [
    ...snapshot.edges.map(edge => annotate(edge, 'config',
      edge.kind === 'watches' && implicitConfigWatchdogs.has(edge.from), known)),
    ...draftEdges.map(edge => annotate({
      id: `${edge.kind}:${edge.from}:${edge.to}`, kind: edge.kind,
      from: edge.from, to: edge.to, label: edgeLabel(edge.kind),
    }, 'draft', false, known)),
    ...implicitDraftWatchEdges(draftNodes, draftEdges, nodes, known),
  ];

  for (const node of nodes) {
    const position = draft.draft.positions[node.id];
    if (position) node.position = position;
  }

  return {
    nodes,
    edges,
    unknownLineage: snapshot.unknownLineage,
    problems,
    draftRevision: draft.revision,
    draftWritable: draft.writable,
  };
}

/* ------------------------------------------------------------------ *
 * Configured nodes
 * ------------------------------------------------------------------ */

function configNode(node: TopologyNode, config: FleetConfig): MergedTopologyNode {
  const name = node.id.slice(node.kind.length + 1);
  const missing: MissingRequirement[] = [];
  let enabled: boolean | undefined;

  if (node.kind === 'agent') {
    const role = config.roles.find(candidate => candidate.name === name);
    // A role reachable only through its on-disk state directory is running
    // configuration we cannot inspect; do not invent a gap for it.
    if (role && !nonBlank(role.mission)) missing.push(AGENT_MISSION);
  } else if (node.kind === 'watchdog') {
    enabled = config.watchdogs.find(candidate => candidate.name === name)?.enabled;
  } else {
    enabled = config.loops.find(candidate => candidate.name === name)?.enabled;
  }

  const complete = missing.length === 0;
  return { ...node, origin: 'config', valid: true, complete, launchable: complete, missing, enabled };
}

/* ------------------------------------------------------------------ *
 * Draft nodes
 * ------------------------------------------------------------------ */

function draftNode(
  node: DraftNode,
  edges: TopologyDraftRead['draft']['drafts']['edges'],
  draftNodes: DraftNode[],
  config: FleetConfig,
): MergedTopologyNode {
  const name = node.id.slice(node.kind.length + 1);
  const missing: MissingRequirement[] = [];

  const collision = nameConflict(node.kind, name, config);
  if (collision)
    missing.push({
      field: 'name',
      why: `The fleet already uses the name "${name}" for ${collision}.`,
      fix: 'Rename this draft before adding it to the fleet.',
    });

  const draftIds = new Set(draftNodes.map(other => other.id));
  const outgoing = edges.filter(edge => edge.from === node.id);
  const stillDraft = (kind: DraftLinkKind) => outgoing
    .filter(edge => edge.kind === kind && draftIds.has(edge.to))
    .map(edge => edge.to.slice('agent:'.length));

  if (node.kind === 'agent') {
    if (!nonBlank(node.fields.mission)) missing.push(AGENT_MISSION);
  } else if (node.kind === 'watchdog') {
    if (!nonBlank(node.fields.coordinator)) missing.push(WATCHDOG_COORDINATOR);
    pushPendingTargets(missing, 'watch', stillDraft('watches'),
      'A watchdog may only watch agents that are already in the fleet.');
  } else {
    if (!outgoing.some(edge => edge.kind === 'targets')) missing.push(LOOP_TARGET);
    if (!nonBlank(node.fields.prompt)) missing.push(LOOP_PROMPT);
    pushPendingTargets(missing, 'roles', stillDraft('targets'),
      'An interval may only deliver to agents that are already in the fleet.');
  }

  return {
    id: node.id,
    kind: node.kind,
    label: name,
    status: 'draft',
    detail: draftDetail(node),
    origin: 'draft',
    valid: !collision,
    complete: missing.length === 0,
    launchable: false,   // a draft is in no file the supervisor reads
    missing,
    fields: node.fields,
    enabled: node.fields.enabled === undefined ? undefined : node.fields.enabled !== false,
  };
}

type DraftLinkKind = 'oversees' | 'watches' | 'targets';

function pushPendingTargets(
  missing: MissingRequirement[],
  field: string,
  pending: string[],
  why: string,
): void {
  if (!pending.length) return;
  missing.push({
    field, why,
    fix: `Add ${pending.join(', ')} to the fleet first, or remove the connection.`,
  });
}

function draftDetail(node: DraftNode): string | undefined {
  const value = node.kind === 'agent' ? node.fields.mission
    : node.kind === 'watchdog' ? node.fields.coordinator && `Reports to ${node.fields.coordinator}`
      : node.fields.prompt;
  return nonBlank(value) ? String(value) : undefined;
}

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

function annotate(
  edge: TopologyEdge,
  origin: NodeOrigin,
  implicit: boolean,
  known: Map<string, MergedTopologyNode>,
): MergedTopologyEdge {
  return {
    ...edge,
    label: implicit ? IMPLICIT_WATCH_LABEL : edge.label,
    origin,
    implicit,
    dangling: !known.has(edge.from) || !known.has(edge.to),
  };
}

/**
 * A draft watchdog nobody scoped to a single agent is a *standalone* watchdog:
 * promoting it omits `watch:`, which the config layer reads as "every role".
 * Draw that so the owner sees the coverage before adding it, and so an agent
 * added later is visibly covered with no edit at all.
 */
function implicitDraftWatchEdges(
  draftNodes: DraftNode[],
  draftEdges: TopologyDraftRead['draft']['drafts']['edges'],
  nodes: MergedTopologyNode[],
  known: Map<string, MergedTopologyNode>,
): MergedTopologyEdge[] {
  const persistentAgents = nodes.filter(node => node.kind === 'agent' && node.lifetime !== 'temporary');
  return draftNodes
    .filter(node => node.kind === 'watchdog'
      && !draftEdges.some(edge => edge.kind === 'watches' && edge.from === node.id))
    .flatMap(watchdog => persistentAgents.map(agent => annotate({
      id: `watches:${watchdog.id}:${agent.id}`, kind: 'watches',
      from: watchdog.id, to: agent.id, label: IMPLICIT_WATCH_LABEL,
    }, 'draft', true, known)));
}

const edgeLabel = (kind: DraftLinkKind): string =>
  (kind === 'watches' ? 'watches' : kind === 'targets' ? 'delivers to' : 'oversees');

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/**
 * What already owns `name`, or undefined when a draft of this kind may use it.
 *
 * Deliberately mirrors the collisions the config layer actually rejects and no
 * others: a watchdog name may not equal a role name, and a watchdog identity
 * (`Watchdog-<name>` by default) may not equal a role name, a role identity or
 * another watchdog identity. Loop names share no namespace with anything, so a
 * loop is only ever blocked by another loop of the same name.
 */
function nameConflict(
  kind: MergedTopologyNode['kind'],
  name: string,
  config: FleetConfig,
): string | undefined {
  if (kind === 'loop') return undefined;

  if (kind === 'agent') {
    // Adding a role named N breaks any watchdog already using N as its identity.
    if (config.watchdogs.some(watchdog => watchdog.name === name)) return 'a watchdog';
    const identity = config.watchdogs.find(watchdog => watchdog.identity === name);
    return identity ? `watchdog ${identity.name}'s identity` : undefined;
  }

  if (config.roles.some(role => role.name === name)) return 'a role';
  const identity = `Watchdog-${name}`;
  if (config.roles.some(role => role.name === identity)) return `a role, which this watchdog's identity "${identity}" would collide with`;
  if (config.roles.some(role => role.identity === identity)) return `a role identity, which this watchdog's identity "${identity}" would collide with`;
  const other = config.watchdogs.find(watchdog => watchdog.identity === identity);
  return other ? `watchdog ${other.name}'s identity "${identity}"` : undefined;
}

const nonBlank = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
