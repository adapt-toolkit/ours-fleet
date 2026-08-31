import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parse, stringify } from 'yaml';

import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { loadConfig, ROLE_NAME_RE, splitRootFor } from '../config.js';
import { parseFleetDocument } from '../config-yaml.js';
import { defaultConfigPath } from '../paths.js';
import type { PrereqReport } from '../harness/types.js';
import { FleetError } from '../application/errors.js';
import { redactSourceSecrets, renderModelOntoSource } from './yaml-document-edit.js';
import { isSensitiveConfigKey } from '../sensitive-config.js';

export const REDACTED_ENV_VALUE = '__OURS_FLEET_SECRET_REDACTED__';
const MAX_CONFIG_BYTES = 256 * 1024;
const DIFF_CONTEXT_LINES = 3;
const KINDS = ['agents', 'agent_templates', 'roles', 'brains', 'room_templates'] as const;

export interface EditableFleetModel {
  manifest: Record<string, unknown>;
  agents: Record<string, Record<string, unknown>>;
  agent_templates: Record<string, Record<string, unknown>>;
}

interface SourceSet {
  manifest: string;
  root: string;
  documents: Map<string, string>;
}

export interface ConfigReadResult {
  path: string; exists: true; firstRun: false; revision: string;
  model: EditableFleetModel; redactions: string[];
}

export interface RestartImpact {
  required: boolean; roles: string[]; watchdogScheduler: boolean;
  scheduledLoops: boolean; summary: string;
}

export interface ConfigPreviewResult {
  valid: true; revision: string; normalizedModel: EditableFleetModel;
  diff: string; redactions: string[]; impact: RestartImpact; preflight: PrereqReport;
}

export interface ConfigWriteResult extends ConfigPreviewResult {
  saved: true; newRevision: string; backup?: string;
}

export interface FleetConfigServiceOptions {
  configPath?: string;
  preflight?(configPath: string): Promise<PrereqReport>;
  /** Fault-injection seam; called under lock immediately before each mutation. */
  beforeMutation?(relativePath: string, index: number): void;
}

const emptyReport = (): PrereqReport => ({ ok: true, checks: [] });

export class FleetConfigService {
  readonly path: string;
  private readonly preflight: (path: string) => Promise<PrereqReport>;
  private readonly beforeMutation?: (relativePath: string, index: number) => void;

  constructor(options: FleetConfigServiceOptions = {}) {
    this.path = options.configPath ?? defaultConfigPath();
    this.preflight = options.preflight ?? (async () => emptyReport());
    this.beforeMutation = options.beforeMutation;
  }

  read(): ConfigReadResult {
    const sources = readSources(this.path);
    try { loadConfig(this.path, { yamlMode: 'strict' }); }
    catch (error) { throw safeError(error, sourceSensitiveValues(sources)); }
    const raw = modelFrom(sources);
    const redacted = redactModel(raw);
    return {
      path: basename(this.path), exists: true, firstRun: false,
      revision: revision(sources), model: redacted.model, redactions: redacted.paths,
    };
  }

  async preview(baseRevision: string, input: unknown): Promise<ConfigPreviewResult> {
    const current = readSources(this.path);
    assertRevision(baseRevision, current);
    const currentModel = modelFrom(current);
    const next = restoreRedactions(assertModel(input), currentModel,
      new Set(redactModel(currentModel).paths));
    const proposal = renderProposal(current, next);
    const staged = stageProposal(this.path, current, proposal);
    let preflight: PrereqReport;
    try {
      loadConfig(staged.manifest, { yamlMode: 'strict' });
      preflight = await this.preflight(staged.manifest);
    } catch (error) {
      throw safeError(error, [...sensitiveValues(next), ...sourceSensitiveValues(current)]);
    } finally { staged.remove(); }
    const redacted = redactModel(next);
    return result(current, currentModel, next, proposal, redacted, preflight);
  }

