import { computeBrainDigest, computePermissionsDigest, type AgentPlan } from './agent-plan.js';
import type { TrustedAdapterPolicySource } from './agent-composition-service.js';
import type { BrainSpec } from './config-resources.js';
import {
  computeBrainAdapterPolicyDigest,
  type BrainAdapterEvidenceAuthority, type BrainAdapterPolicy, type BrainAdapterPolicyEvidence,
  type TrustedAdapterEnforcementBindings, type VerifiedAdapterEnforcementEvidence,
} from './harness/brain-adapter.js';
import { recheckBundledAcpAgent, resolveAuthenticatedBundledAcpAgent } from './harness/acp-agent.js';
import type { AcpAgentResolution } from './harness/acp-agent.js';

const POLICY_REVISION = 'fleet-body-brain-v1';
const VERSIONS = Object.freeze({ codex: '1.1.7', 'claude-code': '0.63.0' } as const);

type SupportedBrain = Readonly<BrainSpec & { harness: 'codex' | 'claude-code'; session: 'acp' }>;

/** Code-owned, versioned production policy and same-instance enforcement evidence issuer. */
export class ProductionBrainAuthority implements TrustedAdapterPolicySource, BrainAdapterEvidenceAuthority {
  readonly #issued = new WeakMap<object, Readonly<TrustedAdapterEnforcementBindings>>();
  constructor(private readonly bundled: Readonly<{
    resolve(packageName: string, binName: string, fallback: string): AcpAgentResolution;
    recheck(resolution: AcpAgentResolution): boolean;
  }> = Object.freeze({ resolve: resolveAuthenticatedBundledAcpAgent, recheck: recheckBundledAcpAgent })) {}

  resolvePolicy(brain: Readonly<BrainSpec>, permissions: Readonly<AgentPlan['permissions']>): Readonly<{
    policy: BrainAdapterPolicyEvidence; enforcementEvidence: VerifiedAdapterEnforcementEvidence;
  }> {
    if ((brain.harness !== 'codex' && brain.harness !== 'claude-code') || brain.session !== 'acp')
      throw new TypeError('unsupported production Brain adapter');
    const supported = brain as SupportedBrain;
    const version = VERSIONS[supported.harness];
    const policyValue: BrainAdapterPolicy = Object.freeze({ schemaVersion: 1,
      kind: supported.harness === 'codex' ? 'codex_acp' : 'claude_code_acp', adapterVersion: version,
      modelPolicy: Object.freeze({ schemaVersion: 1, kind: 'syntax_only', revision: POLICY_REVISION }),
      launch: Object.freeze({ kind: 'bundled' }),
    }) as BrainAdapterPolicy;
    const policy = Object.freeze({ revision: POLICY_REVISION,
      digest: computeBrainAdapterPolicyDigest(POLICY_REVISION, policyValue), value: policyValue });
    const packageName = supported.harness === 'codex'
      ? '@agentclientprotocol/codex-acp' : '@agentclientprotocol/claude-agent-acp';
    const binName = supported.harness === 'codex' ? 'codex-acp' : 'claude-agent-acp';
    const resolution = this.bundled.resolve(packageName, binName, binName);
    if (!resolution.bundled || !resolution.identity || resolution.version !== version
        || !this.bundled.recheck(resolution)) throw new TypeError('trusted bundled adapter unavailable');
    const evidence = Object.freeze({}) as VerifiedAdapterEnforcementEvidence;
    this.#issued.set(evidence as object, Object.freeze({ harness: supported.harness, session: 'acp',
      adapterId: supported.harness === 'codex' ? 'codex-acp' : 'claude-code-acp', adapterVersion: version,
      policyDigest: policy.digest, brainDigest: computeBrainDigest(brain),
      permissionsDigest: computePermissionsDigest(permissions),
      launch: Object.freeze({ kind: 'bundled', packageName,
        manifestPath: resolution.manifestPath, entrypointPath: resolution.entrypointPath,
        version: resolution.version, identity: resolution.identity }),
      enforcement: Object.freeze({ approval: 'native_adapter',
        filesystem: supported.harness === 'codex' ? 'native_adapter' : 'fleet_isolation',
        unattended: 'body_controller' }),
    }));
    return Object.freeze({ policy, enforcementEvidence: evidence });
  }

  authenticateAdapterEvidence(evidence: VerifiedAdapterEnforcementEvidence) {
    return evidence && typeof evidence === 'object' ? this.#issued.get(evidence as object) : undefined;
  }
}
