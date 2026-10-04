import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type ResolvedRole } from '../src/config.js';
import { generateBriefing } from '../src/briefing.js';
import { CAPABILITIES } from '../src/capabilities.js';
import { doctor } from '../src/doctor.js';
import '../src/harness/claude-code.js';
import { claudeCodeAdapter, makeClaudeCodeAdapter } from '../src/harness/claude-code.js';
import '../src/harness/codex.js';
import '../src/harness/hermes.js';
import {
  MANAGED_CLI_RECORD, MANAGED_CLI_WORKFLOWS, acquireCodexRules, analyzeManagedCli,
  claudeManagedCliSettings, codexRulesPath, codexWorkspaceTrust, enableManagedCli,
  inspectClaudeSettings, inspectCodexRules, managedCliBriefing, managedCliCommandPrefix,
  managedCliPrefix, managedCliReport, mergeClaudeOverlay, observeManagedCli,
  prepareManagedCliLaunch, readManagedCliRecord, reconcileCodexRules, renderCodexRules,
  shellSpelling, type ManagedCliPaths,
} from '../src/managed-cli.js';
import { agentDir } from '../src/paths.js';
import { resolvedPlan } from '../src/resolved-plan.js';

let root: string, workspace: string, config: string;
const PATHS: ManagedCliPaths = { node: '/opt/node/bin/node', cli: '/opt/fleet/dist/cli.js', configuration: '/srv/fleet/fleet.yaml' };
const SPACED: ManagedCliPaths = { node: '/opt/node/bin/node', cli: '/Users/a b/Application Support/fleet/dist/cli.js', configuration: '/srv/my fleet/fleet.yaml' };
const FORMS = MANAGED_CLI_WORKFLOWS['task-workflow'].forms;

const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: 'Coordinator', harness: 'codex', session: 'codex-app-server', identity: 'Coordinator',
  sourceFile: 'x', permissionsDeclared: true,
  permissions: { approval: 'auto', filesystem: 'workspace', unattended: 'deny' },
  managed_cli: ['task-workflow'], cwd: workspace, ...over,
} as ResolvedRole);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-cli-')));
  workspace = join(root, 'workspace'); mkdirSync(workspace);
  process.env.OURS_FLEET_HOME = root;
  config = join(root, 'fleet.yaml');
});
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(root, { recursive: true, force: true }); });

/** A real split configuration with one Agent file per entry, modes as Fleet requires. */
function fleet(agents: Record<string, string>, file = config): void {
  writeFileSync(file, 'api_version: ours.network/fleet/v2\n', { mode: 0o600 });
  const dir = join(file.replace(/\.yaml$/u, ''), 'agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, body] of Object.entries(agents)) writeFileSync(join(dir, `${name}.yaml`), body, { mode: 0o600 });
}
const agent = (harness: string, session: string, extra = '') =>
  `# operator comment\nrole: { inline: { mission: coordinate } }\nbrain: { inline: { harness: ${harness}, session: ${session} } }\n`
  + `permissions: { approval: auto, filesystem: workspace, unattended: deny }\ncwd: ${workspace}\n${extra}`;

const codexBin = (() => {
  const found = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : undefined;
})();
/** Codex's own policy engine, no model: what the generated rules decide for one argv. */
function codexDecision(rules: string, argv: string[]): string | undefined {
  const file = join(root, 'check.rules'); writeFileSync(file, rules);
  const out = execFileSync(codexBin!, ['execpolicy', 'check', '--rules', file, '--', ...argv],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, 'codex-home') } });
  return (JSON.parse(out) as { decision?: string }).decision;
}

