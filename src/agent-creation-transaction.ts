import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, unlinkSync, writeSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import type { AgentPlan } from './agent-plan.js';
import { authenticateTransactionConsumer, consumePreparedForTransaction,
  type AgentPlanTransactionConsumer, type PreparedAgentCreation } from './agent-composition-service.js';
import {
  DurableAgentGenerationAuthority, GenerationReservationError,
  type AgentGenerationEvidenceAuthority, type GenerationReservationRecord,
  type VerifiedGenerationReservation,
} from './agent-generation-reservation.js';
import { readStoredAgentPlan } from './agent-plan-store.js';
import { withConfigGraphLock } from './config-graph-lock.js';

export type AcquisitionOutcome = 'not_started' | 'existing_before_action' | 'created_by_action' | 'unknown';
export interface IdentityActionBindings {
  actionKey: string; actionId: string; agentId: string; generation: number; name: string;
  ownership: string; planDigest: string; reservationDigest: string;
}
export interface TrustedAcquisitionProof {
  actionKey: string; actionId: string; agentId: string; generation: number; name: string;
  ownership: string; outcome: AcquisitionOutcome; receiptDigest?: string;
}
export interface TrustedIdentityVerification {
  actionKey: string; actionId: string; agentId: string; generation: number; name: string;
  ownership: string; outcome: 'verified' | 'mismatch' | 'unknown'; provider: string;
  authenticatedIdentityId?: string; evidenceDigest: string;
  acquisition: 'external' | 'created';
}
export interface TrustedOwnershipCapability extends Omit<TrustedAcquisitionProof, 'outcome'> {
  outcome: 'created_by_action'; currentOwner: true;
}
export interface AgentIdentityEvidenceAuthority {
  authenticateAcquisition(evidence: unknown): Readonly<TrustedAcquisitionProof> | undefined;
  authenticateVerification(evidence: unknown): Readonly<TrustedIdentityVerification> | undefined;
  authenticateOwnership(evidence: unknown): Readonly<TrustedOwnershipCapability> | undefined;
}
export interface IdempotentAgentIdentityProvider {
  readonly supportsIdempotentActionKeys: true;
  lookupExisting(input: Readonly<IdentityActionBindings>): Promise<unknown>;
  reconcileAcquisition(input: Readonly<IdentityActionBindings & { receiptHint?: unknown }>): Promise<unknown>;
  createPersistent(input: Readonly<IdentityActionBindings>): Promise<unknown>;
  createTemporary(input: Readonly<IdentityActionBindings>): Promise<unknown>;
  verifyIdentity(input: Readonly<IdentityActionBindings & { acquisition: 'external' | 'created'; receiptDigest?: string }>): Promise<unknown>;
  reconcileReceipt(input: Readonly<IdentityActionBindings & { receiptDigest: string }>): Promise<unknown>;
  removeCreated(capability: unknown): Promise<void>;
  closeTemporary(capability: unknown): Promise<void>;
}
export type AgentCreationState = 'pending' | 'create_authorized' | 'acquired' | 'verifying'
  | 'verified' | 'complete' | 'compensating' | 'compensated' | 'compensation_failed' | 'ambiguous';
export interface AgentCreationResult {
  state: AgentCreationState; reservation: VerifiedGenerationReservation;
  outcome?: 'existing_before_action' | 'created_by_action' | 'unknown';
}
const completeBrand: unique symbol = Symbol('VerifiedCompleteAgentCreation');
export interface CompleteAgentCreationBindings {
  actionId: string; agentId: string; generation: number; planDigest: string;
  snapshotDigest: string; reservationDigest: string; canonicalDir: string;
  identity: Readonly<{ name: string; ownership: string; provider: string;
    authenticatedIdentityId: string; evidenceDigest: string; acquisition: 'external' | 'created' }>;
}
export interface VerifiedCompleteAgentCreation { readonly [completeBrand]: true }
export interface AgentCreationCompletionAuthority {
  validateComplete(reservation: VerifiedGenerationReservation): VerifiedCompleteAgentCreation;
  authenticateComplete(evidence: VerifiedCompleteAgentCreation): Readonly<CompleteAgentCreationBindings> | undefined;
}
export interface AgentCreationFaults {
  afterCreateAuthorized?(): void; afterCreate?(): void;
  beforeSecureOpen?(path: string): void;
  write?(fd: number, bytes: Buffer, offset: number, length: number): number;
}
export class AgentCreationTransactionError extends Error {
  constructor(readonly code: 'invalid_provider' | 'invalid_proof' | 'corrupt_state' | 'publication_conflict') {
    super(`agent creation transaction: ${code}`); this.name = 'AgentCreationTransactionError';
  }
}

