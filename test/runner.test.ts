import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import {
  runOnce, runTemp, runSupervised, buildPaneCommand, reserveLaunchSlot, readExitRecord,
  readRestartLedger, resetRestartLedger, backoffFor, loadTempRole, RESTART_FAIL_THRESHOLD,
  TEMP_IDENTITY_CLOSE_DEBOUNCE_MS, TEMP_IDENTITY_STARTUP_GRACE_MS,
  type AttemptResult, type RunnerDeps,
} from '../src/runner.js';
import { classifyChildExit, classifyShellStatus } from '../src/session/types.js';
import { registerAdapter } from '../src/harness/registry.js';
import { agentDir, stateRoot } from '../src/paths.js';
import { Tmux } from '../src/tmux.js';
import { fakeAdapter } from './registry.test.js';
import type { Exec } from '../src/exec.js';
import type { HarnessAdapter } from '../src/harness/types.js';
import type { MonitorOpts } from '../src/monitor.js';
import {
  OwnerBinderConflictError, OwnerBinderHandoffTimeoutError,
} from '../src/owner-channel/binder.js';

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

/** Records the monitor lifecycle the runner drives, and proves prime happens
 *  before the tmux session is created. */
function monitorRecorder(sessionCreated: () => boolean) {
  const rec = {
    constructed: 0,
    primedBeforeSession: null as boolean | null,
    resetCursor: null as boolean | null,
    ranPid: null as number | null,
    stopped: false,
    env: null as NodeJS.ProcessEnv | null,
  };
  const createMonitor = (opts: MonitorOpts) => {
    rec.constructed++;
    rec.env = opts.deps.env;
    return {
      prime: async options => {
        rec.primedBeforeSession = !sessionCreated();
        rec.resetCursor = options?.resetCursor ?? false;
      },
      run: async (pid: number) => { rec.ranPid = pid; },
      stop: () => { rec.stopped = true; },
    };
  };
  return { rec, createMonitor };
}

/** Fake tmux whose pane "process" dies after `lifeChecks` liveness polls,
 *  writing `.exit-status` (like the pane shell would) at the moment of death. */
