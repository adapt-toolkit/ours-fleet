import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { agentDir, defaultConfigPath, fleetDDir, home } from './paths.js';
import {
  parseFleetDocument, type ConfigDiagnostic, type YamlMode,
} from './config-yaml.js';
import {
  harnessRuntimeDir, resolveIsolation, validateIsolationConfig,
} from './isolation/policy.js';
import { getAdapter } from './harness/registry.js';
import { resolveRoleModelEnv } from './model-env.js';
import type { IsolationConfig, WrapContext } from './isolation/types.js';
import { resolveWatchdogs } from './watchdog/config.js';
import type { ResolvedWatchdog } from './watchdog/config.js';
import { resolveLoops } from './loops/config.js';
import type { ResolvedLoop, ResolvedRoleLoop } from './loops/config.js';
import {
  validateRoomsConfig, validateTasksConfig, validateRoomTemplatesConfig,
} from './rooms-tasks/config.js';
import type { RoomsConfig, RoomTemplatesConfig, TasksConfig } from './rooms-tasks/types.js';
import { CAPABILITIES, CAP_MONITOR_INTERRUPT_AFTER_TOOL } from './capabilities.js';
import { runningLabel } from './provenance.js';
import { parseDuration } from './duration.js';

export interface OverseeEntry { agent: string; interval: string }
export interface WorklogPolicy {
  max_kb: number;
  keep_tail_kb: number;
  max_archives: number;
}
export type WorklogPolicyInput = Partial<WorklogPolicy> | false;
/** Conservative built-in policy; `worklog: false` is the explicit opt-out. */
export const DEFAULT_WORKLOG_POLICY: Readonly<WorklogPolicy> = Object.freeze({
  max_kb: 1024,
  keep_tail_kb: 256,
  max_archives: 12,
});
export interface AuthProxyConfig {
  kind: 'anthropic';
  base_url: string;
  required: boolean;
  health_url: string;
}

/** The 8 content-free event types the ours daemon appends to notifications.log. */
export const NOTIFY_EVENT_TYPES = [
  'message_received', 'file_received', 'sibling_contact_added', 'local_contact_request',
  'pending_message', 'contact_restored', 'inbound_error', 'state_import_failed',
] as const;
export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number];
export type InjectMode = 'notification' | 'full';
export type MonitorMode = 'fleet' | 'native';
export type SessionBackendId = 'acp';
/** Public, harness-neutral permission policy. */
export type FleetPermissionMode = 'ask' | 'auto' | 'allow';
/** `deny` is a deprecated, fail-closed compatibility alias retained for old fleet files. */
export type ApprovalMode = FleetPermissionMode | 'deny';
export type FilesystemMode = 'read-only' | 'workspace' | 'unrestricted';
export type UnattendedMode = 'deny' | 'wait';
/** Monitor wake policy: preserve legacy booleans and add one explicit safe boundary. */
export type MonitorInterrupt = boolean | 'after_tool';

export interface CommonPermissions {
  approval: ApprovalMode;
  filesystem: FilesystemMode;
  unattended: UnattendedMode;
}

export interface SessionOptions {
  acp?: {
    /** ACP agent command and arguments. Defaults are supplied by the harness adapter. */
    command?: string | string[];
  };
}

/** Resolved per-role supervisor-monitor config. */
export interface MonitorConfig {
  /** Who owns mail wake delivery: ours-fleet supervisor or the native harness. */
  mode: MonitorMode;
  /** @deprecated Legacy alias retained in resolved snapshots; use mode. */
  enabled: boolean;
  wake_sources: string[];
  batch_ms: number;
  inject: InjectMode;
  /** Immediate cancel, ordinary non-cancelling delivery, or ACP tool-boundary steering. */
  interrupt: MonitorInterrupt;
  /**
   * Consecutive delivered wakes that must end in an `API Error:`-terminated turn
   * (with no completed turn in between) before `.monitor-status` degrades to
   * `turns failing (api error)` — the refusal-wedge detector (issue #19). Must be
   * a positive integer; resolved default is 3. Optional so old snapshots resolve.
   */
  turn_fail_threshold?: number;
}

/** A trusted, fleet-owned ours mailbox which is never bound inside the agent. */
export interface OwnerChannelConfig {
  /** Existing ours identity exclusively bound by the fleet supervisor. */
  identity: string;
  /** Authenticated ours contact IDs allowed to issue owner instructions. */
  owners: string[];
  /** Exact managed-agent CID whose messages may be relayed outward. */
  agent?: string;
  /** Cancel active work before each owner request instead of queueing it. */
  interrupt: boolean;
  /** Deterministic in-progress notice interval; 0 disables progress notices. */
  progress_interval_ms: number;
  /**
   * Relay the agent's live ACP commentary to the owner while a turn runs.
   * This is the RESTART BASELINE only: `/comments on|off` changes the running
   * session's effective value, and a restart returns to this one.
   */
  comments: boolean;
  attachments: OwnerAttachmentConfig;
}

export interface OwnerAttachmentConfig {
  enabled: boolean;
  max_files_per_request: number;
  max_file_bytes: number;
  max_request_bytes: number;
  retention_ms: number;
}

type OwnerAttachmentConfigInput = Partial<OwnerAttachmentConfig> & {
  /** @deprecated Accepted only so existing configs keep loading; ignored. */
  allowed_mime?: unknown;
};

export type OwnerChannelConfigInput = Omit<Partial<OwnerChannelConfig>, 'attachments'> & {
  attachments?: OwnerAttachmentConfigInput;
};

/** Default wake sources when a role does not list its own. */
export const DEFAULT_WAKE_SOURCES: NotifyEventType[] =
  ['message_received', 'file_received', 'local_contact_request', 'pending_message'];
const MONITOR_KEYS = [
  'mode', 'enabled', 'wake_sources', 'batch_ms', 'inject', 'interrupt', 'turn_fail_threshold',
];
const INJECT_MODES: InjectMode[] = ['notification', 'full'];
const MONITOR_MODES: MonitorMode[] = ['fleet', 'native'];
const MONITOR_DEFAULT_BATCH_MS = 2000;
const MONITOR_DEFAULT_TURN_FAIL_THRESHOLD = 3;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a raw (role-level or merged) `monitor:` block; returns human-readable problems.
 *
 * `capabilities` defaults to what this build declares. A value is rejected in two
 * distinct ways: unknown to every build (a typo), or known but absent from the
 * artifact doing the validating — the second names the capability and the build,
 * because the same fleet.yaml may well be accepted by another install on the host.
 */
export function validateMonitorConfig(
  raw: unknown,
  capabilities: readonly string[] = CAPABILITIES,
): string[] {
  const problems: string[] = [];
  if (!isPlainObject(raw)) return ['monitor: must be a mapping'];
  const m = raw;
  const bad = Object.keys(m).filter(k => !MONITOR_KEYS.includes(k));
  if (bad.length)
    problems.push(`monitor: unknown key(s) ${bad.join(', ')}; allowed: ${MONITOR_KEYS.join(', ')}`);
  if (m.enabled !== undefined && typeof m.enabled !== 'boolean')
    problems.push('monitor.enabled: must be true or false');
  if (m.mode !== undefined && !MONITOR_MODES.includes(m.mode as MonitorMode))
    problems.push(`monitor.mode: invalid value '${m.mode}'; allowed: ${MONITOR_MODES.join(', ')}`);
  if (m.mode !== undefined && typeof m.enabled === 'boolean'
      && m.enabled !== (m.mode === 'fleet'))
    problems.push(`monitor.mode '${m.mode}' conflicts with legacy monitor.enabled ${m.enabled}`);
  if (m.batch_ms !== undefined
      && (typeof m.batch_ms !== 'number' || !Number.isFinite(m.batch_ms) || m.batch_ms < 0))
    problems.push('monitor.batch_ms: must be a non-negative number');
  if (m.inject !== undefined && !INJECT_MODES.includes(m.inject as InjectMode))
    problems.push(`monitor.inject: invalid value '${m.inject}'; allowed: ${INJECT_MODES.join(', ')}`);
  if (m.interrupt !== undefined
      && typeof m.interrupt !== 'boolean' && m.interrupt !== 'after_tool')
    problems.push("monitor.interrupt: must be true, false, or 'after_tool'");
  else if (m.interrupt === 'after_tool' && !capabilities.includes(CAP_MONITOR_INTERRUPT_AFTER_TOOL))
    problems.push(
      `monitor.interrupt: 'after_tool' needs capability ${CAP_MONITOR_INTERRUPT_AFTER_TOOL}, `
      + `which the build validating this config (${runningLabel()}) does not declare. `
      + 'Another install on this host may accept the same file — run `ours-fleet doctor` '
      + 'to see which artifact serves which path.');
  if (m.turn_fail_threshold !== undefined
      && (typeof m.turn_fail_threshold !== 'number' || !Number.isInteger(m.turn_fail_threshold)
          || m.turn_fail_threshold < 1))
    problems.push('monitor.turn_fail_threshold: must be a positive integer');
  if (m.wake_sources !== undefined) {
    if (!Array.isArray(m.wake_sources)) problems.push('monitor.wake_sources: must be a list');
    else {
      const unknown = m.wake_sources.filter(w => !NOTIFY_EVENT_TYPES.includes(w as NotifyEventType));
      if (unknown.length)
        problems.push(
          `monitor.wake_sources: unknown source(s) ${unknown.join(', ')}; ` +
          `allowed: ${NOTIFY_EVENT_TYPES.join(', ')}`);
    }
  }
  return problems;
}

