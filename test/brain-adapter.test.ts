import { describe, expect, it } from 'vitest';
import {
  BrainAdapterRegistry, computeBrainAdapterPolicyDigest, computeModelCatalogDigest,
  createBrainAdapterPolicyResolver, createBrainAdapterPreparer, getBrainAdapter, resolveBrainAdapterPolicy,
  translatePortablePermissionCodes,
  type BrainAdapterEvidenceAuthority, type BrainAdapterPolicy, type BrainAdapterPolicyEvidence,
  type BrainAdapterResolutionInput, type TrustedAdapterEnforcementBindings,
  type VerifiedAdapterEnforcementEvidence,
} from '../src/harness/brain-adapter.js';
import { computeBrainDigest, computePermissionsDigest } from '../src/agent-plan.js';
import { resolveAuthenticatedBundledAcpAgent } from '../src/harness/acp-agent.js';
import { getAdapter } from '../src/harness/registry.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';
import '../src/harness/codex.js';
import '../src/harness/claude-code.js';
import * as brainAdapterModule from '../src/harness/brain-adapter.js';

const codexPolicy = (patch: Partial<Extract<BrainAdapterPolicy, { kind: 'codex_acp' }>> = {}) => ({
  schemaVersion: 1 as const, kind: 'codex_acp' as const, adapterVersion: '1.1.7',
  modelPolicy: { schemaVersion: 1 as const, kind: 'syntax_only' as const, revision: 'syntax-1' },
  launch: { kind: 'bundled' as const }, ...patch,
});
const claudePolicy = (patch: Partial<Extract<BrainAdapterPolicy, { kind: 'claude_code_acp' }>> = {}) => ({
  schemaVersion: 1 as const, kind: 'claude_code_acp' as const, adapterVersion: '0.63.0',
  modelPolicy: { schemaVersion: 1 as const, kind: 'syntax_only' as const, revision: 'syntax-1' },
  launch: { kind: 'bundled' as const }, ...patch,
});
const evidence = (value: BrainAdapterPolicy): BrainAdapterPolicyEvidence => ({
  revision: 'policy-7', digest: computeBrainAdapterPolicyDigest('policy-7', value), value,
});
const brain = (harness: 'codex' | 'claude-code', patch: Partial<BrainSpec> = {}): BrainSpec => ({
  harness, model: harness === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-4-6',
  effort: 'high', session: 'acp', ...patch,
});
const permissions = (
  approval: PermissionSpec['approval'], filesystem: PermissionSpec['filesystem'],
  unattended: PermissionSpec['unattended'],
): PermissionSpec => ({ approval, filesystem, unattended });

const trusted = new WeakMap<object, TrustedAdapterEnforcementBindings>();
const authority: BrainAdapterEvidenceAuthority = {
  authenticateAdapterEvidence: evidenceValue => trusted.get(evidenceValue as object),
};
const authorizedResolve = createBrainAdapterPolicyResolver(authority);
function authorizedInput(
  selectedBrain: BrainSpec, portable: PermissionSpec, policy: BrainAdapterPolicyEvidence,
  patch: Partial<TrustedAdapterEnforcementBindings> = {},
): BrainAdapterResolutionInput {
  const enforcementEvidence = {} as VerifiedAdapterEnforcementEvidence;
  const codex = selectedBrain.harness === 'codex';
  trusted.set(enforcementEvidence as object, {
    harness: selectedBrain.harness as 'codex' | 'claude-code', session: 'acp',
    adapterId: codex ? 'codex-acp' : 'claude-code-acp',
    adapterVersion: codex ? '1.1.7' : '0.63.0',
    policyDigest: policy.digest, brainDigest: computeBrainDigest(selectedBrain),
    permissionsDigest: computePermissionsDigest(portable),
    launch: {
      kind: 'bundled', packageName: codex
        ? '@agentclientprotocol/codex-acp' : '@agentclientprotocol/claude-agent-acp',
      manifestPath: codex ? '/trusted/codex-acp/package.json' : '/trusted/claude-agent-acp/package.json',
      entrypointPath: codex ? '/trusted/codex-acp/index.js' : '/trusted/claude-agent-acp/index.js',
      version: codex ? '1.1.7' : '0.63.0',
      identity: {
        manifest: { path: codex ? '/trusted/codex-acp/package.json' : '/trusted/claude-agent-acp/package.json',
          dev: '1', ino: '2', size: 10, mtimeNs: '3', sha256: `sha256:${'a'.repeat(64)}` },
        entrypoint: { path: codex ? '/trusted/codex-acp/index.js' : '/trusted/claude-agent-acp/index.js',
          dev: '1', ino: '4', size: 10, mtimeNs: '3', sha256: `sha256:${'b'.repeat(64)}` },
      },
    },
    enforcement: {
      approval: 'native_adapter', filesystem: codex ? 'native_adapter' : 'fleet_isolation',
      unattended: 'body_controller',
    },
    ...patch,
  });
  return { brain: selectedBrain, permissions: portable, policy, enforcementEvidence };
}

