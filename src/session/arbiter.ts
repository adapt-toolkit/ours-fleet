import type {
  ConversationHandlePage, ExitRecord, InterruptOutcome, PromptOrigin, QueuedPrompt, SessionEvent,
  AgentSession, SessionSnapshot,
  SubmitPromptOptions, TurnCancellationSource, TurnResult,
} from './types.js';
import {
  ACP_CANCEL_DEADLINE_EXCEEDED, SessionControlError, interruptOutcome,
} from './types.js';
import type {
  ConversationEventV1, ConversationSnapshot, PromptReceipt,
  SubmitPromptCommand,
} from './conversation-types.js';

export type ReminderAttempt =
  /** Admitted; `queued.completion` settles when the turn (or its refusal) ends. */
  | { state: 'admitted'; queued: QueuedPrompt }
  | { state: 'busy' }
  | { state: 'unavailable'; error: string; admitted: false };

/**
 * The single interruption an urgent reminder may request, as the arbiter saw
 * it. `target` names the exact checked turn; `outcome` is what the session
 * and the target's own terminal result actually reported.
 */
export interface UrgentInterruptReport {
  target: UrgentInterruptTarget;
  outcome: 'cancelled' | 'ended' | 'forced' | 'failed';
  reason?: string;
}

export interface UrgentInterruptTarget {
  source: NonNullable<SessionSnapshot['activePromptSource']>;
  sessionId?: string;
  generation: string;
  promptId: string;
}

/** The urgent path's durable seams; every one is synchronous and owned by the reminder store. */
export interface UrgentReminderHooks {
  /** The durable `admitting` claim (as for `tryReminder`). False: nothing is queued. */
  beforeQueue(): boolean;
  /** Release fence; the only way the prompt reaches the model. */
  releaseGuard(): boolean;
  /** Whether this event may still request its one interruption. */
  mayInterrupt(): boolean;
  /** Durable mark written BEFORE the session is asked to cancel. False: do not cancel. */
  markRequested(target: UrgentInterruptTarget): boolean;
  /** How the requested interruption ended. */
  recordOutcome(report: UrgentInterruptReport): void;
  /** The busy turn was not interruptible this time, and why. */
  deferred(reason: UrgentDeferral): void;
  /** Still this caller's current, undispatched claim? Re-checked after every await. */
  stillAdmitting(): boolean;
  /** The wake text, built once the interruption (if any) is known. */
  text(report?: UrgentInterruptReport): string;
}

export type UrgentDeferral =
  | 'protected_turn' | 'untracked_turn' | 'permission_pending' | 'queued_work' | 'session_starting'
  | 'interrupt_unsupported' | 'uncorrelatable' | 'interrupt_already_used';

/**
 * Turn sources an urgent reminder may cancel. Owner-channel requests and the
 * owner console are owner commands: cancelling one finalizes the request and
 * its reply route (owner-channel/channel.ts), which is an owner-visible
 * effect. Startup is the readiness gate, stall-watchdog is mid-recovery, and
 * another self-reminder's turn must not be cancelled by a sibling.
 */
const URGENT_INTERRUPTIBLE = new Set<string>(['fleet-monitor', 'scheduled-loop', 'local-console']);
/** How long a settled cancellation may take to surface the target's own terminal result. */
const URGENT_CORRELATION_MS = 2_000;

export type ScheduledAttempt =
  | { state: 'started'; queued: QueuedPrompt }
  | { state: 'skipped_busy' }
  | { state: 'unavailable'; error: string };

/**
 * Raised for admissions that were still waiting on a generation which had to be
 * retired. It carries `ACP_CANCEL_DEADLINE_EXCEEDED` because that is the only
 * thing that ever retires a generation, and because durable owner ingress
 * already treats that reason as "never delivered — replay it".
 */
class AdmissionRetiredError extends SessionControlError {
  constructor() {
    super('control-unavailable',
      'admission was retired after a cancellation that never settled',
      ACP_CANCEL_DEADLINE_EXCEEDED);
  }
}

