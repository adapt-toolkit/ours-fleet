import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { spawnPermanent, spawnTemp } from '../src/spawn.js';
import { agentDir } from '../src/paths.js';
import { registerAdapter } from '../src/harness/registry.js';
import { fakeAdapter } from './registry.test.js';
import type { OpsDeps } from '../src/ops.js';
import type { SupervisorBackend } from '../src/supervisor/types.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

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

describe('spawn --model', () => {
  it('persists a permanent role model to fleet.d', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Worker', model: 'claude-fable-5' }, d);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.roles.Worker.model).toBe('claude-fable-5');
  });

  it('snapshots a temp role model into role.yaml', async () => {
    const dir = await spawnTemp(
      { name: 'Scout', model: 'claude-fable-5' },
      '/b/ours-fleet',
      () => {},
    );
    const snap = parse(readFileSync(join(dir, 'role.yaml'), 'utf8'));
    expect(snap.model).toBe('claude-fable-5');
  });

  it('drops an empty/whitespace model', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({ name: 'Worker2', model: '   ' }, d);
    const doc = parse(readFileSync(file, 'utf8'));
    expect(doc.roles.Worker2.model).toBeUndefined();
  });

  it('a temp role without model inherits defaults.model', async () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      stringify({ defaults: { harness: 'fake', model: 'claude-fable-5' }, roles: {} }));
    const d = await spawnTemp({ name: 'Scout', mission: 'recon' }, '/b/ours-fleet', () => {});
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.model).toBe('claude-fable-5');
  });

  it('a temp role model overrides defaults.model', async () => {
    writeFileSync(join(dir, 'fleet.yaml'),
      stringify({ defaults: { harness: 'fake', model: 'claude-fable-5' }, roles: {} }));
    const d = await spawnTemp(
      { name: 'Scout', model: 'claude-opus-4-8' }, '/b/ours-fleet', () => {});
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.model).toBe('claude-opus-4-8');
  });
});

describe('spawn Codex options', () => {
  it('persists launcher, permission, sandbox, profile, search, config, and add-dir', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({
      name: 'Coder', harness: 'codex', model: 'gpt-5.4', permissionMode: 'never',
      sandbox: 'workspace-write', profile: 'fleet', launcher: 'auto', search: true,
      codexConfig: { model_reasoning_effort: 'high' }, addDirs: ['/data/shared'], monitor: true,
    }, d);
    const role = parse(readFileSync(file, 'utf8')).roles.Coder;
    expect(role.model).toBe('gpt-5.4');
    expect(role.harness_options).toEqual({
      approval: 'never', sandbox: 'workspace-write', profile: 'fleet', launcher: 'auto',
      search: true, config: { model_reasoning_effort: 'high' }, add_dirs: ['/data/shared'],
      monitor: true,
    });
  });

  it('maps the generic permission flag to Claude permission_mode', async () => {
    const { d } = fakeDeps();
    const file = await spawnPermanent({
      name: 'ClaudeWorker', harness: 'claude-code', permissionMode: 'dontAsk',
    }, d);
    expect(parse(readFileSync(file, 'utf8')).roles.ClaudeWorker.harness_options)
      .toEqual({ permission_mode: 'dontAsk' });
  });
});

describe('spawnTemp', () => {
  it('snapshots the role and launches the supervisor detached (not in a same-named tmux session)', async () => {
    const launched: { binPath: string; args: string[]; dir: string }[] = [];
    const d = await spawnTemp(
      { name: 'Scout', mission: 'recon' },
      '/b/ours-fleet',
      (binPath, args, dir) => { launched.push({ binPath, args, dir }); },
    );
    expect(d).toBe(agentDir('Scout', true));
    const snap = parse(readFileSync(join(d, 'role.yaml'), 'utf8'));
    expect(snap.harness).toBe('fake');       // from defaults
    expect(snap.mission).toBe('recon');
    expect(readFileSync(join(d, 'briefing.md'), 'utf8')).toContain('recon');
    // Supervisor launched detached with the temp dir as its state — NOT inside a
    // tmux session named 'Scout' (which runOnce owns and kills for the agent).
    expect(launched).toEqual([{ binPath: '/b/ours-fleet', args: ['_run-temp', 'Scout'], dir: d }]);
  });
});
