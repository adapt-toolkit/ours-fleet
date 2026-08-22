import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import type { ResolvedRole } from '../config.js';
import type {
  AcpMcpServer, HarnessAdapter, RoleDirs, SessionPrep, SessionState, Launch, UnattendedCapability,
  ValidationError,
} from './types.js';
import { registerAdapter } from './registry.js';
import { replaceFileAtomically, withFileLock, type LockDeps } from '../atomic-file.js';
import { harnessRuntimeDir } from '../isolation/policy.js';
import { bundledAcpAgent } from './acp-agent.js';
import { restoreLockedHarnessMarketplace } from '../harness-plugins.js';

/** One entry of `harness_options.mcp_servers`, in `.mcp.json`'s own shape. */
interface McpServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface ClaudeOptions {
  plugins?: Record<string, boolean>;
  mem_palace?: boolean;
  mem_palace_midsession_autosave?: boolean;
  permission_mode?: string;
  effort?: string;
  mcp_servers?: Record<string, McpServerSpec>;
  mcp_servers_only?: boolean;
}
const OPTION_KEYS = [
  'plugins', 'mem_palace', 'mem_palace_midsession_autosave', 'permission_mode', 'effort',
  'mcp_servers', 'mcp_servers_only',
];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `.mcp.json` server types. Absent means stdio, as the file format has it. */
const MCP_SERVER_TYPES = ['stdio', 'http', 'sse'];

/** A role that names its own ACP command runs a process fleet did not choose. */
const customAcpCommand = (role: ResolvedRole): boolean =>
  role.session === 'acp' && role.session_options?.acp?.command != null;

/**
 * Does this server set include the ours connector?
 *
 * Load-bearing, and the reason it is a check rather than a doc line:
 * `mcp_servers_only` maps to `--strict-mcp-config`, which ignores EVERY other MCP
 * configuration — project `.mcp.json`, user settings, and **plugins**. On a
 * normal install the ours connector arrives as a plugin
 * (`~/.claude/plugins/.../plugin.json` declares `ours`), so a role that turns
 * strict mode on without re-declaring it loses `send_message` and `get_messages`
 * and cannot report that it has: a mute agent looks exactly like a quiet one.
 *
 * Matched on the command line rather than the server's NAME, because the name is
 * the operator's to choose and would make this trivially satisfiable by writing
 * `ours:` above the wrong command.
 */
const declaresOursConnector = (servers: Record<string, McpServerSpec>): boolean =>
  Object.values(servers).some(s =>
    [s.command ?? '', ...(s.args ?? [])].some(part =>
      /(^|[/\\])ours-mcp($|\s)|@ours\.network[/\\]mcp/.test(part)));

/** Shape-check `harness_options.mcp_servers` against `.mcp.json`'s own rules. */
function validateMcpServers(servers: unknown): ValidationError[] {
  if (servers == null) return [];
  const at = (k = '') => ({ path: `harness_options.mcp_servers${k}` });
  if (typeof servers !== 'object' || Array.isArray(servers))
    return [{ ...at(), message: 'must be a map of server name to server definition' }];
  const entries = Object.entries(servers as Record<string, unknown>);
  if (!entries.length)
    return [{ ...at(), message: 'must declare at least one server, or be omitted' }];
  const errors: ValidationError[] = [];
  for (const [name, raw] of entries) {
    const p = `.${name}`;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      errors.push({ ...at(p), message: 'server name must be [A-Za-z0-9_-]' });
      continue;
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ ...at(p), message: 'must be a map' });
      continue;
    }
    const s = raw as McpServerSpec;
    if (s.type != null && !MCP_SERVER_TYPES.includes(s.type))
      errors.push({ ...at(`${p}.type`), message: `must be one of: ${MCP_SERVER_TYPES.join(', ')}` });
    const remote = s.type === 'http' || s.type === 'sse';
    if (remote) {
      if (typeof s.url !== 'string' || !s.url.trim())
        errors.push({ ...at(`${p}.url`), message: `must be a non-empty URL for a ${s.type} server` });
      if (s.command != null)
        errors.push({ ...at(`${p}.command`), message: `must not be set for a ${s.type} server` });
    } else {
      if (typeof s.command !== 'string' || !s.command.trim())
        errors.push({ ...at(`${p}.command`), message: 'must be a non-empty command for a stdio server' });
      if (s.args != null && (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string')))
        errors.push({ ...at(`${p}.args`), message: 'must be an array of strings' });
      if (s.url != null)
        errors.push({ ...at(`${p}.url`), message: 'must not be set for a stdio server' });
    }
    for (const key of ['env', 'headers'] as const) {
      const v = s[key];
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)
          || Object.values(v).some(x => typeof x !== 'string'))
        errors.push({ ...at(`${p}.${key}`), message: 'must be a map of string to string' });
    }
  }
  return errors;
}