function retirementSignal(): { promise: Promise<void>; retire: () => void } {
  let retire!: () => void;
  const promise = new Promise<void>(resolve => { retire = resolve; });
  return { promise, retire };
}

/**
 * One in-process admission boundary for every producer targeting a role.
 * Scheduled callers get an atomic idle recheck plus submission; ordinary
 * producers retain ACP queue semantics while making their unsettled claim
 * visible before another producer can inspect idle state.
 */
export class RoleTurnArbiter implements AgentSession {
  readonly backend;
  readonly pid;
  readonly capabilities;
  private tail: Promise<void> = Promise.resolve();
  private unsettled = 0;
  /** Admissions waiting for the boundary; an urgent interruption yields to them. */
  private waiting = 0;
  /** Terminal results of prompts this arbiter admitted and that have not settled yet. */
  private readonly live = new Map<string, Promise<TurnResult>>();
  private stopping = false;
  private retiring = false;
  /** Bumped by `retireStalledAdmission`; every claim carries the one it was made under. */
  private generation = 0;
  /** Resolves the instant the CURRENT generation is retired. */
  private retirement = retirementSignal();
  private readonly boundaryListeners = new Set<() => void>();
  private stopObservingIdle?: () => void;

  constructor(private readonly session: AgentSession) {
    this.backend = session.backend;
    this.pid = session.pid;
    this.capabilities = session.capabilities;
  }

  /**
   * Waiters race the tail against their own generation's retirement, so a
   * single operation that never settles cannot own the boundary forever. A
   * woken waiter from a retired generation never runs its operation: the
   * ordering it was promised no longer exists, and admitting it silently would
   * be the one thing worse than telling the caller it was not admitted.
   */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    this.waiting++;
    let counted = true;
    const uncount = () => { if (counted) { counted = false; this.waiting = Math.max(0, this.waiting - 1); } };
    const run = Promise.race([this.tail, this.retirement.promise]).then(() => {
      uncount();
      if (generation !== this.generation) throw new AdmissionRetiredError();
      return operation();
    }, error => { uncount(); throw error; });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private track(queued: QueuedPrompt): QueuedPrompt {
    const generation = this.generation;
    this.unsettled++;
    const completion = queued.completion.finally(() => {
      this.live.delete(queued.promptId);
      // A retired generation's claims were released in one step already.
      if (generation === this.generation) this.unsettled = Math.max(0, this.unsettled - 1);
      this.admissionBoundary();
    });
    this.live.set(queued.promptId, completion);
    return { ...queued, completion };
  }

  /**
   * Called whenever the role may have become admissible again: a claim
   * settled, or the session reported idle (which already counts a steered
   * turn's occupancy). Only a hint for producers waiting on `busy`; admission
   * still makes every check itself.
   */
  onAdmissionBoundary(listener: () => void): () => void {
    this.boundaryListeners.add(listener);
    if (!this.stopObservingIdle && this.session.observeConversation) {
      let idle = false;
      const observation = this.session.observeConversation(state => {
        const now = state.readiness === 'idle';
        if (now && !idle) this.admissionBoundary();
        idle = now;
      });
      this.stopObservingIdle = () => observation.unsubscribe();
    }
    return () => {
      this.boundaryListeners.delete(listener);
      if (this.boundaryListeners.size > 0) return;
      this.stopObservingIdle?.();
      this.stopObservingIdle = undefined;
    };
  }

  private admissionBoundary(): void {
    for (const listener of [...this.boundaryListeners]) {
      try { listener(); } catch { /* a hint; the listener's own retry still runs */ }
    }
  }

  /**
   * Release the admission boundary after a cancellation that never settled.
   * Nothing can make a hung ACP call return, so the stuck operation keeps its
   * own promise — it just stops owning `tail` and stops holding a claim.
   *
   * Without this, one unsettled `interrupt` left every later producer queued
   * behind it forever: a scheduled poll never returned, so the loop was never
   * rescheduled and reported neither `started` nor `skipped_busy`, and an owner
   * prompt stayed pending with nothing to resolve it.
   *
   * One-active-run safety is unchanged. The arbiter only orders admission;
   * `tryScheduled` still asks the session itself whether it is idle, and the
   * session still refuses to run two turns at once.
   */
  retireStalledAdmission(): void {
    const retired = this.retirement;
    this.generation++;
    this.retirement = retirementSignal();
    this.tail = Promise.resolve();
    this.unsettled = 0;
    this.waiting = 0;
    retired.retire();
    this.admissionBoundary();
  }

