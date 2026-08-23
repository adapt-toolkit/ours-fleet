import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, defaultConfigPath, fleetDDir, home } from './paths.js';
import {
  parseFleetDocument, type ConfigDiagnostic, type YamlMode,
} from './config-yaml.js';
import {
  harnessRuntimeDir, resolveIsolation, validateIsolationConfig,
} from './isolation/policy.js';
import { getAdapter } from './harness/registry.js';
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

export interface OverseeEntry { role: string; interval: string }
export interface WorklogPolicy {
  max_kb: number;
  keep_tail_kb: number;
  max_archives: number;
}
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
export type SessionBackendId = 'tmux' | 'acp';
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
  tmux?: {
    boot_grace_ms?: number;
  };
}

/** Resolved per-role supervisor-monitor config (see DESIGN-external-monitor §2). */
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
  allowed_mime: string[];
}

export type OwnerChannelConfigInput = Omit<Partial<OwnerChannelConfig>, 'attachments'> & {
  attachments?: Partial<OwnerAttachmentConfig>;
};

export const DEFAULT_OWNER_ATTACHMENT_MIME = [
  'application/pdf', 'application/json', 'text/plain',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/webm',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

/** Default wake sources when a role does not list its own (design §2). */
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
  model_chain?: string[];
  max_tokens?: number;
  autocompact_pct?: number;
  env?: Record<string, string>;
  oversee?: OverseeEntry[];
  harness_options?: Record<string, unknown>;
  isolation?: IsolationConfig;
  monitor?: Partial<MonitorConfig>;
  owner_channel?: OwnerChannelConfigInput;
  worklog?: WorklogPolicy;
  auth_proxy?: Partial<AuthProxyConfig>;
}

