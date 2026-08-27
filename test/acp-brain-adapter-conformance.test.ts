import { describe, expect, it, vi } from 'vitest';

import type { ResolvedRole } from '../src/config.js';
import {
  getBodyBrainAdapterDescriptor, knownBodyBrainAdapterDescriptors,
  registerBodyBrainAdapterDescriptor,
} from '../src/harness/registry.js';
import type { AcpBodyBrainAdapterDescriptor } from '../src/harness/types.js';
import {
  AcpBodyBrainInjectedProvider, createAcpBodyBrainInjectedProvider,
  createAcpBodyBrainPreparedLaunch, AcpBodyBrainProviderError, type AcpBodyBrainInjectedDriver,
  type AcpBodyBrainPreparedLaunch,
} from '../src/session/acp-body-brain-provider.js';

const digest = `sha256:${'a'.repeat(64)}`;
const launch = (
  adapterId: 'codex-acp' | 'claude-code-acp' = 'codex-acp',
): AcpBodyBrainPreparedLaunch => ({
  schemaVersion: 1,
  adapterId,
  adapterVersion: adapterId === 'codex-acp' ? '1.1.7' : '0.63.0',
  argv: ['node', `/bundled/${adapterId}.js`],
  env: { ROLE_ENV: 'owned' },
  translation: adapterId === 'codex-acp'
    ? { model: 'gpt-5.6-sol', effort: 'xhigh', modeId: 'agent', permissionMetadataSource: 'codex-acp' }
    : { model: 'claude-opus-4-6', effort: 'high', modeId: 'acceptEdits', mcpServers: [] },
});

function descriptor(
  harnessId: 'codex' | 'claude-code',
): AcpBodyBrainAdapterDescriptor {
  const adapterId = harnessId === 'codex' ? 'codex-acp' : 'claude-code-acp';
  return Object.freeze({
    schemaVersion: 1 as const, harnessId, adapterId,
    adapterVersion: harnessId === 'codex' ? '1.1.7' : '0.63.0',
    prepare: (_role: ResolvedRole) => createAcpBodyBrainPreparedLaunch(launch(adapterId)),
    createProvider: (prepared: Readonly<AcpBodyBrainPreparedLaunch>, driver: AcpBodyBrainInjectedDriver) =>
      createAcpBodyBrainInjectedProvider(prepared, driver),
  });
}

function fakeDriver(patch: Partial<AcpBodyBrainInjectedDriver> = {}) {
  const calls: string[] = [];
  let listener: ((notification: unknown) => void) | undefined;
  const accepted = async () => ({ state: 'accepted' as const });
  const driver: AcpBodyBrainInjectedDriver = {
    subscribe(value) { calls.push('subscribe'); listener = value; return () => { calls.push('unsubscribe'); listener = undefined; }; },
    async start(request) {
      calls.push(`start:${request.launch.adapterId}:${request.launch.translation.model}:${request.launch.translation.effort}`);
      return { state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest } };
    },
    async restore(request) {
      calls.push(`restore:${request.launch.adapterId}:${request.launch.translation.model}:${request.launch.translation.effort}`);
      return { state: 'accepted', sessionMetadata: request.lifecycle.sessionMetadata! };
    },
    async submit(_request, body) { calls.push(`submit:${new TextDecoder().decode(body)}`); return accepted(); },
    async respondPermission() { calls.push('permission'); return accepted(); },
    async cancel() { calls.push('cancel'); return accepted(); },
    async forceTerminate() { calls.push('force'); return accepted(); },
    async close() { calls.push('close'); return accepted(); },
    async retire() { calls.push('retire'); return accepted(); },
    async cleanup() { calls.push('cleanup'); },
    ...patch,
  };
  return { driver, calls, emit: (value: unknown) => listener?.(value) };
}

