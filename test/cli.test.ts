import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realExec } from '../src/exec.js';
import { UNATTENDED_FLOOR } from '../src/permissions.js';
import { writeV2Fixture } from './v2-fixture.js';
import { INIT_COMPLETION_GUIDANCE } from '../src/init-guidance.js';

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

const writeWatchdogReportFixture = () => {
  writeV2Fixture(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
  const reportsDir = join(dir, '.ours-fleet', 'watchdogs', 'w', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const fixture = JSON.parse(
    readFileSync(resolve('test/fixtures/watchdog-good-report.json'), 'utf8'),
  ) as Record<string, unknown>;
  const report = { ...fixture, watchdog: 'w', run_id: '20260731T115000Z' };
  writeFileSync(join(reportsDir, '20260731T115000Z.json'), JSON.stringify(report));
  return report;
};

describe('ours-fleet CLI', () => {
  it('init guidance copies the complete split default configuration', () => {
    expect(INIT_COMPLETION_GUIDANCE).toContain('examples/fleet.yaml" ~/fleet.yaml');
    expect(INIT_COMPLETION_GUIDANCE).toContain('examples/fleet" ~/fleet');
    expect(INIT_COMPLETION_GUIDANCE).toContain('~/fleet/{agents,roles,brains}/*.yaml');
  });

  it('redacts nested harness secrets identically from human and JSON config output', async () => {
    const file = join(dir, 'fleet.yaml');
    const root = join(dir, 'fleet');
    const agents = join(root, 'agents');
    writeFileSync(file, 'api_version: ours.network/fleet/v2\n');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'A.yaml'), [
      'role: { inline: {} }',
      'brain:',
      '  inline:',
      '    harness: codex',
      '    harness_options:',
      '      access_token: canary-token',
      '      nested:',
      '        password: canary-password',
      '        API-key: canary-api-key',
      '        credential: canary-credential',
      '        private_key: canary-private-key',
      '        auth: canary-auth',
      '        invite: canary-invite',
      '        visible: okay',
      '',
    ].join('\n'));
    chmodSync(file, 0o600);
    chmodSync(root, 0o700);
    chmodSync(agents, 0o700);
    chmodSync(join(agents, 'A.yaml'), 0o600);
    const human = await run(['config', '-c', file]);
    const json = await run(['config', '-c', file, '--json']);
    expect(human.code).toBe(0);
    expect(json.code).toBe(0);
    for (const output of [human.stdout, json.stdout]) {
      expect(output).not.toContain('canary-token');
      expect(output).not.toContain('canary-password');
      expect(output).not.toContain('canary-api-key');
      expect(output).not.toContain('canary-credential');
      expect(output).not.toContain('canary-private-key');
      expect(output).not.toContain('canary-auth');
      expect(output).not.toContain('canary-invite');
      expect(output).toContain('<redacted>');
    }
  });

  it('config --json emits a versioned deterministic plan without env secrets', async () => {
    const file = join(dir, 'fleet.yaml');
    writeV2Fixture(file, [
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
    expect(plan.schemaVersion).toBe(2);
    expect(plan.configMode).toBe('split-v2');
    expect(plan.sourceDocuments).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Manifest' }),
      expect.objectContaining({ kind: 'Agent', id: 'A' }),
    ]));
    // ANTHROPIC_MODEL is present because the role declares a model: the pin the
    // harness actually reads is derived from `model:`, not left to be inherited.
    expect(plan.roles[0].env).toEqual({
      redacted: true,
      keys: ['ANTHROPIC_MODEL', 'A_PUBLIC', 'Z_SECRET'],
      values: {
        ANTHROPIC_MODEL: '<redacted>', A_PUBLIC: '<redacted>', Z_SECRET: '<redacted>',
      },
    });
  });

  it('config --json keeps compatibility warnings off stdout and strict mode fails', async () => {
    const file = join(dir, 'fleet.yaml');
    writeV2Fixture(file, { roles: {} });
    writeFileSync(file, 'api_version: ours.network/fleet/v2\nvars: &shared { value: yes }\nextra: *shared\n', { mode: 0o600 });
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
    const example = join(dir, 'example');
    mkdirSync(example);
    cpSync(resolve('examples/fleet.yaml'), join(example, 'fleet.yaml'));
    cpSync(resolve('examples/fleet'), join(example, 'fleet'), { recursive: true });
    chmodSync(join(example, 'fleet.yaml'), 0o600);
    for (const kind of ['agents', 'roles', 'brains']) {
      chmodSync(join(example, 'fleet', kind), 0o700);
      for (const name of (await import('node:fs')).readdirSync(join(example, 'fleet', kind)))
        chmodSync(join(example, 'fleet', kind, name), 0o600);
    }
    chmodSync(join(example, 'fleet'), 0o700);
    const r = await run(['config', '-c', join(example, 'fleet.yaml')]);
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
    for (const option of ['--bind', '--public-origin', '--password-file', '--no-password', '--pairing'])
      expect(r.stdout).toContain(option);
    expect(r.stdout).not.toContain('#bootstrap=');
  });

  it('web serve accepts port zero for an isolated ephemeral listener', async () => {
    const child = spawn(process.execPath, [
      CLI, 'web', 'serve', '--port', '0', '--no-open', '--no-password',
    ], {
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
      expect(stdout).toContain('WARNING: unprotected mode enabled');
      const { readFileSync } = await import('node:fs');
      expect(JSON.parse(readFileSync(join(dir, '.ours-fleet/web/access.json'), 'utf8')).mode)
        .toBe('none');
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });

  it('requires an explicit protected or unprotected access choice on first web setup', async () => {
    const omitted = await run(['web', 'serve', '--port', '0', '--no-open']);
    expect(omitted.code).toBe(1);
    expect(omitted.stdout).toBe('');
    expect(omitted.stderr).toContain('first web setup requires an explicit access choice');
    expect(omitted.stderr).toContain('--password-file <path>');
    expect(omitted.stderr).toContain('--pairing');
    expect(omitted.stderr).toContain('--no-password');

    const paired = spawn(process.execPath, [
      CLI, 'web', 'serve', '--port', '0', '--no-open', '--pairing',
    ], {
      env: { ...process.env, OURS_FLEET_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    paired.stdout.setEncoding('utf8');
    paired.stdout.on('data', chunk => { stdout += chunk; });
    try {
      await Promise.race([
        new Promise<void>(resolve => paired.stdout.on('data', () => {
          if (/ours-fleet web listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout)) resolve();
        })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('paired web serve did not listen')), 5_000)),
      ]);
      expect(stdout).toContain('Access mode: trusted-browser pairing.');
      const { readFileSync } = await import('node:fs');
      expect(JSON.parse(readFileSync(join(dir, '.ours-fleet/web/access.json'), 'utf8')).mode)
        .toBe('pairing');
    } finally {
      paired.kill('SIGTERM');
      await once(paired, 'exit');
    }
  });

  it('docs and man print the AI-friendly configuration reference', async () => {
    for (const command of ['docs', 'man']) {
      const r = await run([command]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('# ours-fleet reference');
      expect(r.stdout).toContain('--brain BRAIN_ID --role ROLE_ID');
      expect(r.stdout).toContain('approval: ask|auto|allow');
      expect(r.stdout).toContain('@agentclientprotocol/codex-acp');
      expect(r.stdout).toContain('bundled automatically');
      expect(r.stdout).toContain('Reliable mail wake');
      expect(r.stdout).toContain('monitor.mode');
      expect(r.stdout).toContain('## Local web console');
      expect(r.stdout).toContain('ours-fleet web open');
      expect(r.stdout).toContain('ours-fleet web revoke-all');
      expect(r.stdout).toContain('IPv4-loopback-only by default');
      expect(r.stdout).toContain('--public-origin');
      expect(r.stdout).toContain('--password-file');
      expect(r.stdout).toContain('--no-password');
    }
  });

  it('doctor runs and exits 0/1 without crashing', async () => {
    const r = await run(['doctor']);
    expect([0, 1]).toContain(r.code);
    expect(r.stdout).toContain('node');
    expect(r.stdout).toContain('ours daemon');
  });

  it('config errors cleanly on a missing explicit file', async () => {
    const r = await run(['config', '-c', join(dir, 'missing.yaml')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('config not found');
  });

  it('config shows watchdogs and --json includes them in the plan', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'),
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

  it('config fails on a watchdog with an unknown key', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'),
      'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C, intervall: 5m }\n');
    const r = await run(['config']);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/unknown key\(s\) intervall/);
  });

  it('watchdog-run refuses an unknown watchdog and respects the run lock', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
    const r = await run(['watchdog-run', 'ghost']);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/unknown watchdog 'ghost'/);
    mkdirSync(join(dir, '.ours-fleet', 'watchdogs', 'w', '.run-lock'), { recursive: true });
    const r2 = await run(['watchdog-run', 'w']);
    expect(r2.code).toBe(1);
    expect(r2.stderr + r2.stdout).toMatch(/already running/);
  });

  it('watchdog-report shows latest, --list, run-id and --json', async () => {
    const report = writeWatchdogReportFixture();
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
  });

  it('watchdog-report history remains available with broken configuration', async () => {
    writeWatchdogReportFixture();
    // CLI report history remains usable when configuration is removed or broken.
    // The web query deliberately propagates its cfgProvider failure instead.
    writeFileSync(join(dir, 'fleet.yaml'), 'roles: [broken\n');
    const historyFallback = await run(['watchdog-report', 'w', '--list', '--json']);
    expect(historyFallback.code).toBe(0);
    expect(JSON.parse(historyFallback.stdout).runs[0].runId).toBe('20260731T115000Z');
  });

  it('watchdog-report rejects missing runs and unknown watchdogs', async () => {
    writeWatchdogReportFixture();
    const missing = await run(['watchdog-report', 'w', '29990101T000000Z']);
    expect(missing.code).toBe(1);

    const unknown = await run(['watchdog-report', 'ghost']);
    expect(unknown.code).toBe(1);
  });

  it('watchdog-report refuses a path-traversal-shaped name and touches nothing outside watchdogsRoot', async () => {
    const { writeFileSync, mkdirSync: mkdir, statSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
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
    writeV2Fixture(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
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

  it('watchdog-report surfaces an error report\'s diagnostic tail', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
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

  it('restart <watchdog> releases a held-down watchdog', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: C }\n');
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

  it('spawn --help exposes only Brain/Role agent configuration', async () => {
    const r = await run(['spawn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('--model');
    expect(r.stdout).not.toContain('--harness');
    for (const flag of ['--brain', '--role', '--approval', '--filesystem', '--unattended'])
      expect(r.stdout).toContain(flag);
  });

  it('spawn offers --isolation-file, the one new operator input', async () => {
    const r = await run(['spawn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--isolation-file');
    // Commander wraps help text, so match on words rather than a whole phrase.
    expect(r.stdout).toContain('isolation:');
    expect(r.stdout).toContain('fleet.yaml');
  });

  it('docs describe creation-time isolation', async () => {
    const r = await run(['docs']);
    expect(r.stdout).toContain('--isolation-file');
    expect(r.stdout).toContain('Creation-time isolation');
  });

  it('docs describe binary room deletion and legacy config semantics', async () => {
    const r = await run(['docs']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('room delete <id> <id>');
    expect(r.stdout).toContain('deprecated alias');
    expect(r.stdout).toContain('close-then-delete behavior');
    expect(r.stdout).toContain('not retained as an inspectable archive');
  });

  it('config prints an isolation summary for a role that declares it', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'),
      'roles:\n  Sec:\n    isolation:\n      network: deny\n      resources:\n        mem: 2G\n        cpu: "1.5"\n');
    const r = await run(['config']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● Sec');
    expect(r.stdout).toContain('isolation:');
    expect(r.stdout).toMatch(/net=deny/);
    expect(r.stdout).toMatch(/mem=2G/);
  });

  it('config and doctor print the SAME permission warning', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'),
      'roles:\n'
      + '  Lossy:\n    harness: claude-code\n    permissions:\n      approval: allow\n'
      + '  Exact:\n    harness: codex\n    permissions:\n      approval: allow\n      filesystem: unrestricted\n'
      + '  AcpWorkspace:\n    harness: codex\n    session: acp\n'
      + '    permissions:\n      approval: allow\n      filesystem: workspace\n      unattended: deny\n'
      + '  AcpFull:\n    harness: codex\n    session: acp\n'
      + '    permissions:\n      approval: allow\n      filesystem: unrestricted\n      unattended: deny\n');

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

    expect(cfg.stdout).toContain(
      "role 'AcpWorkspace': Codex ACP mode 'agent-full-access' couples approval and filesystem");
    expect(doc.stdout).toMatch(
      /permissions: AcpWorkspace.*mode=agent-full-access approval=never sandbox=danger-full-access.*couples approval and filesystem/);
    expect(doc.stdout).toMatch(/unattended floor: AcpWorkspace.*workspace-edit/);
    expect(cfg.stdout).not.toContain("role 'AcpFull':");
    expect(doc.stdout).toMatch(/permissions: AcpFull.*mode=agent-full-access.*\(exact\)/);
  }, 10_000);

  it('status names a held-down role, its reason and when', async () => {
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

  it('config and doctor both report a contradicted permission intent', async () => {
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(join(dir, 'fleet.yaml'),
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

  it('peek and send never call an unreachable role dead', async () => {
    // No tmux session and no control socket: the honest answer is "I could not
    // reach it", plus what that does and does not prove.
    for (const argv of [['peek', 'Ghost'], ['send', 'Ghost', 'hi']]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${argv[0]} Ghost:`);          // the real failure, named
      expect(r.stderr).not.toContain('is not running');         // the old blanket verdict
    }
  });

  it('send into a busy ACP role returns as queued, not as a dead agent', async () => {
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

  it('doctor fails with the parser cause for a config `config` rejects', async () => {
    writeV2Fixture(join(dir, 'fleet.yaml'), { roles: {} });
    writeFileSync(join(dir, 'fleet', 'agents', 'A.yaml'),
      'role: { inline: {} }\nbrain: { inline: { harness: claude-code } }\nharnes: claude-code\n',
      { mode: 0o600 });

    const cfg = await run(['config']);
    expect(cfg.code).toBe(1);
    expect(cfg.stderr).toContain('unknown key(s) harnes');

    const doc = await run(['doctor']);
    expect(doc.code).toBe(1);                        // must not read green
    expect(doc.stdout).toContain('unknown key(s) harnes');   // same actionable cause
    expect(doc.stdout).toContain('node');            // host checks still ran
    expect(doc.stdout).toContain('ours daemon');
    expect(doc.stdout).toMatch(/claude-code: /);     // AI CLI checks did not disappear
    expect(doc.stdout).toMatch(/MISS roles\s+unknown/);
  });

  it('peek renders automatic permission decisions on a live ACP role', async () => {
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

  it('rejects legacy fleet.d and prints a model from a bare Agent document', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { stringify } = await import('yaml');
    mkdirSync(join(dir, 'fleet.d'), { recursive: true });
    writeFileSync(
      join(dir, 'fleet.d', 'M.yaml'),
      stringify({ roles: { M: { model: 'claude-fable-5' } } }));
    writeV2Fixture(join(dir, 'fleet.yaml'), { roles: {} });
    const legacy = await run(['config']);
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain('legacy fleet.d configuration is unsupported');
    rmSync(join(dir, 'fleet.d'), { recursive: true, force: true });
    writeV2Fixture(join(dir, 'fleet.yaml'), { roles: { M: { model: 'claude-fable-5' } } });
    const r = await run(['config']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('● M');
    expect(r.stdout).toContain('model:');
    expect(r.stdout).toContain('claude-fable-5');
  });
});

describe('never-prompt failure and the capability floor are documented', () => {
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

describe('ours-fleet version', () => {
  it('--version stays a bare semver for scripts', async () => {
    const { stdout, code } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints the build identity, capabilities and the executable serving it', async () => {
    const { stdout, code } = await run(['version']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/ours-fleet \d+\.\d+\.\d+\+[0-9a-f]{12}/);
    expect(stdout).toContain('monitor.interrupt.after_tool');
    expect(stdout).toContain(resolve('dist/cli.js'));
  });

  it('version --json is machine-readable and free of environment values', async () => {
    const { stdout, code } = await run(['version', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(report.capabilities).toContain('monitor.interrupt.after_tool');
    expect(report.packageRoot).toBe(resolve('.'));
    expect(report.node).toBe(process.versions.node);
    expect(JSON.stringify(report)).not.toContain('OURS_FLEET_HOME');
  });

  it('config prints the build that resolved the plan', async () => {
    const file = join(dir, 'fleet.yaml');
    const { writeFileSync } = await import('node:fs');
    writeV2Fixture(file, 'roles:\n  A: {}\n');
    const { stdout } = await run(['config', '-c', file]);
    expect(stdout).toMatch(/build:\s+ours-fleet \d+\.\d+\.\d+\+[0-9a-f]{12}/);
  });
});

describe('build provenance is documented (AI reference)', () => {
  // `docs` is a pure dump of a constant — spawn the CLI once, not once per test.
  let cached: string | undefined;
  const docs = async () => (cached ??= (await run(['docs'])).stdout);

  it('tells an agent that semver alone does not identify an artifact', async () => {
    const text = await docs();
    expect(text).toContain('ours-fleet version');
    expect(text).toMatch(/same version[\s\S]{0,40}different build/i);
  });

  it('names the capability model and where to read a build id', async () => {
    const text = await docs();
    expect(text).toContain('monitor.interrupt.after_tool');
    expect(text).toContain('dist/build-info.json');
    expect(text).toContain('version --json');
  });

  it('points at the doctor install check for a divergent host', async () => {
    expect(await docs()).toMatch(/doctor[\s\S]{0,400}install/i);
  });
});
