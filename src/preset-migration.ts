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
import { loadConfig, splitRootFor } from './config.js';
import { listTemplates } from './rooms-tasks/templates.js';

const STARTER_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  Agent: '0673294fd59f62dd37468d8249231f1730261c9f8a92a60ef10d848115952c26',
  Architect: '08f658d44dda571847e164b3fae59118f5b142cafdb2443372b5c99a29d80bf0',
  Critic: 'd29bd5188ad7de360180f2e30d454f113267898b3de156c5c01787526cacb5a3',
  Developer: '7f70feddd6d2a70ccb844db19dde5b7596d97771d340b36be384a912e1ccf0f1',
  Secretary: '405a45e5be9ea19c80a9b0aa8a06c36d1db2428909e1ca7cf885ace65f6cd954',
  Tester: '87403335d194d98ee905bd005f0d90824f0cf49f8e1ebffbaaebb0d61f324c75',
});

const V3_ROLE_DEFAULT_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  'roles/Agent.yaml': 'f3c739ee7e8e83787e34bf53e0a520f803fb722809c04b99f06c1ef27fd39063',
  'roles/Architect.yaml': '33e6723943acaf10a4f06f2c9c40644573e94b3835af030feec22867066637e7',
  'roles/Critic.yaml': '1b9bdbfa01049c2b9e35a82fcbe0c93d976823e19ec61c02e7a74f655f7ee5fd',
  'roles/Developer.yaml': '15316c13ab9862d394d1812482e92815a570d1e6c151cd8ec744e6cf37aa34c1',
  'roles/Secretary.yaml': '1339ccfafe88c3322370cf953c74d7a3f7d8e3dc51ff504ab1259409e41a0d49',
  'roles/Tester.yaml': 'e03ca047990f09776fd17e97e348bb8014cdaef6c0c2829a37884e5c471fb575',
  'agent_templates/Agent.yaml': '0673294fd59f62dd37468d8249231f1730261c9f8a92a60ef10d848115952c26',
  'agent_templates/Architect.yaml': '08f658d44dda571847e164b3fae59118f5b142cafdb2443372b5c99a29d80bf0',
  'agent_templates/Critic.yaml': 'd29bd5188ad7de360180f2e30d454f113267898b3de156c5c01787526cacb5a3',
  'agent_templates/Developer.yaml': '7f70feddd6d2a70ccb844db19dde5b7596d97771d340b36be384a912e1ccf0f1',
  'agent_templates/Secretary.yaml': '405a45e5be9ea19c80a9b0aa8a06c36d1db2428909e1ca7cf885ace65f6cd954',
  'agent_templates/Tester.yaml': '87403335d194d98ee905bd005f0d90824f0cf49f8e1ebffbaaebb0d61f324c75',
  'room_templates/single.yaml': 'f039eee04ff387642d172e972536e16311601d051691ed9faa091b614e82afbb',
  'room_templates/pair.yaml': '4bd145f5aba0edcec99e24c48792de5276d08eee0cd55f100f724aaa44cdaafb',
  'room_templates/team.yaml': '866202599f84b591336000b7b4278bc85754a82b7016cd2c82751af3b6e25116',
  'agents/FleetCoordinator.yaml': '35eb8c055c32262240c216bf57c6f85f8ac6c6ef5d3338587ea4ccf1f591c516',
});

// The revision-3 interactive generator selected purpose-specific Brains while
// bootstrap copied claude-default. These are exact semantic hashes of that
// generated form, not relaxed structural matches, so nearby user edits remain custom.
const V3_GENERATED_ROLE_DEFAULT_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  'agent_templates/Agent.yaml': 'aa35d661b31f9d4408e208c946f5b669a21a02ecc2b96848478c426529a1507d',
  'agent_templates/Architect.yaml': 'f292e66df7b805f5fff0e9fbe0256e994ea4e3bd1b8429876f2f1360d27c50cd',
  'agent_templates/Critic.yaml': '9ef29e588c5d37d1fc1a3362e0e4b83bd806f41f5a34e1b04c92d57dce49334b',
  'agent_templates/Developer.yaml': 'ad5c56d92607867954649d342c71d68830c461772255229af9c53204fa2d2f3a',
  'agent_templates/Secretary.yaml': 'bfc229e01c42c9288cef7fb3706091ce5c369e77a797c7b14c6d76e930537c01',
  'agent_templates/Tester.yaml': '3733db187951353f855dc998f1dd1f66d883eb556a3e6431a7abf4e267f63071',
  'agents/FleetCoordinator.yaml': '70f90797899828c3669c3914e8f873314e48cb9502aff187d2f1fbc9177f6df9',
});

