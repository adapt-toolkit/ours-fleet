import { createHash } from 'node:crypto';
import {
  BODY_BRAIN_MAX_COMMANDS, BODY_BRAIN_MAX_ID_BYTES,
  type BodyBrainAdmissionReceipt, type BodyBrainAdmissionResult, type BodyBrainCompletion,
  type BodyBrainCompletionResult, type BodyBrainDeterminism, type BodyBrainPromptOrigin,
  type BodyBrainEvent, type BodyBrainGenerationRequest, type BodyBrainMutationResult,
  type BodyBrainPageRequest, type BodyBrainPageResult, type BodyBrainPermissionResponse,
  type BodyBrainPermissionResult, type BodyBrainPromptRequest, type BodyBrainRecoveryRecord,
  type BodyBrainSession, type BodyBrainSessionRestorer, type BodyBrainSnapshot, type BodyBrainTurnOutcome,
} from './body-brain.js';
import {
  type AcpBodyBrainDelivery, type AcpCommandFailureCode, type AcpLifecycleFailureCode, type AcpSessionMetadata,
  type AcpStartRequest, AcpBodyBrainTransportBoundary,
} from './acp-body-brain-transport.js';

export const ACP_BODY_BRAIN_RECOVERY_VERSION = 1 as const;

export type AcpBodyBrainOutboxPhase = 'pending' | 'in_flight' | 'accepted' | 'rejected';
export type AcpBodyBrainOutboxOperation = 'submit' | 'permission' | 'cancel' | 'force' | 'close' | 'retire';

interface AcpBodyBrainOutboxBase {
  operation: AcpBodyBrainOutboxOperation;
  commandId: string;
  generation: string;
  requestHash: string;
  phase: AcpBodyBrainOutboxPhase;
  result?: 'accepted' | AcpCommandFailureCode;
}
export type AcpBodyBrainOutboxEntry = Readonly<AcpBodyBrainOutboxBase & (
  | { operation: 'submit'; promptId: string; origin: BodyBrainPromptOrigin; body: { digest: string; bytes: number } }
  | { operation: 'permission'; permissionId: string; providerPermissionId: string; optionId: string }
  | { operation: 'cancel' | 'force' | 'close' | 'retire' }
)>;

export interface AcpBodyBrainRecoveryEnvelope {
  schemaVersion: 1;
  adapterId: string;
  planDigest: string;
  generation: string;
  sessionRef: string;
  sessionMetadata: Readonly<AcpSessionMetadata>;
  bodyBrain: Readonly<BodyBrainRecoveryRecord>;
  permissionBindings: readonly Readonly<{ permissionId: string; providerPermissionId: string; promptId: string }>[];
  outbox: readonly AcpBodyBrainOutboxEntry[];
  integrityDigest: string;
}

export type AcpBodyBrainEnvelopeResult =
  | { state: 'ok'; envelope: Readonly<AcpBodyBrainRecoveryEnvelope> }
  | { state: 'failed'; code: 'corrupt_recovery' };

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && !descriptor.get && !descriptor.set;
  });
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}
function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= BODY_BRAIN_MAX_ID_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}
function digest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
function integrity(value: Omit<AcpBodyBrainRecoveryEnvelope, 'integrityDigest'>): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}
function origin(value: unknown): value is BodyBrainPromptOrigin {
  if (!plain(value) || !token(value.kind)) return false;
  if (value.kind === 'startup') return exact(value, ['kind']);
  if (value.kind === 'owner' || value.kind === 'local_console' || value.kind === 'monitor')
    return exact(value, ['kind', 'requestId']) && token(value.requestId);
  return value.kind === 'scheduled' && exact(value, ['kind', 'loopId', 'runId']) && token(value.loopId) && token(value.runId);
}
const failures = new Set<AcpCommandFailureCode>([
  'invalid_request', 'generation_changed', 'closed', 'body_unavailable', 'body_digest_mismatch',
  'body_length_mismatch', 'body_oversize', 'adapter_rejected', 'adapter_unavailable',
]);
function validOutbox(raw: unknown, generation: string): raw is AcpBodyBrainOutboxEntry {
  if (!plain(raw) || !token(raw.operation) || !token(raw.commandId) || raw.generation !== generation
    || !digest(raw.requestHash) || !token(raw.phase)) return false;
  if (raw.phase === 'pending' || raw.phase === 'in_flight') {
    if (raw.result !== undefined) return false;
  } else if (raw.phase === 'accepted') {
    if (raw.result !== 'accepted') return false;
  } else if (raw.phase === 'rejected') {
    if (!failures.has(raw.result as AcpCommandFailureCode)) return false;
  } else return false;
  const base = ['operation', 'commandId', 'generation', 'requestHash', 'phase'];
  const optional = ['result'];
  if (raw.operation === 'submit') return exact(raw, [...base, 'promptId', 'origin', 'body'], optional)
    && token(raw.promptId) && origin(raw.origin) && plain(raw.body) && exact(raw.body, ['digest', 'bytes'])
    && digest(raw.body.digest) && Number.isSafeInteger(raw.body.bytes) && (raw.body.bytes as number) >= 0;
  if (raw.operation === 'permission') return exact(raw, [...base, 'permissionId', 'providerPermissionId', 'optionId'], optional)
    && token(raw.permissionId) && token(raw.providerPermissionId) && token(raw.optionId);
  return (raw.operation === 'cancel' || raw.operation === 'force' || raw.operation === 'close' || raw.operation === 'retire')
    && exact(raw, base, optional);
}
function cloneFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const clone = (Array.isArray(value) ? value.map(cloneFreeze)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneFreeze(child)]))) as T;
  return Object.freeze(clone);
}

