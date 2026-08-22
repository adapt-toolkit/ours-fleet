import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { applyRole, up, down, restartRoles, rmRole, type OpsDeps } from '../src/ops.js';
import { loadConfig } from '../src/config.js';
import { agentDir } from '../src/paths.js';
import { readRestartLedger, writeRestartLedger } from '../src/runner.js';
import { registerAdapter } from '../src/harness/registry.js';
import { fakeAdapter } from './registry.test.js';
import { makeSystemdBackend } from '../src/supervisor/systemd.js';
import type { Exec } from '../src/exec.js';
import type { Liveness, SupervisorBackend } from '../src/supervisor/types.js';
import { makeTempSupervisorLauncher, prepareTempSupervisor, tempSystemdUnit } from '../src/temp-lifecycle.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-ops-'));
  process.env.OURS_FLEET_HOME = dir;
  registerAdapter(fakeAdapter);
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

function fakeBackend(live: Liveness = { state: 'stopped', detail: 'inactive (dead)' }) {
  const calls: string[][] = [];
  const backend: SupervisorBackend = {
    id: 'none',
    async init() { return []; },
    async install(n) { calls.push(['install', n]); return { created: true, detail: 'installed' }; },
    async start(n) { calls.push(['start', n]); },
    async stop(n) { calls.push(['stop', n]); },
    async restart(n) { calls.push(['restart', n]); },
    async status(n) { calls.push(['status', n]); return 'inactive'; },
    async liveness(n) { calls.push(['liveness', n]); return live; },
    async uninstall(n) { calls.push(['uninstall', n]); return { removed: true, detail: 'removed' }; },
    logsArgs: n => ({ cmd: 'true', args: [n] }),
  };
  return { calls, backend };
}

/** A systemd backend whose `systemctl show` answers with a canned state pair. */
/**
 * A systemd whose unit reports `activeState (subState)` to the liveness probe
 * `up` makes BEFORE installing, and `active (running)` to any probe after it.
 *
 * That is what a successful `enable --now` actually leaves behind — measured on
 * systemd 255. The distinction matters because `install` now verifies the start
 * rather than trusting systemctl's exit code, which on that version stays 0
 * even when the start failed. A fixture that replayed the pre-install state to
 * the post-install probe would be describing a unit that never started, and
 * would make a correct check look wrong.
 */
function systemdSaying(activeState: string, subState: string) {
  let probes = 0;
  const exec: Exec = async (_cmd, args) => {
    if (!args.includes('show')) return { stdout: '', stderr: '', code: 0 };
    return probes++ === 0
      ? { stdout: `${activeState}\n${subState}\n`, stderr: '', code: 0 }
      : { stdout: 'active\nrunning\n', stderr: '', code: 0 };
  };
  return makeSystemdBackend(exec);
}
function deps(backend: SupervisorBackend, watchdogService?: OpsDeps['watchdogService']) {
  const logs: string[] = [];
  const d: OpsDeps = {
    backend, binPath: '/bin/ours-fleet',
    log: l => logs.push(l),
    identityProvisioner: { exists: async () => true },
    ...(watchdogService ? { watchdogService } : {}),
  };
  return { d, logs };
}

/**
 * `installChanged` simulates WatchdogServiceManager.install()'s own changed-detection
 * (finding #4): defaults to true, matching a first-ever install (no unit file yet).
 * Tests that need to prove the config-fingerprint gate on its own set it false —
 * a real install() would too, since binPath/configPath (the only inputs the real
 * unit content depends on) are unchanged between those calls.
 */
function fakeWatchdogService(opts: { supervised?: boolean; installChanged?: boolean } = {}) {
  const calls: string[] = [];
  const svc: NonNullable<OpsDeps['watchdogService']> = {
    async install(binPath, configPath) {
      calls.push(`install:${binPath}:${configPath ?? ''}`);
      return { changed: opts.installChanged ?? true };
    },
    async start() { calls.push('start'); },
    async stop() { calls.push('stop'); },
    async restart() { calls.push('restart'); },
    supervised: () => opts.supervised ?? true,
  };
  return { calls, svc };
}
const writeCfg = (roles: Record<string, object>) =>
  writeFileSync(join(dir, 'fleet.yaml'), stringify({ roles }));