export interface RoleConfig {
  harness?: string;
  session?: SessionBackendId;
  session_options?: SessionOptions;
  permissions?: Partial<CommonPermissions>;
  identity?: string;
  cwd?: string;
  coordinator?: string;
  mission?: string;
  persona?: string;
  bio?: string;
  briefing_file?: string;
  /** Explicit null means use the selected harness's own default, bypassing fleet defaults. */
  model?: string | null;
  /** Neutral Brain reasoning effort, retained for inspection after adapter translation. */
  effort?: string;
  model_chain?: string[];
  max_tokens?: number;
  autocompact_pct?: number;
  env?: Record<string, string>;
  oversee?: OverseeEntry[];
  harness_options?: Record<string, unknown>;
  isolation?: IsolationConfig;
  monitor?: Partial<MonitorConfig>;
  owner_channel?: OwnerChannelConfigInput;
  worklog?: WorklogPolicyInput;
  auth_proxy?: Partial<AuthProxyConfig>;
}

export type AgentSelection<T extends Record<string, unknown> = Record<string, unknown>> =
  | { ref: string }
  | { inline: T };

/** Canonical authoring contract shared by configured, spawned, and room agents. */
export interface AgentDefinition {
  role: AgentSelection;
  brain: AgentSelection;
  permissions?: Partial<CommonPermissions>;
  identity?: string;
  cwd?: string;
  coordinator?: string;
  env?: Record<string, string>;
  oversee?: OverseeEntry[];
  isolation?: IsolationConfig;
  monitor?: Partial<MonitorConfig>;
  owner_channel?: OwnerChannelConfigInput;
  worklog?: WorklogPolicyInput;
  auth_proxy?: Partial<AuthProxyConfig>;
}

/** Internal first-boot payload for a Fleet-provisioned Cowork room member. */
export interface RoomMemberStartup {
  room_id: string;
  room_identity_cid: string;
  identity_name: string;
  invite_id: string;
  invite: string;
  role: string;
  task: string;
  owner_seat_cid: string | null;
}

export interface ResolvedRole extends Omit<RoleConfig, 'model' | 'owner_channel' | 'worklog'> {
  name: string;
  harness: string;
  session: SessionBackendId;
  permissions: CommonPermissions;
  /**
   * Whether `permissions:` was actually written by the operator (on the role or
   * in defaults), as opposed to resolved from built-in defaults. A role that
   * states its intent only once — neutrally OR natively — has nothing to
   * contradict, and must not be warned at.
   */
  permissionsDeclared: boolean;
  identity: string;
  model?: string;
  sourceFile: string;
  monitor: MonitorConfig;
  owner_channel?: OwnerChannelConfig;
  worklog?: WorklogPolicy;
  auth_proxy?: AuthProxyConfig;
  loops?: ResolvedRoleLoop[];
  provenance?: Record<string, FieldProvenance>;
  /** Internal/transient: never accepted as a user-authored RoleConfig key. */
  roomMemberStartup?: RoomMemberStartup;
  /** Original unresolved selections only; denied operational fields never enter inheritance state. */
  agentSelections?: Pick<AgentDefinition, 'role' | 'brain'>;
}

export interface FieldProvenance {
  sourceFile: string;
  sourcePointer: string;
  sourceKind: 'Agent' | 'Role' | 'Brain' | 'Manifest' | 'built-in';
  sourceId?: string;
  origin: 'explicit' | 'typed-default' | 'built-in';
  viaReference?: { sourcePointer: string; kind: 'Role' | 'Brain'; id: string };
  transforms: Array<{ kind: 'substitution' | 'adapter-normalization' | 'validation-default'; detail: string }>;
}

export interface FleetConfig {
  roles: ResolvedRole[];
  /** Canonical, variable-resolved Agent authoring documents keyed by stable Agent ID. */
  agentDefinitions?: Record<string, AgentDefinition>;
  vars: Record<string, string>;
  defaults: Record<string, unknown>;
  files: string[];
  configMode?: 'split-v2';
  sourceDocuments?: Array<{ kind: 'Manifest' | 'Agent' | 'Role' | 'Brain' | 'RoomTemplate'; id?: string; path: string }>;
  /** Fleet-wide delay (ms) enforced between agent launches to avoid boot bursts (0 = none). */
  startStaggerMs: number;
  /** Warning-first non-plain YAML migration diagnostics, in source order. */
  diagnostics: ConfigDiagnostic[];
  watchdogs: ResolvedWatchdog[];
  loops: ResolvedLoop[];
  rooms?: import('./rooms-tasks/types.js').RoomsConfig;
  roomTemplates?: import('./rooms-tasks/types.js').RoomTemplatesConfig;
  tasks?: import('./rooms-tasks/types.js').TasksConfig;
  /** SHA-256 fingerprint of the resolved owner invite (never the invite itself). */
  ownerInviteFingerprint?: string;
  /**
   * Resolved owner invite for immediate private-IPC use only. This property is
   * deliberately non-enumerable so config dumps and JSON output cannot expose
   * the bearer credential.
   */
  ownerInvite?: string;
}

export class ConfigError extends Error {}

/** Resolve a model without leaking a default that belongs to another harness. */
export function resolveRoleModel(
  model: string | null | undefined,
  harness: string | undefined,
  defaults: Record<string, unknown>,
): string | undefined {
  if (model === null) return undefined;
  if (typeof model === 'string' && model.trim()) return model.trim();
  const defaultHarness = (defaults.harness as string | undefined) ?? 'claude-code';
  const effectiveHarness = harness ?? defaultHarness;
  return effectiveHarness === defaultHarness ? defaults.model as string | undefined : undefined;
}

/**
 * The runtime facts the isolation resolver needs for a role. Single-sourced so
 * config validation, doctor, and the runner all judge the SAME mount set — a
 * policy checked against a different context than the one that launches is not
 * a check at all.
 */
export function isolationContextFor(role: ResolvedRole): WrapContext {
  const stateDir = agentDir(role.name, (role as ResolvedRole & { __temp?: boolean }).__temp === true);
  const runCwd = role.cwd ?? stateDir;
  // Ask the harness how its host state splits. An adapter that declares
  // none keeps the historical whole-home mount.
  let split: { home?: string; shared: string[] } | undefined;
  try { split = getAdapter(role.harness).isolationPaths?.(role, { stateDir, runCwd }); }
  catch { split = undefined; }
  return {
    stateDir,
    runCwd,
    home: home(),
    harness: role.harness,
    additionalWriteDirs: role.harness === 'codex'
      ? ((role.harness_options as { add_dirs?: string[] } | undefined)?.add_dirs ?? [])
      : [],
    harnessHome: split?.home,
    harnessRuntimeDir: split?.home ? harnessRuntimeDir(stateDir, role.harness) : undefined,
    harnessSharedPaths: split?.shared,
  };
}

