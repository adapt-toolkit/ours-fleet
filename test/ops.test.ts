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
  delete process.env.FLEET_START_STAGGER;
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
  const slept: number[] = [];
  const logs: string[] = [];
  const d: OpsDeps = {
    backend, binPath: '/bin/ours-fleet',
    sleep: async ms => { slept.push(ms); },
    log: l => logs.push(l),
  };
  return { d, slept, logs };
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
});

describe('up / down / restart', () => {
  it('up staggers boots and installs every role', async () => {
    process.env.FLEET_START_STAGGER = '3';
    writeCfg({ A: { harness: 'fake' }, B: { harness: 'fake' } });
    const { calls, backend } = fakeBackend();
    const { d, slept } = deps(backend);
    await up(loadConfig(), [], d);
    expect(calls.filter(c => c[0] === 'install').map(c => c[1])).toEqual(['A', 'B']);
    expect(slept).toEqual([3000]);   // once, between the two boots
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
