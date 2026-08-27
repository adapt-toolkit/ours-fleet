import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentIdentityEvidenceAuthority, IdempotentAgentIdentityProvider, IdentityActionBindings,
  TrustedAcquisitionProof, TrustedIdentityVerification, TrustedOwnershipCapability,
} from './agent-creation-transaction.js';
import type { IdentityInspection, IdentityProvisioner, IdentityProvisionProfile } from './creation.js';

const digest = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const validCid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0-\x20\x7f]/u.test(value);

type CreatedCapability = object;

/**
 * Adapts the production ours identity provisioner to the authenticated creation transaction.
 *
 * Creation ownership deliberately lives only in opaque capabilities held by this instance.
 * If the process dies after create() but before the transaction records its receipt, a later
 * instance observes a present identity as unknown ownership and never infers deletion authority.
 */
export class AgentProductionIdentityAuthority
implements IdempotentAgentIdentityProvider, AgentIdentityEvidenceAuthority {
  readonly supportsIdempotentActionKeys = true as const;
  readonly #acquisitions = new WeakMap<object, Readonly<TrustedAcquisitionProof>>();
  readonly #verifications = new WeakMap<object, Readonly<TrustedIdentityVerification>>();
  readonly #ownership = new WeakMap<object, Readonly<TrustedOwnershipCapability>>();
  readonly #preflight = new Map<string, IdentityInspection>();
  readonly #created = new Map<string, { capability: CreatedCapability; receiptDigest: string; cid: string }>();

  constructor(
    private readonly provisioner: IdentityProvisioner,
    private readonly profile: IdentityProvisionProfile,
  ) {}

  authenticateAcquisition(evidence: unknown): Readonly<TrustedAcquisitionProof> | undefined {
    return evidence && typeof evidence === 'object' ? this.#acquisitions.get(evidence) : undefined;
  }
  authenticateVerification(evidence: unknown): Readonly<TrustedIdentityVerification> | undefined {
    return evidence && typeof evidence === 'object' ? this.#verifications.get(evidence) : undefined;
  }
  authenticateOwnership(evidence: unknown): Readonly<TrustedOwnershipCapability> | undefined {
    return evidence && typeof evidence === 'object' ? this.#ownership.get(evidence) : undefined;
  }

  async lookupExisting(input: Readonly<IdentityActionBindings>): Promise<unknown> {
    const inspected = await this.#inspect(input.name);
    this.#preflight.set(input.actionKey, inspected);
    return this.#acquisition(input, inspected.state === 'present' ? 'existing_before_action' : 'unknown');
  }

  async reconcileAcquisition(
    input: Readonly<IdentityActionBindings & { receiptHint?: unknown }>,
  ): Promise<unknown> {
    const created = this.#created.get(input.actionKey);
    if (created && input.receiptHint === created.capability)
      return this.#acquisition(input, 'created_by_action', created.receiptDigest);
    if (created) return this.#acquisition(input, 'created_by_action', created.receiptDigest);

    const known = this.#preflight.get(input.actionKey);
    if (known?.state === 'absent') return this.#acquisition(input, 'not_started');
    if (known) return this.#acquisition(input, 'unknown');
    const inspected = await this.#inspect(input.name);
    this.#preflight.set(input.actionKey, inspected);
    // Present on the first observation of a create action may be the residue of the
    // explicitly non-recoverable crash window. It is never pre-existing proof.
    return this.#acquisition(input, inspected.state === 'absent' ? 'not_started' : 'unknown');
  }

  async createPersistent(input: Readonly<IdentityActionBindings>): Promise<unknown> {
    if (input.ownership !== 'create_persistent' || this.#preflight.get(input.actionKey)?.state !== 'absent'
        || !this.provisioner.create)
      return this.#acquisition(input, 'unknown');
    const outcome = await this.provisioner.create(input.name, this.profile);
    if (!outcome || outcome.state !== 'created_here' || !validCid(outcome.cid)) {
      this.#preflight.set(input.actionKey, { state: 'unknown' });
      return this.#acquisition(input, 'unknown');
    }
    const inspected = await this.#inspect(input.name);
    if (inspected.state !== 'present' || inspected.cid !== outcome.cid)
      return this.#acquisition(input, 'unknown');
    const capability = Object.freeze({});
    const receiptDigest = digest(`ours-created\0${input.actionKey}\0${randomUUID()}`);
    this.#created.set(input.actionKey, { capability, receiptDigest, cid: outcome.cid });
    const ownership = Object.freeze({ ...input, outcome: 'created_by_action' as const,
      receiptDigest, currentOwner: true as const });
    this.#ownership.set(capability, ownership);
    return capability;
  }

  async createTemporary(input: Readonly<IdentityActionBindings>): Promise<unknown> {
    return this.#acquisition(input, 'unknown');
  }

  async verifyIdentity(input: Readonly<IdentityActionBindings & {
    acquisition: 'external' | 'created'; receiptDigest?: string;
  }>): Promise<unknown> {
    const inspected = await this.#inspect(input.name);
    const created = this.#created.get(input.actionKey);
    const expectedCid = input.acquisition === 'created'
      ? created && input.receiptDigest === created.receiptDigest ? created.cid : undefined
      : this.#preflight.get(input.actionKey)?.state === 'present'
        ? (this.#preflight.get(input.actionKey) as Extract<IdentityInspection, { state: 'present' }>).cid
        : undefined;
    const outcome = inspected.state === 'unknown' ? 'unknown'
      : inspected.state === 'present' && expectedCid && inspected.cid === expectedCid ? 'verified' : 'mismatch';
    const raw = Object.freeze({});
    const proof = Object.freeze({ ...input, outcome, provider: 'ours-daemon',
      ...(outcome === 'verified' ? { authenticatedIdentityId: inspected.state === 'present' ? inspected.cid : '' } : {}),
      evidenceDigest: digest(`ours-daemon\0${input.name}\0${inspected.state}\0${inspected.state === 'present' ? inspected.cid : ''}`),
    });
    this.#verifications.set(raw, proof);
    return raw;
  }

  async reconcileReceipt(input: Readonly<IdentityActionBindings & { receiptDigest: string }>): Promise<unknown> {
    const created = this.#created.get(input.actionKey);
    return created?.receiptDigest === input.receiptDigest ? created.capability : Object.freeze({});
  }

  async removeCreated(capability: unknown): Promise<void> {
    const owned = this.authenticateOwnership(capability);
    if (!owned) throw new Error('identity deletion authority unavailable');
    // IdentityProvisioner.remove(name) is intentionally insufficient here: a
    // name-only delete cannot atomically prove the CID still belongs to this action.
    throw new Error('conditional CID deletion authority unavailable');
  }

  async closeTemporary(): Promise<void> {
    throw new Error('temporary identity lifecycle is not owned by permanent composition');
  }

  #acquisition(
    input: Readonly<IdentityActionBindings>, outcome: TrustedAcquisitionProof['outcome'],
    receiptDigest?: string,
  ): object {
    const raw = Object.freeze({});
    const proof = Object.freeze({ ...input, outcome, ...(receiptDigest ? { receiptDigest } : {}) });
    this.#acquisitions.set(raw, proof);
    return raw;
  }

  async #inspect(name: string): Promise<IdentityInspection> {
    if (!this.provisioner.inspect) return { state: 'unknown' };
    try {
      const result = await this.provisioner.inspect(name);
      return result.state === 'present' && !validCid(result.cid) ? { state: 'unknown' } : result;
    }
    catch { return { state: 'unknown' }; }
  }
}