export const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROLE_KEYS = [
  'harness', 'session', 'session_options', 'permissions', 'identity', 'cwd', 'coordinator', 'mission', 'persona', 'bio',
  'briefing_file', 'model', 'effort', 'model_chain', 'max_tokens', 'autocompact_pct', 'env', 'oversee', 'harness_options',
  'isolation', 'monitor', 'owner_channel', 'worklog', 'auth_proxy',
];

export const ROLE_PRESET_KEYS = ['mission', 'persona', 'bio', 'briefing_file'];
export const BRAIN_PRESET_KEYS = [
  'harness', 'session', 'session_options', 'model', 'model_chain', 'max_tokens',
  'autocompact_pct', 'harness_options', 'effort',
];
export const AGENT_KEYS = [
  'role', 'brain', 'permissions', 'identity', 'cwd', 'coordinator', 'env', 'oversee',
  'isolation', 'monitor', 'owner_channel', 'worklog', 'auth_proxy',
];
const V2_API_VERSION = 'ours.network/fleet/v2';

type BarePreset = Record<string, unknown>;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

function schemaError(file: string, pointer: string, summary: string): never {
  throw new ConfigError(`${file}: E_SCHEMA ${pointer}: ${summary}`);
}

export function validateRoleValue(value: BarePreset, file: string, pointer: string): void {
  const limits: Record<string, { bytes: number; nonblank?: boolean }> = {
    mission: { bytes: 16 * 1024, nonblank: true },
    persona: { bytes: 16 * 1024 },
    bio: { bytes: 4 * 1024 },
  };
  for (const [key, rule] of Object.entries(limits)) {
    const current = value[key];
    if (current === undefined) continue;
    if (typeof current !== 'string') schemaError(file, `${pointer}/${key}`, 'must be a string');
    if (rule.nonblank && !current.trim()) schemaError(file, `${pointer}/${key}`, 'must be non-blank');
    if (utf8Bytes(current) > rule.bytes)
      schemaError(file, `${pointer}/${key}`, `must be at most ${rule.bytes} UTF-8 bytes`);
  }
  if (value.briefing_file !== undefined
      && (typeof value.briefing_file !== 'string' || !value.briefing_file.trim()))
    schemaError(file, `${pointer}/briefing_file`, 'must be a non-blank relative path');
}

export function validateBrainValue(value: BarePreset, file: string, pointer: string): void {
  if (typeof value.harness !== 'string' || !value.harness.trim())
    schemaError(file, `${pointer}/harness`, 'is required and must be a registered non-blank harness ID');
  if (value.model !== undefined && value.model !== null
      && (typeof value.model !== 'string' || !value.model.trim()))
    schemaError(file, `${pointer}/model`, 'must be a non-blank string or null');
  for (const key of ['harness_options', 'session_options'] as const) {
    if (value[key] !== undefined && !isPlainObject(value[key]))
      schemaError(file, `${pointer}/${key}`, 'must be a mapping');
  }
}

function validateAgentScalars(value: BarePreset, file: string, id: string): void {
  for (const key of ['identity', 'cwd'] as const) {
    const current = value[key];
    if (current !== undefined && (typeof current !== 'string' || !current.trim()))
      schemaError(file, `/agents/${id}/${key}`, 'must be a non-blank string');
  }
  if (value.coordinator !== undefined
      && (typeof value.coordinator !== 'string' || !ROLE_NAME_RE.test(value.coordinator)))
    schemaError(file, `/agents/${id}/coordinator`, 'must be a valid Agent ID');
  if (value.oversee !== undefined) {
    if (!Array.isArray(value.oversee))
      schemaError(file, `/agents/${id}/oversee`, 'must be an array');
    const seen = new Set<string>();
    value.oversee.forEach((entry, index) => {
      const pointer = `/agents/${id}/oversee/${index}`;
      if (!isPlainObject(entry)) schemaError(file, pointer, 'must be a mapping');
      const keys = Object.keys(entry);
      const bad = keys.filter(key => key !== 'agent' && key !== 'interval');
      if (bad.length || keys.length !== 2 || !keys.includes('agent') || !keys.includes('interval'))
        schemaError(file, pointer, 'must contain exactly agent and interval');
      if (typeof entry.agent !== 'string' || !ROLE_NAME_RE.test(entry.agent))
        schemaError(file, `${pointer}/agent`, 'must be a valid Agent ID');
      if (typeof entry.interval !== 'string')
        schemaError(file, `${pointer}/interval`, 'must be a valid duration');
      try { parseDuration(entry.interval, { name: 'oversee interval' }); }
      catch { schemaError(file, `${pointer}/interval`, 'must be a valid duration such as 5m'); }
      if (seen.has(entry.agent)) schemaError(file, `${pointer}/agent`, 'must be unique');
      seen.add(entry.agent);
    });
  }
}

