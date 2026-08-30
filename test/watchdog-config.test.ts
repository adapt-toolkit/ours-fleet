import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { partitionRestartNames } from '../src/watchdog/config.js';
import type { FleetConfig } from '../src/config.js';
import type { ResolvedWatchdog } from '../src/watchdog/config.js';
import { writeV2Fixture } from './v2-fixture.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ours-fleet-wd-')); process.env.OURS_FLEET_HOME = dir; });
afterEach(() => { delete process.env.OURS_FLEET_HOME; rmSync(dir, { recursive: true, force: true }); });
const base = (s: string) => writeV2Fixture(join(dir, 'fleet.yaml'), s);

const TWO_ROLES = 'roles:\n  Alice: {}\n  Docs: {}\n';

describe('watchdogs config', () => {
  it('resolves defaults for a minimal watchdog', () => {
    base(TWO_ROLES + 'watchdogs:\n  nightwatch:\n    coordinator: FleetCoordinator\n');
    const wd = loadConfig().watchdogs[0];
    expect(wd).toMatchObject({
      name: 'nightwatch', coordinator: 'FleetCoordinator', enabled: true,
      intervalMs: 600_000, watch: ['Alice', 'Docs'], harness: 'claude-code',
      session: 'acp', identity: 'Watchdog-nightwatch',
      timeoutMs: 300_000, keepReports: 50, alertCooldownMs: 3_600_000,
    });
    expect(wd.promptFile).toBeUndefined();
    expect(wd.isolation).toBeUndefined();
    expect(wd.watchExplicit).toBe(false);
  });
  it('returns [] when no watchdogs block exists', () => {
    base(TWO_ROLES);
    expect(loadConfig().watchdogs).toEqual([]);
  });
  it('uses explicit watchdog Brain settings instead of forbidden manifest Brain defaults', () => {
    base('defaults: { harness: claude-code, session: acp, model: claude-fable-5 }\n'
      + TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, session: acp, model: claude-fable-5 }\n');
    const wd = loadConfig().watchdogs[0];
    expect(wd.session).toBe('acp');
    expect(wd.model).toBe('claude-fable-5');
  });
  it('rejects removed watchdog runtime fields with migration guidance', () => {
    const path = join(dir, 'fleet.yaml');
    mkdirSync(join(dir, 'fleet', 'agents'), { recursive: true });
    chmodSync(join(dir, 'fleet'), 0o700);
    chmodSync(join(dir, 'fleet', 'agents'), 0o700);
    writeFileSync(path, 'api_version: ours.network/fleet/v2\nwatchdogs:\n  w: { coordinator: C, harness: codex }\n');
    chmodSync(path, 0o600);
    expect(() => loadConfig(path)).toThrowError(/E_LEGACY.*harness.*canonical Agent/);
  });
  it('substitutes ${var} from vars:', () => {
    base('vars: { coord: FleetCoordinator }\n' + TWO_ROLES
      + 'watchdogs:\n  w: { coordinator: "${coord}" }\n');
    expect(loadConfig().watchdogs[0].coordinator).toBe('FleetCoordinator');
  });
  it('records that an explicit watch list must remain exact at run time', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, watch: [Docs] }\n');
    expect(loadConfig().watchdogs[0]).toMatchObject({ watch: ['Docs'], watchExplicit: true });
  });
  it('rejects an unknown key so a typo cannot silently disarm', () => {
    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, intervall: 5m }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'w' has unknown key\(s\) intervall/);
  });
  it('parses watchdog isolation only when explicitly configured', () => {
    base(TWO_ROLES + 'watchdogs:\n  w:\n    coordinator: C\n    isolation:\n      backend: bubblewrap\n      network: deny\n      fs: { read: [/opt/tools] }\n');
    expect(loadConfig().watchdogs[0].isolation).toEqual({
      backend: 'bubblewrap', network: 'deny', fs: { read: ['/opt/tools'] },
    });

    base(TWO_ROLES + 'watchdogs:\n  w: { coordinator: C, isolation: { network: typo } }\n');
    expect(() => loadConfig()).toThrowError(/WatchdogAgentw.*isolation.network: invalid value 'typo'/);
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
  it('rejects two watchdogs sharing an explicit identity to prevent shared temp state and locks', () => {
    base(TWO_ROLES + 'watchdogs:\n  w1: { coordinator: C, identity: Shared }\n  w2: { coordinator: C, identity: Shared }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'w2': identity 'Shared' collides with watchdog 'w1'/);
  });
  it('rejects an implicit default identity colliding with another watchdog\'s explicit identity', () => {
    base(TWO_ROLES + 'watchdogs:\n  nightwatch: { coordinator: C, identity: Watchdog-other }\n  other: { coordinator: C }\n');
    expect(() => loadConfig()).toThrowError(/watchdog 'other': identity 'Watchdog-other' collides with watchdog 'nightwatch'/);
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
  it('rejects the legacy fleet.d mechanism before loading watchdog entries', () => {
    base(TWO_ROLES);
    mkdirSync(join(dir, 'fleet.d'), { recursive: true });
    writeFileSync(join(dir, 'fleet.d', 'w.yaml'),
      'api_version: ours.network/fleet/v2\nwatchdogs:\n  w: { coordinator: C }\n');
    expect(() => loadConfig()).toThrowError(/legacy fleet.d configuration is unsupported/);
  });
});

describe('partitionRestartNames', () => {
  // partitionRestartNames only reads cfg.watchdogs, so a minimal fake config
  // (just the watchdog names that matter for dispatch) is enough here.
  const cfgWith = (...watchdogNames: string[]): FleetConfig => ({
    roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
    watchdogs: watchdogNames.map(name => ({ name }) as unknown as ResolvedWatchdog),
  });

  it('splits a mixed list into watchdogNames and roleNames, preserving order', () => {
    const cfg = cfgWith('w1', 'w2');
    expect(partitionRestartNames(cfg, ['A', 'w1', 'B', 'w2', 'C']))
      .toEqual({ watchdogNames: ['w1', 'w2'], roleNames: ['A', 'B', 'C'] });
  });

  it('an all-watchdog list yields empty roleNames', () => {
    const cfg = cfgWith('w1', 'w2');
    expect(partitionRestartNames(cfg, ['w2', 'w1']))
      .toEqual({ watchdogNames: ['w2', 'w1'], roleNames: [] });
  });

  it('an all-role/unknown-name list puts everything in roleNames (unknown names are roles\' problem — findRole errors later)', () => {
    const cfg = cfgWith('w1');
    expect(partitionRestartNames(cfg, ['A', 'Ghost']))
      .toEqual({ watchdogNames: [], roleNames: ['A', 'Ghost'] });
  });

  it('an empty list yields both empty', () => {
    const cfg = cfgWith('w1');
    expect(partitionRestartNames(cfg, [])).toEqual({ watchdogNames: [], roleNames: [] });
  });
});
