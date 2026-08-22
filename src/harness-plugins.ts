import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { replaceFileAtomically, withFileLock } from './atomic-file.js';
import { realExec, type Exec, type ExecResult } from './exec.js';
import { stateRoot } from './paths.js';

export const HARNESS_PLUGIN_IDS = ['codex', 'claude-code'] as const;
export type HarnessPluginId = (typeof HARNESS_PLUGIN_IDS)[number];
export type HarnessPluginChannel = 'stable' | 'nightly';

export interface HarnessPluginConfig {
  plugin_channel: HarnessPluginChannel;
}

export type HarnessPluginConfigs = Record<HarnessPluginId, HarnessPluginConfig>;

export interface HarnessPluginLock {
  schemaVersion: 1;
  harness: HarnessPluginId;
  channel: HarnessPluginChannel;
  distTag: 'latest' | 'nightly';
  package: string;
  version: string;
  registry: 'https://registry.npmjs.org';
  resolvedAt: string;
}

export interface HarnessPluginInstallResult {
  lock: HarnessPluginLock;
  lockPath: string;
  marketplacePath: string;
  resolved: boolean;
}

interface HarnessPluginSpec {
  package: string;
  marketplaceName: string;
  marketplaceManifest: string;
  executable: 'codex' | 'claude';
}

const REGISTRY = 'https://registry.npmjs.org' as const;
const SPECS: Record<HarnessPluginId, HarnessPluginSpec> = {
  codex: {
    package: '@ours.network/codex',
    marketplaceName: 'ours-fleet-codex-lock',
    marketplaceManifest: '.agents/plugins/marketplace.json',
    executable: 'codex',
  },
  'claude-code': {
    package: '@ours.network/claude-code',
    marketplaceName: 'ours-fleet-claude-lock',
    marketplaceManifest: '.claude-plugin/marketplace.json',
    executable: 'claude',
  },
};

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function resolveHarnessPluginConfigs(
  raw: unknown,
  file = 'fleet.yaml',
): HarnessPluginConfigs {
  const resolved: HarnessPluginConfigs = {
    codex: { plugin_channel: 'stable' },
    'claude-code': { plugin_channel: 'stable' },
  };
  if (raw === undefined) return resolved;
  if (!isRecord(raw)) throw new Error(`${file}: harnesses must be a map`);
  const unknown = Object.keys(raw).filter(key => !HARNESS_PLUGIN_IDS.includes(key as HarnessPluginId));
  if (unknown.length)
    throw new Error(`${file}: harnesses has unknown harness(es) ${unknown.join(', ')}; allowed: ${HARNESS_PLUGIN_IDS.join(', ')}`);
  for (const harness of HARNESS_PLUGIN_IDS) {
    const value = raw[harness];
    if (value === undefined) continue;
    if (!isRecord(value)) throw new Error(`${file}: harnesses.${harness} must be a map`);
    const bad = Object.keys(value).filter(key => key !== 'plugin_channel');
    if (bad.length)
      throw new Error(`${file}: harnesses.${harness} has unknown key(s) ${bad.join(', ')}; allowed: plugin_channel`);
    const channel = value.plugin_channel;
    if (channel !== 'stable' && channel !== 'nightly')
      throw new Error(`${file}: harnesses.${harness}.plugin_channel must be one of: stable, nightly`);
    resolved[harness] = { plugin_channel: channel };
  }
  return resolved;
}

export const harnessPluginRoot = (harness: HarnessPluginId): string =>
  join(stateRoot(), 'harness-plugins', harness);
export const harnessPluginLockPath = (harness: HarnessPluginId): string =>
  join(harnessPluginRoot(harness), 'plugin-lock.json');
export const harnessPluginMarketplaceRoot = (harness: HarnessPluginId): string =>
  join(harnessPluginRoot(harness), 'marketplace');
export const harnessPluginMarketplacePath = (harness: HarnessPluginId): string =>
  join(harnessPluginMarketplaceRoot(harness), SPECS[harness].marketplaceManifest);