/** `harness_options.mcp_servers` in ACP's `session/new` array shape. */
function acpMcpServersFor(servers: Record<string, McpServerSpec> | undefined): AcpMcpServer[] {
  if (!servers) return [];
  // `env` and `headers` are REQUIRED arrays in the protocol, so they are always
  // sent — empty when the role declared none.
  const pairs = (r: Record<string, string> | undefined) =>
    Object.entries(r ?? {}).map(([name, value]) => ({ name, value }));
  return Object.entries(servers).map(([name, s]) => {
    if (s.type === 'http' || s.type === 'sse')
      return { name, type: s.type, url: s.url!, headers: pairs(s.headers) };
    // Stdio carries NO `type` field: ACP's stdio variant is the one without it,
    // and the bundled agent keys on exactly that (claude-agent-acp
    // acp-agent.js:4058, `!("type" in server)`), so sending `type: 'stdio'`
    // would drop the server on the floor.
    return { name, command: s.command!, args: s.args ?? [], env: pairs(s.env) };
  });
}

/** Claude Code's accepted --permission-mode values. */
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

/**
 * Neutral approval → native Claude mode. The ONE definition, shared by launch
 * and by translation so the two can never disagree about what a role will run
 * with.
 *
 * `allow` maps to `bypassPermissions`, not `dontAsk`. `dontAsk` suppresses the
 * PROMPT, not the denial: an unattended role configured with the operator's
 * explicit `approval: allow` was silently refused the actions it was told to
 * take, with no prompt and no error to show for it. Only an explicit `allow`
 * gets this; `ask` and `deny` are never elevated.
 */
export function nativePermissionMode(
  approval: ResolvedRole['permissions']['approval'],
): string | undefined {
  switch (approval) {
    case 'allow': return 'bypassPermissions';
    case 'auto': return 'acceptEdits';
    case 'deny': return 'plan';
    default: return undefined;               // ask uses Claude's native default
  }
}

/**
 * What an unattended role can actually do under a native mode. Derived from the
 * NATIVE mode, so an operator's explicit `harness_options.permission_mode`
 * override is judged on what it really grants.
 */
export function claudeCapabilities(
  mode: string | undefined, filesystem: ResolvedRole['permissions']['filesystem'],
): UnattendedCapability[] {
  // `plan` may not act at all; `default` and `acceptEdits` still stop to ask,
  // and with no console attached that request is refused rather than answered.
  if (mode !== 'bypassPermissions' && mode !== 'dontAsk') return ['read-state'];
  // `dontAsk` reaches the tools but is refused the actions behind them.
  if (mode === 'dontAsk') return ['read-state', 'status-commands'];
  const caps: UnattendedCapability[] = ['read-state', 'messaging', 'monitor', 'status-commands'];
  if (filesystem !== 'read-only') caps.push('write-state', 'workspace-edit');
  return caps;
}

/** Resolve & validate the per-role permission mode, throwing on an unknown value. */
function permissionMode(role: ResolvedRole): string | undefined {
  const pm = (role.harness_options as ClaudeOptions | undefined)?.permission_mode;
  if (pm == null) return nativePermissionMode(role.permissions?.approval);
  if (!PERMISSION_MODES.includes(pm))
    throw new Error(
      `invalid harness_options.permission_mode "${pm}"; allowed: ${PERMISSION_MODES.join(', ')}`);
  return pm;
}

/** Context window of the fleet model (1M); max_tokens → % of this. */
const WINDOW = 1_000_000;

export function autocompactPct(role: ResolvedRole): number {
  let pct: number;
  if (role.autocompact_pct != null) pct = Math.round(role.autocompact_pct);
  else if (role.max_tokens != null) pct = Math.round((role.max_tokens / WINDOW) * 100);
  else return 50;
  return Math.max(1, Math.min(100, pct));
}

