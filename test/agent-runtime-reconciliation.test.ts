import { describe, expect, it } from 'vitest';
import { ProductionAgentRuntimeReconciliationAuthority } from '../src/agent-runtime-reconciliation.js';

const query = Object.freeze({ agentId: 'A', generation: 1, planDigest: `sha256:${'a'.repeat(64)}`,
  snapshotDigest: `sha256:${'b'.repeat(64)}`, reservationDigest: `sha256:${'c'.repeat(64)}`,
  identityEvidenceDigest: `sha256:${'d'.repeat(64)}`, runtimeInstanceKey: `sha256:${'e'.repeat(64)}`,
  startEffectKey: `sha256:${'f'.repeat(64)}`, adapterDescriptorDigest: `sha256:${'1'.repeat(64)}` });

describe('ProductionAgentRuntimeReconciliationAuthority', () => {
  it('authenticates uncertainty without inferring absence or liveness', async () => {
    const authority = new ProductionAgentRuntimeReconciliationAuthority();
    const evidence = await authority.reconcileStart(query);
    expect(authority.authenticateStart(evidence, query)).toEqual({ outcome: 'unknown' });
    expect(authority.authenticateStart(Object.freeze({ outcome: 'not_started' }), query)).toBeUndefined();
    const retire = { ...query, providerRuntimeId: 'runtime', retireEffectKey: `sha256:${'2'.repeat(64)}` };
    const retired = await authority.reconcileRetire(retire);
    expect(authority.authenticateRetire(retired, retire)).toEqual({ outcome: 'unknown' });
    expect(authority.authenticateRetire(Object.freeze({ outcome: 'already_absent' }), retire)).toBeUndefined();
  });
});
