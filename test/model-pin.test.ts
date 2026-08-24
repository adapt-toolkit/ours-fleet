import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, findRole, ConfigError, type ResolvedRole } from '../src/config.js';
import {
  assertModelPinReachesChild, modelEnvVar, resolveRoleModelEnv,
} from '../src/model-env.js';
import { harnessChildEnv } from '../src/runner.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-modelpin-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const base = (s: string) => writeFileSync(join(dir, 'fleet.yaml'), s);

describe('modelEnvVar', () => {
  it('knows the pin variable for claude-code and nothing else', () => {
    expect(modelEnvVar('claude-code')).toBe('ANTHROPIC_MODEL');
    expect(modelEnvVar('codex')).toBeUndefined();
    expect(modelEnvVar(undefined)).toBeUndefined();
  });
});

describe('resolveRoleModelEnv', () => {
  it('lets an explicit role model win over an inherited defaults.env pin', () => {
    const r = resolveRoleModelEnv({
      harness: 'claude-code',
      model: 'claude-fable-5',
      modelWasExplicit: true,
      defaultsEnv: { ANTHROPIC_MODEL: 'claude-opus-5' },
    });
    expect(r.env.ANTHROPIC_MODEL).toBe('claude-fable-5');
    expect(r.model).toBe('claude-fable-5');
  });

  it('keeps inheriting the defaults model when no model is given', () => {
    const r = resolveRoleModelEnv({
      harness: 'claude-code',
      model: 'claude-opus-5',            // resolved from defaults.model
      modelWasExplicit: false,
      defaultsEnv: { ANTHROPIC_MODEL: 'claude-opus-5' },
    });
    expect(r.env.ANTHROPIC_MODEL).toBe('claude-opus-5');
    expect(r.model).toBe('claude-opus-5');
  });

  it('lets a role-level env pin override the inherited defaults model', () => {
    const r = resolveRoleModelEnv({
      harness: 'claude-code',
      model: 'claude-opus-5',            // from defaults.model, not declared
      modelWasExplicit: false,
      defaultsEnv: { ANTHROPIC_MODEL: 'claude-opus-5' },
      roleEnv: { ANTHROPIC_MODEL: 'claude-fable-5' },
    });
    expect(r.env.ANTHROPIC_MODEL).toBe('claude-fable-5');
    // The reported model must follow the pin, never the value it overrode.
    expect(r.model).toBe('claude-fable-5');
  });

  it('refuses an explicit model that disagrees with the role\'s own env pin', () => {
    expect(() => resolveRoleModelEnv({
      harness: 'claude-code',
      model: 'claude-fable-5',
      modelWasExplicit: true,
      roleEnv: { ANTHROPIC_MODEL: 'claude-opus-5' },
    })).toThrow(/ANTHROPIC_MODEL/);
  });

  it('drops an inherited pin when the model is explicitly cleared', () => {
    const r = resolveRoleModelEnv({
      harness: 'claude-code',
      model: undefined,
      modelWasExplicit: true,            // `--model none` / `model: null`
      defaultsEnv: { ANTHROPIC_MODEL: 'claude-opus-5' },
    });
    expect(r.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(r.model).toBeUndefined();
  });

  it('leaves a non-claude harness env untouched', () => {
    const r = resolveRoleModelEnv({
      harness: 'codex',
      model: 'gpt-5',
      modelWasExplicit: true,
      defaultsEnv: { ANTHROPIC_MODEL: 'claude-opus-5' },
    });
    expect(r.env.ANTHROPIC_MODEL).toBe('claude-opus-5');
    expect(r.model).toBe('gpt-5');
  });

  it('carries unrelated env entries through unchanged', () => {
    const r = resolveRoleModelEnv({
      harness: 'claude-code',
      model: 'claude-fable-5',
      modelWasExplicit: true,
      defaultsEnv: { ANTHROPIC_MODEL: 'claude-opus-5', FOO: 'a' },
      roleEnv: { BAR: 'b' },
      authProxyBaseUrl: 'http://127.0.0.1:9',
    });
    expect(r.env).toEqual({
      ANTHROPIC_MODEL: 'claude-fable-5', FOO: 'a', BAR: 'b',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    });
  });
});

describe('loadConfig model pin', () => {
  it('pins a role that declares a model over the fleet defaults.env pin', () => {
    base([
      'defaults:',
      '  harness: claude-code',
      '  model: claude-opus-5',
      '  env:',
      '    ANTHROPIC_MODEL: claude-opus-5',
      'roles:',
      '  Fabler:',
      '    session: acp',
      '    model: claude-fable-5',
      '',
    ].join('\n'));
    const role = findRole(loadConfig(), 'Fabler')!;
    expect(role.model).toBe('claude-fable-5');
    expect(role.env?.ANTHROPIC_MODEL).toBe('claude-fable-5');
  });

  it('still inherits the default model when a role declares none', () => {
    base([
      'defaults:',
      '  model: claude-opus-5',
      '  env:',
      '    ANTHROPIC_MODEL: claude-opus-5',
      'roles:',
      '  Plain:',
      '    session: acp',
      '',
    ].join('\n'));
    const role = findRole(loadConfig(), 'Plain')!;
    expect(role.model).toBe('claude-opus-5');
    expect(role.env?.ANTHROPIC_MODEL).toBe('claude-opus-5');
  });

  it('rejects a role whose declared model contradicts its own env pin', () => {
    base([
      'roles:',
      '  Contradiction:',
      '    session: acp',
      '    model: claude-fable-5',
      '    env:',
      '      ANTHROPIC_MODEL: claude-opus-5',
      '',
    ].join('\n'));
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe('assertModelPinReachesChild', () => {
  const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({
    name: 'R', harness: 'claude-code', session: 'acp', identity: 'R',
    model: 'claude-fable-5',
    permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
    ...over,
  } as ResolvedRole);

  it('passes when the child env carries the role\'s model', () => {
    expect(() => assertModelPinReachesChild(
      role(), { ANTHROPIC_MODEL: 'claude-fable-5' })).not.toThrow();
  });

  it('throws when the child env would run a different model than the role declares', () => {
    expect(() => assertModelPinReachesChild(
      role(), { ANTHROPIC_MODEL: 'claude-opus-5' }))
      .toThrow(/claude-fable-5/);
  });

  it('throws when the pin is missing entirely', () => {
    expect(() => assertModelPinReachesChild(role(), {})).toThrow(/ANTHROPIC_MODEL/);
  });

  it('ignores harnesses with no model env pin', () => {
    expect(() => assertModelPinReachesChild(
      role({ harness: 'codex', model: 'gpt-5' }), {})).not.toThrow();
  });
});

describe('harnessChildEnv', () => {
  const role = (over: Partial<ResolvedRole> = {}): ResolvedRole => ({
    name: 'R', harness: 'claude-code', session: 'acp', identity: 'R',
    model: 'claude-fable-5',
    env: { ANTHROPIC_MODEL: 'claude-fable-5' },
    permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
    ...over,
  } as ResolvedRole);

  it('hands the role pin to the child even when harness prep set another', () => {
    const env = harnessChildEnv(role(), { ANTHROPIC_MODEL: 'claude-opus-5' }, dir);
    expect(env.ANTHROPIC_MODEL).toBe('claude-fable-5');
  });

  it('refuses to launch when a stale role env block would run another model', () => {
    // Exactly the shipped defect: role.env wins over harness prep, so a role env
    // block carrying the old fleet-wide pin used to decide the runtime silently.
    expect(() => harnessChildEnv(
      role({ env: { ANTHROPIC_MODEL: 'claude-opus-5' } }), {}, dir))
      .toThrow(/refusing to launch/);
  });
});
