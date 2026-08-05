import { FleetError } from '../application/errors.js';
import { ROLE_NAME_RE } from '../config.js';
import { parseDuration } from '../duration.js';
import type {
  ConfigPreviewResult, ConfigWriteResult, EditableFleetModel, FleetConfigService,
} from './fleet-config-service.js';
import type { TopologyDraftStore } from './topology-draft-store.js';
import type { MergedTopology, MergedTopologyNode } from './topology-model.js';

/**
 * Turn sketches into configuration.
 *
 * Promotion is the middle step of sketch -> promote -> launch, and it writes
 * configuration ONLY. It never provisions an identity, never registers a
 * supervisor service and never starts a process: `Launch` is a separate, explicit
 * action. That separation is what makes "visible but not launchable" true at the
 * daemon level rather than as a UI rule.
 *
 * No YAML is written here. The mutation is expressed against the configuration
 * *model* and handed to `FleetConfigService`, so the revision guard, the real
 * loader validating a candidate file, the reviewed diff, the timestamped backup
 * and the atomic 0600 replace are all impossible to bypass.
 */

/** Loop interval when the sketch did not choose one (`resolveLoops` requires it). */
const DEFAULT_LOOP_INTERVAL = '10m';
/** How often an overseer checks a ward when the graph did not say. */
export const DEFAULT_OVERSEE_INTERVAL = '10m';

/** Scalar draft fields that are valid keys of a role mapping. */
const ROLE_FIELDS = ['mission', 'bio', 'persona', 'coordinator', 'harness', 'session', 'model', 'identity', 'cwd'] as const;
/** Scalar draft fields that are valid keys of a watchdog mapping. */
const WATCHDOG_FIELDS = ['coordinator', 'interval', 'enabled'] as const;
/** Scalar draft fields that are valid keys of a loop mapping. */
const LOOP_FIELDS = ['prompt', 'interval', 'initial_delay', 'jitter'] as const;

export interface PromoteRequest {
  ids: string[];
  configRevision: string;
  draftRevision?: string;
}

export interface PromotePreview extends ConfigPreviewResult {
  promoted: string[];
}

export interface PromoteResult extends ConfigWriteResult {
  promoted: string[];
  /** False when the config landed but the sketches could not be cleared. */
  draftsCleared: boolean;
  draftRevision: string;
}

export interface TopologyPromoteOptions {
  drafts: TopologyDraftStore;
  configuration: FleetConfigService;
  topology(): Promise<MergedTopology>;
}

/** One agent taking responsibility for checking on another, drawn on the graph. */
export interface OverseeRequest {
  from: string;
  to: string;
  interval?: string;
  configRevision: string;
}

/** The minimum interval `parseDuration` accepts for a recurring fleet job. */
const MIN_INTERVAL_MS = 60_000;

export class TopologyPromoteService {
  constructor(private readonly options: TopologyPromoteOptions) {}

  async preview(request: PromoteRequest): Promise<PromotePreview> {
    const { model, promoted } = await this.build(request);
    const preview = await this.options.configuration.preview(request.configRevision, model);
    return { ...preview, promoted };
  }

  async promote(request: PromoteRequest): Promise<PromoteResult> {
    const { model, promoted } = await this.build(request);
    const written = await this.options.configuration.write(request.configRevision, model);

    // The configuration is real now. Clearing the sketches is best effort: if the
    // sidecar moved under us the drafts simply resurface as shadowed-by-config,
    // which the merged model already reports, rather than losing the write.
    const cleared = await this.clearDrafts(promoted, request.draftRevision);
    return { ...written, promoted, draftsCleared: cleared.ok, draftRevision: cleared.revision };
  }

  /**
   * What drawing an oversight edge between two agents already in the fleet
   * would write. Same reviewed path as promotion: the caller sees the real diff
   * before anything lands, and this call touches nothing.
   */
  async previewOversee(request: OverseeRequest): Promise<ConfigPreviewResult> {
    return this.options.configuration.preview(request.configRevision, await this.buildOversee(request));
  }

  /**
   * Write the oversight edge. Configuration only — an overseer reads its wards
   * out of its briefing when it next starts, and nothing here starts anything.
   */
  async connectOversee(request: OverseeRequest): Promise<ConfigWriteResult> {
    return this.options.configuration.write(request.configRevision, await this.buildOversee(request));
  }

