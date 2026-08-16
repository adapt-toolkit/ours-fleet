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
      name: 'DeveloperX', harness: 'codex', session: 'acp', model: 'gpt-test',
      cwd: '/work/project', coordinator: 'Coordinator',
      approval: 'allow', filesystem: 'unrestricted', unattended: 'deny',
      monitorConfig: { mode: 'fleet', interrupt: true },
      configPath: '/fleet.yaml', surface: 'agent', callerRole: 'Coordinator',
    });
    expect(result.options.inheritedFromCaller).toEqual(result.inherited);
    expect(result.inherited).toEqual([
      'harness', 'session', 'cwd', 'coordinator', 'approval', 'filesystem', 'unattended',
      'monitorConfig', 'model',
    ]);
  });

  it('preserves explicit overrides and does not copy a model across harnesses', () => {
    const result = inheritCallerSpawnDefaults(caller, {
      name: 'ClaudeWorker', harness: 'claude-code', session: 'tmux', cwd: '/other',
      approval: 'ask', model: 'claude-explicit',
    }, undefined);
    expect(result.options).toMatchObject({
      harness: 'claude-code', session: 'tmux', cwd: '/other', approval: 'ask',
      model: 'claude-explicit', coordinator: 'Coordinator',
    });
    expect(result.inherited).not.toEqual(expect.arrayContaining([
      'harness', 'session', 'cwd', 'approval', 'model',
    ]));

    const harnessOnly = inheritCallerSpawnDefaults(
      caller, { name: 'ClaudeDefault', harness: 'claude-code' }, undefined);
    expect(harnessOnly.options.model).toBeUndefined();
    expect(harnessOnly.inherited).not.toContain('model');
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

  it('fails closed when omitted inheritance cannot be normalized', () => {
    const unsupported = { ...caller, harness: 'missing-adapter' } satisfies ResolvedRole;
    expect(() => inheritCallerSpawnDefaults(unsupported, { name: 'Child' }, undefined))
      .toThrow(/unknown harness/);
    // An explicit policy does not need an unsupported caller mapping.
    expect(inheritCallerSpawnDefaults(
      unsupported, { name: 'Child', approval: 'ask' }, undefined).options.approval).toBe('ask');
  });
});
