/**
 * The pinned managed entry form, exercised through the real built CLI and a real
 * supervisor control socket with the real audit ledger. Nothing is mocked: the
 * child process is the one a harness would run outside its command sandbox.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FleetCommandAuditStore, type FleetAuditAttempt } from '../src/fleet-command-audit.js';
import { MANAGED_CLI_WORKFLOWS, parseManagedEntry } from '../src/managed-cli.js';
import { RoleControlServer } from '../src/session/control.js';

const CLI = resolve('dist/cli.js');
const PIN = '--managed-configuration';
let root: string, state: string, config: string, other: string;
let control: RoleControlServer, audit: FleetCommandAuditStore;

function fleet(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, 'api_version: ours.network/fleet/v2\n', { mode: 0o600 });
  mkdirSync(join(dir, name.replace(/\.yaml$/u, ''), 'agents'), { recursive: true, mode: 0o700 });
  return file;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'managed-entry-'));
  state = join(root, 'role'); mkdirSync(state);
  config = fleet(root, 'fleet.yaml');
  other = fleet(root, 'other.yaml');
  audit = new FleetCommandAuditStore(join(state, 'audit.json'));
  control = new RoleControlServer(state, {}, () => {});
  control.setFleetAuditor({
    async begin(requestId, argv) {
      const row = audit.begin(requestId, 'Fixture', argv);
      return audit.invocation(row.correlationId, 'Fixture', 'delivered');
    },
    async finish({ correlationId, ...outcome }) {
      audit.finish(correlationId, 'Fixture', outcome);
      return audit.outcome(correlationId, 'Fixture', 'delivered');
    },
    async present() {},
  });
  await control.start();
});
afterAll(async () => { await control?.close(); rmSync(root, { recursive: true, force: true }); });

// The supervisor lives in this process, so the child must not block its event loop.
async function run(args: string[], managed = true) {
  const before = audit.list().length;
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      PATH: process.env.PATH, HOME: root, OURS_FLEET_HOME: root,
      OURS_FLEET_SOCKET_ROOT: process.env.OURS_FLEET_SOCKET_ROOT,
      ...(managed ? { OURS_FLEET_PROXY_CALLER: 'Fixture', OURS_FLEET_PROXY_STATE_DIR: state } : {}),
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const status = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); });
  clearTimeout(timer);
  const rows = audit.list().slice(before) as FleetAuditAttempt[];
  return { status, stdout, stderr, rows };
}

/** Every supported invocation retains begin AND finish in the supervisor ledger. */
function audited(rows: FleetAuditAttempt[], outcome?: string) {
  expect(rows).toHaveLength(1);
  expect(rows[0]!.invocation).toBe('delivered');
  expect(rows[0]!.argv[0]).toBe(PIN);
  expect(rows[0]!.argv[1]).toBe('[REDACTED:value]');
  if (outcome) expect(rows[0]!.outcome?.class).toBe(outcome);
  else expect(rows[0]!.outcome?.class).not.toBe('success');
  expect(rows[0]!.outcome?.delivery).toBe('delivered');
}

