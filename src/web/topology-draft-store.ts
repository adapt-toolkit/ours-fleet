import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { FleetError } from '../application/errors.js';
import type { Problem } from '../application/types.js';
import type { TopologyEdgeKind, TopologyNodeKind } from './topology.js';

/**
 * Durable storage for *sketches*: nodes the owner has drawn but not yet added to
 * the fleet, and where every node sits on the canvas.
 *
 * This file is deliberately invisible to `loadConfig`. An incomplete agent in
 * `roles:` would be started by `ours-fleet up`, and an incomplete watchdog or
 * loop is a hard `ConfigError` that makes the entire fleet unloadable — so a
 * draft cannot live in fleet.yaml at all. Being outside the config also makes
 * "visible but not launchable" true at the daemon level rather than in the UI.
 *
 * Nothing here is authoritative and nothing here is a secret: the schema admits
 * only presentational coordinates and a small allowlist of plain draft fields,
 * so `env:`/`vars:` values can never reach it.
 */

export const TOPOLOGY_DRAFT_VERSION = 1;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_NODES = 500;
const MAX_EDGES = 2000;
const MAX_POSITIONS = 2000;
const MAX_COORDINATE = 100_000;
const MAX_FIELDS_PER_NODE = 32;
const MAX_FIELD_LENGTH = 16 * 1024;
const MAX_TUTORIAL_STEP = 32;

const NODE_ID_RE = /^(agent|watchdog|loop):[A-Za-z0-9_-]{1,64}$/;
const NODE_KINDS: readonly TopologyNodeKind[] = ['agent', 'watchdog', 'loop'];
/** `spawned` is runtime provenance, never a drawn edge. */
const EDGE_KINDS: readonly TopologyEdgeKind[] = ['oversees', 'watches', 'targets'];

/**
 * Draft fields the console may persist. An allowlist rather than a denylist so
 * secret-bearing keys (`env`, `vars`, `harness_options`) are excluded by
 * construction; extend it deliberately when the inspector grows a field.
 */
const FIELD_KEYS: readonly string[] = [
  'mission', 'bio', 'persona', 'coordinator', 'prompt',
  'interval', 'initial_delay', 'jitter', 'enabled',
  'harness', 'session', 'model', 'reasoning_effort', 'cwd',
];

export type DraftFieldValue = string | number | boolean;

export interface DraftPosition { x: number; y: number }
export interface DraftNode {
  id: string;
  kind: TopologyNodeKind;
  fields: Record<string, DraftFieldValue>;
}
export interface DraftEdge {
  kind: 'oversees' | 'watches' | 'targets';
  from: string;
  to: string;
}
export interface DraftTutorial { step: number; dismissed: boolean }

export interface TopologyDraft {
  version: number;
  positions: Record<string, DraftPosition>;
  drafts: { nodes: DraftNode[]; edges: DraftEdge[] };
  tutorial: DraftTutorial;
}

export interface TopologyDraftRead {
  draft: TopologyDraft;
  revision: string;
  /** Set when the stored file was unusable and an empty draft is being served. */
  problem?: Problem;
  /** False when the file was written by a newer console and must not be clobbered. */
  writable: boolean;
}

export interface TopologyDraftWriteResult {
  draft: TopologyDraft;
  revision: string;
}

export const emptyDraft = (): TopologyDraft => ({
  version: TOPOLOGY_DRAFT_VERSION,
  positions: {},
  drafts: { nodes: [], edges: [] },
  tutorial: { step: 0, dismissed: false },
});

export interface TopologyDraftStoreOptions { dir?: string }

export class TopologyDraftStore {
  readonly path: string;
  private readonly dir: string;

  constructor(options: TopologyDraftStoreOptions = {}) {
    this.dir = options.dir ?? join(stateRoot(), 'web');
    this.path = join(this.dir, 'topology.json');
  }