const V4_ROLE_DEFAULT_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  'agent_templates/LocalCoordinator.yaml': 'f04a88b541e655e0039e4dc9834293b5180f6d488a473a6c51b50d0b72dae83b',
  'room_templates/team.yaml': 'accaa3569781f7acde3f15c89f447f4132f580f936513379c704aad27481e13f',
});

const V4_GENERATED_ROLE_DEFAULT_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  'agent_templates/LocalCoordinator.yaml': 'cb7c83a835dde9d45bac42cadce2f196f561d2460321c690cdef435f7076f97f',
});

const V5_ROLE_DEFAULT_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  'roles/LocalCoordinator.yaml': '52714be635060adca2bc7fe99c27c3184be6c78e3874a77e61a2fb135bac1278',
  'roles/Developer.yaml': '04278f325c366035e82d8e7f4aff72badb297eaf2fb5afae38a28a5aaf9260c9',
  'roles/Critic.yaml': 'bcb96c84534ca6fc466a8ee63f679785d347ed1cdf223efcc36ca5ed4ca7f3de',
  'agent_templates/LocalCoordinator.yaml': 'c59980ab7d94dad4d4961ba308cf62342291d8f1c57cf2faf900e80136fa2e7d',
  'agent_templates/Developer.yaml': '36f1d010a9c8591ae5ba422ef1ac26335b9f7f3382b6b8532844df754a56287e',
  'agent_templates/Critic.yaml': '7025b842e260a9c91ebc64dd3a11162a82b025b287457c6cb6f6c8964b38cdfd',
  'room_templates/single.yaml': '61051917b1f4f53a13687cc69d3f9ad98f1b02558f82b236b22aac942850395f',
  'room_templates/pair.yaml': 'a20b2145fa84e5d61266385e629892734b98fc61be9d0c7647c3778ec1bb40a8',
  'room_templates/team.yaml': 'c455f54a1f86106bfac7192299130dabfb91fa6179d2dedcc0573a384a902411',
});

const V5_GENERATED_ROLE_DEFAULT_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze({
  'agent_templates/LocalCoordinator.yaml': 'cb7c83a835dde9d45bac42cadce2f196f561d2460321c690cdef435f7076f97f',
  'agent_templates/Developer.yaml': 'fdd953aab72d042e62780dd273598745aae59521b39edf4876d7676bb7189c83',
  'agent_templates/Critic.yaml': '3e98a28f17876061cfadf984351aa59fdbe19629e514eff52c74546545c64a91',
});

const CURRENT_ROLE_DEFAULTS = new Set([
  'roles/Coordinator.yaml', 'roles/LocalCoordinator.yaml', 'roles/Developer.yaml', 'roles/Critic.yaml',
  'agent_templates/LocalCoordinator.yaml', 'agent_templates/Developer.yaml', 'agent_templates/Critic.yaml',
  'room_templates/single.yaml', 'room_templates/pair.yaml', 'room_templates/team.yaml',
  'agents/FleetCoordinator.yaml',
]);

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

export interface RoleDefaultMigrationResult {
  write: boolean;
  root: string;
  stagingPath: string;
  backupPath: string;
  removals: string[];
  replacements: string[];
  additions: string[];
  preserved: string[];
}

interface MigrationHooks {
  rename?: typeof renameSync;
  nonce?: string;
  beforeLockClaim?: () => void;
  beforeRoleDefaultPublish?: () => void;
}