describe('applyRole', () => {
  it('writes briefing/identity/worklog, preserves session-id on keep', () => {
    writeCfg({ A: { harness: 'fake', identity: 'Ay' } });
    const role = loadConfig().roles[0];
    const d1 = applyRole(role);
    expect(readFileSync(join(d1, '.identity'), 'utf8').trim()).toBe('Ay');
    expect(readFileSync(join(d1, 'briefing.md'), 'utf8')).toContain('Ay');
    const sid = readFileSync(join(d1, '.session-id'), 'utf8');
    applyRole(role);
    expect(readFileSync(join(d1, '.session-id'), 'utf8')).toBe(sid);
  });

  it('references ROUTINES.md in the briefing but never seeds the file', () => {
    writeCfg({ A: { harness: 'fake', identity: 'Ay' } });
    const d1 = applyRole(loadConfig().roles[0]);
    expect(readFileSync(join(d1, 'briefing.md'), 'utf8')).toContain(join(d1, 'ROUTINES.md'));
    expect(existsSync(join(d1, 'ROUTINES.md'))).toBe(false);   // absence is meaningful
  });

  it('fresh clears resume markers', () => {
    writeCfg({ A: { harness: 'fake' } });
    const role = loadConfig().roles[0];
    const d1 = applyRole(role);
    writeFileSync(join(d1, '.booted'), '');
    applyRole(role, { fresh: true });
    expect(existsSync(join(d1, '.booted'))).toBe(false);
    expect(existsSync(join(d1, '.session-id'))).toBe(false);
  });

  it('embeds briefing_file content', () => {
    const bf = join(dir, 'curated.md');
    writeFileSync(bf, 'CURATED BODY');
    writeCfg({ A: { harness: 'fake', briefing_file: bf } });
    const d1 = applyRole(loadConfig().roles[0]);
    expect(readFileSync(join(d1, 'briefing.md'), 'utf8')).toContain('CURATED BODY');
  });

  it('surfaces harness_options validation errors', () => {
    const strict = { ...fakeAdapter, id: 'strict', validateOptions: () => [{ path: 'x', message: 'bad' }] };
    registerAdapter(strict);
    writeCfg({ A: { harness: 'strict', harness_options: { x: 1 } } });
    expect(() => applyRole(loadConfig().roles[0])).toThrowError(/role 'A'.*x: bad/);
  });

  it('records the config path used, empty for the default', () => {
    writeCfg({ A: { harness: 'fake' } });
    const d1 = applyRole(loadConfig().roles[0]);
    expect(readFileSync(join(d1, '.config-path'), 'utf8')).toBe('\n');
  });

  it('records an explicit config path for later reload', () => {
    writeCfg({ A: { harness: 'fake' } });
    const d1 = applyRole(loadConfig().roles[0], { configPath: '/custom/fleet.yaml' });
    expect(readFileSync(join(d1, '.config-path'), 'utf8')).toBe('/custom/fleet.yaml\n');
  });

  it('does not write a .config-path marker for temp roles', () => {
    writeCfg({ A: { harness: 'fake' } });
    const d1 = applyRole(loadConfig().roles[0], { temp: true });
    expect(existsSync(join(d1, '.config-path'))).toBe(false);
  });
});

