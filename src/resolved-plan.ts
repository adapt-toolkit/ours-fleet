import type { FleetConfig, ResolvedRole } from './config.js';
import { analyzeRolePermissions } from './permissions.js';

export const RESOLVED_PLAN_SCHEMA_VERSION = 1;

const sortedObject = <T>(value: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const redactSensitive = (value: unknown, key = ''): unknown => {
  if (/(?:secret|token|password|authorization|api[_-]?key)/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map(item => redactSensitive(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([childKey, child]) => [childKey, redactSensitive(child, childKey)]));
  return value;
};

/** Stable, secret-safe machine contract consumed by config JSON and spawn dry-run. */
export function resolvedPlan(cfg: FleetConfig): Record<string, unknown> {
  return {
    schemaVersion: RESOLVED_PLAN_SCHEMA_VERSION,
    sourceFiles: [...cfg.files],
    startStaggerMs: cfg.startStaggerMs,
    diagnostics: cfg.diagnostics.map(diagnostic => ({ ...diagnostic })),
    roles: cfg.roles.map(resolvedRolePlan),
    watchdogs: cfg.watchdogs.map(w => sortedObject({
      name: w.name, sourceFile: w.sourceFile, enabled: w.enabled,
      intervalMs: w.intervalMs, coordinator: w.coordinator, watch: [...w.watch],
      harness: w.harness, session: w.session, model: w.model ?? null,
      identity: w.identity, timeoutMs: w.timeoutMs, keepReports: w.keepReports,
      alertCooldownMs: w.alertCooldownMs, promptFile: w.promptFile ?? null,
      isolation: w.isolation ?? null,
    })),
  };
}

export function resolvedRolePlan(role: ResolvedRole): Record<string, unknown> {
  const analysis = analyzeRolePermissions(role);
  return {
    name: role.name,
    sourceFile: role.sourceFile,
    identity: role.identity,
    harness: role.harness,
    session: role.session,
    sessionOptions: role.session_options ?? null,
    model: role.model ?? null,
    modelChain: role.model_chain ?? null,
    cwd: role.cwd ?? null,
    coordinator: role.coordinator ?? null,
    maxTokens: role.max_tokens ?? null,
    autocompactPct: role.autocompact_pct ?? null,
    permissions: {
      common: role.permissions,
      effectiveNative: analysis.native ?? null,
      supported: analysis.supported,
      exact: analysis.exact ?? false,
      capabilities: analysis.capabilities ?? [],
      floor: analysis.floor ?? null,
      severity: analysis.floorSeverity ?? null,
      warnings: [
        ...analysis.warnings,
        ...(analysis.conflicts ?? []).map(conflict => conflict.warning),
        ...(analysis.floorWarning ? [analysis.floorWarning] : []),
      ],
    },
    monitor: role.monitor,
    isolation: role.isolation ?? null,
    worklog: role.worklog ?? null,
    authProxy: role.auth_proxy ?? null,
    oversee: role.oversee ?? [],
    harnessOptions: redactSensitive(role.harness_options ?? null),
    env: {
      redacted: true,
      keys: Object.keys(role.env ?? {}).sort(),
      values: sortedObject(Object.fromEntries(
        Object.keys(role.env ?? {}).map(key => [key, '<redacted>']))),
    },
  };
}
