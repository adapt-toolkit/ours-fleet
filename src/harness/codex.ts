import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDir, home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import type {
  AcpLaunch, HarnessAdapter, RoleDirs, SessionPrep, ValidationError,
  UnattendedCapability,
} from './types.js';
import { registerAdapter } from './registry.js';
import { harnessRuntimeDir } from '../isolation/policy.js';
import {
  resolveBundledAcpAgent, type AcpAgentResolution,
} from './acp-agent.js';
import { CodexAgentSessionAdapter } from './codex-session.js';
import type { AcpSessionTransport } from './acp-session-transport.js';
import type { CodexAppServerSessionTransport } from './codex-session.js';

interface CodexOptions {
  launcher?: string;
  sandbox?: string;
  approval?: string;
  permission_mode?: string;
  search?: boolean;
  profile?: string;
  config?: Record<string, unknown>;
  add_dirs?: string[];
  monitor?: boolean;
}
const OPTION_KEYS = [
  'launcher', 'sandbox', 'approval', 'permission_mode', 'search', 'profile', 'config', 'add_dirs',
  'monitor',
];

const LAUNCHERS = ['auto', 'ours-codex', 'codex'];

/** Codex CLI's accepted `--sandbox` values. */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
/** Codex CLI's accepted `--ask-for-approval` values. */
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];
const NATIVE_CONFIG_ALLOWLIST = new Set(['model_reasoning_effort']);
const BUNDLED_CODEX_ACP_VERSION = '1.1.7';
const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp';
const CODEX_PROXY_APPROVAL_ENV = 'OURS_FLEET_CODEX_APPROVAL';
const CODEX_PROXY_SANDBOX_ENV = 'OURS_FLEET_CODEX_SANDBOX';
const CODEX_PROXY_REAL_PATH_ENV = 'OURS_FLEET_REAL_CODEX_PATH';
const CODEX_PROXY_MANIFEST_ENV = 'OURS_FLEET_CODEX_ACP_MANIFEST';

/**
 * What an unattended role can actually do under Codex's native settings.
 * `on-request` and `untrusted` stop to ask, and with no console attached that
 * request is refused rather than answered — so the role can only read.
 */
export function codexCapabilities(approval: string, sandbox: string): UnattendedCapability[] {
  if (approval !== 'never') return ['read-state'];
  const caps: UnattendedCapability[] = ['read-state', 'messaging', 'monitor', 'status-commands'];
  if (sandbox !== 'read-only') caps.push('write-state', 'workspace-edit');
  return caps;
}

/** Resolve & validate the per-role sandbox mode, throwing on an unknown value. */
function sandboxMode(role: ResolvedRole): string | undefined {
  const s = (role.harness_options as CodexOptions | undefined)?.sandbox;
  if (s == null) {
    const filesystem = role.permissions?.filesystem;
    if (filesystem === 'read-only') return 'read-only';
    if (filesystem === 'unrestricted') return 'danger-full-access';
    if (filesystem === 'workspace') return 'workspace-write';
    return undefined;
  }
  if (!SANDBOX_MODES.includes(s))
    throw new Error(`invalid harness_options.sandbox "${s}"; allowed: ${SANDBOX_MODES.join(', ')}`);
  return s;
}

function modeForSandbox(sandbox: string | undefined): string | undefined {
  if (sandbox === 'read-only') return 'read-only';
  if (sandbox === 'workspace-write') return 'agent';
  if (sandbox === 'danger-full-access') return 'agent-full-access';
  return undefined;
}

/**
 * Resolve the coupled Codex ACP mode.
 *
 * The portable approval contract owns the default mode selection: `allow`
 * means the adapter's fully non-interactive yolo preset and `auto` means its
 * ordinary agent preset. This intentionally means that Codex ACP cannot retain
 * an independent neutral filesystem posture for those two modes. An explicit
 * native sandbox remains authoritative and selects its corresponding preset.
 */
function acpAgentMode(role: ResolvedRole): string | undefined {
  const explicitSandbox = (role.harness_options as CodexOptions | undefined)?.sandbox;
  if (explicitSandbox != null) return modeForSandbox(sandboxMode(role));
  if (role.permissions?.approval === 'allow') return 'agent-full-access';
  if (role.permissions?.approval === 'auto') return 'agent';
  const sandbox = sandboxMode(role);
  return modeForSandbox(sandbox);
}