function validateLock(value: unknown, harness: HarnessPluginId, path: string): HarnessPluginLock {
  const spec = SPECS[harness];
  const fail = (detail: string): never => {
    throw new Error(`invalid harness plugin lock ${path}: ${detail}; run \`ours-fleet plugins update ${harness}\``);
  };
  if (!isRecord(value)) return fail('expected a JSON object');
  if (value.schemaVersion !== 1) fail('unsupported schemaVersion');
  if (value.harness !== harness) fail(`harness must be '${harness}'`);
  if (value.channel !== 'stable' && value.channel !== 'nightly') fail('channel must be stable or nightly');
  const expectedTag = value.channel === 'stable' ? 'latest' : 'nightly';
  if (value.distTag !== expectedTag) fail(`distTag must be '${expectedTag}' for channel '${value.channel}'`);
  if (value.package !== spec.package) fail(`package must be '${spec.package}'`);
  if (typeof value.version !== 'string' || !EXACT_SEMVER.test(value.version))
    return fail('version must be an exact semver');
  const version = value.version;
  if (value.channel === 'stable' && version.includes('-'))
    fail('stable channel resolved to a prerelease');
  if (value.channel === 'nightly' && !version.includes('-nightly.'))
    fail('nightly channel did not resolve to a -nightly.N prerelease');
  if (value.registry !== REGISTRY) fail(`registry must be '${REGISTRY}'`);
  if (typeof value.resolvedAt !== 'string' || !Number.isFinite(Date.parse(value.resolvedAt)))
    fail('resolvedAt must be an ISO timestamp');
  return value as unknown as HarnessPluginLock;
}

export function readHarnessPluginLock(harness: HarnessPluginId): HarnessPluginLock | undefined {
  const path = harnessPluginLockPath(harness);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    throw new Error(`invalid harness plugin lock ${path}: ${(error as Error).message}; `
      + `run \`ours-fleet plugins update ${harness}\``);
  }
  return validateLock(parsed, harness, path);
}

