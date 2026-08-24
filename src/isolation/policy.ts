import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  BACKENDS, ON_UNAVAILABLE, NETWORK_MODES,
  type IsolationConfig, type Mount, type ResolvedIsolation, type WrapContext,
} from './types.js';

/** A mount that the forbidden-path policy refuses. Raised before any launch. */
export class IsolationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationPolicyError';
  }
}

/**
 * Resolve a path to its canonical form, following symlinks as far as the
 * filesystem allows and normalising the rest. Without this, `~/link-to-ssh`
 * and `/home/u/.ssh` are different strings for the same directory, and a
 * string comparison against the forbidden list is trivially side-stepped.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  let head = abs;
  let tail = '';
  for (;;) {
    try { return tail ? join(realpathSync.native(head), tail) : realpathSync.native(head); }
    catch {
      const parent = dirname(head);
      if (parent === head) return abs;          // nothing on this path exists yet
      tail = tail ? join(basename(head), tail) : basename(head);
      head = parent;
    }
  }
}

const within = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent + sep);

/**
 * How a canonical mount path collides with a canonical forbidden path.
 *
 * `parent` matters as much as the other two: binding `$HOME` does not name
 * `~/.ssh`, but it exposes it just as completely.
 */
export function mountConflict(
  mount: string, forbidden: string,
): 'exact' | 'descendant' | 'parent' | null {
  if (mount === forbidden) return 'exact';
  if (within(mount, forbidden)) return 'descendant';
  if (within(forbidden, mount)) return 'parent';
  return null;
}

const CONFLICT_WORDING = {
  exact: 'is',
  descendant: 'is inside',
  parent: 'would expose',
} as const;

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

/**
 * Where a role's per-role harness runtime state lives. Under the agent's
 * own state directory, so it is covered by the state dir's existing lifecycle
 * and by the forbidden-path exception, and is never shared with a peer.
 */
export const harnessRuntimeDir = (stateDir: string, harnessId: string): string =>
  join(stateDir, 'harness', harnessId);

/** Parse a `host:container` secret pair; a bare path maps to itself. */
function parseSecret(pair: string): Mount {
  const i = pair.indexOf(':');
  const src = i === -1 ? pair : pair.slice(0, i);
  const dst = i === -1 ? pair : pair.slice(i + 1);
  return { src, dst, mode: 'ro' };
}

/**
 * Resolve a raw (already validated) isolation block against runtime context into
 * a defaults-filled, backend-agnostic policy, and REFUSE any mount that would
 * breach the forbidden-path list.
 *
 * The mount model is an allowlist: only the durable set (state dir, cwd, harness
 * config, declared fs/secrets) plus read-only system dirs are exposed. The
 * forbidden list — the ours key store, sibling agent state dirs, ~/.ssh, ~/.aws
 * — is now enforced on top of that, so a role cannot ask its way back in.
 *
 * Not pure: canonicalising a path reads the filesystem, because symlink aliases
 * are one of the ways a forbidden path gets requested. Throws
 * `IsolationPolicyError`; callers surface it against the role.
 */
export function resolveIsolation(cfg: IsolationConfig, ctx: WrapContext): ResolvedIsolation {
  const { stateDir, runCwd, home } = ctx;

  const mounts: Mount[] = [];
  const addRw = (p: string) => { if (!mounts.some(m => m.src === p)) mounts.push({ src: p, dst: p, mode: 'rw' }); };
  const addRo = (p: string) => { if (!mounts.some(m => m.src === p)) mounts.push({ src: p, dst: p, mode: 'ro' }); };
  /** Writable bind whose destination differs from its source (the per-role home). */
  const addRw2 = (src: string, dst: string) => {
    if (!mounts.some(m => m.src === src && m.dst === dst)) mounts.push({ src, dst, mode: 'rw' });
  };

  // Durable set: state dir + cwd, then only the active harness's config/auth roots.
  addRw(stateDir);
  addRw(runCwd);
  if (ctx.harnessHome && ctx.harnessRuntimeDir) {
    // The harness home is backed by a PER-ROLE directory: the agent gets a
    // writable home for its sessions, caches and history, and anything a future
    // CLI version writes lands there too. The shared credentials, global
    // instructions and configuration are then layered back read-only, so they
    // are readable and cannot be rewritten — for this role or for its peers.
    // Order matters: the writable home must precede the read-only overlays.
    addRw2(ctx.harnessRuntimeDir, ctx.harnessHome);
    for (const p of ctx.harnessSharedPaths ?? []) addRo(p);
  } else if (ctx.harness === 'codex') {
    addRw(join(home, '.codex'));
    addRo(join(home, '.agents'));
  } else {
    // Preserve the historical default for callers that predate harness-aware contexts.
    addRw(join(home, '.claude'));
    addRw(join(home, '.claude.json'));
  }
  for (const dir of ctx.additionalWriteDirs ?? []) addRw(dir);

  // The selected harness/session command may live outside the system allowlist
  // (for example Node and a bundled ACP adapter under ~/.local). The runner
  // resolves its exact executable/package closure; keep every such bind RO.
  for (const path of ctx.runtimeReadPaths ?? []) addRo(path);

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

  // ENFORCE the list, before anything builds a backend argv. Until now it was
  // observational: the allowlist model kept these paths out by default, but a
  // role that asked for one in `fs.write`, `secrets`, or a Codex `add_dirs` got
  // it mounted anyway, and the "blocklist" recorded a guarantee it never made.
  //
  // The role's OWN state dir is the one legitimate descendant of the agents
  // root, so it is excepted by exact canonical identity — which does not
  // exempt its parent, and does not exempt a sibling.
  const forbidden = blocklist.map(canonicalPath);
  const ownStateDir = canonicalPath(stateDir);
  for (const m of mounts) {
    for (const [role, path] of [['source', m.src], ['destination', m.dst]] as const) {
      const canon = canonicalPath(path);
      // The role's own state dir and anything inside it (its per-role harness
      // runtime home, 5.1) is the one legitimate descendant of the agents root.
      // This does not exempt the root above it, nor a sibling beside it.
      if (within(canon, ownStateDir)) continue;
      for (let i = 0; i < forbidden.length; i++) {
        const kind = mountConflict(canon, forbidden[i]);
        if (!kind) continue;
        const alias = canon === resolve(path) ? '' : ` (resolves to '${canon}')`;
        throw new IsolationPolicyError(
          `isolation: refusing to mount ${role} '${path}'${alias} — it ` +
          `${CONFLICT_WORDING[kind]} the forbidden path '${blocklist[i]}'`);
      }
    }
  }

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
