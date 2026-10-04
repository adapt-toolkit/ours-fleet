// Disposable qualification of Fleet's own managed CLI setup for the Coordinator
// task workflow: real Codex or Claude Code, the policy `ours-fleet managed-cli
// setup` and Fleet's launch preparation generate, a real supervisor control
// socket and audit ledger. A scripted local provider asks for each command; no
// external model, account, production room or identity is used.
//
//   FLEET_TEST_HARNESS=codex  FLEET_CODEX_BIN=/abs/codex   FLEET_TEST_SESSION=codex-app-server|acp
//   FLEET_TEST_HARNESS=claude FLEET_CLAUDE_BIN=/abs/claude (bundled ACP)
//   FLEET_TEST_QUOTED=1            Fleet CLI and configuration at paths containing spaces
//   FLEET_TEST_CLAUDE_SANDBOX=0    Claude with its OS sandbox left off (permission entries only)
//   FLEET_TEST_NESTED_SANDBOX=1    Claude inside an unprivileged container (see the validation doc)
//   FLEET_TEST_TMP_PREFIX=/abs/private-parent/prefix-   (outside /tmp and outside any workspace)
//   FLEET_TEST_KEEP_ARTIFACTS=1    keep the disposable root for inspection
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runClaudeTurn, runCodexTurn } from './managed-cli-harness-fixture.mjs';

const harness = process.env.FLEET_TEST_HARNESS;
const binary = harness === 'codex' ? process.env.FLEET_CODEX_BIN : process.env.FLEET_CLAUDE_BIN;
assert(['codex', 'claude'].includes(harness) && binary, 'Set FLEET_TEST_HARNESS=codex|claude and FLEET_CODEX_BIN or FLEET_CLAUDE_BIN');
const session = harness === 'claude' ? 'acp' : process.env.FLEET_TEST_SESSION ?? 'codex-app-server';
const quoted = process.env.FLEET_TEST_QUOTED === '1';
const claudeSandbox = process.env.FLEET_TEST_CLAUDE_SANDBOX !== '0';
const sandboxed = harness === 'codex' || claudeSandbox;
const label = `${process.platform} ${harness}/${session}${quoted ? ' quoted-paths' : ''}${harness === 'claude' && !claudeSandbox ? ' claude-sandbox-off' : ''}`;

