import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeLaunchContextAuthority, composeAgentRuntimeChildContext,
  createProductionAgentLaunchComposition } from '../src/agent-production-launch-composition.js';

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe('production Agent launch composition', () => {
  it('constructs one non-live creation/launch authority graph without touching trusted state', () => {
    const trustedStateRoot = mkdtempSync(join(tmpdir(), 'production-launch-')); dirs.push(trustedStateRoot);
    const assembly = createProductionAgentLaunchComposition({ trustedStateRoot,
      identityProvisioner: { exists: async () => false, inspect: async () => ({ state: 'absent' as const }),
        create: async () => ({ state: 'created_here' as const, cid: 'A'.repeat(64) }) },
      identityProfile: {}, now: () => 1 });
    expect(assembly).toMatchObject({ creation: { root: expect.any(Object), ingress: expect.any(Object) },
      launch: expect.any(Object) });
    expect(readdirSync(trustedStateRoot)).toEqual([]);
    expect(Object.keys(assembly)).toEqual(['creation', 'launch', 'runtimeLaunchContexts']);
  });

  it('issues exact same-instance single-use runtime launch contexts without persisting or aliasing env', () => {
    const authority = new AgentRuntimeLaunchContextAuthority();
    const input = { agentId: 'A', generation: 1, actionId: 'start-1', sessionRequestId: 'session-1',
      sessionRequest: { name: 'A', cwd: '/trusted/cwd', stateDir: '/trusted/state', mode: 'fresh' }, cwd: '/trusted/cwd',
      env: { PATH: '/bin', HOME: '/private/home', OURS_TOKEN: 'secret',
        OURS_FLEET_PROXY_CALLER: 'A', OURS_FLEET_PROXY_STATE_DIR: '/trusted/state' } };
    const evidence = authority.issue(input); input.env.PATH = 'mutated';
    const expected = { agentId: 'A', generation: 1, actionId: 'start-1', sessionRequestId: 'session-1',
      sessionRequest: { name: 'A', cwd: '/trusted/cwd', stateDir: '/trusted/state', mode: 'fresh' } };
    expect(authority.consume(Object.freeze({ ...evidence }), expected)).toBeUndefined();
    for (const mismatch of [
      { ...expected, agentId: 'B' }, { ...expected, generation: 2 }, { ...expected, actionId: 'start-2' },
      { ...expected, sessionRequestId: 'session-2' },
      { ...expected, sessionRequest: { ...expected.sessionRequest, cwd: '/changed' } },
    ]) { const rejected = authority.issue(input); expect(authority.consume(rejected, mismatch)).toBeUndefined();
      expect(authority.consume(rejected, expected)).toBeUndefined(); }
    const consumed = authority.consume(evidence, expected)!;
    expect(consumed).toEqual({ cwd: '/trusted/cwd', env: { PATH: '/bin', HOME: '/private/home', OURS_TOKEN: 'secret',
      OURS_FLEET_PROXY_CALLER: 'A', OURS_FLEET_PROXY_STATE_DIR: '/trusted/state' } });
    expect(Object.isFrozen(consumed)).toBe(true); expect(Object.isFrozen(consumed.env)).toBe(true);
    expect(authority.consume(evidence, expected)).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain('secret');
    const foreign = new AgentRuntimeLaunchContextAuthority();
    expect(foreign.consume(authority.issue(input), expected)).toBeUndefined();
    const accessorRequest = { name: 'A', cwd: '/trusted/cwd' };
    Object.defineProperty(accessorRequest, 'mode', { enumerable: true, get: () => 'fresh' });
    expect(() => authority.issue({ ...input, sessionRequest: accessorRequest })).toThrow('runtime launch context unavailable');
    expect(() => authority.issue({ ...input, cwd: '/changed' })).toThrow('runtime launch context unavailable');
  });

  it('rejects malformed/accessor context inputs with one stable error before invoking getters or issuing evidence', () => {
    const authority = new AgentRuntimeLaunchContextAuthority(); let getterCalls = 0;
    const base = { agentId: 'A', generation: 1, actionId: 'start-1', sessionRequestId: 'request-1',
      sessionRequest: { name: 'A', cwd: '/work', stateDir: '/state', mode: 'fresh' }, cwd: '/work',
      env: { OURS_FLEET_PROXY_CALLER: 'A', OURS_FLEET_PROXY_STATE_DIR: '/state' } };
    const malformed: unknown[] = [{ ...base, env: undefined }, { ...base, env: null }, { ...base, env: [] }];
    const envAccessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(envAccessor, 'env', { enumerable: true, get: () => { getterCalls++; throw new Error('secret'); } });
    malformed.push(envAccessor);
    const proxyAccessor = { OURS_FLEET_PROXY_STATE_DIR: '/state' };
    Object.defineProperty(proxyAccessor, 'OURS_FLEET_PROXY_CALLER', {
      enumerable: true, get: () => { getterCalls++; throw new Error('secret'); },
    });
    malformed.push({ ...base, env: proxyAccessor });
    malformed.push({ ...base, env: { ...base.env, [Symbol('secret')]: 'x' } });
    const nonEnumerable = { ...base.env }; Object.defineProperty(nonEnumerable, 'hidden', { value: 'secret' });
    malformed.push({ ...base, env: nonEnumerable });
    const topAccessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(topAccessor, 'agentId', { enumerable: true, get: () => { getterCalls++; return 'A'; } });
    malformed.push(topAccessor);
    for (const value of malformed) expect(() => authority.issue(value as never)).toThrowError(
      new TypeError('runtime launch context unavailable'));
    expect(getterCalls).toBe(0);
    const evidence = authority.issue(base);
    expect(authority.consume(evidence, { agentId: 'A', generation: 1, actionId: 'start-1',
      sessionRequestId: 'request-1', sessionRequest: base.sessionRequest })).toBeDefined();
  });

  it('composes ordinary env precedence while rejecting reserved/model conflicts and scrubbing autostart', () => {
    const context = { cwd: '/work', env: { PATH: '/role/bin', HOME: '/home/role', ORDINARY: 'role',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5', OURS_AUTOSTART: '1' } };
    expect(composeAgentRuntimeChildContext({ PATH: '/adapter/bin', ORDINARY: 'adapter' }, context,
      'claude-code-acp', 'claude-sonnet-4-5', false)).toEqual({ cwd: '/work', env: {
      PATH: '/role/bin', HOME: '/home/role', ORDINARY: 'role', ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    } });
    expect(() => composeAgentRuntimeChildContext({ ANTHROPIC_MODEL: 'claude-sonnet-4-5' },
      { cwd: '/work', env: { ANTHROPIC_MODEL: 'claude-opus-4-1' } }, 'claude-code-acp',
      'claude-sonnet-4-5', false)).toThrow('runtime launch context unavailable');
    expect(() => composeAgentRuntimeChildContext({}, { cwd: '/work', env: {
      OURS_FLEET_CODEX_DISABLE_INHERITED_MCP: '0' } }, 'codex-acp', 'gpt-5', true))
      .toThrow('runtime launch context unavailable');
    for (const key of ['ANTHROPIC_BASE_URL', 'CODEX_APPROVAL', 'CODEX_SANDBOX',
      'OURS_FLEET_CODEX_APPROVAL', 'OURS_FLEET_CODEX_SANDBOX', 'OURS_FLEET_REAL_CODEX_PATH',
      'OURS_FLEET_CODEX_ACP_MANIFEST']) {
      expect(() => composeAgentRuntimeChildContext({ [key]: 'trusted' }, { cwd: '/work', env: { [key]: 'role' } },
        'codex-acp', 'gpt-5', false), key).toThrow('runtime launch context unavailable');
      expect(composeAgentRuntimeChildContext({ [key]: 'same' }, { cwd: '/work', env: { [key]: 'same' } },
        'codex-acp', 'gpt-5', false).env[key], key).toBe('same');
    }
    expect(composeAgentRuntimeChildContext({ CODEX_PATH: '/fleet/proxy' },
      { cwd: '/work', env: { CODEX_PATH: '/operator/codex' } }, 'codex-acp', 'gpt-5', false).env)
      .toMatchObject({ CODEX_PATH: '/fleet/proxy', OURS_FLEET_REAL_CODEX_PATH: '/operator/codex' });
  });

  it('carries a realistic authenticated runtime context into the exact child environment', () => {
    const authority = new AgentRuntimeLaunchContextAuthority();
    const sessionRequest = { name: 'agent-1', cwd: '/work', stateDir: '/state/agent-1', mode: 'fresh',
      permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' } };
    const evidence = authority.issue({ agentId: 'agent-1', generation: 1, actionId: 'create-1',
      sessionRequestId: 'request-1', sessionRequest, cwd: '/work', env: {
        OURS_FLEET_PROXY_CALLER: 'agent-1', OURS_FLEET_PROXY_STATE_DIR: '/state/agent-1',
        OURS_CONFIG: '/config/fleet.yaml', OURS_TOKEN: 'ours-secret', HOME: '/home/agent',
        CODEX_HOME: '/state/agent-1/codex-home', OPENAI_API_KEY: 'openai-secret', CODEX_PATH: '/operator/codex',
      } });
    const context = authority.consume(evidence, { agentId: 'agent-1', generation: 1, actionId: 'create-1',
      sessionRequestId: 'request-1', sessionRequest })!;
    const child = composeAgentRuntimeChildContext({ CODEX_PATH: '/state/agent-1/codex-proxy',
      OURS_FLEET_CODEX_APPROVAL: 'never', OURS_FLEET_CODEX_SANDBOX: 'workspace-write',
      OURS_FLEET_CODEX_ACP_MANIFEST: '/pkg/package.json' }, context, 'codex-acp', 'gpt-5', false);
    expect(child).toEqual({ cwd: '/work', env: {
      CODEX_PATH: '/state/agent-1/codex-proxy', OURS_FLEET_CODEX_APPROVAL: 'never',
      OURS_FLEET_CODEX_SANDBOX: 'workspace-write', OURS_FLEET_CODEX_ACP_MANIFEST: '/pkg/package.json',
      OURS_FLEET_PROXY_CALLER: 'agent-1', OURS_FLEET_PROXY_STATE_DIR: '/state/agent-1',
      OURS_CONFIG: '/config/fleet.yaml', OURS_TOKEN: 'ours-secret', HOME: '/home/agent',
      CODEX_HOME: '/state/agent-1/codex-home', OPENAI_API_KEY: 'openai-secret',
      OURS_FLEET_REAL_CODEX_PATH: '/operator/codex', OURS_FLEET_CODEX_DISABLE_INHERITED_MCP: '0',
    } });
    expect(() => authority.issue({ agentId: 'other', generation: 1, actionId: 'create-1',
      sessionRequestId: 'request-2', sessionRequest, cwd: '/work', env: {
        OURS_FLEET_PROXY_CALLER: 'agent-1', OURS_FLEET_PROXY_STATE_DIR: '/state/agent-1' } }))
      .toThrow('runtime launch context unavailable');
    expect(() => authority.issue({ agentId: 'agent-1', generation: 1, actionId: 'create-1',
      sessionRequestId: 'request-3', sessionRequest, cwd: '/work', env: {
        OURS_FLEET_PROXY_CALLER: 'agent-1', OURS_FLEET_PROXY_STATE_DIR: '/other' } }))
      .toThrow('runtime launch context unavailable');
    expect(() => authority.issue({ agentId: 'agent-1', generation: 1, actionId: 'create-1',
      sessionRequestId: 'request-4', sessionRequest, cwd: '/work', env: {} }))
      .toThrow('runtime launch context unavailable');
    expect(() => composeAgentRuntimeChildContext({ OURS_FLEET_PROXY_CALLER: 'prepared' }, {
      cwd: '/work', env: { OURS_FLEET_PROXY_CALLER: 'agent-1', OURS_FLEET_PROXY_STATE_DIR: '/state/agent-1' },
    }, 'codex-acp', 'gpt-5', false)).toThrow('runtime launch context unavailable');
  });
});