function assertTrustedPath(path: string, expected: 'file' | 'directory'): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new ConfigError(`E_SYMLINK: trusted configuration path is a symlink: ${path}`);
  if (expected === 'file' ? !st.isFile() : !st.isDirectory())
    throw new ConfigError(`E_FILE_TRUST: expected ${expected}: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid)
    throw new ConfigError(`E_FILE_TRUST: ${path} is owned by uid ${st.uid}; required uid ${uid}`);
  if ((st.mode & 0o022) !== 0)
    throw new ConfigError(`E_FILE_TRUST: ${path} is group/world writable (mode ${(st.mode & 0o777).toString(8)})`);
}

export function assertBareKeys(value: unknown, allowed: string[], label: string): BarePreset {
  if (!isPlainObject(value)) throw new ConfigError(`${label}: E_SCHEMA: must be a mapping`);
  const bad = Object.keys(value).filter(key => !allowed.includes(key));
  if (bad.length) throw new ConfigError(`${label}: E_UNKNOWN_KEY: unknown key(s) ${bad.join(', ')}; allowed: ${allowed.join(', ')}`);
  return value;
}

export function splitRootFor(base: string): string {
  const extension = extname(base).toLowerCase();
  return extension === '.yaml' || extension === '.yml' ? base.slice(0, -extension.length) : `${base}.d`;
}

function readKindDirectory(
  root: string, kind: 'agent' | 'role' | 'brain', required: boolean, yamlMode: YamlMode,
  diagnostics: ConfigDiagnostic[], files: string[],
): Map<string, { file: string; value: BarePreset }> {
  if (!existsSync(root)) {
    if (required) throw new ConfigError(`E_ROOT_MISSING: required ${kind} root not found: ${root}`);
    return new Map();
  }
  assertTrustedPath(root, 'directory');
  const result = new Map<string, { file: string; value: BarePreset }>();
  const names = readdirSync(root).filter(name => ['.yaml', '.yml'].includes(extname(name).toLowerCase())).sort();
  for (const name of names) {
    const file = join(root, name);
    assertTrustedPath(file, 'file');
    const id = basename(name, extname(name));
    if (!ROLE_NAME_RE.test(id))
      throw new ConfigError(`${file}: invalid ${kind} id '${id}' (allowed: [A-Za-z0-9_-])`);
    const previous = result.get(id);
    if (previous) throw new ConfigError(`E_DUPLICATE_ID: ${kind} '${id}' defined by both ${previous.file} and ${file}`);
    const parsed = parseFleetDocument(file, readFileSync(file, 'utf8'), yamlMode);
    diagnostics.push(...parsed.diagnostics);
    files.push(file);
    result.set(id, { file, value: parsed.value });
  }
  return result;
}

function readRoomTemplateDirectory(
  root: string, yamlMode: YamlMode, diagnostics: ConfigDiagnostic[], files: string[],
): RoomTemplatesConfig {
  if (!existsSync(root)) return {};
  assertTrustedPath(root, 'directory');
  const result: RoomTemplatesConfig = {};
  const sources = new Map<string, string>();
  const names = readdirSync(root)
    .filter(name => ['.yaml', '.yml'].includes(extname(name).toLowerCase())).sort();
  for (const filename of names) {
    const file = join(root, filename);
    assertTrustedPath(file, 'file');
    const id = basename(filename, extname(filename));
    const previous = sources.get(id);
    if (previous)
      throw new ConfigError(`E_DUPLICATE_ID: room template '${id}' defined by both ${previous} and ${file}`);
    const parsed = parseFleetDocument(file, readFileSync(file, 'utf8'), yamlMode);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value.override_builtin === true) diagnostics.push({
      severity: 'warning', kind: 'deprecated-field', file, line: 1, column: 1,
      message: `${file}: override_builtin is deprecated and ignored for a file-backed Room template`,
    });
    files.push(file);
    const validated = validateRoomTemplatesConfig({ [id]: parsed.value }, file)[id];
    result[id] = { ...validated, sourceFile: file };
    sources.set(id, file);
  }
  return result;
}

function selection(
  raw: unknown, kind: 'role' | 'brain', agentFile: string,
  presets: Map<string, { file: string; value: BarePreset }>, allowed: string[],
): { value: BarePreset; file: string; pointer: string } {
  if (!isPlainObject(raw)) schemaError(agentFile, `/${kind}`, 'must be { ref } or { inline }');
  const keys = Object.keys(raw);
  if (keys.length !== 1 || (keys[0] !== 'ref' && keys[0] !== 'inline'))
    throw new ConfigError(`${agentFile}: E_UNION /${kind}: must contain exactly one of ref or inline`);
  if ('ref' in raw) {
    if (typeof raw.ref !== 'string' || !ROLE_NAME_RE.test(raw.ref))
      schemaError(agentFile, `/${kind}/ref`, 'must be a valid case-sensitive ID');
    const preset = presets.get(raw.ref);
    if (!preset) throw new ConfigError(`${agentFile}: E_REF_MISSING: ${kind} '${raw.ref}' not found`);
    return {
      value: assertBareKeys(preset.value, allowed, `${preset.file}: ${kind} '${raw.ref}'`),
      file: preset.file,
      pointer: `/${kind}s/${raw.ref}`,
    };
  }
  return {
    value: assertBareKeys(raw.inline, allowed, `${agentFile}: agent.${kind}.inline`),
    file: agentFile,
    pointer: `/${kind}/inline`,
  };
}

function deepSubStrict(
  value: unknown, vars: Record<string, string>, file: string, pointer: string,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
      if (!(key in vars)) schemaError(file, pointer, `unknown variable \${${key}}`);
      return String(vars[key]);
    });
  }
  if (Array.isArray(value))
    return value.map((item, index) => deepSubStrict(item, vars, file, `${pointer}/${index}`));
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, deepSubStrict(child, vars, file, `${pointer}/${key}`),
    ]));
  return value;
}

function composeSplitRoles(
  base: string, baseDoc: Record<string, unknown>, yamlMode: YamlMode,
  diagnostics: ConfigDiagnostic[], files: string[], additionalAgent?: { id: string; definition: AgentDefinition },
): { file: string; doc: Record<string, unknown>; provenance?: Record<string, FieldProvenance>; agentSelections?: Pick<AgentDefinition, 'role' | 'brain'>; agentDefinition?: AgentDefinition }[] {
  if (baseDoc.api_version !== V2_API_VERSION)
    throw new ConfigError(`${base}: legacy fleet configuration is unsupported; run 'ours-fleet doctor' and rewrite it as ${V2_API_VERSION}`);
  if ('roles' in baseDoc)
    throw new ConfigError(`${base}: legacy top-level roles: is unsupported; define bare Agent files under ${splitRootFor(base)}/agents/`);
  const root = splitRootFor(base);
  if (!existsSync(root)) throw new ConfigError(`E_ROOT_MISSING: required configuration root not found: ${root}`);
  assertTrustedPath(root, 'directory');
  const brains = readKindDirectory(join(root, 'brains'), 'brain', false, yamlMode, diagnostics, files);
  const roles = readKindDirectory(join(root, 'roles'), 'role', false, yamlMode, diagnostics, files);
  const agents = readKindDirectory(join(root, 'agents'), 'agent', true, yamlMode, diagnostics, files);
  if (additionalAgent) {
    if (agents.has(additionalAgent.id))
      throw new ConfigError(`agent '${additionalAgent.id}' already exists`);
    agents.set(additionalAgent.id, {
      file: '(spawn request)', value: structuredClone(additionalAgent.definition) as unknown as BarePreset,
    });
  }
  const vars = (baseDoc.vars ?? {}) as Record<string, string>;
  const documents: { file: string; doc: Record<string, unknown>; provenance?: Record<string, FieldProvenance>; agentSelections?: Pick<AgentDefinition, 'role' | 'brain'>; agentDefinition?: AgentDefinition }[] = [];
  for (const [id, agent] of agents) {
    const a = assertBareKeys(agent.value, AGENT_KEYS, `${agent.file}: agent '${id}'`);
    if (!('role' in a) || !('brain' in a)) throw new ConfigError(`${agent.file}: agent '${id}' requires role and brain`);
    const role = selection(a.role, 'role', agent.file, roles, ROLE_PRESET_KEYS);
    const brain = selection(a.brain, 'brain', agent.file, brains, BRAIN_PRESET_KEYS);
    const operational = deepSubStrict(
      Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'role' && key !== 'brain')), vars,
      agent.file, `/agents/${id}`,
    ) as Record<string, unknown>;
    validateAgentScalars(operational, agent.file, id);
    const brainValue = deepSubStrict({ ...brain.value }, vars, brain.file, brain.pointer) as Record<string, unknown>;
    validateBrainValue(brainValue, brain.file, brain.pointer);
    const effort = brainValue.effort;
    delete brainValue.effort;
    const harness = brainValue.harness as string;
    {
      let adapter;
      try { adapter = getAdapter(harness); }
      catch { schemaError(brain.file, `${brain.pointer}/harness`, `unregistered harness '${harness}'`); }
      let resolved;
      try {
        resolved = adapter.agentSession.resolveBrain({
          model: brainValue.model as string | null | undefined,
          effort: effort as string | undefined,
          harnessOptions: brainValue.harness_options as Record<string, unknown> | undefined,
        });
      } catch (error) {
        schemaError(brain.file, `${brain.pointer}/effort`, (error as Error).message);
      }
      brainValue.model = resolved.model;
      brainValue.harness_options = resolved.harnessOptions;
      brainValue.effort = effort;
    }
    const roleValue = deepSubStrict({ ...role.value }, vars, role.file, role.pointer) as Record<string, unknown>;
    validateRoleValue(roleValue, role.file, role.pointer);
    if (typeof roleValue.briefing_file === 'string') {
      const containmentRoot = realpathSync(dirname(role.file));
      const briefing = resolve(dirname(role.file), roleValue.briefing_file);
      if (briefing !== containmentRoot && !briefing.startsWith(`${containmentRoot}${sep}`))
        throw new ConfigError(`${role.file}: E_PATH_ESCAPE: briefing_file escapes its ${role.file === agent.file ? 'Agent' : 'Role'} root`);
      assertTrustedPath(briefing, 'file');
      const real = realpathSync(briefing);
      if (real !== containmentRoot && !real.startsWith(`${containmentRoot}${sep}`))
        throw new ConfigError(`${role.file}: E_PATH_ESCAPE: briefing_file realpath escapes its root`);
      roleValue.briefing_file = real;
    }
    const provenance: Record<string, FieldProvenance> = {};
    const record = (
      values: Record<string, unknown>, source: { file: string; pointer: string },
      kind: 'Agent' | 'Role' | 'Brain', via?: { sourcePointer: string; kind: 'Role' | 'Brain'; id: string },
    ) => {
      for (const [key, raw] of Object.entries(values)) provenance[key] = {
        sourceFile: source.file, sourcePointer: `${source.pointer}/${key}`,
        sourceKind: kind, sourceId: via?.id ?? id, origin: 'explicit',
        ...(via ? { viaReference: via } : {}),
        transforms: [
          ...(JSON.stringify(raw).includes('${')
            ? [{ kind: 'substitution' as const, detail: 'manifest variable substitution' }] : []),
          ...(['model', 'harness_options', 'effort'].includes(key)
            ? [{ kind: 'adapter-normalization' as const, detail: 'AgentSession Brain resolution' }] : []),
        ],
      };
    };
    record(a, { file: agent.file, pointer: `/agents/${id}` }, 'Agent');
    record(role.value, { file: role.file, pointer: role.pointer }, 'Role',
      'ref' in (a.role as Record<string, unknown>)
        ? { sourcePointer: `/agents/${id}/role/ref`, kind: 'Role', id: String((a.role as Record<string, unknown>).ref) }
        : undefined);
    record(brain.value, { file: brain.file, pointer: brain.pointer }, 'Brain',
      'ref' in (a.brain as Record<string, unknown>)
        ? { sourcePointer: `/agents/${id}/brain/ref`, kind: 'Brain', id: String((a.brain as Record<string, unknown>).ref) }
        : undefined);
    delete provenance.role; delete provenance.brain;
    const canonicalDefinition = {
      role: deepSubStrict(a.role, vars, agent.file, `/agents/${id}/role`),
      brain: deepSubStrict(a.brain, vars, agent.file, `/agents/${id}/brain`),
      ...operational,
    } as AgentDefinition;
    documents.push({ file: agent.file,
      doc: { roles: { [id]: { ...brainValue, ...roleValue, ...operational } } }, provenance,
      agentSelections: structuredClone({ role: canonicalDefinition.role, brain: canonicalDefinition.brain }),
      agentDefinition: canonicalDefinition });
  }
  return documents;
}

function deepSub(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map(x => deepSub(x, vars));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(x, vars)]));
  return v;
}

/** Load a v2 manifest and bare Agent/Role/Brain documents from its stem directory. */
export function loadConfig(
  configPath?: string,
  options: { yamlMode?: YamlMode; additionalAgent?: { id: string; definition: AgentDefinition }; skipWatchdogs?: boolean } = {},
): FleetConfig {
  const base = configPath ?? defaultConfigPath();
  const files: string[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  let docs: { file: string; doc: Record<string, unknown>; provenance?: Record<string, FieldProvenance>; agentSelections?: Pick<AgentDefinition, 'role' | 'brain'>; agentDefinition?: AgentDefinition }[] = [];
  let manifestDoc: Record<string, unknown> = {};
  if (existsSync(base)) {
    assertTrustedPath(base, 'file');
    const parsed = parseFleetDocument(base, readFileSync(base, 'utf8'), options.yamlMode);
    manifestDoc = parsed.value;
    diagnostics.push(...parsed.diagnostics);
    files.push(base);
  } else if (configPath) {
    throw new ConfigError(`config not found: ${base}`);
  } else {
    throw new ConfigError(`config not found: ${base}`);
  }
  const dd = fleetDDir();
  if (existsSync(dd) && readdirSync(dd).some(f => f.endsWith('.yaml') || f.endsWith('.yml')))
    throw new ConfigError(`${dd}: legacy fleet.d configuration is unsupported; run 'ours-fleet doctor' and move agents to ${splitRootFor(base)}/agents/`);
  docs = [{ file: base, doc: manifestDoc }, ...composeSplitRoles(
    base, manifestDoc, options.yamlMode ?? 'compat', diagnostics, files, options.additionalAgent,
  )];
  const baseDoc = manifestDoc;
  const vars = (baseDoc.vars ?? {}) as Record<string, string>;
  const defaults = (baseDoc.defaults ?? {}) as Record<string, unknown>;
  const legacyRuntimeDefaults = ['harness', 'model', 'model_chain', 'effort', 'harness_options',
    'session', 'session_options', 'max_tokens', 'autocompact_pct']
    .filter(key => Object.hasOwn(defaults, key));
  if (legacyRuntimeDefaults.length)
    throw new ConfigError(`${base}: E_LEGACY /defaults: Brain-owned field(s) ${legacyRuntimeDefaults.join(', ')} are unsupported; move them to a Brain definition`);
  const startStaggerMs = resolveStartStaggerMs(baseDoc.start_stagger_ms, base);
  const seen = new Map<string, string>();
  const roles: ResolvedRole[] = [];
  const agentDefinitions: Record<string, AgentDefinition> = {};
  for (const { file, doc, provenance, agentSelections, agentDefinition } of docs) {
    for (const [name, raw] of Object.entries((doc.roles ?? {}) as Record<string, RoleConfig | null>)) {
      if (!ROLE_NAME_RE.test(name))
        throw new ConfigError(`${file}: invalid role name '${name}' (allowed: [A-Za-z0-9_-])`);
      const prev = seen.get(name);
      if (prev) throw new ConfigError(`role '${name}' defined in both ${prev} and ${file}`);
      seen.set(name, file);
      if (agentDefinition) agentDefinitions[name] = structuredClone(agentDefinition);
      const r = deepSub(raw ?? {}, vars) as RoleConfig;
      const bad = Object.keys(r).filter(k => !ROLE_KEYS.includes(k));
      if (bad.length)
        throw new ConfigError(
          `${file}: role '${name}' has unknown key(s) ${bad.join(', ')}; allowed: ${ROLE_KEYS.join(', ')}`);
      const isolation = r.isolation ?? (defaults.isolation as IsolationConfig | undefined);
      const session = resolveSession(r.session ?? defaults.session, file, name);
      const sessionOptions = resolveSessionOptions(
        defaults.session_options, r.session_options, session, file, name);
      const permissions = resolvePermissions(defaults.permissions, r.permissions, file, name);
      const permissionsDeclared = r.permissions !== undefined || defaults.permissions !== undefined;
      const defaultHarnessOptions = defaults.harness_options;
      if (defaultHarnessOptions !== undefined
          && (typeof defaultHarnessOptions !== 'object' || defaultHarnessOptions === null
              || Array.isArray(defaultHarnessOptions)))
        throw new ConfigError(`${base}: defaults.harness_options must be a map`);
      const harnessOptions = defaultHarnessOptions === undefined && r.harness_options === undefined
        ? undefined
        : {
            ...((defaultHarnessOptions ?? {}) as Record<string, unknown>),
            ...(r.harness_options ?? {}),
          };
      if (isolation !== undefined) {
        const problems = validateIsolationConfig(isolation);
        if (problems.length)
          throw new ConfigError(`${file}: role '${name}' ${problems.join('; ')}`);
      }
      const monitor = resolveMonitorConfig(defaults.monitor, r.monitor, { base, file, name });
      const ownerChannel = resolveOwnerChannelConfig(
        defaults.owner_channel, r.owner_channel, session, file, name);
      const worklog = resolveWorklogPolicy(defaults.worklog, r.worklog, file, name);
      const authProxy = resolveAuthProxy(defaults.auth_proxy, r.auth_proxy, file, name);
      const harness = r.harness ?? (defaults.harness as string | undefined) ?? 'claude-code';
      const defaultHarness = (defaults.harness as string | undefined) ?? 'claude-code';
      const inheritsModelDefaults = harness === defaultHarness && r.model !== null;
      if (authProxy && harness !== 'claude-code')
        throw new ConfigError(`${file}: role '${name}' auth_proxy is supported only by claude-code`);
      // Environment and runtime model are resolved together so `model:` and the
      // harness's model pin can never disagree (see src/model-env.ts).
      const modelEnv = resolveRoleModelEnv({
        harness,
        model: resolveRoleModel(r.model, r.harness, defaults),
        modelWasExplicit: r.model !== undefined,
        defaultsEnv: (defaults.env ?? {}) as Record<string, string>,
        roleEnv: r.env,
        ...(authProxy ? { authProxyBaseUrl: authProxy.base_url } : {}),
      }, message => new ConfigError(`${file}: role '${name}' ${message}`));
      const env = modelEnv.env;
      const model = modelEnv.model;
      const modelChain = resolveModelChain(
        model,
        r.model_chain ?? (inheritsModelDefaults
          ? defaults.model_chain as string[] | undefined
          : undefined),
        file,
        name,
      );
      const fieldProvenance = { ...(provenance ?? {}) };
      const defaulted = (key: string, explicit: boolean, builtIn = false) => {
        if (fieldProvenance[key]) return;
        fieldProvenance[key] = {
          sourceFile: builtIn ? '(built-in)' : base,
          sourcePointer: builtIn ? `/${key}` : `/defaults/${key}`,
          sourceKind: builtIn ? 'built-in' : 'Manifest',
          origin: builtIn ? 'built-in' : explicit ? 'explicit' : 'typed-default',
          transforms: [{ kind: 'validation-default', detail: builtIn ? 'built-in default' : 'manifest operational default' }],
        };
      };
      defaulted('identity', r.identity !== undefined, r.identity === undefined);
      defaulted('permissions', defaults.permissions !== undefined, defaults.permissions === undefined);
      defaulted('monitor', defaults.monitor !== undefined, defaults.monitor === undefined);
      roles.push({
        ...r,
        name,
        sourceFile: file,
        harness,
        session,
        session_options: sessionOptions,
        permissions,
        permissionsDeclared,
        identity: r.identity ?? name,
        model,
        model_chain: modelChain,
        max_tokens: r.max_tokens ?? (defaults.max_tokens as number | undefined),
        harness_options: harnessOptions,
        isolation,
        monitor,
        owner_channel: ownerChannel,
        worklog,
        provenance: fieldProvenance,
        auth_proxy: authProxy,
        env: Object.keys(env).length ? env : undefined,
        loops: [],
        ...(agentSelections ? { agentSelections } : {}),
      });
      // Forbidden-path enforcement: a mount that would breach the policy
      // is a configuration error, caught by `config` rather than at launch.
      if (isolation !== undefined) {
        const role = roles[roles.length - 1];
        try { resolveIsolation(isolation, isolationContextFor(role)); }
        catch (e) {
          throw new ConfigError(`${file}: role '${name}' ${(e as Error).message}`);
        }
      }
    }
  }
  validateOwnerChannelIdentities(roles);
  const watchdogs = options.skipWatchdogs ? [] : resolveWatchdogs(
    baseDoc, base, roles, vars, agentDefinitions,
    (name, definition) => {
      const id = `WatchdogAgent${name}`.slice(0, 64);
      return findRole(loadConfig(base, {
        yamlMode: options.yamlMode, additionalAgent: { id, definition }, skipWatchdogs: true,
      }), id);
    },
  );
  const resolvedLoops = resolveLoops(baseDoc.loops, base, roles, vars);
  for (const role of roles) role.loops = resolvedLoops.byRole.get(role.name) ?? [];

  // ── Rooms, room_templates, tasks (split-config merge) ──────────────
  // These sections may appear in the base fleet.yaml and/or in fleet.d files.
  // Base provides defaults; fleet.d extends. Only one source may define rooms/tasks
  // top-level (room_templates merge by name, last writer wins).
  let rooms: RoomsConfig | undefined;
  let ownerInviteFingerprint: string | undefined;
  let ownerInvite: string | undefined;
  let roomTemplates: RoomTemplatesConfig | undefined;
  let tasks: TasksConfig | undefined;

  const fileTemplates = readRoomTemplateDirectory(
    join(splitRootFor(base), 'room_templates'), options.yamlMode ?? 'compat', diagnostics, files,
  );
  if (Object.keys(fileTemplates).length) roomTemplates = fileTemplates;

  for (const { file, doc } of docs) {
    if (doc.rooms !== undefined) {
      if (rooms) throw new ConfigError(`rooms: defined in multiple files; last: ${file}`);
      const validated = validateRoomsConfig(deepSub(doc.rooms, vars), vars, file);
      ownerInviteFingerprint = validated._invite?.fingerprint;
      ownerInvite = validated._invite?.value;
      const { _invite: _, ...clean } = validated;
      rooms = clean;
    }
    if (doc.room_templates !== undefined) {
      const validated = validateRoomTemplatesConfig(deepSub(doc.room_templates, vars), file);
      const raw = doc.room_templates as Record<string, Record<string, unknown>>;
      for (const [name, template] of Object.entries(validated)) {
        const shadowed = roomTemplates?.[name];
        const marker = raw[name]?.override_builtin;
        if (shadowed && (marker !== true || template.version <= shadowed.version))
          throw new ConfigError(
            `${file}: room_templates.${name} shadows file preset ${shadowed.sourceFile}; `
            + 'set override_builtin: true and use a higher version',
          );
        if (marker === true) diagnostics.push({
          severity: 'warning', kind: 'deprecated-field', file, line: 1, column: 1,
          message: `${file}: room_templates.${name}.override_builtin is deprecated; `
            + 'it is retained only as an explicit manifest-over-file migration marker',
        });
        roomTemplates = { ...(roomTemplates ?? {}), [name]: { ...template, sourceFile: file } };
      }
    }
    if (doc.tasks !== undefined) {
      if (tasks) throw new ConfigError(`tasks: defined in multiple files; last: ${file}`);
      tasks = validateTasksConfig(deepSub(doc.tasks, vars), file);
    }
  }

  const result: FleetConfig = {
    roles, agentDefinitions, vars, defaults, files, startStaggerMs, diagnostics, watchdogs,
    loops: resolvedLoops.loops,
    rooms, roomTemplates, tasks, ownerInviteFingerprint,
    configMode: 'split-v2',
    sourceDocuments: files.map(path => {
      if (path === base) return { kind: 'Manifest' as const, path };
      const parent = basename(dirname(path));
      const kind = parent === 'agents' ? 'Agent' as const
        : parent === 'roles' ? 'Role' as const
          : parent === 'room_templates' ? 'RoomTemplate' as const : 'Brain' as const;
      return { kind, id: basename(path, extname(path)), path };
    }),
  };
  if (ownerInvite !== undefined) {
    Object.defineProperty(result, 'ownerInvite', {
      value: ownerInvite,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return result;
}

/**
 * Canonical form of a 64-hex container ID for authorization decisions. Hex
 * case is not identity: two casings of one CID are the same peer, so every
 * comparison must use this form. Addressing is the opposite — the daemon's
 * contact resolution is case-exact, so daemon-delivered forms must be sent
 * back verbatim and never rewritten to canonical case.
 */
export function canonicalCid(value: string): string {
  return /^[A-Fa-f0-9]{64}$/.test(value) ? value.toLowerCase() : value;
}

export function resolveOwnerChannelConfig(
  defaults: unknown, role: OwnerChannelConfigInput | undefined,
  session: SessionBackendId, file = 'config', name = 'role',
): OwnerChannelConfig | undefined {
  if (defaults === undefined && role === undefined) return undefined;
  if (defaults !== undefined && !isPlainObject(defaults))
    throw new ConfigError(`${file}: defaults.owner_channel must be a map`);
  if (role !== undefined && !isPlainObject(role))
    throw new ConfigError(`${file}: role '${name}' owner_channel must be a map`);
  const defaultInput = (defaults ?? {}) as OwnerChannelConfigInput;
  const merged = {
    ...defaultInput,
    ...(role ?? {}),
  };
  const allowed = [
    'identity', 'owners', 'agent', 'interrupt', 'progress_interval_ms', 'comments', 'attachments',
  ];
  const bad = Object.keys(merged).filter(key => !allowed.includes(key));
  if (bad.length)
    throw new ConfigError(`${file}: role '${name}' owner_channel: unknown key(s) ${bad.join(', ')}`);
  if (typeof merged.identity !== 'string' || !merged.identity.trim())
    throw new ConfigError(`${file}: role '${name}' owner_channel.identity must be a non-blank string`);
  if (!Array.isArray(merged.owners) || merged.owners.length === 0
      || merged.owners.some(owner => typeof owner !== 'string' || !owner.trim()))
    throw new ConfigError(`${file}: role '${name}' owner_channel.owners must be a non-empty list of contact IDs`);
  const owners = merged.owners.map(owner => canonicalCid(owner.trim()));
  if (new Set(owners).size !== owners.length)
    throw new ConfigError(`${file}: role '${name}' owner_channel.owners must not contain duplicates`);
  if (merged.agent !== undefined
      && (typeof merged.agent !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(merged.agent)))
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.agent must be exactly 64 hexadecimal characters`);
  const agent = merged.agent === undefined ? undefined : canonicalCid(merged.agent.trim());
  if (agent && owners.includes(agent))
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.agent must not also be an owner CID`);
  if (agent && owners.some(owner => !/^[A-Fa-f0-9]{64}$/.test(owner)))
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.owners must contain exact 64-hex CIDs when agent relay is configured`);
  if (merged.interrupt !== undefined && typeof merged.interrupt !== 'boolean')
    throw new ConfigError(`${file}: role '${name}' owner_channel.interrupt must be true or false`);
  if (merged.progress_interval_ms !== undefined
      && (typeof merged.progress_interval_ms !== 'number'
        || !Number.isFinite(merged.progress_interval_ms) || merged.progress_interval_ms < 0))
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.progress_interval_ms must be a non-negative number`);
  if (merged.comments !== undefined && typeof merged.comments !== 'boolean')
    throw new ConfigError(`${file}: role '${name}' owner_channel.comments must be true or false`);
  if (defaultInput.attachments !== undefined && !isPlainObject(defaultInput.attachments))
    throw new ConfigError(`${file}: defaults.owner_channel.attachments must be a map`);
  if (role?.attachments !== undefined && !isPlainObject(role.attachments))
    throw new ConfigError(`${file}: role '${name}' owner_channel.attachments must be a map`);
  const attachments = {
    ...(defaultInput.attachments ?? {}), ...(role?.attachments ?? {}),
  } as OwnerAttachmentConfigInput;
  const attachmentKeys = [
    'enabled', 'max_files_per_request', 'max_file_bytes', 'max_request_bytes',
    'retention_ms', 'allowed_mime',
  ];
  const badAttachmentKeys = Object.keys(attachments)
    .filter(key => !attachmentKeys.includes(key));
  if (badAttachmentKeys.length)
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.attachments: unknown key(s) ${badAttachmentKeys.join(', ')}`);
  if (attachments.enabled !== undefined && typeof attachments.enabled !== 'boolean')
    throw new ConfigError(`${file}: role '${name}' owner_channel.attachments.enabled must be true or false`);
  const boundedInteger = (key: keyof OwnerAttachmentConfig, min: number, max: number) => {
    const value = attachments[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value)
        || value < min || value > max))
      throw new ConfigError(
        `${file}: role '${name}' owner_channel.attachments.${key} must be an integer from ${min} to ${max}`);
  };
  boundedInteger('max_files_per_request', 1, 32);
  boundedInteger('max_file_bytes', 1, 100 * 1024 * 1024);
  boundedInteger('max_request_bytes', 1, 256 * 1024 * 1024);
  boundedInteger('retention_ms', 60_000, 30 * 24 * 60 * 60 * 1_000);
  const maxFileBytes = attachments.max_file_bytes ?? 10 * 1024 * 1024;
  const maxRequestBytes = attachments.max_request_bytes ?? 20 * 1024 * 1024;
  if (maxRequestBytes < maxFileBytes)
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.attachments.max_request_bytes must be at least max_file_bytes`);
  if (session !== 'acp')
    throw new ConfigError(
      `${file}: role '${name}' owner_channel requires session: acp for correlated final replies`);
  return {
    identity: merged.identity.trim(),
    owners,
    ...(agent ? { agent } : {}),
    interrupt: merged.interrupt ?? false,
    progress_interval_ms: merged.progress_interval_ms ?? 30_000,
    // Default true preserves the established live-commentary behavior; an
    // upgrade never silently goes quiet on an owner who relied on it.
    comments: merged.comments ?? true,
    attachments: {
      enabled: attachments.enabled ?? true,
      max_files_per_request: attachments.max_files_per_request ?? 4,
      max_file_bytes: maxFileBytes,
      max_request_bytes: maxRequestBytes,
      retention_ms: attachments.retention_ms ?? 24 * 60 * 60 * 1_000,
    },
  };
}

function validateOwnerChannelIdentities(roles: ResolvedRole[]): void {
  const roleIdentities = new Map(roles.map(role => [role.identity, role.name]));
  const channels = new Map<string, string>();
  for (const role of roles) {
    const identity = role.owner_channel?.identity;
    if (!identity) continue;
    const roleOwner = roleIdentities.get(identity);
    if (roleOwner)
      throw new ConfigError(
        `${role.sourceFile}: role '${role.name}' owner_channel.identity '${identity}' conflicts with role '${roleOwner}' identity`);
    const channelOwner = channels.get(identity);
    if (channelOwner)
      throw new ConfigError(
        `${role.sourceFile}: owner_channel.identity '${identity}' is shared by roles '${channelOwner}' and '${role.name}'`);
    channels.set(identity, role.name);
  }
}

export function resolveModelChain(
  model: string | undefined, chain: string[] | undefined, file = 'config', name = 'role',
): string[] | undefined {
  if (chain === undefined) return undefined;
  if (!Array.isArray(chain) || chain.length === 0)
    throw new ConfigError(`${file}: role '${name}' model_chain must be a non-empty list`);
  if (chain.some(entry => typeof entry !== 'string' || entry.trim() === ''))
    throw new ConfigError(`${file}: role '${name}' model_chain entries must be non-blank strings`);
  const normalized = chain.map(entry => entry.trim());
  if (new Set(normalized).size !== normalized.length)
    throw new ConfigError(`${file}: role '${name}' model_chain must not contain duplicates`);
  if (model !== undefined && model !== normalized[0])
    throw new ConfigError(`${file}: role '${name}' model must equal model_chain[0]`);
  return normalized;
}

export function resolveAuthProxy(
  defaults: unknown, role: Partial<AuthProxyConfig> | undefined,
  file = 'config', name = 'role',
): AuthProxyConfig | undefined {
  if (defaults === undefined && role === undefined) return undefined;
  if (defaults !== undefined && !isPlainObject(defaults))
    throw new ConfigError(`${file}: defaults.auth_proxy must be a map`);
  if (role !== undefined && !isPlainObject(role))
    throw new ConfigError(`${file}: role '${name}' auth_proxy must be a map`);
  const merged = {
    ...((defaults ?? {}) as Partial<AuthProxyConfig>),
    ...(role ?? {}),
  };
  const bad = Object.keys(merged).filter(key =>
    !['kind', 'base_url', 'required', 'health_url'].includes(key));
  if (bad.length) throw new ConfigError(
    `${file}: role '${name}' auth_proxy: unknown key(s) ${bad.join(', ')}`);
  if (merged.kind !== 'anthropic')
    throw new ConfigError(`${file}: role '${name}' auth_proxy.kind must be 'anthropic'`);
  if (typeof merged.base_url !== 'string')
    throw new ConfigError(`${file}: role '${name}' auth_proxy.base_url is required`);
  const checked = (label: string, raw: string): URL => {
    let url: URL;
    try { url = new URL(raw); } catch {
      throw new ConfigError(`${file}: role '${name}' auth_proxy.${label} must be a valid URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new ConfigError(`${file}: role '${name}' auth_proxy.${label} must use http or https`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new ConfigError(`${file}: role '${name}' auth_proxy.${label} must be loopback-only`);
    if (url.username || url.password)
      throw new ConfigError(`${file}: role '${name}' auth_proxy.${label} must not contain credentials`);
    return url;
  };
  const base = checked('base_url', merged.base_url);
  const healthRaw = merged.health_url ?? new URL('/healthz', base).toString();
  checked('health_url', healthRaw);
  if (merged.required !== undefined && typeof merged.required !== 'boolean')
    throw new ConfigError(`${file}: role '${name}' auth_proxy.required must be true or false`);
  return {
    kind: 'anthropic',
    base_url: base.toString().replace(/\/$/, ''),
    required: merged.required ?? true,
    health_url: healthRaw,
  };
}