/** Creates an integrity-bound (not authenticated), body-free durable recovery envelope. */
export function createAcpBodyBrainRecoveryEnvelope(
  value: Omit<AcpBodyBrainRecoveryEnvelope, 'schemaVersion' | 'integrityDigest'>,
): Readonly<AcpBodyBrainRecoveryEnvelope> {
  const unsigned = cloneFreeze({ schemaVersion: ACP_BODY_BRAIN_RECOVERY_VERSION, ...value });
  const result = { ...unsigned, integrityDigest: integrity(unsigned) };
  const validated = validateAcpBodyBrainRecoveryEnvelope(result);
  if (validated.state !== 'ok') throw new TypeError('invalid ACP BodyBrain recovery envelope');
  return validated.envelope;
}

export function validateAcpBodyBrainRecoveryEnvelope(raw: unknown): AcpBodyBrainEnvelopeResult {
  if (!plain(raw) || !exact(raw, ['schemaVersion', 'adapterId', 'planDigest', 'generation', 'sessionRef',
    'sessionMetadata', 'bodyBrain', 'permissionBindings', 'outbox', 'integrityDigest']) || raw.schemaVersion !== 1
    || !token(raw.adapterId) || !digest(raw.planDigest) || !token(raw.generation) || !token(raw.sessionRef)
    || !plain(raw.sessionMetadata) || !exact(raw.sessionMetadata, ['schemaVersion', 'token', 'digest'])
    || raw.sessionMetadata.schemaVersion !== 1 || typeof raw.sessionMetadata.token !== 'string'
    || raw.sessionMetadata.token.length < 1 || !digest(raw.sessionMetadata.digest)
    || !plain(raw.bodyBrain) || raw.bodyBrain.generation !== raw.generation || raw.bodyBrain.sessionRef !== raw.sessionRef
    || !Array.isArray(raw.permissionBindings) || raw.permissionBindings.length > BODY_BRAIN_MAX_COMMANDS
    || !raw.permissionBindings.every(binding => plain(binding)
      && exact(binding, ['permissionId', 'providerPermissionId', 'promptId'])
      && token(binding.permissionId) && token(binding.providerPermissionId) && token(binding.promptId))
    || !Array.isArray(raw.outbox) || raw.outbox.length > BODY_BRAIN_MAX_COMMANDS
    || !raw.outbox.every(entry => validOutbox(entry, String(raw.generation))) || !digest(raw.integrityDigest))
    return { state: 'failed', code: 'corrupt_recovery' };
  const ids = raw.outbox.map(entry => (entry as AcpBodyBrainOutboxEntry).commandId);
  if (new Set(ids).size !== ids.length) return { state: 'failed', code: 'corrupt_recovery' };
  const permissionIds = raw.permissionBindings.map(binding => (binding as { permissionId: string }).permissionId);
  const providerPermissionIds = raw.permissionBindings.map(binding => (binding as { providerPermissionId: string }).providerPermissionId);
  if (new Set(permissionIds).size !== permissionIds.length || new Set(providerPermissionIds).size !== providerPermissionIds.length)
    return { state: 'failed', code: 'corrupt_recovery' };
  const { integrityDigest, ...unsigned } = raw;
  if (integrity(unsigned as Omit<AcpBodyBrainRecoveryEnvelope, 'integrityDigest'>) !== integrityDigest)
    return { state: 'failed', code: 'corrupt_recovery' };
  return { state: 'ok', envelope: cloneFreeze(raw as unknown as AcpBodyBrainRecoveryEnvelope) };
}

/** Only work proven never invoked is eligible for recovery replay. */
export function replayableAcpBodyBrainOutbox(
  envelope: Readonly<AcpBodyBrainRecoveryEnvelope>,
): readonly AcpBodyBrainOutboxEntry[] {
  return Object.freeze(envelope.outbox.filter(entry => entry.phase === 'pending'));
}

