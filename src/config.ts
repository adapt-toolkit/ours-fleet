import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { defaultConfigPath, fleetDDir } from './paths.js';
import { validateIsolationConfig } from './isolation/policy.js';
import type { IsolationConfig } from './isolation/types.js';

export interface OverseeEntry { role: string; interval: string }

/** The 8 content-free event types the ours daemon appends to notifications.log. */
export const NOTIFY_EVENT_TYPES = [
  'message_received', 'file_received', 'sibling_contact_added', 'local_contact_request',
  'pending_message', 'contact_restored', 'inbound_error', 'state_import_failed',
] as const;
export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];
export type InjectMode = 'notification' | 'full';

/** Resolved per-role supervisor-monitor config (see DESIGN-external-monitor §2). */
export interface MonitorConfig {
  enabled: boolean;
  wake_sources: string[];
  batch_ms: number;
  inject: InjectMode;
}

/** Default wake sources when a role does not list its own (design §2). */
export const DEFAULT_WAKE_SOURCES: NotifyEventType[] =
  ['message_received', 'file_received', 'local_contact_request', 'pending_message'];
const MONITOR_KEYS = ['enabled', 'wake_sources', 'batch_ms', 'inject'];
const INJECT_MODES: InjectMode[] = ['notification', 'full'];
const MONITOR_DEFAULT_BATCH_MS = 2000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate a raw (role-level or merged) `monitor:` block; returns human-readable problems. */
export function validateMonitorConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(raw)) return ['monitor: must be a mapping'];
  const m = raw;
  const bad = Object.keys(m).filter(k => !MONITOR_KEYS.includes(k));
  if (bad.length)
    problems.push(`monitor: unknown key(s) ${bad.join(', ')}; allowed: ${MONITOR_KEYS.join(', ')}`);
  if (m.enabled !== undefined && typeof m.enabled !== 'boolean')
    problems.push('monitor.enabled: must be true or false');
  if (m.batch_ms !== undefined
      && (typeof m.batch_ms !== 'number' || !Number.isFinite(m.batch_ms) || m.batch_ms < 0))
    problems.push('monitor.batch_ms: must be a non-negative number');
  if (m.inject !== undefined && !INJECT_MODES.includes(m.inject as InjectMode))
    problems.push(`monitor.inject: invalid value '${m.inject}'; allowed: ${INJECT_MODES.join(', ')}`);
  if (m.wake_sources !== undefined) {
    if (!Array.isArray(m.wake_sources)) problems.push('monitor.wake_sources: must be a list');
    else {
      const unknown = m.wake_sources.filter(w => !NOTIFY_EVENT_TYPES.includes(w as NotifyEventType));
      if (unknown.length)
        problems.push(
          `monitor.wake_sources: unknown source(s) ${unknown.join(', ')}; ` +
          `allowed: ${NOTIFY_EVENT_TYPES.join(', ')}`);
    }
  }
  return problems;
}

export interface RoleConfig {
  harness?: string;
  identity?: string;
  cwd?: string;
  coordinator?: string;
  mission?: string;
  persona?: string;
  bio?: string;
  briefing_file?: string;
  model?: string;
  max_tokens?: number;
  autocompact_pct?: number;
  env?: Record<string, string>;
  oversee?: OverseeEntry[];
  harness_options?: Record<string, unknown>;
  isolation?: IsolationConfig;
  monitor?: Partial<MonitorConfig>;
}

export interface ResolvedRole extends RoleConfig {
  name: string;
  harness: string;
  identity: string;
  sourceFile: string;
  monitor: MonitorConfig;
}

export interface FleetConfig {
  roles: ResolvedRole[];
  vars: Record<string, string>;
  defaults: Record<string, unknown>;
  files: string[];
}

export class ConfigError extends Error {}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const ROLE_KEYS = [
  'harness', 'identity', 'cwd', 'coordinator', 'mission', 'persona', 'bio',
  'briefing_file', 'model', 'max_tokens', 'autocompact_pct', 'env', 'oversee', 'harness_options',
  'isolation', 'monitor',
];

function deepSub(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map(x => deepSub(x, vars));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(x, vars)]));
  return v;
}

