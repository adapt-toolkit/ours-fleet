import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realExec } from '../src/exec.js';
import { UNATTENDED_FLOOR } from '../src/permissions.js';

const CLI = resolve('dist/cli.js');
let dir: string;

beforeAll(async () => {
  const r = await realExec('npm', ['run', 'build']);
  if (r.code !== 0) throw new Error(`build failed: ${r.stderr}`);
}, 120_000);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-cli-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) =>
  realExec('node', [CLI, ...args], { env: { ...process.env, OURS_FLEET_HOME: dir } });

describe('ours-fleet CLI', () => {
  it('config prints the merged plan from the example file', async () => {
    const r = await run(['config', '-c', resolve('examples/fleet.yaml')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● FleetCoordinator');
    expect(r.stdout).toContain('● Alice');
    expect(r.stdout).toContain('harness:     claude-code');
    expect(r.stdout).toContain('oversees:    Alice@5m');
    expect(r.stdout).toContain('source:');
  });

  it('--help lists the important commands', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['docs', 'up', 'down', 'spawn', 'send', 'peek', 'doctor', 'init'])
      expect(r.stdout).toContain(c);
  });

  it('docs and man print the AI-friendly configuration reference', async () => {
    for (const command of ['docs', 'man']) {
      const r = await run([command]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('# ours-fleet reference');
      expect(r.stdout).toContain('Both lifetimes support `--session acp`');
      expect(r.stdout).toContain('approval: ask|allow|deny');
      expect(r.stdout).toContain('@agentclientprotocol/codex-acp');
      expect(r.stdout).toContain('bundled automatically');
      expect(r.stdout).toContain('Reliable mail wake');
    }
  });

  it('doctor runs and exits 0/1 without crashing', async () => {
    const r = await run(['doctor']);
    expect([0, 1]).toContain(r.code);
    expect(r.stdout).toContain('node');
    expect(r.stdout).toContain('tmux');
  });

  it('config errors cleanly on a missing explicit file', async () => {
    const r = await run(['config', '-c', join(dir, 'missing.yaml')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('config not found');
  });

  it('spawn --help lists model and Codex controls', async () => {
    const r = await run(['spawn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--model');
    for (const flag of ['--permission-mode', '--sandbox', '--profile', '--launcher', '--codex-config', '--add-dir', '--monitor'])
      expect(r.stdout).toContain(flag);
  });

  it('spawn offers --isolation-file, the one new operator input (6.3)', async () => {
    const r = await run(['spawn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--isolation-file');
    // Commander wraps help text, so match on words rather than a whole phrase.
    expect(r.stdout).toContain('isolation:');
    expect(r.stdout).toContain('fleet.yaml');
  });

  it('docs describe creation-time isolation (6.3)', async () => {
    const r = await run(['docs']);
    expect(r.stdout).toContain('--isolation-file');
    expect(r.stdout).toContain('Creation-time isolation');
  });

  it('config prints an isolation summary for a role that declares it', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    isolation:\n      network: deny\n      resources:\n        mem: 2G\n        cpu: "1.5"\n');
    const r = await run(['config']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● Sec');
    expect(r.stdout).toContain('isolation:');
    expect(r.stdout).toMatch(/net=deny/);
    expect(r.stdout).toMatch(/mem=2G/);
  });

  it('config and doctor print the SAME permission warning (2.3)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n'
      + '  Lossy:\n    harness: claude-code\n    permissions:\n      approval: allow\n'
      + '  Exact:\n    harness: codex\n    permissions:\n      approval: allow\n      filesystem: unrestricted\n');

    const cfg = await run(['config']);
    const doc = await run(['doctor']);
    expect(cfg.code).toBe(0);

    const WARNING = "role 'Lossy': Claude permission modes do not exactly represent "
      + 'independent approval and filesystem intent; fleet isolation remains the outer boundary';
    expect(cfg.stdout).toContain(WARNING);        // the warning has a caller at last…
    expect(doc.stdout).toContain(WARNING);        // …and both commands say the same thing

    // The exact Codex combination stays quiet in both.
    expect(cfg.stdout).not.toContain("role 'Exact':");
    expect(doc.stdout).toMatch(/permissions: Exact.*\(exact\)/);
  });

  it('status names a held-down role, its reason and when (3.2)', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const stateDir = join(dir, '.ours-fleet', 'agents', 'Wedged');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.restart-ledger.json'), JSON.stringify({
      version: 1, consecutiveImmediateFailures: 5,
      lastReason: 'exited with code 127 after 0.2s', nextDelayMs: 0,
      resumeDiscarded: true, circuit: 'open',
      updatedAt: '2026-07-30T10:00:00.000Z', openedAt: '2026-07-30T10:00:00.000Z',
    }));

    const r = await run(['status', 'Wedged']);
    // A held-down role's unit looks healthy — the runner is alive on purpose.
    expect(r.stdout).toContain('HELD DOWN since 2026-07-30T10:00:00.000Z');
    expect(r.stdout).toContain('5 immediate failures');
    expect(r.stdout).toContain('exited with code 127');
    expect(r.stdout).toContain('ours-fleet restart Wedged');
  });

  it('config and doctor both report a contradicted permission intent (2.4)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n'
      + '  Contradicted:\n    harness: claude-code\n'
      + '    permissions:\n      approval: allow\n'
      + '    harness_options:\n      permission_mode: plan\n'
      + '  Single:\n    harness: claude-code\n'
      + '    harness_options:\n      permission_mode: plan\n');

    const cfg = await run(['config']);
    const doc = await run(['doctor']);
    const WARNING = "role 'Contradicted': harness_options.permission_mode=plan contradicts the "
      + 'permissions block, which translates to permission_mode=bypassPermissions — '
      + 'harness_options.permission_mode=plan wins';
    expect(cfg.stdout).toContain(WARNING);
    expect(doc.stdout).toContain(WARNING);

    // A single source of intent says nothing about being contradicted.
    expect(cfg.stdout).not.toContain("role 'Single': harness_options");
    expect(doc.stdout).not.toContain("role 'Single': harness_options");
  });

  it('peek and send never call an unreachable role dead (1.5)', async () => {
    // No tmux session and no control socket: the honest answer is "I could not
    // reach it", plus what that does and does not prove.
    for (const argv of [['peek', 'Ghost'], ['send', 'Ghost', 'hi']]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${argv[0]} Ghost:`);          // the real failure, named
      expect(r.stderr).not.toContain('is not running');         // the old blanket verdict
    }
  });

  it('send into a busy ACP role returns as queued, not as a dead agent (1.5)', async () => {
    const { mkdirSync } = await import('node:fs');
    const { AcpSession } = await import('../src/session/acp.js');
    const { RoleControlServer } = await import('../src/session/control.js');
    const fixture = resolve('test/fixtures/acp-agent.mjs');
    const stateDir = join(dir, '.ours-fleet', 'agents', 'Busy');
    mkdirSync(stateDir, { recursive: true });

    const session = await AcpSession.start({
      name: 'Busy', argv: [process.execPath, fixture], cwd: stateDir, env: {},
      stateDir, mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      log: () => {},
    });
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      const busy = session.submitPrompt('block 3000');    // hold a turn open
      await new Promise(r => setTimeout(r, 100));

      const started = Date.now();
      const r = await run(['send', 'Busy', 'while you are busy']);
      expect(r.code).toBe(0);                             // not an error at all
      expect(r.stdout).toContain('queued for Busy');
      expect(r.stderr).not.toContain('is not running');
      expect(Date.now() - started).toBeLessThan(3_000);   // did not wait for the turn

      // peek must not call it dead either.
      const p = await run(['peek', 'Busy']);
      expect(p.code).toBe(0);
      await busy;
    } finally {
      await control.close();
      await session.close();
    }
  }, 40_000);

  it('doctor fails with the parser cause for a config `config` rejects (1.4)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A:\n    harnes: claude-code\n');

    const cfg = await run(['config']);
    expect(cfg.code).toBe(1);
    expect(cfg.stderr).toContain('unknown key(s) harnes');

    const doc = await run(['doctor']);
    expect(doc.code).toBe(1);                        // must not read green
    expect(doc.stdout).toContain('unknown key(s) harnes');   // same actionable cause
    expect(doc.stdout).toContain('node');            // host checks still ran
    expect(doc.stdout).toContain('tmux');
    expect(doc.stdout).toMatch(/claude-code: /);     // AI CLI checks did not disappear
    expect(doc.stdout).toMatch(/MISS roles\s+unknown/);
  });

  it('peek renders automatic permission decisions on a live ACP role (1.3)', async () => {
    const { mkdirSync } = await import('node:fs');
    const { AcpSession } = await import('../src/session/acp.js');
    const { RoleControlServer } = await import('../src/session/control.js');
    const fixture = resolve('test/fixtures/acp-agent.mjs');
    const stateDir = join(dir, '.ours-fleet', 'agents', 'Perm');   // agentDir('Perm')
    mkdirSync(stateDir, { recursive: true });

    const session = await AcpSession.start({
      name: 'Perm', argv: [process.execPath, fixture], cwd: stateDir, env: {},
      stateDir, mode: 'fresh',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      log: () => {},
    });
    const control = new RoleControlServer(stateDir, session, () => {});
    await control.start();
    try {
      await session.submitPrompt('permission twice');       // both auto-denied
      const r = await run(['peek', 'Perm']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('automatic decision: denied');
      expect(r.stdout).toContain('via permissions.unattended=deny');
      expect(r.stdout).toContain('reason: no controller is attached');
      expect(r.stdout).not.toContain('respond: /permit');   // nothing is pending
    } finally {
      await control.close();
      await session.close();
    }
  }, 30_000);

  it('config prints a role model from fleet.d', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { stringify } = await import('yaml');
    mkdirSync(join(dir, 'fleet.d'), { recursive: true });
    writeFileSync(
      join(dir, 'fleet.d', 'M.yaml'),
      stringify({ roles: { M: { model: 'claude-fable-5' } } }));
    const r = await run(['config']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● M');
    expect(r.stdout).toContain('model:');
    expect(r.stdout).toContain('claude-fable-5');
  });
});

describe('never-prompt failure and the capability floor are documented (7.4)', () => {
  it('docs explain the silent denial and how to detect it before launch', async () => {
    const r = await run(['docs']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Never-prompt failure');
    expect(r.stdout).toContain('no error, no log line');   // (the line wraps before this)
    expect(r.stdout).toContain('.session-events.jsonl');
    expect(r.stdout).toContain('one-shot rejection');
  });

  it('docs list EVERY capability the doctor check enforces', async () => {
    const r = await run(['docs']);
    // The documented floor must match the code exactly — a doc listing five of
    // six would be worse than none, because it would read as complete.
    for (const capability of UNATTENDED_FLOOR) expect(r.stdout, capability).toContain(capability);
  });

  it('docs carry no stale permission prescription', async () => {
    const r = await run(['docs']);
    // `dontAsk` may only appear as a named trap or in the list of native values,
    // never as advice. The old guidance recommended it for unattended roles.
    expect(r.stdout).not.toMatch(/use\s+`?dontAsk/i);
    expect(r.stdout).not.toMatch(/recommend\w*\s+`?dontAsk/i);
    expect(r.stdout).toContain('bypassPermissions');
  });

  it('docs cross-link the floor from the spawn and permissions references', async () => {
    const r = await run(['docs']);
    expect(r.stdout).toContain('--approval/--filesystem/--unattended');
    expect(r.stdout).toContain('unattended floor: <Role>');
  });
});
