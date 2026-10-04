/**
 * Fleet-owned setup of native harness execution policy for the managed CLI.
 *
 * A managed `ours-fleet` call audits through its supervisor's Unix socket before
 * it parses anything, so a harness command sandbox can refuse even `--help`
 * (#231). Fleet prescribes the Coordinator's task workflow and knows the node
 * binary, CLI and configuration a launch uses, so it — not the operator, and not
 * the installer — derives the native rules that let exactly those invocations
 * run outside the command sandbox.
 *
 * What this is NOT: argument validation, target authorization or per-role
 * isolation. A native rule matches an argv PREFIX and admits every trailing
 * argument. The one thing Fleet adds on top is the pinned entry form below,
 * which refuses a different configuration after the process has started.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { replaceFileAtomically, withSynchronousFileLock } from './atomic-file.js';
import { erasedArg } from './erased-resources.js';
import { managedPinMarker } from './fleet-command-audit.js';
import {
  MANAGED_CLI_WORKFLOW_IDS, splitRootFor,
  type FleetConfig, type ManagedCliWorkflowId, type ResolvedRole,
} from './config.js';
import { resolveBundledAcpAgent } from './harness/acp-agent.js';
import { executableOnPath, hostCodex } from './harness/codex-runtime.js';
import { getAdapter } from './harness/registry.js';
import type { SessionPrep } from './harness/types.js';
import { agentDir, defaultConfigPath, home, stateRoot } from './paths.js';

/** Capability-gated by the installer; see src/capabilities.ts. */
export const MANAGED_CONFIGURATION_FLAG = '--managed-configuration';
/** What the last launch of a role actually prepared. Lives in the role's state dir. */
export const MANAGED_CLI_RECORD = '.managed-cli.json';
const RULES_MARKER = '# ours-fleet managed-cli v1 ';
/** Quoted path tokens were refused by Codex 0.159.0 (#231) and granted by 0.160.0. */
export const CODEX_QUOTED_PATH_MINIMUM = '0.160.0';

export interface ManagedCliForm {
  /** Argv tokens after the pin, matched exactly. */
  tokens: readonly string[];
  /** `lifecycle` forms create, change or retire tasks, rooms and agents. */
  effect: 'help' | 'read' | 'lifecycle';
  /** Whether the command itself takes -c/--configuration, where the pin is injected. */
  configuration: boolean;
}

const form = (
  tokens: string, effect: ManagedCliForm['effect'], configuration: boolean,
): ManagedCliForm => ({ tokens: tokens.split(' '), effect, configuration });

export interface ManagedCliWorkflow {
  description: string;
  forms: readonly ManagedCliForm[];
  /** Named so nobody reads their absence as an oversight. */
  excluded: readonly string[];
}

export const MANAGED_CLI_WORKFLOWS: Readonly<Record<ManagedCliWorkflowId, ManagedCliWorkflow>> = {
  'task-workflow': {
    description: "the packaged Coordinator's task workflow",
    forms: [
      form('--help', 'help', false),
      form('task --help', 'help', false),
      form('room --help', 'help', false),
      form('template --help', 'help', false),
      form('docs', 'help', false),
      form('config', 'read', true),
      form('template list', 'read', true),
      form('template show', 'read', true),
      form('template validate', 'read', true),
      form('task list', 'read', true),
      form('task show', 'read', true),
      form('room show', 'read', true),
      form('room members', 'read', true),
      form('task create', 'lifecycle', true),
      form('task start', 'lifecycle', true),
      form('task finish', 'lifecycle', true),
      // These three take no configuration option: they act on the task state of
      // the Fleet home the supervisor's environment selects.
      form('task block', 'lifecycle', false),
      form('task unblock', 'lifecycle', false),
      form('task review', 'lifecycle', false),
    ],
    excluded: [
      'spawn', 'ours tools/call', 'status/peek/send', 'room create/delete/close',
      'task cancel/delete', 'service administration',
    ],
  },
};

const allForms = (workflows: readonly ManagedCliWorkflowId[]): ManagedCliForm[] => {
  const seen = new Map<string, ManagedCliForm>();
  for (const id of workflows)
    for (const entry of MANAGED_CLI_WORKFLOWS[id].forms) seen.set(entry.tokens.join(' '), entry);
  return [...seen.values()];
};

// ---------------------------------------------------------------------------
// The pinned entry form: `NODE CLI --managed-configuration <file> <form> ...`
// ---------------------------------------------------------------------------

export type ManagedEntry =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'pinned'; configuration: string; form: ManagedCliForm; argv: string[] };

/**
 * Recognise the pinned entry form in `argv` (process.argv.slice(2)) and return
 * the ordinary argv Commander should parse.
 *
 * The pin must be the first argument: that is the only position a native prefix
 * rule can fix. For a command that takes `--configuration`, the pinned file is
 * injected directly after the command tokens; a later, different value is
 * refused by `assertPinnedConfiguration` on the PARSED option, so `-c`,
 * `-cFILE`, `--configuration=FILE` and repeats need no token heuristics here.
 */
export function parseManagedEntry(argv: readonly string[]): ManagedEntry {
  if (argv[0] !== MANAGED_CONFIGURATION_FLAG) {
    const terminator = argv.indexOf('--');
    const options = terminator < 0 ? argv : argv.slice(0, terminator);
    if (options.some(arg => arg === MANAGED_CONFIGURATION_FLAG
        || arg.startsWith(`${MANAGED_CONFIGURATION_FLAG}=`)))
      return { kind: 'error', message: `${MANAGED_CONFIGURATION_FLAG} must be the first argument, `
        + 'followed by the absolute configuration path as a separate argument' };
    return { kind: 'none' };
  }
  const configuration = argv[1];
  if (!configuration || !isAbsolute(configuration) || resolve(configuration) !== configuration)
    return { kind: 'error', message: `${MANAGED_CONFIGURATION_FLAG} requires a normalized absolute configuration path` };
  const rest = argv.slice(2);
  const matched = allForms(MANAGED_CLI_WORKFLOW_IDS)
    .filter(entry => entry.tokens.every((token, index) => rest[index] === token))
    .sort((a, b) => b.tokens.length - a.tokens.length)[0];
  if (!matched) {
    const shown = rest.slice(0, 2).filter(arg => !arg.startsWith('-') || arg === '--help').join(' ') || '<none>';
    return { kind: 'error', message: `'${shown}' is not part of a Fleet-prepared managed workflow; `
      + `prepared commands: ${allForms(MANAGED_CLI_WORKFLOW_IDS).map(entry => entry.tokens.join(' ')).join(', ')}. `
      + `Run other commands without ${MANAGED_CONFIGURATION_FLAG}; they stay subject to the command sandbox` };
  }
  const tail = rest.slice(matched.tokens.length);
  return {
    kind: 'pinned', configuration, form: matched,
    argv: matched.configuration
      ? [...matched.tokens, '--configuration', configuration, ...tail] : [...rest],
  };
}

