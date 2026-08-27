import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import type { AcpMcpServer } from './types.js';
import { replaceFileAtomically, type WriteDeps } from '../atomic-file.js';

const MAX_STRING = 4096;
const MAX_OVERLAY = 1024 * 1024;
const MAX_ARRAY = 128;
const MAX_KEYS = 128;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/u;

export type LegacyAcpAdapterOptions =
  | Readonly<{ harness: 'codex'; launcher: 'auto' | 'ours-codex' | 'codex'; profile?: string;
      search: boolean; addDirs: readonly string[]; config: Readonly<Record<string, unknown>> }>
  | Readonly<{ harness: 'claude-code'; plugins: Readonly<Record<string, boolean>>; memPalace: boolean;
      memPalaceMidSessionAutosave: boolean; mcpServers?: Readonly<Record<string, unknown>>;
      mcpServersOnly: boolean }>;

export interface LegacyAcpAttemptInput {
  schemaVersion: 1;
  roleName: string;
  harness: 'codex' | 'claude-code';
  model?: string;
  effort?: string;
  identityName: string;
  lifetime: 'temporary' | 'persistent';
  permissions: Readonly<{ approval: string; filesystem: string; unattended: string }>;
  nativePermissions: Readonly<{
    approvalMode: string; filesystemMode: string; unattendedMode: string; exact: boolean;
  }>;
  acpCommand?: string | readonly string[];
  isolationRequested: boolean;
  scheduling: Readonly<{ autocompactPct?: number }>;
  adapterOptions: LegacyAcpAdapterOptions;
  integrityDigest: string;
}

export interface LegacyAcpRuntimeContext {
  stateDir: string;
  runCwd: string;
  /** Secret-bearing, process-local input. Never canonicalized or persisted. */
  baseEnv: Readonly<Record<string, string>>;
  sessionMode: 'fresh' | 'resume';
  sessionId: string;
}

export interface LegacyAcpPureTranslation {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  modeId?: string;
  mcpServers?: readonly AcpMcpServer[];
  sessionMeta?: Readonly<Record<string, unknown>>;
  permissionMetadataSource?: 'codex-acp';
  files?: readonly Readonly<{ name: string; contents: string; mode?: number }> [];
}

export interface LegacyAcpArtifact {
  adapterId: string;
  adapterVersion: string;
  artifactDigest: string;
}

const preparedBrand: unique symbol = Symbol('legacy ACP prepared attempt');
export interface LegacyPreparedAcpAttempt { readonly [preparedBrand]: true }
export interface AuthenticatedLegacyPreparedAcpAttempt extends LegacyAcpArtifact {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly modeId?: string;
  readonly mcpServers?: readonly AcpMcpServer[];
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  readonly permissionMetadataSource?: 'codex-acp';
  readonly hostEffect: 'none' | 'pretrust_applied';
  readonly integrityDigest: string;
}

type PublicRuntime = Readonly<Omit<LegacyAcpRuntimeContext, 'baseEnv'>>;
export interface LegacyAcpCallbacks {
  translate(input: Readonly<LegacyAcpAttemptInput>, context: PublicRuntime): LegacyAcpPureTranslation;
  probe(translation: Readonly<LegacyAcpPureTranslation>): Promise<LegacyAcpArtifact>;
  /** false means the host effect may have happened, so no evidence may be issued. */
  pretrust?(context: PublicRuntime): Promise<boolean | void>;
}

function canonical(value: unknown, seen = new Set<object>(), maxString = MAX_STRING): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxString || /\0/u.test(value)) throw new TypeError('ACP data string exceeds bounds');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('ACP data number must be finite');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))
    throw new TypeError('ACP data must contain only plain JSON values');
  if (seen.has(value)) throw new TypeError('ACP data must not contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) throw new TypeError('ACP data array exceeds bounds');
      return `[${value.map(child => canonical(child, seen, maxString)).join(',')}]`;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_KEYS || keys.some(key => typeof key !== 'string'))
      throw new TypeError('ACP data object exceeds bounds');
    return `{${(keys as string[]).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)
          || descriptor.value === undefined) throw new TypeError('ACP data must contain only enumerable data properties');
      return `${JSON.stringify(key)}:${canonical(descriptor.value, seen, maxString)}`;
    }).join(',')}}`;
  } finally { seen.delete(value); }
}