/**
 * Pre-trust a dir in ~/.claude.json so the first launch never blocks on the
 * trust dialog.
 *
 * `~/.claude.json` is SHARED by every role and by the operator's own Claude
 * Code. The previous read-modify-write held nothing while it worked, so two
 * roles starting together interleaved and one silently lost its trust entry —
 * and that role then blocked on the dialog it was supposed to be spared,
 * unattended, with nobody to answer it. A crash mid-write truncated the file
 * for everyone.
 *
 * Now: take a cross-process lock, re-read inside it, merge ONLY this project's
 * entry so unrelated operator state survives untouched, and replace the file
 * atomically. Never fatal — a role that cannot be pre-trusted still launches.
 */
export async function pretrust(
  dir: string,
  deps: { log?(line: string): void; lock?: LockDeps } = {},
): Promise<void> {
  const p = join(home(), '.claude.json');
  const log = deps.log ?? (() => {});
  try {
    await withFileLock(`${p}.lock`, () => {
      let doc: Record<string, unknown>;
      if (!existsSync(p)) doc = {};
      else {
        const raw = readFileSync(p, 'utf8');
        try {
          doc = JSON.parse(raw) as Record<string, unknown>;
        } catch (e) {
          // Someone else's file, and it is already broken. Overwriting it would
          // destroy operator state we cannot read; refusing to launch would take
          // the role down for a file it does not own.
          log(`pretrust: ${p} is not valid JSON (${(e as Error).message}) — skipping pre-trust; `
            + `the role may block on Claude's trust dialog until the file is repaired`);
          return;
        }
        if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
          log(`pretrust: ${p} does not contain a JSON object — skipping pre-trust`);
          return;
        }
      }
      const projects = (doc.projects ??= {}) as Record<string, Record<string, unknown>>;
      const e = (projects[dir] ??= {});
      e.hasTrustDialogAccepted = true;
      e.hasCompletedProjectOnboarding = true;
      e.projectOnboardingSeenCount = Math.max((e.projectOnboardingSeenCount as number) ?? 0, 1);
      replaceFileAtomically(p, JSON.stringify(doc, null, 2));
    }, deps.lock);
  } catch (e) {
    log(`pretrust: could not update ${p} (${(e as Error).message}) — continuing without pre-trust`);
  }
}

/**
 * Shared Monitor-arming mandate (issue #16). Single-sourced so the briefing and
 * the restart prompt can never diverge on how the agent must arm its monitor —
 * it must be the Monitor TOOL, not a background Bash task (which never wakes the
 * agent on output → an armed-looking but deaf monitor).
 */
const armMonitor = (id: string): string =>
  'arm a **persistent Monitor** (the Monitor TOOL — NOT a background Bash command; a ' +
  `background Bash task never wakes you on output) running \`ours-mcp watch "${id}"\` ` +
  'so inbound ours mail wakes you';