  async write(baseRevision: string, input: unknown): Promise<ConfigWriteResult> {
    return withFileLock(`${splitRootFor(this.path)}.web-edit.lock`, async () => {
      const current = readSources(this.path);
      assertRevision(baseRevision, current);
      const currentModel = modelFrom(current);
      const next = restoreRedactions(assertModel(input), currentModel,
        new Set(redactModel(currentModel).paths));
      const proposal = renderProposal(current, next);
      const changed = changedDocuments(current, proposal);
      const staged = stageProposal(this.path, current, proposal);
      let preflight: PrereqReport;
      try {
        loadConfig(staged.manifest, { yamlMode: 'strict' });
        preflight = await this.preflight(staged.manifest);
      } catch (error) {
        throw safeError(error, [...sensitiveValues(next), ...sourceSensitiveValues(current)]);
      } finally { staged.remove(); }
      assertRevision(baseRevision, readSources(this.path));
      if (!changed.length) {
        const redacted = redactModel(next);
        return { ...result(current, currentModel, next, proposal, redacted, preflight),
          saved: true, newRevision: baseRevision };
      }
      recheckCollisions(current, proposal, changed);
      const backupRoot = mkdtempSync(join(dirname(this.path), '.fleet-web-backup-'));
      chmodSync(backupRoot, 0o700);
      const backupFiles = join(backupRoot, 'files');
      mkdirSync(backupFiles, { recursive: true, mode: 0o700 });
      for (const rel of changed) if (current.documents.has(rel)) {
        const target = join(backupFiles, rel);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        replaceFileAtomically(target, current.documents.get(rel)!, 0o600);
      }
      try {
        changed.forEach((rel, index) => {
          this.beforeMutation?.(rel, index);
          const target = absoluteFor(this.path, rel);
          const contents = proposal.get(rel);
          if (contents === undefined) rmSync(target, { force: true });
          else {
            assertWritableTarget(target, current.documents.has(rel));
            replaceFileAtomically(target, contents, 0o600);
            chmodSync(target, 0o600);
          }
        });
      } catch (error) {
        try {
          for (const rel of changed) {
            const target = absoluteFor(this.path, rel);
            const old = current.documents.get(rel);
            if (old === undefined) rmSync(target, { force: true });
            else replaceFileAtomically(target, old, 0o600);
          }
        } catch (rollback) {
          throw new FleetError('internal', `configuration recovery failed; restore from ${backupRoot}`,
            { details: { rollback: rollback instanceof Error ? rollback.message : String(rollback) } });
        }
        throw safeError(error, sensitiveValues(next));
      }
      const final = readSources(this.path);
      const redacted = redactModel(next);
      return { ...result(current, currentModel, next, proposal, redacted, preflight),
        saved: true, newRevision: revision(final), backup: backupRoot };
    });
  }
}

