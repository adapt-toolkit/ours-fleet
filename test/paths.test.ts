import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  home, stateRoot, agentsRoot, tmpRoot, logsRoot, agentDir, defaultConfigPath, fleetDDir,
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
