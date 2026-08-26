import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDir, home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import type {
  AcpLaunch, HarnessAdapter, RoleDirs, SessionPrep, SessionState, Launch, ValidationError,
  UnattendedCapability,
} from './types.js';
import { registerAdapter } from './registry.js';
import {
  translatePortablePermissionCodes,
} from './brain-adapter.js';
import { harnessRuntimeDir } from '../isolation/policy.js';
import {
  resolveBundledAcpAgent, type AcpAgentResolution,
} from './acp-agent.js';

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
    if (filesystem) return translatePortablePermissionCodes('codex', role.permissions).legacyNative.sandbox;
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
  if (role.permissions)
    return translatePortablePermissionCodes('codex', role.permissions).coupledAcpMode;
  return undefined;
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
    if (approval)
      return translatePortablePermissionCodes('codex', role.permissions).legacyNative.approval;
    return undefined;
  }
  if (!APPROVAL_POLICIES.includes(a))
    throw new Error(`invalid harness_options.approval "${a}"; allowed: ${APPROVAL_POLICIES.join(', ')}`);
  return a;
}

function launcherMode(role: ResolvedRole): string {
  return (role.harness_options as CodexOptions | undefined)?.launcher ?? 'auto';
}

function bundledCodexAcp() {
  return resolveBundledAcpAgent(CODEX_ACP_PACKAGE, 'codex-acp', 'codex-acp');
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

export function makeCodexAdapter(exec: Exec = realExec): HarnessAdapter {
  return {
    id: 'codex',
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

    validateOptions(opts: unknown): ValidationError[] {
      if (opts == null) return [];
      if (typeof opts !== 'object' || Array.isArray(opts))
        return [{ path: 'harness_options', message: 'must be a map' }];
      const errs: ValidationError[] = Object.keys(opts)
        .filter(k => !OPTION_KEYS.includes(k))
        .map(k => ({ path: `harness_options.${k}`, message: `unknown option; allowed: ${OPTION_KEYS.join(', ')}` }));
      const o = opts as CodexOptions;
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
      const requested = launcherMode(role);
      const hasOursCodex = await commandAvailable('ours-codex', exec);
      if (requested === 'ours-codex' && !hasOursCodex)
        throw new Error('harness_options.launcher is ours-codex, but ours-codex is not on PATH; install @ours.network/codex or use launcher: auto');
      const command = requested === 'codex' ? 'codex' : hasOursCodex ? 'ours-codex' : 'codex';
      return {
        argv: [],
        // OURS_BIND_IDENTITY is the connector's startup bind seed — see the note in
        // claude-code.ts's prepareSession. It belongs on EVERY harness that runs a
        // role with an ours identity, not just claude-code: a seed that works on one
        // harness and silently does nothing on the other is the same class of defect
        // as a config key that only works on one session type.
        env: { OURS_BIND_IDENTITY: role.identity, ...codexAcpEnvironment(role, dirs) },
        command,
      };
    },

    buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume', _s: SessionState, prep: SessionPrep): Launch {
      const stateDir = roleStateDir(role);
      const flags = commonFlags(role);
      const command = prep.command ?? 'codex';
      const argv = mode === 'fresh'
        ? [command, ...flags, ...prep.argv, `Read and follow ${join(stateDir, 'briefing.md')} now.`]
        : [command, 'resume', '--last', ...flags, ...prep.argv,
            this.vocabulary.restartPrompt(role.identity, join(stateDir, 'WORKLOG.md'), role)];
      return { argv, env: prep.env };
    },

    buildAcpLaunch(role: ResolvedRole, prep: SessionPrep): AcpLaunch {
      const configured = role.session_options?.acp?.command;
      // Resolve once: both argv and permission-metadata provenance must describe
      // the same artifact. A bare PATH fallback is launchable for compatibility,
      // but is never authenticated for protected-MCP auto-approval.
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
    },

    // INITIAL_AGENT_MODE covers session/new in codex-acp; session/set_mode
    // keeps resumed/loaded sessions and live status on the identical mode.
    acpPermissionModeId(role: ResolvedRole): string | undefined {
      return acpAgentMode(role);
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

    nativePermissionOverrides(options: unknown): Record<string, unknown> {
      const o = options as CodexOptions | undefined;
      const approval = o?.approval ?? o?.permission_mode;   // permission_mode is the alias
      return {
        ...(approval == null ? {} : { approval }),
        ...(o?.sandbox == null ? {} : { sandbox: o.sandbox }),
      };
    },

    translatePermissions(permissions) {
      const translated = translatePortablePermissionCodes('codex', permissions);
      const approval = translated.legacyNative.approval;
      const sandbox = translated.legacyNative.sandbox;
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
      return {
        ...translated,
        native: { approval, sandbox },
        capabilities: codexCapabilities(approval, sandbox),
      };
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
      const nativeMode = approvalPolicy(role) ?? 'untrusted';
      return { fleetMode: fleetModeForApproval(nativeMode), nativeMode };
    },

    inheritedPermissionMode(role) {
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
// by the runner, which passes dirs to prepareSession; buildLaunch derives from the same rule.
function roleStateDir(role: ResolvedRole): string {
  // Temp roles are marked by the runner via a private field to keep the interface small.
  const temp = (role as ResolvedRole & { __temp?: boolean }).__temp === true;
  return agentDir(role.name, temp);
}

export const codexAdapter = makeCodexAdapter();
registerAdapter(codexAdapter);