describe('generated native policy', () => {
  it('fixes node, CLI, pin, configuration and command in every Codex rule', () => {
    const text = renderCodexRules(PATHS, ['task-workflow']);
    const rules = text.split('\n').filter(line => line.startsWith('prefix_rule'));
    expect(rules).toHaveLength(FORMS.length);
    for (const form of FORMS)
      expect(text).toContain(`prefix_rule(pattern=${JSON.stringify([...managedCliPrefix(PATHS), ...form.tokens])}, decision="allow")`);
    // No rule is shorter than the full pin plus a command: never a bare node/CLI/Fleet grant.
    for (const line of rules) {
      const pattern = JSON.parse(/pattern=(\[.*\]), decision/u.exec(line)![1]!) as string[];
      expect(pattern.slice(0, 4)).toEqual(['/opt/node/bin/node', '/opt/fleet/dist/cli.js', '--managed-configuration', '/srv/fleet/fleet.yaml']);
      expect(pattern.length).toBeGreaterThan(4);
    }
    expect(text).not.toMatch(/spawn|"delete"|"ours"|"send"|"peek"|"status"|"cancel"/u);
  });

  it.skipIf(!codexBin).each([['plain paths', PATHS], ['paths with spaces', SPACED]])(
    'is what real Codex execpolicy grants and refuses: %s', (_name, paths) => {
      const rules = renderCodexRules(paths, ['task-workflow']);
      const pin = managedCliPrefix(paths);
      for (const form of FORMS) expect(codexDecision(rules, [...pin, ...form.tokens])).toBe('allow');
      // Variable options, quoted values and paths after the prefix are admitted — by design, and disclosed.
      expect(codexDecision(rules, [...pin, 'task', 'create', '--title', 'Two words', '--brief', "it's \"quoted\"",
        '--brief-file', '/tmp/a b/brief.md', '--backlog', '--no-room'])).toBe('allow');
      expect(codexDecision(rules, [...pin, 'task', 'start', 'T1', '--template', 'pair', '--member', 'developer',
        '--cwd', '/work/a b', '--filesystem', 'unrestricted'])).toBe('allow');
      // The native boundary itself does NOT see a late configuration; Fleet refuses it at run time.
      expect(codexDecision(rules, [...pin, 'task', 'list', '--configuration', '/other.yaml'])).toBe('allow');
      const refused: string[][] = [
        [paths.node, paths.cli, 'task', 'list'],                                         // no pin
        [paths.node, paths.cli, '--managed-configuration', '/other/fleet.yaml', 'task', 'list'],
        [paths.node, paths.cli, '--managed-configuration', `${paths.configuration}.bak`, 'task', 'list'],
        [paths.node, '/elsewhere/cli.js', ...pin.slice(2), 'task', 'list'],
        ['/usr/bin/node', ...pin.slice(1), 'task', 'list'],
        ['node', ...pin.slice(1), 'task', 'list'],
        [paths.node, '--require', '/w/preload.cjs', ...pin.slice(1), 'task', 'list'],
        [paths.node, '-e', 'process.exit(0)'],
        [paths.node], [paths.node, paths.cli], pin,
        [...pin, 'spawn', 'X', '--temp'], [...pin, 'room', 'delete', 'r', 'r'], [...pin, 'room', 'create'],
        [...pin, 'task', 'delete', 't', 't'], [...pin, 'task', 'cancel', 't', 't'], [...pin, 'task'],
        [...pin, 'ours', 'call', 'A', 't'], [...pin, 'status', 'A'], [...pin, 'send', 'A', 'x'],
        [...pin, '--configuration', '/other.yaml', 'task', 'list'],
        ['env', 'NODE_OPTIONS=--require=/w/p.cjs', ...pin, 'task', 'list'],
        ['bash', '-lc', `${pin.join(' ')} task list`],
      ];
      for (const argv of refused) expect(codexDecision(rules, argv), argv.join(' ')).toBeUndefined();
    });

  it('spells a path that needs quoting in single quotes, and refuses what has no spelling', () => {
    expect(shellSpelling('/opt/node/bin/node')).toBe('/opt/node/bin/node');
    expect(shellSpelling('/Users/a b/Application Support/x')).toBe("'/Users/a b/Application Support/x'");
    expect(shellSpelling('/home/$USER/x')).toBe("'/home/$USER/x'");
    for (const bad of ["/o'brien/node", '/a\\b', '/a\nb', '/a\tb']) expect(shellSpelling(bad)).toBeUndefined();
    expect(managedCliCommandPrefix(SPACED)).toBe(
      "/opt/node/bin/node '/Users/a b/Application Support/fleet/dist/cli.js' --managed-configuration '/srv/my fleet/fleet.yaml'");
    expect(managedCliCommandPrefix({ ...PATHS, cli: "/o'brien/cli.js" })).toBeUndefined();
    // Qualified against real Codex 0.160.0 and Claude 2.1.289: a quoted executable never matches.
    expect(managedCliCommandPrefix({ ...PATHS, node: '/opt/my node/bin/node' })).toBeUndefined();
    expect(claudeManagedCliSettings({ ...PATHS, node: '/opt/my node/bin/node' }, ['task-workflow'])).toBeUndefined();
  });

  it('pairs every Claude permission with the same sandbox exclusion', () => {
    const settings = claudeManagedCliSettings(SPACED, ['task-workflow'])!;
    const prefix = managedCliCommandPrefix(SPACED)!;
    expect(settings.sandbox.excludedCommands).toHaveLength(FORMS.length * 2);
    expect(settings.permissions.allow).toEqual(settings.sandbox.excludedCommands.map(pattern => `Bash(${pattern})`));
    for (const form of FORMS) {
      expect(settings.sandbox.excludedCommands).toContain(`${prefix} ${form.tokens.join(' ')}`);
      expect(settings.sandbox.excludedCommands).toContain(`${prefix} ${form.tokens.join(' ')} *`);
    }
    for (const pattern of settings.sandbox.excludedCommands) {
      expect(pattern.startsWith(`${prefix} `)).toBe(true);
      expect(pattern).not.toMatch(/^\S+ \*$|Bash\(\*\)/u);
    }
    expect(JSON.stringify(settings)).not.toMatch(/"enabled"|bypassPermissions|allowUnsandboxedCommands/u);
    expect(claudeManagedCliSettings({ ...PATHS, cli: "/o'brien/cli.js" }, ['task-workflow'])).toBeUndefined();
  });

  it('merges into the overlay without touching anything that is not its own', () => {
    const base = {
      enabledPlugins: { 'x@y': true },
      permissions: { deny: ['Bash(rm *)'], allow: ['Read(*)', 'Bash(/old/node /old/cli.js --managed-configuration /old.yaml task list *)'], defaultMode: 'acceptEdits' },
      sandbox: { enabled: true, failIfUnavailable: true, excludedCommands: ['docker *', '/old/node /old/cli.js --managed-configuration /old.yaml task list'] },
    };
    const fragment = claudeManagedCliSettings(PATHS, ['task-workflow'])!;
    const merged = mergeClaudeOverlay(base, fragment) as typeof base;
    expect(merged.enabledPlugins).toEqual(base.enabledPlugins);
    expect(merged.permissions.deny).toEqual(['Bash(rm *)']);
    expect(merged.permissions.defaultMode).toBe('acceptEdits');
    expect(merged.sandbox.enabled).toBe(true);
    expect(merged.sandbox.failIfUnavailable).toBe(true);
    expect(merged.permissions.allow).toEqual(['Read(*)', ...fragment.permissions.allow]);
    expect(merged.sandbox.excludedCommands).toEqual(['docker *', ...fragment.sandbox.excludedCommands]);
    // Idempotent, and removal leaves exactly the operator's own entries.
    expect(mergeClaudeOverlay(merged, fragment)).toEqual(merged);
    expect(mergeClaudeOverlay(merged, undefined)).toEqual({
      enabledPlugins: base.enabledPlugins,
      permissions: { deny: ['Bash(rm *)'], allow: ['Read(*)'], defaultMode: 'acceptEdits' },
      sandbox: { enabled: true, failIfUnavailable: true, excludedCommands: ['docker *'] },
    });
    // Never introduces a sandbox switch of its own.
    expect(mergeClaudeOverlay({}, fragment)).toEqual({ permissions: { allow: fragment.permissions.allow }, sandbox: { excludedCommands: fragment.sandbox.excludedCommands } });
    expect(mergeClaudeOverlay({}, undefined)).toEqual({});
  });
});