/** Load ~/fleet.yaml (or an explicit path) merged with ~/fleet.d/*.yaml drop-ins. */
export function loadConfig(configPath?: string): FleetConfig {
  const base = configPath ?? defaultConfigPath();
  const files: string[] = [];
  const docs: { file: string; doc: Record<string, unknown> }[] = [];
  if (existsSync(base)) {
    docs.push({ file: base, doc: (parse(readFileSync(base, 'utf8')) ?? {}) as Record<string, unknown> });
    files.push(base);
  } else if (configPath) {
    throw new ConfigError(`config not found: ${base}`);
  }
  const dd = fleetDDir();
  if (existsSync(dd)) {
    for (const f of readdirSync(dd).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort()) {
      const p = join(dd, f);
      const doc = (parse(readFileSync(p, 'utf8')) ?? {}) as Record<string, unknown>;
      const extra = Object.keys(doc).filter(k => k !== 'roles');
      if (extra.length)
        throw new ConfigError(`${p}: fleet.d files may only define roles: (found: ${extra.join(', ')})`);
      docs.push({ file: p, doc });
      files.push(p);
    }
  }
  const baseDoc = docs.length && docs[0].file === base ? docs[0].doc : {};
  const vars = (baseDoc.vars ?? {}) as Record<string, string>;
  const defaults = (baseDoc.defaults ?? {}) as Record<string, unknown>;
  const seen = new Map<string, string>();
  const roles: ResolvedRole[] = [];
  for (const { file, doc } of docs) {
    for (const [name, raw] of Object.entries((doc.roles ?? {}) as Record<string, RoleConfig | null>)) {
      if (!NAME_RE.test(name))
        throw new ConfigError(`${file}: invalid role name '${name}' (allowed: [A-Za-z0-9_-])`);
      const prev = seen.get(name);
      if (prev) throw new ConfigError(`role '${name}' defined in both ${prev} and ${file}`);
      seen.set(name, file);
      const r = deepSub(raw ?? {}, vars) as RoleConfig;
      const bad = Object.keys(r).filter(k => !ROLE_KEYS.includes(k));
      if (bad.length)
        throw new ConfigError(
          `${file}: role '${name}' has unknown key(s) ${bad.join(', ')}; allowed: ${ROLE_KEYS.join(', ')}`);
      const isolation = r.isolation ?? (defaults.isolation as IsolationConfig | undefined);
      const defaultHarnessOptions = defaults.harness_options;
      if (defaultHarnessOptions !== undefined
          && (typeof defaultHarnessOptions !== 'object' || defaultHarnessOptions === null
              || Array.isArray(defaultHarnessOptions)))
        throw new ConfigError(`${base}: defaults.harness_options must be a map`);
      const harnessOptions = defaultHarnessOptions === undefined && r.harness_options === undefined
        ? undefined
        : {
            ...((defaultHarnessOptions ?? {}) as Record<string, unknown>),
            ...(r.harness_options ?? {}),
          };
      if (isolation !== undefined) {
        const problems = validateIsolationConfig(isolation);
        if (problems.length)
          throw new ConfigError(`${file}: role '${name}' ${problems.join('; ')}`);
      }
      const monitor = resolveMonitor(defaults.monitor, r.monitor, base, file, name);
      roles.push({
        ...r,
        name,
        sourceFile: file,
        harness: r.harness ?? (defaults.harness as string | undefined) ?? 'claude-code',
        identity: r.identity ?? name,
        model: r.model ?? (defaults.model as string | undefined),
        max_tokens: r.max_tokens ?? (defaults.max_tokens as number | undefined),
        harness_options: harnessOptions,
        isolation,
        monitor,
      });
    }
  }
  return { roles, vars, defaults, files };
}

/**
 * Merge `defaults.monitor` under the role's own `monitor:` key-by-key, validate the
 * result, and fill code-constant defaults (design §2). `defaults.monitor.enabled`
 * is the fleet-wide default; absent everywhere ⇒ enabled. Throws ConfigError on a
 * malformed block so a typo fails loudly rather than silently disarming a monitor.
 */
function resolveMonitor(
  defMonitor: unknown, roleMonitor: Partial<MonitorConfig> | undefined,
  base: string, file: string, name: string,
): MonitorConfig {
  if (defMonitor !== undefined && !isPlainObject(defMonitor))
    throw new ConfigError(`${base}: defaults.monitor must be a map`);
  if (roleMonitor !== undefined && !isPlainObject(roleMonitor))
    throw new ConfigError(`${file}: role '${name}' monitor: must be a mapping`);
  const merged: Record<string, unknown> = {
    ...((defMonitor ?? {}) as Record<string, unknown>),
    ...((roleMonitor ?? {}) as Record<string, unknown>),
  };
  const problems = validateMonitorConfig(merged);
  if (problems.length) throw new ConfigError(`${file}: role '${name}' ${problems.join('; ')}`);
  return {
    enabled: (merged.enabled as boolean | undefined) ?? true,
    wake_sources: (merged.wake_sources as string[] | undefined) ?? [...DEFAULT_WAKE_SOURCES],
    batch_ms: (merged.batch_ms as number | undefined) ?? MONITOR_DEFAULT_BATCH_MS,
    inject: (merged.inject as InjectMode | undefined) ?? 'notification',
  };
}

export function findRole(cfg: FleetConfig, name: string): ResolvedRole {
  const r = cfg.roles.find(r => r.name === name);
  if (!r) throw new ConfigError(`no such role '${name}' in ${cfg.files.join(', ') || 'config'}`);
  return r;
}
