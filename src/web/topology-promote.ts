import { FleetError } from '../application/errors.js';
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
  block[node.label] = node.kind === 'agent' ? agentEntry(node)
    : node.kind === 'watchdog' ? watchdogEntry(node, merged)
      : loopEntry(node, merged, model);
}

function agentEntry(node: MergedTopologyNode): Record<string, unknown> {
  return pick(node, ROLE_FIELDS);
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
function linked(merged: MergedTopology, id: string, kind: 'watches' | 'targets'): string[] {
  return [...new Set(merged.edges
    .filter(edge => edge.kind === kind && edge.from === id && !edge.implicit && !edge.dangling)
    .map(edge => edge.to.slice('agent:'.length)))].sort();
}

function sessionOf(model: EditableFleetModel, role: string): string {
  const roles = model.roles as Record<string, Record<string, unknown> | null> | undefined;
  const defaults = model.defaults as Record<string, unknown> | undefined;
  return String(roles?.[role]?.session ?? defaults?.session ?? 'tmux');
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