/** Refuse a parsed `--configuration` that is not the pinned file. Throws a plain Error. */
export function assertPinnedConfiguration(pinned: string, parsed: unknown): void {
  if (parsed === undefined) return;
  if (typeof parsed !== 'string' || resolve(parsed) !== pinned)
    throw new Error(`this invocation is pinned to configuration ${pinned} by ${MANAGED_CONFIGURATION_FLAG}; `
      + 'a different -c/--configuration is refused. Run the command without the pin to use another '
      + 'configuration; it then stays subject to the command sandbox');
}

// ---------------------------------------------------------------------------
// Paths and native policy text
// ---------------------------------------------------------------------------

export interface ManagedCliPaths { node: string; cli: string; configuration: string }

function installedCli(): string {
  const adjacent = fileURLToPath(new URL('./cli.js', import.meta.url));
  // Vitest imports src/ directly; the executable CLI is the built one.
  const candidate = existsSync(adjacent) ? adjacent
    : resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
  try { return realpathSync(candidate); } catch { return candidate; }
}

/** The exact tokens a rule fixes: this process's node, this installation's CLI, this configuration. */
export function managedCliPaths(configPath?: string, overrides: Partial<ManagedCliPaths> = {}): ManagedCliPaths {
  return {
    node: overrides.node ?? process.execPath,
    cli: overrides.cli ?? installedCli(),
    configuration: overrides.configuration ?? resolve(configPath ?? defaultConfigPath()),
  };
}

const PLAIN_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;
/**
 * Single quotes are the one spelling both Codex (>=0.160.0) and Claude match
 * against a rule — for words after the executable. Only a space is admitted
 * beyond the plain characters: that is what was measured natively. `*`, `?`,
 * brackets, parentheses and the like are pattern syntax in Claude's permission
 * and exclusion entries, where a path is inserted verbatim, so a path carrying
 * one would widen the entry beyond this installation.
 */
const QUOTABLE_TOKEN = /^[A-Za-z0-9_@%+=:,./ -]+$/u;

/** The canonical shell spelling of one path token, or undefined when none is qualified. */
export function shellSpelling(token: string): string | undefined {
  if (PLAIN_TOKEN.test(token)) return token;
  return QUOTABLE_TOKEN.test(token) ? `'${token}'` : undefined;
}

/**
 * The executable token is the exception: neither Codex 0.160.0 nor Claude Code
 * 2.1.289 matches a QUOTED first word against a rule, while both match quoted
 * later words. Node must therefore be reachable at a path needing no quoting.
 */
const plainExecutable = (node: string): boolean => PLAIN_TOKEN.test(node);
export const needsQuoting = (paths: ManagedCliPaths): boolean =>
  [paths.cli, paths.configuration].some(token => !PLAIN_TOKEN.test(token));

/** The argv prefix every prepared invocation starts with. */
export function managedCliPrefix(paths: ManagedCliPaths): string[] {
  return [paths.node, paths.cli, MANAGED_CONFIGURATION_FLAG, paths.configuration];
}

/** The same prefix as the agent must type it. Undefined when a path cannot be spelled. */
export function managedCliCommandPrefix(paths: ManagedCliPaths): string | undefined {
  const [cli, configuration] = [paths.cli, paths.configuration].map(shellSpelling);
  if (!plainExecutable(paths.node) || cli === undefined || configuration === undefined) return undefined;
  return [paths.node, cli, MANAGED_CONFIGURATION_FLAG, configuration].join(' ');
}

interface RulesHeader { configuration: string; node: string; cli: string; workflows: ManagedCliWorkflowId[] }

/** Codex execution rules: one `prefix_rule` per form. JSON strings are valid Starlark strings. */
export function renderCodexRules(paths: ManagedCliPaths, workflows: readonly ManagedCliWorkflowId[]): string {
  const header: RulesHeader = { ...paths, workflows: [...workflows].sort() };
  const lines = [
    `${RULES_MARKER}${JSON.stringify(header)}`,
    '# Generated by ours-fleet. Do not edit: this file is replaced at every launch and setup.',
    '# Put your own rules in another file in this directory; Fleet never touches those.',
    '# Each rule lets the named Fleet CLI command run outside the Codex command sandbox for',
    '# every trusted Codex session in this workspace. It matches an argv prefix and admits all',
    '# trailing arguments; it is not argument validation or per-agent isolation.',
  ];
  for (const entry of allForms(workflows))
    lines.push(`prefix_rule(pattern=${JSON.stringify([...managedCliPrefix(paths), ...entry.tokens])}, decision="allow")`);
  return `${lines.join('\n')}\n`;
}

export interface ClaudeManagedCliSettings {
  permissions: { allow: string[] };
  sandbox: { excludedCommands: string[] };
}

/**
 * Claude needs BOTH halves: `permissions.allow` authorizes the Bash call and
 * `sandbox.excludedCommands` places it outside the OS sandbox when one is
 * enabled. Each form is listed bare and with ` *` because the wildcard form
 * alone is not relied on to match an invocation without arguments.
 */
export function claudeManagedCliSettings(
  paths: ManagedCliPaths, workflows: readonly ManagedCliWorkflowId[],
): ClaudeManagedCliSettings | undefined {
  const prefix = managedCliCommandPrefix(paths);
  if (!prefix) return undefined;
  const patterns = allForms(workflows).flatMap(entry => {
    const command = `${prefix} ${entry.tokens.join(' ')}`;
    return [command, `${command} *`];
  });
  return {
    permissions: { allow: patterns.map(pattern => `Bash(${pattern})`) },
    sandbox: { excludedCommands: patterns },
  };
}

const isFleetPattern = (value: unknown): boolean =>
  typeof value === 'string' && value.includes(` ${MANAGED_CONFIGURATION_FLAG} `);

/**
 * Merge the fragment into Fleet's own per-role settings overlay. Entries from a
 * previous launch are dropped first, so a moved node, CLI or configuration
 * leaves nothing stale behind. `sandbox.enabled` is never written: whether
 * Claude's OS sandbox is on stays the operator's setting.
 */
export function mergeClaudeOverlay(
  base: Record<string, unknown>, fragment: ClaudeManagedCliSettings | undefined,
): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const permissions = record(base.permissions);
  const sandbox = record(base.sandbox);
  const allow = [...list(permissions.allow).filter(entry => !isFleetPattern(entry)),
    ...(fragment?.permissions.allow ?? [])];
  const excluded = [...list(sandbox.excludedCommands).filter(entry => !isFleetPattern(entry)),
    ...(fragment?.sandbox.excludedCommands ?? [])];
  const result: Record<string, unknown> = { ...base };
  const nextPermissions = { ...permissions, ...(allow.length ? { allow } : {}) };
  if (!allow.length) delete (nextPermissions as Record<string, unknown>).allow;
  const nextSandbox = { ...sandbox, ...(excluded.length ? { excludedCommands: excluded } : {}) };
  if (!excluded.length) delete (nextSandbox as Record<string, unknown>).excludedCommands;
  if (Object.keys(nextPermissions).length) result.permissions = nextPermissions; else delete result.permissions;
  if (Object.keys(nextSandbox).length) result.sandbox = nextSandbox; else delete result.sandbox;
  return result;
}