/** Work that recovery must observe but must never replay without provider idempotency. */
export function uncertainAcpBodyBrainOutbox(
  envelope: Readonly<AcpBodyBrainRecoveryEnvelope>,
): readonly AcpBodyBrainOutboxEntry[] {
  return Object.freeze(envelope.outbox.filter(entry => entry.phase === 'in_flight'));
}

export type AcpBodyBrainOutboxTransitionResult =
  | { state: 'updated'; outbox: readonly AcpBodyBrainOutboxEntry[] }
  | { state: 'unknown_command' | 'phase_conflict' | 'invalid_result' };

/** Pure immutable phase reducer; accepted/rejected entries are terminal. */
export function transitionAcpBodyBrainOutbox(
  outbox: readonly AcpBodyBrainOutboxEntry[], commandId: string,
  transition: 'invoke' | { settle: 'accepted' } | { settle: 'rejected'; code: AcpCommandFailureCode },
): AcpBodyBrainOutboxTransitionResult {
  const index = outbox.findIndex(entry => entry.commandId === commandId);
  if (index < 0) return { state: 'unknown_command' };
  const current = outbox[index];
  let replacement: AcpBodyBrainOutboxEntry;
  if (transition === 'invoke') {
    if (current.phase !== 'pending') return { state: 'phase_conflict' };
    replacement = { ...current, phase: 'in_flight' } as AcpBodyBrainOutboxEntry;
  } else {
    if (current.phase !== 'in_flight') return { state: 'phase_conflict' };
    if (transition.settle === 'accepted') replacement = { ...current, phase: 'accepted', result: 'accepted' } as AcpBodyBrainOutboxEntry;
    else {
      if (!failures.has(transition.code)) return { state: 'invalid_result' };
      replacement = { ...current, phase: 'rejected', result: transition.code } as AcpBodyBrainOutboxEntry;
    }
  }
  const next = outbox.map((entry, position) => position === index ? replacement : entry);
  return { state: 'updated', outbox: cloneFreeze(next) };
}

export type AcpBodyBrainPumpState = 'idle' | 'scheduled' | 'running' | 'stopped';

export interface AcpBodyBrainStartedTransport {
  transport: AcpBodyBrainTransportBoundary;
  sessionMetadata: Readonly<AcpSessionMetadata>;
  attachDelivery(listener: (delivery: AcpBodyBrainDelivery) => void): boolean;
  cleanup(): Promise<void>;
}

export type AcpBodyBrainStartResult =
  | { state: 'accepted'; started: Readonly<AcpBodyBrainStartedTransport> }
  | { state: 'failed'; code: AcpLifecycleFailureCode };

/**
 * Acquires the transport listener before launch and transfers both resources
 * to one monotonic cleanup handle. A failed or throwing launch is fully
 * unwound here; dependency exceptions never escape with provider details.
 */
async function acquireAcpBodyBrainTransport(
  transport: AcpBodyBrainTransportBoundary,
  operation: () => ReturnType<AcpBodyBrainTransportBoundary['start']>,
): Promise<AcpBodyBrainStartResult> {
  let unsubscribe: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let deliveryListener: ((delivery: AcpBodyBrainDelivery) => void) | undefined;
  let deliveryAttached = false;
  let deliveryOpen = true;
  const bufferedDeliveries: AcpBodyBrainDelivery[] = [];
  const relay = (delivery: AcpBodyBrainDelivery): void => {
    if (!deliveryOpen) return;
    const owned = cloneFreeze(delivery);
    if (deliveryListener) deliveryListener(owned);
    else bufferedDeliveries.push(owned);
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    deliveryOpen = false;
    deliveryListener = undefined;
    bufferedDeliveries.length = 0;
    try { unsubscribe?.(); } catch { /* transport cleanup remains authoritative */ }
    unsubscribe = undefined;
    cleanupPromise = transport.cleanup();
    return cleanupPromise;
  };
  try {
    unsubscribe = transport.subscribe(relay);
    if (!unsubscribe) {
      await cleanup();
      return Object.freeze({ state: 'failed', code: 'listener_required' });
    }
    const result = await operation();
    if (result.state === 'failed') {
      await cleanup();
      return Object.freeze({ state: 'failed', code: result.code });
    }
    const started: AcpBodyBrainStartedTransport = Object.freeze({
      transport,
      sessionMetadata: cloneFreeze(result.sessionMetadata),
      attachDelivery: (next: (delivery: AcpBodyBrainDelivery) => void): boolean => {
        if (!deliveryOpen || deliveryAttached || typeof next !== 'function') return false;
        deliveryAttached = true;
        deliveryListener = next;
        const pending = bufferedDeliveries.splice(0);
        for (const delivery of pending) {
          if (!deliveryOpen || deliveryListener !== next) break;
          next(delivery);
        }
        return true;
      },
      cleanup,
    });
    return Object.freeze({ state: 'accepted', started });
  } catch {
    try { await cleanup(); } catch { /* failure remains closed and redacted */ }
    return Object.freeze({ state: 'failed', code: 'adapter_unavailable' });
  }
}

