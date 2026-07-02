import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { spawnPermanent, spawnTemp } from '../src/spawn.js';
import { agentDir } from '../src/paths.js';
import { registerAdapter } from '../src/harness/registry.js';
import { Tmux } from '../src/tmux.js';
import { fakeAdapter } from './registry.test.js';
import type { OpsDeps } from '../src/ops.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';
import type { Exec } from '../src/exec.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-spawn-'));
  process.env.OURS_FLEET_HOME = dir;
  process.env.FLEET_START_STAGGER = '0';
  registerAdapter(fakeAdapter);
  writeFileSync(join(dir, 'fleet.yaml'), stringify({ defaults: { harness: 'fake' }, roles: { Coord: {} } }));
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  delete process.env.FLEET_START_STAGGER;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps() {
  const calls: string[][] = [];
  const backend: SupervisorBackend = {
    id: 'none',
    async init() { return []; },
    async install(n) { calls.push(['install', n]); },
    async start() {}, async stop() {}, async restart() {},
    async status() { return 'inactive'; }, async uninstall() {},
    logsArgs: n => ({ cmd: 'true', args: [n] }),
  };
  const d: OpsDeps = { backend, binPath: '/b/ours-fleet', sleep: async () => {}, log: () => {} };
  return { d, calls };
}

describe('spawnPermanent', () => {
  it('writes fleet.d/<Name>.yaml from files and brings the role up', async () => {
    writeFileSync(join(dir, 'bio.txt'), 'A public card.');
    writeFileSync(join(dir, 'persona.txt'), 'An operating contract.');
    const { d, calls } = fakeDeps();
    const file = await spawnPermanent({
      name: 'Worker', mission: 'do stuff', coordinator: 'Coord',
      bioFile: join(dir, 'bio.txt'), personaFile: join(dir, 'persona.txt'),
    }, d);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.roles.Worker.bio).toBe('A public card.');
    expect(doc.roles.Worker.persona).toBe('An operating contract.');
    expect(doc.roles.Worker.coordinator).toBe('Coord');
    expect(calls).toContainEqual(['install', 'Worker']);
    expect(readFileSync(join(agentDir('Worker'), 'briefing.md'), 'utf8')).toContain('do stuff');
  });

  it('refuses an existing role name before writing anything', async () => {
    const { d } = fakeDeps();
    await expect(spawnPermanent({ name: 'Coord' }, d)).rejects.toThrowError(/already exists/);
    expect(existsSync(join(dir, 'fleet.d', 'Coord.yaml'))).toBe(false);
  });
});

describe('spawnTemp', () => {
  it('snapshots the role and launches _run-temp in tmux', async () => {
    const tmuxCalls: string[][] = [];
    const exec: Exec = async (cmd, args) => { tmuxCalls.push([cmd, ...args]); return { stdout: '', stderr: '', code: 0 }; };
    const d = await spawnTemp({ name: 'Scout', mission: 'recon' }, new Tmux(exec), '/b/ours-fleet');
    expect(d).toBe(agentDir('Scout', true));
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.harness).toBe('fake');       // from defaults
    expect(snap.mission).toBe('recon');
    expect(readFileSync(join(d, 'briefing.md'), 'utf8')).toContain('recon');
    const ns = tmuxCalls.find(c => c[1] === 'new-session')!;
    expect(ns[ns.length - 1]).toBe(`'/b/ours-fleet' _run-temp 'Scout'`);
  });
});
