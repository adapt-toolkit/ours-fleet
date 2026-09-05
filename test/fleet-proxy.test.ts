import { describe, expect, it } from 'vitest';

import { inheritCallerSpawnDefaults } from '../src/fleet-proxy.js';
import { managedFleetProxyEnv } from '../src/runner.js';
import type { ResolvedRole } from '../src/config.js';
import '../src/harness/codex.js';
import '../src/harness/claude-code.js';

const caller = {
  name: 'Coordinator', harness: 'codex', session: 'acp', identity: 'Coordinator',
  cwd: '/work/project', model: 'gpt-test', sourceFile: '/fleet.yaml',
  permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'deny' },
  permissionsDeclared: true,
  agentSelections: { brain: { ref: 'codex' }, role: { ref: 'Coordinator' } },
  monitor: {
    mode: 'fleet', enabled: true, wake_sources: ['message_received'], batch_ms: 2_000,
    inject: 'notification', interrupt: true, turn_fail_threshold: 3,
  },
} satisfies ResolvedRole;

describe('managed fleet spawn defaults', () => {
  it('injects a supervisor-owned routing hint after role environment overrides', () => {
    const withEnv = {
      ...caller,
      env: {
        KEEP: 'yes', OURS_FLEET_PROXY_STATE_DIR: '/forged',
        OURS_FLEET_PROXY_CALLER: 'forged',
      },
    } satisfies ResolvedRole;
    expect(managedFleetProxyEnv(withEnv, '/state/Coordinator')).toMatchObject({
      KEEP: 'yes', OURS_FLEET_PROXY_STATE_DIR: '/state/Coordinator',
      OURS_FLEET_PROXY_CALLER: 'Coordinator',
    });
  });

  it('fills omitted execution defaults from the authenticated caller role', () => {
    const result = inheritCallerSpawnDefaults(caller, { name: 'DeveloperX' }, '/fleet.yaml');
    expect(result.options).toMatchObject({
      name: 'DeveloperX', brain: { ref: 'codex' }, role: { ref: 'Coordinator' },
      cwd: '/work/project', coordinator: 'Coordinator',
      approval: 'allow', filesystem: 'unrestricted', unattended: 'deny',
      monitorConfig: { mode: 'fleet', interrupt: true },
      configPath: '/fleet.yaml', surface: 'agent', callerRole: 'Coordinator',
    });
    expect(result.options.inheritedFromCaller).toEqual(result.inherited);
    expect(result.inherited).toEqual([
      'brain', 'role', 'cwd', 'coordinator', 'approval', 'filesystem', 'unattended',
      'monitorConfig',
    ]);
  });

  it('preserves explicit Brain and Role overrides', () => {
    const result = inheritCallerSpawnDefaults(caller, {
      name: 'ClaudeWorker', brain: { ref: 'claude' }, role: { ref: 'Worker' }, cwd: '/other',
      approval: 'ask',
    }, undefined);
    expect(result.options).toMatchObject({
      brain: { ref: 'claude' }, role: { ref: 'Worker' }, cwd: '/other', approval: 'ask',
      coordinator: 'Coordinator',
    });
    expect(result.inherited).not.toEqual(expect.arrayContaining([
      'brain', 'role', 'cwd', 'approval',
    ]));
  });

  it('preserves inherited parent effort while an explicit child Brain wins', () => {
    const parent = { ...caller, agentSelections: {
      brain: { inline: { harness: 'codex', model: 'gpt-parent', effort: 'high' } },
      role: { ref: 'Coordinator' },
    } } satisfies ResolvedRole;
    expect(inheritCallerSpawnDefaults(parent, { name: 'Inherited' }, undefined).options.brain)
      .toEqual({ inline: { harness: 'codex', model: 'gpt-parent', effort: 'high' } });
    expect(inheritCallerSpawnDefaults(parent, {
      name: 'Override', brain: { inline: { harness: 'codex', model: 'gpt-child', effort: 'low' } },
    }, undefined).options.brain)
      .toEqual({ inline: { harness: 'codex', model: 'gpt-child', effort: 'low' } });
  });

  it('inherits the caller effective mode after a native override, not its creation default', () => {
    const overridden = {
      ...caller,
      permissions: { ...caller.permissions, approval: 'ask' as const },
      harness_options: { approval: 'never' },
    } satisfies ResolvedRole;
    expect(inheritCallerSpawnDefaults(overridden, { name: 'Child' }, undefined)
      .options.approval).toBe('allow');
  });

  it('inherits configured ACP intent even when the live preset reports a narrower mode', () => {
    const workspaceCaller = {
      ...caller,
      permissions: { ...caller.permissions, filesystem: 'workspace' as const },
    } satisfies ResolvedRole;
    expect(inheritCallerSpawnDefaults(workspaceCaller, { name: 'Child' }, undefined)
      .options.approval).toBe('allow');
  });

  it('fails closed on sensitive inline Brain inheritance while explicit child Brain wins', () => {
    const sensitive = { ...caller, agentSelections: {
      brain: { inline: { harness: 'codex', harness_options: { API_TOKEN: 'sentinel' } } },
      role: { ref: 'Coordinator' },
    } } satisfies ResolvedRole;
    expect(() => inheritCallerSpawnDefaults(sensitive, { name: 'Child' }, undefined))
      .toThrow('caller inline Brain contains sensitive configuration; pass --brain explicitly');
    expect(inheritCallerSpawnDefaults(sensitive, {
      name: 'Child', brain: { ref: 'safe' },
    }, undefined).options.brain).toEqual({ ref: 'safe' });
  });
});