export function startAcpBodyBrainTransport(
  transport: AcpBodyBrainTransportBoundary,
  request: Readonly<AcpStartRequest>,
): Promise<AcpBodyBrainStartResult> {
  return acquireAcpBodyBrainTransport(transport, () => transport.start(request));
}

export type AcpBodyBrainRestoreFactoryResult =
  | { state: 'restored'; reducer: AcpBodyBrainAdmissionReducer }
  | { state: 'failed'; code: 'corrupt_recovery' | 'resume_rejected' | 'adapter_incompatible' | AcpLifecycleFailureCode };

function validRestoreBindings(envelope: Readonly<AcpBodyBrainRecoveryEnvelope>): boolean {
  const admissions = new Map(envelope.bodyBrain.admissions.map(entry => [entry.request.commandId, entry]));
  const submits = envelope.outbox.filter(entry => entry.operation === 'submit');
  if (submits.length !== admissions.size || new Set(submits.map(entry => entry.commandId)).size !== admissions.size)
    return false;
  for (const entry of envelope.outbox) {
    if (entry.operation !== 'submit') continue;
    const admission = admissions.get(entry.commandId);
    if (!admission || admission.requestHash !== entry.requestHash || admission.receipt.promptId !== entry.promptId
      || canonical(admission.request.origin) !== canonical(entry.origin)
      || canonical(admission.request.body) !== canonical(entry.body)) return false;
  }
  if (envelope.bodyBrain.activePromptId) {
    const active = envelope.bodyBrain.admissions.find(entry => entry.receipt.promptId === envelope.bodyBrain.activePromptId);
    if (!active || !envelope.outbox.some(entry => entry.operation === 'submit'
      && entry.commandId === active.request.commandId && entry.promptId === active.receipt.promptId)) return false;
  }
  const permissions = new Map(envelope.bodyBrain.permissions.map(value => [value.permissionId, value]));
  if (permissions.size !== envelope.permissionBindings.length) return false;
  for (const binding of envelope.permissionBindings) {
    const permission = permissions.get(binding.permissionId);
    if (!permission || permission.promptId !== binding.promptId) return false;
  }
  const permissionCommands = envelope.bodyBrain.permissionCommands.filter(value => value.result.state === 'accepted');
  const permissionOutbox = envelope.outbox.filter(entry => entry.operation === 'permission');
  if (permissionCommands.length !== permissionOutbox.length) return false;
  for (const entry of permissionOutbox) {
    if (!permissionCommands.some(command => command.commandId === entry.commandId
      && command.permissionId === entry.permissionId && command.optionId === entry.optionId)) return false;
  }
  const acceptedMutations = envelope.bodyBrain.mutations.filter(value => value.result.state === 'accepted');
  const mutationOutbox = envelope.outbox.filter(entry => entry.operation === 'cancel' || entry.operation === 'force'
    || entry.operation === 'close' || entry.operation === 'retire');
  if (acceptedMutations.length !== mutationOutbox.length) return false;
  for (const entry of mutationOutbox) {
    if (!acceptedMutations.some(mutation => mutation.commandId === entry.commandId
      && mutation.operation === entry.operation)) return false;
  }
  return true;
}

export interface AcpBodyBrainEngineDriver {
  complete(
    session: BodyBrainSession, promptId: string, outcome: BodyBrainTurnOutcome,
    output?: Readonly<{ digest: string; bytes: number }>, reasonCode?: string,
  ): BodyBrainCompletionResult;
  requestPermission(session: BodyBrainSession, promptId: string, optionIds: readonly string[]): string | undefined;
}

export interface AcpBodyBrainSessionEngineFactory {
  start(input: Readonly<{
    adapterId: string; generation: string; sessionMetadata: Readonly<AcpSessionMetadata>;
  }>): Readonly<{ session: BodyBrainSession; driver: AcpBodyBrainEngineDriver }>;
  bindRestored(session: BodyBrainSession): AcpBodyBrainEngineDriver;
}

export type AcpBodyBrainSessionStartResult =
  | { state: 'started'; reducer: AcpBodyBrainAdmissionReducer }
  | { state: 'failed'; code: AcpLifecycleFailureCode | 'adapter_incompatible' };

