import type { CommonPermissions, ResolvedRole } from './config.js';
import { getAdapter } from './harness/registry.js';
import type { UnattendedCapability } from './harness/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './paths.js';

/**
 * The capability floor every unattended role must clear. These are not
 * nice-to-haves: an agent that cannot read its briefing, append its worklog,
 * bind its identity, arm its monitor, edit its workspace, or run the status
 * commands its briefing prescribes cannot carry out the job it was spawned for
 * — and, being unattended, will report no error while failing to.
 */
export const UNATTENDED_FLOOR: readonly UnattendedCapability[] = [
  'read-state', 'write-state', 'messaging', 'monitor', 'workspace-edit', 'status-commands',
];

/** Fleet-owned wake delivery removes the native Monitor-tool requirement. */
export function requiredUnattendedFloor(role: ResolvedRole): readonly UnattendedCapability[] {
  return role.monitor?.mode === 'fleet'
    ? UNATTENDED_FLOOR.filter(capability => capability !== 'monitor')
    : UNATTENDED_FLOOR;
}

export interface FloorResult {
  meets: boolean;
  missing: UnattendedCapability[];
}

/** Which floor capabilities a set of granted capabilities fails to cover. */
export function checkUnattendedFloor(
  granted: readonly UnattendedCapability[],
  required: readonly UnattendedCapability[] = UNATTENDED_FLOOR,
): FloorResult {
  const missing = required.filter(c => !granted.includes(c));
  return { meets: missing.length === 0, missing };
}

/**
 * One role's neutral permissions, resolved through its harness adapter.
 *
 * Both `ours-fleet config` and `ours-fleet doctor` render this same object, so
 * the two commands cannot disagree about what a configuration actually means.
 * Before this existed, `translatePermissions()` was implemented by every
 * adapter and called by nobody: the warnings it produced — including "this
 * combination is not represented exactly" — were unreachable.
 */
export interface RolePermissionAnalysis {
  role: string;
  harness: string;
  permissions: CommonPermissions;
  /** Whether the harness can express neutral permissions at all. */
  supported: boolean;
  /** The harness's own settings, when it can. */
  native?: Record<string, unknown>;
  /** Whether those settings represent the neutral intent exactly. */
  exact?: boolean;
  /** What the native settings actually permit an unattended agent to do. */
  capabilities?: UnattendedCapability[];
  /** Whether those capabilities clear the unattended floor. */
  floor?: FloorResult;
  /**
   * How hard a floor shortfall is. A role that auto-denies (`unattended: deny`)
   * silently does less than asked, so that is a failure; one that waits can at
   * least be rescued by a human attaching a console, so that is a warning.
   */
  floorSeverity?: 'fail' | 'warn';
  /** Native settings that contradict the neutral block; empty when they agree. */
  conflicts?: PermissionConflict[];
  /** A role-named line when the floor is not met; absent when it is. */
  floorWarning?: string;
  /** Role-named translation warnings, ready to print verbatim by any command. */
  warnings: string[];
}

export interface PermissionConflict {
  /** The native setting both sources speak to, e.g. `permission_mode`. */
  key: string;
  /** What the neutral `permissions:` block translates to. */
  fromNeutral: string;
  /** What `harness_options` states directly. */
  fromNative: string;
  /** The role-named line commands print. */
  warning: string;
}

/**
 * Find native settings that contradict the neutral block. Only fires when the
 * operator wrote BOTH — a role that states its intent once, neutrally or
 * natively, has nothing to contradict and stays quiet. `harness_options` wins
 * at launch, which is precisely why a silent disagreement is dangerous: the
 * neutral block reads like the source of truth and is not.
 */
function findConflicts(
  role: ResolvedRole,
  fromNeutral: Record<string, unknown>,
  fromNative: Record<string, unknown>,
): PermissionConflict[] {
  if (!role.permissionsDeclared) return [];
  const conflicts: PermissionConflict[] = [];
  for (const [key, nativeValue] of Object.entries(fromNative)) {
    const neutralValue = fromNeutral[key];
    if (neutralValue === undefined || String(neutralValue) === String(nativeValue)) continue;
    conflicts.push({
      key,
      fromNeutral: String(neutralValue),
      fromNative: String(nativeValue),
      warning: `role '${role.name}': harness_options.${key}=${String(nativeValue)} contradicts the `
        + `permissions block, which translates to ${key}=${String(neutralValue)} — `
        + `harness_options.${key}=${String(nativeValue)} wins`,
    });
  }
  return conflicts;
}

