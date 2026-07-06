import {
  BACKENDS, ON_UNAVAILABLE, NETWORK_MODES,
  type IsolationConfig,
} from './types.js';

const ISOLATION_KEYS = ['backend', 'on_unavailable', 'fs', 'network', 'allow_hosts', 'resources', 'secrets'];
const FS_KEYS = ['read', 'write'];
const RESOURCE_KEYS = ['cpu', 'mem', 'pids'];

const unknownKeys = (obj: Record<string, unknown>, allowed: string[]): string[] =>
  Object.keys(obj).filter(k => !allowed.includes(k));

const enumProblem = (label: string, value: unknown, allowed: readonly string[]): string | null =>
  value === undefined || allowed.includes(value as string)
    ? null
    : `${label}: invalid value '${value}'; allowed: ${allowed.join(', ')}`;

/**
 * Validate a raw `isolation:` block. Returns a list of human-readable problems
 * (empty ⇒ valid). Pure; callable from config.ts like adapter.validateOptions.
 */
export function validateIsolationConfig(raw: unknown): string[] {
  const problems: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return ['isolation: must be a mapping'];
  const iso = raw as Record<string, unknown>;

  const bad = unknownKeys(iso, ISOLATION_KEYS);
  if (bad.length)
    problems.push(`isolation: unknown key(s) ${bad.join(', ')}; allowed: ${ISOLATION_KEYS.join(', ')}`);

  for (const p of [
    enumProblem('isolation.backend', iso.backend, BACKENDS),
    enumProblem('isolation.on_unavailable', iso.on_unavailable, ON_UNAVAILABLE),
    enumProblem('isolation.network', iso.network, NETWORK_MODES),
  ]) if (p) problems.push(p);

  if (iso.fs !== undefined) {
    if (typeof iso.fs !== 'object' || iso.fs === null || Array.isArray(iso.fs))
      problems.push('isolation.fs: must be a mapping');
    else {
      const fsBad = unknownKeys(iso.fs as Record<string, unknown>, FS_KEYS);
      if (fsBad.length)
        problems.push(`isolation.fs: unknown key(s) ${fsBad.join(', ')}; allowed: ${FS_KEYS.join(', ')}`);
    }
  }

  if (iso.resources !== undefined) {
    if (typeof iso.resources !== 'object' || iso.resources === null || Array.isArray(iso.resources))
      problems.push('isolation.resources: must be a mapping');
    else {
      const rBad = unknownKeys(iso.resources as Record<string, unknown>, RESOURCE_KEYS);
      if (rBad.length)
        problems.push(`isolation.resources: unknown key(s) ${rBad.join(', ')}; allowed: ${RESOURCE_KEYS.join(', ')}`);
    }
  }

  return problems;
}

export type { IsolationConfig };