function acpModePermissions(mode: string | undefined): {
  approval: string; sandbox: string;
} {
  if (mode === 'read-only') return { approval: 'on-request', sandbox: 'read-only' };
  if (mode === 'agent-full-access')
    return { approval: 'never', sandbox: 'danger-full-access' };
  return { approval: 'on-request', sandbox: 'workspace-write' };
}

/** The sandbox Codex will actually receive from the selected coupled ACP mode. */
function acpRuntimeSandbox(role: ResolvedRole): string {
  return acpModePermissions(acpAgentMode(role)).sandbox;
}

function fleetModeForApproval(nativeMode: string): 'ask' | 'auto' | 'allow' {
  if (nativeMode === 'never') return 'allow';
  if (nativeMode === 'on-request') return 'auto';
  if (nativeMode === 'untrusted') return 'ask';
  throw new Error(`unsupported Codex approval policy '${nativeMode}'`);
}

/** Resolve & validate the per-role approval policy, throwing on an unknown value. */
function approvalPolicy(role: ResolvedRole): string | undefined {
  const o = role.harness_options as CodexOptions | undefined;
  const a = o?.approval ?? o?.permission_mode;
  if (a == null) {
    const approval = role.permissions?.approval;
    if (approval === 'allow') return 'never';
    if (approval === 'auto' || approval === 'deny') return 'on-request';
    if (approval === 'ask') return 'untrusted';
    return undefined;
  }
  if (!APPROVAL_POLICIES.includes(a))
    throw new Error(`invalid harness_options.approval "${a}"; allowed: ${APPROVAL_POLICIES.join(', ')}`);
  return a;
}

/** Native app-server policy comes only from Fleet's public permission contract. */
function neutralApprovalPolicy(role: ResolvedRole): string {
  if (role.permissions?.approval === 'allow') return 'never';
  if (role.permissions?.approval === 'ask') return 'untrusted';
  return 'on-request';
}

/** Native app-server sandbox comes only from Fleet's public filesystem contract. */
function neutralSandboxMode(role: ResolvedRole): string {
  if (role.permissions?.filesystem === 'read-only') return 'read-only';
  if (role.permissions?.filesystem === 'unrestricted') return 'danger-full-access';
  return 'workspace-write';
}

/** Native config is fail-closed because Codex adds authority-bearing keys over time. */
function isNativeConfigKeyAllowed(key: string): boolean {
  return NATIVE_CONFIG_ALLOWLIST.has(key);
}

/** Defense in depth for callers which launch a role after validation was bypassed. */
export function nativeCodexConfig(role: ResolvedRole): Record<string, unknown> | undefined {
  const options = role.harness_options as CodexOptions | undefined;
  if (!options?.config) return undefined;
  return Object.fromEntries(Object.entries(options.config)
    .filter(([key]) => isNativeConfigKeyAllowed(key)));
}

function launcherMode(role: ResolvedRole): string {
  return (role.harness_options as CodexOptions | undefined)?.launcher ?? 'auto';
}

function bundledCodexAcp() {
  return resolveBundledAcpAgent(CODEX_ACP_PACKAGE, 'codex-acp', 'codex-acp');
}

function codexAgentLaunch(role: ResolvedRole, prep: SessionPrep): AcpLaunch {
  if (role.session === 'codex-app-server') {
    const configured = role.session_options?.codex_app_server?.command;
    if (Array.isArray(configured)) return { argv: [...configured], env: prep.env };
    if (typeof configured === 'string')
      return { argv: ['sh', '-c', configured], env: prep.env };
    const launcher = launcherMode(role);
    const options = role.harness_options as CodexOptions | undefined;
    const flags = [
      ...(options?.search ? ['--search'] : []),
      'app-server',
    ];
    // Preserve the established `auto` launcher contract without resolving PATH
    // during synchronous launch preparation. The static shell fragment passes
    // every dynamic value as an argv element and `exec`s the selected process.
    if (launcher === 'auto') return {
      argv: [
        'sh', '-c',
        'if command -v ours-codex >/dev/null 2>&1; then exec ours-codex "$@"; else exec codex "$@"; fi',
        'ours-fleet-codex', ...flags,
      ],
      env: prep.env,
    };
    const command = launcher === 'ours-codex' ? 'ours-codex' : 'codex';
    return {
      argv: [command, ...flags],
      env: prep.env,
    };
  }
  const configured = role.session_options?.acp?.command;
  const resolved = configured == null
    ? codexAcpLaunchForResolution(bundledCodexAcp())
    : undefined;
  const argv = Array.isArray(configured)
    ? [...configured]
    : typeof configured === 'string'
      ? ['sh', '-c', configured]
      : resolved!.argv;
  const initialMode = acpAgentMode(role);
  return {
    argv,
    env: initialMode ? { ...prep.env, INITIAL_AGENT_MODE: initialMode } : prep.env,
    ...(resolved?.permissionMetadataSource
      ? { permissionMetadataSource: resolved.permissionMetadataSource } : {}),
  };
}