// Each case starts real Node processes; the default 5s is too tight on a loaded host.
describe('pinned managed entry form through the real CLI and supervisor audit', { timeout: 120_000 }, () => {
  it('runs the task workflow with variable options and quoted values', async () => {
    const created = await run([PIN, config, 'task', 'create', '--title', 'Two words & "quotes"',
      '--brief', "multi word brief with 'single' quotes", '--backlog', '--no-room', '--json']);
    expect(created.stderr).toBe('');
    expect(created.status).toBe(0);
    const task = JSON.parse(created.stdout).task as { task_id: string; title: string; state: string };
    expect(task.title).toBe('Two words & "quotes"');
    expect(task.state).toBe('backlog');
    audited(created.rows, 'success');
    // The audit classifies the real command, not the pin or its path.
    expect(created.rows[0]!.classification).toMatchObject({ command: 'task create', decision: 'allow' });
    expect(created.rows[0]!.argv).toContain('--title');
    expect(created.rows[0]!.argv.join(' ')).not.toContain('multi word brief');

    const listed = await run([PIN, config, 'task', 'list', '--state', 'all', '--json']);
    expect(listed.status).toBe(0);
    expect(JSON.stringify(JSON.parse(listed.stdout))).toContain(task.task_id);
    audited(listed.rows, 'success');

    const shown = await run([PIN, config, 'task', 'show', '--json', '--', task.task_id]);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).task.task_id).toBe(task.task_id);
    audited(shown.rows, 'success');
  });

  it('routes block, unblock and review, which take no configuration option', async () => {
    const id = JSON.parse((await run([PIN, config, 'task', 'create', '--title', 'lifecycle',
      '--backlog', '--no-room', '--json'])).stdout).task.task_id as string;
    const blocked = await run([PIN, config, 'task', 'block', id, '--reason', 'waiting for owner', '--json']);
    expect(blocked.stderr).toBe('');
    expect(blocked.status).toBe(0);
    expect(JSON.parse(blocked.stdout).task.blocked.reason).toBe('waiting for owner');
    audited(blocked.rows, 'success');
    const unblocked = await run([PIN, config, 'task', 'unblock', id, '--json']);
    expect(unblocked.status).toBe(0);
    expect(JSON.parse(unblocked.stdout).task.blocked ?? null).toBeNull();
    audited(unblocked.rows, 'success');
    // The pin is not silently turned into an option these commands do not have.
    const injected = await run([PIN, config, 'task', 'block', id, '--reason', 'x', '--configuration', config]);
    expect(injected.status).toBe(1);
    audited(injected.rows, 'validation');
    const review = await run([PIN, config, 'task', 'review', id, '--json']);
    audited(review.rows, review.status === 0 ? 'success' : undefined);
    // Ordinary state validation is unchanged by the pin.
    const missing = await run([PIN, config, 'task', 'unblock', 'no-such-task', '--json']);
    expect(missing.status).toBe(1);
    audited(missing.rows);
  });

  it.each([
    ['late long option', ['task', 'list', '--json', '--configuration', '@other']],
    ['late short option', ['task', 'list', '-c', '@other', '--json']],
    ['attached short option', ['task', 'list', '-c@other']],
    ['equals form', ['task', 'list', '--configuration=@other']],
    ['repeated, last differs', ['task', 'list', '--configuration', '@config', '--configuration', '@other']],
    ['on a lifecycle command', ['task', 'create', '--title', 't', '--backlog', '--no-room', '-c', '@other']],
    ['on plan inspection', ['config', '--json', '--configuration', '@other']],
    ['relative spelling of another file', ['task', 'list', '-c', 'other.yaml']],
  ])('refuses a different configuration: %s', async (_name, args) => {
    const result = await run([PIN, config, ...args.map(arg => arg.replace('@other', other).replace('@config', config))]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`pinned to configuration ${config}`);
    // Refused by Fleet validation after audit began; the command body never ran.
    audited(result.rows, 'validation');
    expect(result.rows[0]!.outcome?.effect).toBe('not_started');
  });

  it('accepts the pinned configuration repeated, and option-like values', async () => {
    const same = await run([PIN, config, 'task', 'list', '--configuration', config, '--json']);
    expect(same.status).toBe(0);
    audited(same.rows, 'success');
    // `--title` consumes the next token even when it looks like an option.
    const literal = await run([PIN, config, 'task', 'create', '--title', '--configuration', '--backlog', '--no-room', '--json']);
    expect(literal.status).toBe(0);
    expect(JSON.parse(literal.stdout).task.title).toBe('--configuration');
    // After `--`, a configuration-looking token is a positional, never an override.
    const positional = await run([PIN, config, 'task', 'show', '--json', '--', '--configuration']);
    expect(positional.status).toBe(1);
    expect(positional.stderr).not.toContain('pinned to configuration');
    expect(positional.stderr).toContain('task not found: --configuration');
  });

  it('pins the configuration the command actually loads', async () => {
    writeFileSync(other, 'api_version: not-a-fleet\n');
    try {
      // With no pin and no option the default (~/fleet.yaml == config here) loads fine;
      // pinning the broken file proves the pinned path is the one read.
      const broken = await run([PIN, other, 'config', '--json']);
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain(other);
      audited(broken.rows, 'runtime');
      const fine = await run([PIN, config, 'config', '--json']);
      expect(fine.status).toBe(0);
      expect(JSON.parse(fine.stdout).roles).toEqual([]);
    } finally { writeFileSync(other, 'api_version: ours.network/fleet/v2\n'); }
  });

  it.each([
    [['--help'], 'Usage: ours-fleet'],
    [['task', '--help'], 'Usage: ours-fleet task'],
    [['room', '--help'], 'Usage: ours-fleet room'],
    [['template', '--help'], 'Usage: ours-fleet template'],
    [['task', 'create', '--help'], '--title <title>'],
    [['task', 'start', '--help'], '--template <name>'],
    [['docs'], 'managed_cli'],
    [['template', 'list', '--json'], '['],
  ])('keeps help and inspection on the audited path: %j', async (args, expected) => {
    const result = await run([PIN, config, ...args]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    audited(result.rows, 'success');
  });

  it.each([
    ['spawn', ['spawn', 'Helper', '--temp']],
    ['room delete', ['room', 'delete', 'r', 'r']],
    ['room create', ['room', 'create', '--name', 'n']],
    ['task delete', ['task', 'delete', 't', 't']],
    ['ours call', ['ours', 'call', 'A', 'send_message']],
    ['status', ['status', 'A']],
    ['second pin', [PIN, '/elsewhere.yaml', 'task', 'list']],
  ])('refuses commands outside the prepared workflow: %s', async (_name, args) => {
    const result = await run([PIN, config, ...args]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('is not part of a Fleet-prepared managed workflow');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.outcome?.effect).toBe('not_started');
  });

  it.each([
    ['pin after the command', ['task', 'list', PIN, '@config']],
    ['equals pin', [`${PIN}=@config`, 'task', 'list']],
    ['relative pin', [PIN, 'fleet.yaml', 'task', 'list']],
    ['unnormalized pin', [PIN, '@config/../fleet.yaml', 'task', 'list']],
  ])('refuses a malformed pin: %s', async (_name, args) => {
    const result = await run(args.map(arg => arg.replace('@config', config)));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/must be the first argument|normalized absolute configuration path/u);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.outcome?.effect).toBe('not_started');
  });

  it.each([
    ['hidden worker', [PIN, '@config', '_run', 'A'], 'fleet supervisor proxy deny'],
    ['no command', [PIN, '@config'], 'fleet supervisor proxy unsupported'],
    ['pin without a value', [PIN], 'fleet supervisor proxy unsupported'],
  ])('leaves the supervisor\'s own fail-closed refusals in front: %s', async (_name, args, message) => {
    const result = await run(args.map(arg => arg.replace('@config', config)));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
    expect(result.rows[0]!.outcome).toMatchObject({ class: 'denied', effect: 'not_started' });
  });

  it('refuses the pinned form outside a managed session instead of running unaudited', async () => {
    const result = await run([PIN, config, 'task', 'list'], false);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('only valid inside a Fleet-managed agent session');
    expect(result.rows).toHaveLength(0);
    // The ordinary operator form is untouched.
    expect((await run(['task', 'list', '--json', '--configuration', config], false)).status).toBe(0);
  });

  it('leaves ordinary managed commands exactly as they were', async () => {
    const result = await run(['task', 'list', '--json', '--configuration', other]);
    expect(result.status).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.argv[0]).toBe('task');
  });
});

