import { join } from 'node:path';
import { agentDir } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import type {
  HarnessAdapter, RoleDirs, SessionPrep, SessionState, Launch, ValidationError,
} from './types.js';
import { registerAdapter } from './registry.js';

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

/** Resolve & validate the per-role sandbox mode, throwing on an unknown value. */
function sandboxMode(role: ResolvedRole): string | undefined {
  const s = (role.harness_options as CodexOptions | undefined)?.sandbox;
  if (s == null) return undefined;
  if (!SANDBOX_MODES.includes(s))
    throw new Error(`invalid harness_options.sandbox "${s}"; allowed: ${SANDBOX_MODES.join(', ')}`);
  return s;
}

/** Resolve & validate the per-role approval policy, throwing on an unknown value. */
function approvalPolicy(role: ResolvedRole): string | undefined {
  const o = role.harness_options as CodexOptions | undefined;
  const a = o?.approval ?? o?.permission_mode;
  if (a == null) return undefined;
  if (!APPROVAL_POLICIES.includes(a))
    throw new Error(`invalid harness_options.approval "${a}"; allowed: ${APPROVAL_POLICIES.join(', ')}`);
  return a;
}

function launcherMode(role: ResolvedRole): string {
  return (role.harness_options as CodexOptions | undefined)?.launcher ?? 'auto';
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
      plugin.pluginId === 'ours@ours-codex-marketplace'
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
        exec('codex', ['plugin', 'list', '--json', '--marketplace', 'ours-codex-marketplace']),
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

    async prepareSession(role: ResolvedRole, _dirs: RoleDirs): Promise<SessionPrep> {
      const requested = launcherMode(role);
      const hasOursCodex = await commandAvailable('ours-codex', exec);
      if (requested === 'ours-codex' && !hasOursCodex)
        throw new Error('harness_options.launcher is ours-codex, but ours-codex is not on PATH; install @ours.network/codex or use launcher: auto');
      const command = requested === 'codex' ? 'codex' : hasOursCodex ? 'ours-codex' : 'codex';
      return { argv: [], env: {}, command };
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

    vocabulary: {
      bindTool: 'choose_identity',
      createTool: 'create_identity',
      setBioTool: 'set_bio',
      setPersonaTool: 'set_persona',
      currentIdentityTool: 'current_identity',
      sendTool: 'send_message',
      getMessagesTool: 'get_messages',
      watchCommand: id => `ours-mcp watch "${id}"`,
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
      launchNote: name => `You were launched as the fleet role \`${name}\` under a Codex session. Confirm you are running.`,
      restartPrompt: (id, worklog, configuredRole) => {
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