/** Resolve one role's permissions through its adapter. Never throws. */
export function analyzeRolePermissions(role: ResolvedRole): RolePermissionAnalysis {
  const base = { role: role.name, harness: role.harness, permissions: role.permissions };
  let adapter;
  try { adapter = getAdapter(role.harness); }
  catch (e) {
    return { ...base, supported: false, warnings: [`role '${role.name}': ${(e as Error).message}`] };
  }

  const neutral = adapter.translatePermissions(role.permissions);
  let translation = adapter.effectivePermissions?.(role) ?? neutral;
  if (!translation.supported) {
    return {
      ...base, supported: false,
      warnings: [`role '${role.name}': harness '${role.harness}' cannot express neutral ` +
        `permissions — ${translation.reason}`],
    };
  }
  const inspection = inspectClaudeDontAskSettings(role);
  if (inspection && translation.supported) {
    translation = { ...translation, capabilities: inspection.capabilities };
  }
  const conflicts = neutral.supported
    ? findConflicts(role, neutral.native, adapter.nativePermissionOverrides(role.harness_options))
    : [];
  const floor = checkUnattendedFloor(translation.capabilities, requiredUnattendedFloor(role));
  const floorSeverity = role.permissions.unattended === 'deny' ? 'fail' as const : 'warn' as const;
  return {
    ...base,
    supported: true,
    native: translation.native,
    exact: translation.exact,
    capabilities: translation.capabilities,
    floor,
    floorSeverity,
    conflicts,
    floorWarning: floor.meets ? undefined : (
      `role '${role.name}': resolved ${role.harness} permissions do not meet the unattended ` +
      `capability floor — missing ${floor.missing.join(', ')} ` +
      `(${formatNative(translation.native)}; unattended=${role.permissions.unattended} means these ` +
      `requests will ${role.permissions.unattended === 'deny' ? 'be denied silently' : 'block the turn'})`),
    warnings: [
      ...translation.warnings.map(w => `role '${role.name}': ${w}`),
      ...(inspection?.warning ? [`role '${role.name}': ${inspection.warning}`] : []),
    ],
  };
}

function inspectClaudeDontAskSettings(role: ResolvedRole): {
  capabilities: UnattendedCapability[];
  warning?: string;
} | undefined {
  if (role.harness !== 'claude-code'
      || (role.harness_options as { permission_mode?: string } | undefined)?.permission_mode !== 'dontAsk')
    return undefined;
  const sources = [
    join(home(), '.claude', 'settings.json'),
    ...(role.cwd ? [
      join(role.cwd, '.claude', 'settings.json'),
      join(role.cwd, '.claude', 'settings.local.json'),
    ] : []),
  ];
  const allow: string[] = [];
  const deny: string[] = [];
  const used: string[] = [];
  for (const source of sources) {
    if (!existsSync(source)) continue;
    try {
      const parsed = JSON.parse(readFileSync(source, 'utf8')) as {
        permissions?: { allow?: unknown; deny?: unknown };
      };
      if (Array.isArray(parsed.permissions?.allow))
        allow.push(...parsed.permissions!.allow.filter((v): v is string => typeof v === 'string'));
      if (Array.isArray(parsed.permissions?.deny))
        deny.push(...parsed.permissions!.deny.filter((v): v is string => typeof v === 'string'));
      used.push(source);
    } catch (e) {
      return {
        capabilities: ['read-state'],
        warning: `cannot prove Claude dontAsk allow-list because ${source} is unreadable or invalid: `
          + `${(e as Error).message}`,
      };
    }
  }
  const permitted = (patterns: RegExp[]): boolean =>
    patterns.some(pattern => allow.some(rule => pattern.test(rule)))
    && !patterns.some(pattern => deny.some(rule => pattern.test(rule)));
  const capabilities: UnattendedCapability[] = [];
  if (permitted([/^Read(?:\(|$)/i])) capabilities.push('read-state');
  if (permitted([/^Write(?:\(|$)/i, /^Edit(?:\(|$)/i])) capabilities.push('write-state');
  if (permitted([/^mcp__(?:ours|plugin_ours)__|^ours[:_]/i])) capabilities.push('messaging');
  if (role.monitor?.mode === 'fleet' || permitted([/^Monitor(?:\(|$)/i])) capabilities.push('monitor');
  if (permitted([/^Write(?:\(|$)/i, /^Edit(?:\(|$)/i, /^Bash(?:\(|$)/i]))
    capabilities.push('workspace-edit');
  if (permitted([/^Bash(?:\(|$)/i])) capabilities.push('status-commands');
  return {
    capabilities,
    warning: used.length
      ? `Claude dontAsk allow-list inspected from ${used.join(' + ')}`
      : 'cannot prove Claude dontAsk allow-list: no readable settings source',
  };
}

/** Every line a command should show for a role: translation, conflicts, floor. */
export function allWarnings(a: RolePermissionAnalysis): string[] {
  return [
    ...a.warnings,
    ...(a.conflicts ?? []).map(c => c.warning),
    ...(a.floorWarning ? [a.floorWarning] : []),
  ];
}

/** Resolve every role's permissions, in config order. */
export function analyzeFleetPermissions(roles: ResolvedRole[]): RolePermissionAnalysis[] {
  return roles.map(analyzeRolePermissions);
}

/** Render an analysis's native settings compactly, for one-line reporting. */
export function formatNative(native: Record<string, unknown> | undefined): string {
  if (!native || !Object.keys(native).length) return '(none)';
  return Object.entries(native).map(([k, v]) => `${k}=${String(v)}`).join(' ');
}