const repoCli = resolve('dist/cli.js');
const root = realpathSync(mkdtempSync(process.env.FLEET_TEST_TMP_PREFIX ?? '/tmp/fleet-managed-cli-'));
// Everything Fleet reads or writes is under the disposable root from here on.
for (const key of Object.keys(process.env)) if (/^(OURS_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_)/u.test(key)) delete process.env[key];
process.env.OURS_FLEET_HOME = root;
process.env.HOME = root;
process.env.OURS_FLEET_SUPERVISOR = 'none';
process.env.CODEX_HOME = join(root, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-home');
// Unix socket paths are short; the disposable root usually is not.
const socketRoot = realpathSync(mkdtempSync(join(tmpdir(), 'fmc-')));
chmodSync(socketRoot, 0o700);
process.env.OURS_FLEET_SOCKET_ROOT = socketRoot;

const { loadConfig, findRole } = await import('../dist/config.js');
const { FleetCommandAuditStore } = await import('../dist/fleet-command-audit.js');
const { RoleControlServer } = await import('../dist/session/control.js');
const { agentDir } = await import('../dist/paths.js');
const managedCli = await import('../dist/managed-cli.js');

const project = join(root, 'project'); mkdirSync(project);
// The installation as the operator has it. With FLEET_TEST_QUOTED the Fleet
// package and its configuration really live at paths that need shell quoting (a
// copy, not a symlink: Fleet pins the resolved path, so a symlink would prove
// nothing). Node stays at its own path: no harness matches a quoted executable.
const installDir = join(root, 'Application Support', 'fleet pkg');
if (quoted) {
  mkdirSync(installDir, { recursive: true });
  cpSync(dirname(repoCli), join(installDir, 'dist'), { recursive: true });
  copyFileSync(resolve('package.json'), join(installDir, 'package.json'));
  symlinkSync(resolve('node_modules'), join(installDir, 'node_modules'));
}
const paths = { node: process.execPath, cli: quoted ? join(installDir, 'dist', 'cli.js') : repoCli };
const configDir = join(root, quoted ? 'fleet config' : 'config'); mkdirSync(configDir, { mode: 0o700 });
const config = join(configDir, 'fleet.yaml');
const otherConfig = join(configDir, 'other.yaml');
for (const file of [config, otherConfig]) {
  writeFileSync(file, 'api_version: ours.network/fleet/v2\n', { mode: 0o600 });
  mkdirSync(join(file.replace(/\.yaml$/u, ''), 'agents'), { recursive: true, mode: 0o700 });
}
// A room template to inspect: `template show` and `template validate` read these.
for (const dir of ['agent_templates', 'room_templates']) mkdirSync(join(configDir, 'fleet', dir), { recursive: true, mode: 0o700 });
writeFileSync(join(configDir, 'fleet', 'agent_templates', 'Developer.yaml'), [
  'role: { inline: { mission: Implement the task. } }', 'brain: { inline: { harness: codex, session: codex-app-server, model: gpt-5.6-sol } }',
  'permissions: { approval: allow, filesystem: workspace, unattended: deny }', ''].join('\n'), { mode: 0o600 });
writeFileSync(join(configDir, 'fleet', 'room_templates', 'single.yaml'), [
  'version: 1', 'description: "Solo task: one Developer"', 'room: { quiet_membership: false, anonymous: false }',
  'contract: |', '  Developer owns task execution.', 'members:',
  '  - { slot: developer, role: Developer, count: 1, agent_template: Developer }', ''].join('\n'), { mode: 0o600 });
const bin = join(root, 'bin'); mkdirSync(bin);
if (harness === 'codex') symlinkSync(binary, join(bin, 'codex'));
const agentFile = join(configDir, 'fleet', 'agents', 'Coordinator.yaml');
writeFileSync(agentFile, [
  '# Operator-authored agent; setup adds exactly one key below.',
  'role: { inline: { mission: Coordinate tasks. } }',
  `brain: { inline: { harness: ${harness === 'codex' ? 'codex' : 'claude-code'}, session: ${session}, model: ${harness === 'codex' ? 'gpt-5.6-sol' : 'claude-sonnet-4-6'} } }`,
  'permissions: { approval: auto, filesystem: workspace, unattended: deny }',
  `cwd: ${JSON.stringify(project)}`,
  ...(harness === 'codex' && session === 'acp' ? [`env: { CODEX_PATH: ${JSON.stringify(binary)} }`] : []),
  '',
].join('\n'), { mode: 0o600 });

const baseEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: root, OURS_FLEET_HOME: root, OURS_FLEET_SUPERVISOR: 'none',
  CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, OURS_FLEET_SOCKET_ROOT: socketRoot };

/** The operator (or the installer) running the installed Fleet CLI. No session, no model. */
function operator(args) {
  return new Promise((done, fail) => {
    const child = spawn(paths.node, [paths.cli, ...args], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail); child.once('close', code => done({ code, stdout, stderr }));
  });
}
const report = async (command, extra = []) => {
  const result = await operator(['managed-cli', command, '--configuration', config, '--json', ...extra]);
  assert(result.stdout, result.stderr);
  return { ...JSON.parse(result.stdout), exit: result.code };
};
const coordinator = value => value.roles.find(item => item.role === 'Coordinator');