  queuePrompt(text: string, options: SubmitPromptOptions = {}): Promise<QueuedPrompt> {
    return this.exclusive(async () => {
      if (this.retiring) throw new Error('Chat is closing');
      return this.track(await this.session.queuePrompt(text, this.monitorAdmissionOptions(options)));
    });
  }

  /** Inbox traffic must not cancel or steer an active human console/voice turn.
   * Queue it once; the monitor commits its cursor after that turn succeeds.
   * Other origins retain their configured monitor policy.
   */
  private monitorAdmissionOptions(options: SubmitPromptOptions): SubmitPromptOptions {
    if (options.origin?.kind !== 'fleet-monitor') return options;
    const active = this.session.snapshot().activePromptSource;
    // A self-reminder turn is protected the same way: a retried wake (say the
    // one an urgent reminder just interrupted) queues behind it instead of
    // cancelling it before the agent could inspect and acknowledge.
    return active === 'owner-admin-console' || active === 'self-reminder'
      ? { ...options, interrupt: false, steer: false } : options;
  }

  async submitPrompt(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
    return (await this.queuePrompt(text, options)).completion;
  }

  /**
   * Do not hold `exclusive` while ACP waits for a tool boundary: permission
   * answers and explicit interrupts must remain able to pass immediately.
   */
  submitPromptAfterTool(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
    if(this.retiring) return Promise.reject(new Error('Chat is closing'));
    if (this.monitorAdmissionOptions(options) !== options)
      return this.submitPrompt(text, options);
    return this.session.submitPromptAfterTool?.(text, options)
      ?? this.session.submitPrompt(text, { ...options, interrupt: false, steer: false });
  }

  async tryScheduled(
    text: string, origin: Extract<PromptOrigin, { kind: 'scheduled-loop' }>,
    beforeQueue?: () => void | Promise<void>,
  ): Promise<ScheduledAttempt> {
    // Give owner/console/I/O callbacks already ready in this event-loop turn a
    // chance to claim the arbiter first. Scheduled work is best-effort; humans
    // and authenticated ingress have priority at the idle boundary.
    await new Promise<void>(resolve => setImmediate(resolve));
    return this.exclusive(async (): Promise<ScheduledAttempt> => {
      const snapshot = this.session.snapshot();
      if (this.stopping || !snapshot.alive || snapshot.readiness === 'failed')
        return { state: 'unavailable', error: this.stopping ? 'role is stopping' : 'session is unavailable' };
      if (snapshot.readiness !== 'idle' || this.unsettled > 0) return { state: 'skipped_busy' };
      try {
        await beforeQueue?.();
        const queued = await this.session.queuePrompt(text, { interrupt: false, origin });
        // The race is lost, but the prompt was admitted and WILL run. Keep the
        // claim so idle accounting matches reality instead of under-counting.
        if (queued.queuedBehind > 0) {
          this.track(queued);
          return { state: 'unavailable', error: 'scheduled admission race' };
        }
        return { state: 'started', queued: this.track(queued) };
      } catch (error) {
        return { state: 'unavailable', error: (error as Error)?.message ?? String(error) };
      }
    }).catch(error => {
      // A retired attempt was never submitted. Reporting that as an outcome
      // instead of a rejection is what keeps the poll — and with it the loop's
      // own rescheduling — from being abandoned mid-tick.
      if (error instanceof AdmissionRetiredError)
        return { state: 'unavailable', error: error.message } as ScheduledAttempt;
      throw error;
    });
  }

