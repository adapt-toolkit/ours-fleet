import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { runOnce, runTemp, buildPaneCommand } from '../src/runner.js';
import { registerAdapter } from '../src/harness/registry.js';
import { agentDir } from '../src/paths.js';
import { Tmux } from '../src/tmux.js';
import { fakeAdapter } from './registry.test.js';
import type { Exec } from '../src/exec.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-run-'));
  process.env.OURS_FLEET_HOME = dir;
  registerAdapter(fakeAdapter);
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/** Fake tmux whose pane "process" dies after `lifeChecks` liveness polls,
 *  writing `.exit-status` (like the pane shell would) at the moment of death. */
function fakeWorld(opts: { exitCode?: string; lifeChecks?: number; exitDelayMs?: number; exitFile?: string; bwrap?: 'ok' | 'missing'; cpuDelegated?: boolean } = {}) {
  const paneCommands: string[] = [];
  let clock = 0;
  let checks = 0;
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'bwrap') return { stdout: 'bubblewrap 0.11.1\n', stderr: '', code: opts.bwrap === 'missing' ? 127 : 0 };
    if (args[0] === 'new-session') paneCommands.push(args[args.length - 1]);
    if (args[0] === 'list-panes') return { stdout: '4242\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const deps = {
    tmux: new Tmux(exec),
    exec,
    cpuDelegated: () => opts.cpuDelegated ?? true,
    isAlive: () => {
      checks++;
      if (checks >= (opts.lifeChecks ?? 2)) {
        if (opts.exitFile) writeFileSync(opts.exitFile, (opts.exitCode ?? '0') + '\n');
        return false;
      }
      return true;
    },
    sleep: async (ms: number) => { clock += opts.exitDelayMs ?? ms; },
    now: () => clock,
    log: () => {},
  };
  return { deps, paneCommands };
}

const writeCfg = (roles: Record<string, object>) =>
  writeFileSync(join(dir, 'fleet.yaml'), stringify({ roles }));

describe('buildPaneCommand', () => {
  it('escapes argv and env, appends exit capture', () => {
    const cmd = buildPaneCommand(
      { argv: ['bin', "it's"], env: { A: 'x y' } }, { B: 'z' }, '/tmp/es');
    expect(cmd).toContain(`A='x y'`);
    expect(cmd).toContain(`B='z'`);
    expect(cmd).toContain(`'bin' 'it'\\''s'`);
    expect(cmd).toContain(`; echo $? > '/tmp/es'`);
  });

  it('runs a sandbox-wrapped argv while keeping env + exit capture host-side', () => {
    const cmd = buildPaneCommand(
      { argv: ['claude', 'go'], env: { A: 'x' } }, { B: 'z' }, '/tmp/es',
      ['bwrap', '--die-with-parent', '--', 'claude', 'go']);
    expect(cmd.startsWith('env ')).toBe(true);         // env prefix host-side
    expect(cmd).toContain(`A='x'`);
    expect(cmd).toContain(`'bwrap' '--die-with-parent' '--' 'claude' 'go'`);
    expect(cmd).toContain(`; echo $? > '/tmp/es'`);     // exit capture host-side
    expect(cmd.indexOf('bwrap')).toBeLessThan(cmd.indexOf('echo $?')); // capture is outside
  });
});

describe('runOnce isolation', () => {
  it('wraps the pane command under bwrap when the role declares isolation', async () => {
    writeCfg({ A: { harness: 'fake', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).toContain(`'bwrap'`);
    expect(paneCommands[0]).toMatch(/'--'.*'fakebin'/);      // original argv after --
    expect(paneCommands[0]).toContain('; echo $? >');        // exit capture preserved
  });

  it('does not wrap when the role has no isolation block', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).not.toContain('bwrap');
    expect(paneCommands[0]).toContain(`'fakebin'`);
  });

  it('still captures the exit code from a wrapped role', async () => {
    writeCfg({ A: { harness: 'fake', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    // clean exit (code 0) rotates the session-id, proving exit capture worked
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
  });

  it('degrades to un-isolated (no bwrap) when the backend is unavailable under warn', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'warn' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).not.toContain('bwrap');
    expect(paneCommands[0]).toContain(`'fakebin'`);
  });

  it('strict + unavailable backend refuses to launch', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'strict' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await expect(runOnce('A', {}, deps)).rejects.toThrow(/strict|unavailable|refus/i);
  });

  it('composes a systemd-run resource scope OUTSIDE the sandbox when resources are set', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { resources: { mem: '256M', cpu: '1', pids: 128 } } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), cpuDelegated: true });
    await runOnce('A', {}, deps);
    const cmd = paneCommands[0];
    expect(cmd).toContain('systemd-run');
    expect(cmd).toContain('MemoryMax=256M');
    expect(cmd).toContain('CPUQuota=100%');
    expect(cmd).toContain('TasksMax=128');
    expect(cmd.indexOf('systemd-run')).toBeLessThan(cmd.indexOf('bwrap')); // resource scope is outermost
  });

  it('degrades cpu cap to a warning when the cpu controller is not delegated', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { resources: { mem: '256M', cpu: '2' } } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), cpuDelegated: false });
    await runOnce('A', {}, deps);
    const cmd = paneCommands[0];
    expect(cmd).toContain('MemoryMax=256M');   // mem still enforced
    expect(cmd).not.toContain('CPUQuota');       // cpu dropped
  });

  it('applies resource caps even when the sandbox degrades to none', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'warn', resources: { mem: '128M' } } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await runOnce('A', {}, deps);
    const cmd = paneCommands[0];
    expect(cmd).not.toContain('bwrap');          // sandbox degraded
    expect(cmd).toContain('systemd-run');        // but resources still capped
    expect(cmd).toContain('MemoryMax=128M');
  });
});

describe('runOnce', () => {
  it('fresh boot writes markers and launches with fresh args', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '1', lifeChecks: 30, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(existsSync(join(d, '.session-id'))).toBe(true);
    expect(paneCommands[0]).toContain('--sid');       // fake adapter fresh marker
    expect(paneCommands[0]).toContain('--fake-prep');
    expect(paneCommands[0]).toContain('FAKE=');
    // crash (code 1, slow) keeps .booted → next run resumes
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('clean exit rotates session-id and clears .booted', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
    expect(existsSync(join(d, '.booted'))).toBe(false);
  });

  it('fast-failing resume self-heals to fresh', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps, paneCommands } = fakeWorld(
      { exitCode: '1', exitDelayMs: 100, exitFile: join(d, '.exit-status') }); // dies ~0.2s < 20s
    await runOnce('A', {}, deps);
    expect(paneCommands[0]).toContain('--resume');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
    expect(existsSync(join(d, '.booted'))).toBe(false);
  });

  it('slow crash keeps resume state', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');
    // 30 liveness checks × 2000ms simulated = 60s > fastFailSecs
    const { deps } = fakeWorld({ exitCode: '137', lifeChecks: 30, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).toBe('KEEP');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });
});

describe('runTemp', () => {
  it('runs from the tmp snapshot and removes the dir afterwards', async () => {
    const d = agentDir('T', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'),
      stringify({ name: 'T', harness: 'fake', identity: 'T', sourceFile: 'tmp' }));
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runTemp('T', deps);
    expect(existsSync(d)).toBe(false);
  });
});
