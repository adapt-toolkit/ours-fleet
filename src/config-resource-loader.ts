import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { parseFleetDocument } from './config-yaml.js';
import {
  MAX_ROLE_TEXT_BYTES, ResourceValidationError, parseTypedResource,
  type BrainRef, type BrainSpec, type ResourceKind, type TypedResource,
} from './config-resources.js';

const DIRECTORY_KIND = {
  'roles.d': 'Role',
  'brains.d': 'Brain',
  'agents.d': 'Agent',
  'room-templates.d': 'RoomTemplate',
  'rooms.d': 'RoomsPolicy',
  'tasks.d': 'TasksPolicy',
} as const satisfies Record<string, ResourceKind>;

const BOOTSTRAP_KEYS = [
  'schema_version', 'config_dir', 'policy', 'adapters', 'watchdogs', 'loops', 'owner_routing',
] as const;
const CONTEXT_SEPARATOR = '\n\n--- instance context ---\n\n';

export interface ResourceLoaderLimits {
  maxFileBytes: number;
  maxAggregateBytes: number;
}

export const DEFAULT_RESOURCE_LOADER_LIMITS: Readonly<ResourceLoaderLimits> = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxAggregateBytes: 16 * 1024 * 1024,
});

export interface LoaderDiagnostic {
  severity: 'warning';
  code: 'ignored_entry';
  sourceFile: string;
  message: string;
}

export interface BrainValidationContext {
  sourceFile: string;
  fieldPath: string;
  resourceId?: string;
}

export type BrainValidationHook = (
  brain: Readonly<BrainSpec>, context: Readonly<BrainValidationContext>,
) => readonly string[] | void;

export interface ConfigResourceSource {
  kind: ResourceKind;
  id: string;
  sourceFile: string;
  relativePath: string;
  size: number;
  sha256: string;
  resource: TypedResource;
}

export interface ConfigResourceSnapshot {
  schemaVersion: 2;
  bootstrapFile: string;
  configDir: string;
  digest: string;
  /**
   * Top-level and container-shape validated global policy. Complete semantic validation
   * is mandatory before any later publication/reconciliation slice may consume it.
   */
  bootstrap: Readonly<Record<string, unknown>>;
  sources: readonly Readonly<ConfigResourceSource>[];
  resources: Readonly<Partial<Record<ResourceKind, Readonly<Record<string, TypedResource>>>>>;
  diagnostics: readonly Readonly<LoaderDiagnostic>[];
}

export interface ConfigResourceDocument {
  /** One-level typed path such as `roles.d/coordinator.yaml`. */
  relativePath: string;
  bytes: Buffer;
}

export class ConfigResourceLoadError extends Error {
  constructor(readonly sourceFile: string, readonly fieldPath: string, message: string) {
    super(`${sourceFile}:${fieldPath}: ${message}`);
  }
}

interface ReadIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface ReadResult { bytes: Buffer; identity: ReadIdentity }

interface LoaderTestHooks {
  beforeOpen?: (path: string) => void;
  afterRead?: (path: string) => void;
  beforeReadDirectory?: (path: string) => void;
  /** null simulates a platform without the required secure-open flag. */
  noFollowFlag?: null;
}

const identityOf = (stat: BigIntStats): ReadIdentity => ({
  dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs,
});