  /** The configuration model that adding `from oversees to` produces. */
  private async buildOversee(request: OverseeRequest): Promise<EditableFleetModel> {
    const { from, to } = request;
    for (const name of [from, to])
      if (!ROLE_NAME_RE.test(name ?? ''))
        throw new FleetError('invalid_request', `'${name}' is not a valid agent name`);
    if (from === to)
      throw new FleetError('invalid_request', `${from} cannot oversee itself — choose a different agent`);

    const interval = request.interval ?? DEFAULT_OVERSEE_INTERVAL;
    try { parseDuration(interval, { name: 'interval', minMs: MIN_INTERVAL_MS }); }
    catch (error) { throw new FleetError('invalid_request', (error as Error).message); }

    const merged = await this.options.topology();
    const read = this.options.configuration.read();
    if (read.revision !== request.configRevision)
      throw new FleetError('stale_state', 'fleet.yaml changed since it was opened; reload before saving');

    const model = structuredClone(read.model);
    const roles = section(model, 'roles');
    assertConfiguredAgent(merged, roles, from, 'oversee another agent');
    assertConfiguredAgent(merged, roles, to, 'be overseen');

    const entry = mapping(from, roles[from]);
    const existing = Array.isArray(entry.oversee) ? entry.oversee : [];
    if (existing.some(item => (item as { role?: unknown } | null)?.role === to))
      throw new FleetError('conflict', `${from} already oversees ${to}`);
    entry.oversee = [...existing, { role: to, interval }];
    roles[from] = entry;
    return model;
  }

  private async clearDrafts(
    promoted: string[],
    draftRevision: string | undefined,
  ): Promise<{ ok: boolean; revision: string }> {
    const current = this.options.drafts.read();
    if (draftRevision !== undefined && draftRevision !== current.revision)
      return { ok: false, revision: current.revision };
    const promotedIds = new Set(promoted);
    const next = {
      ...current.draft,
      drafts: {
        nodes: current.draft.drafts.nodes.filter(node => !promotedIds.has(node.id)),
        /*
         * A drawn edge is owned by its SOURCE — it becomes the source's `watch:`
         * or `roles:` list — so it is materialised, and therefore redundant, only
         * once the source itself is written. Clearing it because the TARGET was
         * promoted silently rewrites the survivor's meaning: a watchdog scoped to
         * one agent loses its only scope edge, reads as standalone, and is then
         * written with no `watch:` key at all — that is, watching everything.
         */
        edges: current.draft.drafts.edges.filter(edge => !promotedIds.has(edge.from)),
      },
    };
    try {
      const written = await this.options.drafts.write(current.revision, next);
      return { ok: true, revision: written.revision };
    } catch {
      return { ok: false, revision: current.revision };
    }
  }

  /** Build the configuration model that adding `ids` produces. */
  private async build(request: PromoteRequest): Promise<{ model: EditableFleetModel; promoted: string[] }> {
    if (!Array.isArray(request.ids) || request.ids.length === 0)
      throw new FleetError('invalid_request', 'name at least one sketch to add to the fleet');

    const merged = await this.options.topology();
    const read = this.options.configuration.read();
    if (read.revision !== request.configRevision)
      throw new FleetError('stale_state', 'fleet.yaml changed since it was opened; reload before adding to the fleet');

    const selected = request.ids.map(id => resolve(merged, id));
    const model = structuredClone(read.model);

    // Agents first: a watchdog's `watch:` list and a loop's `roles:` list may only
    // name roles that exist, including ones being added in this same write.
    for (const node of [...selected].sort(byKind)) addNode(model, node, merged);
    return { model, promoted: selected.map(node => node.id) };
  }
}

const KIND_ORDER: Record<MergedTopologyNode['kind'], number> = { agent: 0, watchdog: 1, loop: 2 };
const byKind = (a: MergedTopologyNode, b: MergedTopologyNode) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

function resolve(merged: MergedTopology, id: string): MergedTopologyNode {
  const node = merged.nodes.find(candidate => candidate.id === id);
  if (!node) throw new FleetError('invalid_request', `there is no sketch called ${id}`);
  if (node.origin !== 'draft')
    throw new FleetError('conflict', `${node.label} is already part of the fleet configuration`);
  if (!node.valid || !node.complete) {
    const why = node.missing.map(item => `${item.field}: ${item.fix}`).join(' ');
    throw new FleetError('invalid_request', `${node.label} is not ready to add — ${why}`);
  }
  return node;
}

function addNode(model: EditableFleetModel, node: MergedTopologyNode, merged: MergedTopology): void {
  const block = section(model, node.kind === 'agent' ? 'roles' : node.kind === 'watchdog' ? 'watchdogs' : 'loops');
  if (block[node.label] !== undefined)
    throw new FleetError('conflict', `${node.label} already exists in the configuration`);
  block[node.label] = node.kind === 'agent' ? agentEntry(node, merged)
    : node.kind === 'watchdog' ? watchdogEntry(node, merged)
      : loopEntry(node, merged, model);
}