const rows = (['codex', 'claude-code'] as const).flatMap(harness =>
  (['ask', 'auto', 'allow', 'deny'] as const).flatMap(approval =>
    (['read-only', 'workspace', 'unrestricted'] as const).flatMap(filesystem =>
      (['deny', 'wait'] as const).map(unattended =>
        ({ harness, approval, filesystem, unattended })))));

const effortRows = (['codex', 'claude-code'] as const).flatMap(harness =>
  (harness === 'codex'
    ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : ['low', 'medium', 'high', 'xhigh', 'max']).flatMap(effort =>
    rows.filter(row => row.harness === harness).map(row => ({ ...row, effort }))));

describe('exact Brain adapter policy resolution', () => {
  it.each(effortRows)(
    'prepares without launch and preserves parity for $harness/$effort/$approval/$filesystem/$unattended',
    ({ harness, effort, approval, filesystem, unattended }) => {
      const selectedBrain = brain(harness, { effort });
      const portable = permissions(approval, filesystem, unattended);
      const policy = evidence(harness === 'codex' ? codexPolicy() : claudePolicy());
      const resolved = authorizedResolve(authorizedInput(selectedBrain, portable, policy));
      expect(resolved.nativeDescriptor).toMatchObject({
        approvalMode: translatePortablePermissionCodes(harness, portable).approvalMode,
        filesystemMode: translatePortablePermissionCodes(harness, portable).filesystemMode,
        unattendedMode: unattended,
      });
    },
  );

  it.each(rows)(
    'resolves $harness $approval/$filesystem/$unattended with exact enforcement owners',
    ({ harness, approval, filesystem, unattended }) => {
      const portable = permissions(approval, filesystem, unattended);
      const value = harness === 'codex' ? codexPolicy() : claudePolicy();
      const resolved = authorizedResolve(authorizedInput(brain(harness), portable, evidence(value)));
      const codes = translatePortablePermissionCodes(harness, portable);
      expect(resolved).toMatchObject({
        redacted: true, policyRevision: 'policy-7', policyDigest: computeBrainAdapterPolicyDigest('policy-7', value),
        portableDescriptor: portable,
        nativeDescriptor: {
          approvalMode: codes.approvalMode, filesystemMode: codes.filesystemMode,
          unattendedMode: unattended, exact: true,
        },
        enforcement: {
          approval: { owner: 'native_adapter' },
          filesystem: { owner: harness === 'codex' ? 'native_adapter' : 'fleet_isolation' },
          unattended: { owner: 'body_controller' },
        },
      });
      for (const field of ['approval', 'filesystem', 'unattended'] as const)
        expect(resolved.enforcement[field].policyDigest).toBe(resolved.policyDigest);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(JSON.stringify(resolved)).not.toContain('approvalOverrideAvailable');
      expect(JSON.stringify(resolved)).not.toContain('fleetIsolationModes');
    },
  );

  it.each([
    ['codex custom', brain('codex'), codexPolicy({ launch: { kind: 'custom' } })],
    ['claude custom', brain('claude-code'), claudePolicy({ launch: { kind: 'custom' } })],
    ['codex version mismatch', brain('codex'), codexPolicy({ adapterVersion: 'forged-9' })],
    ['claude version mismatch', brain('claude-code'), claudePolicy({ adapterVersion: 'forged-9' })],
  ] as const)('fails closed when %s evidence is unavailable', (_name, selectedBrain, value) => {
    const portable = permissions('ask', 'workspace', 'deny');
    expect(() => authorizedResolve(authorizedInput(selectedBrain, portable, evidence(value))))
      .toThrow(/custom|version/iu);
  });

  it('rejects caller-forged enforcement capabilities even with a recomputed digest', () => {
    const forged = {
      ...codexPolicy(), authenticated: true, approvalOverrideAvailable: true,
      sandboxModes: ['read-only', 'unrestricted', 'workspace'], bodyControllerModes: ['deny', 'wait'],
    } as unknown as BrainAdapterPolicy;
    const portable = permissions('allow', 'unrestricted', 'wait');
    expect(() => authorizedResolve(authorizedInput(brain('codex'), portable, evidence(forged))))
      .toThrow(/invalid keys/u);
  });

  it.each([
    ['codex session', brain('codex', { session: 'tmux' })],
    ['claude session', brain('claude-code', { session: 'tmux' })],
    ['codex effort', brain('codex', { effort: 'impossible' })],
    ['claude effort', brain('claude-code', { effort: 'ultra' })],
    ['codex model mismatch', brain('codex', { model: 'claude-opus-4-6' })],
    ['claude model mismatch', brain('claude-code', { model: 'gpt-5.6-sol' })],
    ['model syntax', brain('codex', { model: 'bad model' })],
  ])('rejects unsupported %s', (_name, selectedBrain) => {
    const value = selectedBrain.harness === 'codex' ? codexPolicy() : claudePolicy();
    const portable = permissions('ask', 'workspace', 'deny');
    expect(() => authorizedResolve(authorizedInput(selectedBrain, portable, evidence(value))))
      .toThrow(/unsupported|mismatch|bounded|unknown Brain adapter tuple/iu);
  });

  it('recomputes typed policy digest and rejects policy kind mismatch', () => {
    const value = codexPolicy();
    const selectedBrain = brain('codex');
    const portable = permissions('ask', 'workspace', 'deny');
    const badDigest = { revision: 'policy-7', digest: `sha256:${'0'.repeat(64)}`, value };
    expect(() => authorizedResolve(authorizedInput(selectedBrain, portable, badDigest)))
      .toThrow(/digest does not match/u);
    const wrongKind = evidence(claudePolicy());
    expect(() => authorizedResolve(authorizedInput(selectedBrain, portable, wrongKind)))
      .toThrow(/kind or schema|invalid keys/u);
    const changedRevision = { revision: 'policy-8', digest: evidence(value).digest, value };
    expect(() => authorizedResolve(authorizedInput(selectedBrain, portable, changedRevision)))
      .toThrow(/digest does not match/u);
  });

  it('binds an injected versioned model catalog without echoing it', () => {
    const models = ['gpt-5.6-sol', 'gpt-5.6-terra'];
    const value = codexPolicy({ modelPolicy: {
      schemaVersion: 1, kind: 'catalog', revision: 'catalog-9',
      catalogDigest: computeModelCatalogDigest(models), models,
    } });
    const selectedBrain = brain('codex');
    const portable = permissions('ask', 'workspace', 'deny');
    const resolved = authorizedResolve(authorizedInput(selectedBrain, portable, evidence(value)));
    expect(JSON.stringify(resolved)).not.toContain('gpt-5.6-terra');
    const absentBrain = brain('codex', { model: 'gpt-not-listed' });
    expect(() => authorizedResolve(authorizedInput(absentBrain, portable, evidence(value))))
      .toThrow(/bound adapter catalog/u);
    const tampered = codexPolicy({ modelPolicy: {
      schemaVersion: 1, kind: 'catalog', revision: 'catalog-9',
      catalogDigest: `sha256:${'f'.repeat(64)}`, models,
    } });
    expect(() => authorizedResolve(authorizedInput(selectedBrain, portable, evidence(tampered))))
      .toThrow(/catalog digest/u);
  });

  it('rejects opaque evidence without an authority and rejects missing-bundle fallback', () => {
    const selectedBrain = brain('codex');
    const portable = permissions('ask', 'workspace', 'deny');
    const policy = evidence(codexPolicy());
    const input = authorizedInput(selectedBrain, portable, policy);
    expect(() => resolveBrainAdapterPolicy(input)).toThrow(/not authenticated/u);
    const fallbackInput = authorizedInput(selectedBrain, portable, policy, {
      launch: { kind: 'fallback', packageName: '@agentclientprotocol/codex-acp' },
    });
    expect(() => authorizedResolve(fallbackInput)).toThrow(/bindings do not match/u);
  });

  it('separates redacted durable validation from immutable ephemeral launch material', () => {
    const selectedBrain = brain('codex');
    const portable = permissions('allow', 'unrestricted', 'wait');
    const policy = evidence(codexPolicy());
    const input = authorizedInput(selectedBrain, portable, policy);
    const actual = resolveAuthenticatedBundledAcpAgent(
      '@agentclientprotocol/codex-acp', 'codex-acp', 'codex-acp',
    );
    expect(actual.bundled).toBe(true);
    const original = trusted.get(input.enforcementEvidence as object)!;
    trusted.set(input.enforcementEvidence as object, { ...original, launch: {
      kind: 'bundled', packageName: '@agentclientprotocol/codex-acp',
      manifestPath: actual.manifestPath, entrypointPath: actual.entrypointPath,
      version: actual.version, identity: actual.identity,
    } });
    const prepare = createBrainAdapterPreparer(authority);
    const prepared = prepare(input);
    (selectedBrain as { model: string }).model = 'mutated-after-prepare';
    expect(prepared.model).toBe('gpt-5.6-sol');
    expect(prepared.argv[1]).toBe(actual.entrypointPath);
    expect(() => JSON.stringify(prepared)).toThrow(/cannot be serialized/u);
    expect(JSON.stringify(prepared.validation)).not.toContain(actual.entrypointPath!);
    expect(JSON.stringify(prepared.validation)).not.toContain(actual.manifestPath!);
    expect(() => (prepared.argv as string[]).push('mutate')).toThrow();
    expect(prepared.recheckAtSideEffectBoundary()).toBe(true);
  });

  it('rejects getter inputs without leaking provider-private values', () => {
    const selectedBrain = brain('codex');
    Object.defineProperty(selectedBrain, 'model', {
      enumerable: true, get: () => 'secret-provider-model',
    });
    const portable = permissions('ask', 'workspace', 'deny');
    const policy = evidence(codexPolicy());
    const input = authorizedInput(selectedBrain, portable, policy);
    const prepare = createBrainAdapterPreparer(authority);
    expect(() => prepare(input)).toThrow(/immutable data properties/u);
    expect(() => prepare(input)).not.toThrow(/secret-provider-model/u);
  });
});

