import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realExec } from '../src/exec.js';
import { UNATTENDED_FLOOR } from '../src/permissions.js';

const CLI = resolve('dist/cli.js');
let dir: string;

beforeAll(() => {
  // dist/cli.js is built once by vitest's globalSetup (test/global-setup.ts),
  // before any test file runs — this is just a cheap guard against that
  // invariant breaking.
  if (!existsSync(CLI)) throw new Error('dist/cli.js missing — global setup should have built it');
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-cli-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) =>
  realExec('node', [CLI, ...args], { env: { ...process.env, OURS_FLEET_HOME: dir } });

describe('ours-fleet CLI', () => {
  it('config --json emits a versioned deterministic plan without env secrets', async () => {
    const file = join(dir, 'fleet.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, [
      'roles:',
      '  A:',
      '    model: approved-model',
      '    env:',
      '      Z_SECRET: canary-must-not-leak',
      '      A_PUBLIC: still-redacted',
      '',
    ].join('\n'));
    const first = await run(['config', '-c', file, '--json']);
    const second = await run(['config', '-c', file, '--json']);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stderr).toBe('');
    expect(first.stdout).not.toContain('canary-must-not-leak');
    const plan = JSON.parse(first.stdout);
    expect(plan.schemaVersion).toBe(1);
    expect(plan.roles[0].env).toEqual({
      redacted: true,
      keys: ['A_PUBLIC', 'Z_SECRET'],
      values: { A_PUBLIC: '<redacted>', Z_SECRET: '<redacted>' },
    });
  });

  it('config --json keeps compatibility warnings off stdout and strict mode fails', async () => {
    const file = join(dir, 'fleet.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'roles:\n  A: &role {}\n  B: *role\n');
    const compat = await run(['config', '-c', file, '--json']);
    expect(compat.code).toBe(0);
    expect(() => JSON.parse(compat.stdout)).not.toThrow();
    expect(compat.stderr).toContain('non-plain YAML');
    const strict = await run(['config', '-c', file, '--json', '--yaml-mode', 'strict']);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toBe('');
    expect(strict.stderr).toContain('non-plain YAML');
  });

  it('config prints the merged plan from the example file', async () => {
    const r = await run(['config', '-c', resolve('examples/fleet.yaml')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● FleetCoordinator');
    expect(r.stdout).toContain('● Alice');
    expect(r.stdout).toContain('harness:     claude-code');
    expect(r.stdout).toContain('monitor:     fleet (interrupt=false)');
    expect(r.stdout).toContain('oversees:    Alice@5m');
    expect(r.stdout).toContain('source:');
  });

  it('--help lists the important commands', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['docs', 'up', 'down', 'spawn', 'send', 'peek', 'doctor', 'init'])
      expect(r.stdout).toContain(c);
  });

  it('web help exposes secure re-pair and revocation commands', async () => {
    const r = await run(['web', '--help']);
    expect(r.code).toBe(0);
    for (const command of [
      'serve', 'install', 'start', 'stop', 'restart', 'status', 'uninstall', 'open', 'revoke-all',
    ]) expect(r.stdout).toContain(command);
    expect(r.stdout).not.toContain('#bootstrap=');
  });

  it('web serve accepts port zero for an isolated ephemeral listener', async () => {
    const child = spawn(process.execPath, [CLI, 'web', 'serve', '--port', '0', '--no-open'], {
      env: { ...process.env, OURS_FLEET_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    try {
      await Promise.race([
        new Promise<void>(resolve => child.stdout.on('data', () => {
          if (/ours-fleet web listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout)) resolve();
        })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('web serve did not listen')), 5_000)),
      ]);
      expect(stdout).toMatch(/ours-fleet web listening on http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
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
      expect(r.stdout).toContain('monitor.mode');
      expect(r.stdout).toContain('## Local web console');
      expect(r.stdout).toContain('ours-fleet web open');
      expect(r.stdout).toContain('ours-fleet web revoke-all');
      expect(r.stdout).toContain('intentionally IPv4-loopback-only');
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

  it('config shows watchdogs and --json includes them in the plan (acceptance 1)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  Alice: {}\n  Docs: {}\n'
      + 'watchdogs:\n'
      + '  nightwatch: { coordinator: FleetCoordinator, isolation: { network: deny } }\n'
      + '  slowlane: { coordinator: Owner, interval: 2h, watch: [Docs], enabled: false }\n');
    const human = await run(['config']);
    expect(human.stdout).toContain('watchdogs:');
    expect(human.stdout).toMatch(/nightwatch.*every 10m.*-> FleetCoordinator/s);
    expect(human.stdout).toContain('isolation: {"network":"deny"}');
    expect(human.stdout).toMatch(/slowlane.*disabled/s);
    const json = await run(['config', '--json']);
    const plan = JSON.parse(json.stdout);
    expect(plan.watchdogs).toHaveLength(2);
    expect(plan.watchdogs[0]).toMatchObject({
      name: 'nightwatch', enabled: true, intervalMs: 600000,
      coordinator: 'FleetCoordinator', watch: ['Alice', 'Docs'],
      identity: 'Watchdog-nightwatch', model: null, promptFile: null,
      isolation: { network: 'deny' },
    });
  });

  it('config fails on a watchdog with an unknown key (acceptance 1)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'),
      'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C, intervall: 5m }\n');
    const r = await run(['config']);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/unknown key\(s\) intervall/);
  });

  it('watchdog-run refuses an unknown watchdog and respects the run lock', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    const r = await run(['watchdog-run', 'ghost']);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/unknown watchdog 'ghost'/);
    mkdirSync(join(dir, '.ours-fleet', 'watchdogs', 'w', '.run-lock'), { recursive: true });
    const r2 = await run(['watchdog-run', 'w']);
    expect(r2.code).toBe(1);
    expect(r2.stderr + r2.stdout).toMatch(/already running/);
  });

  it('watchdog-report shows latest, --list, run-id and --json (acceptance 7)', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    const reportsDir = join(dir, '.ours-fleet', 'watchdogs', 'w', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const fixture = JSON.parse(
      readFileSync(resolve('test/fixtures/watchdog-good-report.json'), 'utf8'),
    ) as Record<string, unknown>;
    const report = { ...fixture, watchdog: 'w', run_id: '20260731T115000Z' };
    writeFileSync(join(reportsDir, '20260731T115000Z.json'), JSON.stringify(report));

    const latest = await run(['watchdog-report', 'w']);
    expect(latest.code).toBe(0);
    expect(latest.stdout).toMatch(/w.*20260731T115000Z/s);
    expect(latest.stdout).toMatch(/Alice\s+blocked/);
    expect(latest.stdout).toContain('Waiting on a trust dialog');

    const list = await run(['watchdog-report', 'w', '--list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/20260731T115000Z\s+.*anomalies/);

    const one = await run(['watchdog-report', 'w', '20260731T115000Z', '--json']);
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout).run_id).toBe('20260731T115000Z');
    expect(one.stdout).toBe(JSON.stringify(report) + '\n'); // stored JSON, unmodified

    const missing = await run(['watchdog-report', 'w', '29990101T000000Z']);
    expect(missing.code).toBe(1);

    const unknown = await run(['watchdog-report', 'ghost']);
    expect(unknown.code).toBe(1);
  });

  it('watchdog-report refuses a path-traversal-shaped name and touches nothing outside watchdogsRoot (finding #1)', async () => {
    const { writeFileSync, mkdirSync: mkdir, statSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    // watchdogsRoot() is `<dir>/.ours-fleet/watchdogs`; join(watchdogsRoot(), '../../evil')
    // lands at `<dir>/evil` — two levels up from `watchdogs`. Pre-create that as an unrelated
    // "victim" directory (0755, no reports/) so the traversal target actually exists: without
    // that, `watchdogKnown`'s pre-fix existsSync check legitimately returns false regardless of
    // any guard, and the test would pass vacuously.
    const victim = join(dir, 'evil');
    mkdir(victim, { recursive: true, mode: 0o755 });
    const before = statSync(victim).mode & 0o777;

    const r = await run(['watchdog-report', '../../evil', '--list']);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/unknown watchdog '\.\.\/\.\.\/evil'/);
    // Pre-fix, watchdogKnown resolves this traversal to an existing dir, so listRuns() proceeds
    // into store.ts's ensureDir, which chmods the target 0700 and mkdirs a reports/ inside it —
    // an unrelated directory outside watchdogsRoot mutated by an unvalidated CLI arg.
    expect(statSync(victim).mode & 0o777).toBe(before);
    expect(existsSync(join(victim, 'reports'))).toBe(false);
  });

  it('watchdog-report --list --json emits machine-readable run metadata, not the human table', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    const reportsDir = join(dir, '.ours-fleet', 'watchdogs', 'w', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const fixture = JSON.parse(
      readFileSync(resolve('test/fixtures/watchdog-good-report.json'), 'utf8'),
    ) as Record<string, unknown>;
    const report = { ...fixture, watchdog: 'w', run_id: '20260731T115000Z' };
    writeFileSync(join(reportsDir, '20260731T115000Z.json'), JSON.stringify(report));

    const r = await run(['watchdog-report', 'w', '--list', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.runs[0].runId).toBe('20260731T115000Z');
  });

  it('watchdog-report surfaces an error report\'s diagnostic tail (acceptance 9)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    const reportsDir = join(dir, '.ours-fleet', 'watchdogs', 'w', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const report = {
      schema_version: 1, watchdog: 'w', run_id: '20260731T115000Z',
      started_at: '2026-07-31T11:50:00Z', finished_at: '2026-07-31T11:51:12Z',
      status: 'error', summary: { checked: 0, healthy: 0, idle: 0, anomalies: 0 },
      roles: [], alerts: [], error: 'timeout', tail: 'boom line',
    };
    writeFileSync(join(reportsDir, '20260731T115000Z.json'), JSON.stringify(report));

    const r = await run(['watchdog-report', 'w']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('output tail');
    expect(r.stdout).toContain('boom line');
  });

  it('restart <watchdog> releases a held-down watchdog (spec §3, Task 15)', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    const sdir = join(dir, '.ours-fleet', 'watchdogs', 'w');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'state.json'), JSON.stringify({
      version: 1, consecutiveFailures: 3, heldDown: true, heldSince: '2026-07-31T10:00:00Z',
    }));

    const cfgOut = await run(['config']);
    expect(cfgOut.stdout).toContain('● w  (held down)');

    const rep = await run(['watchdog-report', 'w', '--list']);
    expect(rep.stdout).toMatch(/HELD DOWN/);

    const r = await run(['restart', 'w']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/released watchdog 'w'/);
    expect(JSON.parse(readFileSync(join(sdir, 'state.json'), 'utf8')).heldDown).toBe(false);

    // the config chip clears too, once the watchdog is no longer held down
    const cfgAfter = await run(['config']);
    expect(cfgAfter.stdout).not.toContain('(held down)');
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
