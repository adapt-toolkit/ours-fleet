import type { CommonPermissions, ResolvedRole } from './config.js';
import { getAdapter } from './harness/registry.js';

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
  /** Role-named lines, ready to print verbatim by any command. */
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
  return {
    ...base,
    supported: true,
    native: translation.native,
    exact: translation.exact,
    warnings: translation.warnings.map(w => `role '${role.name}': ${w}`),
  };
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