  /**
   * Admit a self-reminder wake only into an idle role, at the same boundary
   * every producer uses. It never interrupts or steers, and never joins a
   * queue behind other work: a busy role answers `busy` and the caller tries
   * again later. `beforeQueue` makes the caller's durable claim; if it
   * declines, nothing is queued. `releaseGuard` is the session's last-moment
   * fence and is the only way the prompt can reach the model.
   */
  async tryReminder(
    text: string, origin: Extract<PromptOrigin, { kind: 'self-reminder' }>,
    beforeQueue: () => boolean, releaseGuard: () => boolean,
  ): Promise<ReminderAttempt> {
    await new Promise<void>(resolve => setImmediate(resolve));
    return this.exclusive(async (): Promise<ReminderAttempt> => {
      const snapshot = this.session.snapshot();
      if (this.stopping || this.retiring || !snapshot.alive || snapshot.readiness === 'failed')
        return { state: 'unavailable', error: this.stopping ? 'role is stopping' : 'session is unavailable', admitted: false };
      if (snapshot.readiness !== 'idle' || this.unsettled > 0) return { state: 'busy' };
      if (!beforeQueue()) return { state: 'unavailable', error: 'claim declined', admitted: false };
      try {
        const queued = await this.session.queuePrompt(text, {
          interrupt: false, steer: false, origin, releaseGuard,
        });
        return { state: 'admitted', queued: this.track(queued) };
      } catch (error) {
        return { state: 'unavailable', error: (error as Error)?.message ?? String(error), admitted: false };
      }
    }).catch(error => {
      if (error instanceof AdmissionRetiredError)
        return { state: 'unavailable', error: error.message, admitted: false } as ReminderAttempt;
      throw error;
    });
  }

  /**
   * Admit an URGENT self-reminder wake. Idle: exactly `tryReminder`. Busy: the
   * reminder may ask the exact checked turn to stop — once per event — and is
   * then admitted at the next boundary like any other reminder.
   *
   * The check and the cancel request happen in one synchronous step inside the
   * admission boundary, so the turn asked to stop is the turn that was checked.
   * Only a running, correlatable, interruptible turn with nothing queued behind
   * it and no admission waiting is ever asked to stop; anything else is a
   * reported deferral (`busy`). After the cancellation the boundary is given up
   * before the wake is queued, so an owner prompt (or any producer) that
   * arrived meanwhile is admitted first and the wake simply finds the role
   * busy. A forced, failed or uncertain cancellation never queues the wake.
   */
  async tryUrgentReminder(
    origin: Extract<PromptOrigin, { kind: 'self-reminder' }>, hooks: UrgentReminderHooks,
  ): Promise<ReminderAttempt> {
    await new Promise<void>(resolve => setImmediate(resolve));
    const unavailable = (error: string) => ({ state: 'unavailable', error, admitted: false }) as ReminderAttempt;
    const first = await this.exclusive(async (): Promise<ReminderAttempt | UrgentInterruptReport> => {
      const snapshot = this.session.snapshot();
      if (this.stopping || this.retiring || !snapshot.alive || snapshot.readiness === 'failed')
        return unavailable(this.stopping ? 'role is stopping' : 'session is unavailable');
      if (snapshot.readiness === 'idle' && this.unsettled === 0) return this.queueReminder(hooks, origin);
      const deferral = this.urgentTarget(snapshot);
      if (typeof deferral === 'string' || !hooks.mayInterrupt()) {
        hooks.deferred(typeof deferral === 'string' ? deferral : 'interrupt_already_used');
        return { state: 'busy' };
      }
      if (!hooks.beforeQueue()) return unavailable('claim declined');
      if (!hooks.markRequested(deferral)) return unavailable('interrupt request not recorded');
      const terminal = this.live.get(deferral.promptId);
      // No await between the check above and this call: the session cancels
      // the turn that was checked, never a successor.
      let report: UrgentInterruptReport;
      try {
        const outcome = interruptOutcome(await this.session.interrupt('self-reminder'));
        report = outcome.state === 'forced'
          ? { target: deferral, outcome: 'forced', ...(outcome.reasonCode ? { reason: outcome.reasonCode } : {}) }
          : { target: deferral, outcome: await correlate(terminal) };
      } catch (error) {
        report = { target: deferral, outcome: 'failed', reason: controlReason(error) };
      }
      hooks.recordOutcome(report);
      return report;
    }).catch(error => {
      if (error instanceof AdmissionRetiredError) return unavailable(error.message);
      throw error;
    });
    if ('state' in first) return first;
    if (first.outcome === 'forced' || first.outcome === 'failed')
      return unavailable(`interruption ${first.outcome}; the wake was not queued`);
    // Give up the boundary: anything that queued during the cancellation —
    // owner input first among them — is admitted before the wake.
    await new Promise<void>(resolve => setImmediate(resolve));
    return this.exclusive(async (): Promise<ReminderAttempt> => {
      const snapshot = this.session.snapshot();
      if (this.stopping || this.retiring || !snapshot.alive || snapshot.readiness === 'failed')
        return unavailable(this.stopping ? 'role is stopping' : 'session is unavailable');
      if (!hooks.stillAdmitting()) return unavailable('reminder changed during the interruption');
      if (snapshot.readiness !== 'idle' || this.unsettled > 0 || this.waiting > 0) return { state: 'busy' };
      return this.queueReminder(hooks, origin, first, false);
    }).catch(error => {
      if (error instanceof AdmissionRetiredError) return unavailable(error.message);
      throw error;
    });
  }