const watchdog = setTimeout(() => process.exit(124), 1_500_000);
let control;
const evidence = [];
try {
  // --- Setup exactly as the installer invokes it --------------------------------
  const before = readFileSync(agentFile, 'utf8');
  const undeclared = await report('setup');
  assert.equal(coordinator(undeclared).setup.state, 'not-declared');
  assert.equal(existsSync(join(project, '.codex')), false);
  const enabled = await report('setup', ['--enable', 'Coordinator']);
  assert.deepEqual(enabled.enabled.map(item => item.changed), [true]);
  assert.equal(readFileSync(agentFile, 'utf8'), `${before}managed_cli: [task-workflow]\n`);
  const prepared = coordinator(enabled);
  assert.equal(prepared.setup.state, harness === 'codex' ? 'prepared' : 'generated-at-launch', JSON.stringify(prepared));
  assert.equal(prepared.session_policy, 'never-launched');
  assert.match(prepared.observed.summary, /^not observed/u);
  const prefix = prepared.commandPrefix;
  assert(prefix, 'setup did not report an invocation prefix');
  if (quoted) assert.match(prefix, /^\S+ '[^']* [^']*' --managed-configuration '[^']* [^']*'$/u);
  assert.equal(prefix, managedCli.managedCliCommandPrefix({ ...paths, configuration: config }));
  const again = await report('setup');
  if (harness === 'codex') assert.equal(coordinator(again).setup.action, 'unchanged');
  console.log(`PASS ${label}: setup enabled one agent, generated policy idempotently, started no session`);

  // --- A supervisor for the role, with the real audit ledger --------------------
  const role = findRole(loadConfig(config), 'Coordinator');
  const stateDir = agentDir('Coordinator'); mkdirSync(stateDir, { recursive: true });
  const audit = new FleetCommandAuditStore(join(stateDir, '.fleet-command-audit.json'));
  control = new RoleControlServer(stateDir, {}, () => {});
  control.setFleetAuditor({
    async begin(requestId, argv) { const row = audit.begin(requestId, 'Coordinator', argv); return audit.invocation(row.correlationId, 'Coordinator', 'delivered'); },
    async finish({ correlationId, ...outcome }) { audit.finish(correlationId, 'Coordinator', outcome); return audit.outcome(correlationId, 'Coordinator', 'delivered'); },
    async present() {},
  });
  await control.start();

  const userSettings = claudeSandbox ? { sandbox: {
    ...(process.env.FLEET_TEST_NESTED_SANDBOX === '1' ? { enableWeakerNestedSandbox: true } : {}),
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
  } } : {};
  const turn = harness === 'codex' ? runCodexTurn : runClaudeTurn;
  async function run(command, note) {
    const result = await turn({ [harness]: binary, root, role, stateDir, cwd: project, configPath: config,
      deps: { paths }, env: baseEnv, command, userSettings });
    evidence.push({ note, command, exitCode: result.exitCode, output: result.output.slice(0, 600) });
    return result;
  }
  const plain = [paths.node, paths.cli].map(token => managedCli.shellSpelling(token)).join(' ');
  // Probes the agent could write itself; each tries to leave a marker outside the workspace.
  const escape = name => `try { require('node:fs').writeFileSync(${JSON.stringify(join(root, name))}, 'x'); process.exitCode = 2 } catch (e) { console.log('filesystem restriction retained ' + e.code) }`;
  writeFileSync(join(project, 'write-outside.cjs'), escape('outside-project'));
  writeFileSync(join(project, 'chained.cjs'), escape('chained-escaped'));
  const firstJson = text => {
    const start = text.indexOf('{');
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1))
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* trailing harness text */ }
    throw new Error(`no JSON object in: ${text}`);
  };
  const denied = /connect (EPERM|EACCES)/u;
  const ledger = () => audit.list();

  // --- The sandbox is real: without the prepared form, nothing reaches the supervisor
  if (sandboxed) {
    const blocked = await run(`${plain} --help`, 'unpinned help stays sandboxed');
    assert.notEqual(blocked.exitCode, 0, blocked.output);
    assert.match(blocked.output, denied);
    assert.equal(ledger().length, 0);
    const guard = await run(`${managedCli.shellSpelling(paths.node)} write-outside.cjs`, 'unrelated write outside the workspace stays denied');
    assert.match(guard.output, /filesystem restriction retained (EPERM|EACCES|EROFS)/u, guard.output);
    assert.equal(existsSync(join(root, 'outside-project')), false);
    console.log(`PASS ${label}: command sandbox blocks the unprepared CLI before audit and keeps the filesystem boundary`);
  } else {
    const unapproved = await run(`${plain} --help`, 'unpinned help is not pre-approved');
    assert.notEqual(unapproved.exitCode, 0, unapproved.output);
    assert.equal(ledger().length, 0);
    console.log(`PASS ${label}: without a matching permission entry the Bash call is refused (no sandbox in force)`);
  }

  // --- The declared workflow, as an agent types it ------------------------------
  const expectAudited = (count, command, outcome) => {
    const rows = ledger();
    assert.equal(rows.length, count, JSON.stringify(rows.map(row => row.argv)));
    const row = rows.at(-1);
    assert.equal(row.argv[0], '--managed-configuration');
    assert.equal(row.classification.command, command);
    assert.equal(row.invocation, 'delivered');
    assert.equal(row.outcome?.delivery, 'delivered');
    if (outcome) assert.equal(row.outcome.class, outcome, JSON.stringify(row.outcome));
  };
  let audited = 0;
  const help = await run(`${prefix} --help`, 'pinned help');
  assert.equal(help.exitCode, 0, help.output);
  assert.match(help.output, /Usage: ours-fleet/u);
  expectAudited(++audited, '--help', 'success');

  const created = await run(`${prefix} task create --title 'Review the "Q3" plan' --brief "two words; it's quoted & safe" --backlog --no-room --json`,
    'task create with quoted variable options');
  assert.equal(created.exitCode, 0, created.output);
  const task = firstJson(created.output).task;
  assert.equal(task.title, 'Review the "Q3" plan');
  expectAudited(++audited, 'task create', 'success');
  const id = task.task_id;

  for (const [args, command, check] of [
    ['task list --state all --json', 'task list', output => assert(output.includes(id), output)],
    [`task show --json -- ${id}`, 'task show', output => assert(output.includes(id), output)],
    [`task block ${id} --reason 'waiting for the owner' --json`, 'task block', output => assert(output.includes('waiting for the owner'), output)],
    [`task unblock ${id} --json`, 'task unblock', output => assert(output.includes(id), output)],
    ['template list --json', 'template list', output => assert(output.includes('"single"'), output)],
    ['template show single --json', 'template show', output => assert(output.includes('Solo task: one Developer'), output)],
    ['template validate --json', 'template validate', output => assert.equal(firstJson(output).valid, true, output)],
    // The reference is long enough that a harness truncates or spills it; the audit row is the proof.
    ['docs', 'docs', undefined],
    ['config --json', 'config', output => assert(output.includes('"Coordinator"'), output)],
  ]) {
    const result = await run(`${prefix} ${args}`, command);
    assert.equal(result.exitCode, 0, `${command}: ${result.output}`);
    check?.(result.output);
    expectAudited(++audited, command, 'success');
  }
  console.log(`PASS ${label}: pinned help, task create/list/show/block/unblock, template list/show/validate, config and docs ran outside the sandbox, each audited begin+finish`);

  // This fixture has no daemon or Cowork, so these cannot complete here: what is
  // established is that they reach the supervisor and Fleet's own validation, not
  // the socket denial. Their SUCCESSFUL run — a provisioned room, a spawned member,
  // review and finish — is test/managed-cli-lifecycle.integration.mjs.
  for (const [args, command] of [
    [`task review ${id} --json`, 'task review'],
    [`task start ${id} --template single --json`, 'task start'],
    [`task finish ${id} --summary 'closed by the fixture' --json`, 'task finish'],
    ['room show no-such-room --json', 'room show'],
    ['room members no-such-room --json', 'room members'],
  ]) {
    const result = await run(`${prefix} ${args}`, `${command} (reaches Fleet; outcome is Fleet's own)`);
    assert.doesNotMatch(result.output, denied, `${command}: ${result.output}`);
    expectAudited(++audited, command);
  }
  console.log(`PASS ${label}: task review/start/finish and room show/members reached the supervisor and Fleet validation (no socket denial); their successful run is the lifecycle fixture`);

  // --- Boundaries ---------------------------------------------------------------
  const override = await run(`${prefix} task list --json --configuration ${managedCli.shellSpelling(otherConfig)}`, 'late configuration override');
  assert.notEqual(override.exitCode, 0, override.output);
  assert.match(override.output, /pinned to configuration/u);
  expectAudited(++audited, 'task list', 'validation');
  assert.equal(ledger().at(-1).outcome.effect, 'not_started');

  for (const [command, note] of [
    [`${prefix} spawn Helper --temp`, 'spawn under the pin is not a prepared command'],
    [`${prefix} room delete r r`, 'room delete under the pin is not a prepared command'],
    [`${plain} task list --configuration ${managedCli.shellSpelling(config)}`, 'the same command without the pin'],
    [`${plain} --managed-configuration ${managedCli.shellSpelling(otherConfig)} task list`, 'a pin naming another configuration'],
  ]) {
    const result = await run(command, note);
    assert.notEqual(result.exitCode, 0, `${note}: ${result.output}`);
    if (sandboxed) assert.match(result.output, denied, `${note}: ${result.output}`);
    assert.equal(ledger().length, audited, `${note} reached the supervisor`);
  }
  // Shell forms that would smuggle code or authority next to a prepared command.
  const preload = join(project, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'preload-escaped'))}, 'bad');`);
  const smuggled = [
    [`NODE_OPTIONS=--require=${preload} ${prefix} --help`, 'environment-prefixed preload', 'preload-escaped'],
    [`${prefix} --help && ${managedCli.shellSpelling(paths.node)} chained.cjs`, 'chained command', 'chained-escaped'],
    [`${prefix} --help > ${join(root, 'redirect-escaped')}`, 'redirect outside the workspace', 'redirect-escaped'],
  ];
  for (const [command, note, marker] of smuggled) {
    const result = await run(command, note);
    if (sandboxed) {
      assert.equal(existsSync(join(root, marker)), false, `${note} escaped the sandbox: ${result.output}`);
      assert.equal(ledger().length, audited, `${note} reached the supervisor`);
    } else {
      // With no sandbox in force there is nothing to escape; the claim is only
      // that the line is not pre-approved by Fleet's entries.
      assert.notEqual(result.exitCode, 0, `${note}: ${result.output}`);
      assert.equal(existsSync(join(root, marker)), false);
    }
  }
  console.log(`PASS ${label}: late configuration refused by Fleet after audit; unprepared commands, missing/other pin, preload, chaining and redirect stay ${sandboxed ? 'sandboxed' : 'unapproved'}`);

  // --- User configuration is intact; diagnostics tell setup from observation -----
  assert.equal(readFileSync(agentFile, 'utf8'), `${before}managed_cli: [task-workflow]\n`);
  if (harness === 'codex') assert.deepEqual(readdirSync(join(project, '.codex', 'rules')), [managedCli.codexRulesPath(project, config).split('/').pop()]);
  else {
    // Claude may keep its own project state; none of it may carry Fleet's entries.
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = join(project, '.claude', name);
      if (existsSync(file)) assert.doesNotMatch(readFileSync(file, 'utf8'), /--managed-configuration/u);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')), userSettings);
    const overlay = JSON.parse(readFileSync(join(stateDir, '.settings-overlay.json'), 'utf8'));
    assert.equal(overlay.sandbox.enabled, undefined);
    assert(overlay.permissions.allow.every(rule => rule.startsWith(`Bash(${prefix} `)));
  }
  const status = coordinator(await report('status'));
  assert.equal(status.session_policy, 'current', JSON.stringify(status));
  const observed = status.observed.current.filter(item => item.class === 'success').map(item => item.form);
  for (const form of ['--help', 'task create', 'task list', 'task show', 'task block', 'task unblock', 'template list', 'template show', 'template validate', 'config', 'docs'])
    assert(observed.includes(form), `${form} not observed: ${JSON.stringify(status.observed)}`);
  assert.match(status.observed.summary, /lifecycle commands not listed remain unobserved/u);
  console.log(`PASS ${label}: status reports the launched policy as current and lists exactly the forms the audit ledger observed`);
  console.log(`QUALIFIED ${label}: node ${process.version}; ${audited} audited pinned invocations; invocation prefix: ${prefix}`);
} finally {
  clearTimeout(watchdog);
  await control?.close();
  rmSync(socketRoot, { recursive: true, force: true });
  if (process.env.FLEET_TEST_EVIDENCE) writeFileSync(process.env.FLEET_TEST_EVIDENCE, JSON.stringify({ label, evidence }, null, 2));
  if (process.env.FLEET_TEST_KEEP_ARTIFACTS === '1') console.log(`Fixture artifacts retained: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