// ---------------------------------------------------------------------------
// Which roles, and whether the combination is one Fleet prepares
// ---------------------------------------------------------------------------

export type ManagedCliMechanism = 'codex-workspace-rules' | 'claude-session-settings';

export interface ManagedCliAnalysis {
  role: string;
  harness: string;
  session: string;
  workflows: ManagedCliWorkflowId[];
  state: 'not-declared' | 'not-required' | 'unsupported' | 'supported';
  mechanism?: ManagedCliMechanism;
  /** Why the state is not-required or unsupported. Actionable, one per line. */
  reasons: string[];
  /** What the prepared policy actually grants, for disclosure. */
  scope: string[];
  workspace: string;
  paths: ManagedCliPaths;
  /** The prefix the agent types; absent unless supported. */
  commandPrefix?: string;
}

export interface ManagedCliDeps {
  platform?: NodeJS.Platform;
  paths?: Partial<ManagedCliPaths>;
  /** Codex version for the quoted-path qualification; read from the role's Codex when omitted. */
  codexVersion?: string;
}

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/** Where `path` really is: symlinks resolved through the deepest ancestor that exists. */
function canonical(path: string): string {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...missing.reverse()); } catch { /* not there yet */ }
    if (dirname(current) === current) return resolve(path);
    missing.push(basename(current));
  }
}

export function roleWorkspace(role: ResolvedRole, temp = false): string {
  return role.cwd && existsSync(role.cwd) ? role.cwd : agentDir(role.name, temp);
}

const versionAtLeast = (version: string, minimum: string): boolean => {
  const parse = (value: string) => (/(\d+)\.(\d+)\.(\d+)/u.exec(value) ?? []).slice(1).map(Number);
  const [a, b] = [parse(version), parse(minimum)];
  if (a.length !== 3) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return true;
};

/**
 * The Codex that will run this role, by the same choice the launch makes: an
 * explicit CODEX_PATH, else (for the bundled ACP adapter) a host Codex at least
 * as new as the bundled one, else the bundled copy. `--version` only; no model.
 */
function codexRuntimeVersion(role: ResolvedRole, cwd: string): string | undefined {
  const env = { ...process.env, ...(role.env ?? {}) };
  const reported = (path: string): string | undefined => {
    const result = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? /\b(\d+\.\d+\.\d+)\b/u.exec(result.stdout ?? '')?.[1] : undefined;
  };
  try {
    if (env.CODEX_PATH) return reported(executableOnPath(env.CODEX_PATH, env, cwd));
    if (role.session !== 'acp') return reported(executableOnPath('codex', env, cwd));
    const manifest = resolveBundledAcpAgent('@agentclientprotocol/codex-acp', 'codex-acp', 'codex-acp').manifestPath;
    const host = hostCodex(manifest, env, cwd);
    if (host || !manifest) return host?.version;
    return (JSON.parse(readFileSync(createRequire(manifest).resolve('@openai/codex/package.json'), 'utf8')) as { version?: string }).version;
  } catch { return undefined; }
}

/** Decide, without touching the filesystem, what Fleet prepares for one role. */
export function analyzeManagedCli(
  role: ResolvedRole, configPath: string | undefined,
  options: ManagedCliDeps & { temp?: boolean; workspace?: string } = {},
): ManagedCliAnalysis {
  const paths = managedCliPaths(configPath, options.paths);
  const workspace = options.workspace ?? roleWorkspace(role, options.temp);
  const workflows = [...(role.managed_cli ?? [])];
  const base = {
    role: role.name, harness: role.harness, session: role.session, workflows, workspace, paths,
    reasons: [] as string[], scope: [] as string[],
  };
  if (!workflows.length) return { ...base, state: 'not-declared' };

  const reasons: string[] = [];
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin')
    reasons.push(`platform '${platform}' is not qualified; only Linux and macOS are declared`);
  let mechanism: ManagedCliMechanism | undefined;
  if (role.harness === 'codex') {
    mechanism = 'codex-workspace-rules';
    if (role.session === 'acp' && role.session_options?.acp?.command != null)
      reasons.push('a custom session_options.acp.command is not the bundled Codex ACP adapter Fleet qualifies; drop it or keep this role sandboxed');
    if (role.session === 'codex-app-server' && role.session_options?.codex_app_server?.command != null)
      reasons.push('a custom session_options.codex_app_server.command is not the Codex launch Fleet qualifies; drop it or keep this role sandboxed');
  } else if (role.harness === 'claude-code') {
    mechanism = 'claude-session-settings';
    if (role.session_options?.acp?.command != null)
      reasons.push('a custom session_options.acp.command cannot receive Fleet\'s settings overlay; drop it or keep this role sandboxed');
  } else {
    reasons.push(`harness '${role.harness}' has no qualified native execution policy; supported: codex (native app-server, bundled ACP), claude-code (bundled ACP)`);
  }
  // Every root this launch lets the agent write: its workspace and the extra
  // directories the role adds. Native settings Fleet cannot read may add more.
  const native = (role.harness_options ?? {}) as { add_dirs?: unknown; config?: unknown; profile?: unknown };
  const writable = [workspace, ...(Array.isArray(native.add_dirs) ? native.add_dirs.filter((dir): dir is string => typeof dir === 'string').map(dir => resolve(workspace, dir)) : [])];
  if (role.harness === 'codex' && (native.profile != null || (native.config && typeof native.config === 'object' && Object.keys(native.config).length)))
    reasons.push('harness_native.config or harness_native.profile changes Codex\'s native sandbox in ways Fleet does not inspect (for example extra writable roots), so it cannot tell whether the agent could replace the pinned files; drop them or keep this role sandboxed');
  if (role.isolation)
    reasons.push('the role declares isolation:, and Fleet\'s outer sandbox is kept as-is; the workflow is not qualified inside it');
  if (!plainExecutable(paths.node))
    reasons.push(`Node executable path ${JSON.stringify(paths.node)} would need shell quoting, and neither Codex nor Claude matches a quoted executable against a rule; install or link Node at a path without spaces or shell metacharacters and start Fleet with that Node`);
  for (const [label, value] of [['Node executable', paths.node], ['Fleet CLI', paths.cli], ['configuration', paths.configuration]] as const) {
    if (label !== 'Node executable' && shellSpelling(value) === undefined)
      reasons.push(`${label} path ${JSON.stringify(value)} contains a character other than letters, digits, spaces and _@%+=:,./- and has no qualified literal spelling in a native rule (quotes, backslashes and pattern characters such as * ? [ ] ( ) are not matched literally); install it at a path without them`);
    // Lexically and by where the path really leads: a link outside the workspace
    // that points into it is just as replaceable by the agent.
    const real = canonical(value);
    const root = writable.find(dir => inside(value, dir) || inside(real, canonical(dir)));
    if (root !== undefined)
      reasons.push(`${label} ${value}${real === value ? '' : ` (which resolves to ${real})`} is inside the agent-writable ${root === workspace ? 'workspace' : 'directory (harness_options.add_dirs)'} ${root}; a rule on a file the agent can replace would let it run anything outside the sandbox`);
  }
  if (mechanism === 'codex-workspace-rules' && needsQuoting(paths) && !reasons.length) {
    const version = options.codexVersion ?? codexRuntimeVersion(role, workspace);
    if (version === undefined)
      reasons.push(`the Fleet CLI or configuration path needs shell quoting, which only Codex >=${CODEX_QUOTED_PATH_MINIMUM} matches against rules, and this role's Codex version could not be read; install Codex or keep Fleet and its configuration at paths without spaces`);
    else if (!versionAtLeast(version, CODEX_QUOTED_PATH_MINIMUM))
      reasons.push(`the Fleet CLI or configuration path needs shell quoting, which Codex ${version} does not match against rules; upgrade Codex to >=${CODEX_QUOTED_PATH_MINIMUM} or keep Fleet and its configuration at paths without spaces`);
  }
  if (reasons.length) return { ...base, state: 'unsupported', mechanism, reasons };

  if (mechanism === 'codex-workspace-rules') {
    let sandbox: unknown;
    try {
      const adapter = getAdapter(role.harness);
      const effective = adapter.effectivePermissions?.(role) ?? adapter.translatePermissions(role.permissions);
      sandbox = effective.supported ? effective.native.sandbox : undefined;
    } catch { sandbox = undefined; }
    if (sandbox === 'danger-full-access')
      return { ...base, state: 'not-required', mechanism,
        reasons: ['the role runs Codex with sandbox=danger-full-access, so no command sandbox stands between it and the supervisor; nothing is generated'] };
  }
  const names = workflows.map(id => MANAGED_CLI_WORKFLOWS[id].description).join(', ');
  const scope = [
    `Runs outside the ${mechanism === 'codex-workspace-rules' ? 'Codex' : 'Claude'} command sandbox: ${allForms(workflows).map(entry => entry.tokens.join(' ')).join('; ')} (${names}).`,
    'Each rule fixes the Node executable, this Fleet CLI, the configuration and the command; every trailing option and argument is admitted, including task/room content, member overrides and file paths. Ordinary CLI validation and the supervisor audit still apply.',
    'task start and task finish provision and retire rooms and agents: this is real authority, not read access.',
    mechanism === 'codex-workspace-rules'
      ? `Codex workspace rules apply to every trusted Codex session in ${workspace}, not to this agent alone.`
      : 'The Claude entries live in this agent\'s own Fleet settings overlay; Claude\'s OS sandbox is left as your settings configure it.',
    `Not prepared and still sandboxed: ${[...new Set(workflows.flatMap(id => MANAGED_CLI_WORKFLOWS[id].excluded))].join(', ')}, and compound, redirected or environment-prefixed command lines.`,
  ];
  return { ...base, state: 'supported', mechanism, scope, commandPrefix: managedCliCommandPrefix(paths) };
}

