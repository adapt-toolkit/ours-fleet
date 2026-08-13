/**
 * Build and install provenance.
 *
 * Two installs of this package once served the same host with the same semver
 * (0.16.0) and different behaviour: one accepted `monitor.interrupt: after_tool`,
 * the other rejected it. Their `dist/cli.js` were byte-identical, so `--version`
 * could not tell them apart — the divergence lived in other modules, built from a
 * commit after the feature landed but before the release commit bumped the
 * version. Nothing in either artifact recorded which source tree it came from.
 *
 * This module gives every build a content-derived identity, exposes the
 * capabilities it declares, and can enumerate the other installs reachable on
 * this host so the mismatch is reported instead of guessed at.
 */
import { createHash } from 'node:crypto';
import {
  accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { delimiter, dirname, join, parse, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from './capabilities.js';
import { VERSION } from './version.js';

export const PACKAGE_NAME = '@ours.network/fleet';
export const BIN_NAME = 'ours-fleet';
/** Stand-in build id for artifacts built before this module existed. */
export const UNKNOWN_BUILD = 'unknown';

/** Identity of one built artifact, written into dist/ at build time. */
export interface BuildInfo {
  version: string;
  /** First 12 hex of a sha256 over every other file in dist/. */
  buildId: string;
  /** Commit the build was cut from, when git was available. */
  commit?: string;
  /** Whether that working tree had uncommitted changes. */
  dirty?: boolean;
  builtAt?: string;
  capabilities: string[];
}

/** One @ours.network/fleet package directory on this host. */
export interface Install {
  packageRoot: string;
  version: string;
  /** Absent for a pre-provenance build — its identity is unknowable. */
  build?: BuildInfo;
}

export interface InstallRecord extends Install {
  /** The PATH candidate that reaches this install, if any. */
  bin?: string;
  realBin?: string;
  /** Position of `bin`'s directory in PATH; absent when off PATH. */
  pathIndex?: number;
  /** Whether this is the install executing right now. */
  running: boolean;
}

export type SkewKind = 'version-build-conflict' | 'shadowed-runtime' | 'unknown-build-identity';

export interface InstallSkew {
  kind: SkewKind;
  severity: 'error' | 'warn';
  message: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
}

function parseBuildInfo(value: Record<string, unknown> | undefined): BuildInfo | undefined {
  if (typeof value?.version !== 'string' || typeof value.buildId !== 'string') return undefined;
  return {
    version: value.version,
    buildId: value.buildId,
    commit: typeof value.commit === 'string' ? value.commit : undefined,
    dirty: typeof value.dirty === 'boolean' ? value.dirty : undefined,
    builtAt: typeof value.builtAt === 'string' ? value.builtAt : undefined,
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

/** Read the install rooted at `packageRoot`, or undefined if that is not one. */
export function readInstall(packageRoot: string): Install | undefined {
  const pkg = readJson(join(packageRoot, 'package.json'));
  if (pkg?.name !== PACKAGE_NAME || typeof pkg.version !== 'string') return undefined;
  return {
    packageRoot,
    version: pkg.version,
    build: parseBuildInfo(readJson(join(packageRoot, 'dist', 'build-info.json'))),
  };
}

/** Walk up from `from` to the @ours.network/fleet package directory containing it. */
export function findPackageRoot(from: string): string | undefined {
  let dir = from;
  const { root } = parse(dir);
  for (;;) {
    if (readInstall(dir)) return dir;
    if (dir === root) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const realPathOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * Would a shell run this PATH candidate? A directory that happens to carry the
 * command's name is not the command, and neither is a regular file without its
 * execute bit — a half-finished install. Counting either lets something the
 * operator can never actually invoke shadow the real one in every verdict.
 *
 * Windows has no execute bit (PATHEXT decides), but this CLI supervises through
 * systemd/launchd and does not run there, so the mode check is POSIX-only.
 */
function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * Every install reachable from PATH, plus the one executing right now.
 * PATH order is preserved; an install reached by several PATH entries is listed
 * once, at its earliest position.
 */
export function discoverInstalls(opts: {
  path?: string;
  argv1?: string;
  binName?: string;
  platform?: NodeJS.Platform;
} = {}): InstallRecord[] {
  const binName = opts.binName ?? BIN_NAME;
  const platform = opts.platform ?? process.platform;
  const entries = (opts.path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const records: InstallRecord[] = [];
  const byRoot = new Map<string, InstallRecord>();

  entries.forEach((entry, pathIndex) => {
    const bin = join(entry, binName);
    const realBin = realPathOr(bin);
    if (!isExecutableFile(realBin, platform)) return;
    const packageRoot = findPackageRoot(dirname(realBin));
    if (!packageRoot || byRoot.has(packageRoot)) return;
    const install = readInstall(packageRoot);
    if (!install) return;
    const record: InstallRecord = { ...install, bin, realBin, pathIndex, running: false };
    byRoot.set(packageRoot, record);
    records.push(record);
  });

  const argv1 = 'argv1' in opts ? opts.argv1 : process.argv[1];
  const runningRoot = argv1 ? findPackageRoot(dirname(realPathOr(argv1))) : undefined;
  if (runningRoot) {
    const known = byRoot.get(runningRoot);
    if (known) known.running = true;
    else {
      const install = readInstall(runningRoot);
      if (install) records.push({ ...install, realBin: realPathOr(argv1!), running: true });
    }
  }
  return records;
}

/**
 * sha256 over an install's dist/ tree, first 12 hex — the same bytes and order
 * `scripts/build-info.mjs` hashes, so a stamped install's digest equals its
 * buildId. This is what tells two PRE-provenance installs apart: they both
 * report `unknown`, but they are not the same artifact, and the host that
 * motivated this module had exactly that pair.
 */
export function contentDigest(packageRoot: string): string | undefined {
  const dist = join(packageRoot, 'dist');
  if (!existsSync(dist)) return undefined;
  const stamp = join(dist, 'build-info.json');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p !== stamp) files.push(relative(dist, p).split(sep).join('/'));
    }
  };
  try { walk(dist); } catch { return undefined; }
  const hash = createHash('sha256');
  for (const rel of files.sort()) {
    const bytes = readFileSync(join(dist, rel));
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 12);
}

/** `0.17.0+9f1c2a3b4d5e`, or `…+unknown` for a pre-provenance build. */
export const buildLabel = (install: Pick<Install, 'version' | 'build'>): string =>
  `${install.version}+${install.build?.buildId ?? UNKNOWN_BUILD}`;

/** What an install says it can do — never guessed from its version. */
export const capabilitySummary = (install: Install): string =>
  !install.build ? 'capabilities unknown'
    : install.build.capabilities.length
      ? `capabilities: ${install.build.capabilities.join(', ')}`
      : 'no declared capabilities';

const describe = (r: InstallRecord, identity?: string): string =>
  `${r.packageRoot} (${buildLabel(r)}`
  + (identity && identity !== r.build?.buildId ? `, content ${identity}` : '')
  + `${r.running ? ', running' : ''}; ${capabilitySummary(r)})`;

/**
 * What an install effectively IS: its stamped build id, or — for an artifact
 * built before stamps existed — a hash of what it is made of. `unknown` only
 * when neither can be established.
 */
const identityOf = (
  install: Install, digest: (packageRoot: string) => string | undefined,
): string => install.build?.buildId ?? digest(install.packageRoot) ?? UNKNOWN_BUILD;

/**
 * Conflicts an operator must know about. `version-build-conflict` is the one
 * that bit this host: same semver, different artifact, silently different rules.
 *
 * `digest` is only consulted inside a version group of two or more, so the
 * common single-install case never hashes anything.
 */
export function analyzeInstalls(
  records: InstallRecord[],
  digest: (packageRoot: string) => string | undefined = contentDigest,
): InstallSkew[] {
  const skews: InstallSkew[] = [];
  const conflicted = new Set<string>();

  const byVersion = new Map<string, InstallRecord[]>();
  for (const r of records) byVersion.set(r.version, [...(byVersion.get(r.version) ?? []), r]);
  for (const [version, group] of byVersion) {
    if (group.length < 2) continue;
    // A pre-provenance build has no id to compare, so fall back to what it is
    // made of. Two installs are the same artifact or they are not.
    const identity = new Map(group.map(r => [r.packageRoot, identityOf(r, digest)] as const));
    if (new Set(identity.values()).size < 2) continue;
    for (const r of group) conflicted.add(r.packageRoot);
    skews.push({
      kind: 'version-build-conflict',
      severity: 'error',
      message: `${group.length} installs report ours-fleet ${version} but are different builds: `
        + `${group.map(r => describe(r, identity.get(r.packageRoot))).join(' vs ')}`
        + '. They accept different fleet.yaml — compare `ours-fleet version --json` on each '
        + 'and remove or update the stale one.',
    });
  }

  const running = records.find(r => r.running);
  const first = records.filter(r => r.pathIndex !== undefined)
    .sort((a, b) => a.pathIndex! - b.pathIndex!)[0];
  // Two prefixes holding the same artifact are not a skew — whichever answers,
  // the operator gets the same behaviour. Only compare content when the roots
  // differ, so the ordinary single-install case never hashes anything.
  const sameArtifact = running && first && first.packageRoot !== running.packageRoot
    && identityOf(first, digest) === identityOf(running, digest)
    && first.version === running.version;
  if (running && first && first.packageRoot !== running.packageRoot && !sameArtifact)
    skews.push({
      kind: 'shadowed-runtime',
      // Same semver on both sides is the trap: nothing an operator can see
      // distinguishes them. Different semver is merely worth knowing (running a
      // checkout while a global install exists is an ordinary way to work).
      severity: first.version === running.version ? 'error' : 'warn',
      message: `this process runs ${describe(running)} but \`${BIN_NAME}\` on PATH resolves to `
        + `${first.bin} -> ${first.packageRoot} (${buildLabel(first)}). A command you type and this `
        + 'runtime are not the same artifact.',
    });

  for (const r of records) {
    if (r.build || conflicted.has(r.packageRoot)) continue;
    skews.push({
      kind: 'unknown-build-identity',
      severity: 'warn',
      message: `${r.packageRoot} (${r.version}) predates build provenance — it ships no `
        + 'dist/build-info.json, so its source tree and capabilities cannot be verified.',
    });
  }
  return skews;
}

let cached: BuildInfo | undefined;

/** Identity of the build executing right now. */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(moduleDir);
  const candidates = [
    join(moduleDir, 'build-info.json'),
    ...(root ? [join(root, 'dist', 'build-info.json')] : []),
  ];
  for (const file of candidates) {
    const info = parseBuildInfo(readJson(file));
    if (info) return (cached = info);
  }
  // Running from a tree that was never built (or a build that predates this).
  return (cached = { version: VERSION, buildId: UNKNOWN_BUILD, capabilities: [...CAPABILITIES] });
}

/** `ours-fleet 0.17.0+9f1c2a3b4d5e` — one line, safe for any operator output. */
export const runningLabel = (): string => {
  const info = buildInfo();
  return `${BIN_NAME} ${buildLabel({ version: info.version, build: info })}`;
};