export interface ResolvedRole extends Omit<RoleConfig, 'model' | 'owner_channel'> {
  name: string;
  harness: string;
  session: SessionBackendId;
  permissions: CommonPermissions;
  /**
   * Whether `permissions:` was actually written by the operator (on the role or
   * in defaults), as opposed to resolved from built-in defaults. A role that
   * states its intent only once — neutrally OR natively — has nothing to
   * contradict, and must not be warned at (2.4).
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
}

export interface FleetConfig {
  roles: ResolvedRole[];
  vars: Record<string, string>;
  defaults: Record<string, unknown>;
  files: string[];
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
  // Ask the harness how its host state splits (5.1). An adapter that declares
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

export const ROLE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const ROLE_KEYS = [
  'harness', 'session', 'session_options', 'permissions', 'identity', 'cwd', 'coordinator', 'mission', 'persona', 'bio',
  'briefing_file', 'model', 'model_chain', 'max_tokens', 'autocompact_pct', 'env', 'oversee', 'harness_options',
  'isolation', 'monitor', 'owner_channel', 'worklog', 'auth_proxy',
];

function deepSub(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map(x => deepSub(x, vars));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(x, vars)]));
  return v;
}

/** Load ~/fleet.yaml (or an explicit path) merged with ~/fleet.d/*.yaml drop-ins. */
export function loadConfig(
  configPath?: string,
  options: { yamlMode?: YamlMode } = {},
): FleetConfig {
  const base = configPath ?? defaultConfigPath();
  const files: string[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const docs: { file: string; doc: Record<string, unknown> }[] = [];
  if (existsSync(base)) {
    const parsed = parseFleetDocument(base, readFileSync(base, 'utf8'), options.yamlMode);
    docs.push({ file: base, doc: parsed.value });
    diagnostics.push(...parsed.diagnostics);
    files.push(base);
  } else if (configPath) {
    throw new ConfigError(`config not found: ${base}`);
  }
  const dd = fleetDDir();
  if (existsSync(dd)) {
    for (const f of readdirSync(dd).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort()) {
      const p = join(dd, f);
      const parsed = parseFleetDocument(p, readFileSync(p, 'utf8'), options.yamlMode);
      const doc = parsed.value;
      diagnostics.push(...parsed.diagnostics);
      const FLEET_D_ALLOWED = ['roles', 'rooms', 'room_templates', 'tasks'];
      const extra = Object.keys(doc).filter(k => !FLEET_D_ALLOWED.includes(k));
      if (extra.length)
        throw new ConfigError(`${p}: fleet.d files may only define ${FLEET_D_ALLOWED.join(', ')}: (found: ${extra.join(', ')})`);
      docs.push({ file: p, doc });
      files.push(p);
    }
  }
  const baseDoc = docs.length && docs[0].file === base ? docs[0].doc : {};
  const vars = (baseDoc.vars ?? {}) as Record<string, string>;
  const defaults = (baseDoc.defaults ?? {}) as Record<string, unknown>;
  const startStaggerMs = resolveStartStaggerMs(baseDoc.start_stagger_ms, base);
  const seen = new Map<string, string>();
  const roles: ResolvedRole[] = [];
  for (const { file, doc } of docs) {
    for (const [name, raw] of Object.entries((doc.roles ?? {}) as Record<string, RoleConfig | null>)) {
      if (!ROLE_NAME_RE.test(name))
        throw new ConfigError(`${file}: invalid role name '${name}' (allowed: [A-Za-z0-9_-])`);
      const prev = seen.get(name);
      if (prev) throw new ConfigError(`role '${name}' defined in both ${prev} and ${file}`);
      seen.set(name, file);
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
      const model = resolveRoleModel(r.model, r.harness, defaults);
      const modelChain = resolveModelChain(
        model,
        r.model_chain ?? (inheritsModelDefaults
          ? defaults.model_chain as string[] | undefined
          : undefined),
        file,
        name,
      );
      if (authProxy && harness !== 'claude-code')
        throw new ConfigError(`${file}: role '${name}' auth_proxy is supported only by claude-code`);
      const env = {
        ...((defaults.env ?? {}) as Record<string, string>),
        ...(r.env ?? {}),
        ...(authProxy ? { ANTHROPIC_BASE_URL: authProxy.base_url } : {}),
      };
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
        auth_proxy: authProxy,
        env: Object.keys(env).length ? env : undefined,
        loops: [],
      });
      // Forbidden-path enforcement (5.2): a mount that would breach the policy
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
  const watchdogs = resolveWatchdogs(baseDoc, base, roles, vars, defaults);
  const resolvedLoops = resolveLoops(baseDoc.loops, base, roles, vars);
  for (const role of roles) role.loops = resolvedLoops.byRole.get(role.name) ?? [];

  // ── Rooms, room_templates, tasks (split-config merge) ──────────────
  // These sections may appear in the base fleet.yaml and/or in fleet.d files.
  // Base provides defaults; fleet.d extends. Only one source may define rooms/tasks
  // top-level (room_templates merge by name, last writer wins).
  let rooms: RoomsConfig | undefined;
  let ownerInviteFingerprint: string | undefined;
  let roomTemplates: RoomTemplatesConfig | undefined;
  let tasks: TasksConfig | undefined;

  for (const { file, doc } of docs) {
    if (doc.rooms !== undefined) {
      if (rooms) throw new ConfigError(`rooms: defined in multiple files; last: ${file}`);
      const validated = validateRoomsConfig(deepSub(doc.rooms, vars), vars, file);
      ownerInviteFingerprint = validated._invite?.fingerprint;
      const { _invite: _, ...clean } = validated;
      rooms = clean;
    }
    if (doc.room_templates !== undefined) {
      const validated = validateRoomTemplatesConfig(deepSub(doc.room_templates, vars), file);
      roomTemplates = { ...(roomTemplates ?? {}), ...validated };
    }
    if (doc.tasks !== undefined) {
      if (tasks) throw new ConfigError(`tasks: defined in multiple files; last: ${file}`);
      tasks = validateTasksConfig(deepSub(doc.tasks, vars), file);
    }
  }

  return {
    roles, vars, defaults, files, startStaggerMs, diagnostics, watchdogs,
    loops: resolvedLoops.loops,
    rooms, roomTemplates, tasks, ownerInviteFingerprint,
  };
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
  } as Partial<OwnerAttachmentConfig>;
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
  const allowedMime = attachments.allowed_mime ?? [...DEFAULT_OWNER_ATTACHMENT_MIME];
  if (!Array.isArray(allowedMime) || allowedMime.length < 1 || allowedMime.length > 64
      || allowedMime.some(mime => typeof mime !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)))
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.attachments.allowed_mime must contain 1-64 lowercase MIME types`);
  if (new Set(allowedMime).size !== allowedMime.length)
    throw new ConfigError(
      `${file}: role '${name}' owner_channel.attachments.allowed_mime must not contain duplicates`);
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
      allowed_mime: [...allowedMime],
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
  defaults: unknown, role: WorklogPolicy | undefined, file = 'config', name = 'role',
): WorklogPolicy | undefined {
  if (defaults === undefined && role === undefined) return undefined;
  if (defaults !== undefined && !isPlainObject(defaults))
    throw new ConfigError(`${file}: defaults.worklog must be a map`);
  if (role !== undefined && !isPlainObject(role))
    throw new ConfigError(`${file}: role '${name}' worklog must be a map`);
  const merged = {
    ...((defaults ?? {}) as Partial<WorklogPolicy>),
    ...(role ?? {}),
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
  const value = raw ?? 'tmux';
  if (value !== 'tmux' && value !== 'acp')
    throw new ConfigError(`${file}: role '${name}' session: must be one of: tmux, acp`);
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
    tmux: {
      ...(((defaults as SessionOptions | undefined)?.tmux) ?? {}),
      ...(role?.tmux ?? {}),
    },
  };
  const bad = Object.keys(merged).filter(k => k !== 'acp' && k !== 'tmux');
  if (bad.length)
    throw new ConfigError(`${file}: role '${name}' session_options: unknown key(s) ${bad.join(', ')}`);
  if (!isPlainObject(merged.acp) || !isPlainObject(merged.tmux))
    throw new ConfigError(`${file}: role '${name}' session_options.${session} must be a map`);
  const acpBad = Object.keys(merged.acp).filter(k => k !== 'command');
  const tmuxBad = Object.keys(merged.tmux).filter(k => k !== 'boot_grace_ms');
  if (acpBad.length)
    throw new ConfigError(`${file}: role '${name}' session_options.acp: unknown key(s) ${acpBad.join(', ')}`);
  if (tmuxBad.length)
    throw new ConfigError(`${file}: role '${name}' session_options.tmux: unknown key(s) ${tmuxBad.join(', ')}`);
  const command = merged.acp.command;
  if (command !== undefined
      && !(typeof command === 'string' && command.trim())
      && !(Array.isArray(command) && command.length > 0
        && command.every(v => typeof v === 'string' && v.length > 0)))
    throw new ConfigError(
      `${file}: role '${name}' session_options.acp.command must be a non-empty string or string list`);
  const grace = merged.tmux.boot_grace_ms;
  if (grace !== undefined
      && (typeof grace !== 'number' || !Number.isFinite(grace) || grace < 0))
    throw new ConfigError(
      `${file}: role '${name}' session_options.tmux.boot_grace_ms must be a non-negative number`);
  return Object.keys(merged.acp).length || Object.keys(merged.tmux).length ? merged : undefined;
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
 * result, and fill code-constant defaults (design §2). `monitor.mode` selects
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