/** Bind launch argv and metadata provenance to one already-completed resolution. */
export function codexAcpLaunchForResolution(
  resolution: AcpAgentResolution,
): Pick<AcpLaunch, 'argv' | 'permissionMetadataSource'> {
  const permissionMetadataSource = resolution.bundled
    && resolution.version === BUNDLED_CODEX_ACP_VERSION
    && resolution.manifestPath !== undefined
    ? 'codex-acp' as const
    : undefined;
  return {
    argv: [...resolution.argv],
    ...(permissionMetadataSource ? { permissionMetadataSource } : {}),
  };
}

function canOverrideBundledAcpApproval(): boolean {
  const resolution = bundledCodexAcp();
  return resolution.bundled && resolution.version === BUNDLED_CODEX_ACP_VERSION
    && resolution.manifestPath !== undefined && compiledProxyModule() !== undefined;
}

function compiledProxyModule(): string | undefined {
  const adjacent = fileURLToPath(new URL('./codex-app-server-proxy.js', import.meta.url));
  if (existsSync(adjacent)) return adjacent;
  // Vitest imports src/ directly; globalSetup builds the executable module in dist/.
  const fromSource = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/harness',
    'codex-app-server-proxy.js');
  if (existsSync(fromSource)) return fromSource;
  return undefined;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Materialize the tiny CODEX_PATH executable inside the role's own state dir.
 * Keeping it there makes the proxy available under both ordinary and isolated
 * launches without adding another host path to the filesystem boundary.
 */
function codexAcpEnvironment(role: ResolvedRole, dirs: RoleDirs): Record<string, string> {
  if (role.session !== 'acp' || role.session_options?.acp?.command != null) return {};
  const resolution = bundledCodexAcp();
  if (!resolution.bundled || resolution.version !== BUNDLED_CODEX_ACP_VERSION
      || !resolution.manifestPath) return {};
  const runtimeDir = harnessRuntimeDir(dirs.stateDir, 'codex');
  mkdirSync(runtimeDir, { recursive: true });
  const proxyModule = join(runtimeDir, 'app-server-proxy.mjs');
  const source = compiledProxyModule();
  if (!source) throw new Error('Codex app-server proxy is missing; rebuild ours-fleet');
  writeFileSync(proxyModule, readFileSync(source, 'utf8'), { mode: 0o600 });
  const windows = process.platform === 'win32';
  const command = join(runtimeDir, windows ? 'codex-app-server-proxy.cmd' : 'codex-app-server-proxy');
  const script = windows
    ? `@echo off\r\n"${process.execPath.replaceAll('"', '""')}" "${proxyModule.replaceAll('"', '""')}" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(proxyModule)} "$@"\n`;
  writeFileSync(command, script, { mode: 0o700 });
  chmodSync(command, 0o700);
  return {
    CODEX_PATH: command,
    [CODEX_PROXY_APPROVAL_ENV]: approvalPolicy(role) ?? 'on-request',
    [CODEX_PROXY_SANDBOX_ENV]: acpRuntimeSandbox(role),
    [CODEX_PROXY_MANIFEST_ENV]: resolution.manifestPath,
    ...(process.env.CODEX_PATH ? { [CODEX_PROXY_REAL_PATH_ENV]: process.env.CODEX_PATH } : {}),
  };
}

function encodeTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.every(v => ['string', 'boolean', 'number'].includes(typeof v)))
    return `[${value.map(encodeTomlValue).join(', ')}]`;
  throw new Error('must be a string, finite number, boolean, or array of those values');
}

/** Flags shared by fresh launch and resume: model, sandbox, approval, search. */
function commonFlags(role: ResolvedRole): string[] {
  const o = (role.harness_options ?? {}) as CodexOptions;
  const search = o.search === true;
  const sm = sandboxMode(role);
  const ap = approvalPolicy(role);
  return [
    ...(role.model ? ['--model', role.model] : []),
    ...(o.profile ? ['--profile', o.profile] : []),
    ...(sm ? ['--sandbox', sm] : []),
    ...(ap ? ['--ask-for-approval', ap] : []),
    ...(search ? ['--search'] : []),
    ...(o.add_dirs ?? []).flatMap(dir => ['--add-dir', dir]),
    ...Object.entries(o.config ?? {}).flatMap(([key, value]) => ['--config', `${key}=${encodeTomlValue(value)}`]),
  ];
}

async function commandAvailable(command: string, exec: Exec): Promise<boolean> {
  const r = await exec('sh', ['-c', `command -v ${command} >/dev/null 2>&1`]);
  return r.code === 0;
}

function hasInstalledOursPlugin(output: string): boolean {
  try {
    const value = JSON.parse(output) as { installed?: Array<Record<string, unknown>> };
    return (value.installed ?? []).some(plugin =>
      (plugin.name === 'ours' || (typeof plugin.pluginId === 'string' && plugin.pluginId.startsWith('ours@')))
      && plugin.installed === true
      && plugin.enabled === true);
  } catch { return false; }
}

