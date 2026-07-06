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
    for (const c of ['up', 'down', 'spawn', 'send', 'peek', 'doctor', 'init'])
      expect(r.stdout).toContain(c);
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

  it('spawn --help lists the --model option', async () => {
    const r = await run(['spawn', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--model');
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