describe('Phase 4C BodyBrain descriptor registry', () => {
  it('fails closed while absent and owns exact production registrations deterministically', () => {
    expect(knownBodyBrainAdapterDescriptors()).toEqual([]);
    expect(() => getBodyBrainAdapterDescriptor('codex')).toThrow(/not registered/u);
    expect(() => getBodyBrainAdapterDescriptor('claude-code')).toThrow(/not registered/u);

    const mutable = { ...descriptor('codex') };
    expect(() => registerBodyBrainAdapterDescriptor(mutable)).toThrow(/exact frozen/u);
    const accessor = Object.freeze(Object.defineProperty({ ...descriptor('codex') }, 'adapterVersion', {
      enumerable: true, get: () => '1.1.7',
    })) as AcpBodyBrainAdapterDescriptor;
    expect(() => registerBodyBrainAdapterDescriptor(accessor)).toThrow(/exact frozen/u);
    expect(() => registerBodyBrainAdapterDescriptor(Object.freeze({
      ...descriptor('codex'), harnessId: 'other',
    }) as unknown as AcpBodyBrainAdapterDescriptor)).toThrow(/unknown production/u);
    expect(() => registerBodyBrainAdapterDescriptor(Object.freeze({
      ...descriptor('codex'), adapterId: 'claude-code-acp',
    }) as AcpBodyBrainAdapterDescriptor)).toThrow(/invalid BodyBrain/u);
    expect(() => registerBodyBrainAdapterDescriptor(Object.freeze({
      ...descriptor('codex'), adapterVersion: '9.9.9',
    }))).toThrow(/invalid BodyBrain/u);

    const codex = descriptor('codex'); const claude = descriptor('claude-code');
    registerBodyBrainAdapterDescriptor(codex);
    expect(getBodyBrainAdapterDescriptor('codex')).toBe(codex);
    expect(() => registerBodyBrainAdapterDescriptor(codex)).toThrow(/duplicate/u);
    expect(() => registerBodyBrainAdapterDescriptor(descriptor('codex'))).toThrow(/duplicate/u);
    registerBodyBrainAdapterDescriptor(claude);
    expect(knownBodyBrainAdapterDescriptors()).toEqual(['claude-code', 'codex']);
    expect(getBodyBrainAdapterDescriptor('claude-code')).toBe(claude);
  });
});

