import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseDuration } from '../duration.js';
import { ConfigError, ROLE_NAME_RE, resolveRoleModel } from '../config.js';
import type { FleetConfig, ResolvedRole, SessionBackendId } from '../config.js';
import { validateIsolationConfig } from '../isolation/policy.js';
import type { IsolationConfig } from '../isolation/types.js';

export interface WatchdogConfig {
  coordinator?: string; enabled?: boolean; interval?: string; watch?: string[];
  harness?: string; model?: string | null; session?: string; identity?: string;
  timeout?: string; keep_reports?: number; alert_cooldown?: string; prompt_file?: string;
  isolation?: IsolationConfig;
}
export interface ResolvedWatchdog {
  name: string; coordinator: string; enabled: boolean; intervalMs: number;
  watch: string[]; watchExplicit: boolean; harness: string; session: SessionBackendId; model?: string;
  identity: string; timeoutMs: number; keepReports: number; alertCooldownMs: number;
  promptFile?: string; isolation?: IsolationConfig; sourceFile: string;
}

const WATCHDOG_KEYS = [
  'coordinator', 'enabled', 'interval', 'watch', 'harness', 'model', 'session',
  'identity', 'timeout', 'keep_reports', 'alert_cooldown', 'prompt_file', 'isolation',
];
export const WATCHDOG_DEFAULT_INTERVAL_MS = 600_000;
export const WATCHDOG_MIN_INTERVAL_MS = 60_000;
export const WATCHDOG_DEFAULT_TIMEOUT_MS = 300_000;
export const WATCHDOG_DEFAULT_KEEP_REPORTS = 50;
export const WATCHDOG_DEFAULT_COOLDOWN_MS = 3_600_000;

function deepSub(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map(x => deepSub(x, vars));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(x, vars)]));
  return v;
}

export function resolveWatchdogs(
  baseDoc: Record<string, unknown>, baseFile: string, roles: ResolvedRole[],
  vars: Record<string, string>, defaults: Record<string, unknown>,
): ResolvedWatchdog[] {
  const block = baseDoc.watchdogs;
  if (block === undefined || block === null) return [];
  if (typeof block !== 'object' || Array.isArray(block))
    throw new ConfigError(`${baseFile}: watchdogs: must be a map`);
  const roleNames = new Set(roles.map(r => r.name));
  const roleIdentities = new Set(roles.map(r => r.identity));
  // Tracks identity -> owning watchdog name across entries (final review #5):
  // two watchdogs declaring the same identity would otherwise share a temp
  // dir, tmux session, and run lock with no error until they collide at
  // runtime.
  const watchdogIdentities = new Map<string, string>();
  const out: ResolvedWatchdog[] = [];
  for (const [name, rawEntry] of Object.entries(block as Record<string, unknown>)) {
    const where = `${baseFile}: watchdog '${name}'`;
    if (!ROLE_NAME_RE.test(name))
      throw new ConfigError(`${baseFile}: invalid watchdog name '${name}' (allowed: [A-Za-z0-9_-])`);
    if (roleNames.has(name))
      throw new ConfigError(`${baseFile}: watchdog '${name}' collides with a role name`);
    const w = deepSub(rawEntry ?? {}, vars) as WatchdogConfig;
    const bad = Object.keys(w).filter(k => !WATCHDOG_KEYS.includes(k));
    if (bad.length)
      throw new ConfigError(`${where} has unknown key(s) ${bad.join(', ')}; allowed: ${WATCHDOG_KEYS.join(', ')}`);
    if (typeof w.coordinator !== 'string' || !w.coordinator.trim())
      throw new ConfigError(`${where}: coordinator is required`);
    const watch = w.watch === undefined ? roles.map(r => r.name) : w.watch;
    if (!Array.isArray(watch) || watch.some(x => typeof x !== 'string'))
      throw new ConfigError(`${where}: watch must be a list of role names`);
    for (const r of watch)
      if (!roleNames.has(r)) throw new ConfigError(`${where}: watch names missing role '${r}'`);
    const identity = w.identity ?? `Watchdog-${name}`;
    if (roleNames.has(identity) || roleIdentities.has(identity))
      throw new ConfigError(`${where}: identity '${identity}' collides with a role name or identity`);
    const collidingWatchdog = watchdogIdentities.get(identity);
    if (collidingWatchdog !== undefined)
      throw new ConfigError(`${where}: identity '${identity}' collides with watchdog '${collidingWatchdog}'`);
    watchdogIdentities.set(identity, name);
    const harness = w.harness ?? (defaults.harness as string | undefined) ?? 'claude-code';
    const sessionRaw = w.session ?? (defaults.session as string | undefined) ?? 'tmux';
    if (sessionRaw !== 'tmux' && sessionRaw !== 'acp')
      throw new ConfigError(`${where}: session must be 'tmux' or 'acp'`);
    if (w.prompt_file !== undefined) {
      if (typeof w.prompt_file !== 'string' || !isAbsolute(w.prompt_file))
        throw new ConfigError(`${where}: prompt_file must be an absolute path`);
      if (!existsSync(w.prompt_file))
        throw new ConfigError(`${where}: prompt_file not found: ${w.prompt_file}`);
    }
    if (w.isolation !== undefined) {
      const problems = validateIsolationConfig(w.isolation);
      if (problems.length) throw new ConfigError(`${where} ${problems.join('; ')}`);
    }
    const dur = (v: string | undefined, key: string, fallback: number, minMs?: number) => {
      if (v === undefined) return fallback;
      try { return parseDuration(v, { name: key, minMs }); }
      catch (e) { throw new ConfigError(`${where}: ${(e as Error).message}`); }
    };
    const keepReports = w.keep_reports ?? WATCHDOG_DEFAULT_KEEP_REPORTS;
    if (!Number.isInteger(keepReports) || keepReports < 1)
      throw new ConfigError(`${where}: keep_reports must be a positive integer`);
    if (w.enabled !== undefined && typeof w.enabled !== 'boolean')
      throw new ConfigError(`${where}: enabled must be true or false`);
    out.push({
      name, coordinator: w.coordinator.trim(),
      enabled: w.enabled ?? true,
      intervalMs: dur(w.interval, 'interval', WATCHDOG_DEFAULT_INTERVAL_MS, WATCHDOG_MIN_INTERVAL_MS),
      watch, watchExplicit: w.watch !== undefined, harness, session: sessionRaw,
      model: resolveRoleModel(w.model, w.harness, defaults),
      identity,
      timeoutMs: dur(w.timeout, 'timeout', WATCHDOG_DEFAULT_TIMEOUT_MS),
      keepReports,
      alertCooldownMs: dur(w.alert_cooldown, 'alert_cooldown', WATCHDOG_DEFAULT_COOLDOWN_MS),
      promptFile: w.prompt_file, isolation: w.isolation, sourceFile: baseFile,
    });
  }
  return out;
}

/**
 * Split `restart`'s argument names into watchdogs (a release, handled
 * directly) and roles (handed to restartRoles). Watchdog names can't collide
 * with role names (config validation guarantees dispatch is unambiguous), so
 * a name matching a configured watchdog is always a release, never a role
 * restart. Order is preserved within each bucket; unknown names fall through
 * to roleNames — findRole errors later, same as today.
 */
export function partitionRestartNames(
  cfg: FleetConfig, names: string[],
): { watchdogNames: string[]; roleNames: string[] } {
  const watchdogNames = names.filter(n => cfg.watchdogs.some(w => w.name === n));
  const roleNames = names.filter(n => !watchdogNames.includes(n));
  return { watchdogNames, roleNames };
}