function fingerprint(path: string): string {
  const value = parseFleetDocument(path, readFileSync(path, 'utf8'), 'strict').value;
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function pathProof(path: string): Record<string, string | number> {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error(`migration proof refuses symlink or special file: ${path}`);
  return {
    dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
    size: stat.size,
    ...(stat.isFile() ? {
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    } : {}),
  };
}

/** Stable proof of every path, byte, and preservation-relevant identity in a trusted tree. */
function treeProof(root: string): string {
  const entries: Array<Record<string, string | number>> = [];
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    entries.push({ path: relative, type: stat.isDirectory() ? 'directory' : 'file', ...pathProof(path) });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort())
      visit(join(path, name), relative ? `${relative}/${name}` : name);
  };
  visit(root, '.');
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

function manifestProof(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`migration proof requires a regular manifest: ${path}`);
  return canonicalJson(pathProof(path));
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

function validateRoleDefaultMigration(stageManifest: string): void {
  const config = loadConfig(stageManifest, { yamlMode: 'strict' });
  for (const template of listTemplates(config.roomTemplates ?? {})) {
    for (const member of template.members) if (!config.agentTemplates?.[member.agent_template])
      throw new Error(
        `Room Template '${template.name}' references missing Agent Template '${member.agent_template}'`,
      );
  }
}

