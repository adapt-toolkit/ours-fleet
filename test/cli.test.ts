import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realExec } from '../src/exec.js';

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