export async function startAcpBodyBrainSession(
  transport: AcpBodyBrainTransportBoundary, request: Readonly<AcpStartRequest>,
  engines: Readonly<AcpBodyBrainSessionEngineFactory>,
): Promise<AcpBodyBrainSessionStartResult> {
  const acquired = await startAcpBodyBrainTransport(transport, request);
  if (acquired.state !== 'accepted') return acquired;
  try {
    const adapterId = transport.presentation().adapterId;
    const engine = engines.start({
      adapterId, generation: request.generation,
      sessionMetadata: acquired.started.sessionMetadata,
    });
    if (engine.session.generation !== request.generation)
      throw new TypeError('engine generation mismatch');
    return { state: 'started', reducer: new AcpBodyBrainAdmissionReducer(
      engine.session, engine.driver, acquired.started, adapterId, request.planDigest,
    ) };
  } catch {
    try { await acquired.started.cleanup(); } catch { /* failure remains closed */ }
    return { state: 'failed', code: 'adapter_incompatible' };
  }
}

/** Validates all durable state before subscribing or invoking the provider. */
export async function restoreAcpBodyBrainSession(
  transport: AcpBodyBrainTransportBoundary,
  rawEnvelope: unknown,
  restorer: Readonly<BodyBrainSessionRestorer>,
  engines: Readonly<AcpBodyBrainSessionEngineFactory>,
): Promise<AcpBodyBrainRestoreFactoryResult> {
  let envelope: Readonly<AcpBodyBrainRecoveryEnvelope>;
  let restoredBody: ReturnType<BodyBrainSessionRestorer['restore']>;
  try {
    const validated = validateAcpBodyBrainRecoveryEnvelope(rawEnvelope);
    if (validated.state !== 'ok' || !restorer || typeof restorer.restore !== 'function'
      || !engines || typeof engines.bindRestored !== 'function') return { state: 'failed', code: 'corrupt_recovery' };
    envelope = validated.envelope;
    if (!validRestoreBindings(envelope)) return { state: 'failed', code: 'corrupt_recovery' };
    restoredBody = restorer.restore(envelope.bodyBrain);
  } catch { return { state: 'failed', code: 'corrupt_recovery' }; }
  if (restoredBody.state !== 'restored') return {
    state: 'failed', code: restoredBody.code === 'adapter_incompatible' ? 'adapter_incompatible' : 'corrupt_recovery',
  };
  try {
    if (restoredBody.session.generation !== envelope.generation || restoredBody.session.sessionRef !== envelope.sessionRef
      || transport.presentation().adapterId !== envelope.adapterId) return { state: 'failed', code: 'adapter_incompatible' };
  } catch { return { state: 'failed', code: 'adapter_incompatible' }; }
  const acquired = await acquireAcpBodyBrainTransport(transport, () => transport.restore({
    protocolVersion: 1, generation: envelope.generation, planDigest: envelope.planDigest,
    sessionMetadata: envelope.sessionMetadata,
  }));
  if (acquired.state !== 'accepted') return acquired;
  if (canonical(acquired.started.sessionMetadata) !== canonical(envelope.sessionMetadata)) {
    await acquired.started.cleanup();
    return { state: 'failed', code: 'resume_rejected' };
  }
  try {
    const driver = engines.bindRestored(restoredBody.session);
    return { state: 'restored', reducer: new AcpBodyBrainAdmissionReducer(
      restoredBody.session, driver, acquired.started, envelope.adapterId, envelope.planDigest,
      envelope.outbox, envelope.permissionBindings,
    ) };
  } catch {
    try { await acquired.started.cleanup(); } catch { /* restore failure remains redacted */ }
    return { state: 'failed', code: 'corrupt_recovery' };
  }
}

export interface AcpBodyBrainAdmissionSnapshot {
  generation: string;
  activePromptId?: string;
  queuedPromptIds: readonly string[];
  bodyBrain: Readonly<BodyBrainRecoveryRecord>;
  outbox: readonly AcpBodyBrainOutboxEntry[];
}

/**
 * Synchronous local admission authority for an active ACP transport. Provider
 * acceptance is deliberately downstream: receipts describe durable local
 * queue admission and never change after the asynchronous transport result.
 */
export class AcpBodyBrainAdmissionReducer implements BodyBrainSession {
  private readonly deliveries: AcpBodyBrainDelivery[] = [];
  private readonly providerPermissionIds = new Map<string, { providerPermissionId: string; promptId: string }>();
  private outbox: readonly AcpBodyBrainOutboxEntry[];
  private lifecycle: 'active' | 'closed' = 'active';
  private epoch = 0;
  private readonly pump: AcpBodyBrainOutboxPump;

