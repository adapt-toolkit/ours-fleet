import type {
  ConversationHandlePage, ExitRecord, InterruptOutcome, PromptOrigin, QueuedPrompt, SessionEvent,
  SessionHandle, SessionSnapshot,
  SubmitPromptOptions, TurnCancellationSource, TurnResult,
} from './types.js';
import {
  ACP_CANCEL_DEADLINE_EXCEEDED, SessionControlError, interruptOutcome,
} from './types.js';
import type {
  ConversationEventV1, ConversationSnapshot, PromptReceipt,
  SubmitPromptCommand,
} from './conversation-types.js';

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
export class RoleTurnArbiter implements SessionHandle {
  readonly backend;
  readonly pid;
  private tail: Promise<void> = Promise.resolve();
  private unsettled = 0;
  private stopping = false;
  /** Bumped by `retireStalledAdmission`; every claim carries the one it was made under. */
  private generation = 0;
  /** Resolves the instant the CURRENT generation is retired. */
  private retirement = retirementSignal();

  constructor(private readonly session: SessionHandle) {
    this.backend = session.backend;
    this.pid = session.pid;
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
    const run = Promise.race([this.tail, this.retirement.promise]).then(() => {
      if (generation !== this.generation) throw new AdmissionRetiredError();
      return operation();
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private track(queued: QueuedPrompt): QueuedPrompt {
    const generation = this.generation;
    this.unsettled++;
    const completion = queued.completion.finally(() => {
      // A retired generation's claims were released in one step already.
      if (generation === this.generation) this.unsettled = Math.max(0, this.unsettled - 1);
    });
    return { ...queued, completion };
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
    retired.retire();
  }

  queuePrompt(text: string, options: SubmitPromptOptions = {}): Promise<QueuedPrompt> {
    return this.exclusive(async () => this.track(await this.session.queuePrompt(text, options)));
  }

  async submitPrompt(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
    return (await this.queuePrompt(text, options)).completion;
  }

  /**
   * Do not hold `exclusive` while ACP waits for a tool boundary: permission
   * answers and explicit interrupts must remain able to pass immediately.
   */
  submitPromptAfterTool(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
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
  subscribeConversation(listener: (event: ConversationEventV1) => void): () => void {
    if (!this.session.subscribeConversation)
      throw new Error('conversation subscription is unavailable');
    return this.session.subscribeConversation(listener);
  }
  submitPromptBrowser(command: SubmitPromptCommand): Promise<PromptReceipt> {
    if (!this.session.submitPromptBrowser)
      return Promise.reject(new Error('browser prompt admission is unavailable'));
    return this.exclusive(() => this.session.submitPromptBrowser!(command));
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