function trustedFile(path: string): string {
  let stat;
  try { stat = lstatSync(path); } catch { throw new FleetError('invalid_request', `missing configuration source ${path}`); }
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new FleetError('invalid_request', `${path} must be a regular non-symlink file`);
  if (uid !== undefined && stat.uid !== uid)
    throw new FleetError('forbidden', `${path} is not owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new FleetError('forbidden', `${path} is group/world writable`);
  if (stat.size > MAX_CONFIG_BYTES) throw new FleetError('invalid_request', `${path} exceeds ${MAX_CONFIG_BYTES} bytes`);
  return readFileSync(path, 'utf8');
}

function trustedDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FleetError('invalid_request', `${path} must be a non-symlink directory`);
  if (uid !== undefined && stat.uid !== uid) throw new FleetError('forbidden', `${path} is not owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new FleetError('forbidden', `${path} is group/world writable`);
}

function readSources(manifest: string): SourceSet {
  const documents = new Map<string, string>();
  documents.set(basename(manifest), trustedFile(manifest));
  const root = splitRootFor(manifest);
  trustedDirectory(root);
  for (const kind of KINDS) {
    const dir = join(root, kind);
    if (!existsSync(dir)) { if (kind === 'agents') throw new FleetError('invalid_request', `required Agent root missing: ${dir}`); continue; }
    trustedDirectory(dir);
    for (const name of readdirSync(dir).sort()) {
      if ((kind === 'agents' || kind === 'agent_templates' || kind === 'room_templates')
          && !['.yaml', '.yml'].includes(extname(name).toLowerCase())) continue;
      documents.set(join(kind, name), trustedFile(join(dir, name)));
    }
  }
  return { manifest, root, documents };
}

function modelFrom(sources: SourceSet): EditableFleetModel {
  const manifestKey = basename(sources.manifest);
  const manifest = parseFleetDocument(sources.manifest, sources.documents.get(manifestKey)!, 'strict').value;
  const agents: Record<string, Record<string, unknown>> = {};
  const agent_templates: Record<string, Record<string, unknown>> = {};
  for (const [rel, source] of sources.documents) if (rel.startsWith(`agents/`)) {
    const id = basename(rel, extname(rel));
    agents[id] = parseFleetDocument(absoluteFor(sources.manifest, rel), source, 'strict').value;
  }
  for (const [rel, source] of sources.documents) if (rel.startsWith(`agent_templates/`)) {
    const id = basename(rel, extname(rel));
    agent_templates[id] = parseFleetDocument(absoluteFor(sources.manifest, rel), source, 'strict').value;
  }
  return { manifest, agents, agent_templates };
}

function assertModel(value: unknown): EditableFleetModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FleetError('invalid_request', 'model must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'agent_templates,agents,manifest') throw new FleetError('invalid_request', 'model allows exactly manifest, agents, and agent_templates');
  for (const key of ['manifest', 'agents', 'agent_templates']) if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))
    throw new FleetError('invalid_request', `${key} must be an object`);
  for (const [id, doc] of Object.entries(input.agents as Record<string, unknown>)) {
    if (!ROLE_NAME_RE.test(id)) throw new FleetError('invalid_request', `invalid Agent ID '${id}'`);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new FleetError('invalid_request', `Agent '${id}' must be an object`);
  }
  for (const [id, doc] of Object.entries(input.agent_templates as Record<string, unknown>)) {
    if (!ROLE_NAME_RE.test(id)) throw new FleetError('invalid_request', `invalid Agent Template ID '${id}'`);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new FleetError('invalid_request', `Agent Template '${id}' must be an object`);
  }
  return structuredClone(input) as unknown as EditableFleetModel;
}

function renderProposal(current: SourceSet, model: EditableFleetModel): Map<string, string> {
  const next = new Map<string, string>();
  const manifestRel = basename(current.manifest);
  next.set(manifestRel, render(current.documents.get(manifestRel)!, model.manifest));
  for (const [id, doc] of Object.entries(model.agents).sort(([a], [b]) => a.localeCompare(b))) {
    const oldRel = [...current.documents.keys()].find(rel => rel.startsWith('agents/')
      && basename(rel, extname(rel)) === id);
    next.set(oldRel ?? join('agents', `${id}.yaml`), oldRel
      ? render(current.documents.get(oldRel)!, doc) : stringify(doc));
  }
  for (const [id, doc] of Object.entries(model.agent_templates).sort(([a], [b]) => a.localeCompare(b))) {
    const oldRel = [...current.documents.keys()].find(rel => rel.startsWith('agent_templates/')
      && basename(rel, extname(rel)) === id);
    next.set(oldRel ?? join('agent_templates', `${id}.yaml`), oldRel
      ? render(current.documents.get(oldRel)!, doc) : stringify(doc));
  }
  for (const [rel, source] of current.documents) if (
    rel.startsWith('roles/') || rel.startsWith('brains/') || rel.startsWith('room_templates/')
  ) next.set(rel, source);
  return next;
}

function render(source: string, model: Record<string, unknown>): string {
  try { return renderModelOntoSource(source, model); }
  catch (error) { throw safeError(error); }
}