  constructor(
    private readonly bodyBrain: BodyBrainSession,
    private readonly driver: AcpBodyBrainEngineDriver,
    private readonly started: Readonly<AcpBodyBrainStartedTransport>,
    private readonly adapterId: string,
    private readonly planDigest: string,
    outbox: readonly AcpBodyBrainOutboxEntry[] = [],
    permissionBindings: readonly Readonly<{ permissionId: string; providerPermissionId: string; promptId: string }>[] = [],
  ) {
    if (!bodyBrain || !token(bodyBrain.generation) || !token(bodyBrain.sessionRef)
      || !driver || typeof driver.complete !== 'function' || typeof driver.requestPermission !== 'function'
      || !token(adapterId) || !digest(planDigest)) throw new TypeError('invalid ACP admission reducer');
    this.outbox = cloneFreeze(outbox);
    for (const binding of permissionBindings) this.providerPermissionIds.set(binding.permissionId, cloneFreeze({
      providerPermissionId: binding.providerPermissionId, promptId: binding.promptId,
    }));
    this.pump = new AcpBodyBrainOutboxPump(() => this.reduceOne());
    let installing = true;
    if (!started.attachDelivery(delivery => {
      if (this.lifecycle !== 'active') return;
      this.deliveries.push(cloneFreeze(delivery));
      if (!installing) this.pump.schedule();
    })) throw new TypeError('ACP delivery ownership unavailable');
    installing = false;
    for (let delivery = this.deliveries.shift(); delivery; delivery = this.deliveries.shift())
      this.reduceDelivery(delivery);
    if (this.hasPendingWork() || this.deliveries.length > 0) this.pump.schedule();
  }

  get generation(): string { return this.bodyBrain.generation; }
  get sessionRef(): string { return this.bodyBrain.sessionRef; }

  admitPrompt(raw: BodyBrainPromptRequest): BodyBrainAdmissionResult {
    if (this.lifecycle === 'closed') return { state: 'closed' };
    const result = this.bodyBrain.admitPrompt(raw);
    if (result.state !== 'accepted') return result;
    if (!this.outbox.some(entry => entry.operation === 'submit' && entry.commandId === result.receipt.commandId)) {
      const recovered = this.bodyBrain.recoveryRecord().admissions
        .find(entry => entry.request.commandId === result.receipt.commandId);
      if (!recovered) throw new TypeError('shared engine omitted admitted prompt recovery');
      this.outbox = cloneFreeze([...this.outbox, {
        operation: 'submit' as const, commandId: recovered.request.commandId, generation: this.generation,
        requestHash: recovered.requestHash, phase: 'pending' as const, promptId: recovered.receipt.promptId,
        origin: recovered.request.origin, body: recovered.request.body,
      }]);
      if (result.receipt.state === 'started') this.pump.schedule();
    }
    return cloneFreeze(result);
  }

  awaitCompletion(generation: string, promptId: string): BodyBrainCompletionResult | { state: 'stale_generation' } {
    return cloneFreeze(this.bodyBrain.awaitCompletion(generation, promptId));
  }

  snapshot(): Readonly<BodyBrainSnapshot> { return cloneFreeze(this.bodyBrain.snapshot()); }
  page(request?: BodyBrainPageRequest): BodyBrainPageResult { return cloneFreeze(this.bodyBrain.page(request)); }
  subscribe(listener: (event: BodyBrainEvent) => void): () => void { return this.bodyBrain.subscribe(listener); }
  recoveryRecord(): Readonly<BodyBrainRecoveryRecord> { return cloneFreeze(this.bodyBrain.recoveryRecord()); }

  adapterSnapshot(): Readonly<AcpBodyBrainAdmissionSnapshot> {
    const snapshot = this.bodyBrain.snapshot();
    const recovery = this.bodyBrain.recoveryRecord();
    return cloneFreeze({
      generation: this.generation,
      ...(snapshot.activePromptId ? { activePromptId: snapshot.activePromptId } : {}),
      queuedPromptIds: recovery.promptQueue,
      bodyBrain: recovery,
      outbox: this.outbox,
    });
  }

  recoveryEnvelope(): Readonly<AcpBodyBrainRecoveryEnvelope> {
    return createAcpBodyBrainRecoveryEnvelope({
      adapterId: this.adapterId, planDigest: this.planDigest,
      generation: this.generation, sessionRef: this.sessionRef,
      sessionMetadata: this.started.sessionMetadata, bodyBrain: this.bodyBrain.recoveryRecord(),
      permissionBindings: [...this.providerPermissionIds.entries()].map(([permissionId, value]) => ({ permissionId, ...value })),
      outbox: this.outbox,
    });
  }