/** Explicit adoption of exact known packaged role defaults; customized files are never changed. */
export function migratePackagedRoleDefaults(
  configuration: string,
  options: { write?: boolean } = {},
  hooks: MigrationHooks = {},
): RoleDefaultMigrationResult {
  const configPath = resolve(configuration);
  const root = splitRootFor(configPath);
  if (!existsSync(configPath) || !existsSync(root))
    throw new Error('packaged role-default migration requires an existing split configuration');
  const uid = process.getuid?.(); const configStat = lstatSync(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink() || (configStat.mode & 0o077) !== 0
    || (uid !== undefined && configStat.uid !== uid))
    throw new Error('packaged role-default migration requires an owner-private regular config');
  assertPrivateTree(root);
  const parent = dirname(root); const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o022) !== 0
    || (uid !== undefined && parentStat.uid !== uid) || statSync(root).dev !== parentStat.dev)
    throw new Error('packaged role-default migration requires an owner-controlled same-filesystem parent');
  const classify = () => {
    const removals: string[] = []; const replacements: string[] = []; const preserved: string[] = [];
    const known = new Set([
      ...Object.keys(V3_ROLE_DEFAULT_FINGERPRINTS),
      ...Object.keys(V4_ROLE_DEFAULT_FINGERPRINTS),
      ...Object.keys(V5_ROLE_DEFAULT_FINGERPRINTS),
    ]);
    for (const relative of known) {
      const path = join(root, relative); if (!existsSync(path)) continue;
      const actual = fingerprint(path);
      const recognized = [
        V3_ROLE_DEFAULT_FINGERPRINTS[relative],
        V3_GENERATED_ROLE_DEFAULT_FINGERPRINTS[relative],
        V4_ROLE_DEFAULT_FINGERPRINTS[relative],
        V4_GENERATED_ROLE_DEFAULT_FINGERPRINTS[relative],
        V5_ROLE_DEFAULT_FINGERPRINTS[relative],
        V5_GENERATED_ROLE_DEFAULT_FINGERPRINTS[relative],
      ].some(expected => expected !== undefined && actual === expected);
      if (recognized)
        (CURRENT_ROLE_DEFAULTS.has(relative) ? replacements : removals).push(path);
      else preserved.push(path);
    }
    const additions: string[] = [];
    for (const relative of CURRENT_ROLE_DEFAULTS) {
      const path = join(root, relative);
      if (!existsSync(path)) additions.push(path);
      else if (!replacements.includes(path) && !preserved.includes(path)) preserved.push(path);
    }
    return { removals: removals.sort(), replacements: replacements.sort(),
      additions: additions.sort(), preserved: preserved.sort() };
  };
  const classified = classify();
  const nonce = hooks.nonce ?? `${new Date().toISOString().replace(/[^0-9]/g, '')}-${process.pid}`;
  const stagingPath = join(parent, `.${basename(root)}.role-defaults-stage-${nonce}`);
  const backupPath = join(parent, `.${basename(root)}.role-defaults-backup-${nonce}`);
  const stageManifest = `${stagingPath}.yaml`;
  const lockPath = join(parent, `.${basename(root)}.role-defaults-migration.lock`);
  const result = { write: options.write === true, root, stagingPath, backupPath,
    ...classified };
  if (!options.write || (!classified.removals.length && !classified.replacements.length && !classified.additions.length)) return result;
  for (const path of [stagingPath, backupPath, stageManifest, lockPath])
    if (existsSync(path)) throw new Error('packaged role-default migration refuses existing staging, backup, or lock path');
  const lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const lockToken = `${process.pid}:${randomUUID()}\n`; writeFileSync(lockFd, lockToken); fsyncSync(lockFd);
  try {
    assertPrivateTree(root);
    if (canonicalJson(classify()) !== canonicalJson(classified))
      throw new Error('packaged role-default migration inputs changed after lock acquisition');
    const sourceTreeProof = treeProof(root);
    const sourceManifestProof = manifestProof(configPath);
    copyTree(root, stagingPath);
    for (const path of classified.removals) unlinkSync(join(stagingPath, path.slice(root.length + 1)));
    const source = join(packagedPresetRoot(), 'fleet');
    for (const path of [...classified.replacements, ...classified.additions]) {
      const relative = path.slice(root.length + 1); const target = join(stagingPath, relative);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (existsSync(target)) unlinkSync(target);
      copyFileSync(join(source, relative), target, constants.COPYFILE_EXCL); chmodSync(target, 0o600);
      fsyncPath(target);
    }
    for (const kind of ['roles', 'agent_templates', 'room_templates', 'agents'])
      fsyncPath(join(stagingPath, kind));
    assertPrivateTree(stagingPath);
    copyFileSync(configPath, stageManifest, constants.COPYFILE_EXCL); chmodSync(stageManifest, 0o600);
    try { validateRoleDefaultMigration(stageManifest); }
    catch (error) { throw new Error(`staged configuration is invalid: ${(error as Error).message}`, { cause: error }); }
    unlinkSync(stageManifest);
    const rename = hooks.rename ?? renameSync;
    hooks.beforeRoleDefaultPublish?.();
    rename(root, backupPath); fsyncPath(parent);
    let verificationFailure: unknown;
    try {
      assertPrivateTree(backupPath);
      if (treeProof(backupPath) !== sourceTreeProof || manifestProof(configPath) !== sourceManifestProof)
        throw new Error('migration inputs changed during staging');
    } catch (error) { verificationFailure = error; }
    if (verificationFailure) {
      try { rename(backupPath, root); fsyncPath(parent); }
      catch (rollbackError) {
        throw new Error(`post-rename verification failed and rollback failed; recovery backup retained at ${backupPath}: ${(rollbackError as Error).message}`, { cause: verificationFailure });
      }
      throw new Error(`post-rename verification failed; live root restored and staged recovery retained at ${stagingPath}: ${(verificationFailure as Error).message}`, { cause: verificationFailure });
    }
    try { rename(stagingPath, root); fsyncPath(parent); }
    catch (publishError) {
      try { rename(backupPath, root); fsyncPath(parent); }
      catch (rollbackError) {
        throw new Error(`publication failed and rollback failed; recovery backup retained at ${backupPath}: ${(rollbackError as Error).message}`, { cause: publishError });
      }
      throw new Error(`publication failed; original restored and staged recovery retained at ${stagingPath}: ${(publishError as Error).message}`, { cause: publishError });
    }
    return result;
  } finally {
    closeSync(lockFd);
    if (existsSync(stageManifest)) unlinkSync(stageManifest);
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === lockToken) unlinkSync(lockPath);
  }
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
