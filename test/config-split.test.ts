import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRole, loadConfig } from '../src/config.js';
import { spawnDryRun } from '../src/spawn.js';
import { resolvedRolePlan } from '../src/resolved-plan.js';
import { getAdapter } from '../src/harness/registry.js';
import '../src/harness/codex.js';
import '../src/harness/claude-code.js';

let dir: string;
let oldHome: string | undefined;

function manifest(body = ''): void {
  writeFileSync(join(dir, 'fleet.yaml'), `api_version: ours.network/fleet/v2\n${body}`);
  chmodSync(join(dir, 'fleet.yaml'), 0o600);
}

function kind(kindName: 'agents' | 'roles' | 'brains', name: string, body: string): void {
  const root = join(dir, 'fleet', kindName);
  mkdirSync(root, { recursive: true });
  chmodSync(join(dir, 'fleet'), 0o700);
  chmodSync(root, 0o700);
  writeFileSync(join(root, name), body);
  chmodSync(join(root, name), 0o600);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-split-'));
  oldHome = process.env.HOME;
  process.env.HOME = dir;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('Agent Role Brain split configuration', () => {
  it('composes preset Role and Brain into one runtime role', () => {
    manifest('vars:\n  root: /work\n');
    kind('roles', 'developer.yaml', 'mission: Build it\npersona: Be precise\nbio: Developer\n');
    kind('brains', 'codex-high.yaml', 'harness: codex\nmodel: gpt-5.6\neffort: high\n');
    kind('agents', 'Alice.yaml', [
      'role: { ref: developer }',
      'brain: { ref: codex-high }',
      'cwd: ${root}/alice',
      'permissions: { approval: ask, filesystem: workspace, unattended: deny }',
      '',
    ].join('\n'));
    const cfg = loadConfig();
    const alice = findRole(cfg, 'Alice');
    expect(alice).toMatchObject({
      name: 'Alice', identity: 'Alice', harness: 'codex', model: 'gpt-5.6',
      effort: 'high',
      mission: 'Build it', persona: 'Be precise', bio: 'Developer', cwd: '/work/alice',
    });
    expect(alice.harness_options).toMatchObject({ config: { model_reasoning_effort: 'high' } });
    expect(getAdapter('codex').agentSession.sessionConfigSelections(alice)).toEqual([
      { configId: 'model', value: 'gpt-5.6' },
      { configId: 'reasoning_effort', value: 'high' },
    ]);
    expect(alice.sourceFile).toBe(join(dir, 'fleet', 'agents', 'Alice.yaml'));
    expect(cfg.configMode).toBe('split-v2');
    expect(cfg.sourceDocuments).toEqual(expect.arrayContaining([
      { kind: 'Manifest', path: join(dir, 'fleet.yaml') },
      { kind: 'Agent', id: 'Alice', path: join(dir, 'fleet', 'agents', 'Alice.yaml') },
    ]));
    expect(alice.provenance?.effort).toMatchObject({
      sourceKind: 'Brain', origin: 'explicit', transforms: expect.arrayContaining([
        expect.objectContaining({ kind: 'adapter-normalization' }),
      ]),
    });
    expect(resolvedRolePlan(alice)).toEqual(resolvedRolePlan(findRole(loadConfig(), 'Alice')));
    expect((resolvedRolePlan(alice).references as Array<{ kind: string }>).map(ref => ref.kind))
      .toEqual(['Brain', 'Role']);
  });

  it('accepts fully inline Role and Brain without preset roots', () => {
    manifest();
    kind('agents', 'Inline.yaml', [
      'role:',
      '  inline: { mission: Coordinate, persona: Delegate }',
      'brain:',
      '  inline: { harness: claude-code, model: claude-fable-5, effort: medium }',
      '',
    ].join('\n'));
    const role = findRole(loadConfig(), 'Inline');
    expect(role).toMatchObject({ mission: 'Coordinate', persona: 'Delegate', harness: 'claude-code', model: 'claude-fable-5' });
    expect(role.harness_options).toMatchObject({ effort: 'medium' });
  });

  it('derives exact IDs from filename stems and rejects yaml/yml duplicates', () => {
    manifest();
    kind('roles', 'dev.yaml', 'mission: one\n');
    kind('roles', 'dev.yml', 'mission: two\n');
    kind('agents', 'A.yaml', 'role: { ref: dev }\nbrain: { inline: { harness: codex } }\n');
    expect(() => loadConfig()).toThrow(/E_DUPLICATE_ID.*dev.*dev\.yaml.*dev\.yml/);
  });

  it('rejects missing refs and invalid union overlays', () => {
    manifest();
    kind('agents', 'A.yaml', 'role: { ref: absent }\nbrain: { inline: { harness: codex } }\n');
    expect(() => loadConfig()).toThrow(/E_REF_MISSING.*role 'absent'/);
    kind('roles', 'dev.yaml', 'mission: ok\n');
    kind('agents', 'A.yaml', 'role: { ref: dev, inline: { mission: no } }\nbrain: { inline: { harness: codex } }\n');
    expect(() => loadConfig()).toThrow(/E_UNION.*exactly one/);
  });

  it('rejects legacy single-file and fleet.d configurations actionably', () => {
    writeFileSync(join(dir, 'fleet.yaml'), 'roles:\n  A: {}\n');
    chmodSync(join(dir, 'fleet.yaml'), 0o600);
    expect(() => loadConfig()).toThrow(/legacy fleet configuration is unsupported.*ours-fleet doctor/);
    manifest();
    mkdirSync(join(dir, 'fleet', 'agents'), { recursive: true });
    chmodSync(join(dir, 'fleet'), 0o700);
    chmodSync(join(dir, 'fleet', 'agents'), 0o700);
    mkdirSync(join(dir, 'fleet.d'));
    writeFileSync(join(dir, 'fleet.d', 'A.yaml'), 'roles: { A: {} }\n');
    chmodSync(join(dir, 'fleet.d', 'A.yaml'), 0o600);
    expect(() => loadConfig()).toThrow(/legacy fleet\.d configuration is unsupported.*ours-fleet doctor/);
  });

  it('rejects symlinked kind roots', () => {
    manifest();
    mkdirSync(join(dir, 'fleet'), { recursive: true });
    chmodSync(join(dir, 'fleet'), 0o700);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'fleet', 'agents'));
    expect(() => loadConfig()).toThrow(/E_SYMLINK.*agents/);
  });

  it('preserves neutral effort through writer, loader, adapter materialization, and inspection', () => {
    manifest();
    const document = { role: { inline: { mission: 'Inspect' } },
      brain: { inline: { harness: 'codex', effort: 'xhigh' } } };
    kind('agents', 'Writer.yaml', `${JSON.stringify(document)}\n`);
    const role = findRole(loadConfig(), 'Writer');
    expect(role.effort).toBe('xhigh');
    expect(role.harness_options).toEqual({ config: { model_reasoning_effort: 'xhigh' } });
    expect(resolvedRolePlan(role).effort).toBe('xhigh');
  });

  it('routes real spawn inputs through the selected adapter exactly once', () => {
    manifest();
    kind('agents', 'Existing.yaml', 'role: { inline: {} }\nbrain: { inline: { harness: codex } }\n');
    for (const [harness, effort, native] of [
      ['codex', 'ultra', { config: { model_reasoning_effort: 'ultra' } }],
      ['claude-code', 'max', { effort: 'max' }],
    ] as const) {
      const dry = spawnDryRun({
        name: `Dry-${harness}`, brain: { inline: { harness, effort } }, role: { inline: {} },
        configPath: join(dir, 'fleet.yaml'),
        temp: true,
      });
      expect(dry.roleDocument).toMatchObject({ brain: { inline: { harness, effort } } });
      expect(dry.resolvedRole).toMatchObject({ harness, effort, harness_options: native });
    }
  });

  it('routes a room canonical agent definition through the same Codex effort constructor', () => {
    manifest();
    kind('agents', 'Existing.yaml',
      'role: { inline: {} }\nbrain: { inline: { harness: codex } }\n');
    const dry = spawnDryRun({
      name: 'RoomMember', temp: true, configPath: join(dir, 'fleet.yaml'),
      agentDefinition: {
        brain: { inline: { harness: 'codex', model: 'gpt-room', effort: 'low' } },
        role: { inline: { mission: 'Review' } },
      },
    });
    expect(dry.roleDocument).toMatchObject({
      brain: { inline: { harness: 'codex', model: 'gpt-room', effort: 'low' } },
    });
    expect(dry.resolvedRole).toMatchObject({
      harness: 'codex', model: 'gpt-room', effort: 'low',
      harness_options: { config: { model_reasoning_effort: 'low' } },
    });
    expect(getAdapter('codex').agentSession.sessionConfigSelections(dry.resolvedRole)).toEqual([
      { configId: 'model', value: 'gpt-room' },
      { configId: 'reasoning_effort', value: 'low' },
    ]);
  });

  it('substitutes preset and inline values, but never refs, and rejects unknown vars safely', () => {
    manifest('vars:\n  harness_name: codex\n  mission_text: Build safely\n');
    kind('roles', 'developer.yaml', 'mission: ${mission_text}\n');
    kind('brains', 'runtime.yaml', 'harness: ${harness_name}\n');
    kind('agents', 'Preset.yaml', 'role: { ref: developer }\nbrain: { ref: runtime }\n');
    kind('agents', 'Inline.yaml', [
      'role: { inline: { mission: "${mission_text}" } }',
      'brain: { inline: { harness: "${harness_name}" } }',
      '',
    ].join('\n'));
    expect(findRole(loadConfig(), 'Preset')).toMatchObject({ mission: 'Build safely', harness: 'codex' });
    expect(findRole(loadConfig(), 'Inline')).toMatchObject({ mission: 'Build safely', harness: 'codex' });

    kind('agents', 'Ref.yaml', 'role: { ref: "${mission_text}" }\nbrain: { inline: { harness: codex } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/role\/ref.*valid case-sensitive ID/);
    kind('agents', 'Ref.yaml', 'role: { inline: { mission: "${missing}" } }\nbrain: { inline: { harness: codex } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/role\/inline\/mission: unknown variable \$\{missing\}/);
  });

  it('enforces focused Role, Brain, Agent, and union schema boundaries', () => {
    manifest();
    kind('agents', 'A.yaml', 'role: { inline: { mission: 42 } }\nbrain: { inline: { harness: codex } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/role\/inline\/mission.*string/);
    kind('agents', 'A.yaml', 'role: { inline: {} }\nbrain: { inline: { model: 42 } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/brain\/inline\/harness.*required/);
    kind('agents', 'A.yaml', 'role: { inline: {} }\nbrain: { inline: { harness: codex, model: 42 } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/brain\/inline\/model.*string or null/);
    kind('agents', 'A.yaml', 'role: { inline: {} }\nbrain: { inline: { harness: missing-adapter } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/brain\/inline\/harness.*unregistered/);
    kind('agents', 'A.yaml', 'role: { inline: {} }\nbrain: { inline: { harness: codex } }\nidentity: ""\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/agents\/A\/identity.*non-blank/);
    kind('agents', 'A.yaml', `role: { inline: { mission: "${'x'.repeat(16 * 1024 + 1)}" } }\nbrain: { inline: { harness: codex } }\n`);
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/role\/inline\/mission.*16384 UTF-8 bytes/);
  });

  it('rejects scalar Brain option maps inline and in presets without echoing values', () => {
    manifest();
    kind('agents', 'A.yaml', 'role: { inline: {} }\nbrain: { inline: { harness: codex, harness_options: CANARY_SECRET } }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/brain\/inline\/harness_options: must be a mapping/);
    try { loadConfig(); } catch (error) { expect(String(error)).not.toContain('CANARY_SECRET'); }

    kind('brains', 'bad.yaml', 'harness: codex\nsession_options: PRESET_SECRET\n');
    kind('agents', 'A.yaml', 'role: { inline: {} }\nbrain: { ref: bad }\n');
    expect(() => loadConfig()).toThrow(/E_SCHEMA \/brains\/bad\/session_options: must be a mapping/);
    try { loadConfig(); } catch (error) { expect(String(error)).not.toContain('PRESET_SECRET'); }
  });

  it('enforces the closed unique Agent oversee contract with canonical durations', () => {
    manifest();
    const write = (oversee: string) => kind('agents', 'A.yaml',
      `role: { inline: {} }\nbrain: { inline: { harness: codex } }\noversee: ${oversee}\n`);
    write('[{ agent: B, interval: 5m }]');
    expect(findRole(loadConfig(), 'A').oversee).toEqual([{ agent: 'B', interval: '5m' }]);

    for (const [subject, pattern] of [
      ['nope', /\/agents\/A\/oversee: must be an array/],
      ['[nope]', /\/agents\/A\/oversee\/0: must be a mapping/],
      ['[{ role: B, interval: 5m }]', /\/agents\/A\/oversee\/0: must contain exactly agent and interval/],
      ['[{ agent: B, interval: 5m, extra: CANARY }]', /\/agents\/A\/oversee\/0: must contain exactly agent and interval/],
      ['[{ agent: "bad name", interval: 5m }]', /\/agents\/A\/oversee\/0\/agent: must be a valid Agent ID/],
      ['[{ agent: B, interval: soon }]', /\/agents\/A\/oversee\/0\/interval: must be a valid duration/],
      ['[{ agent: B, interval: 5m }, { agent: B, interval: 10m }]', /\/agents\/A\/oversee\/1\/agent: must be unique/],
    ] as const) {
      write(subject);
      expect(() => loadConfig()).toThrow(pattern);
      try { loadConfig(); } catch (error) { expect(String(error)).not.toContain('CANARY'); }
    }
  });
});