  respondPermission(request: BodyBrainPermissionResponse): BodyBrainPermissionResult {
    if (this.lifecycle === 'closed') return { state: 'closed' };
    const result = this.bodyBrain.respondPermission(request);
    const binding = this.providerPermissionIds.get(request.permissionId);
    if (result.state === 'accepted' && binding) this.enqueueControl({
      operation: 'permission', commandId: request.commandId, generation: request.generation,
      requestHash: this.requestHash({ operation: 'permission', request }), phase: 'pending',
      permissionId: request.permissionId, providerPermissionId: binding.providerPermissionId, optionId: request.optionId,
    });
    return cloneFreeze(result);
  }

  requestCancel(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.mutateCanonical('cancel', request, () => this.bodyBrain.requestCancel(request));
  }
  forceTerminate(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.mutateCanonical('force', request, () => this.bodyBrain.forceTerminate(request));
  }
  close(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.mutateCanonical('close', request, () => this.bodyBrain.close(request));
  }
  retire(request: BodyBrainGenerationRequest): BodyBrainMutationResult {
    return this.mutateCanonical('retire', request, () => this.bodyBrain.retire(request));
  }

  private mutateCanonical(
    operation: 'cancel' | 'force' | 'close' | 'retire', request: BodyBrainGenerationRequest,
    apply: () => BodyBrainMutationResult,
  ): BodyBrainMutationResult {
    if (this.lifecycle === 'closed') return { state: 'closed' };
    const result = apply();
    if (result.state === 'accepted') this.enqueueControl({
      operation, commandId: request.commandId, generation: request.generation,
      requestHash: this.requestHash({ operation, request }), phase: 'pending',
    });
    return cloneFreeze(result);
  }

  private requestHash(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
  }

  private enqueueControl(entry: AcpBodyBrainOutboxEntry): void {
    if (this.outbox.some(value => value.commandId === entry.commandId)) return;
    this.outbox = cloneFreeze([...this.outbox, entry]);
    this.pump.schedule();
  }

  private async reduceOne(): Promise<boolean> {
    const delivery = this.deliveries.shift();
    if (delivery) {
      this.reduceDelivery(delivery);
      return this.deliveries.length > 0 || this.hasPendingWork();
    }
    if (this.lifecycle !== 'active') return false;
    const activePromptId = this.bodyBrain.snapshot().activePromptId;
    const activeAdmission = activePromptId
      ? this.bodyBrain.recoveryRecord().admissions.find(entry => entry.receipt.promptId === activePromptId)
      : undefined;
    const entry = this.outbox.find(value => value.phase === 'pending' && (value.operation !== 'submit'
      || (activeAdmission !== undefined && value.commandId === activeAdmission.request.commandId)));
    if (!entry) return false;
    const transition = transitionAcpBodyBrainOutbox(this.outbox, entry.commandId, 'invoke');
    if (transition.state !== 'updated') return false;
    this.outbox = transition.outbox;
    const epoch = this.epoch;
    let result: { state: 'accepted' } | { state: 'failed'; code: AcpCommandFailureCode };
    try {
      result = await this.invokeOutbox(entry, activeAdmission);
    } catch { result = { state: 'failed', code: 'adapter_unavailable' }; }
    if (this.lifecycle !== 'active' || epoch !== this.epoch || entry.generation !== this.generation) return false;
    const settled = transitionAcpBodyBrainOutbox(this.outbox, entry.commandId,
      result.state === 'accepted' ? { settle: 'accepted' } : { settle: 'rejected', code: result.code });
    if (settled.state === 'updated') this.outbox = settled.outbox;
    if (result.state === 'failed' && entry.operation === 'submit' && activePromptId
      && this.bodyBrain.snapshot().activePromptId === activePromptId) {
      this.driver.complete(this.bodyBrain, activePromptId, 'failed', undefined, result.code);
    }
    return this.hasPendingWork();
  }

  private invokeOutbox(
    entry: AcpBodyBrainOutboxEntry,
    admission?: Readonly<BodyBrainRecoveryRecord['admissions'][number]>,
  ): Promise<{ state: 'accepted' } | { state: 'failed'; code: AcpCommandFailureCode }> {
    if (entry.operation === 'submit') {
      if (!admission || admission.receipt.promptId !== entry.promptId)
        return Promise.resolve({ state: 'failed', code: 'invalid_request' });
      return this.started.transport.submit({
        generation: this.generation, commandId: entry.commandId, promptId: entry.promptId,
        origin: entry.origin, body: entry.body,
      });
    }
    if (entry.operation === 'permission') return this.started.transport.respondPermission({
      generation: this.generation, commandId: entry.commandId,
      permissionId: entry.providerPermissionId, optionId: entry.optionId,
    });
    const request = { generation: this.generation, commandId: entry.commandId };
    if (entry.operation === 'cancel') return this.started.transport.cancel(request);
    if (entry.operation === 'force') return this.started.transport.forceTerminate(request);
    if (entry.operation === 'close') return this.started.transport.close(request);
    return this.started.transport.retire(request);
  }