// ---------------------------------------------------------------------------
// Codex: one Fleet-owned rules file per (workspace, configuration)
// ---------------------------------------------------------------------------

export function codexRulesPath(workspace: string, configuration: string): string {
  const id = createHash('sha256').update(configuration).digest('hex').slice(0, 12);
  return join(workspace, '.codex', 'rules', `ours-fleet-${id}.rules`);
}

function readRulesHeader(path: string): RulesHeader | 'foreign' | undefined {
  if (!existsSync(path)) return undefined;
  const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  if (!first.startsWith(RULES_MARKER)) return 'foreign';
  try {
    const header = JSON.parse(first.slice(RULES_MARKER.length)) as RulesHeader;
    return typeof header.configuration === 'string' ? header : 'foreign';
  } catch { return 'foreign'; }
}

interface Registry {
  version: 1;
  /** Every rules file Fleet wrote, so a moved workspace or configuration can be cleaned up. */
  files: Record<string, { configuration: string; holders: string[] }>;
}

const registryPath = (): string => join(stateRoot(), 'managed-cli', 'registry.json');

function withRegistry<T>(work: (registry: Registry) => T): T {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withSynchronousFileLock(`${path}.lock`, () => {
    let registry: Registry = { version: 1, files: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Registry;
        if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') registry = parsed;
      } catch { /* a damaged registry forgets old files; it never deletes on a guess */ }
    }
    const before = JSON.stringify(registry);
    const result = work(registry);
    if (JSON.stringify(registry) !== before) replaceFileAtomically(path, `${JSON.stringify(registry, null, 2)}\n`);
    return result;
  });
}

export type RulesAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'conflict';
export interface RulesResult { path: string; action: RulesAction; detail?: string }

const holderId = (role: string, temp: boolean): string => temp ? `temp:${role}` : role;

/** Write this workspace's rules file and record `holder` as needing it. */
export function acquireCodexRules(
  workspace: string, paths: ManagedCliPaths, workflows: readonly ManagedCliWorkflowId[], holder: string,
): RulesResult {
  const path = codexRulesPath(workspace, paths.configuration);
  return withRegistry(registry => {
    const entry = registry.files[path] ?? { configuration: paths.configuration, holders: [] };
    const header = readRulesHeader(path);
    if (header === 'foreign')
      return { path, action: 'conflict' as const,
        detail: `${path} exists and was not generated by ours-fleet; it is left untouched. Move your rules to another file name in that directory` };
    // Other holders of the same file may declare other workflows; never narrow theirs.
    const wanted = [...new Set([...(header && entry.holders.some(name => name !== holder) ? header.workflows : []), ...workflows])]
      .filter((id): id is ManagedCliWorkflowId => (MANAGED_CLI_WORKFLOW_IDS as readonly string[]).includes(id));
    const content = renderCodexRules(paths, wanted);
    const current = header ? readFileSync(path, 'utf8') : undefined;
    if (current !== content) replaceFileAtomically(path, content, 0o644);
    if (!entry.holders.includes(holder)) entry.holders = [...entry.holders, holder].sort();
    registry.files[path] = entry;
    return { path, action: current === undefined ? 'created' as const : current === content ? 'unchanged' as const : 'updated' as const };
  });
}

/**
 * Drop `holder` from every rules file except `keep`. A file left without a
 * holder is removed when Fleet still owns it; a file other agents hold is left
 * exactly as it is. This is what a launch does when the role stopped declaring
 * the workflow, lost support, or moved to another workspace or configuration.
 */
export function releaseCodexRules(holder: string, keep?: string): RulesResult[] {
  return withRegistry(registry => {
    const results: RulesResult[] = [];
    for (const [path, entry] of Object.entries(registry.files)) {
      if (path === keep || !entry.holders.includes(holder)) continue;
      entry.holders = entry.holders.filter(name => name !== holder);
      if (entry.holders.length) continue;
      const header = readRulesHeader(path);
      if (header && header !== 'foreign') {
        rmSync(path, { force: true });
        results.push({ path, action: 'removed', detail: `${holder} no longer uses it` });
      } else if (header === 'foreign')
        results.push({ path, action: 'conflict', detail: `${path} is no longer Fleet-generated; left untouched` });
      delete registry.files[path];
    }
    return results;
  });
}

