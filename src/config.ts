import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { defaultConfigPath, fleetDDir } from './paths.js';
import { validateIsolationConfig } from './isolation/policy.js';
import type { IsolationConfig } from './isolation/types.js';

export interface OverseeEntry { role: string; interval: string }

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
}

export interface ResolvedRole extends RoleConfig {
  name: string;
  harness: string;
  identity: string;
  sourceFile: string;
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
  'isolation',
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
      if (isolation !== undefined) {
        const problems = validateIsolationConfig(isolation);
        if (problems.length)
          throw new ConfigError(`${file}: role '${name}' ${problems.join('; ')}`);
      }
      roles.push({
        ...r,
        name,
        sourceFile: file,
        harness: r.harness ?? (defaults.harness as string | undefined) ?? 'claude-code',
        identity: r.identity ?? name,
        model: r.model ?? (defaults.model as string | undefined),
        max_tokens: r.max_tokens ?? (defaults.max_tokens as number | undefined),
        isolation,
      });
    }
  }
  return { roles, vars, defaults, files };
}

export function findRole(cfg: FleetConfig, name: string): ResolvedRole {
  const r = cfg.roles.find(r => r.name === name);
  if (!r) throw new ConfigError(`no such role '${name}' in ${cfg.files.join(', ') || 'config'}`);
  return r;
}