export function resolveWorklogPolicy(
  defaults: unknown, role: WorklogPolicyInput | undefined, file = 'config', name = 'role',
): WorklogPolicy | undefined {
  if (role === false || (role === undefined && defaults === false)) return undefined;
  if (defaults !== undefined && defaults !== false && !isPlainObject(defaults))
    throw new ConfigError(`${file}: defaults.worklog must be a map or false`);
  if (role !== undefined && !isPlainObject(role))
    throw new ConfigError(`${file}: role '${name}' worklog must be a map or false`);
  const merged = {
    ...DEFAULT_WORKLOG_POLICY,
    ...((defaults === false || defaults === undefined ? {} : defaults) as Partial<WorklogPolicy>),
    ...(role === undefined ? {} : role),
  };
  const bad = Object.keys(merged).filter(key =>
    !['max_kb', 'keep_tail_kb', 'max_archives'].includes(key));
  if (bad.length) throw new ConfigError(
    `${file}: role '${name}' worklog: unknown key(s) ${bad.join(', ')}`);
  for (const key of ['max_kb', 'keep_tail_kb', 'max_archives'] as const) {
    const value = merged[key];
    if (!Number.isInteger(value) || (value as number) <= 0)
      throw new ConfigError(`${file}: role '${name}' worklog.${key} must be a positive integer`);
  }
  if ((merged.max_archives as number) > 1000)
    throw new ConfigError(`${file}: role '${name}' worklog.max_archives must be at most 1000`);
  if ((merged.keep_tail_kb as number) >= (merged.max_kb as number))
    throw new ConfigError(`${file}: role '${name}' worklog.keep_tail_kb must be less than max_kb`);
  return merged as WorklogPolicy;
}