/**
 * Bring every registered rules file of `configuration` in line with `expected`
 * (path → persistent holders). Temporary holders stay while their state dir
 * exists. A file nobody holds is removed if — and only if — Fleet still owns
 * it; a file whose configuration no longer exists is obsolete and goes too.
 */
export function reconcileCodexRules(
  configuration: string, expected: ReadonlyMap<string, readonly string[]>, write: boolean,
): RulesResult[] {
  return withRegistry(registry => {
    const results: RulesResult[] = [];
    for (const [path, entry] of Object.entries(registry.files)) {
      const obsolete = entry.configuration !== configuration && !existsSync(entry.configuration);
      if (entry.configuration !== configuration && !obsolete) continue;
      const temporary = entry.holders.filter(name => name.startsWith('temp:')
        && existsSync(agentDir(name.slice('temp:'.length), true)));
      const holders = obsolete ? [] : [...new Set([...(expected.get(path) ?? []), ...temporary])].sort();
      if (holders.length) { if (write) entry.holders = holders; continue; }
      const header = readRulesHeader(path);
      const detail = obsolete ? `configuration ${entry.configuration} no longer exists` : 'no agent declares it for this workspace any more';
      if (!write) { if (header && header !== 'foreign') results.push({ path, action: 'removed', detail: `${detail} (would be removed)` }); continue; }
      if (header && header !== 'foreign') { rmSync(path, { force: true }); results.push({ path, action: 'removed', detail }); }
      else if (header === 'foreign') results.push({ path, action: 'conflict', detail: `${path} is no longer Fleet-generated; left untouched` });
      delete registry.files[path];
    }
    return results;
  });
}

/** Static comparison of the rules file with what this installation would generate. */
export function inspectCodexRules(
  workspace: string, paths: ManagedCliPaths, workflows: readonly ManagedCliWorkflowId[],
): { path: string; state: 'prepared' | 'missing' | 'stale' | 'conflict'; detail: string } {
  const path = codexRulesPath(workspace, paths.configuration);
  const header = readRulesHeader(path);
  if (header === undefined) return { path, state: 'missing', detail: 'rules file not generated yet' };
  if (header === 'foreign') return { path, state: 'conflict', detail: 'a non-Fleet file occupies the Fleet rules file name' };
  const missing = workflows.filter(id => !header.workflows.includes(id));
  const expected = renderCodexRules(paths, [...new Set([...header.workflows, ...workflows])]
    .filter((id): id is ManagedCliWorkflowId => (MANAGED_CLI_WORKFLOW_IDS as readonly string[]).includes(id)));
  if (!missing.length && readFileSync(path, 'utf8') === expected) return { path, state: 'prepared', detail: 'matches this installation' };
  const moved = (['node', 'cli', 'configuration'] as const).filter(key => header[key] !== paths[key]);
  return { path, state: 'stale', detail: moved.length
    ? `generated for another ${moved.join('/')} path (${moved.map(key => header[key]).join(', ')})`
    : missing.length ? `does not cover ${missing.join(', ')}` : 'content differs from what this Fleet generates' };
}

/** Whether Codex treats the workspace as trusted, which is what loads project rules. */
export function codexWorkspaceTrust(
  workspace: string, env: NodeJS.ProcessEnv = process.env,
): { state: 'trusted' | 'untrusted' | 'unknown'; source: string } {
  const source = join(env.CODEX_HOME ?? join(home(), '.codex'), 'config.toml');
  if (!existsSync(source)) return { state: 'unknown', source };
  let text: string;
  try { text = readFileSync(source, 'utf8'); } catch { return { state: 'unknown', source }; }
  const headers = [`[projects.${JSON.stringify(workspace)}]`, `[projects.'${workspace}']`];
  const lines = text.split('\n');
  const start = lines.findIndex(line => headers.includes(line.trim()));
  if (start < 0) return { state: 'untrusted', source };
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/u.test(line)) break;
    const match = /^\s*trust_level\s*=\s*["']([^"']*)["']/u.exec(line);
    if (match) return { state: match[1] === 'trusted' ? 'trusted' : 'untrusted', source };
  }
  return { state: 'untrusted', source };
}

// ---------------------------------------------------------------------------
// Claude: what the operator's own settings do around Fleet's overlay
// ---------------------------------------------------------------------------

export interface ClaudeSettingsInspection {
  /** `unknown` when no readable source states it; Claude's default is then off. */
  sandbox: 'enabled' | 'disabled' | 'unknown';
  sources: string[];
  /** Bash deny rules, which take precedence over Fleet's allow entries. */
  bashDeny: string[];
  unreadable: string[];
}

export function inspectClaudeSettings(
  workspace: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): ClaudeSettingsInspection {
  const managed = platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';
  // Lowest precedence first; a later source overrides `sandbox.enabled`.
  const candidates = [
    join(env.CLAUDE_CONFIG_DIR ?? join(home(), '.claude'), 'settings.json'),
    join(workspace, '.claude', 'settings.json'),
    join(workspace, '.claude', 'settings.local.json'),
    managed,
  ];
  const result: ClaudeSettingsInspection = { sandbox: 'unknown', sources: [], bashDeny: [], unreadable: [] };
  for (const source of candidates) {
    if (!existsSync(source)) continue;
    try {
      const parsed = JSON.parse(readFileSync(source, 'utf8')) as {
        sandbox?: { enabled?: unknown }; permissions?: { deny?: unknown };
      };
      result.sources.push(source);
      if (typeof parsed.sandbox?.enabled === 'boolean') result.sandbox = parsed.sandbox.enabled ? 'enabled' : 'disabled';
      if (Array.isArray(parsed.permissions?.deny))
        result.bashDeny.push(...parsed.permissions.deny.filter((rule): rule is string =>
          typeof rule === 'string' && /^Bash(?:\(|$)/u.test(rule)));
    } catch { result.unreadable.push(source); }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Launch preparation — the one path every managed session start goes through
// ---------------------------------------------------------------------------

export interface ManagedCliRecord {
  version: 1;
  state: ManagedCliAnalysis['state'] | 'conflict';
  mechanism?: ManagedCliMechanism;
  workflows: ManagedCliWorkflowId[];
  paths: ManagedCliPaths;
  workspace: string;
  /** Hash of everything that decides the generated policy; equal digests mean the same policy. */
  digest: string;
  /** When a policy with this digest was first loaded into a launch. */
  preparedAt: string;
  artifact?: string;
  reasons: string[];
}

export function managedCliDigest(analysis: ManagedCliAnalysis): string {
  return createHash('sha256').update(JSON.stringify([
    analysis.state, analysis.mechanism ?? null, [...analysis.workflows].sort(), analysis.paths, analysis.workspace,
    analysis.workflows.map(id => MANAGED_CLI_WORKFLOWS[id].forms.map(entry => entry.tokens.join(' '))),
  ])).digest('hex');
}

export function readManagedCliRecord(stateDir: string): ManagedCliRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, MANAGED_CLI_RECORD), 'utf8')) as ManagedCliRecord;
    return parsed.version === 1 ? parsed : undefined;
  } catch { return undefined; }
}