describe('up / down / restart', () => {
  it('creates permanent role and owner-channel identities before service installation', async () => {
    writeCfg({ A: {
      harness: 'fake', session: 'acp', identity: 'RoleIdentity', bio: 'Role bio',
      persona: 'Role persona',
      owner_channel: { identity: 'RoleOwner', owners: ['owner-cid'] },
    } });
    const present = new Set<string>();
    const created: Array<{ name: string; profile: Record<string, unknown> }> = [];
    const order: string[] = [];
    const { calls, backend } = fakeBackend();
    backend.install = async name => {
      order.push(`install:${name}`);
      calls.push(['install', name]);
      return { created: true, detail: 'installed' };
    };
    const { d } = deps(backend);
    d.identityProvisioner = {
      exists: async name => present.has(name),
      create: async (name, profile) => {
        order.push(`identity:${name}`);
        present.add(name);
        created.push({ name, profile });
      },
    };

    await up(loadConfig(), ['A'], d);

    expect(order).toEqual(['identity:RoleIdentity', 'identity:RoleOwner', 'install:A']);
    expect(created).toEqual([
      { name: 'RoleIdentity', profile: {
        bio: 'Role bio', persona: 'Role persona', exposeLocal: true, localAutoAccept: true,
      } },
      { name: 'RoleOwner', profile: {
        bio: 'Authenticated owner channel for the ours-fleet A role.',
        exposeLocal: false, localAutoAccept: false,
      } },
    ]);
    const briefing = readFileSync(join(agentDir('A'), 'briefing.md'), 'utf8');
    expect(briefing).toContain('It was created when your role');
    expect(briefing).not.toContain('call **create_identity**');
  });

  it('refuses to start when permanent identity reconciliation is unavailable', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { calls, backend } = fakeBackend();
    const { d } = deps(backend);
    d.identityProvisioner = { exists: async () => 'unknown' };

    await expect(up(loadConfig(), ['A'], d)).rejects.toThrow(/could not establish permanent ours identity/);
    expect(calls.some(call => call[0] === 'install')).toBe(false);
  });

  it('installs every role promptly (launch spacing is enforced by the start gate, not here)', async () => {
    writeCfg({ A: { harness: 'fake' }, B: { harness: 'fake' } });
    const { calls, backend } = fakeBackend();
    const { d } = deps(backend);
    await up(loadConfig(), [], d);
    expect(calls.filter(c => c[0] === 'install').map(c => c[1])).toEqual(['A', 'B']);
  });

  it('down stops each named role', async () => {
    writeCfg({ A: { harness: 'fake' }, B: { harness: 'fake' } });
    const { calls, backend } = fakeBackend();
    const { d } = deps(backend);
    await down(loadConfig(), ['B'], d);
    expect(calls).toEqual([['stop', 'B']]);
  });

  it('down reports the backend\'s real stop failure (1.5)', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { backend } = fakeBackend();
    backend.stop = async () => {
      throw new Error('systemctl stop ours-fleet-agent@A.service failed: Job is in progress');
    };
    const { d, logs } = deps(backend);
    await down(loadConfig(), ['A'], d);
    expect(logs.join('\n')).toContain('Job is in progress');
    expect(logs.join('\n')).not.toContain('maybe not running');   // the old guess
  });

  it('down targets an exact state-backed temporary role absent from merged YAML', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const tempDir = agentDir('Temp', true);
    mkdirSync(tempDir, { recursive: true });
    prepareTempSupervisor(tempDir, 'Temp');
    await makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd',
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    })('/bin/ours-fleet', ['_run-temp', 'Temp'], tempDir);
    const { calls, backend } = fakeBackend();
    const commands: string[][] = [];
    const { d, logs } = deps(backend);
    d.exec = async (command, args) => {
      commands.push([command, ...args]);
      return { stdout: '', stderr: '', code: 0 };
    };

    await down(loadConfig(), ['Temp'], d);

    expect(commands).toEqual([['systemctl', '--user', 'stop', tempSystemdUnit('Temp')]]);
    expect(calls).toEqual([]); // no permanent backend was guessed
    expect(logs.join('\n')).toContain('temporary role Temp');
  });

  it('restart fresh clears markers then bounces', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { calls, backend } = fakeBackend();
    const { d } = deps(backend);
    const stateDir = agentDir('A');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.booted'), '');
    await restartRoles(loadConfig(), ['A'], d, 'fresh');
    expect(existsSync(join(stateDir, '.booted'))).toBe(false);
    expect(calls).toContainEqual(['restart', 'A']);
  });

  it('up records the given configPath in each role\'s .config-path marker', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await up(loadConfig(join(dir, 'fleet.yaml')), [], d, join(dir, 'fleet.yaml'));
    expect(readFileSync(join(agentDir('A'), '.config-path'), 'utf8')).toBe(`${join(dir, 'fleet.yaml')}\n`);
  });

  it('restartRoles records the given configPath in the marker too', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await restartRoles(loadConfig(join(dir, 'fleet.yaml')), ['A'], d, 'keep', join(dir, 'fleet.yaml'));
    expect(readFileSync(join(agentDir('A'), '.config-path'), 'utf8')).toBe(`${join(dir, 'fleet.yaml')}\n`);
  });
});

