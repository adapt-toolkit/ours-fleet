import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
function systemdSaying(activeState: string, subState: string) {
  const exec: Exec = async () => ({ stdout: `${activeState}\n${subState}\n`, stderr: '', code: 0 });
  return makeSystemdBackend(exec);
}
function deps(backend: SupervisorBackend) {
  const logs: string[] = [];
  const d: OpsDeps = {
    backend, binPath: '/bin/ours-fleet',
    log: l => logs.push(l),
  };
  return { d, logs };
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
});
