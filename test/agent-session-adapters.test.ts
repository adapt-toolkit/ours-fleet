import { describe, expect, it, vi } from 'vitest';

import type { ResolvedRole } from '../src/config.js';
import type { Exec } from '../src/exec.js';
import { makeClaudeCodeAdapter } from '../src/harness/claude-code.js';
import { makeCodexAdapter } from '../src/harness/codex.js';
import type { AgentSessionStartOptions } from '../src/harness/agent-session.js';
import type { SessionPrep } from '../src/harness/types.js';
import type { AgentSession } from '../src/session/types.js';

const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
const session = { backend: 'acp', pid: 42 } as AgentSession;
const permissions = { approval: 'allow', filesystem: 'workspace', unattended: 'deny' } as const;

function role(harness: 'codex' | 'claude-code', extra: Partial<ResolvedRole> = {}): ResolvedRole {
  return {
    name: 'Worker', identity: 'Worker', harness, session: 'acp', permissions,
    permissionsDeclared: true,
    monitor: { mode: 'native', enabled: false, wake_sources: [], batch_ms: 0,
      inject: 'notification', interrupt: false },
    sourceFile: 'test', ...extra,
  } as ResolvedRole;
}

async function start(
  adapter: ReturnType<typeof makeCodexAdapter> | ReturnType<typeof makeClaudeCodeAdapter>,
  resolvedRole: ResolvedRole, prep: SessionPrep, mode: 'fresh' | 'resume' = 'resume',
) {
  const prepared = adapter.agentSession.prepareLaunch(resolvedRole, prep);
  const options: AgentSessionStartOptions = {
    role: resolvedRole, prep,
    launch: { ...prepared, argv: ['wrapped', ...prepared.argv] },
    cwd: '/work', stateDir: '/state', mode, permissions,
    permissionMode: { fleetMode: 'allow', nativeMode: 'native-mode' }, log: () => {},
  };
  return adapter.agentSession.start(options);
}

describe('production agent-session adapters', () => {
  it('Codex preserves mode, isolation-wrapped argv, initial mode, and trusted provenance', async () => {
    const transport = vi.fn(async () => session);
    const adapter = makeCodexAdapter(exec, transport);
    const resolvedRole = role('codex');

    await expect(start(adapter, resolvedRole, { env: { ROLE: '1' } }, 'resume')).resolves.toBe(session);

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Worker', argv: expect.arrayContaining(['wrapped']), env: expect.objectContaining({
        ROLE: '1', INITIAL_AGENT_MODE: 'agent-full-access',
      }), cwd: '/work', stateDir: '/state', mode: 'resume', modeId: 'agent-full-access',
      permissionMetadataSource: 'codex-acp', scrubObsoleteOursAutostart: true,
    }));
  });

  it('Codex treats an operator-selected ACP command as untrusted', async () => {
    const transport = vi.fn(async () => session);
    const adapter = makeCodexAdapter(exec, transport);
    const resolvedRole = role('codex', { session_options: { acp: { command: ['custom-acp'] } } });

    await start(adapter, resolvedRole, { env: {} }, 'fresh');

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['wrapped', 'custom-acp'], mode: 'fresh', permissionMetadataSource: undefined,
    }));
  });

  it('Claude preserves settings, strict MCP configuration, servers, and has no Codex provenance', async () => {
    const transport = vi.fn(async () => session);
    const adapter = makeClaudeCodeAdapter(exec, transport);
    const resolvedRole = role('claude-code', { harness_options: {
      mcp_servers_only: true,
      mcp_servers: { ours: { command: 'ours-mcp', args: ['serve'], env: { TOKEN: 'x' } } },
    } });

    await expect(start(adapter, resolvedRole, {
      env: { ROLE: '1' }, settingsOverlay: '/state/settings.json',
    })).resolves.toBe(session);

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Worker', argv: expect.arrayContaining(['wrapped']), env: { ROLE: '1' },
      mode: 'resume', modeId: 'bypassPermissions', permissionMetadataSource: undefined,
      mcpServers: [{ name: 'ours', command: 'ours-mcp', args: ['serve'],
        env: [{ name: 'TOKEN', value: 'x' }] }],
      sessionMeta: { claudeCode: { options: {
        settings: '/state/settings.json', strictMcpConfig: true,
      } } },
      scrubObsoleteOursAutostart: true,
    }));
  });
});