interface Transition {
  schemaVersion: 1; kind: 'AgentIdentityTransition'; actionId: string; agentId: string;
  generation: number; planDigest: string; snapshotDigest: string; ordinal: number;
  from: AgentCreationState | null; state: AgentCreationState; prevDigest: string | null;
  event: Record<string, unknown>; digest: string;
}
const SHA = /^sha256:[a-f0-9]{64}$/u;
const MAX_RECORD = 64 * 1024;
const EDGES: Readonly<Record<string, readonly AgentCreationState[]>> = {
  start: ['pending'], pending: ['create_authorized'],
  create_authorized: ['acquired', 'ambiguous'], acquired: ['verifying'],
  verifying: ['verified', 'compensating', 'ambiguous'], verified: ['complete', 'ambiguous'],
  compensating: ['compensated', 'compensation_failed', 'ambiguous'],
  complete: [], compensated: [], compensation_failed: [], ambiguous: [],
};
const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new AgentCreationTransactionError('corrupt_state');
  return `{${Object.keys(value).sort().map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new AgentCreationTransactionError('corrupt_state');
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
};
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}
function assertNoSymlink(path: string): void {
  const absolute = resolve(path); const root = parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new AgentCreationTransactionError('corrupt_state'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof AgentCreationTransactionError) throw error;
      throw new AgentCreationTransactionError('corrupt_state');
    }
  }
}
function privateDir(path: string): void {
  assertNoSymlink(dirname(path)); mkdirSync(path, { recursive: true, mode: 0o700 }); assertNoSymlink(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)
    throw new AgentCreationTransactionError('corrupt_state');
}
function secureBytes(path: string, faults: AgentCreationFaults = {}): Buffer {
  assertNoSymlink(dirname(path));
  let before; try { before = lstatSync(path, { bigint: true }); } catch { throw new AgentCreationTransactionError('corrupt_state'); }
  if (before.isSymbolicLink() || !before.isFile() || (Number(before.mode) & 0o777) !== 0o600
      || before.size < 1n || before.size > BigInt(MAX_RECORD)) throw new AgentCreationTransactionError('corrupt_state');
  faults.beforeSecureOpen?.(path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) throw new AgentCreationTransactionError('corrupt_state');
    const bytes = Buffer.alloc(Number(opened.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new AgentCreationTransactionError('corrupt_state'); offset += count;
    }
    if (!sameStat(opened, fstatSync(fd, { bigint: true })) || !sameStat(opened, lstatSync(path, { bigint: true })))
      throw new AgentCreationTransactionError('corrupt_state');
    return bytes;
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ } }
}
function secureJson(path: string, faults: AgentCreationFaults = {}): Record<string, unknown> {
  const bytes = secureBytes(path, faults); let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new AgentCreationTransactionError('corrupt_state'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || `${canonical(value)}\n` !== bytes.toString('utf8')) throw new AgentCreationTransactionError('corrupt_state');
  return value as Record<string, unknown>;
}
function fsyncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

class CompletionValidator {
  constructor(private readonly generations: AgentGenerationEvidenceAuthority,
    private readonly faults: AgentCreationFaults = {}) {}

  validate(reservation: VerifiedGenerationReservation): Readonly<CompleteAgentCreationBindings> {
    const record = this.generations.authenticate(reservation);
    if (!record) throw new GenerationReservationError('corrupt_state');
    const plan = readStoredAgentPlan(record.canonicalDir, record, 'transaction').plan;
    const bindings = this.bindings(record, plan);
    const chain = this.chain(record, false);
    this.assertChainBindings(chain, bindings);
    if (chain.at(-1)?.state !== 'complete') throw new AgentCreationTransactionError('corrupt_state');
    const identity = this.verifiedArtifacts(record, bindings, chain);
    return Object.freeze({ actionId: record.actionId, agentId: record.agentId,
      generation: record.generation, planDigest: record.planDigest, snapshotDigest: record.snapshotDigest,
      reservationDigest: record.reservationDigest, canonicalDir: record.canonicalDir,
      identity: Object.freeze(identity) });
  }

  bindings(record: Readonly<GenerationReservationRecord>, plan: AgentPlan): IdentityActionBindings {
    const unsigned = { actionId: record.actionId, agentId: record.agentId, generation: record.generation,
      name: plan.identity.name, ownership: plan.identity.ownership, planDigest: record.planDigest,
      reservationDigest: record.reservationDigest };
    return { actionKey: digest(canonical(unsigned)), ...unsigned };
  }

  chain(record: Readonly<GenerationReservationRecord>, create: boolean): Transition[] {
    const dir = join(record.canonicalDir, 'identity-transitions');
    if (create) privateDir(dir); else assertNoSymlink(dir);
    let files: string[];
    try { files = readdirSync(dir).filter(name => !name.startsWith('.')).sort(); }
    catch { throw new AgentCreationTransactionError('corrupt_state'); }
    const output: Transition[] = [];
    for (let ordinal = 0; ordinal < files.length; ordinal++) {
      const file = files[ordinal]!;
      if (!/^\d{8}-[a-z_]+\.json$/u.test(file)) throw new AgentCreationTransactionError('corrupt_state');
      const value = secureJson(join(dir, file), this.faults);
      if (!exact(value, ['schemaVersion', 'kind', 'actionId', 'agentId', 'generation', 'planDigest',
        'snapshotDigest', 'ordinal', 'from', 'state', 'prevDigest', 'event', 'digest']))
        throw new AgentCreationTransactionError('corrupt_state');
      const transition = value as unknown as Transition; const prior = output.at(-1);
      const { digest: recordDigest, ...transitionUnsigned } = transition;
      if (transition.schemaVersion !== 1 || transition.kind !== 'AgentIdentityTransition'
          || transition.actionId !== record.actionId || transition.agentId !== record.agentId
          || transition.generation !== record.generation || transition.planDigest !== record.planDigest
          || transition.snapshotDigest !== record.snapshotDigest || transition.ordinal !== ordinal
          || file !== `${String(ordinal).padStart(8, '0')}-${transition.state}.json`
          || transition.from !== (prior?.state ?? null) || transition.prevDigest !== (prior?.digest ?? null)
          || !EDGES[prior?.state ?? 'start']?.includes(transition.state)
          || !SHA.test(recordDigest) || digest(canonical(transitionUnsigned)) !== recordDigest
          || !transition.event || typeof transition.event !== 'object' || Array.isArray(transition.event))
        throw new AgentCreationTransactionError('corrupt_state');
      this.validateEvent(transition); output.push(Object.freeze(transition));
    }
    return output;
  }

  validateEvent(value: Transition): void {
    const event = value.event; const empty = () => exact(event, []); let valid = false;
    if (['pending', 'verifying', 'complete', 'compensated', 'compensation_failed'].includes(value.state)) valid = empty();
    else if (value.state === 'create_authorized')
      valid = exact(event, ['actionKey']) && typeof event.actionKey === 'string' && SHA.test(event.actionKey);
    else if (value.state === 'acquired') valid = event.outcome === 'created_by_action'
      ? exact(event, ['outcome', 'receiptDigest']) && typeof event.receiptDigest === 'string' && SHA.test(event.receiptDigest)
      : event.outcome === 'existing_before_action' && exact(event, ['outcome']);
    else if (value.state === 'verified') valid = exact(event,
      ['provider', 'authenticatedIdentityId', 'evidenceDigest', 'acquisition'])
      && typeof event.provider === 'string' && event.provider.length > 0
      && typeof event.authenticatedIdentityId === 'string' && event.authenticatedIdentityId.length > 0
      && typeof event.evidenceDigest === 'string' && SHA.test(event.evidenceDigest)
      && ['external', 'created'].includes(String(event.acquisition));
    else if (value.state === 'compensating') valid = exact(event, ['receiptDigest'])
      && typeof event.receiptDigest === 'string' && SHA.test(event.receiptDigest);
    else if (value.state === 'ambiguous') valid = exact(event, ['reason']) && typeof event.reason === 'string'
      && /^[a-z][a-z0-9_]{0,63}$/u.test(event.reason);
    if (!valid) throw new AgentCreationTransactionError('corrupt_state');
  }

  assertChainBindings(chain: readonly Transition[], bindings: IdentityActionBindings): void {
    const authorized = chain.find(value => value.state === 'create_authorized');
    if (authorized && authorized.event.actionKey !== bindings.actionKey)
      throw new AgentCreationTransactionError('corrupt_state');
    const acquired = chain.find(value => value.state === 'acquired');
    const verified = chain.find(value => value.state === 'verified');
    if (acquired && verified) {
      const expected = acquired.event.outcome === 'created_by_action' ? 'created' : 'external';
      if (verified.event.acquisition !== expected) throw new AgentCreationTransactionError('corrupt_state');
    }
    const compensating = chain.find(value => value.state === 'compensating');
    if (compensating && compensating.event.receiptDigest !== acquired?.event.receiptDigest)
      throw new AgentCreationTransactionError('corrupt_state');
  }

  acquiredEvent(chain: readonly Transition[]): { outcome: string; receiptDigest?: string } {
    const event = chain.find(value => value.state === 'acquired')?.event;
    if (!event || !['existing_before_action', 'created_by_action'].includes(String(event.outcome))
        || (event.outcome === 'created_by_action'
          ? typeof event.receiptDigest !== 'string' || !SHA.test(event.receiptDigest)
          : event.receiptDigest !== undefined))
      throw new AgentCreationTransactionError('corrupt_state');
    return event as { outcome: string; receiptDigest?: string };
  }

  verifiedArtifacts(record: Readonly<GenerationReservationRecord>, bindings: IdentityActionBindings,
    chain: readonly Transition[]): CompleteAgentCreationBindings['identity'] {
    const acquired = this.acquiredEvent(chain);
    const verified = chain.find(value => value.state === 'verified')?.event;
    if (!verified) throw new AgentCreationTransactionError('corrupt_state');
    const binding = secureJson(join(record.canonicalDir, 'identity-binding.json'), this.faults);
    if (!exact(binding, ['schemaVersion', 'kind', 'actionId', 'agentId', 'generation', 'name', 'ownership',
      'planDigest', 'snapshotDigest', 'reservationDigest', 'actionKey', 'provider',
      'authenticatedIdentityId', 'evidenceDigest', 'acquisition'])
        || binding.schemaVersion !== 1 || binding.kind !== 'AuthenticatedIdentityBinding'
        || binding.actionId !== record.actionId || binding.agentId !== record.agentId
        || binding.generation !== record.generation || binding.name !== bindings.name
        || binding.ownership !== bindings.ownership || binding.planDigest !== record.planDigest
        || binding.snapshotDigest !== record.snapshotDigest || binding.reservationDigest !== record.reservationDigest
        || binding.actionKey !== bindings.actionKey || typeof binding.provider !== 'string'
        || typeof binding.authenticatedIdentityId !== 'string' || typeof binding.evidenceDigest !== 'string'
        || !SHA.test(binding.evidenceDigest) || !['external', 'created'].includes(String(binding.acquisition))
        || binding.provider !== verified.provider || binding.authenticatedIdentityId !== verified.authenticatedIdentityId
        || binding.evidenceDigest !== verified.evidenceDigest || binding.acquisition !== verified.acquisition)
      throw new AgentCreationTransactionError('corrupt_state');
    const provenance = secureJson(join(record.canonicalDir, 'creation-provenance.json'), this.faults);
    if (!exact(provenance, ['schemaVersion', 'kind', 'actionId', 'agentId', 'generation', 'planDigest',
      'snapshotDigest', 'reservationDigest', 'actionKey', 'acquisition', 'verificationEvidenceDigest'])
        || provenance.schemaVersion !== 1 || provenance.kind !== 'AgentCreationProvenance'
        || provenance.actionId !== record.actionId || provenance.agentId !== record.agentId
        || provenance.generation !== record.generation || provenance.planDigest !== record.planDigest
        || provenance.snapshotDigest !== record.snapshotDigest || provenance.reservationDigest !== record.reservationDigest
        || provenance.actionKey !== bindings.actionKey || provenance.acquisition !== acquired.outcome
        || provenance.verificationEvidenceDigest !== binding.evidenceDigest
        || binding.acquisition === 'external' && provenance.acquisition !== 'existing_before_action'
        || binding.acquisition === 'created' && provenance.acquisition !== 'created_by_action')
      throw new AgentCreationTransactionError('corrupt_state');
    return { name: String(binding.name), ownership: String(binding.ownership), provider: String(binding.provider),
      authenticatedIdentityId: String(binding.authenticatedIdentityId), evidenceDigest: String(binding.evidenceDigest),
      acquisition: binding.acquisition as 'external' | 'created' };
  }
}

/** Terminal-only completion reader. It has no creation consumer or identity-effect surface. */
export class DurableAgentCreationCompletionAuthority implements AgentCreationCompletionAuthority {
  readonly #validator: CompletionValidator;
  readonly #evidence = new WeakMap<object, Readonly<CompleteAgentCreationBindings>>();
  constructor(generations: AgentGenerationEvidenceAuthority, faults: AgentCreationFaults = {}) {
    this.#validator = new CompletionValidator(generations, faults);
  }
  validateComplete(reservation: VerifiedGenerationReservation): VerifiedCompleteAgentCreation {
    const trusted = this.#validator.validate(reservation);
    const evidence = Object.freeze({ [completeBrand]: true as const }); this.#evidence.set(evidence, trusted);
    return evidence;
  }
  authenticateComplete(evidence: VerifiedCompleteAgentCreation) {
    return this.#evidence.get(evidence as object);
  }
}

export class AgentCreationTransaction {
  readonly #completion: DurableAgentCreationCompletionAuthority;
  readonly #validator: CompletionValidator;
  constructor(
    private readonly consumer: AgentPlanTransactionConsumer,
    private readonly generations: DurableAgentGenerationAuthority,
    private readonly provider: IdempotentAgentIdentityProvider,
    private readonly evidence: AgentIdentityEvidenceAuthority,
    private readonly faults: AgentCreationFaults = {},
  ) {
    if (!authenticateTransactionConsumer(consumer)) throw new AgentCreationTransactionError('invalid_provider');
    this.#validator = new CompletionValidator(generations, faults);
    this.#completion = new DurableAgentCreationCompletionAuthority(generations, faults);
  }

  async persistPrepared(prepared: PreparedAgentCreation, input: Readonly<{ actionId: string; targetEvidence?: unknown }>): Promise<AgentCreationResult> {
    const existing = await this.generations.lookup(prepared.agentId, input.actionId);
    if (existing) return this.#resumeReservation(existing);
    const plan = consumePreparedForTransaction(this.consumer, prepared);
    return this.#resumeReservation(await this.generations.persist(plan, input.actionId));
  }
  async resume(input: Readonly<{ agentId: string; actionId: string }>): Promise<AgentCreationResult> {
    return this.#resumeReservation(await this.generations.resume(input.agentId, input.actionId));
  }
  validateComplete(reservation: VerifiedGenerationReservation): VerifiedCompleteAgentCreation {
    return this.#completion.validateComplete(reservation);
  }
  authenticateComplete(evidence: VerifiedCompleteAgentCreation): Readonly<CompleteAgentCreationBindings> | undefined {
    return this.#completion.authenticateComplete(evidence);
  }
  async #resumeReservation(reservation: VerifiedGenerationReservation): Promise<AgentCreationResult> {
    const record = this.#reservation(reservation);
    const plan = readStoredAgentPlan(record.canonicalDir, record, 'transaction').plan;
    return this.#run(reservation, record, plan);
  }
  async #run(reservation: VerifiedGenerationReservation, record: GenerationReservationRecord,
    plan: AgentPlan): Promise<AgentCreationResult> {
    if (this.provider.supportsIdempotentActionKeys !== true) throw new AgentCreationTransactionError('invalid_provider');
    const bindings = this.#bindings(record, plan); let chain = this.#chain(record);
    this.#assertChainBindings(chain, bindings);
    if (!chain.length) { await this.#append(record, 'pending', {}); chain = this.#chain(record); }
    for (;;) {
      const current = chain.at(-1)!;
      if (['complete', 'compensated', 'compensation_failed', 'ambiguous'].includes(current.state)) {
        if (current.state === 'complete') this.#verifiedArtifacts(record, bindings, chain);
        return { state: current.state, reservation,
          ...(current.state === 'ambiguous' ? { outcome: 'unknown' as const } : {}) };
      }
      if (current.state === 'pending') {
        await this.#append(record, 'create_authorized', { actionKey: bindings.actionKey });
        this.faults.afterCreateAuthorized?.(); chain = this.#chain(record); continue;
      }
      if (current.state === 'create_authorized') {
        let raw = plan.identity.ownership === 'existing'
          ? await this.provider.lookupExisting(bindings)
          : await this.provider.reconcileAcquisition(bindings);
        let proof = this.#acquisition(raw, bindings);
        if (plan.identity.ownership === 'existing') {
          if (proof.outcome !== 'existing_before_action') {
            await this.#append(record, 'ambiguous', { reason: 'existing_identity_unverified' });
            chain = this.#chain(record); continue;
          }
        } else if (proof.outcome === 'not_started') {
          raw = plan.identity.ownership === 'create_temporary'
            ? await this.provider.createTemporary(bindings) : await this.provider.createPersistent(bindings);
          this.faults.afterCreate?.();
          proof = this.#acquisition(await this.provider.reconcileAcquisition({ ...bindings, receiptHint: raw }), bindings);
        }
        if (proof.outcome === 'unknown' || proof.outcome === 'not_started') {
          await this.#append(record, 'ambiguous', { reason: 'acquisition_unknown' }); chain = this.#chain(record); continue;
        }
        await this.#append(record, 'acquired', { outcome: proof.outcome,
          ...(proof.receiptDigest ? { receiptDigest: proof.receiptDigest } : {}) });
        chain = this.#chain(record); continue;
      }
      if (current.state === 'acquired') {
        await this.#append(record, 'verifying', {}); chain = this.#chain(record); continue;
      }
      if (current.state === 'verifying') {
        const acquired = this.#acquiredEvent(chain);
        const acquisition = acquired.outcome === 'created_by_action' ? 'created' : 'external';
        const raw = await this.provider.verifyIdentity({ ...bindings, acquisition,
          ...(acquired.receiptDigest ? { receiptDigest: acquired.receiptDigest } : {}) });
        const proof = this.#verification(raw, bindings, acquisition);
        if (proof.outcome === 'unknown') {
          await this.#append(record, 'ambiguous', { reason: 'verification_unknown' }); chain = this.#chain(record); continue;
        }
        if (proof.outcome === 'mismatch') {
          if (acquisition === 'created' && acquired.receiptDigest)
            await this.#append(record, 'compensating', { receiptDigest: acquired.receiptDigest });
          else await this.#append(record, 'ambiguous', { reason: 'external_verification_mismatch' });
          chain = this.#chain(record); continue;
        }
        await this.#append(record, 'verified', { provider: proof.provider,
          authenticatedIdentityId: proof.authenticatedIdentityId!, evidenceDigest: proof.evidenceDigest,
          acquisition }); chain = this.#chain(record); continue;
      }
      if (current.state === 'compensating') {
        await this.#compensate(record, bindings, this.#acquiredEvent(chain).receiptDigest!, plan.identity.ownership);
        chain = this.#chain(record); continue;
      }
      if (current.state === 'verified') {
        const acquired = this.#acquiredEvent(chain); const verified = current.event;
        try {
          await this.#artifact(record, 'identity-binding.json', {
            schemaVersion: 1, kind: 'AuthenticatedIdentityBinding', actionId: record.actionId,
            agentId: record.agentId, generation: record.generation, name: plan.identity.name,
            ownership: plan.identity.ownership, planDigest: record.planDigest,
            snapshotDigest: record.snapshotDigest, reservationDigest: record.reservationDigest,
            actionKey: bindings.actionKey,
            provider: verified.provider, authenticatedIdentityId: verified.authenticatedIdentityId,
            evidenceDigest: verified.evidenceDigest, acquisition: verified.acquisition,
          });
          await this.#artifact(record, 'creation-provenance.json', {
            schemaVersion: 1, kind: 'AgentCreationProvenance', actionId: record.actionId,
            agentId: record.agentId, generation: record.generation, planDigest: record.planDigest,
            snapshotDigest: record.snapshotDigest, reservationDigest: record.reservationDigest,
            actionKey: bindings.actionKey,
            acquisition: acquired.outcome, verificationEvidenceDigest: verified.evidenceDigest,
          });
        } catch {
          // Publication conflict is ambiguous.  Destruction is forbidden after ambiguity.
          await this.#append(record, 'ambiguous', { reason: 'publication_conflict' });
          return { state: 'ambiguous', reservation, outcome: 'unknown' };
        }
        await this.#append(record, 'complete', {}); chain = this.#chain(record); continue;
      }
      throw new AgentCreationTransactionError('corrupt_state');
    }
  }

  #reservation(value: VerifiedGenerationReservation): Readonly<GenerationReservationRecord> {
    const record = this.generations.authenticate(value); if (!record) throw new GenerationReservationError('corrupt_state'); return record;
  }
  #bindings(record: GenerationReservationRecord, plan: AgentPlan): IdentityActionBindings {
    return this.#validator.bindings(record, plan);
  }
  #acquisition(raw: unknown, bindings: IdentityActionBindings): Readonly<TrustedAcquisitionProof> {
    const proof = this.evidence.authenticateAcquisition(raw);
    if (!proof || proof.actionKey !== bindings.actionKey || proof.actionId !== bindings.actionId
        || proof.agentId !== bindings.agentId || proof.generation !== bindings.generation
        || proof.name !== bindings.name || proof.ownership !== bindings.ownership
        || !['not_started', 'existing_before_action', 'created_by_action', 'unknown'].includes(proof.outcome)
        || (proof.outcome === 'created_by_action'
          ? typeof proof.receiptDigest !== 'string' || !SHA.test(proof.receiptDigest)
          : proof.receiptDigest !== undefined))
      throw new AgentCreationTransactionError('invalid_proof');
    return proof;
  }
  #verification(raw: unknown, bindings: IdentityActionBindings, acquisition: 'external' | 'created') {
    const proof = this.evidence.authenticateVerification(raw);
    if (!proof || proof.actionKey !== bindings.actionKey || proof.actionId !== bindings.actionId
        || proof.agentId !== bindings.agentId || proof.generation !== bindings.generation
        || proof.name !== bindings.name || proof.ownership !== bindings.ownership
        || proof.acquisition !== acquisition || !['verified', 'mismatch', 'unknown'].includes(proof.outcome)
        || !SHA.test(proof.evidenceDigest) || typeof proof.provider !== 'string' || !proof.provider
        || proof.outcome === 'verified' && (!proof.authenticatedIdentityId || typeof proof.authenticatedIdentityId !== 'string'))
      throw new AgentCreationTransactionError('invalid_proof');
    return proof;
  }
  #acquiredEvent(chain: readonly Transition[]): { outcome: string; receiptDigest?: string } {
    return this.#validator.acquiredEvent(chain);
  }
  async #compensate(record: GenerationReservationRecord, bindings: IdentityActionBindings,
    receiptDigest: string, ownership: string): Promise<void> {
    const raw = await this.provider.reconcileReceipt({ ...bindings, receiptDigest });
    const proof = this.evidence.authenticateOwnership(raw);
    if (!proof || !proof.currentOwner || proof.outcome !== 'created_by_action'
        || proof.actionKey !== bindings.actionKey || proof.actionId !== bindings.actionId
        || proof.agentId !== bindings.agentId || proof.generation !== bindings.generation
        || proof.name !== bindings.name || proof.ownership !== bindings.ownership
        || proof.receiptDigest !== receiptDigest) {
      await this.#append(record, 'ambiguous', { reason: 'ownership_unknown' }); return;
    }
    try {
      if (ownership === 'create_temporary') await this.provider.closeTemporary(raw);
      else if (ownership === 'create_persistent') await this.provider.removeCreated(raw);
      else throw new AgentCreationTransactionError('corrupt_state');
      await this.#append(record, 'compensated', {});
    } catch { await this.#append(record, 'compensation_failed', {}); }
  }

  #chain(record: GenerationReservationRecord): Transition[] {
    return this.#validator.chain(record, true);
  }
  #assertChainBindings(chain: readonly Transition[], bindings: IdentityActionBindings): void {
    this.#validator.assertChainBindings(chain, bindings);
  }
  async #append(record: GenerationReservationRecord, state: AgentCreationState, event: Record<string, unknown>): Promise<void> {
    const dir = join(record.canonicalDir, 'identity-transitions'); privateDir(dir);
    await withConfigGraphLock(join(record.canonicalDir, '.transition'), 'exclusive', async () => {
      const chain = this.#chain(record); const prior = chain.at(-1);
      if (chain.some(value => value.state === state)
          || prior && ['complete', 'compensated', 'compensation_failed', 'ambiguous'].includes(prior.state)) return;
      if (!EDGES[prior?.state ?? 'start']?.includes(state)) throw new AgentCreationTransactionError('corrupt_state');
      const unsigned = { schemaVersion: 1 as const, kind: 'AgentIdentityTransition' as const,
        actionId: record.actionId, agentId: record.agentId, generation: record.generation,
        planDigest: record.planDigest, snapshotDigest: record.snapshotDigest, ordinal: chain.length,
        from: prior?.state ?? null, state, prevDigest: prior?.digest ?? null, event };
      await this.#artifact(record, join('identity-transitions', `${String(chain.length).padStart(8, '0')}-${state}.json`),
        { ...unsigned, digest: digest(canonical(unsigned)) });
      this.#chain(record);
    });
  }
  async #artifact(record: GenerationReservationRecord, relative: string, value: unknown): Promise<void> {
    const path = join(record.canonicalDir, relative); privateDir(dirname(path));
    const bytes = Buffer.from(`${canonical(value)}\n`); const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for (let offset = 0; offset < bytes.length;) {
        const count = this.faults.write?.(fd, bytes, offset, bytes.length - offset)
          ?? writeSync(fd, bytes, offset, bytes.length - offset);
        if (count <= 0) throw new AgentCreationTransactionError('publication_conflict'); offset += count;
      }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temp, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !secureBytes(path, this.faults).equals(bytes))
          throw new AgentCreationTransactionError('publication_conflict');
      }
      fsyncDir(dirname(path));
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* stable error */ }
      try { unlinkSync(temp); } catch { /* private temp */ }
    }
  }
  #verifiedArtifacts(record: GenerationReservationRecord, bindings: IdentityActionBindings,
    chain: readonly Transition[]): CompleteAgentCreationBindings['identity'] {
    return this.#validator.verifiedArtifacts(record, bindings, chain);
  }
}