describe('parseManagedEntry', () => {
  it('injects the pin only where the command takes a configuration', () => {
    for (const form of MANAGED_CLI_WORKFLOWS['task-workflow'].forms) {
      const entry = parseManagedEntry([PIN, '/srv/fleet.yaml', ...form.tokens, '--json']);
      expect(entry.kind).toBe('pinned');
      if (entry.kind !== 'pinned') continue;
      expect(entry.form.tokens).toEqual(form.tokens);
      expect(entry.argv).toEqual(form.configuration
        ? [...form.tokens, '--configuration', '/srv/fleet.yaml', '--json']
        : [...form.tokens, '--json']);
    }
  });
  it('preserves the tail verbatim for argv-based member parsing', () => {
    const tail = ['--template', 'pair', '--member', 'developer', '--model', 'x', '--member', 'critic', '--cwd', '/a b'];
    const entry = parseManagedEntry([PIN, '/srv/fleet.yaml', 'task', 'start', 'T1', ...tail]);
    expect(entry).toMatchObject({ kind: 'pinned',
      argv: ['task', 'start', '--configuration', '/srv/fleet.yaml', 'T1', ...tail] });
  });
  it('is inert for ordinary argv, including a value that merely equals the flag', () => {
    expect(parseManagedEntry(['task', 'list'])).toEqual({ kind: 'none' });
    expect(parseManagedEntry([])).toEqual({ kind: 'none' });
    expect(parseManagedEntry(['send', 'A', '--', PIN])).toEqual({ kind: 'none' });
  });
});