  /**
   * Never throws. A missing, unreadable, oversized, malformed or future-version
   * sidecar degrades to an empty draft plus a `problem` the console can show as
   * a banner — losing sketches is bad, but blocking the console on them is worse.
   */
  read(): TopologyDraftRead {
    const raw = this.readRaw();
    const revision = digest(raw.text);
    if (raw.problem) return { draft: emptyDraft(), revision, problem: raw.problem, writable: true };
    if (raw.text === '') return { draft: emptyDraft(), revision, writable: true };

    let parsed: unknown;
    try { parsed = JSON.parse(raw.text); }
    catch (error) {
      return {
        draft: emptyDraft(), revision, writable: true,
        problem: problem('draft_corrupt', `topology drafts are unreadable and were ignored: ${(error as Error).message}`),
      };
    }
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version === 'number' && version > TOPOLOGY_DRAFT_VERSION)
      return {
        draft: emptyDraft(), revision, writable: false,
        problem: problem('draft_version_unsupported',
          `topology drafts were written by a newer console (version ${version}); update ours-fleet to edit them`),
      };
    return { draft: coerceDraft(parsed), revision, writable: true };
  }

  /**
   * Revision-guarded, atomic, 0600. Strict on the way in: an out-of-bounds
   * coordinate, an unknown field or an unparseable id is refused with a reason
   * rather than silently dropped, because the caller is the console's own
   * editor and a silent drop would look like data loss.
   */
  async write(baseRevision: string, next: unknown): Promise<TopologyDraftWriteResult> {
    const draft = validateDraft(next);
    const text = `${JSON.stringify(draft, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_FILE_BYTES)
      throw new FleetError('invalid_request', `topology drafts exceed ${MAX_FILE_BYTES} bytes`);

    return withFileLock(`${this.path}.lock`, () => {
      const current = this.read();
      if (!current.writable)
        throw new FleetError('incompatible_version', current.problem?.detail ?? 'topology drafts are not writable');
      if (!baseRevision || baseRevision !== current.revision)
        throw new FleetError('stale_state', 'topology drafts changed since they were opened; reload before saving');
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      replaceFileAtomically(this.path, text, 0o600);
      return { draft, revision: digest(text) };
    });
  }

  private readRaw(): { text: string; problem?: Problem } {
    if (!existsSync(this.path)) return { text: '' };
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink())
        return { text: '', problem: problem('draft_unreadable', 'topology drafts must be a regular non-symlink file') };
      if (stat.size > MAX_FILE_BYTES)
        return { text: '', problem: problem('draft_unreadable', `topology drafts exceed ${MAX_FILE_BYTES} bytes and were ignored`) };
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid)
        return { text: '', problem: problem('draft_unreadable', 'topology drafts are not owned by the current user') };
      return { text: readFileSync(this.path, 'utf8') };
    } catch (error) {
      return { text: '', problem: problem('draft_unreadable', `topology drafts could not be read: ${(error as Error).message}`) };
    }
  }
}

const problem = (code: string, detail: string): Problem =>
  ({ code, severity: 'warning', detail, source: 'topology.json' });

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/* ------------------------------------------------------------------ *
 * Lenient read coercion — drop what does not fit, keep the rest.
 * ------------------------------------------------------------------ */

function coerceDraft(value: unknown): TopologyDraft {
  const draft = emptyDraft();
  if (!isRecord(value)) return draft;

  const positions = value.positions;
  if (isRecord(positions)) for (const [id, raw] of Object.entries(positions).slice(0, MAX_POSITIONS)) {
    if (!NODE_ID_RE.test(id) || !isRecord(raw)) continue;
    if (!isCoordinate(raw.x) || !isCoordinate(raw.y)) continue;
    draft.positions[id] = { x: raw.x, y: raw.y };
  }

  const drafts = isRecord(value.drafts) ? value.drafts : {};
  const seenNodes = new Set<string>();
  if (Array.isArray(drafts.nodes)) for (const raw of drafts.nodes) {
    if (draft.drafts.nodes.length >= MAX_NODES) break;
    const node = coerceNode(raw);
    if (!node || seenNodes.has(node.id)) continue;
    seenNodes.add(node.id);
    draft.drafts.nodes.push(node);
  }

  const seenEdges = new Set<string>();
  if (Array.isArray(drafts.edges)) for (const raw of drafts.edges) {
    if (draft.drafts.edges.length >= MAX_EDGES) break;
    const edge = coerceEdge(raw);
    if (!edge) continue;
    const key = `${edge.kind}:${edge.from}:${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    draft.drafts.edges.push(edge);
  }

  if (isRecord(value.tutorial)) {
    const { step, dismissed } = value.tutorial;
    if (typeof step === 'number' && Number.isInteger(step) && step >= 0 && step <= MAX_TUTORIAL_STEP)
      draft.tutorial.step = step;
    draft.tutorial.dismissed = dismissed === true;
  }
  return draft;
}

function coerceNode(value: unknown): DraftNode | undefined {
  if (!isRecord(value)) return undefined;
  const { id, kind } = value;
  if (typeof id !== 'string' || !NODE_ID_RE.test(id)) return undefined;
  if (typeof kind !== 'string' || !NODE_KINDS.includes(kind as TopologyNodeKind)) return undefined;
  if (!id.startsWith(`${kind}:`)) return undefined;
  const fields: Record<string, DraftFieldValue> = {};
  if (isRecord(value.fields)) for (const [key, raw] of Object.entries(value.fields)) {
    if (Object.keys(fields).length >= MAX_FIELDS_PER_NODE) break;
    if (!FIELD_KEYS.includes(key) || !isFieldValue(raw)) continue;
    fields[key] = raw;
  }
  return { id, kind: kind as TopologyNodeKind, fields };
}

function coerceEdge(value: unknown): DraftEdge | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, from, to } = value;
  if (typeof kind !== 'string' || !EDGE_KINDS.includes(kind as TopologyEdgeKind)) return undefined;
  if (typeof from !== 'string' || !NODE_ID_RE.test(from)) return undefined;
  if (typeof to !== 'string' || !NODE_ID_RE.test(to) || from === to) return undefined;
  return { kind: kind as DraftEdge['kind'], from, to };
}

/* ------------------------------------------------------------------ *
 * Strict write validation — refuse with a reason.
 * ------------------------------------------------------------------ */