  /** The exact interruptible turn, or why there is none. Synchronous by design. */
  private urgentTarget(snapshot: SessionSnapshot): UrgentInterruptTarget | UrgentDeferral {
    if (snapshot.readiness === 'starting') return 'session_starting';
    if (snapshot.readiness === 'awaiting_permission' || snapshot.pendingPermissionId) return 'permission_pending';
    if (snapshot.readiness !== 'running') return 'untracked_turn';
    const source = snapshot.activePromptSource;
    if (!source) return 'untracked_turn';
    if (!URGENT_INTERRUPTIBLE.has(source)) return 'protected_turn';
    if (!this.session.capabilities?.interrupt) return 'interrupt_unsupported';
    if (this.waiting > 0 || this.unsettled > 1) return 'queued_work';
    if (!this.session.observeConversation) return 'uncorrelatable';
    let state;
    try {
      const observation = this.session.observeConversation(() => {});
      state = observation.snapshot;
      observation.unsubscribe();
    } catch { return 'uncorrelatable'; }
    if (state.pendingPermissions.length || state.pendingPermissionIds.length) return 'permission_pending';
    if (state.pendingPromptCount > 0 || state.queueDepth > 1) return 'queued_work';
    if (state.activePromptIds.length < 1) return 'untracked_turn';
    return {
      source, generation: state.sessionGeneration, promptId: state.activePromptIds[0]!,
      ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    };
  }

  private async queueReminder(
    hooks: UrgentReminderHooks, origin: Extract<PromptOrigin, { kind: 'self-reminder' }>,
    report?: UrgentInterruptReport, claim = true,
  ): Promise<ReminderAttempt> {
    if (claim && !hooks.beforeQueue()) return { state: 'unavailable', error: 'claim declined', admitted: false };
    try {
      const queued = await this.session.queuePrompt(hooks.text(report), {
        interrupt: false, steer: false, origin, releaseGuard: () => hooks.releaseGuard(),
      });
      return { state: 'admitted', queued: this.track(queued) };
    } catch (error) {
      return { state: 'unavailable', error: (error as Error)?.message ?? String(error), admitted: false };
    }
  }