function fakeWorld(opts: { exitCode?: string; lifeChecks?: number; exitDelayMs?: number; exitFile?: string; bwrap?: 'ok' | 'missing'; cpuDelegated?: boolean; legacyExitFile?: boolean; sessionGone?: boolean } = {}) {
  const paneCommands: string[] = [];
  let clock = 0;
  let checks = 0;
  let sessionCreated = false;
  let sessionKilled = false;
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'bwrap') return { stdout: 'bubblewrap 0.11.1\n', stderr: '', code: opts.bwrap === 'missing' ? 127 : 0 };
    if (cmd === 'tmux') {
      // Faithful to #32: a real tmux invoked without `-L` talks to the SHARED
      // default server, which is a different server from this role's. A fake
      // that answered anyway would let the socket flag be dropped unnoticed.
      if (args[0] !== '-L' || !args[1].startsWith('ours-fleet-'))
        return { stdout: '', stderr: 'no server running on the default socket', code: 1 };
      const sub = args[2];
      if (sub === 'new-session') {
        paneCommands.push(args[args.length - 1]); sessionCreated = true; sessionKilled = false;
      }
      if (sub === 'kill-session' && sessionCreated) sessionKilled = true;
      if (sub === 'list-panes') return { stdout: '4242\n', stderr: '', code: 0 };
      if (sub === 'has-session')
        return { stdout: '', stderr: '', code: opts.sessionGone || sessionKilled ? 1 : 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const { rec, createMonitor } = monitorRecorder(() => sessionCreated);
  const deps = {
    tmux: new Tmux(exec),
    exec,
    cpuDelegated: () => opts.cpuDelegated ?? true,
    isAlive: () => {
      if (sessionKilled) return false;
      checks++;
      if (checks >= (opts.lifeChecks ?? 2)) {
        if (opts.exitFile) writeFileSync(opts.exitFile, opts.legacyExitFile
          ? (opts.exitCode ?? '0') + '\n'                       // pre-upgrade `echo $?`
          : JSON.stringify({ version: 1, backend: 'tmux', status: Number(opts.exitCode ?? '0') }));
        return false;
      }
      return true;
    },
    sleep: async (ms: number) => { clock += opts.exitDelayMs ?? ms; },
    now: () => clock,
    log: () => {},
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ cursor: 0, events: [] }) }),
    createMonitor,
  };
  return { deps, paneCommands, monitor: rec };
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
    expect(cmd).toContain(`__ofs=$?`);
    expect(cmd).toContain(`> '/tmp/es'`);
  });

  it('runs a sandbox-wrapped argv while keeping env + exit capture host-side', () => {
    const cmd = buildPaneCommand(
      { argv: ['claude', 'go'], env: { A: 'x' } }, { B: 'z' }, '/tmp/es',
      ['bwrap', '--die-with-parent', '--', 'claude', 'go']);
    expect(cmd.startsWith('env ')).toBe(true);         // env prefix host-side
    expect(cmd).toContain(`A='x'`);
    expect(cmd).toContain(`'bwrap' '--die-with-parent' '--' 'claude' 'go'`);
    expect(cmd).toContain(`> '/tmp/es'`);                              // exit capture host-side
    expect(cmd.indexOf('bwrap')).toBeLessThan(cmd.indexOf('__ofs=$?')); // capture is outside
  });

  it('unsets inherited NO_COLOR, defaults truecolor, and honors explicit role overrides', () => {
    const exitFile = join(dir, 'pane-exit');
    const probe = ['sh', '-c', 'printf "%s|%s" "${NO_COLOR-unset}" "$COLORTERM"'];
    const inherited = buildPaneCommand({ argv: probe, env: {} }, undefined, exitFile);
    expect(inherited).toContain('env -u NO_COLOR ');
    expect(inherited).toContain("COLORTERM='truecolor'");
    expect(execFileSync('sh', ['-c', inherited], {
      env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8',
    })).toBe('unset|truecolor');

    const explicit = buildPaneCommand(
      { argv: probe, env: {} }, { NO_COLOR: '1', COLORTERM: 'legacy' }, exitFile,
    );
    expect(explicit).not.toContain('-u NO_COLOR');
    expect(execFileSync('sh', ['-c', explicit], {
      env: { ...process.env, NO_COLOR: 'parent' }, encoding: 'utf8',
    })).toBe('1|legacy');
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
    expect(paneCommands[0]).toContain('__ofs=$?');           // exit capture preserved
  });

  it('resolves and read-only binds a home-scoped tmux launcher', async () => {
    const binDir = join(dir, '.local', 'bin');
    const launcher = join(binDir, 'home-launcher');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    registerAdapter({
      ...fakeAdapter,
      id: 'home-runtime',
      buildLaunch: (_role, _mode, _state, prep) => ({ argv: ['home-launcher'], env: prep.env }),
    });
    writeCfg({ A: { harness: 'home-runtime', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try { await runOnce('A', {}, deps); }
    finally { process.env.PATH = oldPath; }
    expect(paneCommands[0]).toContain(`'--ro-bind-try' '${launcher}' '${launcher}'`);
    expect(paneCommands[0]).toMatch(new RegExp(`'--'.*'${launcher}'`));
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

  it('writes a .isolation-degraded marker when isolation degrades under warn', async () => {
    writeCfg({ A: { harness: 'fake', isolation: { on_unavailable: 'warn' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status'), bwrap: 'missing' });
    await runOnce('A', {}, deps);
    const marker = join(d, '.isolation-degraded');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toMatch(/bubblewrap|bwrap|unavailable/i);
  });

  it('clears a stale .isolation-degraded marker when isolation succeeds', async () => {
    writeCfg({ A: { harness: 'fake', isolation: {} } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.isolation-degraded'), 'stale\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(existsSync(join(d, '.isolation-degraded'))).toBe(false);
  });
});

describe('runOnce', () => {
  it('upgrades legacy temp snapshots to explicit monitor ownership', () => {
    const d = agentDir('OldTemp', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name: 'OldTemp',
      harness: 'fake',
      session: 'tmux',
      identity: 'OldTemp',
      sourceFile: '(temp)',
      monitor: {
        enabled: true,
        wake_sources: ['message_received'],
        batch_ms: 2000,
        inject: 'notification',
      },
    }));

    expect(loadTempRole('OldTemp').monitor)
      .toMatchObject({ mode: 'fleet', enabled: true, interrupt: false });
  });

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

describe('creation-time isolation reaches the FIRST launch (6.3)', () => {
  it("a role whose config carries `isolation` is sandbox-wrapped on its first start", async () => {
    // This is the property --isolation-file exists for: the very first process
    // is confined, not the one after the operator edits fleet.yaml.
    writeCfg({ Sec: { harness: 'fake', isolation: { network: 'deny' } } });
    const d = agentDir('Sec');
    mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('Sec', {}, deps);
    expect(paneCommands[0]).toContain(`'bwrap'`);
    expect(paneCommands[0]).toContain(`'--unshare-net'`);      // network: deny honoured
    expect(paneCommands[0]).toMatch(/'--'.*'fakebin'/);
  });
});

describe('exit classification (1.6)', () => {
  const readRecord = (d: string) =>
    JSON.parse(readFileSync(join(d, '.exit-status'), 'utf8')) as { class: string; detail: string };

  it('classifies a shell wait status into clean, program-exit, or signal', () => {
    expect(classifyShellStatus(0)).toMatchObject({ class: 'clean', code: 0 });
    expect(classifyShellStatus(1)).toMatchObject({ class: 'program-exit', code: 1 });
    expect(classifyShellStatus(127)).toMatchObject({ class: 'program-exit', code: 127 });
    expect(classifyShellStatus(137)).toMatchObject({ class: 'signal', signal: 'SIG9' });
    expect(classifyShellStatus(143)).toMatchObject({ class: 'signal', signal: 'SIG15' });
  });

  it('classifies a child exit reported by node, keeping the real signal name', () => {
    expect(classifyChildExit(0, null)).toMatchObject({ class: 'clean', code: 0 });
    expect(classifyChildExit(3, null)).toMatchObject({ class: 'program-exit', code: 3 });
    expect(classifyChildExit(null, 'SIGKILL')).toMatchObject({ class: 'signal', signal: 'SIGKILL' });
    expect(classifyChildExit(null, null)).toMatchObject({ class: 'unknown' });
  });

  it('never calls an absent or unreadable record a crash', () => {
    const p = join(dir, 'nothing-here');
    expect(readExitRecord(p)).toBeNull();
    writeFileSync(p, '');
    expect(readExitRecord(p)).toMatchObject({ class: 'unknown' });
    writeFileSync(p, 'garbage not json');
    expect(readExitRecord(p)).toMatchObject({ class: 'unknown' });
    expect(JSON.stringify(readExitRecord(p))).not.toContain('crash');
  });

  it('still reads a bare number left by a pre-upgrade pane', () => {
    const p = join(dir, 'legacy');
    writeFileSync(p, '0\n');
    expect(readExitRecord(p)).toMatchObject({ class: 'clean', code: 0 });
    writeFileSync(p, '137\n');
    expect(readExitRecord(p)).toMatchObject({ class: 'signal', signal: 'SIG9' });
  });

  /** label, shell status, resulting class, does the next start resume? */
  const TMUX_CASES: Array<[string, string, string, boolean]> = [
    ['a clean exit', '0', 'clean', false],
    ['a non-zero program exit', '1', 'program-exit', true],
    ['a signal', '137', 'signal', true],
  ];

  for (const [label, status, cls, resumes] of TMUX_CASES) {
    it(`records ${label} and ${resumes ? 'resumes' : 'starts fresh'} next time`, async () => {
      writeCfg({ A: { harness: 'fake' } });
      const d = agentDir('A'); mkdirSync(d, { recursive: true });
      writeFileSync(join(d, '.session-id'), 'OLD\n');
      writeFileSync(join(d, '.booted'), '');
      // 30 liveness checks × 2000ms simulated keeps it out of the fast-fail window
      const { deps } = fakeWorld({ exitCode: status, lifeChecks: 30, exitFile: join(d, '.exit-status') });
      await runOnce('A', {}, deps);
      expect(readRecord(d).class).toBe(cls);
      expect(existsSync(join(d, '.booted'))).toBe(resumes);
    });
  }

  it('a missing record with the session still alive is unknown, and keeps context', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({ lifeChecks: 30 });          // no exitFile ⇒ nothing written
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('unknown');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('a destroyed session is its own class, not a program exit', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({ lifeChecks: 30, sessionGone: true });
    await runOnce('A', {}, deps);
    const record = readRecord(d);
    expect(record.class).toBe('session-destroyed');
    expect(record.detail).toContain('no longer exists');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('a session destroyed early is NOT treated as a fast-failing resume', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'KEEP\n');
    writeFileSync(join(d, '.booted'), '');                   // resume mode
    // dies after ~0.2s simulated — well inside fastFailSecs (20)
    const { deps } = fakeWorld({ exitDelayMs: 100, sessionGone: true });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('session-destroyed');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).toBe('KEEP');
    expect(existsSync(join(d, '.booted'))).toBe(true);
  });

  it('a program that exits fast during resume still self-heals to fresh', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    writeFileSync(join(d, '.booted'), '');
    const { deps } = fakeWorld({ exitCode: '1', exitDelayMs: 100, exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('program-exit');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
  });

  it('a legacy bare-number record drives the same decision', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.session-id'), 'OLD\n');
    const { deps } = fakeWorld({
      exitCode: '0', legacyExitFile: true, exitFile: join(d, '.exit-status'),
    });
    await runOnce('A', {}, deps);
    expect(readRecord(d).class).toBe('clean');
    expect(readFileSync(join(d, '.session-id'), 'utf8').trim()).not.toBe('OLD');
  });
});

describe('runOnce ACP startup outcome (1.2)', () => {
  const acpFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');

  /** The fake adapter, taught to launch the ACP fixture as its agent process. */
  const acpAdapter: HarnessAdapter = {
    ...fakeAdapter,
    id: 'fake-acp',
    buildAcpLaunch: () => ({ argv: [process.execPath, acpFixture], env: {} }),
    effectivePermissionMode: role => ({
      fleetMode: role.permissions.approval === 'allow' ? 'allow'
        : role.permissions.approval === 'auto' ? 'auto' : 'ask',
      nativeMode: role.permissions.approval === 'allow' ? 'fixture-allow' : 'fixture-ask',
    }),
  };

  /** Real-clock deps: an ACP session is a real child process, not a fake pane. */
  function acpDeps() {
    const logs: string[] = [];
    const exec: Exec = async () => ({ stdout: '', stderr: '', code: 0 });
    return {
      logs,
      deps: {
        tmux: new Tmux(exec), exec,
        cpuDelegated: () => true,
        isAlive: () => true,
        sleep: (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 25))),
        now: () => Date.now(),
        log: (l: string) => { logs.push(l); },
        fetch: async () => ({ status: 200, ok: true, json: async () => ({ cursor: 0, events: [] }) }),
        createMonitor: () => ({ prime: async () => {}, run: async () => {}, stop: () => {} }),
      },
    };
  }

  beforeEach(() => { registerAdapter(acpAdapter); });

  it('a refused startup prompt fails the role instead of logging it up', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      env: { ACP_FIXTURE_STOP_REASON: 'refusal' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/startup prompt refused/);
    expect(logs.some(l => l.includes('[A] up;'))).toBe(false);
  });

  it('a cancelled startup prompt fails the role too', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      env: { ACP_FIXTURE_STOP_REASON: 'cancelled' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/startup prompt cancelled/);
    expect(logs.some(l => l.includes('[A] up;'))).toBe(false);
  });

  it('delivers the adapter-computed permission mode to the ACP session', async () => {
    registerAdapter({ ...acpAdapter, id: 'fake-acp-mode', acpPermissionModeId: () => 'acceptEdits' });
    writeCfg({ A: {
      harness: 'fake-acp-mode', session: 'acp',
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();

    await runOnce('A', {}, deps);
    const events = readFileSync(join(agentDir('A'), '.session-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { kind: string; text?: string });
    expect(events.some(e => e.kind === 'agent_text' && e.text === 'mode:acceptEdits')).toBe(true);
  });

  it('warns once at startup that an unattended role auto-denies (1.3)', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);
    const warnings = logs.filter(l => l.includes('permission policy: unattended=deny'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('reject_once');
  });

  it('says nothing about auto-denial when the role waits instead (1.3)', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);
    expect(logs.some(l => l.includes('permission policy'))).toBe(false);
  });

  it('records the ACP child\'s real exit, per class (1.6)', async () => {
    for (const [code, cls, fresh] of [['0', 'clean', true], ['4', 'program-exit', false]] as const) {
      writeCfg({ A: {
        harness: 'fake-acp', session: 'acp',
        env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_EXIT_CODE: code },
      } });
      const d = agentDir('A');
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, '.session-id'), 'OLD\n');
      const { deps } = acpDeps();

      await runOnce('A', {}, deps);
      const record = JSON.parse(readFileSync(join(d, '.exit-status'), 'utf8'));
      expect(record.class, `exit code ${code}`).toBe(cls);
      if (cls === 'program-exit') expect(record.code).toBe(4);
      // A clean exit rotates under this adapter's policy; a program exit does not.
      expect(readFileSync(join(d, '.session-id'), 'utf8').trim() !== 'OLD').toBe(fresh);
    }
  }, 20_000);

  it('a floor-compliant role starts with ZERO permission prompts (2.1)', async () => {
    // The startup prompt makes the agent request a tool permission. A role whose
    // resolved permissions clear the floor must have it granted automatically —
    // nothing pending, nothing denied, and the turn completes.
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_ALWAYS_PERMISSION: '1' },
    } });
    const d = agentDir('A');
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);

    const events = readFileSync(join(d, '.session-events.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l) as { kind: string; status?: string; decision?: string });
    const permissions = events.filter(e => e.kind === 'permission');
    expect(permissions.length).toBeGreaterThan(0);                    // one was requested
    expect(permissions.every(e => e.status === 'completed')).toBe(true);  // none left pending
    expect(permissions.every(e => e.decision === 'allowed')).toBe(true);  // and none denied
    expect(logs.some(l => l.includes('[A] up;'))).toBe(true);
    expect(events.some(e => e.kind === 'turn_stop')).toBe(true);      // the turn finished
  }, 20_000);

  it('a completed startup prompt does log the role up', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },      // agent leaves once startup is answered
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps, logs } = acpDeps();

    await runOnce('A', {}, deps);
    expect(logs.some(l => l.includes('[A] up;') && l.includes('session=acp'))).toBe(true);
  });

  it('starts and stops the owner channel with the live ACP session', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();
    let started = 0;
    let closed = 0;
    deps.createOwnerChannel = options => {
      expect(options.role).toBe('A');
      expect(options.config.identity).toBe('A-owner');
      expect(options.session.backend).toBe('acp');
      return {
        start: async () => { started++; },
        drain: async () => {},
        close: async () => {
          expect(existsSync(join(agentDir('A'), '.control.sock'))).toBe(false);
          closed++;
        },
        manage: async () => { throw new Error('not used'); },
      };
    };

    await runOnce('A', {}, deps);
    expect(started).toBe(1);
    expect(closed).toBe(1);
  });

  it('asks only an owned predecessor control route to report a bounded handoff timeout', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    writeFileSync(join(agentDir('A'), '.control.sock'), 'predecessor-route');
    const { deps, logs } = acpDeps();
    const report = vi.fn(async () => {
      expect(readFileSync(join(agentDir('A'), '.control.sock'), 'utf8')).toBe('predecessor-route');
      return 'delivered' as const;
    });
    deps.reportOwnerStartupFailure = report;
    deps.acquireOwnerBinder = async () => {
      throw new OwnerBinderHandoffTimeoutError('owned overlap');
    };

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/owner channel failed to start.*owned overlap/);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(agentDir('A'));
    expect(logs).toContain('[A] owner channel startup recovery notice delivered by authenticated predecessor');
  });

  it('does not guess a recovery route for a foreign owner-channel bind failure', async () => {
    writeCfg({ A: {
      harness: 'fake-acp', session: 'acp',
      owner_channel: { identity: 'A-owner', owners: ['owner-cid'] },
      env: { ACP_FIXTURE_EXIT_AFTER: '1' },
    } });
    mkdirSync(agentDir('A'), { recursive: true });
    const { deps } = acpDeps();
    const report = vi.fn(async () => 'delivered' as const);
    deps.reportOwnerStartupFailure = report;
    deps.acquireOwnerBinder = async () => {
      throw new OwnerBinderConflictError('identity is held by a foreign live session');
    };

    await expect(runOnce('A', {}, deps)).rejects.toThrow(/foreign live session/);
    expect(report).not.toHaveBeenCalled();
  });

  it('starts scheduled loops only after ACP startup and stops them before teardown', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), stringify({
      roles: { A: {
        harness: 'fake-acp', session: 'acp',
        env: { ACP_FIXTURE_EXIT_AFTER: '2' },
      } },
      loops: { health: {
        roles: ['A'], interval: '1m', initial_delay: '0s', prompt: 'bounded health pass',
      } },
    }), { mode: 0o600 });
    const stateDir = agentDir('A');
    mkdirSync(stateDir, { recursive: true });
    const { deps, logs } = acpDeps();
    await runOnce('A', {}, deps);
    const state = JSON.parse(readFileSync(join(stateDir, '.scheduled-loops.json'), 'utf8'));
    expect(state.loops.health.counts).toMatchObject({ started: 1, completed: 1 });
    expect(state.loops.health.activeRunId).toBeNull();
    expect(logs.some(line => line.includes('loop health started'))).toBe(true);
    expect(JSON.stringify(state)).not.toContain('bounded health pass');
  }, 20_000);

  it('steers an interrupting wake during ACP startup instead of cancelling startup', async () => {
    writeCfg({ A: {
      harness: 'fake-acp',
      session: 'acp',
      monitor: { mode: 'fleet', interrupt: true },
      env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_PROMPT_DELAY_MS: '100' },
    } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps } = acpDeps();
    let startupWasActive = false;
    let wakeOutcome: string | undefined;
    deps.createMonitor = opts => ({
      prime: async () => {},
      run: async () => {
        const before = readFileSync(join(d, '.session-events.jsonl'), 'utf8');
        startupWasActive = !before.includes('"kind":"turn_stop"');
        const result = await opts.deps.delivery!.submit('wake during startup', { interrupt: true });
        wakeOutcome = result.outcome;
      },
      stop: () => {},
    });

    await runOnce('A', {}, deps);
    expect(startupWasActive).toBe(true);
    expect(['injected', 'startedNewTurn']).toContain(wakeOutcome);
    const events = readFileSync(join(d, '.session-events.jsonl'), 'utf8');
    expect(events).not.toContain('"stopReason":"cancelled"');
    expect(events).toContain('"kind":"turn_stop"');
  });

  it('steers after_tool directly during ACP startup without waiting or cancelling', async () => {
    writeCfg({ A: {
      harness: 'fake-acp',
      session: 'acp',
      monitor: { mode: 'fleet', interrupt: 'after_tool' },
      env: { ACP_FIXTURE_EXIT_AFTER: '1', ACP_FIXTURE_PROMPT_DELAY_MS: '100' },
    } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps } = acpDeps();
    let wakeOutcome: string | undefined;
    deps.createMonitor = opts => ({
      prime: async () => {},
      run: async () => {
        const result = await opts.deps.delivery!.submit(
          'after_tool wake during startup', { interrupt: 'after_tool' });
        wakeOutcome = result.outcome;
      },
      stop: () => {},
    });

    await runOnce('A', {}, deps);
    expect(['injected', 'startedNewTurn']).toContain(wakeOutcome);
    const events = readFileSync(join(d, '.session-events.jsonl'), 'utf8');
    expect(events).not.toContain('"kind":"monitor_delivery"');
    expect(events).not.toContain('"cancellationSource":"fleet-monitor"');
    expect(events).not.toContain('"stopReason":"cancelled"');
  });
});

