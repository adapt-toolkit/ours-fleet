import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { applyRole, up, down, restartRoles, rmRole, type OpsDeps } from '../src/ops.js';
import { loadConfig } from '../src/config.js';
import { agentDir } from '../src/paths.js';
import { registerAdapter } from '../src/harness/registry.js';
import { fakeAdapter } from './registry.test.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';

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

function fakeBackend() {
  const calls: string[][] = [];
  const backend: SupervisorBackend = {
    id: 'none',
    async init() { return []; },
    async install(n) { calls.push(['install', n]); },
    async start(n) { calls.push(['start', n]); },
    async stop(n) { calls.push(['stop', n]); },
    async restart(n) { calls.push(['restart', n]); },
    async status(n) { calls.push(['status', n]); return 'inactive'; },
    async uninstall(n) { calls.push(['uninstall', n]); },
    logsArgs: n => ({ cmd: 'true', args: [n] }),
  };
  return { calls, backend };
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
