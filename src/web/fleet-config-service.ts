import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, readFileSync, rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { loadConfig } from '../config.js';
import { parseFleetDocument } from '../config-yaml.js';
import { defaultConfigPath } from '../paths.js';
import type { PrereqReport } from '../harness/types.js';
import { FleetError } from '../application/errors.js';
import { redactSourceSecrets, renderModelOntoSource } from './yaml-document-edit.js';

export const REDACTED_ENV_VALUE = '__OURS_FLEET_SECRET_REDACTED__';
const MAX_CONFIG_BYTES = 256 * 1024;
const DIFF_CONTEXT_LINES = 3;

export type EditableFleetModel = Record<string, unknown>;

export interface ConfigReadResult {
  path: string;
  exists: boolean;
  firstRun: boolean;
  revision: string;
  model: EditableFleetModel;
  redactions: string[];
}

export interface RestartImpact {
  required: boolean;
  roles: string[];
  watchdogScheduler: boolean;
  scheduledLoops: boolean;
  summary: string;
}

export interface ConfigPreviewResult {
  valid: true;
  revision: string;
  normalizedModel: EditableFleetModel;
  diff: string;
  redactions: string[];
  impact: RestartImpact;
  preflight: PrereqReport;
}

export interface ConfigWriteResult extends ConfigPreviewResult {
  saved: true;
  newRevision: string;
  backup?: string;
}

export interface FleetConfigServiceOptions {
  configPath?: string;
  preflight?(configPath: string): Promise<PrereqReport>;
}

const emptyReport = (): PrereqReport => ({ ok: true, checks: [] });

export class FleetConfigService {
  readonly path: string;
  private readonly preflight: (path: string) => Promise<PrereqReport>;

  constructor(options: FleetConfigServiceOptions = {}) {
    this.path = options.configPath ?? defaultConfigPath();
    this.preflight = options.preflight ?? (async () => emptyReport());
  }

  read(): ConfigReadResult {
    const source = this.readSource();
    const parsed = parseFleetDocument(this.path, source, 'strict').value;
    const redacted = redactModel(parsed);
    return {
      path: basename(this.path), exists: existsSync(this.path),
      firstRun: !existsSync(this.path), revision: digest(source),
      model: redacted.model, redactions: redacted.paths,
    };
  }

  async preview(baseRevision: string, model: unknown): Promise<ConfigPreviewResult> {
    const currentSource = this.readSource();
    this.assertRevision(baseRevision, currentSource);
    const current = parseFleetDocument(this.path, currentSource, 'strict').value;
    const restored = restoreRedactions(assertModel(model), current);
    const nextSource = render(currentSource, restored);
    const candidate = this.validateCandidate(nextSource);
    const redactedNext = redactModel(restored);
    const preflight = await this.preflight(candidate.path).finally(candidate.remove);
    return {
      valid: true, revision: digest(currentSource), normalizedModel: redactedNext.model,
      diff: sourceDiff(currentSource, nextSource),
      redactions: redactedNext.paths,
      impact: restartImpact(current, restored), preflight,
    };
  }