describe('runOnce monitor integration', () => {
  it('primes the monitor before creating the session and stops it after pid death', async () => {
    writeCfg({ A: { harness: 'fake' } });   // monitor.mode defaults to fleet
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(monitor.constructed).toBe(1);
    expect(monitor.primedBeforeSession).toBe(true);   // cursor primed before tmux.newSession
    expect(monitor.ranPid).toBe(4242);
    expect(monitor.stopped).toBe(true);               // stopped when the pane pid died
  });

  it('does not construct a fleet monitor when monitor.mode is native', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(monitor.constructed).toBe(0);
  });

  it('re-primes at tip when wake ownership moves from native back to fleet', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    await runOnce('A', {}, fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') }).deps);

    writeCfg({ A: { harness: 'fake', monitor: { mode: 'fleet' } } });
    const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(monitor.resetCursor).toBe(true);
  });

  it('does not request a cursor reset across fleet-to-fleet restarts', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'fleet' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });

    const first = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, first.deps);
    expect(first.monitor.resetCursor).toBe(false);

    const second = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, second.deps);
    expect(second.monitor.resetCursor).toBe(false);
  });

  it('passes service env plus role daemon-profile overrides to the monitor', async () => {
    const savedPort = process.env.OURS_PORT;
    const savedToken = process.env.OURS_API_TOKEN;
    process.env.OURS_PORT = '3001';
    process.env.OURS_API_TOKEN = 'service-token';
    try {
      writeCfg({
        A: {
          harness: 'fake',
          env: {
            OURS_PORT: '4555',
            OURS_API_TOKEN: 'role-token',
            OURS_CONFIG: '/role/ours.json',
            OURS_STATE_DIR: '/role/state',
          },
        },
      });
      const d = agentDir('A'); mkdirSync(d, { recursive: true });
      const { deps, monitor } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
      await runOnce('A', {}, deps);
      expect(monitor.env?.OURS_PORT).toBe('4555');
      expect(monitor.env?.OURS_API_TOKEN).toBe('role-token');
      expect(monitor.env?.OURS_CONFIG).toBe('/role/ours.json');
      expect(monitor.env?.OURS_STATE_DIR).toBe('/role/state');
      expect(monitor.env?.PATH).toBe(process.env.PATH); // inherited service env remains present
    } finally {
      if (savedPort === undefined) delete process.env.OURS_PORT;
      else process.env.OURS_PORT = savedPort;
      if (savedToken === undefined) delete process.env.OURS_API_TOKEN;
      else process.env.OURS_API_TOKEN = savedToken;
    }
  });
});

