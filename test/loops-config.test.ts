import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { resolvedPlan } from '../src/resolved-plan.js';
import { canonicalAgentLoops, resolveAgentLoops } from '../src/loops/config.js';
import type { ResolvedRole } from '../src/config.js';
import { writeV2Fixture } from './v2-fixture.js';
import { stringify } from 'yaml';

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

const write = (yaml: string) => writeV2Fixture(file, yaml);

describe('scheduled loop configuration', () => {
  it('round-trips canonical temporary-agent loops including duration boundaries', () => {
    const role = { name: 'Temp', harness: 'codex', session: 'acp' } as ResolvedRole;
    const resolved = resolveAgentLoops({ edge: {
      interval: '30d', initial_delay: '0s', jitter: '1h', prompt: 'continue',
    } }, role, '(test)');
    const roundTrip = resolveAgentLoops(canonicalAgentLoops(resolved), role, '(sealed)');
    expect(roundTrip.map(loop => ({
      intervalMs: loop.intervalMs, initialDelayMs: loop.initialDelayMs,
      jitterMs: loop.jitterMs, prompt: loop.prompt,
    }))).toEqual([{ intervalMs: 2_592_000_000, initialDelayMs: 0,
      jitterMs: 3_600_000, prompt: 'continue' }]);
  });

  it('accepts 64 Agent loops and rejects 65 at validation time', () => {
    const role = { name: 'Temp', harness: 'codex', session: 'acp' } as ResolvedRole;
    const block = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      `loop-${index}`, { interval: '1m', prompt: `pass ${index}` },
    ]));
    expect(resolveAgentLoops(Object.fromEntries(Object.entries(block).slice(0, 64)), role, '(64)'))
      .toHaveLength(64);
    expect(() => resolveAgentLoops(block, role, '(65)')).toThrow('at most 64 entries');
  });

  it('accepts loops on inert Agent Templates, redacts prompts, and rejects persistent use', () => {
    write({ roles: {} });
    const templatePath = join(dir, 'fleet', 'agent_templates', 'Agent.yaml');
    writeFileSync(templatePath, stringify({
      role: { inline: { mission: 'work' } }, brain: { inline: { harness: 'codex' } },
      loops: { progress: { interval: '1m', prompt: 'CONFIG_LOOP_CANARY' } },
    }), { mode: 0o600 });
    const cfg = loadConfig(file);
    expect(cfg.agentTemplates?.Agent.loops).toMatchObject({ progress: { interval: '1m' } });
    const plan = JSON.stringify(resolvedPlan(cfg));
    expect(plan).not.toContain('CONFIG_LOOP_CANARY');
    expect(plan).toContain('sha256');
    writeFileSync(join(dir, 'fleet', 'agents', 'Persistent.yaml'), 'template: Agent\n', { mode: 0o600 });
    expect(() => loadConfig(file)).toThrow('supported only for temporary Agent launches');
  });

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

  it('rejects legacy tmux roles before loop activation', () => {
    write('roles:\n  A: { session: tmux }\nloops:\n  check: { roles: [A], interval: 1m, prompt: hi, enabled: false }\n');
    expect(() => loadConfig(file)).toThrow(/tmux is no longer supported/);
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
