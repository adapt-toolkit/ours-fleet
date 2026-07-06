import { join, dirname } from 'node:path';
import {
  BACKENDS, ON_UNAVAILABLE, NETWORK_MODES,
  type IsolationConfig, type Mount, type ResolvedIsolation, type WrapContext,
} from './types.js';

/** Read-only system dirs exposed under the allowlist model. */
const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
/** Ephemeral scratch mounts. */
const scratchTmpfs = (home: string) => ['/tmp', join(home, '.cache')];
/** Home-relative sensitive paths never exposed (the blocklist's teeth). */
const SENSITIVE_HOME = ['.ssh', '.aws', '.docker', '.gnupg', '.ours', 'fleet.yaml', 'fleet.d'];

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

/** Parse a `host:container` secret pair; a bare path maps to itself. */
function parseSecret(pair: string): Mount {
  const i = pair.indexOf(':');
  const src = i === -1 ? pair : pair.slice(0, i);
  const dst = i === -1 ? pair : pair.slice(i + 1);
  return { src, dst, mode: 'ro' };
}

/**
 * Resolve a raw (already validated) isolation block against runtime context into
 * a defaults-filled, backend-agnostic policy. Pure — no I/O, no probing.
 *
 * The mount model is an allowlist: only the durable set (state dir, cwd, Claude
 * config, declared fs/secrets) plus read-only system dirs are exposed; everything
 * else on the host — the ours key store, sibling agent state dirs, ~/.ssh, ~/.aws —
 * is simply never mounted, and thus absent inside the sandbox (§5.2).
 */
export function resolveIsolation(cfg: IsolationConfig, ctx: WrapContext): ResolvedIsolation {
  const { stateDir, runCwd, home } = ctx;

  const mounts: Mount[] = [];
  const addRw = (p: string) => { if (!mounts.some(m => m.src === p)) mounts.push({ src: p, dst: p, mode: 'rw' }); };
  const addRo = (p: string) => { if (!mounts.some(m => m.src === p)) mounts.push({ src: p, dst: p, mode: 'ro' }); };

  // Durable set (always present, rw): state dir, cwd, Claude config.
  addRw(stateDir);
  addRw(runCwd);
  addRw(join(home, '.claude'));
  addRw(join(home, '.claude.json'));

  // Declared fs extras.
  for (const p of cfg.fs?.write ?? []) addRw(p);
  for (const p of cfg.fs?.read ?? []) addRo(p);
  // Declared secrets (ro, host:container).
  for (const pair of cfg.secrets ?? []) {
    const m = parseSecret(pair);
    if (!mounts.some(x => x.src === m.src && x.dst === m.dst)) mounts.push(m);
  }

  const agentsRoot = dirname(stateDir);
  const blocklist = [
    ...SENSITIVE_HOME.map(p => join(home, p)),
    agentsRoot, // sibling agents' state dirs (this agent's own is explicitly mounted)
  ];

  return {
    backend: cfg.backend ?? 'auto',
    onUnavailable: cfg.on_unavailable ?? 'warn',
    network: cfg.network ?? 'broker',
    allowHosts: cfg.allow_hosts ?? [],
    resources: cfg.resources ?? {},
    mounts,
    system: SYSTEM_RO,
    tmpfs: scratchTmpfs(home),
    blocklist,
  };
}

export type { IsolationConfig };
