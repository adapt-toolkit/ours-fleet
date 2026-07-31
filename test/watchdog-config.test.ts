import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-')); process.env.OURS_FLEET_HOME = dir; });
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(dir, { recursive: true, force: true }); });
const base = (s: string) => writeFileSync(join(dir, 'fleet.yaml'), s);

const TWO_ROLES = 'roles:\n  Alice: {}\n  Docs: {}\n';

describe('watchdogs config', () => {
  it('resolves defaults for a minimal watchdog', () => {
    base(TWO_ROLES + 'watchdogs:\n  nightwatch:\n    coordinator: FleetCoordinator\n');
    const wd = loadConfig().watchdogs[0];
    expect(wd).toMatchObject({
      name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
      intervalMs: 600_000, watch: ['Alice', 'Docs'], harness: 'claude-code',
      session: 'tmux', identity: 'Watchdog-nightwatch',
      timeoutMs: 300_000, keepReports: 50, alertCooldownMs: 3_600_000,
    });
    expect(wd.promptFile).toBeUndefined();
  });
  it('returns [] when no watchdogs block exists', () => {
    base(TWO_ROLES);
    expect(loadConfig().watchdogs).toEqual([]);
  });
  it('inherits defaults.harness/session/model like roles do', () => {
    base('defaults: { harness: claude-code, session: acp, model: claude-fable-5 }\n'
      + TWO_ROLES + 'watchdogs:\n  w: { coordinator: C }\n');
    const wd = loadConfig().watchdogs[0];
    expect(wd.session).toBe('acp');
    expect(wd.model).toBe('claude-fable-5');
  });
  it('substitutes ${var} from vars:', () => {
    base('vars: { coord: FleetCoordinator }\n' + TWO_ROLES
      + 'watchdogs:\n  w: { coordinator: "${coord}" }\n');
    expect(loadConfig().watchdogs[0].coordinator).toBe('FleetCoordinator');
  });
  it('rejects an unknown key so a typo cannot silently disarm', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, intervall: 5m }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'w' has unknown key\(s\) intervall/);
  });
  it('requires coordinator', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { interval: 10m }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'w'.*coordinator/);
  });
  it('rejects a watch entry naming a missing role', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, watch: [Alice, Ghost] }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'w'.*watch.*'Ghost'/);
  });
  it('rejects a name colliding with a role', () => {
    base(TWO_ROLES + 'watchdogs:\n  Alice: { coordinator: C }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'Alice' collides with a role name/);
  });
  it('rejects an identity colliding with a role name or identity', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, identity: Alice }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'w'.*identity 'Alice' collides/);
  });
  it('enforces the 1m interval minimum and duration syntax', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, interval: 30s }\n');
    expect(() => loadConfig()).toThrowError(/interval.*minimum.*1m/);
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, interval: soon }\n');
    expect(() => loadConfig()).toThrowError(/invalid duration 'soon'/);
  });
  it('requires prompt_file to be an absolute path to an existing file', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, prompt_file: rel.md }\n');
    expect(() => loadConfig()).toThrowError(/prompt_file.*absolute/);
    base(TWO_ROLES + `watchdogs:\n  w: { coordinator: C, prompt_file: ${join(dir, 'missing.md')} }\n`);
    expect(() => loadConfig()).toThrowError(/prompt_file.*not found/);
  });
  it('rejects invalid names and enabled: false disables scheduling but keeps the entry', () => {
    base(TWO_ROLES + 'watchdogs:\n  "bad name": { coordinator: C }\n');
    expect(() => loadConfig()).toThrowError(/invalid watchdog name/);
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, enabled: false }\n');
    expect(loadConfig().watchdogs[0].enabled).toBe(false);
  });
  it('is rejected in fleet.d drop-ins (roles-only rule already enforced)', () => {
    base(TWO_ROLES);
    mkdirSync(join(dir, 'fleet.d'), { recursive: true });
    writeFileSync(join(dir, 'fleet.d', 'w.yaml'), 'watchdogs:\n  w: { coordinator: C }\n');
    expect(() => loadConfig()).toThrowError(/fleet.d files may only define roles:/);
  });
});