  /** Retire only at the same admission boundary used by all prompt producers. */
  retireIfIdle(expired: (snapshot: SessionSnapshot, queueDepth: number) => boolean): Promise<boolean> {
    return this.exclusive(async()=>{
      const snapshot=this.session.snapshot();
      const queue=this.session.conversationSnapshot?.().queueDepth ?? -1;
      if(this.retiring || this.unsettled>0 || snapshot.readiness!=='idle' || !expired(snapshot,queue)) return false;
      this.retiring=true;this.stopping=true;
      await this.session.close();
      return true;
    });
  }
  sharedTurnId(promptId: string): string | undefined { return this.session.sharedTurnId?.(promptId); }
  stopScheduledAdmission(): void { this.stopping = true; }
  isAlive(): boolean { return this.session.isAlive(); }
  snapshot(): SessionSnapshot { return this.session.snapshot(); }
  conversationPage(request: { after?: string; limit?: number } = {}): ConversationHandlePage {
    if (!this.session.conversationPage)
      throw new Error('conversation ledger is unavailable');
    return this.session.conversationPage(request);
  }
  conversationSnapshot(): ConversationSnapshot {
    if (!this.session.conversationSnapshot)
      throw new Error('conversation snapshot is unavailable');
    return this.session.conversationSnapshot();
  }
  subscribeConversationFailure(listener: (generation: string) => void) {
    if (!this.session.subscribeConversationFailure) throw new Error('conversation durability observation is unavailable');
    return this.session.subscribeConversationFailure(listener);
  }
  conversationReplayAvailable(expectedGeneration: string): boolean {
    return this.session.conversationReplayAvailable?.(expectedGeneration) ?? false;
  }
  replayConversation(request: import('./conversation-replay.js').ConversationReplayRequest) {
    if (!this.session.replayConversation) throw new Error('conversation replay is unavailable');
    return this.session.replayConversation(request);
  }
  observeConversation(listener: (state: import('./conversation-types.js').ConversationObservationState) => void): import('./conversation-types.js').ConversationObservation {
    if (!this.session.observeConversation) throw new Error('conversation observation is unavailable');
    return this.session.observeConversation(listener);
  }
  subscribeConversation(listener: (event: ConversationEventV1) => void): () => void {
    if (!this.session.subscribeConversation)
      throw new Error('conversation subscription is unavailable');
    return this.session.subscribeConversation(listener);
  }
  submitPromptBrowser(command: SubmitPromptCommand): Promise<PromptReceipt> {
    if (!this.session.submitPromptBrowser)
      return Promise.reject(new Error('browser prompt admission is unavailable'));
    return this.exclusive(() => {if(this.retiring) throw new Error('Chat is closing');return this.session.submitPromptBrowser!(command);});
  }
  get liveVoiceSupported(): boolean { return this.session.liveVoiceSupported === true; }
  interruptPrompt(generation: string, promptId: string): Promise<InterruptOutcome> {
    return this.exclusive(async () => {
      if (!this.session.interruptPrompt) throw new Error('targeted voice interrupt is unavailable');
      return interruptOutcome(await this.session.interruptPrompt(generation, promptId));
    });
  }
  interrupt(source: TurnCancellationSource = 'local-console'): Promise<InterruptOutcome> {
    return this.exclusive(async () => interruptOutcome(await this.session.interrupt(source)));
  }
  respondPermission(permissionId: string, optionId: string): boolean {
    return this.session.respondPermission(permissionId, optionId);
  }

  respondPermissionV2(
    permissionId: string, optionId: string, sessionGeneration: string,
  ): 'accepted' | 'stale' {
    return this.session.respondPermissionV2?.(permissionId, optionId, sessionGeneration)
      ?? 'stale';
  }
  eventsSince(seq: number): SessionEvent[] { return this.session.eventsSince(seq); }
  subscribe(listener: (event: SessionEvent) => void): () => void { return this.session.subscribe(listener); }
  setControllerAttached(attached: boolean): void { this.session.setControllerAttached(attached); }
  exitResult(): ExitRecord | null { return this.session.exitResult(); }
  close(): Promise<void> { return this.session.close(); }
}

/**
 * Whether the target's own terminal result proves this request cancelled it.
 * A settled interrupt says only that the turn (or nothing) ended; without the
 * target's correlated result the honest answer is `ended`.
 */
async function correlate(terminal: Promise<TurnResult> | undefined): Promise<'cancelled' | 'ended'> {
  if (!terminal) return 'ended';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    terminal,
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), URGENT_CORRELATION_MS); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
  return result?.outcome === 'cancelled' && result.cancellationSource === 'self-reminder' ? 'cancelled' : 'ended';
}

function controlReason(error: unknown): string {
  if (error instanceof SessionControlError) return error.reasonCode ?? error.kind;
  return 'control_error';
}
