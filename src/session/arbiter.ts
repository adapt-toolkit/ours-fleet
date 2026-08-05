import type {
  ConversationHandlePage, ExitRecord, PromptOrigin, QueuedPrompt, SessionEvent, SessionHandle, SessionSnapshot,
  SubmitPromptOptions, TurnCancellationSource, TurnResult,
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

  constructor(private readonly session: SessionHandle) {
    this.backend = session.backend;
    this.pid = session.pid;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private track(queued: QueuedPrompt): QueuedPrompt {
    this.unsettled++;
    const completion = queued.completion.finally(() => { this.unsettled = Math.max(0, this.unsettled - 1); });
    return { ...queued, completion };
  }

  queuePrompt(text: string, options: SubmitPromptOptions = {}): Promise<QueuedPrompt> {
    return this.exclusive(async () => this.track(await this.session.queuePrompt(text, options)));
  }

  async submitPrompt(text: string, options: SubmitPromptOptions = {}): Promise<TurnResult> {
    return (await this.queuePrompt(text, options)).completion;
  }

  async tryScheduled(
    text: string, origin: Extract<PromptOrigin, { kind: 'scheduled-loop' }>,
    beforeQueue?: () => void | Promise<void>,
  ): Promise<ScheduledAttempt> {
    // Give owner/console/I/O callbacks already ready in this event-loop turn a
    // chance to claim the arbiter first. Scheduled work is best-effort; humans
    // and authenticated ingress have priority at the idle boundary.
    await new Promise<void>(resolve => setImmediate(resolve));
    return this.exclusive(async () => {
      const snapshot = this.session.snapshot();
      if (this.stopping || !snapshot.alive || snapshot.readiness === 'failed')
        return { state: 'unavailable', error: this.stopping ? 'role is stopping' : 'session is unavailable' };
      if (snapshot.readiness !== 'idle' || this.unsettled > 0) return { state: 'skipped_busy' };
      try {
        await beforeQueue?.();
        const queued = await this.session.queuePrompt(text, { interrupt: false, origin });
        if (queued.queuedBehind > 0) return { state: 'unavailable', error: 'scheduled admission race' };
        return { state: 'started', queued: this.track(queued) };
      } catch (error) {
        return { state: 'unavailable', error: (error as Error)?.message ?? String(error) };
      }
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
  interrupt(source: TurnCancellationSource = 'local-console'): Promise<void> {
    return this.exclusive(() => this.session.interrupt(source));
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