/**
 * Prepare the native policy for one launch and return the session prep to use.
 * Never throws: a role whose policy cannot be prepared still launches, exactly
 * as sandboxed as it was, and the reason is logged and recorded.
 */
export function prepareManagedCliLaunch(
  role: ResolvedRole,
  options: {
    stateDir: string; runCwd: string; configPath?: string; temp?: boolean;
    prep: SessionPrep; log(line: string): void; deps?: ManagedCliDeps; now?(): Date;
  },
): SessionPrep {
  const recordPath = join(options.stateDir, MANAGED_CLI_RECORD);
  try {
    const analysis = analyzeManagedCli(role, options.configPath,
      { ...options.deps, temp: options.temp, workspace: options.runCwd });
    let prep = options.prep;
    // A previous launch may have left Fleet entries in the overlay; a role that
    // no longer declares or supports the workflow must not keep them.
    if (role.harness === 'claude-code' && role.session_options?.acp?.command == null) {
      const fragment = analysis.state === 'supported'
        ? claudeManagedCliSettings(analysis.paths, analysis.workflows) : undefined;
      const overlayPath = prep.settingsOverlay ?? join(options.stateDir, '.settings-overlay.json');
      const base = prep.settingsOverlay && existsSync(prep.settingsOverlay)
        ? JSON.parse(readFileSync(prep.settingsOverlay, 'utf8')) as Record<string, unknown> : {};
      const merged = mergeClaudeOverlay(base, fragment);
      if (fragment || prep.settingsOverlay) {
        replaceFileAtomically(overlayPath, `${JSON.stringify(merged, null, 2)}\n`);
        prep = { ...prep, settingsOverlay: overlayPath };
      }
    }
    const holder = holderId(role.name, options.temp === true);
    const released = (keep?: string): void => {
      for (const result of releaseCodexRules(holder, keep))
        options.log(`[${role.name}] managed CLI: Codex rules ${result.action} at ${result.path} (${result.detail})`);
    };
    if (analysis.state === 'not-declared') { released(); rmSync(recordPath, { force: true }); return prep; }

    let state: ManagedCliRecord['state'] = analysis.state;
    let artifact: string | undefined;
    const reasons = [...analysis.reasons];
    if (analysis.state === 'supported' && analysis.mechanism === 'codex-workspace-rules') {
      const result = acquireCodexRules(analysis.workspace, analysis.paths, analysis.workflows, holder);
      artifact = result.path;
      // A changed workspace or configuration: the rules this role held before go.
      released(result.action === 'conflict' ? undefined : result.path);
      if (result.action === 'conflict') { state = 'conflict'; reasons.push(result.detail!); }
      else options.log(`[${role.name}] managed CLI: Codex rules ${result.action} at ${result.path}`);
    } else if (analysis.state === 'supported') {
      released();
      artifact = prep.settingsOverlay;
      options.log(`[${role.name}] managed CLI: Claude permission and sandbox-exclusion entries written to ${artifact}`);
    }
    if (analysis.state !== 'supported') released();
    if (state !== 'supported')
      options.log(`[${role.name}] managed CLI: ${state} — ${reasons.join('; ')}`);
    const digest = managedCliDigest(analysis);
    const previous = readManagedCliRecord(options.stateDir);
    const record: ManagedCliRecord = {
      version: 1, state, ...(analysis.mechanism ? { mechanism: analysis.mechanism } : {}),
      workflows: analysis.workflows, paths: analysis.paths, workspace: analysis.workspace, digest,
      preparedAt: previous?.digest === digest && previous.state === state
        ? previous.preparedAt : (options.now?.() ?? new Date()).toISOString(),
      ...(artifact ? { artifact } : {}), reasons,
    };
    replaceFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return prep;
  } catch (error) {
    options.log(`[${role.name}] managed CLI: preparation failed (${(error as Error).message}); the role launches without it`);
    return options.prep;
  }
}

// ---------------------------------------------------------------------------
// Observed evidence — what the supervisor's audit ledger actually recorded
// ---------------------------------------------------------------------------

export interface ManagedCliObservation {
  /** Per form, the best completed pinned invocation recorded after the current policy was loaded. */
  current: { form: string; effect: ManagedCliForm['effect']; at: string; class: string }[];
  /** Pinned invocations that predate the current policy: history, not verification. */
  historical: number;
  /** Rows pinned to a configuration other than the one this policy was prepared for. */
  foreign: number;
  summary: string;
}

/** Whether Commander answers this argv with help text instead of running the command. */
const asksForHelp = (tail: readonly string[]): boolean => {
  const terminator = tail.indexOf('--');
  return (terminator < 0 ? tail : tail.slice(0, terminator)).some(arg => arg === '--help' || arg === '-h');
};