const sameIdentity = (left: ReadIdentity, right: ReadIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeNs === right.mtimeNs;

const isWithin = (candidate: string, parent: string): boolean => {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

function assertNoSymlinkComponents(path: string, sourceFile: string, fieldPath = '$'): void {
  // Component checks plus O_NOFOLLOW close the final-component attack. A hostile
  // non-cooperating writer can still rename a parent between these syscalls;
  // transaction locking/recovery narrows that documented TOCTOU in the next slice.
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(cursor, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ConfigResourceLoadError(sourceFile, fieldPath, `path component does not exist: ${cursor}`);
      throw new ConfigResourceLoadError(
        sourceFile, fieldPath, `cannot inspect path component ${cursor}: ${fsReason(error)}`);
    }
    if (stat.isSymbolicLink())
      throw new ConfigResourceLoadError(
        sourceFile, fieldPath, `symlink path component is forbidden: ${cursor}`);
  }
}

function readBoundedStableFile(
  path: string, maxBytes: number, aggregateRemaining = Number.MAX_SAFE_INTEGER,
  hooks?: LoaderTestHooks,
): ReadResult {
  assertNoSymlinkComponents(path, path);
  let beforePath: BigIntStats;
  try { beforePath = lstatSync(path, { bigint: true }); }
  catch (error) {
    throw new ConfigResourceLoadError(path, '$', `cannot inspect file before reading: ${fsReason(error)}`);
  }
  if (!beforePath.isFile())
    throw new ConfigResourceLoadError(path, '$', 'must be a regular file');
  hooks?.beforeOpen?.(path);
  const noFollow = hooks?.noFollowFlag === null ? undefined : constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number')
    throw new ConfigResourceLoadError(path, '$', 'secure file open unavailable: O_NOFOLLOW is required');
  const flags = constants.O_RDONLY | noFollow;
  let fd: number;
  try { fd = openSync(path, flags); }
  catch (error) {
    throw new ConfigResourceLoadError(path, '$', `cannot open stable regular file: ${fsReason(error)}`);
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new ConfigResourceLoadError(path, '$', 'must be a regular file');
    if (beforePath.dev !== before.dev || beforePath.ino !== before.ino
        || beforePath.size !== before.size || beforePath.mtimeNs !== before.mtimeNs)
      throw new ConfigResourceLoadError(path, '$', 'file identity changed before reading');
    if (before.size > BigInt(maxBytes))
      throw new ConfigResourceLoadError(path, '$', `exceeds ${maxBytes} byte file limit`);
    if (before.size > BigInt(aggregateRemaining))
      throw new ConfigResourceLoadError(path, '$', 'aggregate byte limit exceeded');
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count === 0) throw new ConfigResourceLoadError(path, '$', 'changed or truncated while reading');
      offset += count;
    }
    hooks?.afterRead?.(path);
    const after = fstatSync(fd, { bigint: true });
    let afterPath: BigIntStats;
    try { afterPath = lstatSync(path, { bigint: true }); }
    catch (error) {
      throw new ConfigResourceLoadError(path, '$', `cannot inspect file after reading: ${fsReason(error)}`);
    }
    const beforeIdentity = identityOf(before);
    if (!sameIdentity(beforeIdentity, identityOf(after))
        || beforePath.dev !== afterPath.dev || beforePath.ino !== afterPath.ino
        || beforePath.size !== afterPath.size || beforePath.mtimeNs !== afterPath.mtimeNs)
      throw new ConfigResourceLoadError(path, '$', 'file identity changed while reading');
    return { bytes, identity: beforeIdentity };
  } finally {
    closeSync(fd);
  }
}

