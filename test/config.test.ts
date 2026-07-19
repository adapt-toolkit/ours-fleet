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

  it('merges defaults.harness_options with per-role overrides', () => {
    base('defaults:\n  harness: codex\n  harness_options:\n    launcher: auto\n    sandbox: workspace-write\nroles:\n  A: {}\n  B:\n    harness_options:\n      sandbox: read-only\n      search: true\n');
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').harness_options).toEqual({ launcher: 'auto', sandbox: 'workspace-write' });
    expect(findRole(cfg, 'B').harness_options).toEqual({ launcher: 'auto', sandbox: 'read-only', search: true });
  });

  it('rejects a non-map defaults.harness_options', () => {
    base('defaults:\n  harness_options: nope\nroles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/defaults\.harness_options must be a map/);
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

  it('a role without model inherits defaults.model', () => {
    base('defaults:\n  model: claude-fable-5\nroles:\n  A: {}\n  B:\n    model: claude-opus-4-8\n');
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').model).toBe('claude-fable-5');
    expect(cfg.defaults.model).toBe('claude-fable-5');
  });

  it('a per-role model overrides defaults.model', () => {
    base('defaults:\n  model: claude-fable-5\nroles:\n  B:\n    model: claude-opus-4-8\n');
    expect(findRole(loadConfig(), 'B').model).toBe('claude-opus-4-8');
  });

  it('leaves model undefined when neither role nor defaults set it', () => {
    base('roles:\n  A: {}\n');
    expect(findRole(loadConfig(), 'A').model).toBeUndefined();
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

describe('loadConfig isolation', () => {
  it('accepts an isolation block at role level and round-trips it', () => {
    base('roles:\n  A:\n    isolation:\n      backend: bubblewrap\n      network: deny\n      fs:\n        write: [/work/a]\n        read: [/opt/tc]\n      resources:\n        mem: 2G\n        cpu: "1.5"\n        pids: 512\n      secrets: ["/h/tok:/run/secrets/tok"]\n');
    const a = findRole(loadConfig(), 'A') as any;
    expect(a.isolation.backend).toBe('bubblewrap');
    expect(a.isolation.network).toBe('deny');
    expect(a.isolation.fs.write).toEqual(['/work/a']);
    expect(a.isolation.resources.mem).toBe('2G');
    expect(a.isolation.secrets).toEqual(['/h/tok:/run/secrets/tok']);
  });

  it('leaves roles without isolation unchanged (undefined)', () => {
    base('roles:\n  A:\n    mission: plain\n');
    const a = findRole(loadConfig(), 'A') as any;
    expect(a.isolation).toBeUndefined();
  });

  it('applies defaults.isolation to roles lacking their own; role overrides', () => {
    base('defaults:\n  isolation:\n    backend: auto\n    on_unavailable: strict\nroles:\n  A: {}\n  B:\n    isolation:\n      backend: none\n');
    const cfg = loadConfig();
    const a = findRole(cfg, 'A') as any;
    const b = findRole(cfg, 'B') as any;
    expect(a.isolation.on_unavailable).toBe('strict');
    expect(b.isolation.backend).toBe('none');
  });

  it('interpolates ${vars} inside isolation paths', () => {
    base('vars:\n  root: /work\nroles:\n  A:\n    isolation:\n      fs:\n        write: ["${root}/a"]\n');
    const a = findRole(loadConfig(), 'A') as any;
    expect(a.isolation.fs.write).toEqual(['/work/a']);
  });

  it('rejects unknown isolation sub-keys with the allowed list', () => {
    base('roles:\n  A:\n    isolation:\n      netork: deny\n');
    expect(() => loadConfig()).toThrowError(/isolation.*netork.*allowed:.*network/s);
  });

  it('rejects an invalid backend enum value', () => {
    base('roles:\n  A:\n    isolation:\n      backend: docker\n');
    expect(() => loadConfig()).toThrowError(/isolation\.backend.*docker.*bubblewrap/s);
  });

  it('rejects an invalid network enum value', () => {
    base('roles:\n  A:\n    isolation:\n      network: firewall\n');
    expect(() => loadConfig()).toThrowError(/isolation\.network.*firewall.*broker/s);
  });

  it('rejects an invalid on_unavailable enum value', () => {
    base('roles:\n  A:\n    isolation:\n      on_unavailable: explode\n');
    expect(() => loadConfig()).toThrowError(/isolation\.on_unavailable.*explode.*warn/s);
  });

  it('rejects unknown keys under isolation.fs', () => {
    base('roles:\n  A:\n    isolation:\n      fs:\n        writeable: [/x]\n');
    expect(() => loadConfig()).toThrowError(/isolation\.fs.*writeable.*allowed:.*write/s);
  });

  it('rejects unknown keys under isolation.resources', () => {
    base('roles:\n  A:\n    isolation:\n      resources:\n        memory: 2G\n');
    expect(() => loadConfig()).toThrowError(/isolation\.resources.*memory.*allowed:.*mem/s);
  });
});

describe('loadConfig monitor', () => {
  it('resolves code-constant defaults when no monitor block is present', () => {
    base('roles:\n  A: {}\n');
    const a = findRole(loadConfig(), 'A');
    expect(a.monitor.enabled).toBe(true);
    expect(a.monitor.wake_sources).toEqual([
      'message_received', 'file_received', 'local_contact_request', 'pending_message',
    ]);
    expect(a.monitor.batch_ms).toBe(2000);
    expect(a.monitor.inject).toBe('notification');
  });

  it('inherits defaults.monitor.enabled and lets a role override it', () => {
    base('defaults:\n  monitor:\n    enabled: false\nroles:\n  A: {}\n  B:\n    monitor:\n      enabled: true\n');
    const cfg = loadConfig();
    expect(findRole(cfg, 'A').monitor.enabled).toBe(false);
    expect(findRole(cfg, 'B').monitor.enabled).toBe(true);
  });

  it('merges role monitor over defaults.monitor key-by-key', () => {
    base('defaults:\n  monitor:\n    batch_ms: 5000\nroles:\n  A:\n    monitor:\n      wake_sources: [message_received]\n');
    const a = findRole(loadConfig(), 'A');
    expect(a.monitor.batch_ms).toBe(5000);            // from defaults
    expect(a.monitor.wake_sources).toEqual(['message_received']); // from role
    expect(a.monitor.enabled).toBe(true);             // code default
  });

  it('accepts a role wake_sources subset', () => {
    base('roles:\n  A:\n    monitor:\n      wake_sources: [message_received, file_received]\n');
    expect(findRole(loadConfig(), 'A').monitor.wake_sources)
      .toEqual(['message_received', 'file_received']);
  });

  it('accepts inject: full (validated; delivery lands in phase 2)', () => {
    base('roles:\n  A:\n    monitor:\n      inject: full\n');
    expect(findRole(loadConfig(), 'A').monitor.inject).toBe('full');
  });

  it('rejects unknown monitor keys with the allowed list', () => {
    base('roles:\n  A:\n    monitor:\n      enabledd: true\n');
    expect(() => loadConfig()).toThrowError(/monitor.*enabledd.*allowed:.*enabled/s);
  });

  it('rejects an unknown wake_source', () => {
    base('roles:\n  A:\n    monitor:\n      wake_sources: [message_recieved]\n');
    expect(() => loadConfig()).toThrowError(/wake_sources.*message_recieved.*allowed:.*message_received/s);
  });

  it('rejects an invalid inject mode', () => {
    base('roles:\n  A:\n    monitor:\n      inject: firehose\n');
    expect(() => loadConfig()).toThrowError(/monitor\.inject.*firehose.*notification.*full/s);
  });

  it('rejects a non-numeric / negative batch_ms', () => {
    base('roles:\n  A:\n    monitor:\n      batch_ms: -5\n');
    expect(() => loadConfig()).toThrowError(/monitor\.batch_ms/);
  });

  it('rejects a non-map monitor block', () => {
    base('roles:\n  A:\n    monitor: nope\n');
    expect(() => loadConfig()).toThrowError(/monitor.*mapping/);
  });

  it('rejects a non-map defaults.monitor', () => {
    base('defaults:\n  monitor: nope\nroles:\n  A: {}\n');
    expect(() => loadConfig()).toThrowError(/defaults\.monitor must be a map/);
  });
});