/** Read the role's audit ledger without mutating or recovering it. */
export function observeManagedCli(stateDir: string, record: ManagedCliRecord | undefined): ManagedCliObservation {
  const none = (summary: string): ManagedCliObservation => ({ current: [], historical: 0, foreign: 0, summary });
  let attempts: { argv?: unknown; invokedAt?: string; outcome?: { class?: string; completedAt?: string } }[];
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, '.fleet-command-audit.json'), 'utf8')) as { attempts?: unknown };
    attempts = Array.isArray(parsed.attempts) ? parsed.attempts as typeof attempts : [];
  } catch { return none('not observed: this role has no supervisor audit ledger yet'); }
  const latest = new Map<string, ManagedCliObservation['current'][number]>();
  let historical = 0, foreign = 0;
  // Erasing a task or room replaces every argv word of its rows by a hash. The
  // words that decide what a row is evidence of are a small fixed vocabulary, so
  // they stay recognisable without the ledger holding any erased content.
  const vocabulary = [MANAGED_CONFIGURATION_FLAG, '--help', '-h', '--',
    ...allForms(MANAGED_CLI_WORKFLOW_IDS).flatMap(entry => entry.tokens),
    ...(record?.paths?.configuration ? [managedPinMarker(record.paths.configuration)] : [])];
  const erased = new Map(vocabulary.map(word => [erasedArg(word), word]));
  for (const attempt of attempts) {
    if (!Array.isArray(attempt.argv)) continue;
    const argv = attempt.argv.map(String).map(word => erased.get(word) ?? word);
    if (argv[0] !== MANAGED_CONFIGURATION_FLAG) continue;
    const entry = parseManagedEntry(['--managed-configuration', '/', ...argv.slice(2)]);
    if (entry.kind !== 'pinned' || !attempt.outcome?.completedAt) continue;
    if (!record || attempt.outcome.completedAt < record.preparedAt) { historical++; continue; }
    // Evidence for THIS policy only: a row pinned to another configuration ran under other
    // rules. The ledger holds the pin as a fingerprint; a row without one is not attributable.
    if (argv[1] !== managedPinMarker(record.paths.configuration)) { foreign++; continue; }
    // The row records what was typed, and `task create --help` only printed help:
    // it is evidence for the help path of that command, never for the command.
    const help = entry.form.effect !== 'help' && asksForHelp(argv.slice(2 + entry.form.tokens.length));
    const name = `${entry.form.tokens.join(' ')}${help ? ' --help' : ''}`;
    // One success is the evidence; a later refusal of the same form does not erase it.
    if (latest.get(name)?.class === 'success' && attempt.outcome.class !== 'success') continue;
    latest.set(name, { form: name, effect: help ? 'help' : entry.form.effect, at: attempt.outcome.completedAt, class: attempt.outcome.class ?? 'unknown' });
  }
  const current = [...latest.values()].sort((a, b) => a.form.localeCompare(b.form));
  const succeeded = current.filter(item => item.class === 'success');
  const lifecycle = succeeded.filter(item => item.effect === 'lifecycle');
  const failed = current.filter(item => item.class !== 'success');
  const past = (failed.length ? ` Audited but not completed successfully: ${failed.map(item => `${item.form} (${item.class})`).join(', ')}.` : '')
    + (historical ? ` ${historical} earlier pinned invocation(s) predate the current policy and verify nothing about it.` : '')
    + (foreign ? ` ${foreign} invocation(s) pinned to another configuration, or not attributable to one, are not evidence for this policy.` : '');
  if (!succeeded.length)
    return { current, historical, foreign, summary: `not observed: no pinned invocation has completed through the supervisor since the current policy was loaded.${past}` };
  if (!lifecycle.length)
    return { current, historical, foreign, summary: `supervisor reached by ${succeeded.map(item => item.form).join(', ')} only; help and read commands prove their own audited path, not the task lifecycle.${past}` };
  return { current, historical, foreign, summary: `supervisor reached by ${succeeded.map(item => item.form).join(', ')}; lifecycle commands not listed remain unobserved.${past}` };
}

// ---------------------------------------------------------------------------
// Setup and status — what the installer and `doctor` call. Never starts a session.
// ---------------------------------------------------------------------------

export interface ManagedCliRoleReport {
  role: string;
  harness: string;
  session: string;
  workflows: ManagedCliWorkflowId[];
  /** Generated configuration compared with this installation. Static. */
  setup: {
    state: 'not-declared' | 'not-required' | 'unsupported' | 'prepared' | 'missing' | 'stale' | 'conflict' | 'generated-at-launch';
    mechanism?: ManagedCliMechanism;
    artifact?: string;
    action?: RulesAction;
    detail: string;
  };
  /** Whether the session that is (or was last) running loaded the current policy. */
  session_policy: 'not-applicable' | 'never-launched' | 'current' | 'restart-required';
  /** From the audit ledger. Never inferred from `setup`. */
  observed: ManagedCliObservation;
  commandPrefix?: string;
  scope: string[];
  warnings: string[];
}

export interface ManagedCliReport {
  version: 1;
  configuration: string;
  node: string;
  cli: string;
  platform: { os: NodeJS.Platform; declared: boolean };
  wrote: boolean;
  roles: ManagedCliRoleReport[];
  removed: RulesResult[];
  disclosure: string[];
}

export function managedCliReport(
  cfg: Pick<FleetConfig, 'roles'>, configPath: string | undefined,
  options: ManagedCliDeps & { write: boolean; env?: NodeJS.ProcessEnv },
): ManagedCliReport {
  const paths = managedCliPaths(configPath, options.paths);
  const platform = options.platform ?? process.platform;
  const expected = new Map<string, string[]>();
  const roles: ManagedCliRoleReport[] = [];
  for (const role of cfg.roles) {
    const analysis = analyzeManagedCli(role, configPath, options);
    const stateDir = agentDir(role.name);
    const record = readManagedCliRecord(stateDir);
    const warnings: string[] = [];
    const env = { ...(options.env ?? process.env), ...(role.env ?? {}) };
    let setup: ManagedCliRoleReport['setup'];
    if (analysis.state !== 'supported') {
      setup = { state: analysis.state, ...(analysis.mechanism ? { mechanism: analysis.mechanism } : {}),
        detail: analysis.reasons.join('; ') || 'the agent does not declare managed_cli' };
    } else if (analysis.mechanism === 'codex-workspace-rules') {
      const path = codexRulesPath(analysis.workspace, paths.configuration);
      expected.set(path, [...(expected.get(path) ?? []), holderId(role.name, false)]);
      let action: RulesAction | undefined;
      if (options.write) action = acquireCodexRules(analysis.workspace, paths, analysis.workflows, role.name).action;
      const inspected = inspectCodexRules(analysis.workspace, paths, analysis.workflows);
      setup = { state: inspected.state, mechanism: analysis.mechanism, artifact: inspected.path,
        ...(action ? { action } : {}), detail: inspected.detail };
      const trust = codexWorkspaceTrust(analysis.workspace, env);
      if (trust.state !== 'trusted')
        warnings.push(`Codex does not record ${analysis.workspace} as a trusted project (${trust.source}: ${trust.state}); `
          + 'project rules load only in trusted workspaces. Trust it through Codex\'s own prompt or configuration — Fleet does not change trust');
    } else {
      setup = { state: 'generated-at-launch', mechanism: analysis.mechanism,
        artifact: join(stateDir, '.settings-overlay.json'),
        detail: 'Claude entries are written into the agent\'s own settings overlay each time its session starts' };
      const claude = inspectClaudeSettings(analysis.workspace, env, platform);
      warnings.push(claude.sandbox === 'enabled'
        ? `Claude's OS sandbox is enabled in your settings (${claude.sources.join(', ')}); Fleet's exclusions place the prepared commands outside it`
        : `Claude's OS sandbox is ${claude.sandbox === 'disabled' ? 'disabled' : 'not enabled by any readable settings file'}: Fleet's sandbox exclusions are inert and only the Bash permission entries take effect. Fleet does not enable the sandbox; no sandbox qualification is claimed for this agent`);
      if (claude.bashDeny.length)
        warnings.push(`your Claude settings deny ${claude.bashDeny.join(', ')}; deny rules win over Fleet's allow entries and are left in place`);
      if (claude.unreadable.length)
        warnings.push(`could not read ${claude.unreadable.join(', ')}; their effect on the sandbox and on Bash permissions is unknown`);
    }
    const supported = analysis.state === 'supported';
    const session_policy: ManagedCliRoleReport['session_policy'] = !supported && !record ? 'not-applicable'
      : !record ? 'never-launched'
        : record.digest === managedCliDigest(analysis) && (!supported || record.state === 'supported') ? 'current'
          : 'restart-required';
    roles.push({
      role: role.name, harness: role.harness, session: role.session, workflows: analysis.workflows,
      setup, session_policy,
      observed: supported || record ? observeManagedCli(stateDir, session_policy === 'current' ? record : undefined)
        : { current: [], historical: 0, foreign: 0, summary: 'not applicable' },
      ...(analysis.commandPrefix ? { commandPrefix: analysis.commandPrefix } : {}),
      scope: analysis.scope, warnings,
    });
  }
  const removed = reconcileCodexRules(paths.configuration, expected, options.write);
  return {
    version: 1, ...paths,
    platform: { os: platform, declared: platform === 'linux' || platform === 'darwin' },
    wrote: options.write, roles, removed,
    disclosure: [
      'setup is static: it generates and compares configuration and never starts an agent session or a model.',
      'observed comes only from the supervisor audit ledger; a prepared setup is not evidence that a command reached the supervisor.',
      'A running session keeps the policy it started with; restart agents listed as restart-required.',
      ...(platform === 'darwin' ? [
        'macOS: the generated policy uses the same mechanisms qualified on Linux, but the generated-setup integration matrix has not been run on macOS for this release. Treat observed, not setup, as the evidence here.',
      ] : []),
    ],
  };
}

