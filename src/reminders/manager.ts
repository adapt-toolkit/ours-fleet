import type { ReminderAttempt } from '../session/arbiter.js';
import type { PromptOrigin } from '../session/types.js';
import type { ReminderEvent, ReminderRecord, ReminderStore } from './store.js';

/** The admission seam: the role's RoleTurnArbiter in production. */
export interface ReminderAdmitter {
  tryReminder(
    text: string, origin: Extract<PromptOrigin, { kind: 'self-reminder' }>,
    beforeQueue: () => boolean, releaseGuard: () => boolean,
  ): Promise<ReminderAttempt>;
}

export interface ReminderManagerDeps {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  log(line: string): void;
}

/**
 * The dispatcher never sleeps longer than this while reminders are open, so a
 * wall-clock jump (host suspend, NTP step) is noticed within a minute. With
 * nothing open it arms no timer at all: an idle agent costs nothing.
 */
export const REMINDER_POLL_CEILING_MS = 60_000;
/** Busy role: re-check at the next idle boundary within these bounds. */
const BUSY_RETRY_MIN_MS = 2_000;
const BUSY_RETRY_MAX_MS = 30_000;
/** Admission refused before reaching the model: bounded backoff, inside the late window. */
const UNAVAILABLE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

export interface ReminderManagerHandle {
  start(): void;
  stop(): void;
  /** Called after an agent tool changed the schedule so the timer reflects it. */
  changed(): void;
}

/**
 * Turns due self-reminders into wakes for the agent that owns them.
 *
 * Runs inside that agent's runner, beside the role's turn arbiter. It starts
 * only after the role's startup turn has succeeded and stops before the runner
 * releases its runtime binding. Admission is idle-only: a wake never
 * interrupts or queues behind work, and the session's release guard makes the
 * durable `dispatched` claim at the moment the prompt reaches the model.
 */