describe('injected ACP BodyBrain provider conformance', () => {
  it.each(['codex-acp', 'claude-code-acp'] as const)(
    'rejects missing/invalid %s model and effort before driver ownership', adapterId => {
      const valid = launch(adapterId);
      expect(() => createAcpBodyBrainPreparedLaunch({
        ...valid, translation: { ...valid.translation, model: '' },
      })).toThrow(/invalid ACP BodyBrain prepared launch/u);
      expect(() => createAcpBodyBrainPreparedLaunch({
        ...valid, translation: { ...valid.translation, effort: 'foreign-effort' },
      })).toThrow(/invalid ACP BodyBrain prepared launch/u);
      expect(() => createAcpBodyBrainPreparedLaunch({
        ...valid, translation: { effort: valid.translation.effort } as typeof valid.translation,
      })).toThrow(/invalid ACP BodyBrain prepared launch/u);
    },
  );

  it.each(['codex-acp', 'claude-code-acp'] as const)(
    'owns immutable launch translation and one listener/cleanup for %s', async adapterId => {
      const raw = launch(adapterId);
      const { driver, calls, emit } = fakeDriver();
      const provider = new AcpBodyBrainInjectedProvider(raw, driver);
      (raw.argv as string[])[0] = 'mutated';
      (raw.env as Record<string, string>).ROLE_ENV = 'mutated';
      (raw.translation as { model: string }).model = 'mutated';
      expect(provider.launch.argv[0]).toBe('node');
      expect(provider.launch.env.ROLE_ENV).toBe('owned');
      expect(provider.launch.translation.model).toBe(adapterId === 'codex-acp' ? 'gpt-5.6-sol' : 'claude-opus-4-6');
      expect(Object.isFrozen(provider.launch)).toBe(true);
      expect(Object.isFrozen(provider.launch.translation)).toBe(true);
      expect(Object.isFrozen(provider.launch.argv)).toBe(true);
      const delivered: unknown[] = [];
      provider.subscribe(value => { delivered.push(value); });
      expect(() => provider.subscribe(() => undefined)).toThrow(/listener unavailable/u);
      expect(await provider.start({ protocolVersion: 1, generation: 'generation-1', planDigest: digest }))
        .toMatchObject({ state: 'accepted' });
      emit({ synthetic: adapterId });
      expect(delivered).toEqual([{ synthetic: adapterId }]);
      expect(await provider.submit({ generation: 'generation-1', commandId: 'submit-1', promptId: 'prompt-1',
        origin: { kind: 'startup' } }, new TextEncoder().encode('hello'))).toEqual({ state: 'accepted' });
      expect(await provider.respondPermission({ generation: 'generation-1', commandId: 'permission-1',
        permissionId: 'permission-1', optionId: 'allow' })).toEqual({ state: 'accepted' });
      for (const [method, commandId] of [
        ['cancel', 'cancel-1'], ['forceTerminate', 'force-1'], ['close', 'close-1'], ['retire', 'retire-1'],
      ] as const) expect(await provider[method]({ generation: 'generation-1', commandId })).toEqual({ state: 'accepted' });
      await Promise.all([provider.cleanup(), provider.cleanup()]);
      emit({ late: true });
      expect(delivered).toHaveLength(1);
      expect(calls.filter(value => value === 'unsubscribe')).toHaveLength(1);
      expect(calls.filter(value => value === 'cleanup')).toHaveLength(1);
      expect(await provider.cancel({ generation: 'generation-1', commandId: 'late' }))
        .toEqual({ state: 'failed', code: 'closed' });
    },
  );

  it.each(['codex-acp', 'claude-code-acp'] as const)(
    'fails %s closed and redacts dependency throws without implicit retry', async adapterId => {
    const { driver, calls } = fakeDriver({
      async start() { calls.push('throwing-start'); throw new Error('provider secret'); },
      async cleanup() { calls.push('cleanup'); throw new Error('cleanup secret'); },
    });
    const provider = new AcpBodyBrainInjectedProvider(launch(adapterId), driver);
    provider.subscribe(() => undefined);
    expect(await provider.start({ protocolVersion: 1, generation: 'generation-1', planDigest: digest }))
      .toEqual({ state: 'failed', code: 'adapter_unavailable' });
    expect(calls.filter(value => value === 'throwing-start')).toHaveLength(1);
    expect(calls.filter(value => value === 'cleanup')).toHaveLength(1);
    expect(JSON.stringify(provider.launch)).not.toContain('provider secret');
    },
  );

  it.each(['codex-acp', 'claude-code-acp'] as const)(
    'redacts %s subscription and constructor getter traps and keeps cleanup idempotent', async adapterId => {
    const { driver, calls } = fakeDriver({
      subscribe(): () => void { throw new Error('subscription secret'); },
    });
    const provider = new AcpBodyBrainInjectedProvider(launch(adapterId), driver);
    let escaped: unknown;
    try { provider.subscribe(() => undefined); } catch (error) { escaped = error; }
    expect(escaped).toBeInstanceOf(AcpBodyBrainProviderError);
    expect(String(escaped)).not.toContain('subscription secret');
    await Promise.all([provider.cleanup(), provider.cleanup()]);
    expect(calls.filter(value => value === 'cleanup')).toHaveLength(1);

    const trapped = Object.defineProperty({}, 'subscribe', {
      enumerable: true, get(): never { throw new Error('getter secret'); },
    }) as AcpBodyBrainInjectedDriver;
    expect(() => new AcpBodyBrainInjectedProvider(launch(adapterId), trapped)).toThrow(AcpBodyBrainProviderError);
    try { new AcpBodyBrainInjectedProvider(launch(adapterId), trapped); }
    catch (error) { expect(String(error)).not.toContain('getter secret'); }
    },
  );

  it.each(['codex-acp', 'claude-code-acp'] as const)(
    'fences %s wrong generation and restores exact metadata without exposing it', async adapterId => {
    const { driver } = fakeDriver();
    const provider = new AcpBodyBrainInjectedProvider(launch(adapterId), driver);
    provider.subscribe(() => undefined);
    const metadata = { schemaVersion: 1 as const, token: 'restore-secret-token', digest };
    expect(await provider.restore({ protocolVersion: 1, generation: 'generation-2', planDigest: digest,
      sessionMetadata: metadata })).toEqual({ state: 'accepted', sessionMetadata: metadata });
    expect(await provider.cancel({ generation: 'other-generation', commandId: 'cancel-wrong' }))
      .toEqual({ state: 'failed', code: 'generation_changed' });
    expect(JSON.stringify(provider.launch)).not.toContain(metadata.token);
    await provider.cleanup();
    },
  );
});

const productionRole = (harness: 'codex' | 'claude-code', patch: Partial<ResolvedRole> = {}) => ({
  name: `role-${harness}`, harness, session: 'acp', identity: `identity-${harness}`, sourceFile: 'test',
  model: harness === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-4-6',
  harness_options: { effort: harness === 'codex' ? 'ultra' : 'medium' },
  permissions: { approval: 'auto', filesystem: 'workspace', unattended: 'deny' },
  permissionsDeclared: true,
  monitor: { mode: 'fleet', enabled: true, wake_sources: [], batch_ms: 2000, inject: 'notification' },
  ...patch,
}) as ResolvedRole;