describe('up/down reconcile the supervised watchdog scheduler', () => {
  const withWatchdog = (extra = '') =>
    writeFileSync(join(dir, 'fleet.yaml'), `roles:\n  A: {}\nwatchdogs:\n  w: { coordinator: A${extra} }\n`);

  it('up with an enabled watchdog installs + restarts the scheduler when supervised (final review #4: `start` is a no-op on an already-active unit, so config changes never reach it)', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService();
    const { d, logs } = deps(backend, svc);
    await up(loadConfig(), [], d);
    expect(calls).toEqual(['install:/bin/ours-fleet:', 'restart']);
    expect(logs.join('\n')).toMatch(/↑ watchdogs scheduler.*w/);
  });

  describe('restart is gated on an actual change, not fired on every up (finding #4)', () => {
    it('a second reconcile of the SAME config calls start, not restart — an unrelated `up` must not interrupt an in-flight check', async () => {
      withWatchdog();
      const { backend } = fakeBackend();
      // installChanged: false on every call — a real install() would report exactly this
      // across two calls with the same binPath/configPath, since neither changed.
      const first = fakeWatchdogService({ installChanged: false });
      await up(loadConfig(), [], deps(backend, first.svc).d);   // no stored fingerprint yet -> restart

      const second = fakeWatchdogService({ installChanged: false });
      await up(loadConfig(), [], deps(backend, second.svc).d);   // same config -> fingerprint unchanged too
      expect(second.calls).toEqual(['install:/bin/ours-fleet:', 'start']);
    });

    it('a changed watchdog interval triggers restart even though the unit/plist content itself is unaffected by it', async () => {
      withWatchdog(', interval: 5m');
      const { backend } = fakeBackend();
      const first = fakeWatchdogService({ installChanged: false });
      await up(loadConfig(), [], deps(backend, first.svc).d);   // establishes the fingerprint for interval: 5m

      withWatchdog(', interval: 15m');   // only the interval changed; unit content (binPath/-c) did not
      const second = fakeWatchdogService({ installChanged: false });   // a real install() would report false too
      await up(loadConfig(), [], deps(backend, second.svc).d);
      expect(second.calls).toEqual(['install:/bin/ours-fleet:', 'restart']);
    });

    it('writes the config fingerprint file (0600) after a successful reconcile', async () => {
      withWatchdog();
      const { backend } = fakeBackend();
      const { svc } = fakeWatchdogService();
      const { d } = deps(backend, svc);
      await up(loadConfig(), [], d);
      const fpPath = join(dir, '.ours-fleet', 'watchdogs', '.config-fingerprint');
      expect(existsSync(fpPath)).toBe(true);
      expect((statSync(fpPath).mode & 0o777)).toBe(0o600);
    });
  });

  it('up with only a disabled watchdog does not install the scheduler', async () => {
    withWatchdog(', enabled: false');
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService();
    const { d } = deps(backend, svc);
    await up(loadConfig(), [], d);
    expect(calls).not.toContain('install:/bin/ours-fleet:');
    expect(calls.some(c => c.startsWith('install'))).toBe(false);
  });

  it('up with no watchdogs at all stops the scheduler, tolerating absence', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService();
    const { d } = deps(backend, svc);
    await up(loadConfig(), [], d);
    expect(calls).toEqual(['stop']);
  });

  it('up with no watchdogs and an unsupervised service never calls stop (final review #3: spurious stop on watchdog-less fleets)', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService({ supervised: false });
    const { d } = deps(backend, svc);
    await up(loadConfig(), [], d);
    expect(calls).not.toContain('stop');
  });

  it('up logs the foreground hint when watchdogs are enabled but unsupervised', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService({ supervised: false });
    const { d, logs } = deps(backend, svc);
    await up(loadConfig(), [], d);
    expect(calls).toEqual([]);
    expect(logs.join('\n')).toContain("OURS_FLEET_SUPERVISOR=none — run 'ours-fleet _run-watchdogs' in the foreground");
  });

  it('a named `up <Role>` still reconciles the scheduler', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService();
    const { d } = deps(backend, svc);
    await up(loadConfig(), ['A'], d);
    expect(calls).toEqual(['install:/bin/ours-fleet:', 'restart']);
  });

  it('up never fails when the scheduler service throws', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const svc: NonNullable<OpsDeps['watchdogService']> = {
      async install() { throw new Error('boom'); },
      async start() { throw new Error('boom'); },
      async stop() { throw new Error('boom'); },
      async restart() { throw new Error('boom'); },
      supervised: () => true,
    };
    const { d, logs } = deps(backend, svc);
    await expect(up(loadConfig(), [], d)).resolves.not.toThrow();
    expect(logs.join('\n')).toContain('boom');
  });

  it('up without a watchdogService (old callers) does not throw', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await expect(up(loadConfig(), [], d)).resolves.not.toThrow();
  });

  it('a whole-fleet down (no names) stops the scheduler', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService();
    const { d } = deps(backend, svc);
    await down(loadConfig(), [], d);
    expect(calls).toEqual(['stop']);
  });

  it('a whole-fleet down never calls stop when the service reports unsupervised (final review #3)', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService({ supervised: false });
    const { d } = deps(backend, svc);
    await down(loadConfig(), [], d);
    expect(calls).not.toContain('stop');
  });

  it('a named `down <Role>` does NOT stop the scheduler', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { calls, svc } = fakeWatchdogService();
    const { d } = deps(backend, svc);
    await down(loadConfig(), ['A'], d);
    expect(calls).toEqual([]);
  });

  it('down without a watchdogService (old callers) does not throw', async () => {
    withWatchdog();
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await expect(down(loadConfig(), [], d)).resolves.not.toThrow();
  });
});

