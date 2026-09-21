import { expect, it } from 'vitest';
import type { ResolvedRole } from '../src/config.js';
import { managedClaudeMeta, prepareManagedHarness } from '../src/agent-ours/harness.js';

it('replaces the standard ours plugin while preserving Codex settings and Fleet proxy environment', () => {
  const prepared = prepareManagedHarness({ harness: 'codex' } as ResolvedRole, '/state', '/work', '/descriptor', {
    OURS_CONFIG: '/private/profile', OURS_LEASE_TOKEN: 'private', OURS_FLEET_PROXY: 'scoped',
    CODEX_CONFIG: JSON.stringify({ model: 'test', plugins: { unrelated: { enabled: true } } }),
  });
  expect(prepared.env).not.toHaveProperty('OURS_CONFIG');
  expect(prepared.env).not.toHaveProperty('OURS_LEASE_TOKEN');
  expect(prepared.env.OURS_FLEET_PROXY).toBe('scoped');
  expect(JSON.parse(prepared.env.CODEX_CONFIG)).toEqual({ model: 'test', plugins: {
    unrelated: { enabled: true }, 'ours@ours-codex-marketplace': { enabled: false },
  } });
  expect(prepared.ours.server.name).toBe('ours');
  expect(prepared.env.DISABLE_MCP_CONFIG_FILTERING).toBe('true');
});

it('preserves Claude hooks, other plugins and session metadata', () => {
  const original = { custom: 'retained', claudeCode: { options: { strictMcpConfig: true,
    settings: { hooks: { SessionStart: ['existing'] }, enabledPlugins: {
      unrelated: true, 'ours@ours.network': true,
    } },
  } } };
  expect(managedClaudeMeta(original)).toEqual({ custom: 'retained', claudeCode: { options: {
    strictMcpConfig: true, settings: { hooks: { SessionStart: ['existing'] }, enabledPlugins: {
      unrelated: true, 'ours@ours.network': false,
    } },
  } } });
  expect(original.claudeCode.options.settings.enabledPlugins['ours@ours.network']).toBe(true);
});