  private hasPendingActiveSubmit(): boolean {
    const activePromptId = this.bodyBrain.snapshot().activePromptId;
    if (!activePromptId) return false;
    const active = this.bodyBrain.recoveryRecord().admissions.find(entry => entry.receipt.promptId === activePromptId);
    return !!active && this.outbox.some(entry => entry.commandId === active.request.commandId && entry.phase === 'pending');
  }

  private hasPendingWork(): boolean {
    return this.outbox.some(entry => entry.phase === 'pending' && entry.operation !== 'submit')
      || this.hasPendingActiveSubmit();
  }

  private reduceDelivery(delivery: AcpBodyBrainDelivery): void {
    if (this.lifecycle !== 'active' || delivery.state !== 'notification') return;
    const notification = delivery.notification;
    const activeId = this.bodyBrain.snapshot().activePromptId;
    if (notification.generation !== this.generation || !activeId) return;
    let outcome: BodyBrainTurnOutcome | undefined;
    let output: Readonly<{ digest: string; bytes: number }> | undefined;
    let reasonCode: string | undefined;
    if (notification.kind === 'completed') {
      if (notification.promptId !== activeId) return;
      outcome = notification.outcome; output = notification.output;
    } else if (notification.kind === 'exited') {
      if (notification.promptId !== undefined && notification.promptId !== activeId) return;
      outcome = notification.code === 'forced' ? 'cancelled' : notification.code === 'lost' ? 'failed' : 'inconclusive';
      reasonCode = notification.code;
    } else if (notification.kind === 'failed') {
      if (notification.promptId !== undefined && notification.promptId !== activeId) return;
      outcome = 'failed'; reasonCode = notification.code;
    } else if (notification.kind === 'permission_requested') {
      if (notification.promptId !== activeId) return;
      const permissionId = this.driver.requestPermission(this.bodyBrain, activeId, notification.optionIds);
      if (permissionId) this.providerPermissionIds.set(permissionId, {
        providerPermissionId: notification.permissionId, promptId: activeId,
      });
      return;
    } else return;
    const completed = this.driver.complete(this.bodyBrain, activeId, outcome, output, reasonCode);
    if (completed.state === 'terminal' && this.hasPendingActiveSubmit()) this.pump.schedule();
  }

  async settled(): Promise<void> { await this.pump.settled(); }

  async cleanup(): Promise<void> {
    if (this.lifecycle === 'closed') { await this.pump.stop(); await this.started.cleanup(); return; }
    this.lifecycle = 'closed';
    this.epoch++;
    this.deliveries.length = 0;
    await this.pump.stop();
    await this.started.cleanup();
  }
}

/**
 * Single-consumer microtask pump. schedule() during a drain sets a durable
 * wake flag, so work admitted at the empty-queue boundary cannot be lost.
 * No timers are used; the owner supplies the bounded next-operation reducer.
 */
export class AcpBodyBrainOutboxPump {
  private current: AcpBodyBrainPumpState = 'idle';
  private wakeRequested = false;
  private epoch = 0;
  private active?: Promise<void>;

  constructor(private readonly reduceOne: () => Promise<boolean>) {}

  get state(): AcpBodyBrainPumpState { return this.current; }
  private isStopped(): boolean { return this.current === 'stopped'; }

  schedule(): void {
    if (this.current === 'stopped') return;
    if (this.current === 'running') { this.wakeRequested = true; return; }
    if (this.current === 'scheduled') return;
    this.current = 'scheduled';
    const epoch = this.epoch;
    this.active = Promise.resolve().then(() => this.drain(epoch));
  }

  private async drain(epoch: number): Promise<void> {
    if (this.current === 'stopped' || epoch !== this.epoch) return;
    this.current = 'running';
    do {
      this.wakeRequested = false;
      let consumed: boolean;
      try { consumed = await this.reduceOne(); }
      catch {
        // Dependency failure consumes no implicit retry. The owning reducer
        // records a closed redacted result before throwing when appropriate.
        consumed = false;
      }
      if (this.isStopped() || epoch !== this.epoch) return;
      if (consumed) this.wakeRequested = true;
    } while (this.wakeRequested);
    this.current = 'idle';
  }

  async settled(): Promise<void> { await this.active; }

  async stop(): Promise<void> {
    if (this.current === 'stopped') { await this.active; return; }
    this.current = 'stopped';
    this.epoch++;
    await this.active;
  }
}
