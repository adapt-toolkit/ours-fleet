import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  home, stateRoot, agentsRoot, tmpRoot, logsRoot, agentDir, defaultConfigPath, fleetDDir,
  deriveXdgRuntimeDir,
} from '../src/paths.js';

describe('paths', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.OURS_FLEET_HOME; process.env.OURS_FLEET_HOME = '/x'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.OURS_FLEET_HOME;
    else process.env.OURS_FLEET_HOME = saved;
  });

  it('derives everything from OURS_FLEET_HOME', () => {
    expect(home()).toBe('/x');
    expect(stateRoot()).toBe('/x/.ours-fleet');
    expect(agentsRoot()).toBe('/x/.ours-fleet/agents');
    expect(tmpRoot()).toBe('/x/.ours-fleet/tmp');
    expect(logsRoot()).toBe('/x/.ours-fleet/logs');
    expect(agentDir('A')).toBe('/x/.ours-fleet/agents/A');
    expect(agentDir('A', true)).toBe('/x/.ours-fleet/tmp/A');
    expect(defaultConfigPath()).toBe('/x/fleet.yaml');
    expect(fleetDDir()).toBe('/x/fleet.d');
  });

  it('falls back to os homedir without the env var', () => {
    delete process.env.OURS_FLEET_HOME;
    expect(home().length).toBeGreaterThan(0);
    expect(home()).not.toBe('/x');
  });
});

describe('deriveXdgRuntimeDir (#9)', () => {
  it('derives /run/user/<uid> when unset and the dir exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const got = deriveXdgRuntimeDir(env, 1234, p => p === '/run/user/1234');
    expect(got).toBe('/run/user/1234');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1234');
  });

  it('never overrides an existing value', () => {
    const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: '/run/user/999' };
    const got = deriveXdgRuntimeDir(env, 1234, () => true);
    expect(got).toBe('/run/user/999');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/999');
  });

  it('leaves env untouched when /run/user/<uid> does not exist (linger off)', () => {
    const env: NodeJS.ProcessEnv = {};
    const got = deriveXdgRuntimeDir(env, 1234, () => false);
    expect(got).toBeUndefined();
    expect('XDG_RUNTIME_DIR' in env).toBe(false);
  });
});
