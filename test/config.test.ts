import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, findRole, ConfigError } from '../src/config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-cfg-'));
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const base = (s: string) => writeFileSync(join(dir, 'fleet.yaml'), s);
const dropin = (name: string, s: string) => {
  mkdirSync(join(dir, 'fleet.d'), { recursive: true });
  writeFileSync(join(dir, 'fleet.d', name), s);
};

describe('loadConfig', () => {
  it('merges fleet.yaml with fleet.d drop-ins', () => {
    base('roles:\n  A:\n    mission: base role\n');
    dropin('b.yaml', 'roles:\n  B:\n    mission: spawned\n');
    const cfg = loadConfig();
    expect(cfg.roles.map(r => r.name).sort()).toEqual(['A', 'B']);
    expect(findRole(cfg, 'B').sourceFile).toContain('fleet.d/b.yaml');
  });

  it('errors on duplicate role naming both files', () => {
    base('roles:\n  A: {}\n');
    dropin('a.yaml', 'roles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/A.*defined in both.*fleet\.yaml.*a\.yaml/s);
  });

  it('substitutes ${vars} recursively', () => {
    base('vars:\n  root: /work\nroles:\n  A:\n    cwd: ${root}/a\n    persona: |\n      lives at ${root}\n');
    const a = findRole(loadConfig(), 'A');
    expect(a.cwd).toBe('/work/a');
    expect(a.persona).toContain('lives at /work');
  });

  it('applies defaults cascade and identity fallback', () => {
    base('defaults:\n  harness: claude-code\n  max_tokens: 500000\nroles:\n  A: {}\n  B:\n    harness: other\n    max_tokens: 100\n    identity: Bee\n');
    const cfg = loadConfig();
    const a = findRole(cfg, 'A');
    expect(a.harness).toBe('claude-code');
    expect(a.max_tokens).toBe(500000);
    expect(a.identity).toBe('A');
    const b = findRole(cfg, 'B');
    expect(b.harness).toBe('other');
    expect(b.max_tokens).toBe(100);
    expect(b.identity).toBe('Bee');
  });

  it('defaults harness to claude-code with no defaults section', () => {
    base('roles:\n  A: {}\n');
    expect(findRole(loadConfig(), 'A').harness).toBe('claude-code');
  });

  it('rejects invalid role names', () => {
    base('roles:\n  "foo bar": {}\n');
    expect(() => loadConfig()).toThrowError(/invalid role name/);
  });

  it('rejects unknown role keys with the allowed list', () => {
    base('roles:\n  A:\n    persnoa: oops\n');
    expect(() => loadConfig()).toThrowError(/persnoa.*allowed:.*persona/s);
  });

  it('accepts a per-role model field', () => {
    base('roles:\n  A:\n    model: claude-fable-5\n  B: {}\n');
    const cfg = loadConfig();
    expect(cfg.roles.find(r => r.name === 'A')!.model).toBe('claude-fable-5');
    expect(cfg.roles.find(r => r.name === 'B')!.model).toBeUndefined();
  });

  it('still rejects an unknown role key', () => {
    base('roles:\n  A:\n    modell: oops\n');
    expect(() => loadConfig()).toThrowError(/unknown key/);
  });

  it('rejects drop-ins defining more than roles', () => {
    base('roles: {}\n');
    dropin('bad.yaml', 'vars:\n  x: 1\nroles: {}\n');
    expect(() => loadConfig()).toThrowError(/may only define roles/);
  });

  it('throws for an explicit missing config path', () => {
    expect(() => loadConfig(join(dir, 'nope.yaml'))).toThrowError(ConfigError);
  });

  it('findRole throws for unknown names', () => {
    base('roles:\n  A: {}\n');
    expect(() => findRole(loadConfig(), 'Z')).toThrowError(/no such role 'Z'/);
  });
});