describe('up liveness (1.1) — only a definite stop discards session context', () => {
  /** label, systemd ActiveState, SubState, does `up` boot it fresh? */
  const SHAPES: Array<[string, string, string, boolean]> = [
    ['running', 'active', 'running', false],
    ['active (exited)', 'active', 'exited', false],
    ['inactive (dead)', 'inactive', 'dead', true],
    ['activating (auto-restart)', 'activating', 'auto-restart', false],
    ['failed (error)', 'failed', 'failed', true],
  ];

  const bootedRole = () => {
    writeCfg({ A: { harness: 'fake' } });
    const stateDir = agentDir('A');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.booted'), '');
    return stateDir;
  };

  for (const [label, activeState, subState, bootsFresh] of SHAPES) {
    it(`systemd '${label}' ${bootsFresh ? 'clears' : 'preserves'} .booted`, async () => {
      const stateDir = bootedRole();
      const { d, logs } = deps(systemdSaying(activeState, subState));
      await up(loadConfig(), [], d);
      expect(existsSync(join(stateDir, '.booted'))).toBe(!bootsFresh);
      expect(logs.join('\n')).not.toContain('liveness unknown');
    });
  }

  it('a failed status probe is unknown: context is kept and the failure is visible', async () => {
    const stateDir = bootedRole();
    const failing: Exec = async (_cmd, args) => args.includes('show')
      ? { stdout: '', stderr: 'Failed to connect to user scope bus', code: 1 }
      : { stdout: '', stderr: '', code: 0 };
    const { d, logs } = deps(makeSystemdBackend(failing));
    await up(loadConfig(), [], d);
    expect(existsSync(join(stateDir, '.booted'))).toBe(true);
    expect(logs.join('\n')).toContain('liveness unknown');
    expect(logs.join('\n')).toContain('Failed to connect to user scope bus');
  });

  it('an unrecognised state is unknown, never a stop', async () => {
    const stateDir = bootedRole();
    const { d, logs } = deps(systemdSaying('maintenance', 'unknown'));
    await up(loadConfig(), [], d);
    expect(existsSync(join(stateDir, '.booted'))).toBe(true);
    expect(logs.join('\n')).toContain('liveness unknown');
  });

  it('a backend that throws is unknown, not a stop', async () => {
    const stateDir = bootedRole();
    const { backend } = fakeBackend();
    backend.liveness = async () => { throw new Error('probe exploded'); };
    const { d, logs } = deps(backend);
    await up(loadConfig(), [], d);
    expect(existsSync(join(stateDir, '.booted'))).toBe(true);
    expect(logs.join('\n')).toContain('probe exploded');
  });

  it('a stopped role boots fresh and reads the briefing `up` just rewrote', async () => {
    const first = join(dir, 'brief-1.md');
    writeFileSync(first, 'FIRST BRIEFING BODY');
    writeFileSync(join(dir, 'fleet.yaml'), stringify({ roles: { A: { harness: 'fake', briefing_file: first } } }));
    const { d: d1 } = deps(systemdSaying('active', 'running'));
    await up(loadConfig(), [], d1);
    const stateDir = agentDir('A');
    writeFileSync(join(stateDir, '.booted'), '');           // role has since booted
    expect(readFileSync(join(stateDir, 'briefing.md'), 'utf8')).toContain('FIRST BRIEFING BODY');

    const second = join(dir, 'brief-2.md');
    writeFileSync(second, 'SECOND BRIEFING BODY');
    writeFileSync(join(dir, 'fleet.yaml'), stringify({ roles: { A: { harness: 'fake', briefing_file: second } } }));
    const { d: d2 } = deps(systemdSaying('inactive', 'dead'));
    await up(loadConfig(), [], d2);

    expect(readFileSync(join(stateDir, 'briefing.md'), 'utf8')).toContain('SECOND BRIEFING BODY');
    expect(existsSync(join(stateDir, '.booted'))).toBe(false);   // will re-read it on next start
  });
});