function resolveSession(raw: unknown, file: string, name: string): SessionBackendId {
  const value = raw ?? 'acp';
  if (value === 'tmux')
    throw new ConfigError(
      `${file}: role '${name}' session: tmux is no longer supported; use session: acp `
      + 'with the Codex or Claude Code adapter');
  if (value !== 'acp')
    throw new ConfigError(`${file}: role '${name}' session: must be: acp`);
  return value;
}

function resolveSessionOptions(
  defaults: unknown, role: SessionOptions | undefined, session: SessionBackendId,
  file: string, name: string,
): SessionOptions | undefined {
  if (defaults !== undefined && !isPlainObject(defaults))
    throw new ConfigError(`${file}: defaults.session_options must be a map`);
  if (role !== undefined && !isPlainObject(role))
    throw new ConfigError(`${file}: role '${name}' session_options must be a map`);
  const merged = {
    ...((defaults ?? {}) as SessionOptions),
    ...(role ?? {}),
    acp: {
      ...(((defaults as SessionOptions | undefined)?.acp) ?? {}),
      ...(role?.acp ?? {}),
    },
  };
  if ((defaults as Record<string, unknown> | undefined)?.tmux !== undefined
      || (role as Record<string, unknown> | undefined)?.tmux !== undefined)
    throw new ConfigError(
      `${file}: role '${name}' session_options.tmux is no longer supported; `
      + 'use session: acp with session_options.acp');
  const bad = Object.keys(merged).filter(k => k !== 'acp');
  if (bad.length)
    throw new ConfigError(`${file}: role '${name}' session_options: unknown key(s) ${bad.join(', ')}`);
  if (!isPlainObject(merged.acp))
    throw new ConfigError(`${file}: role '${name}' session_options.${session} must be a map`);
  const acpBad = Object.keys(merged.acp).filter(k => k !== 'command');
  if (acpBad.length)
    throw new ConfigError(`${file}: role '${name}' session_options.acp: unknown key(s) ${acpBad.join(', ')}`);
  const command = merged.acp.command;
  if (command !== undefined
      && !(typeof command === 'string' && command.trim())
      && !(Array.isArray(command) && command.length > 0
        && command.every(v => typeof v === 'string' && v.length > 0)))
    throw new ConfigError(
      `${file}: role '${name}' session_options.acp.command must be a non-empty string or string list`);
  return Object.keys(merged.acp).length ? merged : undefined;
}