/**
 * An agent carries the oversight drawn from it, so a relationship sketched on
 * the graph reaches configuration instead of evaporating at promotion. Only
 * edges pointing at agents that are already in the fleet are written — a draft
 * target is reported as a gap on the source instead, because `oversee:` cannot
 * name a role that does not exist.
 */
function agentEntry(node: MergedTopologyNode, merged: MergedTopology): Record<string, unknown> {
  const wards = linked(merged, node.id, 'oversees');
  return {
    ...pick(node, ROLE_FIELDS),
    ...(wards.length
      ? { oversee: wards.map(role => ({ role, interval: DEFAULT_OVERSEE_INTERVAL })) }
      : {}),
  };
}

/**
 * D4, and the owner requirement it encodes: a watchdog drawn on its own carries
 * NO `watch:` key, which the config layer reads as "every configured role" —
 * so an agent added tomorrow is covered with no edit at all. A watchdog created
 * from a specific agent carries that agent explicitly and stays scoped to it.
 */
function watchdogEntry(node: MergedTopologyNode, merged: MergedTopology): Record<string, unknown> {
  const scoped = linked(merged, node.id, 'watches');
  return { ...pick(node, WATCHDOG_FIELDS), ...(scoped.length ? { watch: scoped } : {}) };
}

function loopEntry(
  node: MergedTopologyNode,
  merged: MergedTopology,
  model: EditableFleetModel,
): Record<string, unknown> {
  const roles = linked(merged, node.id, 'targets');
  const entry: Record<string, unknown> = {
    roles, ...pick(node, LOOP_FIELDS),
  };
  entry.interval ??= DEFAULT_LOOP_INTERVAL;
  // An enabled loop hard-requires `session: acp` on every target. Adding one to a
  // tmux agent would make the whole fleet unloadable, so it arrives switched off
  // and badged instead — the owner turns it on after switching the agent to ACP.
  if (node.enabled === false || !roles.every(role => sessionOf(model, role) === 'acp')) entry.enabled = false;
  return entry;
}

/** Names of the agents this node points at, from drawn edges and derived ones alike. */
function linked(merged: MergedTopology, id: string, kind: 'watches' | 'targets' | 'oversees'): string[] {
  return [...new Set(merged.edges
    .filter(edge => edge.kind === kind && edge.from === id && !edge.implicit && !edge.dangling)
    .map(edge => edge.to.slice('agent:'.length)))].sort();
}

function sessionOf(model: EditableFleetModel, role: string): string {
  const roles = model.roles as Record<string, Record<string, unknown> | null> | undefined;
  const defaults = model.defaults as Record<string, unknown> | undefined;
  return String(roles?.[role]?.session ?? defaults?.session ?? 'tmux');
}

/**
 * Refuse an oversight edge that could not honestly be written, with the reason
 * the owner needs rather than a YAML error.
 *
 * `oversee:` lives in `fleet.yaml` and names roles there, so both ends have to
 * be in the file: a sketch is not configuration yet, and an agent the console
 * only knows from its state directory (a live temporary spawn) has no entry to
 * write into or to be named by.
 */
function assertConfiguredAgent(
  merged: MergedTopology,
  roles: Record<string, unknown>,
  name: string,
  action: string,
): void {
  const node = merged.nodes.find(candidate => candidate.id === `agent:${name}`);
  if (!node) throw new FleetError('invalid_request', `there is no agent called ${name} on the graph`);
  if (node.kind !== 'agent')
    throw new FleetError('invalid_request', `${name} is a ${node.kind}; oversight connects two agents`);
  if (node.origin === 'draft')
    throw new FleetError('invalid_request', `${name} is still a sketch — add it to the fleet before it can ${action}`);
  if (roles[name] === undefined)
    throw new FleetError('invalid_request', `${name} is not in fleet.yaml, so it cannot ${action}`);
}

/**
 * A role entry as an editable mapping — `Alice:` with no body parses as null,
 * which is a legal empty role. Anything else is refused rather than replaced:
 * quietly overwriting a value we do not understand would drop whatever the
 * operator actually wrote there.
 */
function mapping(name: string, value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new FleetError('invalid_request',
      `${name} is not a mapping in fleet.yaml; fix it in the configuration editor first`);
  return value as Record<string, unknown>;
}

function section(model: EditableFleetModel, key: string): Record<string, unknown> {
  const existing = model[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing))
    return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  model[key] = created;
  return created;
}

/** Copy only the sketched fields that are real keys of the target mapping. */
function pick(node: MergedTopologyNode, keys: readonly string[]): Record<string, unknown> {
  const fields = node.fields ?? {};
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}