export class ReminderManager implements ReminderManagerHandle {
  private timer?: unknown;
  private started = false;
  private stopping = false;
  private polling = false;
  private busyStreak = 0;
  /** Consecutive re-arms with work already overdue; drives the spin backoff. */
  private overdueStreak = 0;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly role: string,
    private readonly store: ReminderStore,
    private readonly admitter: ReminderAdmitter,
    private readonly deps: ReminderManagerDeps,
  ) {}

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.schedule(0);
  }

  /** Synchronous: after this returns no timer is armed and every release guard refuses. */
  stop(): void {
    this.stopping = true;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }

  get isStopping(): boolean { return this.stopping; }

  changed(): void {
    if (this.started && !this.stopping && !this.polling) this.schedule();
  }

  /** Public fake-clock seam; the timer calls the same transition. */
  async poll(): Promise<void> {
    if (!this.started || this.stopping || this.polling) return;
    this.polling = true;
    let delay: number | undefined;
    try {
      const ready = this.store.sweep(this.inFlight);
      for (const event of ready) {
        if (this.stopping) return;
        const outcome = await this.admit(event);
        if (outcome === 'busy') {
          this.busyStreak++;
          delay = Math.min(BUSY_RETRY_MAX_MS, BUSY_RETRY_MIN_MS * 2 ** Math.min(this.busyStreak - 1, 4));
          break;
        }
        this.busyStreak = 0;
        // One wake per turn boundary: the next due reminder waits for the
        // following poll, by which time this one's turn has claimed the role.
        if (outcome === 'admitted') { delay = 0; break; }
      }
    } catch (error) {
      this.deps.log(`[${this.role}] self-reminder dispatch failed: ${(error as Error)?.name ?? 'Error'}; retrying`);
      delay = UNAVAILABLE_RETRY_MS[0];
    } finally {
      this.polling = false;
    }
    this.schedule(delay);
  }

  private async admit(event: ReminderEvent): Promise<'admitted' | 'busy' | 'skipped'> {
    const summary = this.store.eventSummary(event.id);
    if (!summary) return 'skipped';
    const { reminder } = summary;
    const origin = {
      kind: 'self-reminder' as const, eventId: event.id, reminderId: reminder.id, revision: event.revision,
    };
    const text = wakePrompt(event, reminder, this.deps.now(), event.attempts > 0);
    this.inFlight.add(event.id);
    let attempt: ReminderAttempt;
    try {
      attempt = await this.admitter.tryReminder(
        text, origin,
        () => !this.stopping && this.store.markAdmitting(event.id),
        () => this.guard(event.id),
      );
    } catch (error) {
      this.inFlight.delete(event.id);
      this.store.releaseUndispatched(event.id, this.retryAt(event));
      throw error;
    }
    if (attempt.state === 'busy') { this.inFlight.delete(event.id); return 'busy'; }
    if (attempt.state === 'unavailable') {
      this.inFlight.delete(event.id);
      this.store.releaseUndispatched(event.id, this.retryAt(event));
      this.deps.log(`[${this.role}] self-reminder ${event.id.slice(0, 12)} not admitted; will retry within its window`);
      return 'skipped';
    }
    // Own the completion before anything else can throw: the queued prompt
    // ends this admission whatever happens to the receipt write below.
    const settled = () => {
      this.inFlight.delete(event.id);
      // Settled without the guard dispatching it (offline session, refused at
      // release while stopping): still undispatched, so it may be retried.
      // A failed write leaves it admitting with no owner; sweep recovers that.
      try { this.store.releaseUndispatched(event.id, this.retryAt(event)); } catch { /* recovered by sweep */ }
      this.changed();
    };
    void attempt.queued.completion.then(settled, settled);
    // The receipt is diagnostic only; dispatch state is the release guard's.
    try { this.store.recordReceipt(event.id, attempt.queued.promptId); }
    catch { this.deps.log(`[${this.role}] self-reminder ${event.id.slice(0, 12)} receipt not recorded`); }
    this.deps.log(`[${this.role}] self-reminder ${event.id.slice(0, 12)} admitted`);
    return 'admitted';
  }

  private guard(eventId: string): boolean {
    const result = this.store.claimDispatch(eventId, this.stopping);
    if (!result.dispatch)
      this.deps.log(`[${this.role}] self-reminder ${eventId.slice(0, 12)} not dispatched at release (${result.reason})`);
    return result.dispatch;
  }

  private retryAt(event: ReminderEvent): number {
    const step = UNAVAILABLE_RETRY_MS[Math.min(event.attempts, UNAVAILABLE_RETRY_MS.length - 1)]!;
    return this.deps.now() + step;
  }

  private schedule(delayMs?: number): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    if (this.stopping) return;
    let delay = delayMs;
    if (delay === undefined) {
      const next = this.store.nextWorkAt(this.inFlight);
      if (next === undefined) { this.overdueStreak = 0; return; }
      delay = Math.max(0, next - this.deps.now());
      // Work that is already overdue after a full poll means the poll could
      // not move it (storage refusing writes, say). Back off instead of
      // re-arming at once; any real progress resets the streak.
      if (delay === 0) {
        delay = this.overdueStreak ? Math.min(REMINDER_POLL_CEILING_MS, 1_000 * 2 ** Math.min(this.overdueStreak - 1, 6)) : 0;
        this.overdueStreak++;
      } else this.overdueStreak = 0;
    }
    delay = Math.min(delay, REMINDER_POLL_CEILING_MS);
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.poll();
    }, delay);
  }
}

/**
 * The wake text. It carries the agent's own title so the wake is legible, but
 * the note is only returned by `fleet_reminder_inspect`, which also re-checks
 * eligibility at the moment the agent acts.
 */
export function wakePrompt(
  event: ReminderEvent, reminder: ReminderRecord, now: number, retry: boolean,
): string {
  const lateBy = Math.max(0, now - Date.parse(reminder.dueAt));
  return [
    '[fleet-reminder]',
    `event_id: ${event.id}`,
    `reminder_id: ${reminder.id}`,
    `revision: ${event.revision}`,
    `title: ${JSON.stringify(reminder.title)}`,
    `due: ${reminder.localTime} ${reminder.timeZone} (${reminder.dueAt})`,
    ...(lateBy >= 60_000 ? [`late_by_minutes: ${Math.floor(lateBy / 60_000)}`] : []),
    ...(retry ? ['note: an earlier admission of this wake never reached you; this is the same event'] : []),
    '',
    'This is a reminder you scheduled for yourself through Fleet. It is not an owner message,',
    'not ours mail, and grants no new authority.',
    'Call fleet_reminder_inspect with this event_id to read the note and confirm it is still eligible,',
    'then decide what to do within your existing instructions and authority; doing nothing is fine.',
    'When handled, call fleet_reminder_ack with event_id and revision. Ack records only that you',
    'handled this wake; it sends nothing. To postpone instead, call fleet_reminder_update with a new',
    'local_time. Fleet never messages anyone on your behalf.',
  ].join('\n');
}
