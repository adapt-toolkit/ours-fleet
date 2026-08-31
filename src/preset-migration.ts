import {
  closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync,
  fstatSync, utimesSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { parseFleetDocument } from './config-yaml.js';
import { packagedPresetRoot } from './preset-bootstrap.js';
import { splitRootFor } from './config.js';

const STARTER_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  Agent: '0673294fd59f62dd37468d8249231f1730261c9f8a92a60ef10d848115952c26',
  Architect: '08f658d44dda571847e164b3fae59118f5b142cafdb2443372b5c99a29d80bf0',
  Critic: 'd29bd5188ad7de360180f2e30d454f113267898b3de156c5c01787526cacb5a3',
  Developer: '7f70feddd6d2a70ccb844db19dde5b7596d97771d340b36be384a912e1ccf0f1',
  Secretary: '405a45e5be9ea19c80a9b0aa8a06c36d1db2428909e1ca7cf885ace65f6cd954',
  Tester: '87403335d194d98ee905bd005f0d90824f0cf49f8e1ebffbaaebb0d61f324c75',
});

export const legacyStarterMigrationManifest = Object.freeze({
  schemaVersion: 1,
  presetRevision: 2,
  fingerprints: STARTER_FINGERPRINTS,
});

export interface PresetMigrationResult {
  write: boolean;
  root: string;
  stagingPath: string;
  backupPath: string;
  moves: Array<{ from: string; to: string }>;
  additions: string[];
}

interface MigrationHooks {
  rename?: typeof renameSync;
  nonce?: string;
  beforeLockClaim?: () => void;
}