export function resolvePermissions(
  defaults: unknown, role: Partial<CommonPermissions> | undefined,
  file = 'config', name = 'role',
): CommonPermissions {
  if (defaults !== undefined && !isPlainObject(defaults))
    throw new ConfigError(`${file}: defaults.permissions must be a map`);
  if (role !== undefined && !isPlainObject(role))
    throw new ConfigError(`${file}: role '${name}' permissions must be a map`);
  const merged = {
    ...((defaults ?? {}) as Partial<CommonPermissions>),
    ...(role ?? {}),
  };
  const allowed = ['approval', 'filesystem', 'unattended'];
  const bad = Object.keys(merged).filter(k => !allowed.includes(k));
  if (bad.length)
    throw new ConfigError(`${file}: role '${name}' permissions: unknown key(s) ${bad.join(', ')}`);
  if (merged.approval !== undefined && !['ask', 'auto', 'allow', 'deny'].includes(merged.approval))
    throw new ConfigError(
      `${file}: role '${name}' permissions.approval must be one of: ask, auto, allow ` +
      `(deprecated alias: deny)`);
  if (merged.filesystem !== undefined
      && !['read-only', 'workspace', 'unrestricted'].includes(merged.filesystem))
    throw new ConfigError(
      `${file}: role '${name}' permissions.filesystem must be one of: read-only, workspace, unrestricted`);
  if (merged.unattended !== undefined && !['deny', 'wait'].includes(merged.unattended))
    throw new ConfigError(`${file}: role '${name}' permissions.unattended must be one of: deny, wait`);
  return {
    approval: merged.approval ?? 'ask',
    filesystem: merged.filesystem ?? 'workspace',
    unattended: merged.unattended ?? 'deny',
  };
}

