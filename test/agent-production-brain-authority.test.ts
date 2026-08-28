import { describe, expect, it } from 'vitest';
import { resolveAuthenticatedBundledAcpAgent } from '../src/harness/acp-agent.js';
import { ProductionBrainAuthority } from '../src/agent-production-brain-authority.js';

describe('ProductionBrainAuthority', () => {
  it('issues versioned code-owned policy and authenticates only same-instance evidence', () => {
    const authority = new ProductionBrainAuthority();
    const input = authority.resolvePolicy({ harness: 'codex', session: 'acp', model: 'gpt-5', effort: 'high' },
      { approval: 'allow', filesystem: 'workspace', unattended: 'deny' });
    expect(input.policy).toMatchObject({ revision: 'fleet-body-brain-v1',
      value: { kind: 'codex_acp', adapterVersion: '1.1.7', launch: { kind: 'bundled' } } });
    expect(authority.authenticateAdapterEvidence(input.enforcementEvidence)).toMatchObject({
      harness: 'codex', session: 'acp', adapterId: 'codex-acp', adapterVersion: '1.1.7',
    });
    expect(new ProductionBrainAuthority().authenticateAdapterEvidence(input.enforcementEvidence)).toBeUndefined();
    expect(authority.authenticateAdapterEvidence(Object.freeze({}) as never)).toBeUndefined();
    expect(authority.authenticateAdapterEvidence(Object.freeze({ ...input.enforcementEvidence }) as never))
      .toBeUndefined();
  });

  it('issues the exact Claude fleet-isolation enforcement mapping', () => {
    const authority = new ProductionBrainAuthority();
    const input = authority.resolvePolicy({ harness: 'claude-code', session: 'acp', model: 'sonnet', effort: 'high' },
      { approval: 'allow', filesystem: 'workspace', unattended: 'deny' });
    expect(input.policy.value).toMatchObject({ kind: 'claude_code_acp', adapterVersion: '0.63.0' });
    expect(authority.authenticateAdapterEvidence(input.enforcementEvidence)).toMatchObject({
      harness: 'claude-code', adapterId: 'claude-code-acp',
      enforcement: { approval: 'native_adapter', filesystem: 'fleet_isolation', unattended: 'body_controller' },
    });
  });

  it('refuses issuance when the current bundled identity fails its boundary recheck', () => {
    const authority = new ProductionBrainAuthority(Object.freeze({
      resolve: resolveAuthenticatedBundledAcpAgent, recheck: () => false,
    }));
    expect(() => authority.resolvePolicy({ harness: 'codex', session: 'acp', model: 'gpt-5', effort: 'high' },
      { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }))
      .toThrow(/trusted bundled adapter unavailable/u);
  });
});
