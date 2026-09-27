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
  expect(JSON.parse(prepared.env.CODEX_CONFIG)).toMatchObject({ model: 'test', plugins: {
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


const messagingTools = {
  current_identity: { approval_mode: 'approve' },
  get_messages: { approval_mode: 'approve' },
  list_history: { approval_mode: 'approve' },
  list_contacts: { approval_mode: 'approve' },
  send_message: { approval_mode: 'approve' },
};

it('carries complete bound transport and exactly five tool approvals without changing sandbox or other config', () => {
  const input = { model: 'test', approval_policy: 'never', sandbox_mode: 'workspace-write',
    mcp_servers: { other: { url: 'https://example.test/mcp', tools: { read: { approval_mode: 'prompt' } } },
      ours: { command: '/old/connector' } },
    plugins: { unrelated: { enabled: true } } };
  const role = { harness: 'codex', permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    harness_options: { sandbox: 'workspace-write' } } as ResolvedRole;
  const prepared = prepareManagedHarness(role, '/state', '/work', '/bound/descriptor', {
    CODEX_CONFIG: JSON.stringify(input),
  });
  const config = JSON.parse(prepared.env.CODEX_CONFIG);
  const server = (prepared.ours.native.mcp_servers as Record<string, Record<string, unknown>>).ours;
  expect(server).toEqual({ command: process.execPath, args: prepared.ours.server.args,
    env: { FLEET_OURS_BRIDGE_DESCRIPTOR: '/bound/descriptor' }, tools: messagingTools });
  expect(config.mcp_servers.ours).toEqual(server);
  expect(config.mcp_servers.other).toEqual(input.mcp_servers.other);
  expect(config.approval_policy).toBe('never');
  expect(config.sandbox_mode).toBe('workspace-write');
  expect(config.plugins.unrelated).toEqual({ enabled: true });
  expect(prepared.env.FLEET_OURS_MANAGED).toBe('1');
  expect(prepared.ours.native).not.toHaveProperty('sandbox_mode');
  expect(prepared.ours.native).not.toHaveProperty('approval_policy');
});

it.each(['ask', 'auto', 'deny', undefined])('does not preapprove tools for portable approval %s', approval => {
  const prepared = prepareManagedHarness({ harness: 'codex', permissions: { approval } } as ResolvedRole,
    '/state', '/work', '/descriptor', { CODEX_CONFIG: '{}' });
  expect((prepared.ours.native.mcp_servers as any).ours).not.toHaveProperty('tools');
  expect(JSON.parse(prepared.env.CODEX_CONFIG).mcp_servers.ours).not.toHaveProperty('tools');
});

it('does not add Codex policy to other harnesses', () => {
  const prepared = prepareManagedHarness({ harness: 'claude-code', permissions: { approval: 'allow' } } as ResolvedRole,
    '/state', '/work', '/descriptor', { CODEX_CONFIG: '{"model":"preserved"}' });
  expect((prepared.ours.native.mcp_servers as any).ours).not.toHaveProperty('tools');
  expect(prepared.env.CODEX_CONFIG).toBe('{"model":"preserved"}');
});