describe('explicit operator actions reset the restart circuit (3.2)', () => {
  const heldDown = () => {
    const stateDir = agentDir('A');
    mkdirSync(stateDir, { recursive: true });
    writeRestartLedger(stateDir, {
      version: 1, consecutiveImmediateFailures: 5, lastReason: 'exited with code 1',
      nextDelayMs: 0, resumeDiscarded: true, circuit: 'open',
      updatedAt: '2026-07-30T00:00:00.000Z', openedAt: '2026-07-30T00:00:00.000Z',
    });
    return stateDir;
  };

  it('`up` releases a held-down role', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const stateDir = heldDown();
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await up(loadConfig(), [], d);
    const ledger = readRestartLedger(stateDir);
    expect(ledger.circuit).toBe('closed');
    expect(ledger.consecutiveImmediateFailures).toBe(0);
    expect(ledger.resumeDiscarded).toBe(false);
  });

  it('`restart` releases it too', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const stateDir = heldDown();
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await restartRoles(loadConfig(), ['A'], d, 'keep');
    expect(readRestartLedger(stateDir).circuit).toBe('closed');
  });

  it('`down` does NOT release it — stopping a role is not a decision to retry', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const stateDir = heldDown();
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await down(loadConfig(), ['A'], d);
    expect(readRestartLedger(stateDir).circuit).toBe('open');
  });
});