describe('which combinations Fleet prepares', () => {
  const analyze = (over: Partial<ResolvedRole> = {}, deps: Parameters<typeof analyzeManagedCli>[2] = {}) =>
    analyzeManagedCli(role(over), '/srv/fleet/fleet.yaml', { paths: PATHS, platform: 'linux', ...deps });

  it('prepares nothing for a role that does not declare it, whatever it is called', () => {
    for (const name of ['Coordinator', 'FleetCoordinator', 'Owner'])
      expect(analyze({ name, managed_cli: undefined, persona: 'You are the fleet Coordinator. Run ours-fleet task start.' }).state).toBe('not-declared');
    expect(analyze({ managed_cli: [] }).state).toBe('not-declared');
  });

  it.each([
    ['codex', 'codex-app-server', 'codex-workspace-rules'],
    ['codex', 'acp', 'codex-workspace-rules'],
    ['claude-code', 'acp', 'claude-session-settings'],
  ] as const)('supports %s/%s on Linux and macOS', (harness, session, mechanism) => {
    for (const platform of ['linux', 'darwin'] as const) {
      const result = analyze({ harness, session }, { platform });
      expect(result).toMatchObject({ state: 'supported', mechanism });
      expect(result.commandPrefix).toBe('/opt/node/bin/node /opt/fleet/dist/cli.js --managed-configuration /srv/fleet/fleet.yaml');
      expect(result.scope.join('\n')).toContain('every trailing option and argument is admitted');
      expect(result.scope.join('\n')).toContain('task start and task finish provision and retire');
      expect(result.scope.join('\n')).toContain('Not prepared and still sandboxed: spawn');
    }
  });

  it.each([
    ['windows', {}, { platform: 'win32' as const }, /platform 'win32' is not qualified/u],
    ['hermes', { harness: 'hermes', session: 'acp' as const }, {}, /harness 'hermes' has no qualified native execution policy/u],
    ['custom Codex ACP', { session: 'acp' as const, session_options: { acp: { command: ['my-acp'] } } }, {}, /custom session_options\.acp\.command/u],
    ['custom app-server', { session_options: { codex_app_server: { command: 'x app-server' } } }, {}, /custom session_options\.codex_app_server\.command/u],
    ['custom Claude ACP', { harness: 'claude-code', session: 'acp' as const, session_options: { acp: { command: 'x' } } }, {}, /cannot receive Fleet's settings overlay/u],
    ['outer isolation', { isolation: { network: 'none' } as never }, {}, /declares isolation:.*outer sandbox is kept as-is/u],
    ['unspellable path', {}, { paths: { ...PATHS, cli: "/o'brien/cli.js" } }, /Fleet CLI path .* has no qualified shell spelling/u],
    ['Node at a path with spaces', {}, { paths: { ...PATHS, node: '/opt/my node/bin/node' } }, /neither Codex nor Claude matches a quoted executable against a rule/u],
    ['Node at a path with spaces (Claude)', { harness: 'claude-code', session: 'acp' as const }, { paths: { ...PATHS, node: '/Applications/My Node/node' } }, /neither Codex nor Claude matches a quoted executable/u],
    ['quoted path on old Codex', {}, { paths: SPACED, codexVersion: '0.159.0' }, /Codex 0\.159\.0 does not match against rules; upgrade Codex to >=0\.160\.0/u],
    ['quoted path, unreadable Codex', { env: { CODEX_PATH: '/nonexistent/codex' } }, { paths: SPACED }, /this role's Codex version could not be read/u],
  ])('reports %s as unsupported with a reason and no expansion', (_name, over, deps, reason) => {
    const result = analyze(over as Partial<ResolvedRole>, deps);
    expect(result.state).toBe('unsupported');
    expect(result.reasons.join('\n')).toMatch(reason);
    expect(result.commandPrefix).toBeUndefined();
    expect(result.scope).toEqual([]);
  });

  it('refuses to anchor a rule on a file the agent can rewrite', () => {
    for (const key of ['node', 'cli', 'configuration'] as const) {
      const result = analyze({}, { paths: { ...PATHS, [key]: join(workspace, 'bin', 'x') } });
      expect(result.state).toBe('unsupported');
      expect(result.reasons.join('\n')).toContain('is inside the agent-writable workspace');
    }
  });

  it('qualifies quoted paths from Codex 0.160.0 and for Claude', () => {
    expect(analyze({}, { paths: SPACED, codexVersion: '0.160.0' }).state).toBe('supported');
    expect(analyze({}, { paths: SPACED, codexVersion: 'codex-cli 0.161.2' }).state).toBe('supported');
    expect(analyze({ harness: 'claude-code', session: 'acp' }, { paths: SPACED }).commandPrefix).toBe(managedCliCommandPrefix(SPACED));
  });

  it('generates nothing when Codex has no command sandbox', () => {
    const result = analyze({ permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'deny' } });
    expect(result.state).toBe('not-required');
    expect(result.reasons[0]).toContain('danger-full-access');
    // Restricted filesystem intents all keep a sandbox and are prepared.
    for (const filesystem of ['workspace', 'read-only'] as const)
      expect(analyze({ permissions: { approval: 'auto', filesystem, unattended: 'deny' } }).state).toBe('supported');
  });
});

describe('Codex workspace rules: ownership, idempotence and migration', () => {
  const rulesDir = () => join(workspace, '.codex', 'rules');
  const paths = (): ManagedCliPaths => ({ ...PATHS, configuration: config });

  it('creates once, then leaves the file byte- and mtime-identical', () => {
    writeFileSync(config, '');
    const first = acquireCodexRules(workspace, paths(), ['task-workflow'], 'A');
    expect(first.action).toBe('created');
    expect(first.path).toBe(codexRulesPath(workspace, config));
    const before = statSync(first.path);
    expect(before.mode & 0o022).toBe(0);
    expect(acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').action).toBe('unchanged');
    expect(acquireCodexRules(workspace, paths(), ['task-workflow'], 'B').action).toBe('unchanged');
    expect(statSync(first.path).mtimeMs).toBe(before.mtimeMs);
    expect(inspectCodexRules(workspace, paths(), ['task-workflow']).state).toBe('prepared');
  });

  it('preserves the operator\'s own rules and never overwrites a file it did not write', () => {
    writeFileSync(config, '');
    mkdirSync(rulesDir(), { recursive: true });
    const own = join(rulesDir(), 'mine.rules');
    writeFileSync(own, 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
    const target = codexRulesPath(workspace, config);
    writeFileSync(target, 'prefix_rule(pattern=["make"], decision="allow")\n');
    const result = acquireCodexRules(workspace, paths(), ['task-workflow'], 'A');
    expect(result.action).toBe('conflict');
    expect(result.detail).toContain('was not generated by ours-fleet');
    expect(readFileSync(target, 'utf8')).toBe('prefix_rule(pattern=["make"], decision="allow")\n');
    expect(inspectCodexRules(workspace, paths(), ['task-workflow']).state).toBe('conflict');
    // A marker line that no longer parses is treated the same way: not ours to replace.
    writeFileSync(target, '# ours-fleet managed-cli v1 {broken\nprefix_rule(pattern=["node"], decision="allow")\n');
    expect(acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').action).toBe('conflict');
    rmSync(target);
    expect(acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').action).toBe('created');
    expect(readFileSync(own, 'utf8')).toBe('prefix_rule(pattern=["git", "status"], decision="allow")\n');
    expect(readdirSync(rulesDir()).sort()).toEqual(['mine.rules', target.split('/').pop()].sort());
  });

  it('replaces manual edits inside its own file and follows a moved node or CLI', () => {
    writeFileSync(config, '');
    const { path } = acquireCodexRules(workspace, paths(), ['task-workflow'], 'A');
    writeFileSync(path, `${readFileSync(path, 'utf8')}prefix_rule(pattern=["/opt/node/bin/node"], decision="allow")\n`);
    expect(inspectCodexRules(workspace, paths(), ['task-workflow'])).toMatchObject({ state: 'stale', detail: 'content differs from what this Fleet generates' });
    expect(acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').action).toBe('updated');
    expect(readFileSync(path, 'utf8')).toBe(renderCodexRules(paths(), ['task-workflow']));

    const moved = { ...paths(), node: '/new/node', cli: '/new/fleet/dist/cli.js' };
    expect(inspectCodexRules(workspace, moved, ['task-workflow'])).toMatchObject({
      state: 'stale', detail: 'generated for another node/cli path (/opt/node/bin/node, /opt/fleet/dist/cli.js)' });
    expect(acquireCodexRules(workspace, moved, ['task-workflow'], 'A')).toMatchObject({ action: 'updated', path });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('"/new/node", "/new/fleet/dist/cli.js"'.replace(', ', ','));
    expect(text).not.toContain('/opt/node/bin/node');
    expect(readdirSync(rulesDir())).toHaveLength(1);
  });

  it('keeps a shared file while any agent holds it and removes it with the last one', () => {
    writeFileSync(config, '');
    const path = codexRulesPath(workspace, config);
    acquireCodexRules(workspace, paths(), ['task-workflow'], 'A');
    acquireCodexRules(workspace, paths(), ['task-workflow'], 'B');
    expect(reconcileCodexRules(config, new Map([[path, ['B']]]), true)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    // A dry run reports and changes nothing.
    expect(reconcileCodexRules(config, new Map(), false)).toMatchObject([{ path, action: 'removed' }]);
    expect(existsSync(path)).toBe(true);
    expect(reconcileCodexRules(config, new Map(), true)).toMatchObject([{ path, action: 'removed', detail: 'no agent declares it for this workspace any more' }]);
    expect(existsSync(path)).toBe(false);
    expect(reconcileCodexRules(config, new Map(), true)).toEqual([]);
  });

  it('keeps a temporary agent\'s file until that agent is gone', () => {
    writeFileSync(config, '');
    const path = acquireCodexRules(workspace, paths(), ['task-workflow'], 'temp:Member').path;
    mkdirSync(agentDir('Member', true), { recursive: true });
    expect(reconcileCodexRules(config, new Map(), true)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    rmSync(agentDir('Member', true), { recursive: true });
    expect(reconcileCodexRules(config, new Map(), true)).toMatchObject([{ action: 'removed' }]);
    expect(existsSync(path)).toBe(false);
  });

  it('never lets two configurations in one workspace overwrite each other', () => {
    const second = join(root, 'second.yaml');
    writeFileSync(config, ''); writeFileSync(second, '');
    const a = acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').path;
    const b = acquireCodexRules(workspace, { ...PATHS, configuration: second }, ['task-workflow'], 'A').path;
    expect(a).not.toBe(b);
    expect(readFileSync(a, 'utf8')).toContain(JSON.stringify(config));
    expect(readFileSync(b, 'utf8')).toContain(JSON.stringify(second));
    // Reconciling one configuration does not touch the other's live file...
    expect(reconcileCodexRules(config, new Map([[a, ['A']]]), true)).toEqual([]);
    expect(existsSync(b)).toBe(true);
    // ...until that configuration itself is gone, when its file is obsolete.
    rmSync(second);
    expect(reconcileCodexRules(config, new Map([[a, ['A']]]), true)).toMatchObject([
      { path: b, action: 'removed', detail: `configuration ${second} no longer exists` }]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
  });

  it('does not delete a file that stopped being Fleet\'s, and survives a damaged registry', () => {
    writeFileSync(config, '');
    const path = acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').path;
    writeFileSync(path, 'prefix_rule(pattern=["mine"], decision="allow")\n');
    expect(reconcileCodexRules(config, new Map(), true)).toMatchObject([{ action: 'conflict' }]);
    expect(readFileSync(path, 'utf8')).toBe('prefix_rule(pattern=["mine"], decision="allow")\n');
    rmSync(path);
    acquireCodexRules(workspace, paths(), ['task-workflow'], 'A');
    writeFileSync(join(root, '.ours-fleet', 'managed-cli', 'registry.json'), '{not json');
    // Forgetting is safe; deleting on a guess would not be.
    expect(reconcileCodexRules(config, new Map(), true)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(acquireCodexRules(workspace, paths(), ['task-workflow'], 'A').action).toBe('unchanged');
  });

  it('survives concurrent writers', async () => {
    writeFileSync(config, '');
    const script = `import('${join(process.cwd(), 'dist/managed-cli.js')}').then(m => m.acquireCodexRules(${JSON.stringify(workspace)}, ${JSON.stringify(paths())}, ['task-workflow'], process.argv[1]));`;
    const { spawn } = await import('node:child_process');
    const codes = await Promise.all(Array.from({ length: 8 }, (_unused, index) => new Promise<number | null>(done =>
      spawn(process.execPath, ['-e', script, `H${index}`], { env: { ...process.env, OURS_FLEET_HOME: root }, stdio: 'ignore' }).once('close', done))));
    expect(codes).toEqual(Array(8).fill(0));
    expect(readFileSync(codexRulesPath(workspace, config), 'utf8')).toBe(renderCodexRules(paths(), ['task-workflow']));
    const registry = JSON.parse(readFileSync(join(root, '.ours-fleet', 'managed-cli', 'registry.json'), 'utf8'));
    expect(registry.files[codexRulesPath(workspace, config)].holders).toEqual(Array.from({ length: 8 }, (_unused, index) => `H${index}`));
    expect(readdirSync(rulesDir()).filter(name => name.includes('.tmp'))).toEqual([]);
  });

  it('reads Codex project trust without changing it', () => {
    const env = { CODEX_HOME: join(root, 'codex') };
    expect(codexWorkspaceTrust(workspace, env).state).toBe('unknown');
    mkdirSync(env.CODEX_HOME);
    const toml = join(env.CODEX_HOME, 'config.toml');
    writeFileSync(toml, `model = "x"\n[projects."/elsewhere"]\ntrust_level = "trusted"\n`);
    expect(codexWorkspaceTrust(workspace, env).state).toBe('untrusted');
    writeFileSync(toml, `[projects.${JSON.stringify(workspace)}]\ntrust_level = "untrusted"\n[projects."/elsewhere"]\ntrust_level = "trusted"\n`);
    expect(codexWorkspaceTrust(workspace, env).state).toBe('untrusted');
    const trusted = `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`;
    writeFileSync(toml, trusted);
    expect(codexWorkspaceTrust(workspace, env)).toEqual({ state: 'trusted', source: toml });
    expect(readFileSync(toml, 'utf8')).toBe(trusted);
  });
});

describe('launch preparation', () => {
  const launch = (target: ResolvedRole, prep = { env: {} as Record<string, string> }, temp = false) => {
    const stateDir = agentDir(target.name, temp); mkdirSync(stateDir, { recursive: true });
    const log: string[] = [];
    const result = prepareManagedCliLaunch(target, {
      stateDir, runCwd: workspace, configPath: config, temp, prep, log: line => log.push(line),
      deps: { paths: { ...PATHS, configuration: config }, platform: 'linux' }, now: () => new Date('2026-10-04T10:00:00Z'),
    });
    return { result, log, stateDir };
  };

  it('writes Codex rules for native and ACP launches alike, and records what it loaded', () => {
    writeFileSync(config, '');
    for (const session of ['codex-app-server', 'acp'] as const) {
      const { result, log, stateDir } = launch(role({ name: `C-${session}`, session }));
      expect(result).toEqual({ env: {} });
      expect(log.join('\n')).toMatch(/managed CLI: Codex rules (created|unchanged) at /u);
      expect(readManagedCliRecord(stateDir)).toMatchObject({
        state: 'supported', mechanism: 'codex-workspace-rules', artifact: codexRulesPath(workspace, config),
        preparedAt: '2026-10-04T10:00:00.000Z', workflows: ['task-workflow'] });
    }
    expect(readFileSync(codexRulesPath(workspace, config), 'utf8')).toBe(renderCodexRules({ ...PATHS, configuration: config }, ['task-workflow']));
  });

  it('adds Claude entries to the role\'s own overlay and the session receives them intact', async () => {
    writeFileSync(config, '');
    const target = role({ harness: 'claude-code', session: 'acp', harness_options: { plugins: { 'x@y': true } } });
    const stateDir = agentDir(target.name); mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const userSettings = join(root, '.claude', 'settings.json');
    const user = JSON.stringify({ sandbox: { enabled: true }, permissions: { deny: ['Bash(curl *)'] } });
    writeFileSync(userSettings, user);
    // The real adapter writes the plugin overlay; Fleet then merges into that same file.
    const prep = await claudeCodeAdapter.prepareSession(target, { stateDir, runCwd: workspace });
    const { result } = launch(target, prep);
    expect(result.settingsOverlay).toBe(join(stateDir, '.settings-overlay.json'));
    const overlay = JSON.parse(readFileSync(result.settingsOverlay!, 'utf8'));
    const fragment = claudeManagedCliSettings({ ...PATHS, configuration: config }, ['task-workflow'])!;
    expect(overlay).toEqual({ enabledPlugins: { 'x@y': true }, permissions: { allow: fragment.permissions.allow }, sandbox: { excludedCommands: fragment.sandbox.excludedCommands } });
    expect(overlay.sandbox.enabled).toBeUndefined();
    // What the bundled ACP adapter is actually handed.
    let started: { sessionMeta?: Record<string, unknown> } | undefined;
    const adapter = makeClaudeCodeAdapter(undefined, async options => { started = options; return {} as never; });
    await adapter.agentSession.start({
      role: target, prep: result, launch: adapter.agentSession.prepareLaunch(target, result), cwd: workspace,
      stateDir, mode: 'fresh', permissions: target.permissions, log: () => {},
      managedOurs: { server: { name: 'ours', command: 'x', args: [], env: [] }, native: {} },
    } as never);
    const meta = started!.sessionMeta as { claudeCode: { options: { settings: typeof overlay } } };
    expect(meta.claudeCode.options.settings.permissions.allow).toEqual(fragment.permissions.allow);
    expect(meta.claudeCode.options.settings.sandbox).toEqual({ excludedCommands: fragment.sandbox.excludedCommands });
    expect(meta.claudeCode.options.settings.enabledPlugins).toMatchObject({ 'x@y': true, 'ours@ours.network': false });
    expect(readFileSync(userSettings, 'utf8')).toBe(user);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);
    expect(existsSync(join(workspace, '.codex'))).toBe(false);
  });

  it('creates an overlay for a Claude role that had none, and drops the entries when undeclared', () => {
    writeFileSync(config, '');
    const target = role({ harness: 'claude-code', session: 'acp' });
    const { result, stateDir } = launch(target);
    expect(JSON.parse(readFileSync(result.settingsOverlay!, 'utf8')).permissions.allow.length).toBe(FORMS.length * 2);
    const again = launch({ ...target, managed_cli: undefined }, { env: {}, settingsOverlay: result.settingsOverlay } as never);
    expect(JSON.parse(readFileSync(again.result.settingsOverlay!, 'utf8'))).toEqual({});
    expect(existsSync(join(stateDir, MANAGED_CLI_RECORD))).toBe(false);
    expect(launch({ ...target, managed_cli: undefined }).result).toEqual({ env: {} });
  });

  it('keeps preparedAt while the policy is the same and renews it when it changes', () => {
    writeFileSync(config, '');
    const target = role();
    const stateDir = agentDir(target.name); mkdirSync(stateDir, { recursive: true });
    const at = (iso: string, paths: ManagedCliPaths) => {
      prepareManagedCliLaunch(target, { stateDir, runCwd: workspace, configPath: config, prep: { env: {} }, log: () => {},
        deps: { paths, platform: 'linux' }, now: () => new Date(iso) });
      return readManagedCliRecord(stateDir)!.preparedAt;
    };
    const same = { ...PATHS, configuration: config };
    expect(at('2026-01-01T00:00:00Z', same)).toBe('2026-01-01T00:00:00.000Z');
    expect(at('2026-02-02T00:00:00Z', same)).toBe('2026-01-01T00:00:00.000Z');
    expect(at('2026-03-03T00:00:00Z', { ...same, cli: '/new/cli.js' })).toBe('2026-03-03T00:00:00.000Z');
  });

  it('launches an unsupported or conflicting role unchanged and says why', () => {
    writeFileSync(config, '');
    const unsupported = launch(role({ name: 'H', harness: 'hermes', session: 'acp' }));
    expect(unsupported.result).toEqual({ env: {} });
    expect(unsupported.log.join('\n')).toContain('managed CLI: unsupported');
    expect(readManagedCliRecord(unsupported.stateDir)!.state).toBe('unsupported');
    expect(existsSync(join(workspace, '.codex'))).toBe(false);
    mkdirSync(join(workspace, '.codex', 'rules'), { recursive: true });
    writeFileSync(codexRulesPath(workspace, config), 'prefix_rule(pattern=["x"], decision="allow")\n');
    const conflict = launch(role({ name: 'K' }));
    expect(conflict.log.join('\n')).toContain('managed CLI: conflict');
    expect(readManagedCliRecord(conflict.stateDir)!.state).toBe('conflict');
    // A failure inside preparation never stops the launch.
    const broken = prepareManagedCliLaunch(role(), { stateDir: join(root, 'missing', '\0bad'), runCwd: workspace,
      configPath: config, prep: { env: { A: '1' } }, log: () => {}, deps: { paths: { ...PATHS, configuration: config }, platform: 'linux' } });
    expect(broken).toEqual({ env: { A: '1' } });
  });

  it('holds the rules file for a temporary agent under its own holder', () => {
    writeFileSync(config, '');
    launch(role({ name: 'Member' }), { env: {} }, true);
    const registry = JSON.parse(readFileSync(join(root, '.ours-fleet', 'managed-cli', 'registry.json'), 'utf8'));
    expect(registry.files[codexRulesPath(workspace, config)].holders).toEqual(['temp:Member']);
  });
});

describe('configuration, setup report and diagnostics', () => {
  const deps = () => ({ paths: { node: PATHS.node, cli: PATHS.cli }, platform: 'linux' as const, env: { CODEX_HOME: join(root, 'codex') } });
  const ledger = (stateDir: string, rows: { argv: string[]; at: string; class?: string }[]) => writeFileSync(
    join(stateDir, '.fleet-command-audit.json'), JSON.stringify({ version: 1, attempts: rows.map(row => ({
      argv: ['--managed-configuration', '[REDACTED:value]', ...row.argv], invokedAt: row.at,
      outcome: { completedAt: row.at, class: row.class ?? 'success' } })) }));

  it('accepts managed_cli only as an explicit list of known workflows', () => {
    fleet({ A: agent('codex', 'codex-app-server', 'managed_cli: [task-workflow]\n'), B: agent('codex', 'acp') });
    const cfg = loadConfig(config);
    expect(cfg.roles.find(item => item.name === 'A')!.managed_cli).toEqual(['task-workflow']);
    expect(cfg.roles.find(item => item.name === 'B')!.managed_cli).toBeUndefined();
    expect(resolvedPlan(cfg, { files: [] } as never).roles.map((item: { managedCli: string[] }) => item.managedCli)).toEqual([['task-workflow'], []]);
    for (const bad of ['task-workflow', '[everything]', '[task-workflow, task-workflow]', 'true', '{ all: true }']) {
      fleet({ A: agent('codex', 'acp', `managed_cli: ${bad}\n`) });
      expect(() => loadConfig(config), bad).toThrow(/managed_cli: must be a list of distinct workflow IDs; supported: task-workflow/u);
    }
  });

  it('enables one agent by adding one key and nothing else', () => {
    fleet({ A: agent('codex', 'acp'), B: agent('codex', 'acp') });
    const file = join(root, 'fleet', 'agents', 'A.yaml');
    const before = readFileSync(file, 'utf8');
    const other = readFileSync(join(root, 'fleet', 'agents', 'B.yaml'), 'utf8');
    expect(enableManagedCli(config, 'A', 'task-workflow')).toEqual({ file, changed: true });
    const after = readFileSync(file, 'utf8');
    expect(after).toBe(`${before}managed_cli: [task-workflow]\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(enableManagedCli(config, 'A', 'task-workflow')).toEqual({ file, changed: false });
    expect(readFileSync(file, 'utf8')).toBe(after);
    expect(readFileSync(join(root, 'fleet', 'agents', 'B.yaml'), 'utf8')).toBe(other);
    const cfg = loadConfig(config);
    expect(cfg.roles.find(item => item.name === 'A')).toMatchObject({ managed_cli: ['task-workflow'],
      permissions: { approval: 'auto', filesystem: 'workspace', unattended: 'deny' } });
    expect(() => enableManagedCli(config, 'Nobody', 'task-workflow')).toThrow(/agent 'Nobody' has no definition file/u);
  });

  it('leaves long, quoted and commented lines byte-identical when it must re-serialize', () => {
    const long = `cwd: "${workspace}"\nenv: { NOTE: "${'x'.repeat(140)}" } # keep me\nmanaged_cli: []\n`;
    fleet({ A: agent('codex', 'acp').replace(`cwd: ${workspace}\n`, long) });
    const file = join(root, 'fleet', 'agents', 'A.yaml');
    const before = readFileSync(file, 'utf8');
    enableManagedCli(config, 'A', 'task-workflow');
    expect(readFileSync(file, 'utf8')).toBe(before.replace('managed_cli: []', 'managed_cli: [task-workflow]'));
    expect(loadConfig(config).roles[0]!.managed_cli).toEqual(['task-workflow']);
  });

  it('enables a template instance through its overrides', () => {
    fleet({});
    mkdirSync(join(root, 'fleet', 'agent_templates'), { mode: 0o700 });
    writeFileSync(join(root, 'fleet', 'agent_templates', 'T.yaml'), agent('codex', 'acp'), { mode: 0o600 });
    writeFileSync(join(root, 'fleet', 'agents', 'A.yaml'), 'template: T\n', { mode: 0o600 });
    enableManagedCli(config, 'A', 'task-workflow');
    expect(readFileSync(join(root, 'fleet', 'agents', 'A.yaml'), 'utf8')).toBe('template: T\noverrides:\n  managed_cli: [task-workflow]\n');
    expect(loadConfig(config).roles[0]!.managed_cli).toEqual(['task-workflow']);
    // An existing block-style overrides map gains one line at its own indentation.
    const existing = `template: T\noverrides:\n    # why\n    cwd: "${workspace}"   # keep\n    env: { A: "1" }\n`;
    writeFileSync(join(root, 'fleet', 'agents', 'A.yaml'), existing, { mode: 0o600 });
    enableManagedCli(config, 'A', 'task-workflow');
    expect(readFileSync(join(root, 'fleet', 'agents', 'A.yaml'), 'utf8')).toBe(
      `template: T\noverrides:\n    # why\n    managed_cli: [task-workflow]\n    cwd: "${workspace}"   # keep\n    env: { A: "1" }\n`);
    expect(loadConfig(config).roles[0]).toMatchObject({ managed_cli: ['task-workflow'], cwd: workspace });
    // A flow-style overrides map has no line to add; the result is still correct YAML.
    writeFileSync(join(root, 'fleet', 'agents', 'A.yaml'), `template: T\noverrides: { env: { A: "1" } }\n`, { mode: 0o600 });
    enableManagedCli(config, 'A', 'task-workflow');
    expect(loadConfig(config).roles[0]).toMatchObject({ managed_cli: ['task-workflow'], env: { A: '1' } });
  });

  it('separates generated setup, the running session and observed supervisor access', () => {
    fleet({
      Codex: agent('codex', 'codex-app-server', 'managed_cli: [task-workflow]\n'),
      Claude: agent('claude-code', 'acp', 'managed_cli: [task-workflow]\n'),
      Plain: agent('codex', 'acp'),
      Hermes: agent('hermes', 'acp', 'managed_cli: [task-workflow]\n').replace('session: acp', 'session: acp, model: some/model'),
    });
    const cfg = loadConfig(config);
    const by = (report: ReturnType<typeof managedCliReport>, name: string) => report.roles.find(item => item.role === name)!;

    // status: nothing written, nothing claimed.
    const status = managedCliReport(cfg, config, { ...deps(), write: false });
    expect(status.wrote).toBe(false);
    expect(existsSync(join(workspace, '.codex'))).toBe(false);
    expect(by(status, 'Codex')).toMatchObject({ setup: { state: 'missing' }, session_policy: 'never-launched' });
    expect(by(status, 'Codex').observed.summary).toContain('not observed');
    expect(by(status, 'Plain')).toMatchObject({ setup: { state: 'not-declared' }, session_policy: 'not-applicable' });
    expect(by(status, 'Hermes').setup).toMatchObject({ state: 'unsupported' });
    expect(by(status, 'Hermes').setup.detail).toContain("harness 'hermes' has no qualified native execution policy");
    expect(by(status, 'Claude').setup).toMatchObject({ state: 'generated-at-launch', mechanism: 'claude-session-settings' });
    expect(by(status, 'Claude').warnings.join('\n')).toContain('Fleet\'s sandbox exclusions are inert');
    expect(by(status, 'Claude').warnings.join('\n')).toContain('no sandbox qualification is claimed');
    expect(by(status, 'Codex').warnings.join('\n')).toContain('Fleet does not change trust');
    // The matrix ran on Linux only: macOS says so itself instead of borrowing that result.
    expect(status.disclosure.join('\n')).not.toContain('macOS');
    expect(managedCliReport(cfg, config, { ...deps(), write: false, platform: 'darwin' }).disclosure.join('\n'))
      .toContain('has not been run on macOS');

    // setup: generated, idempotent, still no session and no observation.
    const setup = managedCliReport(cfg, config, { ...deps(), write: true });
    expect(by(setup, 'Codex').setup).toMatchObject({ state: 'prepared', action: 'created', artifact: codexRulesPath(workspace, config) });
    expect(by(setup, 'Codex').session_policy).toBe('never-launched');
    expect(by(setup, 'Codex').observed.current).toEqual([]);
    const again = managedCliReport(cfg, config, { ...deps(), write: true });
    expect(by(again, 'Codex').setup.action).toBe('unchanged');
    expect(again.removed).toEqual([]);

    // A launch loads the policy; a help call afterwards is reported as help, not as lifecycle proof.
    const codexRole = cfg.roles.find(item => item.name === 'Codex')!;
    const stateDir = agentDir('Codex'); mkdirSync(stateDir, { recursive: true });
    prepareManagedCliLaunch(codexRole, { stateDir, runCwd: workspace, configPath: config, prep: { env: {} }, log: () => {},
      deps: deps(), now: () => new Date('2026-10-04T10:00:00Z') });
    ledger(stateDir, [
      { argv: ['task', 'create', '--title', 'old'], at: '2026-10-03T09:00:00Z' },
      { argv: ['--help'], at: '2026-10-04T10:05:00Z' },
      { argv: ['task', 'list'], at: '2026-10-04T10:06:00Z', class: 'validation' },
    ]);
    const helped = by(managedCliReport(cfg, config, { ...deps(), write: false }), 'Codex');
    expect(helped.session_policy).toBe('current');
    expect(helped.observed.historical).toBe(1);
    expect(helped.observed.summary).toContain('supervisor reached by --help only');
    expect(helped.observed.summary).toContain('not the task lifecycle');
    expect(helped.observed.summary).toContain('Audited but not completed successfully: task list (validation).');
    expect(helped.observed.summary).toContain('1 earlier pinned invocation(s) predate the current policy and verify nothing about it');
    ledger(stateDir, [{ argv: ['task', 'create', '--title', 'x'], at: '2026-10-04T10:07:00Z' }, { argv: ['--help'], at: '2026-10-04T10:08:00Z' },
      { argv: ['task', 'create', '--title', 'y', '--configuration', '/other'], at: '2026-10-04T10:09:00Z', class: 'validation' }]);
    const lifecycle = by(managedCliReport(cfg, config, { ...deps(), write: false }), 'Codex');
    expect(lifecycle.observed.summary).toBe('supervisor reached by --help, task create; lifecycle commands not listed remain unobserved.');
    expect(lifecycle.observed.current.map(item => item.form)).toEqual(['--help', 'task create']);

    // The package moved: setup is stale, the running session holds the old policy, and old rows prove nothing.
    const moved = { ...deps(), paths: { node: PATHS.node, cli: '/new/fleet/dist/cli.js' } };
    const stale = by(managedCliReport(cfg, config, { ...moved, write: false }), 'Codex');
    expect(stale).toMatchObject({ setup: { state: 'stale' }, session_policy: 'restart-required' });
    expect(stale.observed.current).toEqual([]);
    expect(stale.observed.historical).toBe(3);
    const updated = by(managedCliReport(cfg, config, { ...moved, write: true }), 'Codex');
    expect(updated).toMatchObject({ setup: { state: 'prepared', action: 'updated' }, session_policy: 'restart-required' });
    expect(updated.commandPrefix).toBe(`/opt/node/bin/node /new/fleet/dist/cli.js --managed-configuration ${config}`);
  });

  it('removes its rules when the last declaring agent stops declaring, and only then', () => {
    fleet({ A: agent('codex', 'acp', 'managed_cli: [task-workflow]\n'), B: agent('codex', 'acp', 'managed_cli: [task-workflow]\n') });
    managedCliReport(loadConfig(config), config, { ...deps(), write: true });
    const path = codexRulesPath(workspace, config);
    mkdirSync(join(workspace, '.codex', 'rules'), { recursive: true });
    writeFileSync(join(workspace, '.codex', 'rules', 'mine.rules'), '# mine\n');
    fleet({ A: agent('codex', 'acp'), B: agent('codex', 'acp', 'managed_cli: [task-workflow]\n') });
    expect(managedCliReport(loadConfig(config), config, { ...deps(), write: true }).removed).toEqual([]);
    expect(existsSync(path)).toBe(true);
    fleet({ A: agent('codex', 'acp'), B: agent('codex', 'acp') });
    expect(managedCliReport(loadConfig(config), config, { ...deps(), write: false }).removed).toMatchObject([{ path, action: 'removed' }]);
    expect(existsSync(path)).toBe(true);
    expect(managedCliReport(loadConfig(config), config, { ...deps(), write: true }).removed).toMatchObject([{ path, action: 'removed' }]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(workspace, '.codex', 'rules'))).toEqual(['mine.rules']);
  });

  it('reports what the operator\'s Claude settings do around the overlay', () => {
    const env = { CLAUDE_CONFIG_DIR: join(root, 'claude') };
    expect(inspectClaudeSettings(workspace, env, 'linux')).toMatchObject({ sandbox: 'unknown', bashDeny: [] });
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ sandbox: { enabled: true }, permissions: { deny: ['Bash(node *)', 'Read(/etc/*)', 'Bash'] } }));
    expect(inspectClaudeSettings(workspace, env, 'linux')).toMatchObject({ sandbox: 'enabled', bashDeny: ['Bash(node *)', 'Bash'] });
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { enabled: false } }));
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{broken');
    const inspected = inspectClaudeSettings(workspace, env, 'linux');
    expect(inspected.sandbox).toBe('disabled');
    expect(inspected.unreadable).toEqual([join(workspace, '.claude', 'settings.json')]);

    fleet({ Claude: agent('claude-code', 'acp', 'managed_cli: [task-workflow]\n') });
    rmSync(join(workspace, '.claude'), { recursive: true });
    const warnings = managedCliReport(loadConfig(config), config, { ...deps(), env, write: false }).roles[0]!.warnings.join('\n');
    expect(warnings).toContain("Claude's OS sandbox is enabled in your settings");
    expect(warnings).toContain("your Claude settings deny Bash(node *), Bash; deny rules win over Fleet's allow entries and are left in place");
  });

  it('never reads an old ledger row as verification of the current policy', () => {
    const stateDir = agentDir('X'); mkdirSync(stateDir, { recursive: true });
    expect(observeManagedCli(stateDir, undefined).summary).toContain('no supervisor audit ledger yet');
    ledger(stateDir, [{ argv: ['task', 'start', 'T'], at: '2026-10-01T00:00:00Z' }]);
    expect(observeManagedCli(stateDir, undefined)).toMatchObject({ current: [], historical: 1 });
    const record = { preparedAt: '2026-10-02T00:00:00Z' } as never;
    expect(observeManagedCli(stateDir, record).summary).toMatch(/^not observed: no pinned invocation has completed/u);
    // Unpinned rows are ordinary commands, not evidence about this policy at all.
    writeFileSync(join(stateDir, '.fleet-command-audit.json'), JSON.stringify({ version: 1, attempts: [
      { argv: ['task', 'list'], outcome: { completedAt: '2026-10-03T00:00:00Z', class: 'success' } }] }));
    expect(observeManagedCli(stateDir, record)).toMatchObject({ current: [], historical: 0 });
  });

  it('doctor prints the three facts as three rows', async () => {
    fleet({ Codex: agent('codex', 'codex-app-server', 'managed_cli: [task-workflow]\n'), Plain: agent('codex', 'acp') });
    const exec = async () => ({ stdout: '', stderr: '', code: 1 });
    const rows = (await doctor({ configPath: config }, exec, 'linux', async () => { throw new Error('offline'); },
      async () => { throw new Error('offline'); })).checks.filter(check => check.name.startsWith('managed CLI'));
    expect(rows.map(row => row.name)).toEqual(['managed CLI setup: Codex', 'managed CLI session: Codex', 'managed CLI observed: Codex']);
    expect(rows[0]).toMatchObject({ ok: false });
    expect(rows[0]!.detail).toContain('static: missing — rules file not generated yet; run: ours-fleet managed-cli setup');
    expect(rows[1]!.detail).toBe('not launched since setup; the policy loads at its next start');
    expect(rows[2]!.detail).toContain('not observed');
    managedCliReport(loadConfig(config), config, { write: true });
    const after = (await doctor({ configPath: config }, exec, 'linux', async () => { throw new Error('offline'); },
      async () => { throw new Error('offline'); })).checks.filter(check => check.name.startsWith('managed CLI'));
    expect(after[0]).toMatchObject({ ok: true });
    expect(after[0]!.detail).toContain('static: prepared');
    expect(after[2]!.detail).toContain('not observed');
  });

  it('declares the capability the installer gates on', () => {
    expect(CAPABILITIES).toContain('managed-cli.setup-v1');
  });
});

describe('briefing', () => {
  const brief = (target: ResolvedRole, lines: string[]) => generateBriefing(target, claudeCodeAdapter.vocabulary, {
    stateDir: '/s', worklogPath: '/s/WORKLOG.md', routinesPath: '/s/ROUTINES.md', managedCli: lines });

  it('gives a prepared role the exact prefix and its limits', () => {
    writeFileSync(config, '');
    const target = role({ session: 'acp' });
    const lines = managedCliBriefing(target, config);
    const text = brief(target, lines);
    expect(text).toContain('### Fleet commands outside the command sandbox');
    expect(text).toMatch(/```sh\n\S+ \S+ --managed-configuration \S+ <command> \[options\]\n```/u);
    expect(text).toContain('`task create`, `task start`, `task finish`, `task block`, `task unblock`, `task review`');
    expect(text).toContain('Do not add `-c`/`--configuration`');
    expect(text).toContain('is not prepared here and will be refused by the sandbox');
    expect(text).not.toContain('No Fleet command is prepared to run outside your sandbox');
  });

  it('tells a sandboxed role without the workflow the truth instead of promising every command', () => {
    const target = role({ session: 'acp', managed_cli: undefined });
    const text = brief(target, managedCliBriefing(target, config));
    expect(text).not.toContain('All public CLI surfaces are available');
    expect(text).toContain('a\nharness command sandbox can refuse that connection (`connect EPERM`)');
    expect(text).toContain('No Fleet command is prepared to run outside your sandbox');
    const unrestricted = role({ session: 'acp', managed_cli: undefined, permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'deny' } });
    expect(brief(unrestricted, [])).not.toContain('connect EPERM');
  });

  it('names the reason when the declared workflow could not be prepared', () => {
    const target = role({ harness: 'hermes', session: 'acp' });
    const text = managedCliBriefing(target, config).join('\n');
    expect(text).toContain('Fleet could not prepare it for this launch');
    expect(text).toContain("harness 'hermes' has no qualified native execution policy");
    expect(text).toContain('Report that as a blocker');
  });
});