describe('registered production ACP BodyBrain translations', () => {
  it.each(['codex', 'claude-code'] as const)(
    'binds %s descriptor identity/policy and drives fresh plus restore without a process launch', async harness => {
      vi.resetModules();
      await import('../src/harness/codex.js');
      await import('../src/harness/claude-code.js');
      const registry = await import('../src/harness/registry.js');
      const brainAdapters = await import('../src/harness/brain-adapter.js');
      const registered = registry.getBodyBrainAdapterDescriptor(harness);
      const policy = brainAdapters.getBrainAdapter(harness, 'acp');
      expect(registered).toMatchObject({
        schemaVersion: 1, harnessId: harness, adapterId: policy.adapterId,
        adapterVersion: policy.adapterVersion,
      });
      expect(Object.isFrozen(registered)).toBe(true);
      expect(() => registered.prepare(productionRole(harness === 'codex' ? 'claude-code' : 'codex'), {
        argv: [], env: {},
      })).toThrow(/another harness/u);
      const prepared = registered.prepare(productionRole(harness), {
        argv: [], env: { OWNED: '1' }, settingsOverlay: '/state/settings.json',
      });
      expect(prepared).toMatchObject({
        schemaVersion: 1, adapterId: policy.adapterId, adapterVersion: policy.adapterVersion,
        env: { OWNED: '1' },
        translation: {
          model: harness === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-4-6',
          effort: harness === 'codex' ? 'ultra' : 'medium',
          modeId: harness === 'codex' ? 'agent' : 'acceptEdits',
        },
      });
      expect(Object.isFrozen(prepared)).toBe(true);
      expect(Object.isFrozen(prepared.translation)).toBe(true);
      if (harness === 'codex') {
        expect(prepared.translation.permissionMetadataSource).toBe('codex-acp');
        expect(prepared.translation.sessionMeta).toBeUndefined();
        expect(prepared.translation.mcpServers).toBeUndefined();
      } else {
        expect(prepared.translation.permissionMetadataSource).toBeUndefined();
        expect(prepared.translation.sessionMeta).toEqual({
          claudeCode: { options: { settings: '/state/settings.json' } },
        });
        expect(prepared.translation.mcpServers).toBeUndefined();
      }

      const freshFake = fakeDriver();
      const fresh = registered.createProvider(prepared, freshFake.driver);
      fresh.subscribe(() => undefined);
      expect(await fresh.start({ protocolVersion: 1, generation: 'generation-fresh', planDigest: digest }))
        .toMatchObject({ state: 'accepted' });
      expect(freshFake.calls).toContain(`start:${policy.adapterId}:${prepared.translation.model}:${prepared.translation.effort}`);
      await fresh.cleanup();
      const restoreFake = fakeDriver();
      const restored = registered.createProvider(prepared, restoreFake.driver);
      restored.subscribe(() => undefined);
      const metadata = { schemaVersion: 1 as const, token: 'opaque-restore', digest };
      expect(await restored.restore({ protocolVersion: 1, generation: 'generation-restore', planDigest: digest,
        sessionMetadata: metadata })).toEqual({ state: 'accepted', sessionMetadata: metadata });
      expect(restoreFake.calls).toContain(`restore:${policy.adapterId}:${prepared.translation.model}:${prepared.translation.effort}`);
      await restored.cleanup();
    },
  );

  it('preserves Claude inherited versus explicit-empty MCP semantics and bundled-only metadata', async () => {
    vi.resetModules();
    await import('../src/harness/claude-code.js');
    const registry = await import('../src/harness/registry.js');
    const registered = registry.getBodyBrainAdapterDescriptor('claude-code');
    const inherited = registered.prepare(productionRole('claude-code'), { argv: [], env: {} });
    const explicitEmpty = registered.prepare(productionRole('claude-code', {
      harness_options: { effort: 'medium', mcp_servers: {} },
    }), { argv: [], env: {} });
    expect(inherited.translation.mcpServers).toBeUndefined();
    expect(explicitEmpty.translation.mcpServers).toEqual([]);
    const custom = registered.prepare(productionRole('claude-code', {
      session_options: { acp: { command: ['custom-acp'] } },
    }), { argv: [], env: {}, settingsOverlay: '/must-not-cross' });
    expect(custom.translation.sessionMeta).toBeUndefined();
    expect(custom.argv).toEqual(['custom-acp']);
  });
});