function validateDraft(value: unknown): TopologyDraft {
  if (!isRecord(value)) throw invalid('topology draft must be a JSON object');
  const version = value.version ?? TOPOLOGY_DRAFT_VERSION;
  if (version !== TOPOLOGY_DRAFT_VERSION)
    throw invalid(`unsupported topology draft version ${String(version)}`);

  const draft = emptyDraft();

  const positions = value.positions ?? {};
  if (!isRecord(positions)) throw invalid('positions must be an object');
  const positionIds = Object.keys(positions);
  if (positionIds.length > MAX_POSITIONS) throw invalid(`at most ${MAX_POSITIONS} node positions are supported`);
  for (const id of positionIds) {
    if (!NODE_ID_RE.test(id)) throw invalid(`invalid node id in positions: ${id}`);
    const raw = positions[id];
    if (!isRecord(raw) || !isCoordinate(raw.x) || !isCoordinate(raw.y))
      throw invalid(`position for ${id} must be finite x/y within ±${MAX_COORDINATE}`);
    draft.positions[id] = { x: raw.x, y: raw.y };
  }

  const drafts = value.drafts ?? {};
  if (!isRecord(drafts)) throw invalid('drafts must be an object');
  const nodes = drafts.nodes ?? [];
  const edges = drafts.edges ?? [];
  if (!Array.isArray(nodes)) throw invalid('drafts.nodes must be an array');
  if (!Array.isArray(edges)) throw invalid('drafts.edges must be an array');
  if (nodes.length > MAX_NODES) throw invalid(`at most ${MAX_NODES} draft nodes are supported`);
  if (edges.length > MAX_EDGES) throw invalid(`at most ${MAX_EDGES} draft edges are supported`);

  const seenNodes = new Set<string>();
  for (const raw of nodes) {
    const node = validateNode(raw);
    if (seenNodes.has(node.id)) throw invalid(`duplicate draft node ${node.id}`);
    seenNodes.add(node.id);
    draft.drafts.nodes.push(node);
  }

  const seenEdges = new Set<string>();
  for (const raw of edges) {
    const edge = validateEdge(raw);
    const key = `${edge.kind}:${edge.from}:${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    draft.drafts.edges.push(edge);
  }

  const tutorial = value.tutorial ?? {};
  if (!isRecord(tutorial)) throw invalid('tutorial must be an object');
  const step = tutorial.step ?? 0;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > MAX_TUTORIAL_STEP)
    throw invalid(`tutorial.step must be an integer between 0 and ${MAX_TUTORIAL_STEP}`);
  draft.tutorial = { step, dismissed: tutorial.dismissed === true };
  return draft;
}

function validateNode(value: unknown): DraftNode {
  if (!isRecord(value)) throw invalid('each draft node must be an object');
  const { id, kind } = value;
  if (typeof id !== 'string' || !NODE_ID_RE.test(id))
    throw invalid(`draft node id must look like agent:<Name>: ${JSON.stringify(id)}`);
  if (typeof kind !== 'string' || !NODE_KINDS.includes(kind as TopologyNodeKind))
    throw invalid(`draft node ${id} has an unknown kind ${JSON.stringify(kind)}`);
  if (!id.startsWith(`${kind}:`)) throw invalid(`draft node ${id} does not match kind ${kind}`);

  const rawFields = value.fields ?? {};
  if (!isRecord(rawFields)) throw invalid(`draft node ${id} fields must be an object`);
  const keys = Object.keys(rawFields);
  if (keys.length > MAX_FIELDS_PER_NODE)
    throw invalid(`draft node ${id} has more than ${MAX_FIELDS_PER_NODE} fields`);
  const fields: Record<string, DraftFieldValue> = {};
  for (const key of keys) {
    if (!FIELD_KEYS.includes(key))
      throw invalid(`draft node ${id} may not store field ${JSON.stringify(key)}`);
    const raw = rawFields[key];
    if (!isFieldValue(raw))
      throw invalid(`draft node ${id} field ${key} must be a string under ${MAX_FIELD_LENGTH} characters, a finite number, or a boolean`);
    fields[key] = raw;
  }
  return { id, kind: kind as TopologyNodeKind, fields };
}

function validateEdge(value: unknown): DraftEdge {
  if (!isRecord(value)) throw invalid('each draft edge must be an object');
  const { kind, from, to } = value;
  if (typeof kind !== 'string' || !EDGE_KINDS.includes(kind as TopologyEdgeKind))
    throw invalid(`draft edge has an unknown kind ${JSON.stringify(kind)}`);
  if (typeof from !== 'string' || !NODE_ID_RE.test(from)) throw invalid(`invalid draft edge source ${JSON.stringify(from)}`);
  if (typeof to !== 'string' || !NODE_ID_RE.test(to)) throw invalid(`invalid draft edge target ${JSON.stringify(to)}`);
  if (from === to) throw invalid(`draft edge ${from} cannot point at itself`);
  return { kind: kind as DraftEdge['kind'], from, to };
}

const invalid = (message: string) => new FleetError('invalid_request', message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= -MAX_COORDINATE && value <= MAX_COORDINATE;
}

function isFieldValue(value: unknown): value is DraftFieldValue {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH;
}
