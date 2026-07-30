import type { CommonPermissions, ResolvedRole } from './config.js';
import { getAdapter } from './harness/registry.js';
import type { UnattendedCapability } from './harness/types.js';

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

export interface FloorResult {
  meets: boolean;
  missing: UnattendedCapability[];
}

/** Which floor capabilities a set of granted capabilities fails to cover. */
export function checkUnattendedFloor(granted: readonly UnattendedCapability[]): FloorResult {
  const missing = UNATTENDED_FLOOR.filter(c => !granted.includes(c));
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
  /** A role-named line when the floor is not met; absent when it is. */
  floorWarning?: string;
  /** Role-named translation warnings, ready to print verbatim by any command. */
  warnings: string[];
}

/** Resolve one role's permissions through its adapter. Never throws. */
export function analyzeRolePermissions(role: ResolvedRole): RolePermissionAnalysis {
  const base = { role: role.name, harness: role.harness, permissions: role.permissions };
  let adapter;
  try { adapter = getAdapter(role.harness); }
  catch (e) {
    return { ...base, supported: false, warnings: [`role '${role.name}': ${(e as Error).message}`] };
  }

  const translation = adapter.translatePermissions(role.permissions);
  if (!translation.supported) {
    return {
      ...base, supported: false,
      warnings: [`role '${role.name}': harness '${role.harness}' cannot express neutral ` +
        `permissions — ${translation.reason}`],
    };
  }
  const floor = checkUnattendedFloor(translation.capabilities);
  const floorSeverity = role.permissions.unattended === 'deny' ? 'fail' as const : 'warn' as const;
  return {
    ...base,
    supported: true,
    native: translation.native,
    exact: translation.exact,
    capabilities: translation.capabilities,
    floor,
    floorSeverity,
    floorWarning: floor.meets ? undefined : (
      `role '${role.name}': resolved ${role.harness} permissions do not meet the unattended ` +
      `capability floor — missing ${floor.missing.join(', ')} ` +
      `(${formatNative(translation.native)}; unattended=${role.permissions.unattended} means these ` +
      `requests will ${role.permissions.unattended === 'deny' ? 'be denied silently' : 'block the turn'})`),
    warnings: translation.warnings.map(w => `role '${role.name}': ${w}`),
  };
}

/** Every line a command should show for a role: translation first, then the floor. */
export function allWarnings(a: RolePermissionAnalysis): string[] {
  return a.floorWarning ? [...a.warnings, a.floorWarning] : a.warnings;
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