describe('temporary identity retirement', () => {
  const writeTemp = (name: string) => {
    const d = agentDir(name, true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name, harness: 'fake', session: 'tmux', identity: name,
      monitor: { mode: 'native' }, sourceFile: '(temp)',
    }));
    return d;
  };

  it('closes a live temp session only after a sustained absence of its observed identity', async () => {
    const d = writeTemp('T');
    const world = fakeWorld({ lifeChecks: 100, exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async url => {
      expect(url).toContain('/identities');
      const identities = probes++ === 0 ? [{ name: 'T', temporary: true }] : [];
      return { status: 200, ok: true, json: async () => ({ identities }) };
    };

    const result = await runOnce('T', { temp: true }, world.deps);

    expect(result.retirementReason).toBe('identity-closed');
    expect(result.elapsedSecs).toBeGreaterThanOrEqual(TEMP_IDENTITY_CLOSE_DEBOUNCE_MS / 1000);
    expect(probes).toBeGreaterThan(2);
    expect(world.paneCommands).toHaveLength(1);
  });

  it('allows a slow first bind before settling an identity absent from the first poll', async () => {
    const d = writeTemp('T');
    const world = fakeWorld({ lifeChecks: 100, exitCode: '0', exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async () => ({
      status: 200, ok: true, json: async () => { probes++; return { identities: [] }; },
    });

    const result = await runOnce('T', { temp: true }, world.deps);

    expect(result.retirementReason).toBe('identity-closed');
    expect(result.elapsedSecs).toBeGreaterThanOrEqual(TEMP_IDENTITY_STARTUP_GRACE_MS / 1000);
    expect(probes).toBeGreaterThan(2);
    expect(world.paneCommands).toHaveLength(1);
  });

  it('never probes or changes a permanent role lifecycle', async () => {
    writeCfg({ A: { harness: 'fake', monitor: { mode: 'native' } } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const world = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    let probes = 0;
    world.deps.fetch = async () => {
      probes++;
      return { status: 200, ok: true, json: async () => ({ identities: [] }) };
    };

    await runOnce('A', {}, world.deps);

    expect(probes).toBe(0);
  });
});

describe('reserveLaunchSlot (start gate)', () => {
  const gateDeps = (clock: { t: number }) => ({
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
    log: () => {},
  });

  it('returns now for a lone start and records the timestamp', async () => {
    const clock = { t: 1000 };
    const t = await reserveLaunchSlot(dir, 5000, gateDeps(clock));
    expect(t).toBe(1000);                                   // zero wait for a lone launch
    expect(readFileSync(join(dir, '.last-launch'), 'utf8').trim()).toBe('1000');
  });

  it('spaces successive launches by staggerMs (concurrent boot burst)', async () => {
    const clock = { t: 1000 };                              // clock held: all "arrive" together
    const deps = gateDeps(clock);
    const t1 = await reserveLaunchSlot(dir, 5000, deps);
    const t2 = await reserveLaunchSlot(dir, 5000, deps);
    const t3 = await reserveLaunchSlot(dir, 5000, deps);
    expect([t1, t2, t3]).toEqual([1000, 6000, 11000]);      // spread out by 5000ms each
  });

  it('does not delay a lone start that follows a long idle gap', async () => {
    writeFileSync(join(dir, '.last-launch'), '500');        // ancient prior launch
    const clock = { t: 100000 };
    const t = await reserveLaunchSlot(dir, 5000, gateDeps(clock));
    expect(t).toBe(100000);                                 // max(now, 500+5000) = now
  });

  it('breaks a stale lock left by a crashed launcher instead of deadlocking', async () => {
    mkdirSync(join(dir, '.launch-gate.lock'), { recursive: true });
    writeFileSync(join(dir, '.launch-gate.lock', 'ts'), '0');  // lock stamped far in the past
    const clock = { t: 100000 };                               // now ≫ staleMs ⇒ steal it
    const t = await reserveLaunchSlot(dir, 1000, gateDeps(clock));
    expect(t).toBe(100000);
    expect(existsSync(join(dir, '.launch-gate.lock'))).toBe(false);  // released
  });
});

describe('runOnce start-stagger', () => {
  it('runs the launch through the gate when start_stagger_ms is set (lone = no real wait)', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), stringify({ start_stagger_ms: 5000, roles: { A: { harness: 'fake' } } }));
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps, paneCommands } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(paneCommands).toHaveLength(1);                                  // launched
    expect(existsSync(join(stateRoot(), '.last-launch'))).toBe(true);      // gate engaged
  });

  it('touches no launch gate when start_stagger_ms is unset (default behavior)', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A'); mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runOnce('A', {}, deps);
    expect(existsSync(join(stateRoot(), '.last-launch'))).toBe(false);
  });
});