function fsReason(error: unknown): string {
  const value = error as NodeJS.ErrnoException;
  return value.code ? `${value.code}${value.message ? ` (${value.message})` : ''}` : String(error);
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function digestPart(hash: ReturnType<typeof createHash>, label: string, bytes: Buffer): void {
  const labelBytes = Buffer.from(label, 'utf8');
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(BigInt(labelBytes.length), 0);
  header.writeBigUInt64BE(BigInt(bytes.length), 8);
  hash.update(header).update(labelBytes).update(bytes);
}

function parseBootstrap(path: string, bytes: Buffer): Record<string, unknown> {
  let value: Record<string, unknown>;
  try { value = parseFleetDocument(path, bytes.toString('utf8'), 'strict').value; }
  catch (error) {
    throw new ConfigResourceLoadError(path, '$', error instanceof Error ? error.message : String(error));
  }
  const extra = Object.keys(value).filter(key => !BOOTSTRAP_KEYS.includes(
    key as (typeof BOOTSTRAP_KEYS)[number]));
  if (extra.length)
    throw new ConfigResourceLoadError(path, '$', `unknown bootstrap key(s): ${extra.sort().join(', ')}`);
  if (value.schema_version !== 2)
    throw new ConfigResourceLoadError(path, '$.schema_version', 'must be 2');
  if (value.config_dir !== undefined
      && (typeof value.config_dir !== 'string' || !value.config_dir.length
        || value.config_dir !== value.config_dir.trim()))
    throw new ConfigResourceLoadError(path, '$.config_dir', 'must be a non-empty unpadded string');
  for (const key of ['policy', 'adapters', 'owner_routing'] as const) {
    if (value[key] !== undefined && !isPlainMapping(value[key]))
      throw new ConfigResourceLoadError(path, `$.${key}`, 'must be a mapping');
  }
  // Preserve the existing input contract: null disables watchdog/loop collections.
  for (const key of ['watchdogs', 'loops'] as const) {
    if (value[key] !== undefined && value[key] !== null && !isPlainMapping(value[key]))
      throw new ConfigResourceLoadError(path, `$.${key}`, 'must be a mapping or null');
  }
  return value;
}

export function resolveConfigResourceDirectory(bootstrapFile: string, bootstrapBytes: Buffer): string {
  const path = resolve(bootstrapFile);
  const bootstrap = parseBootstrap(path, bootstrapBytes);
  return resolve(dirname(path), (bootstrap.config_dir as string | undefined) ?? 'fleet.conf.d');
}

function resolveBrain(ref: BrainRef, brains: Readonly<Record<string, TypedResource>>, source: string, path: string): BrainSpec {
  if (!('template' in ref)) return ref;
  const resource = brains[ref.template];
  if (!resource || resource.kind !== 'Brain')
    throw new ConfigResourceLoadError(source, `${path}.template`, `unknown Brain '${ref.template}'`);
  return resource.spec;
}

function graphValidate(
  sources: readonly ConfigResourceSource[],
  resources: Partial<Record<ResourceKind, Record<string, TypedResource>>>,
  validateBrain: BrainValidationHook,
): void {
  const roles = resources.Role ?? {};
  const brains = resources.Brain ?? {};
  const agents = resources.Agent ?? {};
  const templates = resources.RoomTemplate ?? {};
  const sourceByResource = new Map(sources.map(source => [source.resource, source.sourceFile]));
  const ensureRole = (id: string, source: string, path: string): void => {
    if (!roles[id]) throw new ConfigResourceLoadError(source, path, `unknown Role '${id}'`);
  };
  const checkBrain = (ref: BrainRef, source: string, path: string, resourceId?: string): BrainSpec => {
    const brain = resolveBrain(ref, brains, source, path);
    const problems = validateBrain(brain, { sourceFile: source, fieldPath: path, resourceId }) ?? [];
    if (problems.length) throw new ConfigResourceLoadError(source, path, problems.join('; '));
    return brain;
  };

  for (const resource of Object.values(brains)) {
    if (resource.kind !== 'Brain') continue;
    const source = sourceByResource.get(resource)!;
    const problems = validateBrain(resource.spec, {
      sourceFile: source, fieldPath: '$.spec', resourceId: resource.id,
    }) ?? [];
    if (problems.length) throw new ConfigResourceLoadError(source, '$.spec', problems.join('; '));
  }
  for (const resource of Object.values(agents)) {
    if (resource.kind !== 'Agent') continue;
    const source = sourceByResource.get(resource)!;
    ensureRole(resource.spec.role, source, '$.spec.role');
    const brain = checkBrain(resource.spec.brain, source, '$.spec.brain', resource.id);
    if (resource.spec.runtime?.owner_channel && brain.session !== 'acp')
      throw new ConfigResourceLoadError(source, '$.spec.runtime.owner_channel', 'requires an ACP Brain');
    const supervision = resource.spec.runtime?.supervision;
    if (supervision?.coordinator && !agents[supervision.coordinator])
      throw new ConfigResourceLoadError(source, '$.spec.runtime.supervision.coordinator',
        `unknown Agent '${supervision.coordinator}'`);
    supervision?.oversee?.forEach((entry, index) => {
      if (!agents[entry.role]) throw new ConfigResourceLoadError(
        source, `$.spec.runtime.supervision.oversee[${index}].role`, `unknown Agent '${entry.role}'`);
    });
  }
  for (const resource of Object.values(templates)) {
    if (resource.kind !== 'RoomTemplate') continue;
    const source = sourceByResource.get(resource)!;
    const slots = new Set<string>();
    resource.spec.members.forEach((member, index) => {
      const path = `$.spec.members[${index}]`;
      if (slots.has(member.slot))
        throw new ConfigResourceLoadError(source, `${path}.slot`, `duplicate slot '${member.slot}'`);
      slots.add(member.slot);
      ensureRole(member.role, source, `${path}.role`);
      if (member.brain) checkBrain(member.brain, source, `${path}.brain`, resource.id);
      const role = roles[member.role];
      if (role?.kind === 'Role' && member.role_context) {
        for (const field of ['mission', 'persona'] as const) {
          const append = member.role_context[`${field}_append`];
          if (append !== undefined) {
            const effective = `${role.spec[field] ?? ''}${CONTEXT_SEPARATOR}${append}`;
            if (Buffer.byteLength(effective, 'utf8') > MAX_ROLE_TEXT_BYTES)
              throw new ConfigResourceLoadError(
                source, `${path}.role_context.${field}_append`,
                `effective ${field} exceeds ${MAX_ROLE_TEXT_BYTES} UTF-8 bytes`);
          }
        }
      }
    });
  }
  for (const resource of Object.values(resources.RoomsPolicy ?? {})) {
    if (resource.kind !== 'RoomsPolicy') continue;
    const source = sourceByResource.get(resource)!;
    const defaults = resource.spec.defaults;
    if (defaults?.template && !templates[defaults.template])
      throw new ConfigResourceLoadError(source, '$.spec.defaults.template',
        `unknown RoomTemplate '${defaults.template}'`);
    if (defaults?.brain) checkBrain(defaults.brain, source, '$.spec.defaults.brain', resource.id);
  }
  for (const resource of Object.values(resources.TasksPolicy ?? {})) {
    if (resource.kind !== 'TasksPolicy') continue;
    const source = sourceByResource.get(resource)!;
    if (resource.spec.default_room_template && !templates[resource.spec.default_room_template])
      throw new ConfigResourceLoadError(source, '$.spec.default_room_template',
        `unknown RoomTemplate '${resource.spec.default_room_template}'`);
    if (resource.spec.brain) checkBrain(resource.spec.brain, source, '$.spec.brain', resource.id);
  }
}

/**
 * Validate a complete proposed document set without consulting the filesystem.
 * Transaction code supplies bytes already read through the secure disk loader's
 * identity boundary; this seam performs the identical schema/graph/digest work
 * without making staged files visible or rewriting bootstrap `config_dir`.
 */
export function loadConfigResourceSnapshotFromDocuments(options: {
  bootstrapFile: string;
  bootstrapBytes: Buffer;
  configDir: string;
  documents: readonly ConfigResourceDocument[];
  validateBrain?: BrainValidationHook;
  limits?: Partial<ResourceLoaderLimits>;
}): ConfigResourceSnapshot {
  const limits = { ...DEFAULT_RESOURCE_LOADER_LIMITS, ...(options.limits ?? {}) };
  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1
      || !Number.isSafeInteger(limits.maxAggregateBytes)
      || limits.maxAggregateBytes < limits.maxFileBytes)
    throw new ConfigResourceLoadError(options.bootstrapFile, '$', 'invalid loader byte limits');
  if (!Buffer.isBuffer(options.bootstrapBytes) || options.bootstrapBytes.length > limits.maxFileBytes)
    throw new ConfigResourceLoadError(
      options.bootstrapFile, '$', `bootstrap must be a Buffer within ${limits.maxFileBytes} bytes`);
  let aggregate = options.bootstrapBytes.length;
  for (const document of options.documents) {
    if (!Buffer.isBuffer(document.bytes) || document.bytes.length > limits.maxFileBytes)
      throw new ConfigResourceLoadError(
        options.bootstrapFile, '$', `proposed document must be a Buffer within ${limits.maxFileBytes} bytes`);
    aggregate += document.bytes.length;
    if (aggregate > limits.maxAggregateBytes)
      throw new ConfigResourceLoadError(options.bootstrapFile, '$', 'aggregate byte limit exceeded');
  }
  const bootstrapFile = resolve(options.bootstrapFile);
  const configDir = resolve(options.configDir);
  const bootstrap = parseBootstrap(bootstrapFile, options.bootstrapBytes);
  const configuredDir = bootstrap.config_dir as string | undefined;
  const selectedDir = resolve(dirname(bootstrapFile), configuredDir ?? 'fleet.conf.d');
  if (selectedDir !== configDir)
    throw new ConfigResourceLoadError(
      bootstrapFile, '$.config_dir', 'proposed config_dir must match the transaction config directory');

  const diagnostics: LoaderDiagnostic[] = [];
  const sources: ConfigResourceSource[] = [];
  const resources: Partial<Record<ResourceKind, Record<string, TypedResource>>> = {};
  const hash = createHash('sha256');
  digestPart(hash, 'bootstrap', options.bootstrapBytes);
  const seenPaths = new Set<string>();
  for (const document of options.documents) {
    const parts = document.relativePath.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]
        || !(parts[0] in DIRECTORY_KIND) || parts[1] === '.' || parts[1] === '..')
      throw new ConfigResourceLoadError(
        bootstrapFile, '$', `invalid proposed typed path '${document.relativePath}'`);
  }
  const ordered = [...options.documents].sort((left, right) => {
    const [leftDir, leftName] = left.relativePath.split('/');
    const [rightDir, rightName] = right.relativePath.split('/');
    const dirs = Object.keys(DIRECTORY_KIND);
    const directoryOrder = dirs.indexOf(leftDir) - dirs.indexOf(rightDir);
    return directoryOrder || Buffer.compare(Buffer.from(leftName), Buffer.from(rightName));
  });

  for (const document of ordered) {
    const parts = document.relativePath.split('/');
    if (seenPaths.has(document.relativePath))
      throw new ConfigResourceLoadError(
        bootstrapFile, '$', `duplicate proposed typed path '${document.relativePath}'`);
    seenPaths.add(document.relativePath);
    const [directoryName, entryName] = parts as [keyof typeof DIRECTORY_KIND, string];
    const sourceFile = join(configDir, directoryName, entryName);
    const yaml = entryName.endsWith('.yaml') || entryName.endsWith('.yml');
    if (!yaml) {
      diagnostics.push({
        severity: 'warning', code: 'ignored_entry', sourceFile,
        message: 'ignored non-YAML entry in typed directory',
      });
      continue;
    }
    try { parseFleetDocument(sourceFile, document.bytes.toString('utf8'), 'strict'); }
    catch (error) {
      throw new ConfigResourceLoadError(
        sourceFile, '$', error instanceof Error ? error.message : String(error));
    }
    let resource: TypedResource;
    try { resource = parseTypedResource(sourceFile, document.bytes.toString('utf8')); }
    catch (error) {
      if (error instanceof ResourceValidationError) throw error;
      throw new ConfigResourceLoadError(
        sourceFile, '$', error instanceof Error ? error.message : String(error));
    }
    const expectedKind = DIRECTORY_KIND[directoryName];
    if (resource.kind !== expectedKind)
      throw new ConfigResourceLoadError(
        sourceFile, '$.kind', `directory ${directoryName} requires kind ${expectedKind}`);
    const byKind = resources[resource.kind] ??= Object.create(null) as Record<string, TypedResource>;
    if (Object.hasOwn(byKind, resource.id))
      throw new ConfigResourceLoadError(
        sourceFile, '$.id', `duplicate ${resource.kind} id '${resource.id}'`);
    byKind[resource.id] = resource;
    const sha256 = createHash('sha256').update(document.bytes).digest('hex');
    sources.push({
      kind: resource.kind, id: resource.id, sourceFile, relativePath: document.relativePath,
      size: document.bytes.length, sha256, resource,
    });
    digestPart(hash, `${resource.kind}:${document.relativePath}`, document.bytes);
  }
  graphValidate(sources, resources, options.validateBrain ?? (() => []));
  return deepFreeze({
    schemaVersion: 2 as const, bootstrapFile, configDir,
    digest: `sha256:${hash.digest('hex')}`, bootstrap: structuredClone(bootstrap),
    sources, resources, diagnostics,
  });
}