  async write(baseRevision: string, model: unknown): Promise<ConfigWriteResult> {
    return withFileLock(`${this.path}.web-edit.lock`, async () => {
      const currentSource = this.readSource();
      this.assertRevision(baseRevision, currentSource);
      const current = parseFleetDocument(this.path, currentSource, 'strict').value;
      const restored = restoreRedactions(assertModel(model), current);
      const nextSource = render(currentSource, restored);
      const candidate = this.validateCandidate(nextSource);
      const preflight = await this.preflight(candidate.path).finally(candidate.remove);
      // The lock coordinates trusted web/agent writers. An operator's editor does
      // not take it, so re-check immediately before replacement as well.
      this.assertRevision(baseRevision, this.readSource());
      const redactedNext = redactModel(restored);
      let backup: string | undefined;
      if (existsSync(this.path)) {
        backup = `${basename(this.path)}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        replaceFileAtomically(join(dirname(this.path), backup), currentSource, 0o600);
      }
      replaceFileAtomically(this.path, nextSource, 0o600);
      chmodSync(this.path, 0o600);
      return {
        saved: true, valid: true, revision: digest(currentSource), newRevision: digest(nextSource),
        normalizedModel: redactedNext.model,
        diff: sourceDiff(currentSource, nextSource),
        redactions: redactedNext.paths, impact: restartImpact(current, restored), preflight,
        backup,
      };
    });
  }

  private readSource(): string {
    if (!existsSync(this.path)) return 'roles: {}\n';
    const stat = lstatSync(this.path);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new FleetError('invalid_request', 'fleet configuration must be a regular non-symlink file');
    if (stat.size > MAX_CONFIG_BYTES)
      throw new FleetError('invalid_request', `fleet configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
    if (uid !== undefined && stat.uid !== uid)
      throw new FleetError('forbidden', 'fleet configuration is not owned by the current user');
    return readFileSync(this.path, 'utf8');
  }

  private assertRevision(expected: string, source: string): void {
    if (!expected || expected !== digest(source))
      throw new FleetError('stale_state', 'fleet.yaml changed since it was opened; reload before saving');
  }

  private validateCandidate(source: string): { path: string; remove(): void } {
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES)
      throw new FleetError('invalid_request', `fleet configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
    const candidate = join(dirname(this.path), `.${basename(this.path)}.preview-${process.pid}-${randomUUID()}.yaml`);
    replaceFileAtomically(candidate, source, 0o600);
    try { loadConfig(candidate, { yamlMode: 'strict' }); }
    catch (error) {
      rmSync(candidate, { force: true });
      throw new FleetError('invalid_request', (error as Error).message);
    }
    return { path: candidate, remove: () => rmSync(candidate, { force: true }) };
  }
}

function assertModel(value: unknown): EditableFleetModel {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new FleetError('invalid_request', 'model must be a JSON object');
  return structuredClone(value as EditableFleetModel);
}

/**
 * Apply the edited model onto the user's own document rather than re-serializing
 * it, so comments, key order and formatting outside the edit survive the save.
 */
function render(currentSource: string, model: EditableFleetModel): string {
  try { return renderModelOntoSource(currentSource, model); }
  catch (error) { throw new FleetError('invalid_request', (error as Error).message); }
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function envMaps(model: EditableFleetModel): Array<{ path: string; map: Record<string, unknown> }> {
  const maps: Array<{ path: string; map: Record<string, unknown> }> = [];
  const add = (value: unknown, path: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      maps.push({ path, map: value as Record<string, unknown> });
  };
  add((model.defaults as Record<string, unknown> | undefined)?.env, 'defaults.env');
  const roles = model.roles;
  if (roles && typeof roles === 'object' && !Array.isArray(roles))
    for (const [name, raw] of Object.entries(roles))
      add((raw as Record<string, unknown> | null)?.env, `roles.${name}.env`);
  return maps;
}

function redactModel(input: EditableFleetModel): { model: EditableFleetModel; paths: string[] } {
  const model = structuredClone(input);
  const paths: string[] = [];
  const secretVars = new Set<string>();
  for (const item of envMaps(model)) for (const [key, value] of Object.entries(item.map)) {
    if (typeof value === 'string')
      for (const match of value.matchAll(/\$\{(\w+)\}/g)) secretVars.add(match[1]);
    item.map[key] = REDACTED_ENV_VALUE;
    paths.push(`${item.path}.${key}`);
  }
  const vars = model.vars;
  if (vars && typeof vars === 'object' && !Array.isArray(vars))
    for (const key of secretVars) if (key in vars) {
      (vars as Record<string, unknown>)[key] = REDACTED_ENV_VALUE;
      paths.push(`vars.${key}`);
    }
  return { model, paths: paths.sort() };
}

function restoreRedactions(next: EditableFleetModel, current: EditableFleetModel): EditableFleetModel {
  const oldByPath = new Map(envMaps(current).map(item => [item.path, item.map]));
  for (const item of envMaps(next)) for (const [key, value] of Object.entries(item.map)) {
    if (value !== REDACTED_ENV_VALUE) continue;
    const previous = oldByPath.get(item.path)?.[key];
    if (previous === undefined)
      throw new FleetError('invalid_request', `${item.path}.${key} uses a redaction marker with no prior value`);
    item.map[key] = previous;
  }
  const nextVars = next.vars as Record<string, unknown> | undefined;
  const oldVars = current.vars as Record<string, unknown> | undefined;
  if (nextVars) for (const [key, value] of Object.entries(nextVars)) {
    if (value !== REDACTED_ENV_VALUE) continue;
    if (!oldVars || oldVars[key] === undefined)
      throw new FleetError('invalid_request', `vars.${key} uses a redaction marker with no prior value`);
    nextVars[key] = oldVars[key];
  }
  return next;
}

/**
 * Unified-style diff of the real file text with env secrets masked. Common
 * leading/trailing lines are trimmed, so a surgical edit reviews as a small
 * hunk instead of the whole configuration twice.
 */
function sourceDiff(beforeSource: string, afterSource: string): string {
  const before = splitLines(redactSourceSecrets(beforeSource, REDACTED_ENV_VALUE));
  const after = splitLines(redactSourceSecrets(afterSource, REDACTED_ENV_VALUE));
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  if (head === before.length && head === after.length) return '';

  const start = Math.max(0, head - DIFF_CONTEXT_LINES);
  const trailing = Math.min(DIFF_CONTEXT_LINES, tail);
  const beforeSpan = before.length - tail + trailing - start;
  const afterSpan = after.length - tail + trailing - start;
  return [
    '--- fleet.yaml (current)', '+++ fleet.yaml (proposed)',
    `@@ -${start + 1},${beforeSpan} +${start + 1},${afterSpan} @@`,
    ...before.slice(start, head).map(line => ` ${line}`),
    ...before.slice(head, before.length - tail).map(line => `-${line}`),
    ...after.slice(head, after.length - tail).map(line => `+${line}`),
    ...before.slice(before.length - tail, before.length - tail + trailing).map(line => ` ${line}`),
    '',
  ].join('\n');
}

function splitLines(source: string): string[] {
  return source.replace(/\n$/, '').split('\n');
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function restartImpact(before: EditableFleetModel, after: EditableFleetModel): RestartImpact {
  const changed = (key: string) => JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  const beforeRoles = (before.roles ?? {}) as Record<string, unknown>;
  const afterRoles = (after.roles ?? {}) as Record<string, unknown>;
  const roles = [...new Set([...objectKeys(beforeRoles), ...objectKeys(afterRoles)])]
    .filter(name => JSON.stringify(beforeRoles[name]) !== JSON.stringify(afterRoles[name])).sort();
  if (changed('defaults')) roles.splice(0, roles.length, ...objectKeys(afterRoles).sort());
  const watchdogScheduler = changed('watchdogs');
  const scheduledLoops = changed('loops');
  const required = roles.length > 0 || watchdogScheduler || scheduledLoops || changed('vars');
  const parts = [roles.length ? `${roles.length} role${roles.length === 1 ? '' : 's'}` : '',
    watchdogScheduler ? 'watchdog scheduler' : '', scheduledLoops ? 'scheduled loops' : ''].filter(Boolean);
  return {
    required, roles, watchdogScheduler, scheduledLoops,
    summary: required ? `Save only writes configuration; apply/restart ${parts.join(', ') || 'affected roles'} separately.`
      : 'No running process needs a restart.',
  };
}