/** Validate the top-level `start_stagger_ms` (supervisor launch spacing); default 0. */
function resolveStartStaggerMs(raw: unknown, base: string): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
    throw new ConfigError(
      `${base}: start_stagger_ms must be a non-negative number of milliseconds (got ${JSON.stringify(raw)})`);
  return raw;
}

/**
 * Merge `defaults.monitor` under the role's own `monitor:` key-by-key, validate the
 * result, and fill code-constant defaults. `monitor.mode` selects
 * fleet-owned or native-harness monitoring; absent everywhere ⇒ fleet. The old
 * `enabled` boolean remains a compatibility alias. Throws ConfigError on a
 * malformed block so a typo fails loudly rather than silently disarming a monitor.
 * Exported so temp-spawn (which builds a ResolvedRole by hand) resolves identically.
 */
export function resolveMonitorConfig(
  defMonitor: unknown, roleMonitor?: Partial<MonitorConfig>,
  labels: { base?: string; file?: string; name?: string } = {},
): MonitorConfig {
  const where = labels.file && labels.name ? `${labels.file}: role '${labels.name}' ` : '';
  if (defMonitor !== undefined && !isPlainObject(defMonitor))
    throw new ConfigError(`${labels.base ?? 'config'}: defaults.monitor must be a map`);
  if (roleMonitor !== undefined && !isPlainObject(roleMonitor))
    throw new ConfigError(`${where}monitor: must be a mapping`);
  const def = (defMonitor ?? {}) as Record<string, unknown>;
  const own = (roleMonitor ?? {}) as Record<string, unknown>;
  const defProblems = validateMonitorConfig(def);
  if (defProblems.length)
    throw new ConfigError(`${labels.base ?? 'config'}: defaults.${defProblems.join('; defaults.')}`);
  const ownProblems = validateMonitorConfig(own);
  if (ownProblems.length) throw new ConfigError(`${where}${ownProblems.join('; ')}`);
  const merged: Record<string, unknown> = {
    ...def,
    ...own,
  };
  const selected = own.mode !== undefined
    ? own.mode
    : own.enabled !== undefined
      ? (own.enabled ? 'fleet' : 'native')
      : def.mode !== undefined
        ? def.mode
        : def.enabled !== undefined
          ? (def.enabled ? 'fleet' : 'native')
          : 'fleet';
  const mode = selected as MonitorMode;
  return {
    mode,
    enabled: mode === 'fleet',
    wake_sources: (merged.wake_sources as string[] | undefined) ?? [...DEFAULT_WAKE_SOURCES],
    batch_ms: (merged.batch_ms as number | undefined) ?? MONITOR_DEFAULT_BATCH_MS,
    inject: (merged.inject as InjectMode | undefined) ?? 'notification',
    interrupt: (merged.interrupt as MonitorInterrupt | undefined) ?? false,
    turn_fail_threshold:
      (merged.turn_fail_threshold as number | undefined) ?? MONITOR_DEFAULT_TURN_FAIL_THRESHOLD,
  };
}

export function findRole(cfg: FleetConfig, name: string): ResolvedRole {
  const r = cfg.roles.find(r => r.name === name);
  if (!r) throw new ConfigError(`no such role '${name}' in ${cfg.files.join(', ') || 'config'}`);
  return r;
}