export function loadConfigResourceSnapshot(options: {
  bootstrapFile: string;
  limits?: Partial<ResourceLoaderLimits>;
  validateBrain?: BrainValidationHook;
  /** Deterministic fault injection for tests; production callers omit it. */
  testHooks?: LoaderTestHooks;
}): ConfigResourceSnapshot {
  const limits = { ...DEFAULT_RESOURCE_LOADER_LIMITS, ...(options.limits ?? {}) };
  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1
      || !Number.isSafeInteger(limits.maxAggregateBytes)
      || limits.maxAggregateBytes < limits.maxFileBytes)
    throw new ConfigResourceLoadError(options.bootstrapFile, '$', 'invalid loader byte limits');
  const bootstrapPath = resolve(options.bootstrapFile);
  const bootstrapRead = readBoundedStableFile(
    bootstrapPath, limits.maxFileBytes, Number.MAX_SAFE_INTEGER, options.testHooks);
  const bootstrap = parseBootstrap(bootstrapPath, bootstrapRead.bytes);
  const configuredDir = bootstrap.config_dir as string | undefined;
  const selectedDir = resolve(dirname(bootstrapPath), configuredDir ?? 'fleet.conf.d');
  assertNoSymlinkComponents(selectedDir, bootstrapPath, '$.config_dir');
  let configDir: string;
  let configDirStat: BigIntStats;
  try {
    configDir = realpathSync.native(selectedDir);
    configDirStat = lstatSync(configDir, { bigint: true });
  } catch (error) {
    throw new ConfigResourceLoadError(
      bootstrapPath, '$.config_dir', `cannot resolve selected config directory: ${fsReason(error)}`);
  }
  if (!configDirStat.isDirectory())
    throw new ConfigResourceLoadError(bootstrapPath, '$.config_dir', 'must resolve to a directory');

  let aggregate = bootstrapRead.bytes.length;
  if (aggregate > limits.maxAggregateBytes)
    throw new ConfigResourceLoadError(bootstrapPath, '$', 'aggregate byte limit exceeded');
  const diagnostics: LoaderDiagnostic[] = [];
  const sources: ConfigResourceSource[] = [];
  const resources: Partial<Record<ResourceKind, Record<string, TypedResource>>> = {};
  const hash = createHash('sha256');
  digestPart(hash, 'bootstrap', bootstrapRead.bytes);

  for (const [directoryName, expectedKind] of Object.entries(DIRECTORY_KIND)) {
    const directory = join(configDir, directoryName);
    let directoryStat: ReturnType<typeof lstatSync>;
    try { directoryStat = lstatSync(directory, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ConfigResourceLoadError(directory, '$', `cannot inspect typed directory: ${fsReason(error)}`);
    }
    if (directoryStat.isSymbolicLink())
      throw new ConfigResourceLoadError(directory, '$', 'typed directory must not be a symlink');
    if (!directoryStat.isDirectory())
      throw new ConfigResourceLoadError(directory, '$', 'typed directory must be a directory');
    assertNoSymlinkComponents(directory, directory);
    options.testHooks?.beforeReadDirectory?.(directory);
    let entries: Buffer[];
    try { entries = readdirSync(directory, { encoding: 'buffer' }).sort(Buffer.compare); }
    catch (error) {
      throw new ConfigResourceLoadError(directory, '$', `cannot read typed directory: ${fsReason(error)}`);
    }
    for (const rawName of entries) {
      const entryName = rawName.toString('utf8');
      if (!Buffer.from(entryName, 'utf8').equals(rawName))
        throw new ConfigResourceLoadError(directory, '$', 'entry basename must be valid UTF-8');
      const candidate = join(directory, entryName);
      let entry: BigIntStats;
      try { entry = lstatSync(candidate, { bigint: true }); }
      catch (error) {
        throw new ConfigResourceLoadError(candidate, '$', `cannot inspect discovered entry: ${fsReason(error)}`);
      }
      if (entry.isSymbolicLink())
        throw new ConfigResourceLoadError(candidate, '$', 'symlink entries are forbidden');
      const yaml = entryName.endsWith('.yaml') || entryName.endsWith('.yml');
      if (!yaml) {
        diagnostics.push({
          severity: 'warning', code: 'ignored_entry', sourceFile: candidate,
          message: 'ignored non-YAML entry in typed directory',
        });
        continue;
      }
      if (!entry.isFile())
        throw new ConfigResourceLoadError(candidate, '$', 'YAML candidate must be a regular file');
      const read = readBoundedStableFile(
        candidate, limits.maxFileBytes, limits.maxAggregateBytes - aggregate, options.testHooks);
      if (!sameIdentity(identityOf(entry), read.identity))
        throw new ConfigResourceLoadError(candidate, '$', 'discovered file identity changed before reading');
      let canonical: string;
      let canonicalStat: BigIntStats;
      try {
        // Canonicalize the already-validated parent only: resolving the leaf would
        // follow a symlink installed after discovery and change which path we attest.
        canonical = join(realpathSync.native(directory), entryName);
        canonicalStat = lstatSync(canonical, { bigint: true });
      } catch (error) {
        throw new ConfigResourceLoadError(candidate, '$', `cannot verify canonical candidate: ${fsReason(error)}`);
      }
      if (!isWithin(canonical, configDir))
        throw new ConfigResourceLoadError(candidate, '$', 'candidate escapes selected config directory');
      if (canonicalStat.dev !== read.identity.dev || canonicalStat.ino !== read.identity.ino
          || canonicalStat.size !== read.identity.size || canonicalStat.mtimeNs !== read.identity.mtimeNs)
        throw new ConfigResourceLoadError(candidate, '$', 'file identity changed before canonical verification');
      aggregate += read.bytes.length;
      try { parseFleetDocument(canonical, read.bytes.toString('utf8'), 'strict'); }
      catch (error) {
        throw new ConfigResourceLoadError(canonical, '$', error instanceof Error ? error.message : String(error));
      }
      let resource: TypedResource;
      try { resource = parseTypedResource(canonical, read.bytes.toString('utf8')); }
      catch (error) {
        if (error instanceof ResourceValidationError) throw error;
        throw new ConfigResourceLoadError(canonical, '$', error instanceof Error ? error.message : String(error));
      }
      if (resource.kind !== expectedKind)
        throw new ConfigResourceLoadError(
          canonical, '$.kind', `directory ${directoryName} requires kind ${expectedKind}`);
      const byKind = resources[resource.kind] ??= Object.create(null) as Record<string, TypedResource>;
      if (Object.hasOwn(byKind, resource.id))
        throw new ConfigResourceLoadError(
          canonical, '$.id', `duplicate ${resource.kind} id '${resource.id}'`);
      byKind[resource.id] = resource;
      const relativePath = relative(configDir, canonical).split(sep).join('/');
      const sha256 = createHash('sha256').update(read.bytes).digest('hex');
      sources.push({
        kind: resource.kind, id: resource.id, sourceFile: canonical, relativePath,
        size: read.bytes.length, sha256, resource,
      });
      digestPart(hash, `${resource.kind}:${relativePath}`, read.bytes);
    }
  }

  graphValidate(sources, resources, options.validateBrain ?? (() => []));
  return deepFreeze({
    schemaVersion: 2 as const, bootstrapFile: bootstrapPath, configDir,
    digest: `sha256:${hash.digest('hex')}`, bootstrap: structuredClone(bootstrap),
    sources, resources, diagnostics,
  });
}