describe('Brain tuple registry and legacy translation parity', () => {
  it('uses exact harness/session tuples and rejects duplicate registration', () => {
    expect(getBrainAdapter('codex', 'acp').harness).toBe('codex');
    expect(() => getBrainAdapter('codex', 'tmux')).toThrow(/unknown Brain adapter tuple/u);
    const registry = new BrainAdapterRegistry();
    registry.register(getBrainAdapter('codex', 'acp'));
    expect(() => registry.register(getBrainAdapter('codex', 'acp'))).toThrow(/duplicate/u);
    expect(getAdapter('codex').id).toBe('codex');
  });

  it('does not expose a production issuer or registrar and isolates local catalogs', () => {
    expect('makeProductionBrainAdapter' in brainAdapterModule).toBe(false);
    expect('registerBrainAdapter' in brainAdapterModule).toBe(false);
    const local = new BrainAdapterRegistry();
    local.register({
      harness: 'codex', session: 'acp', adapterId: 'codex-acp', adapterVersion: 'forged-9',
    });
    expect(local.get('codex', 'acp').adapterVersion).toBe('forged-9');
    expect(getBrainAdapter('codex', 'acp').adapterVersion).toBe('1.1.7');
    expect(() => local.register({
      harness: 'other', session: 'acp', adapterId: 'codex-acp', adapterVersion: '1',
      resolvePolicy: () => ({}) as never,
    } as never)).toThrow(/invalid keys/u);
  });

  it.each(rows)('shares one pure translation with legacy $harness helpers', ({ harness, approval, filesystem, unattended }) => {
    const portable = permissions(approval, filesystem, unattended);
    const shared = translatePortablePermissionCodes(harness, portable);
    const legacy = getAdapter(harness).translatePermissions(portable);
    expect(legacy.supported).toBe(true);
    if (!legacy.supported) throw new Error('expected supported translation');
    expect(legacy.native).toEqual(shared.legacyNative);
  });

  it('shares Claude launch-helper mode selection without executing a launch', async () => {
    const { nativePermissionMode } = await import('../src/harness/claude-code.js');
    for (const approval of ['ask', 'auto', 'allow'] as const) {
      const shared = translatePortablePermissionCodes(
        'claude-code', permissions(approval, 'workspace', 'deny')).legacyNative.permission_mode;
      expect(nativePermissionMode(approval) ?? 'default').toBe(shared);
    }
  });

  it('shares Codex ACP mode selection without executing a launch', () => {
    const adapter = getAdapter('codex');
    for (const [approval, filesystem, expected] of [
      ['ask', 'read-only', 'read-only'], ['auto', 'workspace', 'agent'],
      ['allow', 'unrestricted', 'agent-full-access'],
    ] as const) {
      const portable = permissions(approval, filesystem, 'deny');
      const shared = translatePortablePermissionCodes('codex', portable);
      expect(shared.legacyNative.sandbox).toBe(filesystem === 'workspace'
        ? 'workspace-write' : filesystem === 'unrestricted' ? 'danger-full-access' : 'read-only');
      const role = {
        permissions: portable, harness_options: undefined, session: 'acp', session_options: undefined,
      } as unknown as import('../src/config.js').ResolvedRole;
      expect(shared.coupledAcpMode).toBe(expected);
      expect(adapter.acpPermissionModeId!(role)).toBe(expected);
    }
  });
});