function marketplaceDocument(lock: HarnessPluginLock): Record<string, unknown> {
  const spec = SPECS[lock.harness];
  const source = lock.harness === 'codex'
    ? { source: 'npm', package: lock.package, version: lock.version, registry: lock.registry }
    : { source: 'npm', package: lock.package, version: lock.version };
  if (lock.harness === 'codex') {
    return {
      name: spec.marketplaceName,
      interface: { displayName: `ours.network (${lock.channel}, locked ${lock.version})` },
      plugins: [{
        name: 'ours', source,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    };
  }
  return {
    $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
    name: spec.marketplaceName,
    owner: { name: 'Adapt Framework Solutions Ltd', url: 'https://ours.network' },
    description: `Generated by ours-fleet; @ours.network/claude-code is locked to ${lock.version}.`,
    plugins: [{
      name: 'ours', source,
      description: 'Secure ours.network messaging for Claude Code.',
    }],
  };
}

function writeMarketplace(lock: HarnessPluginLock): string {
  const path = harnessPluginMarketplacePath(lock.harness);
  replaceFileAtomically(path, `${JSON.stringify(marketplaceDocument(lock), null, 2)}\n`, 0o644);
  return path;
}

/**
 * Re-materialize the generated marketplace from the persisted exact lock.
 * This is the ONLY ordinary startup/reconciliation path: it performs no exec,
 * no network call, and cannot observe a moving npm dist-tag.
 */
export function restoreLockedHarnessMarketplace(
  harness: HarnessPluginId,
  expectedChannel?: HarnessPluginChannel,
): HarnessPluginLock | undefined {
  const lock = readHarnessPluginLock(harness);
  if (!lock) {
    if (expectedChannel === 'nightly')
      throw new Error(`harness '${harness}' requests nightly but has no exact lock; `
        + `run \`ours-fleet plugins install ${harness}\``);
    return undefined;
  }
  if (expectedChannel && lock.channel !== expectedChannel)
    throw new Error(`harness '${harness}' requests ${expectedChannel} but its exact lock is ${lock.channel} `
      + `(${lock.version}); run \`ours-fleet plugins update ${harness}\``);
  if (lock) writeMarketplace(lock);
  return lock;
}

async function checked(exec: Exec, command: string, args: string[], action: string): Promise<ExecResult> {
  const result = await exec(command, args);
  if (result.code !== 0)
    throw new Error(`${action} failed (${command} ${args.join(' ')}): ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  return result;
}

function parseJson(output: string, action: string): unknown {
  try { return JSON.parse(output); }
  catch (error) { throw new Error(`${action} returned invalid JSON: ${(error as Error).message}`); }
}

async function resolveExactVersion(
  harness: HarnessPluginId,
  channel: HarnessPluginChannel,
  exec: Exec,
  now: () => Date,
): Promise<HarnessPluginLock> {
  const spec = SPECS[harness];
  const distTag = channel === 'stable' ? 'latest' : 'nightly';
  const result = await checked(
    exec, 'npm', ['view', `${spec.package}@${distTag}`, 'version', '--json'],
    `resolve ${spec.package} ${distTag}`,
  );
  const version = parseJson(result.stdout, `npm view ${spec.package}@${distTag}`);
  if (typeof version !== 'string' || !EXACT_SEMVER.test(version))
    throw new Error(`npm view ${spec.package}@${distTag} did not return one exact semver`);
  if (channel === 'stable' && version.includes('-'))
    throw new Error(`refusing stable ${spec.package}: npm latest resolved to prerelease ${version}`);
  if (channel === 'nightly' && !version.includes('-nightly.'))
    throw new Error(`refusing nightly ${spec.package}: npm nightly resolved to ${version}`);
  return {
    schemaVersion: 1,
    harness,
    channel,
    distTag,
    package: spec.package,
    version,
    registry: REGISTRY,
    resolvedAt: now().toISOString(),
  };
}

function marketplaceEntries(harness: HarnessPluginId, output: string): Array<Record<string, unknown>> {
  const parsed = parseJson(output, `${SPECS[harness].executable} plugin marketplace list`);
  if (harness === 'codex') {
    if (!isRecord(parsed) || !Array.isArray(parsed.marketplaces))
      throw new Error('codex plugin marketplace list returned an unexpected shape');
    return parsed.marketplaces.filter(isRecord);
  }
  if (!Array.isArray(parsed))
    throw new Error('claude plugin marketplace list returned an unexpected shape');
  return parsed.filter(isRecord);
}

async function ensureMarketplaceRegistered(harness: HarnessPluginId, exec: Exec): Promise<void> {
  const spec = SPECS[harness];
  const root = harnessPluginMarketplaceRoot(harness);
  const result = await checked(
    exec, spec.executable, ['plugin', 'marketplace', 'list', '--json'],
    `list ${harness} marketplaces`,
  );
  const existing = marketplaceEntries(harness, result.stdout)
    .find(entry => entry.name === spec.marketplaceName);
  if (existing) {
    if (harness === 'codex') {
      const declared = isRecord(existing.marketplaceSource)
        ? existing.marketplaceSource.source : existing.root;
      if (typeof declared !== 'string' || resolve(declared) !== resolve(root))
        throw new Error(`marketplace '${spec.marketplaceName}' already exists but does not point to ${root}; `
          + 'refusing to replace an unrelated marketplace');
    } else {
      // Claude copies marketplace contents into its cache, but retains the
      // source kind in list output. Refresh that copy after each lock update.
      if (existing.source !== 'directory')
        throw new Error(`marketplace '${spec.marketplaceName}' already exists but is not a local directory; `
          + 'refusing to replace an unrelated marketplace');
      await checked(exec, 'claude', ['plugin', 'marketplace', 'update', spec.marketplaceName],
        `refresh ${harness} locked marketplace`);
    }
    return;
  }
  const args = harness === 'codex'
    ? ['plugin', 'marketplace', 'add', root, '--json']
    : ['plugin', 'marketplace', 'add', root, '--scope', 'user'];
  await checked(exec, spec.executable, args, `register ${harness} locked marketplace`);
}

async function removeLegacyPluginSelections(harness: HarnessPluginId, exec: Exec): Promise<void> {
  const spec = SPECS[harness];
  const result = await checked(
    exec, spec.executable, ['plugin', 'list', '--json'], `list ${harness} plugins`,
  );
  const parsed = parseJson(result.stdout, `${spec.executable} plugin list`);
  if (harness === 'codex' && (!isRecord(parsed) || !Array.isArray(parsed.installed)))
    throw new Error('codex plugin list returned an unexpected shape');
  if (harness === 'claude-code' && !Array.isArray(parsed))
    throw new Error('claude plugin list returned an unexpected shape');
  const entries = (harness === 'codex'
    ? (parsed as Record<string, unknown>).installed as unknown[]
    : parsed as unknown[]).filter(isRecord);
  const ids = new Set(entries
    .map(entry => harness === 'codex' ? entry.pluginId : entry.id)
    .filter((id): id is string => typeof id === 'string'));
  const legacy = harness === 'codex'
    ? ['ours@ours-codex-marketplace', 'ours-fleet@ours-codex-marketplace']
    : ['ours@ours', 'ours@ours.network'];
  for (const selector of legacy.filter(id => ids.has(id))) {
    const args = harness === 'codex'
      ? ['plugin', 'remove', selector, '--json']
      : ['plugin', 'uninstall', selector, '--scope', 'user', '--keep-data'];
    await checked(exec, spec.executable, args, `remove legacy moving selection ${selector}`);
  }
}

async function installFromLock(lock: HarnessPluginLock, exec: Exec): Promise<void> {
  const spec = SPECS[lock.harness];
  // The Codex package also owns the ours-codex launcher. Pin that executable to
  // the same exact artifact as the local marketplace; never invoke its broad
  // installer, which may select daemon/SDK packages outside this feature.
  if (lock.harness === 'codex') {
    await checked(
      exec, 'npm', ['install', '--global', `${lock.package}@${lock.version}`],
      `install ${lock.package}@${lock.version}`,
    );
  }
  await ensureMarketplaceRegistered(lock.harness, exec);
  const selector = `ours@${spec.marketplaceName}`;
  const args = lock.harness === 'codex'
    ? ['plugin', 'add', selector, '--json']
    : ['plugin', 'install', selector, '--scope', 'user'];
  await checked(exec, spec.executable, args, `install ${selector}`);
  // The same plugin under an older Git marketplace is a distinct harness
  // selection and can remain enabled beside the lock. Remove only the known
  // ours selectors, after the exact local selection is installed successfully.
  await removeLegacyPluginSelections(lock.harness, exec);
}

/**
 * Explicit install/update transaction.
 *
 * install reuses an existing same-channel lock (deterministic repair/reinstall);
 * update always resolves the requested channel once and advances the lock.
 */
export async function installHarnessPlugin(
  harness: HarnessPluginId,
  channel: HarnessPluginChannel,
  options: { update?: boolean; exec?: Exec; now?: () => Date } = {},
): Promise<HarnessPluginInstallResult> {
  const exec = options.exec ?? realExec;
  const root = harnessPluginRoot(harness);
  return withFileLock(`${root}.lock`, async () => {
    const existing = readHarnessPluginLock(harness);
    const mustResolve = options.update === true || !existing || existing.channel !== channel;
    const lock = mustResolve
      ? await resolveExactVersion(harness, channel, exec, options.now ?? (() => new Date()))
      : existing;
    if (mustResolve)
      replaceFileAtomically(harnessPluginLockPath(harness), `${JSON.stringify(lock, null, 2)}\n`);
    // Publish the lock first. If installation is interrupted, every retry uses
    // this same exact version; no half-finished transaction can observe a newer
    // dist-tag on its own.
    const marketplacePath = writeMarketplace(lock);
    await installFromLock(lock, exec);
    return {
      lock,
      lockPath: harnessPluginLockPath(harness),
      marketplacePath,
      resolved: mustResolve,
    };
  });
}

export function selectedHarnessPluginIds(values: string[]): HarnessPluginId[] {
  if (!values.length) return [...HARNESS_PLUGIN_IDS];
  const unknown = values.filter(value => !HARNESS_PLUGIN_IDS.includes(value as HarnessPluginId));
  if (unknown.length)
    throw new Error(`unknown harness(es) ${unknown.join(', ')}; allowed: ${HARNESS_PLUGIN_IDS.join(', ')}`);
  return [...new Set(values as HarnessPluginId[])];
}