export function makeCodexAdapter(
  exec: Exec = realExec, transport?: AcpSessionTransport,
  nativeTransport?: CodexAppServerSessionTransport,
): HarnessAdapter {
  return {
    id: 'codex',
    agentSession: new CodexAgentSessionAdapter({
      resolveBrain(brain) {
        const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
        if (brain.effort != null
            && (typeof brain.effort !== 'string' || !levels.includes(brain.effort)))
          throw new Error(`Codex Brain effort must be one of: ${levels.join(', ')}`);
        const harnessOptions = { ...(brain.harnessOptions ?? {}) };
        if (brain.effort) harnessOptions.config = {
          ...((harnessOptions.config ?? {}) as Record<string, unknown>),
          model_reasoning_effort: brain.effort,
        };
        return { model: brain.model, harnessOptions };
      },
      modelEnvironmentVariable: () => undefined,
      prepareLaunch(role, prep) {
        const launch = codexAgentLaunch(role, prep);
        const { permissionMetadataSource, ...neutral } = launch;
        return {
          ...neutral,
          ...(permissionMetadataSource
            ? { adapterState: { permissionMetadataSource } } : {}),
        };
      },
      sessionConfigSelections: role => [
        ...(typeof role.model === 'string'
          ? [{ configId: 'model', value: role.model }] : []),
        ...(typeof role.effort === 'string'
          ? [{ configId: 'reasoning_effort', value: role.effort }] : []),
      ],
      permissionModeId: role => acpAgentMode(role),
      mcpServers: () => undefined,
      sessionMeta: () => undefined,
      approvalPolicy: neutralApprovalPolicy,
      sandbox: neutralSandboxMode,
      nativeConfig: nativeCodexConfig,
      addDirs: role => (role.harness_options as CodexOptions | undefined)?.add_dirs,
    }, transport, nativeTransport),
    supportsResume: true,

    async checkPrereqs() {
      const [r, hasOursCodex, plugins] = await Promise.all([
        exec('codex', ['--version']),
        commandAvailable('ours-codex', exec),
        exec('codex', ['plugin', 'list', '--json']),
      ]);
      const ok = r.code === 0;
      const hasOursPlugin = plugins.code === 0 && hasInstalledOursPlugin(plugins.stdout);
      return {
        ok: ok && hasOursPlugin,
        checks: [
          {
            name: 'codex',
            ok,
            detail: ok ? r.stdout.trim() : 'codex CLI not found on PATH — install the Codex CLI and log in',
          },
          {
            name: 'ours-codex',
            // Optional by design: plain Codex is the supported fallback.
            ok: true,
            detail: hasOursCodex
              ? 'available — fleet roles use native background mail wake'
              : 'not found — fleet roles fall back to codex with foreground monitoring; install @ours.network/codex for background wake',
          },
          {
            name: 'ours plugin',
            ok: hasOursPlugin,
            detail: hasOursPlugin
              ? 'installed and enabled — ours tools and monitor tools are available'
              : 'not installed — run: npm i -g @ours.network/codex && ours-codex-install',
          },
        ],
      };
    },

    validateOptions(opts: unknown, role?: ResolvedRole): ValidationError[] {
      if (opts == null) return [];
      if (typeof opts !== 'object' || Array.isArray(opts))
        return [{ path: 'harness_options', message: 'must be a map' }];
      const errs: ValidationError[] = Object.keys(opts)
        .filter(k => !OPTION_KEYS.includes(k))
        .map(k => ({ path: `harness_options.${k}`, message: `unknown option; allowed: ${OPTION_KEYS.join(', ')}` }));
      const o = opts as CodexOptions;
      if (role?.session === 'codex-app-server') {
        if (o.profile != null)
          errs.push({
            path: 'harness_options.profile',
            message: 'is not accepted for codex-app-server; Codex rejects --profile for app-server',
          });
        if (o.approval != null)
          errs.push({
            path: 'harness_options.approval',
            message: 'is not accepted for codex-app-server; use permissions.approval: ask|auto|allow',
          });
        if (o.permission_mode != null)
          errs.push({
            path: 'harness_options.permission_mode',
            message: 'is not accepted for codex-app-server; use permissions.approval: ask|auto|allow',
          });
        if (o.sandbox != null)
          errs.push({
            path: 'harness_options.sandbox',
            message: 'is not accepted for codex-app-server; use permissions.filesystem: read-only|workspace|unrestricted',
          });
      }
      if (o.launcher != null && !LAUNCHERS.includes(o.launcher))
        errs.push({ path: 'harness_options.launcher', message: `must be one of: ${LAUNCHERS.join(', ')}` });
      if (o.sandbox != null && !SANDBOX_MODES.includes(o.sandbox))
        errs.push({ path: 'harness_options.sandbox', message: `must be one of: ${SANDBOX_MODES.join(', ')}` });
      if (o.approval != null && !APPROVAL_POLICIES.includes(o.approval))
        errs.push({ path: 'harness_options.approval', message: `must be one of: ${APPROVAL_POLICIES.join(', ')}` });
      if (o.permission_mode != null && !APPROVAL_POLICIES.includes(o.permission_mode))
        errs.push({ path: 'harness_options.permission_mode', message: `must be one of: ${APPROVAL_POLICIES.join(', ')}` });
      if (o.approval != null && o.permission_mode != null && o.approval !== o.permission_mode)
        errs.push({ path: 'harness_options.permission_mode', message: 'conflicts with harness_options.approval' });
      if (o.search != null && typeof o.search !== 'boolean')
        errs.push({ path: 'harness_options.search', message: 'must be a boolean' });
      if (o.monitor != null && typeof o.monitor !== 'boolean')
        errs.push({ path: 'harness_options.monitor', message: 'must be a boolean' });
      if (o.profile != null && (typeof o.profile !== 'string' || !o.profile.trim()))
        errs.push({ path: 'harness_options.profile', message: 'must be a non-empty profile name' });
      if (o.add_dirs != null && (!Array.isArray(o.add_dirs) || o.add_dirs.some(v => typeof v !== 'string' || !v)))
        errs.push({ path: 'harness_options.add_dirs', message: 'must be an array of non-empty paths' });
      if (o.config != null) {
        if (typeof o.config !== 'object' || Array.isArray(o.config))
          errs.push({ path: 'harness_options.config', message: 'must be a map of Codex config keys to TOML scalar/array values' });
        else for (const [key, value] of Object.entries(o.config)) {
          if (role?.session === 'codex-app-server' && !isNativeConfigKeyAllowed(key)) {
            errs.push({
              path: `harness_options.config.${key}`,
              message: 'is not accepted for codex-app-server; only model_reasoning_effort is allowed',
            });
            continue;
          }
          try { encodeTomlValue(value); }
          catch (e) { errs.push({ path: `harness_options.config.${key}`, message: (e as Error).message }); }
        }
      }
      return errs;
    },

    async prepareSession(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep> {
      // Per-role harness runtime home; harmless for un-isolated roles.
      // Only a role that declares `isolation:` gets a sandbox, and only a
      // sandbox needs this directory to exist before entry.
      if (role.isolation) mkdirSync(harnessRuntimeDir(dirs.stateDir, 'codex'), { recursive: true });
      return {
        // OURS_BIND_IDENTITY is the connector's startup bind seed — see the note in
        // claude-code.ts's prepareSession. It belongs on EVERY harness that runs a
        // role with an ours identity, not just claude-code: a seed that works on one
        // harness and silently does nothing on the other is the same class of defect
        // as a config key that only works on one session type.
        env: { OURS_BIND_IDENTITY: role.identity, ...codexAcpEnvironment(role, dirs) },
      };
    },

    isolationPaths(role: ResolvedRole, _dirs: RoleDirs) {
      const codexHome = join(home(), '.codex');
      const profile = (role.harness_options as CodexOptions | undefined)?.profile;
      return {
        home: codexHome,
        // Credentials, shared config, shared instructions, and the role's own
        // profile file if it names one. Sessions, history, caches and the local
        // sqlite stores are runtime state and stay per-role.
        shared: [
          join(codexHome, 'auth.json'),
          join(codexHome, 'config.toml'),
          join(codexHome, 'AGENTS.md'),
          join(codexHome, 'plugins'),
          ...(profile ? [join(codexHome, `${profile}.config.toml`)] : []),
          join(home(), '.agents'),
        ],
      };
    },

    nativePermissionOverrides(options: unknown, role?: ResolvedRole): Record<string, unknown> {
      if (role?.session === 'codex-app-server') return {};
      const o = options as CodexOptions | undefined;
      const approval = o?.approval ?? o?.permission_mode;   // permission_mode is the alias
      return {
        ...(approval == null ? {} : { approval }),
        ...(o?.sandbox == null ? {} : { sandbox: o.sandbox }),
      };
    },

    translatePermissions(permissions) {
      const approval = permissions.approval === 'allow' ? 'never'
        : permissions.approval === 'ask' ? 'untrusted' : 'on-request';
      const sandbox = permissions.filesystem === 'read-only'
        ? 'read-only'
        : permissions.filesystem === 'unrestricted'
          ? 'danger-full-access'
          : 'workspace-write';
      return {
        supported: true,
        native: { approval, sandbox },
        exact: true,
        warnings: [],
        capabilities: codexCapabilities(approval, sandbox),
      };
    },

    effectivePermissions(role) {
      const translated = this.translatePermissions(role.permissions);
      if (!translated.supported) return translated;
      if (role.session === 'codex-app-server') return translated;
      const approval = approvalPolicy(role) ?? 'on-request';
      const sandbox = sandboxMode(role) ?? 'workspace-write';
      if (role.session === 'acp') {
        const mode = acpAgentMode(role) ?? 'agent';
        const configured = role.session_options?.acp?.command;
        const overrideAvailable = configured == null && canOverrideBundledAcpApproval();
        const actual = overrideAvailable
          ? { approval, sandbox: acpRuntimeSandbox(role) }
          : acpModePermissions(mode);
        const exact = actual.approval === approval && actual.sandbox === sandbox;
        return {
          ...translated,
          native: { mode, ...actual },
          exact,
          warnings: exact ? [] : [configured != null
            ? `custom ACP command cannot be verified against approval=${approval} sandbox=${sandbox}; `
              + `its '${mode}' mode is conservatively treated as approval=${actual.approval} `
              + `sandbox=${actual.sandbox}`
            : `Codex ACP mode '${mode}' couples approval and filesystem as `
              + `approval=${actual.approval} sandbox=${actual.sandbox}; this does not exactly `
              + `represent approval=${approval} sandbox=${sandbox}`],
          capabilities: codexCapabilities(actual.approval, actual.sandbox),
        };
      }
      return translated;
    },

    effectivePermissionMode(role) {
      if (role.session === 'acp') {
        const nativeMode = acpAgentMode(role) ?? 'agent';
        if (role.session_options?.acp?.command == null && canOverrideBundledAcpApproval()) {
          const approval = approvalPolicy(role) ?? 'on-request';
          return { fleetMode: fleetModeForApproval(approval), nativeMode };
        }
        return {
          fleetMode: fleetModeForApproval(acpModePermissions(nativeMode).approval), nativeMode,
        };
      }
      const nativeMode = neutralApprovalPolicy(role);
      return { fleetMode: fleetModeForApproval(nativeMode), nativeMode };
    },

    inheritedPermissionMode(role) {
      if (role.session === 'codex-app-server')
        return fleetModeForApproval(neutralApprovalPolicy(role));
      return fleetModeForApproval(approvalPolicy(role) ?? 'untrusted');
    },

    vocabulary: {
      bindTool: 'choose_identity',
      createTool: 'create_identity',
      temporaryCreateTool: 'create_temporary_identity',
      setBioTool: 'set_bio',
      setPersonaTool: 'set_persona',
      currentIdentityTool: 'current_identity',
      sendTool: 'send_message',
      getMessagesTool: 'get_messages',
      listHistoryTool: 'list_history',
      getHistoryItemTool: 'get_history_item',
      monitorInstruction: (id, configuredRole) => {
        const consented = (configuredRole?.harness_options as CodexOptions | undefined)?.monitor === true;
        const consent = consented
          ? `The fleet owner explicitly consented in configuration with \`harness_options.monitor: true\`. ` +
            `Call **arm_monitor** for identity "${id}" after binding. `
          : `Ask the fleet owner in this console whether to arm mail monitoring for "${id}". ` +
            `Do not call **arm_monitor** until they explicitly say yes; if they decline, leave it ` +
            `disarmed and check mail only when asked. `;
        return consent +
          `Under \`ours-codex\` this arms session-scoped background wake. If the tool reports that ` +
          `only standard Codex is available, surface its \`ours-codex\` recommendation and ask ` +
          `separately before calling **foreground_monitor**; that blocking wait is the supported ` +
          `fallback. After each arrival, call **get_messages**, handle the mail, and re-enter ` +
          `**foreground_monitor** while the approved monitoring session remains armed.`;
      },
      supervisedWakeNote: () =>
        'Your mail wake-ups are delivered by the fleet supervisor directly into this console as ' +
        '`[fleet-monitor]` lines — do NOT arm arm_monitor or foreground_monitor. When such a line ' +
        'appears, call **get_messages**, handle the mail, and reply with send_message.',
      launchNote: name => `You were launched as the fleet role \`${name}\` under a Codex session. Confirm you are running.`,
      restartPrompt: (id, worklog, configuredRole) => {
        if (configuredRole?.monitor?.mode === 'fleet')
          return `Session restarted. Re-bind your ours identity now (choose_identity name "${id}" force=true); ` +
            'your mail wakes are delivered by the fleet supervisor as `[fleet-monitor]` console lines, so do ' +
            `NOT arm arm_monitor/foreground_monitor. Continue from ${worklog}. Do not re-run whatever crashed you.`;
        const consented = (configuredRole?.harness_options as CodexOptions | undefined)?.monitor === true;
        return `Session restarted. Re-bind your ours identity now (choose_identity name "${id}" force=true), ` +
          (consented
            ? `then call arm_monitor for "${id}"; monitor consent is persisted in fleet configuration. `
            : `then ask the fleet owner before arming monitoring for "${id}". `) +
          `If this is the native-codex fallback, follow the tool's foreground_monitor consent flow and ` +
          `re-enter it after handling each message. Continue from ${worklog}. Do not re-run whatever crashed you.`;
      },
    },

    exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
  };
}

// The adapter needs the state dir for briefing/worklog paths in launch prompts.
// Roles' state dirs are canonical: agentDir(name) — temp roles carry their dir in cwd handling
// by the runner, which passes dirs to prepareSession.
function roleStateDir(role: ResolvedRole): string {
  // Temp roles are marked by the runner via a private field to keep the interface small.
  const temp = (role as ResolvedRole & { __temp?: boolean }).__temp === true;
  return agentDir(role.name, temp);
}

export const codexAdapter = makeCodexAdapter();
registerAdapter(codexAdapter);