export function makeClaudeCodeAdapter(exec: Exec = realExec): HarnessAdapter {
  return {
    id: 'claude-code',
    supportsResume: true,

    async checkPrereqs() {
      const r = await exec('claude', ['--version']);
      const ok = r.code === 0;
      return {
        ok,
        checks: [{
          name: 'claude',
          ok,
          detail: ok ? r.stdout.trim() : 'claude CLI not found on PATH — install Claude Code and log in',
        }],
      };
    },

    validateOptions(opts: unknown, role?: ResolvedRole): ValidationError[] {
      if (opts == null) return [];
      if (typeof opts !== 'object' || Array.isArray(opts))
        return [{ path: 'harness_options', message: 'must be a map' }];
      const errors = Object.keys(opts)
        .filter(k => !OPTION_KEYS.includes(k))
        .map(k => ({ path: `harness_options.${k}`, message: `unknown option; allowed: ${OPTION_KEYS.join(', ')}` }));
      const o = opts as ClaudeOptions;
      const effort = o.effort;
      if (effort != null && !EFFORT_LEVELS.includes(effort))
        errors.push({ path: 'harness_options.effort', message: `must be one of: ${EFFORT_LEVELS.join(', ')}` });
      if (o.mcp_servers_only != null && typeof o.mcp_servers_only !== 'boolean')
        errors.push({ path: 'harness_options.mcp_servers_only', message: 'must be a boolean' });
      errors.push(...validateMcpServers(o.mcp_servers));
      if (o.mcp_servers_only === true && !o.mcp_servers)
        errors.push({
          path: 'harness_options.mcp_servers_only',
          message: 'requires harness_options.mcp_servers; on its own it would leave the role with no MCP servers at all',
        });
      // The muteness gate. Only when the declared set is otherwise well-formed —
      // a shape error already told the operator to look here.
      if (o.mcp_servers_only === true && o.mcp_servers && errors.length === 0
          && !declaresOursConnector(o.mcp_servers))
        errors.push({
          path: 'harness_options.mcp_servers',
          message: 'mcp_servers_only ignores every other MCP configuration, INCLUDING plugins — and the ours '
            + 'connector is normally a plugin, so this role would have no send_message or get_messages and no way '
            + 'to report that. Declare it explicitly, e.g. ours: { command: ours-mcp, args: [proxy] }',
        });
      // Session-aware refusals. Both options reach an ACP session through the
      // bundled agent's `_meta` vocabulary, so a role that launches a DIFFERENT
      // ACP agent cannot be promised either one. Refuse rather than send it and
      // hope: silently dropping the config is the defect being fixed here.
      if (role && customAcpCommand(role)) {
        for (const key of ['plugins', 'mcp_servers', 'mcp_servers_only'] as const) {
          if (o[key] == null) continue;
          errors.push({
            path: `harness_options.${key}`,
            message: 'cannot be honoured with session_options.acp.command: it is delivered through the bundled '
              + 'Claude ACP agent\'s _meta vocabulary, which another agent has no reason to read. Drop the '
              + 'custom ACP command, or drop this option',
          });
        }
      }
      return errors;
    },

    async prepareSession(role: ResolvedRole, dirs: RoleDirs): Promise<SessionPrep> {
      // Re-materialize only from the persisted exact lock. Ordinary launches
      // never resolve npm tags or run an installer.
      restoreLockedHarnessMarketplace('claude-code', role.harnessPluginChannel);
      // Pre-trust stays a HOST-side step: inside the sandbox ~/.claude.json is
      // read-only, and it is the fleet's job to trust the role's dirs, not the
      // agent's (5.1, 6.1).
      await pretrust(dirs.stateDir);
      if (dirs.runCwd && dirs.runCwd !== dirs.stateDir) await pretrust(dirs.runCwd);
      const o = (role.harness_options ?? {}) as ClaudeOptions;
      const memPalace = o.mem_palace !== false;
      const enabledPlugins: Record<string, boolean> = { ...(o.plugins ?? {}) };
      if (!memPalace) enabledPlugins['mempalace@mempalace'] = false;

      const env: Record<string, string> = {
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(autocompactPct(role)),
        MEMPALACE_HOOKS_AUTO_SAVE: 'false',
        MEMPALACE_MIDSESSION_AUTOSAVE: o.mem_palace_midsession_autosave ? 'true' : 'false',
        // The role's identity, for the ours connector to bind at startup instead of
        // the briefing telling the MODEL to call choose_identity. Both launches
        // return `prep.env`, so this one line covers tmux and ACP alike.
        //
        // The bind the connector performs is PLAIN and fail-closed: it can never
        // evict a live session, and a role whose identity does not exist yet simply
        // boots unbound and falls through to the briefing's create-if-missing step.
        // Nothing here may ever grow a force flag.
        OURS_BIND_IDENTITY: role.identity,
      };
      if (!memPalace) env.MEMPALACE_DISABLED = 'true';

      // Per-role harness runtime home (5.1). Created before sandbox entry so the
      // bind has something to mount; harmless for un-isolated roles.
      // Only a role that declares `isolation:` gets a sandbox, and only a
      // sandbox needs this directory to exist before entry.
      if (role.isolation) mkdirSync(harnessRuntimeDir(dirs.stateDir, 'claude'), { recursive: true });

      const argv: string[] = [];
      let settingsOverlay: string | undefined;
      if (Object.keys(enabledPlugins).length) {
        settingsOverlay = join(dirs.stateDir, '.settings-overlay.json');
        writeFileSync(settingsOverlay, JSON.stringify({ enabledPlugins }, null, 2));
        argv.push('--settings', settingsOverlay);
      }

      // `harness_options.mcp_servers` — the tmux delivery. `--mcp-config` ADDS the
      // file's servers; `--strict-mcp-config` is what makes the set exclusive, and
      // it is opt-in per role because it drops everything else the user has,
      // plugins included (see `declaresOursConnector`).
      let mcpConfigFile: string | undefined;
      if (o.mcp_servers) {
        mcpConfigFile = join(dirs.stateDir, '.mcp-config.json');
        writeFileSync(
          mcpConfigFile, JSON.stringify({ mcpServers: o.mcp_servers }, null, 2), { mode: 0o600 });
        argv.push('--mcp-config', mcpConfigFile);
        if (o.mcp_servers_only === true) argv.push('--strict-mcp-config');
      }

      return {
        argv, env,
        ...(settingsOverlay ? { settingsOverlay } : {}),
        ...(mcpConfigFile ? { mcpConfigFile } : {}),
      };
    },

    buildLaunch(role: ResolvedRole, mode: 'fresh' | 'resume', s: SessionState, prep: SessionPrep): Launch {
      const stateDir = roleStateDir(role);
      const pm = permissionMode(role);
      const o = role.harness_options as ClaudeOptions | undefined;
      const base = ['claude', ...(role.model ? ['--model', role.model] : []),
                    ...(o?.effort ? ['--effort', o.effort] : []),
                    ...(pm ? ['--permission-mode', pm] : []),
                    ...prep.argv, '--remote-control', role.name];
      const argv = mode === 'fresh'
        ? [...base, '--session-id', s.sessionId, `Read and follow ${join(stateDir, 'briefing.md')} now.`]
        : [...base, '--resume', s.sessionId,
            this.vocabulary.restartPrompt(role.identity, join(stateDir, 'WORKLOG.md'), role)];
      return { argv, env: prep.env };
    },

    buildAcpLaunch(role: ResolvedRole, prep: SessionPrep): Launch {
      const configured = role.session_options?.acp?.command;
      const argv = Array.isArray(configured)
        ? [...configured]
        : typeof configured === 'string'
          ? ['sh', '-c', configured]
          : bundledAcpAgent(
              '@agentclientprotocol/claude-agent-acp', 'claude-agent-acp', 'claude-agent-acp');
      return { argv, env: prep.env };
    },

    // Same source as buildLaunch's --permission-mode flag, so the tmux and ACP
    // backends cannot disagree about what a role's permissions translate to.
    acpPermissionModeId(role: ResolvedRole): string | undefined {
      return permissionMode(role);
    },

    /**
     * Deliver, over ACP, the two things the tmux launch delivers as flags.
     *
     * `buildAcpLaunch` builds its own argv and cannot carry `prep.argv`: the
     * process it launches is the ACP agent, not `claude`, and it takes none of
     * claude's flags. That is why `harness_options.plugins` did nothing at all on
     * an ACP role — the overlay was written and then dropped, and the mem-palace
     * toggle rode `prep.env` and survived, so the failure was silent AND
     * selective.
     *
     * `_meta.claudeCode.options` is the bundled agent's own passthrough into the
     * Claude Agent SDK (@agentclientprotocol/claude-agent-acp, acp-agent.js:4092
     * → the `options` object at :4144). `settings` takes the same overlay path
     * `--settings` takes; `strictMcpConfig` is the SDK's spelling of
     * `--strict-mcp-config`. Both are spread BEFORE the fields the agent forces,
     * so neither is overwritten.
     *
     * ⚠ RETURNS NOTHING FOR A ROLE THAT NAMES ITS OWN ACP COMMAND. That process
     * is not the bundled agent and has no reason to read this vocabulary; sending
     * it anyway would be the silent drop again, one level down. `validateOptions`
     * refuses those roles instead.
     */
    acpSessionMeta(role: ResolvedRole, prep: SessionPrep): Record<string, unknown> | undefined {
      if (customAcpCommand(role)) return undefined;
      const options: Record<string, unknown> = {};
      if (prep.settingsOverlay) options.settings = prep.settingsOverlay;
      if ((role.harness_options as ClaudeOptions | undefined)?.mcp_servers_only === true)
        options.strictMcpConfig = true;
      return Object.keys(options).length ? { claudeCode: { options } } : undefined;
    },

    /**
     * The declared servers, in ACP's array shape. Sent on `session/new` and on
     * resume/load, because the SDK builds its server set once per session and a
     * resumed session that dropped them would quietly lose its tools.
     */
    acpMcpServers(role: ResolvedRole): AcpMcpServer[] {
      return acpMcpServersFor((role.harness_options as ClaudeOptions | undefined)?.mcp_servers);
    },

    isolationPaths(_role: ResolvedRole, _dirs: RoleDirs) {
      const claudeHome = join(home(), '.claude');
      return {
        home: claudeHome,
        // Credentials and project trust (~/.claude.json), the global
        // instructions every role shares, and the shared settings. Everything
        // else under ~/.claude — sessions, projects, caches, history — is
        // runtime state and belongs to the role, not to the fleet.
        shared: [
          join(home(), '.claude.json'),
          join(claudeHome, 'CLAUDE.md'),
          join(claudeHome, 'settings.json'),
          join(claudeHome, 'plugins'),
        ],
      };
    },

    nativePermissionOverrides(options: unknown): Record<string, unknown> {
      const pm = (options as ClaudeOptions | undefined)?.permission_mode;
      return pm == null ? {} : { permission_mode: pm };
    },

    translatePermissions(permissions) {
      const native = nativePermissionMode(permissions.approval) ?? 'default';
      const exact = permissions.filesystem === 'workspace' && permissions.approval === 'ask';
      return {
        supported: true,
        native: { permission_mode: native },
        exact,
        warnings: exact ? [] : [
          'Claude permission modes do not exactly represent independent approval and filesystem intent; fleet isolation remains the outer boundary',
        ],
        capabilities: claudeCapabilities(native, permissions.filesystem),
      };
    },

    effectivePermissions(role) {
      const translated = this.translatePermissions(role.permissions);
      if (!translated.supported) return translated;
      const native = permissionMode(role) ?? 'default';
      return {
        ...translated,
        native: { permission_mode: native },
        capabilities: claudeCapabilities(native, role.permissions.filesystem),
      };
    },

    effectivePermissionMode(role) {
      const nativeMode = permissionMode(role) ?? 'default';
      const fleetMode = nativeMode === 'bypassPermissions' ? 'allow'
        : nativeMode === 'acceptEdits' || nativeMode === 'dontAsk' ? 'auto'
          : nativeMode === 'default' || nativeMode === 'plan' ? 'ask' : undefined;
      if (!fleetMode) throw new Error(`unsupported Claude permission mode '${nativeMode}'`);
      return { fleetMode, nativeMode };
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
      watchCommand: id => `ours-mcp watch "${id}"`,
      monitorInstruction: id => {
        const m = armMonitor(id);
        return `${m.charAt(0).toUpperCase()}${m.slice(1)}.`;
      },
      supervisedWakeNote: () =>
        'Your mail wake-ups are delivered by the fleet supervisor directly into this console as ' +
        '`[fleet-monitor]` lines — do NOT arm an in-session Monitor. When such a line appears, run ' +
        '**get_messages** to drain the mail.',
      launchNote: name => `You were launched with \`--remote-control ${name}\`. Confirm you are running.`,
      restartPrompt: (id, worklog, role) =>
        `Session restarted. Re-bind your ours identity now (choose_identity name "${id}" force=true), ` +
        (role?.monitor?.mode === 'fleet'
          ? 'then continue from '
          : `then ${armMonitor(id)}, then continue from `) +
        `${worklog}. Do not re-run whatever crashed you.` +
        (role?.monitor?.mode === 'fleet'
          ? ' Your mail wakes arrive as `[fleet-monitor]` console lines from the supervisor — ' +
            'do NOT arm an in-session Monitor.'
          : ''),
    },

    exitPolicy: { cleanExitIsFresh: true, fastFailSecs: 20 },
  };
}

// The adapter needs the state dir for briefing/worklog paths in launch prompts.
// Roles' state dirs are canonical: agentDir(name) — temp roles carry their dir in cwd handling
// by the runner, which passes dirs to prepareSession; buildLaunch derives from the same rule.
import { agentDir } from '../paths.js';
function roleStateDir(role: ResolvedRole): string {
  // Temp roles are marked by the runner via a private field to keep the interface small.
  const temp = (role as ResolvedRole & { __temp?: boolean }).__temp === true;
  return agentDir(role.name, temp);
}

export const claudeCodeAdapter = makeClaudeCodeAdapter();
registerAdapter(claudeCodeAdapter);