function fingerprint(path: string): string {
  const value = parseFleetDocument(path, readFileSync(path, 'utf8'), 'strict').value;
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertPrivateTree(root: string): void {
  const uid = process.getuid?.();
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`migration refuses symlink or special file: ${path}`);
    if (uid !== undefined && stat.uid !== uid)
      throw new Error(`migration refuses path owned by uid ${stat.uid}: ${path}`);
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error(`migration requires owner-private, non-group/world-writable mode: ${path}`);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function copyTree(source: string, target: string): void {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { mode: stat.mode & 0o777 });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry));
    chmodSync(target, stat.mode & 0o777);
    utimesSync(target, stat.atime, stat.mtime);
    fsyncPath(target);
    return;
  }
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, stat.mode & 0o777);
  utimesSync(target, stat.atime, stat.mtime);
  const fd = openSync(target, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function verifyStarters(root: string): Array<{ name: string; path: string }> {
  return Object.entries(STARTER_FINGERPRINTS).map(([name, expected]) => {
    const path = join(root, 'agents', `${name}.yaml`);
    if (!existsSync(path)) throw new Error(`legacy starter migration is ambiguous: missing ${path}`);
    const actual = fingerprint(path);
    if (actual !== expected)
      throw new Error(`legacy starter migration refuses customized known starter ${path}`);
    return { name, path };
  });
}

/** Explicit safe migration of the exact revision-2 six-worker starter set. Dry-run unless write=true. */
export function migrateLegacyStarterPresets(
  configuration: string,
  options: { write?: boolean } = {},
  hooks: MigrationHooks = {},
): PresetMigrationResult {
  const configPath = resolve(configuration);
  const root = splitRootFor(configPath);
  const configStat = lstatSync(configPath);
  const uid = process.getuid?.();
  if (!configStat.isFile() || configStat.isSymbolicLink() || (configStat.mode & 0o077) !== 0
    || (uid !== undefined && configStat.uid !== uid))
    throw new Error(`migration requires an owner-private regular v2 configuration file: ${configPath}`);
  const config = parseFleetDocument(configPath, readFileSync(configPath, 'utf8'), 'strict').value;
  if (config.api_version !== 'ours.network/fleet/v2')
    throw new Error(`legacy starter migration requires api_version ours.network/fleet/v2: ${configPath}`);
  if (!existsSync(root)) throw new Error(`legacy starter split root does not exist: ${root}`);
  assertPrivateTree(root);
  const rootStat = statSync(root);
  const parent = dirname(root);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o022) !== 0
    || (uid !== undefined && parentStat.uid !== uid))
    throw new Error(`migration requires an owner-controlled, non-group/world-writable parent directory: ${parent}`);
  if (rootStat.dev !== statSync(parent).dev)
    throw new Error(`migration requires same-filesystem atomic rename: ${root} and ${parent}`);
  const starters = verifyStarters(root);
  const templateDir = join(root, 'agent_templates');
  const coordinator = join(root, 'agents', 'FleetCoordinator.yaml');
  for (const { name } of starters) {
    const target = join(templateDir, `${name}.yaml`);
    if (existsSync(target)) throw new Error(`legacy starter migration destination collides: ${target}`);
  }
  if (existsSync(coordinator)) throw new Error(`legacy starter migration destination collides: ${coordinator}`);

  const nonce = hooks.nonce ?? `${new Date().toISOString().replace(/[^0-9]/g, '')}-${process.pid}`;
  const stagingPath = join(parent, `.${basename(root)}.agent-templates-stage-${nonce}`);
  const backupPath = join(parent, `.${basename(root)}.legacy-backup-${nonce}`);
  const lockPath = join(parent, `.${basename(root)}.agent-templates-migration.lock`);
  const lockReleasePath = `${lockPath}.release-${randomUUID()}`;
  for (const path of [stagingPath, backupPath, lockPath, lockReleasePath])
    if (existsSync(path)) throw new Error(`migration refuses existing staging, backup, or lock path: ${path}`);
  const result: PresetMigrationResult = {
    write: options.write === true, root, stagingPath, backupPath,
    moves: starters.map(({ path, name }) => ({ from: path, to: join(templateDir, `${name}.yaml`) })),
    additions: [coordinator],
  };
  if (!options.write) return result;

  const lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const lockToken = `${process.pid}:${randomUUID()}\n`;
  try {
    writeFileSync(lockFd, lockToken); fsyncSync(lockFd);
    // The lock closes the race, but preflight occurred before acquiring it so repeat every safety assertion.
    for (const path of [stagingPath, backupPath])
      if (existsSync(path)) throw new Error(`migration refuses existing staging or backup path: ${path}`);
    assertPrivateTree(root);
    verifyStarters(root);
    copyTree(root, stagingPath);
    const stagedTemplates = join(stagingPath, 'agent_templates');
    if (!existsSync(stagedTemplates)) mkdirSync(stagedTemplates, { mode: 0o700 });
    for (const { name } of starters)
      renameSync(join(stagingPath, 'agents', `${name}.yaml`), join(stagedTemplates, `${name}.yaml`));
    copyFileSync(join(packagedPresetRoot(), 'fleet', 'agents', 'FleetCoordinator.yaml'),
      join(stagingPath, 'agents', 'FleetCoordinator.yaml'), constants.COPYFILE_EXCL);
    chmodSync(join(stagingPath, 'agents', 'FleetCoordinator.yaml'), 0o600);
    fsyncPath(join(stagingPath, 'agents', 'FleetCoordinator.yaml'));
    for (const path of [stagedTemplates, join(stagingPath, 'agents'), stagingPath]) fsyncPath(path);
    assertPrivateTree(stagingPath);
    verifyStarters(root); // immediate fingerprint revalidation before publication
    const rename = hooks.rename ?? renameSync;
    try { rename(root, backupPath); } catch (error) {
      throw new Error(`migration publication failed; staged recovery tree retained at ${stagingPath}: ${(error as Error).message}`, { cause: error });
    }
    fsyncPath(parent);
    try {
      rename(stagingPath, root);
      fsyncPath(parent);
    } catch (publishError) {
      try {
        rename(backupPath, root);
        fsyncPath(parent);
      } catch (rollbackError) {
        throw new Error(`migration publication failed and rollback failed; manually recover ${backupPath} to ${root}; staged recovery tree is ${stagingPath}: ${(rollbackError as Error).message}`, { cause: publishError });
      }
      throw new Error(`migration publication failed; original restored and staged recovery tree retained at ${stagingPath}: ${(publishError as Error).message}`, { cause: publishError });
    }
    return result;
  } finally {
    const held = fstatSync(lockFd);
    closeSync(lockFd);
    if (existsSync(lockPath)) {
      const current = lstatSync(lockPath);
      if (current.dev !== held.dev || current.ino !== held.ino || readFileSync(lockPath, 'utf8') !== lockToken)
        throw new Error(`migration lock ownership changed; refusing to remove foreign lock: ${lockPath}`);
      hooks.beforeLockClaim?.();
      renameSync(lockPath, lockReleasePath);
      const claimed = lstatSync(lockReleasePath);
      if (claimed.dev !== held.dev || claimed.ino !== held.ino || readFileSync(lockReleasePath, 'utf8') !== lockToken) {
        if (!existsSync(lockPath)) renameSync(lockReleasePath, lockPath);
        throw new Error(`migration lock changed during atomic release; foreign lock preserved at ${existsSync(lockReleasePath) ? lockReleasePath : lockPath}`);
      }
      unlinkSync(lockReleasePath);
      fsyncPath(parent);
    } else throw new Error(`migration lock vanished before release: ${lockPath}`);
  }
}