const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const own = <T>(value: T): T => JSON.parse(canonical(value)) as T;
function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function exact(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError(`${name} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)))
    throw new TypeError(`${name} has invalid keys`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)
        || descriptor.value === undefined) throw new TypeError(`${name} must contain only data properties`);
  }
  return value as Record<string, unknown>;
}

const withoutDigest = (input: LegacyAcpAttemptInput): Omit<LegacyAcpAttemptInput, 'integrityDigest'> => {
  const { integrityDigest: _, ...value } = input;
  return value;
};

export function legacyAcpIntegrityDigest(input: Omit<LegacyAcpAttemptInput, 'integrityDigest'>): string {
  validateInputShape(input, false);
  return digest(input);
}

function validateInputShape(input: unknown, withDigest: boolean): asserts input is LegacyAcpAttemptInput {
  const root = exact(input, 'legacy ACP attempt', [
    'schemaVersion', 'roleName', 'harness',
    ...((input as LegacyAcpAttemptInput)?.model === undefined ? [] : ['model']),
    ...((input as LegacyAcpAttemptInput)?.effort === undefined ? [] : ['effort']),
    'identityName', 'lifetime', 'permissions', 'nativePermissions',
    ...((input as LegacyAcpAttemptInput)?.acpCommand === undefined ? [] : ['acpCommand']),
    'isolationRequested', 'scheduling', 'adapterOptions', ...(withDigest ? ['integrityDigest'] : []),
  ]);
  if (root.schemaVersion !== 1 || typeof root.roleName !== 'string' || !TOKEN.test(root.roleName)
      || typeof root.harness !== 'string' || !['codex', 'claude-code'].includes(root.harness)
      || typeof root.identityName !== 'string' || !root.identityName.length
      || Buffer.byteLength(root.identityName) > MAX_STRING || /[\0\r\n]/u.test(root.identityName)
      || typeof root.lifetime !== 'string' || !['temporary', 'persistent'].includes(root.lifetime)
      || typeof root.isolationRequested !== 'boolean') throw new TypeError('invalid legacy ACP attempt');
  for (const key of ['model', 'effort'] as const)
    if (root[key] !== undefined && (typeof root[key] !== 'string' || !TOKEN.test(root[key] as string)))
      throw new TypeError(`legacy ACP ${key} is invalid`);
  const permissions = exact(root.permissions, 'legacy ACP permissions', ['approval', 'filesystem', 'unattended']);
  if (typeof permissions.approval !== 'string' || !['ask', 'auto', 'allow', 'deny'].includes(permissions.approval)
      || typeof permissions.filesystem !== 'string'
      || !['read-only', 'workspace', 'unrestricted'].includes(permissions.filesystem)
      || typeof permissions.unattended !== 'string' || !['deny', 'wait'].includes(permissions.unattended))
    throw new TypeError('invalid legacy ACP permissions');
  const native = exact(root.nativePermissions, 'legacy ACP nativePermissions', [
    'approvalMode', 'filesystemMode', 'unattendedMode', 'exact',
  ]);
  if (typeof native.approvalMode !== 'string' || !TOKEN.test(native.approvalMode)
      || typeof native.filesystemMode !== 'string' || !TOKEN.test(native.filesystemMode)
      || typeof native.unattendedMode !== 'string' || !['deny', 'wait'].includes(native.unattendedMode)
      || typeof native.exact !== 'boolean') throw new TypeError('invalid legacy ACP nativePermissions');
  const scheduling = exact(root.scheduling, 'legacy ACP scheduling',
    (root.scheduling as { autocompactPct?: number }).autocompactPct === undefined ? [] : ['autocompactPct']);
  if (scheduling.autocompactPct !== undefined && (typeof scheduling.autocompactPct !== 'number'
      || !Number.isInteger(scheduling.autocompactPct) || scheduling.autocompactPct < 1
      || scheduling.autocompactPct > 100)) throw new TypeError('invalid legacy ACP scheduling');
  const options = root.adapterOptions as LegacyAcpAdapterOptions;
  if (options?.harness !== root.harness) throw new TypeError('legacy ACP adapter options do not match harness');
  if (options.harness === 'codex') {
    exact(options, 'legacy Codex ACP options', [
      'harness', 'launcher', ...(options.profile === undefined ? [] : ['profile']),
      'search', 'addDirs', 'config',
    ]);
    if (!['auto', 'ours-codex', 'codex'].includes(options.launcher)
        || options.profile !== undefined && (typeof options.profile !== 'string' || !TOKEN.test(options.profile))
        || typeof options.search !== 'boolean' || !Array.isArray(options.addDirs)
        || options.addDirs.length > MAX_ARRAY || options.addDirs.some(value => typeof value !== 'string'
          || !value.length || Buffer.byteLength(value) > MAX_STRING || /\0/u.test(value))
        || !options.config || typeof options.config !== 'object' || Array.isArray(options.config)
        || Object.getPrototypeOf(options.config) !== Object.prototype)
      throw new TypeError('invalid legacy Codex ACP options');
    for (const value of Object.values(options.config)) {
      const scalar = (child: unknown) => typeof child === 'string' || typeof child === 'boolean'
        || typeof child === 'number' && Number.isFinite(child);
      if (!scalar(value) && (!Array.isArray(value) || value.length > MAX_ARRAY || !value.every(scalar)))
        throw new TypeError('invalid legacy Codex ACP config');
    }
  } else {
    exact(options, 'legacy Claude ACP options', [
      'harness', 'plugins', 'memPalace', 'memPalaceMidSessionAutosave',
      ...(options.mcpServers === undefined ? [] : ['mcpServers']), 'mcpServersOnly',
    ]);
    if (!options.plugins || typeof options.plugins !== 'object' || Array.isArray(options.plugins)
        || Object.getPrototypeOf(options.plugins) !== Object.prototype
        || Object.entries(options.plugins).some(([key, value]) => !TOKEN.test(key) || typeof value !== 'boolean')
        || typeof options.memPalace !== 'boolean' || typeof options.memPalaceMidSessionAutosave !== 'boolean'
        || typeof options.mcpServersOnly !== 'boolean') throw new TypeError('invalid legacy Claude ACP options');
    if (options.mcpServers !== undefined) validateMcpServerMap(options.mcpServers);
  }
  if (root.acpCommand !== undefined && typeof root.acpCommand !== 'string'
      && (!Array.isArray(root.acpCommand) || !root.acpCommand.length || root.acpCommand.length > 64
        || root.acpCommand.some(value => typeof value !== 'string' || !value.length
          || Buffer.byteLength(value) > MAX_STRING || /[\0\r\n]/u.test(value)))) throw new TypeError('invalid ACP command');
  if (typeof root.acpCommand === 'string' && (!root.acpCommand.length
      || Buffer.byteLength(root.acpCommand) > MAX_STRING || /\0/u.test(root.acpCommand)))
    throw new TypeError('invalid ACP command');
  canonical(input);
  if (withDigest && (typeof root.integrityDigest !== 'string' || !SHA.test(root.integrityDigest)
      || digest(withoutDigest(input as LegacyAcpAttemptInput)) !== root.integrityDigest))
    throw new TypeError('legacy ACP integrity digest is invalid');
}

function validateMcpServerMap(value: Readonly<Record<string, unknown>>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length > MAX_KEYS)
    throw new TypeError('invalid legacy Claude MCP servers');
  for (const [name, raw] of Object.entries(value)) {
    if (!TOKEN.test(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.getPrototypeOf(raw) !== Object.prototype) throw new TypeError('invalid legacy Claude MCP server');
    const server = raw as Record<string, unknown>;
    const remote = server.type === 'http' || server.type === 'sse';
    const allowed = remote ? ['type', 'url', 'headers'] : ['command', 'args', 'env'];
    if (Object.keys(server).some(key => !allowed.includes(key))) throw new TypeError('invalid legacy Claude MCP server keys');
    if (remote) {
      if (typeof server.url !== 'string' || !server.url.length) throw new TypeError('invalid legacy Claude MCP URL');
    } else if (typeof server.command !== 'string' || !server.command.length
        || server.args !== undefined && (!Array.isArray(server.args)
          || server.args.some(arg => typeof arg !== 'string'))) throw new TypeError('invalid legacy Claude MCP command');
    const pairs = remote ? server.headers : server.env;
    if (pairs !== undefined && (!pairs || typeof pairs !== 'object' || Array.isArray(pairs)
        || Object.values(pairs).some(child => typeof child !== 'string')))
      throw new TypeError('invalid legacy Claude MCP values');
  }
}

function validateRuntime(context: LegacyAcpRuntimeContext): void {
  exact(context, 'legacy ACP runtime context', ['stateDir', 'runCwd', 'baseEnv', 'sessionMode', 'sessionId']);
  if (!isAbsolute(context.stateDir) || !isAbsolute(context.runCwd)
      || !['fresh', 'resume'].includes(context.sessionMode)
      || typeof context.sessionId !== 'string' || !TOKEN.test(context.sessionId))
    throw new TypeError('invalid legacy ACP runtime context');
  exact(context.baseEnv, 'legacy ACP baseEnv', Object.keys(context.baseEnv));
  for (const [key, value] of Object.entries(context.baseEnv))
    if (!TOKEN.test(key) || typeof value !== 'string' || /\0/u.test(value)) throw new TypeError('invalid legacy ACP baseEnv');
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateTranslation(value: LegacyAcpPureTranslation, stateDir: string): LegacyAcpPureTranslation {
  exact(value, 'legacy ACP translation', [
    'argv', 'env', ...(value.modeId === undefined ? [] : ['modeId']),
    ...(value.mcpServers === undefined ? [] : ['mcpServers']),
    ...(value.sessionMeta === undefined ? [] : ['sessionMeta']),
    ...(value.permissionMetadataSource === undefined ? [] : ['permissionMetadataSource']),
    ...(value.files === undefined ? [] : ['files']),
  ]);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.length > 64
      || value.argv.some(arg => typeof arg !== 'string' || !arg.length || Buffer.byteLength(arg) > MAX_STRING || /[\0\r\n]/u.test(arg)))
    throw new TypeError('invalid legacy ACP argv');
  exact(value.env, 'legacy ACP env', Object.keys(value.env));
  for (const [key, child] of Object.entries(value.env))
    if (!TOKEN.test(key) || typeof child !== 'string' || Buffer.byteLength(child) > MAX_STRING
        || /\0/u.test(child)) throw new TypeError('invalid legacy ACP env');
  if (value.modeId !== undefined && (typeof value.modeId !== 'string' || !TOKEN.test(value.modeId)))
    throw new TypeError('invalid legacy ACP mode');
  if (value.permissionMetadataSource !== undefined && value.permissionMetadataSource !== 'codex-acp')
    throw new TypeError('invalid legacy ACP permission metadata source');
  if (value.mcpServers !== undefined) validateTranslatedMcpServers(value.mcpServers);
  if (value.sessionMeta !== undefined) canonical(value.sessionMeta);
  const names = new Set<string>();
  for (const file of value.files ?? []) {
    exact(file, 'legacy ACP overlay', ['name', 'contents', ...(file.mode === undefined ? [] : ['mode'])]);
    if (typeof file.name !== 'string' || !file.name || Buffer.byteLength(file.name) > MAX_STRING
        || /[\0\r\n]/u.test(file.name) || isAbsolute(file.name) || normalize(file.name) !== file.name
        || file.name.split(/[\\/]/u).includes('..') || file.name.includes(sep) || names.has(file.name)
        || typeof file.contents !== 'string' || Buffer.byteLength(file.contents) > MAX_OVERLAY
        || (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0o600 || file.mode > 0o700)))
      throw new TypeError('invalid legacy ACP overlay');
    names.add(file.name);
    const target = join(stateDir, file.name);
    if (!target.startsWith(`${stateDir}${sep}`)) throw new TypeError('legacy ACP overlay escapes stateDir');
  }
  const { files, ...withoutFiles } = value;
  canonical(withoutFiles);
  canonical(files ?? [], new Set<object>(), MAX_OVERLAY);
  return deepFreeze(value);
}

function validateTranslatedMcpServers(servers: readonly AcpMcpServer[]): void {
  if (!Array.isArray(servers) || servers.length > MAX_ARRAY)
    throw new TypeError('invalid translated ACP MCP servers');
  for (const raw of servers) {
    const server = raw as unknown as Record<string, unknown>;
    const remote = server.type === 'http' || server.type === 'sse';
    exact(server, 'translated ACP MCP server', remote
      ? ['name', 'type', 'url', 'headers'] : ['name', 'command', 'args', 'env']);
    if (typeof server.name !== 'string' || !TOKEN.test(server.name))
      throw new TypeError('invalid translated ACP MCP server name');
    if (remote) {
      if (typeof server.url !== 'string' || !server.url.length) throw new TypeError('invalid translated ACP MCP URL');
    } else if (typeof server.command !== 'string' || !server.command.length
        || !Array.isArray(server.args) || server.args.some(value => typeof value !== 'string'))
      throw new TypeError('invalid translated ACP MCP command');
    const pairs = (remote ? server.headers : server.env) as unknown;
    if (!Array.isArray(pairs) || pairs.length > MAX_ARRAY) throw new TypeError('invalid translated ACP MCP values');
    for (const pair of pairs) {
      const fields = exact(pair, 'translated ACP MCP value', ['name', 'value']);
      if (typeof fields.name !== 'string' || !TOKEN.test(fields.name)
          || typeof fields.value !== 'string' || Buffer.byteLength(fields.value) > MAX_STRING || /\0/u.test(fields.value))
        throw new TypeError('invalid translated ACP MCP value');
    }
  }
}

interface Issued {
  adapter: object;
  input: LegacyAcpAttemptInput;
  context: Readonly<Omit<LegacyAcpRuntimeContext, 'baseEnv'>>;
  baseEnvRef: LegacyAcpRuntimeContext['baseEnv'];
  baseEnvOwned: Readonly<Record<string, string>>;
  artifact: LegacyAcpArtifact;
  value: AuthenticatedLegacyPreparedAcpAttempt;
}

/** Instance-owned, process-local authority. Its opaque evidence is deliberately not serializable. */
export class LegacyAcpPreparationAuthority {
  readonly #issued = new WeakMap<object, Issued>();
  constructor(
    private readonly adapter: object,
    private readonly callbacks: LegacyAcpCallbacks,
    private readonly writes: WriteDeps = {},
  ) {}

  async prepare(input: LegacyAcpAttemptInput, context: LegacyAcpRuntimeContext): Promise<LegacyPreparedAcpAttempt> {
    validateInputShape(input, true);
    validateRuntime(context);
    const ownedInput = Object.freeze(own(input));
    const baseEnvOwned = Object.freeze({ ...context.baseEnv });
    const publicRuntime = Object.freeze({
      stateDir: context.stateDir, runCwd: context.runCwd,
      sessionMode: context.sessionMode, sessionId: context.sessionId,
    });
    // All validation and byte construction is complete before probe or publication.
    const translated = validateTranslation(this.callbacks.translate(ownedInput, publicRuntime), context.stateDir);
    const artifact = Object.freeze(own(await this.callbacks.probe(translated)));
    exact(artifact, 'legacy ACP artifact', ['adapterId', 'adapterVersion', 'artifactDigest']);
    if (typeof artifact.adapterId !== 'string' || !TOKEN.test(artifact.adapterId)
        || typeof artifact.adapterVersion !== 'string' || !TOKEN.test(artifact.adapterVersion)
        || typeof artifact.artifactDigest !== 'string' || !SHA.test(artifact.artifactDigest))
      throw new TypeError('invalid legacy ACP artifact');
    for (const file of translated.files ?? [])
      {
        const target = join(context.stateDir, file.name);
        if (isSymlink(context.stateDir) || isSymlink(target))
          throw new TypeError('legacy ACP overlay symlinks are forbidden');
        replaceFileAtomically(target, file.contents, file.mode ?? 0o600, this.writes);
      }
    if (this.callbacks.pretrust && await this.callbacks.pretrust(publicRuntime) === false)
      throw new Error('legacy ACP pretrust outcome is uncertain');
    const mergedEnv = { ...baseEnvOwned, ...translated.env };
    if (ownedInput.harness === 'codex' && translated.env.CODEX_PATH && baseEnvOwned.CODEX_PATH)
      mergedEnv.OURS_FLEET_REAL_CODEX_PATH = baseEnvOwned.CODEX_PATH;
    const value = Object.freeze({
      argv: translated.argv, env: Object.freeze(mergedEnv),
      ...(translated.modeId === undefined ? {} : { modeId: translated.modeId }),
      ...(translated.mcpServers === undefined ? {} : { mcpServers: translated.mcpServers }),
      ...(translated.sessionMeta === undefined ? {} : { sessionMeta: translated.sessionMeta }),
      ...(translated.permissionMetadataSource === undefined ? {} : {
        permissionMetadataSource: translated.permissionMetadataSource,
      }),
      ...artifact, hostEffect: this.callbacks.pretrust ? 'pretrust_applied' as const : 'none' as const,
      integrityDigest: ownedInput.integrityDigest,
    });
    const evidence = Object.freeze({ [preparedBrand]: true as const });
    this.#issued.set(evidence, {
      adapter: this.adapter, input: ownedInput, context: publicRuntime,
      baseEnvRef: context.baseEnv, baseEnvOwned, artifact, value,
    });
    return evidence;
  }

  authenticate(
    adapter: object, evidence: LegacyPreparedAcpAttempt, input: LegacyAcpAttemptInput,
    context: LegacyAcpRuntimeContext,
  ): AuthenticatedLegacyPreparedAcpAttempt | undefined {
    const issued = this.#issued.get(evidence as object);
    if (!issued || adapter !== this.adapter || issued.adapter !== adapter) return undefined;
    try { validateInputShape(input, true); validateRuntime(context); } catch { return undefined; }
    if (canonical(input) !== canonical(issued.input) || input.integrityDigest !== issued.input.integrityDigest
        || context.baseEnv !== issued.baseEnvRef || canonical(context.baseEnv) !== canonical(issued.baseEnvOwned)
        || context.stateDir !== issued.context.stateDir || context.runCwd !== issued.context.runCwd
        || context.sessionMode !== issued.context.sessionMode || context.sessionId !== issued.context.sessionId) return undefined;
    return issued.value;
  }
}

export const authenticatePrepared = (
  authority: LegacyAcpPreparationAuthority, adapter: object, evidence: LegacyPreparedAcpAttempt,
  input: LegacyAcpAttemptInput, context: LegacyAcpRuntimeContext,
): AuthenticatedLegacyPreparedAcpAttempt | undefined => authority.authenticate(adapter, evidence, input, context);

// Phase-5 deletion gate: LegacyAcpAttemptInput, prepareAcpLegacy, and the runner bridge must be
// deleted together when every ACP start consumes recorded AgentPlan/reservation evidence.