describe('runOnce config-path fallback', () => {
  it('falls back to the .config-path marker when no -c is given (systemd restart path)', async () => {
    // Default ~/fleet.yaml has no role A at all — only the custom file does.
    writeCfg({});
    const customCfg = join(dir, 'custom.yaml');
    writeFileSync(customCfg, stringify({ roles: { A: { harness: 'fake' } } }));
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.config-path'), customCfg + '\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    // No opts.configPath passed — this is exactly what systemd's `_run A` does.
    await expect(runOnce('A', {}, deps)).resolves.not.toThrow();
  });

  it('an explicit configPath still wins over the marker', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const staleCfg = join(dir, 'stale.yaml');
    writeFileSync(staleCfg, stringify({ roles: {} }));   // no A here
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.config-path'), staleCfg + '\n');
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await expect(runOnce('A', { configPath: join(dir, 'fleet.yaml') }, deps)).resolves.not.toThrow();
  });

  it('no marker + no explicit path falls back to the default config, unchanged', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await expect(runOnce('A', {}, deps)).resolves.not.toThrow();
  });
});

describe('runTemp', () => {
  it('runs from the tmp snapshot and archives evidence outside the live roster afterwards', async () => {
    const d = agentDir('T', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'),
      stringify({ name: 'T', harness: 'fake', identity: 'T', sourceFile: 'tmp' }));
    const { deps } = fakeWorld({ exitCode: '0', exitFile: join(d, '.exit-status') });
    await runTemp('T', deps);
    expect(existsSync(d)).toBe(false);
    const archiveRoot = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(archiveRoot).find(name => name.includes('-T-'))!;
    expect(readFileSync(join(archiveRoot, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"session-ended"');
    expect(readFileSync(join(archiveRoot, 'terminations.jsonl'), 'utf8'))
      .toContain('"role":"T"');
  });

  it('settles the supervisor and archives an explicit closed-identity retirement', async () => {
    const d = agentDir('Closed', true);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'role.yaml'), stringify({
      name: 'Closed', harness: 'fake', identity: 'Closed', monitor: { mode: 'native' },
      sourceFile: 'tmp',
    }));
    const { deps } = fakeWorld({ lifeChecks: 100, exitFile: join(d, '.exit-status') });
    deps.fetch = async () => ({
      status: 200, ok: true, json: async () => ({ identities: [] }),
    });

    await runTemp('Closed', deps);

    expect(existsSync(d)).toBe(false);
    const archiveRoot = join(stateRoot(), 'recovery', 'temporary');
    const archived = readdirSync(archiveRoot).find(name => name.includes('-Closed-'))!;
    expect(readFileSync(join(archiveRoot, archived, 'termination.jsonl'), 'utf8'))
      .toContain('"reason":"identity-closed"');
  });
});

describe('restart-loop containment (3.2)', () => {
  /** A fake clock and a fake child, so the policy is tested, not the sessions. */
  function supervisorWorld(stateDir: string, opts: {
    /** Seconds each attempt "lasts", by attempt index. Last value repeats. */
    durations?: number[];
    /** Attempts after which the loop stops (default: 20, a runaway guard). */
    stopAfter?: number;
    /** Attempt indices whose session rotated its resume state. */
    rotatesAt?: number[];
    throwAt?: number[];
  } = {}) {
    const durations = opts.durations ?? [0];
    const sleeps: number[] = [];
    const attempts: Array<{ allowResumeRotation?: boolean }> = [];
    const logs: string[] = [];
    let clock = 0;
    const deps: Partial<RunnerDeps> = {
      sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
      log: (l: string) => { logs.push(l); },
      // Stop once the breaker has opened: the real loop then holds down forever
      // on purpose, which against a fake clock is an infinite spin.
      shouldStop: () => attempts.length >= (opts.stopAfter ?? 20)
        || readRestartLedger(stateDir).circuit === 'open',
    };
    const attempt = async (
      _n: string, o: { allowResumeRotation?: boolean },
    ): Promise<AttemptResult> => {
      const i = attempts.length;
      attempts.push({ allowResumeRotation: o.allowResumeRotation });
      if (opts.throwAt?.includes(i)) throw new Error('could not start the session');
      const secs = durations[Math.min(i, durations.length - 1)];
      clock += secs * 1000;
      return {
        elapsedSecs: secs,
        exit: { version: 1, class: 'program-exit', code: 1, detail: 'exited with code 1' },
        rotated: opts.rotatesAt?.includes(i) ?? false,
        mode: 'resume',
      };
    };
    return { deps, attempt, sleeps, attempts, logs };
  }

  const setup = () => {
    writeCfg({ A: { harness: 'fake' } });
    const d = agentDir('A');
    mkdirSync(d, { recursive: true });
    return d;
  };

  it('grows the delay exponentially, bounded', () => {
    expect(backoffFor(0)).toBe(0);
    expect(backoffFor(1)).toBe(2_000);
    expect(backoffFor(2)).toBe(4_000);
    expect(backoffFor(3)).toBe(8_000);
    expect(backoffFor(4)).toBe(16_000);
    expect(backoffFor(5)).toBe(32_000);
    expect(backoffFor(99)).toBe(60_000);          // bounded
  });

  it('an immediate-exit program reaches exactly N attempts, then holds down', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1] });
    const ledger = await runSupervised('A', {}, w.deps, w.attempt);

    expect(w.attempts).toHaveLength(RESTART_FAIL_THRESHOLD);   // exactly N child attempts
    expect(ledger.circuit).toBe('open');
    expect(ledger.consecutiveImmediateFailures).toBe(RESTART_FAIL_THRESHOLD);
    expect(ledger.lastReason).toContain('exited with code 1');
    expect(Number.isNaN(Date.parse(ledger.openedAt!))).toBe(false);   // dated reason
    // Backoff was applied between attempts, growing, and never after the open.
    expect(w.sleeps).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(w.logs.some(l => l.includes('HELD DOWN'))).toBe(true);
  });

  it('stays held down without starting another child', async () => {
    const d = setup();
    const boot = supervisorWorld(d, { durations: [0.1] });
    await runSupervised('A', {}, boot.deps, boot.attempt);
    expect(readRestartLedger(d).circuit).toBe('open');

    // A fresh runner process (e.g. the host rebooted) must honour the ledger.
    const w = supervisorWorld(d, { stopAfter: 1 });
    let polls = 0;
    w.deps.shouldStop = () => ++polls > 3;
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(w.attempts).toHaveLength(0);            // no child was started at all
  });

  it('the ledger survives a runner restart and keeps counting', async () => {
    const d = setup();
    // Two separate runner "processes", two attempts each.
    for (let i = 0; i < 2; i++) {
      const w = supervisorWorld(d, { durations: [0.1], stopAfter: 2 });
      await runSupervised('A', {}, w.deps, w.attempt);
    }
    expect(readRestartLedger(d).consecutiveImmediateFailures).toBe(4);
    expect(readRestartLedger(d).circuit).toBe('closed');       // one short of N

    const w = supervisorWorld(d, { durations: [0.1], stopAfter: 1 });
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(readRestartLedger(d).circuit).toBe('open');         // the 5th opens it
  });

  it('an explicit reset closes the circuit and releases a held-down runner', async () => {
    const d = setup();
    const first = supervisorWorld(d, { durations: [0.1] });
    await runSupervised('A', {}, first.deps, first.attempt);
    expect(readRestartLedger(d).circuit).toBe('open');

    resetRestartLedger(d);
    expect(readRestartLedger(d).circuit).toBe('closed');
    expect(readRestartLedger(d).consecutiveImmediateFailures).toBe(0);

    const w = supervisorWorld(d, { durations: [0.1], stopAfter: 1 });
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(w.attempts).toHaveLength(1);            // it starts children again
  });

  it('a session that runs for a while clears the streak', async () => {
    const d = setup();
    // Four instant failures, then one long session, then instant failures again.
    const w = supervisorWorld(d, { durations: [0.1, 0.1, 0.1, 0.1, 999, 0.1], stopAfter: 7 });
    await runSupervised('A', {}, w.deps, w.attempt);
    // Without the reset, 7 instant failures would have opened the circuit.
    expect(readRestartLedger(d).circuit).toBe('closed');
    expect(readRestartLedger(d).consecutiveImmediateFailures).toBe(2);
  });

  it('discards resume state at most once in a failure sequence', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1], rotatesAt: [0] });
    await runSupervised('A', {}, w.deps, w.attempt);
    // The first attempt was allowed to rotate; every later one was not.
    expect(w.attempts[0].allowResumeRotation).toBe(true);
    expect(w.attempts.slice(1).every(a => a.allowResumeRotation === false)).toBe(true);
  });

  it('allows rotation again once the streak is broken', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1, 999, 0.1], rotatesAt: [0], stopAfter: 3 });
    await runSupervised('A', {}, w.deps, w.attempt);
    expect(w.attempts[0].allowResumeRotation).toBe(true);
    expect(w.attempts[1].allowResumeRotation).toBe(false);   // still inside the streak
    expect(w.attempts[2].allowResumeRotation).toBe(true);    // long session reset it
  });

  it('a session that cannot even start counts as an immediate failure', async () => {
    const d = setup();
    const w = supervisorWorld(d, { durations: [0.1], throwAt: [0, 1, 2, 3, 4] });
    await runSupervised('A', {}, w.deps, w.attempt);
    const ledger = readRestartLedger(d);
    expect(ledger.circuit).toBe('open');
    expect(ledger.lastReason).toContain('could not start the session');
  });

  it('a corrupt ledger starts clean instead of taking the role down', () => {
    const d = setup();
    writeFileSync(join(d, '.restart-ledger.json'), '{not json');
    expect(readRestartLedger(d)).toMatchObject({ circuit: 'closed', consecutiveImmediateFailures: 0 });
  });
});