function stageProposal(manifest: string, current: SourceSet, proposal: Map<string, string>) {
  const dir = mkdtempSync(join(dirname(manifest), '.fleet-web-preview-'));
  chmodSync(dir, 0o700);
  const stagedManifest = join(dir, basename(manifest));
  const stagedRoot = splitRootFor(stagedManifest);
  mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(stagedRoot, 'agents'), { mode: 0o700 });
  for (const [rel, source] of proposal) {
    const target = rel === basename(manifest) ? stagedManifest : join(stagedRoot, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    replaceFileAtomically(target, source, 0o600);
  }
  return { manifest: stagedManifest, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function changedDocuments(current: SourceSet, proposal: Map<string, string>): string[] {
  return [...new Set([...current.documents.keys(), ...proposal.keys()])]
    .filter(rel => current.documents.get(rel) !== proposal.get(rel)).sort();
}

function recheckCollisions(current: SourceSet, proposal: Map<string, string>, changed: string[]): void {
  for (const rel of changed) {
    const target = absoluteFor(current.manifest, rel);
    const existed = current.documents.has(rel);
    if (!existed && proposal.has(rel) && existsSync(target)) throw new FleetError('stale_state', `configuration collision at ${rel}`);
    if (existed) trustedFile(target);
  }
}

function assertWritableTarget(path: string, existed: boolean): void {
  if (!existsSync(path)) { if (existed) throw new FleetError('stale_state', `${path} disappeared`); return; }
  trustedFile(path);
}

function absoluteFor(manifest: string, rel: string): string {
  return rel === basename(manifest) ? manifest : join(splitRootFor(manifest), rel);
}

function revision(sources: SourceSet): string {
  const hash = createHash('sha256');
  for (const [rel, bytes] of [...sources.documents].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(`${Buffer.byteLength(rel)}:${rel}:${Buffer.byteLength(bytes)}:`).update(bytes);
  return hash.digest('hex');
}

function assertRevision(expected: string, sources: SourceSet): void {
  if (!expected || expected !== revision(sources)) throw new FleetError('stale_state', 'configuration sources changed since opened; reload before saving');
}

function sensitive(key: string, inEnv: boolean): boolean {
  return inEnv || isSensitiveConfigKey(key);
}

function redactModel(input: EditableFleetModel): { model: EditableFleetModel; paths: string[] } {
  const model = structuredClone(input); const paths: string[] = [];
  const walk = (value: unknown, path: string, inEnv = false): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (inEnv && item !== null && typeof item !== 'object') {
          value[i] = REDACTED_ENV_VALUE; paths.push(`${path}/${i}`);
        } else walk(item, `${path}/${i}`, inEnv);
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = `${path}/${key}`;
      if (sensitive(key, inEnv) && child !== null && typeof child !== 'object') {
        (value as Record<string, unknown>)[key] = REDACTED_ENV_VALUE; paths.push(next);
      } else walk(child, next, inEnv || key === 'env' || sensitive(key, false));
    }
  };
  walk(model, '');
  return { model, paths: paths.sort() };
}

function restoreRedactions(
  next: EditableFleetModel, old: EditableFleetModel, allowed: ReadonlySet<string>,
): EditableFleetModel {
  const walk = (value: unknown, previous: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const prior = Array.isArray(previous) ? previous[i] : undefined;
        if (item === REDACTED_ENV_VALUE) {
          if (!allowed.has(`${path}/${i}`) || prior === undefined)
            throw new FleetError('invalid_request', `${path}/${i} has no prior redacted value`);
          value[i] = structuredClone(prior);
        } else walk(item, prior, `${path}/${i}`);
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const prior = previous && typeof previous === 'object' && !Array.isArray(previous)
        ? (previous as Record<string, unknown>)[key] : undefined;
      if (child === REDACTED_ENV_VALUE) {
        if (!allowed.has(`${path}/${key}`) || prior === undefined)
          throw new FleetError('invalid_request', `${path}/${key} has no prior redacted value`);
        (value as Record<string, unknown>)[key] = structuredClone(prior);
      } else walk(child, prior, `${path}/${key}`);
    }
  };
  walk(next, old, ''); return next;
}

function maskSource(source: string, secrets: string[]): string {
  let masked = redactSourceSecrets(source, REDACTED_ENV_VALUE);
  for (const secret of secrets.sort((a, b) => b.length - a.length))
    if (secret) masked = masked.split(secret).join(REDACTED_ENV_VALUE);
  return masked;
}