/** Whether a regular file the caller owns sits at `path`. */
const regularFile = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};

/**
 * Add a workflow to an existing Agent file, and nothing else. Comments, key
 * order and every other setting — permissions included — are preserved.
 */
export function enableManagedCli(
  configPath: string | undefined, agent: string, workflow: ManagedCliWorkflowId,
): { file: string; changed: boolean } {
  const root = splitRootFor(resolve(configPath ?? defaultConfigPath()));
  const file = ['.yaml', '.yml'].map(extension => join(root, 'agents', `${agent}${extension}`)).find(regularFile);
  if (!file) throw new Error(`agent '${agent}' has no definition file under ${join(root, 'agents')}; `
    + 'only configured persistent Agents can be enabled here. For a template, add `managed_cli: [task-workflow]` to its file');
  const document = parseDocument(readFileSync(file, 'utf8'));
  if (document.errors.length) throw new Error(`${file}: ${document.errors[0]!.message}`);
  const path = document.has('template') ? ['overrides', 'managed_cli'] : ['managed_cli'];
  const current = document.getIn(path, true) as { toJSON?(): unknown } | undefined;
  const existing = current?.toJSON ? current.toJSON() : current;
  if (existing !== undefined && !Array.isArray(existing))
    throw new Error(`${file}: managed_cli must be a list; fix it before enabling a workflow`);
  if ((existing as unknown[] | undefined)?.includes(workflow)) return { file, changed: false };
  // Edit the text, not the document: re-serializing YAML would re-fold long
  // lines and re-space flow collections the operator wrote. The parsed document
  // is used only to find where the one value goes.
  const source = readFileSync(file, 'utf8');
  const ends = source === '' || source.endsWith('\n') ? '' : '\n';
  const value = `[${[...((existing as unknown[] | undefined) ?? []), workflow].join(', ')}]`;
  const range = (node: unknown): [number, number] | undefined => {
    const found = (node as { range?: [number, number, number] } | undefined)?.range;
    return found ? [found[0], found[1]] : undefined;
  };
  const overrides = path.length === 2 ? document.get('overrides', true) as { items?: { key: unknown }[]; flow?: boolean } | undefined : undefined;
  let next: string | undefined;
  if (existing !== undefined) {
    const at = range(current);
    if (at) next = `${source.slice(0, at[0])}${value}${source.slice(at[1])}`;
  } else if (path.length === 1) {
    next = `${source}${ends}managed_cli: ${value}\n`;
  } else if (overrides === undefined) {
    next = `${source}${ends}overrides:\n  managed_cli: ${value}\n`;
  } else if (!overrides.flow && overrides.items?.length) {
    const at = range(overrides.items[0]!.key);
    const line = at ? source.lastIndexOf('\n', at[0] - 1) + 1 : -1;
    if (at && /^[ ]*$/u.test(source.slice(line, at[0])))
      next = `${source.slice(0, line)}${source.slice(line, at[0])}managed_cli: ${value}\n${source.slice(line)}`;
  }
  if (next === undefined) {
    // A shape with no safe insertion point (for example a flow-style overrides
    // map): fall back to the YAML writer, which keeps comments but may respace.
    document.setIn(path, document.createNode([...((existing as unknown[] | undefined) ?? []), workflow], { flow: true }));
    next = document.toString({ lineWidth: 0 });
  }
  // Never write something that no longer says what was asked for.
  const verify = parseDocument(next);
  const written = verify.getIn(path) as { toJSON?(): unknown } | undefined;
  if (verify.errors.length || !((written?.toJSON ? written.toJSON() : written) as unknown[] | undefined)?.includes(workflow))
    throw new Error(`${file}: could not add managed_cli safely; add \`managed_cli: [${workflow}]\` to the Agent by hand`);
  replaceFileAtomically(file, next, statSync(file).mode & 0o777);
  return { file, changed: true };
}

/** The briefing section for a role, or nothing when it declares no workflow. */
export function managedCliBriefing(role: ResolvedRole, configPath: string | undefined, temp = false): string[] {
  const analysis = analyzeManagedCli(role, configPath, { temp });
  if (analysis.state === 'not-declared') return [];
  if (analysis.state === 'not-required') return [];
  if (analysis.state !== 'supported' || !analysis.commandPrefix) return [
    '', '### Fleet commands outside the command sandbox',
    'This role declares a managed Fleet workflow, but Fleet could not prepare it for this launch:',
    ...analysis.reasons.map(reason => `- ${reason}`),
    'Fleet commands therefore stay inside your command sandbox and may fail with `connect EPERM`.',
    'Report that as a blocker; do not look for another way to run them.',
  ];
  const forms = allForms(analysis.workflows);
  const list = (effect: ManagedCliForm['effect']) =>
    forms.filter(entry => entry.effect === effect).map(entry => `\`${entry.tokens.join(' ')}\``).join(', ');
  return [
    '', '### Fleet commands outside the command sandbox',
    'Your command sandbox blocks the supervisor socket every `ours-fleet` call needs. Fleet prepared',
    'these commands to run outside it. Wherever your instructions say `ours-fleet <command>`, type',
    'this exact prefix instead, as one simple command:',
    '', '```sh', `${analysis.commandPrefix} <command> [options]`, '```', '',
    `Prepared: ${list('lifecycle')}; ${list('read')}; ${list('help')}.`,
    'Spell the prefix exactly as shown, quotes included. Quote option values normally',
    '(`--title "Two words"`). Do not add `-c`/`--configuration`: the prefix pins it and another',
    'value is refused. A line with `&&`, `;`, a pipe, a redirect, `$(...)` or a leading `VAR=value`',
    'does not match and runs inside the sandbox.',
    'Every other Fleet command — `spawn`, `ours call`, `status`, `peek`, `send`, room deletion —',
    'is not prepared here and will be refused by the sandbox. Report that; do not work around it.',
  ];
}
