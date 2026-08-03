import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { resolvedPlan } from '../src/resolved-plan.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-loop-config-'));
  file = join(dir, 'fleet.yaml');
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const write = (yaml: string) => writeFileSync(file, yaml, { mode: 0o600 });

describe('scheduled loop configuration', () => {
  it('resolves exact and permanent-only wildcard roles with full-interval defaults', () => {
    write([
      'vars: { cadence: 2h }',
      'roles:',
      '  Coordinator: { session: acp }',
      '  Release: { session: acp }',
      'loops:',
      '  health:',
      '    roles: [Coordinator]',
      '    interval: ${cadence}',
      '    prompt: literal health pass',
      '  all:',
      '    roles: ["*"]',
      '    interval: 1d',
      '    initial_delay: 0s',
      '    jitter: 1h',
      '    prompt: hygiene',
      '',
    ].join('\n'));
    const cfg = loadConfig(file);
    expect(cfg.loops.map(loop => [loop.name, loop.roleNames])).toEqual([
      ['all', ['Coordinator', 'Release']], ['health', ['Coordinator']],
    ]);
    expect(cfg.loops.find(loop => loop.name === 'health')).toMatchObject({
      intervalMs: 7_200_000, initialDelayMs: 7_200_000, jitterMs: 0, enabled: true,
    });
    expect(cfg.loops.find(loop => loop.name === 'all')).toMatchObject({
      initialDelayMs: 0, jitterMs: 3_600_000,
    });
    expect(cfg.roles.find(role => role.name === 'Release')?.loops?.map(loop => loop.name))
      .toEqual(['all']);
  });

  it('allows disabled tmux definitions but rejects enabled incompatible targets', () => {
    write('roles:\n  A: { session: tmux }\nloops:\n  check: { roles: [A], interval: 1m, prompt: hi, enabled: false }\n');
    expect(loadConfig(file).loops[0].enabled).toBe(false);
    write('roles:\n  A: { session: tmux }\nloops:\n  check: { roles: [A], interval: 1m, prompt: hi }\n');
    expect(() => loadConfig(file)).toThrow(/scheduled loops require session: acp/);
  });

  it.each([
    ['unknown key', 'roles: [A], interval: 1m, prompt: hi, retry: true'],
    ['duplicate roles', 'roles: [A, A], interval: 1m, prompt: hi'],
    ['mixed wildcard', 'roles: ["*", A], interval: 1m, prompt: hi'],
    ['missing role', 'roles: [Missing], interval: 1m, prompt: hi'],
    ['blank prompt', 'roles: [A], interval: 1m, prompt: ""'],
    ['short interval', 'roles: [A], interval: 59s, prompt: hi'],
    ['long interval', 'roles: [A], interval: 31d, prompt: hi'],
    ['bad jitter', 'roles: [A], interval: 1m, jitter: 1m, prompt: hi'],
  ])('rejects %s', (_label, entry) => {
    write(`roles:\n  A: { session: acp }\nloops:\n  check: { ${entry} }\n`);
    expect(() => loadConfig(file)).toThrow(/loop 'check'/);
  });

  it('rejects NUL/oversized prompts and unsafe explicit config permissions', () => {
    write(`roles:\n  A: { session: acp }\nloops:\n  check:\n    roles: [A]\n    interval: 1m\n    prompt: "bad\\0text"\n`);
    expect(() => loadConfig(file)).toThrow(/NUL/);
    write(`roles:\n  A: { session: acp }\nloops:\n  check:\n    roles: [A]\n    interval: 1m\n    prompt: ${'x'.repeat(16_385)}\n`);
    expect(() => loadConfig(file)).toThrow(/16384 bytes/);
    write('roles:\n  A: { session: acp }\nloops:\n  check: { roles: [A], interval: 1m, prompt: hi }\n');
    chmodSync(file, 0o666);
    expect(() => loadConfig(file)).toThrow(/group\/world writable/);
  });

  it('redacts literal prompt text from the resolved plan', () => {
    write('roles:\n  A: { session: acp }\nloops:\n  check: { roles: [A], interval: 1m, prompt: "CANARY_LOOP_SECRET" }\n');
    const json = JSON.stringify(resolvedPlan(loadConfig(file)));
    expect(json).not.toContain('CANARY_LOOP_SECRET');
    expect(json).toContain('sha256');
    expect(json).toContain('bytes');
  });
});