function sourceDiff(before: string, after: string, label: string, secrets: string[]): string {
  const left = splitLines(maskSource(before, secrets));
  const right = splitLines(maskSource(after, secrets));
  let head = 0; while (head < left.length && head < right.length && left[head] === right[head]) head++;
  let tail = 0; while (tail < left.length - head && tail < right.length - head
    && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail++;
  if (head === left.length && head === right.length) return '';
  const start = Math.max(0, head - DIFF_CONTEXT_LINES); const trailing = Math.min(DIFF_CONTEXT_LINES, tail);
  return [`--- ${label} (current)`, `+++ ${label} (proposed)`,
    `@@ -${start + 1},${left.length - tail + trailing - start} +${start + 1},${right.length - tail + trailing - start} @@`,
    ...left.slice(start, head).map(x => ` ${x}`), ...left.slice(head, left.length - tail).map(x => `-${x}`),
    ...right.slice(head, right.length - tail).map(x => `+${x}`),
    ...left.slice(left.length - tail, left.length - tail + trailing).map(x => ` ${x}`), ''].join('\n');
}

function proposalDiff(current: SourceSet, proposal: Map<string, string>): string {
  const secrets = sensitiveValues(modelFrom(current));
  try { secrets.push(...sensitiveValues(modelFrom({ ...current, documents: proposal }))); } catch { /* validation reports later */ }
  return [...new Set([...current.documents.keys(), ...proposal.keys()])].sort().map(rel =>
    sourceDiff(current.documents.get(rel) ?? '', proposal.get(rel) ?? '', rel, secrets)).filter(Boolean).join('\n');
}

function splitLines(source: string): string[] { return source.replace(/\n$/, '').split('\n'); }

function restartImpact(before: EditableFleetModel, after: EditableFleetModel): RestartImpact {
  const roles = [...new Set([...Object.keys(before.agents), ...Object.keys(after.agents)])]
    .filter(id => JSON.stringify(before.agents[id]) !== JSON.stringify(after.agents[id])).sort();
  const watchdogScheduler = JSON.stringify(before.manifest.watchdogs) !== JSON.stringify(after.manifest.watchdogs);
  const scheduledLoops = JSON.stringify(before.manifest.loops) !== JSON.stringify(after.manifest.loops);
  const required = roles.length > 0 || watchdogScheduler || scheduledLoops;
  return { required, roles, watchdogScheduler, scheduledLoops,
    summary: required ? 'Save only writes configuration; apply/restart affected roles separately.' : 'No running process needs a restart.' };
}

function result(current: SourceSet, before: EditableFleetModel, after: EditableFleetModel,
  proposal: Map<string, string>, redacted: ReturnType<typeof redactModel>, preflight: PrereqReport): ConfigPreviewResult {
  return { valid: true, revision: revision(current), normalizedModel: redacted.model,
    diff: proposalDiff(current, proposal), redactions: redacted.paths,
    impact: restartImpact(before, after), preflight };
}

function sensitiveValues(model: EditableFleetModel): string[] {
  const values: string[] = [];
  const walk = (value: unknown, inSensitive = false): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item, inSensitive); return; }
    if (!value || typeof value !== 'object') {
      if (inSensitive && typeof value === 'string' && value !== REDACTED_ENV_VALUE) values.push(value);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      walk(child, inSensitive || key === 'env' || sensitive(key, false));
  };
  walk(model); return [...new Set(values)];
}

function sourceSensitiveValues(sources: SourceSet): string[] {
  const values: string[] = [];
  for (const [rel, source] of sources.documents) {
    if (!['.yaml', '.yml'].includes(extname(rel).toLowerCase())) continue;
    try {
      const parsed = parse(source) as unknown;
      values.push(...sensitiveValues({ manifest: {}, agents: { source: parsed as Record<string, unknown> }, agent_templates: {} }));
    } catch { /* the authoritative parser reports malformed YAML */ }
  }
  return [...new Set(values)];
}

function safeError(error: unknown, secrets: string[] = []): FleetError {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.sort((a, b) => b.length - a.length))
    if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/[^\s:]+(?:secret|token|password)[^\s:]*/gi, '[redacted]');
  return new FleetError(error instanceof FleetError ? error.code : 'invalid_request', message);
}