describe('rmRole', () => {
  it('removes a spawned role including its fleet.d file', async () => {
    writeCfg({});
    mkdirSync(join(dir, 'fleet.d'), { recursive: true });
    writeFileSync(join(dir, 'fleet.d', 'S.yaml'), stringify({ roles: { S: { harness: 'fake' } } }));
    const cfg = loadConfig();
    applyRole(cfg.roles[0]);
    const { calls, backend } = fakeBackend();
    const { d } = deps(backend);
    await rmRole(cfg, 'S', d);
    expect(calls).toContainEqual(['uninstall', 'S']);
    expect(existsSync(join(dir, 'fleet.d', 'S.yaml'))).toBe(false);
    expect(existsSync(agentDir('S'))).toBe(false);
  });

  it('never deletes the hand-written fleet.yaml for base roles', async () => {
    writeCfg({ A: { harness: 'fake' } });
    const cfg = loadConfig();
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    await rmRole(cfg, 'A', d);
    expect(existsSync(join(dir, 'fleet.yaml'))).toBe(true);
  });

  it('rm stops and archives an exact temporary role absent from merged YAML', async () => {
    writeCfg({});
    const tempDir = agentDir('Temp', true);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'WORKLOG.md'), 'keep this\n');
    prepareTempSupervisor(tempDir, 'Temp');
    await makeTempSupervisorLauncher({
      platform: 'linux', supervisor: 'systemd',
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    })('/bin/ours-fleet', ['_run-temp', 'Temp'], tempDir);
    const { calls, backend } = fakeBackend();
    const { d, logs } = deps(backend);
    d.exec = async (_command, args) => ({
      stdout: args.includes('show') ? 'inactive\n' : '', stderr: '', code: 0,
    });
    d.sleep = async () => {};

    await rmRole(loadConfig(), 'Temp', d);

    expect(calls).toEqual([]);
    expect(existsSync(tempDir)).toBe(false);
    const recovery = join(dir, '.ours-fleet', 'recovery', 'temporary');
    const archived = readdirSync(recovery).find(name => name.includes('-Temp-'))!;
    expect(readFileSync(join(recovery, archived, 'WORKLOG.md'), 'utf8')).toContain('keep this');
    expect(logs.join('\n')).toContain("removed temporary role 'Temp'");
  });

  it('rm archives a stopped temp role whose supervisor metadata is incomplete', async () => {
    writeCfg({});
    const tempDir = agentDir('Incomplete', true);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'WORKLOG.md'), 'preserve incomplete launch evidence\n');
    prepareTempSupervisor(tempDir, 'Incomplete');
    const { calls, backend } = fakeBackend();
    const { d } = deps(backend);
    d.exec = async () => ({ stdout: '', stderr: '', code: 0 });
    d.sleep = async () => {};

    await rmRole(loadConfig(), 'Incomplete', d);

    expect(calls).toEqual([]);
    expect(existsSync(tempDir)).toBe(false);
    const recovery = join(dir, '.ours-fleet', 'recovery', 'temporary');
    const archived = readdirSync(recovery).find(name => name.includes('-Incomplete-'))!;
    expect(readFileSync(join(recovery, archived, 'WORKLOG.md'), 'utf8'))
      .toContain('preserve incomplete launch evidence');
  });

  it('refuses to archive a detached temp supervisor that remains live after SIGTERM', async () => {
    writeCfg({});
    const tempDir = agentDir('Lingering', true);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'WORKLOG.md'), 'live process evidence\n');
    prepareTempSupervisor(tempDir, 'Lingering');
    await makeTempSupervisorLauncher({
      supervisor: 'none', spawnDetached: () => 424242,
    })('/bin/ours-fleet', ['_run-temp', 'Lingering'], tempDir);
    const { backend } = fakeBackend();
    const { d } = deps(backend);
    const signals: Array<NodeJS.Signals | 0> = [];
    d.kill = (_pid, signal) => { signals.push(signal); };
    d.exec = async () => ({
      stdout: '424242 node /bin/ours-fleet _run-temp Lingering\n', stderr: '', code: 0,
    });
    d.sleep = async () => {};

    await expect(rmRole(loadConfig(), 'Lingering', d))
      .rejects.toThrow(/supervisor is running; refusing to archive/);

    expect(signals).toContain('SIGTERM');
    expect(existsSync(tempDir)).toBe(true);
    expect(readFileSync(join(tempDir, 'WORKLOG.md'), 'utf8')).toContain('live process evidence');
  });
});
