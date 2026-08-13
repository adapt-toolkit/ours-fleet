import { randomUUID } from 'node:crypto';

import type { ResolvedRoleLoop } from './config.js';
import {
  ScheduledLoopStateStore, deterministicJitter, increment, type LoopRuntimeState,
  type ScheduledLoopsFile, type StateWriter,
} from './state.js';
import { RoleTurnArbiter } from '../session/arbiter.js';
import type { TurnResult } from '../session/types.js';

export interface LoopManagerDeps {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  log(line: string): void;
  /** Persistence seam; defaults to the atomic replace. Tests inject write faults here. */
  writeState?: StateWriter;
  /** Test seam for the post-cancellation abandon bound; production uses the default. */
  cancelAbandonMs?: number;
}

/** The manager never sleeps longer than this, so one poll per minute is the floor rate. */
const POLL_CEILING_MS = 60_000;

/**
 * Recovery delay for the nth consecutive failure: 1s doubling to the poll
 * ceiling. Bounded at both ends — never a busy retry, never longer than the
 * normal cadence, so recovery is noticed within a minute of the fault clearing.
 */
export function backoffMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1) - 1, 6);
  return Math.min(POLL_CEILING_MS, 1_000 * 2 ** exponent);
}

/**
 * How long a cancelled run may stay `active` before the loop stops believing it
 * will ever settle. Deliberately longer than the session layer's own escalation
 * (cancel grace + SIGTERM->SIGKILL grace), so this fires only when that recovery
 * did not, and never races a run that is about to report honestly.
 */
const LOOP_CANCEL_ABANDON_MS = 60_000;

export interface LoopActionResult {
  state: 'started' | 'skipped_busy' | 'disabled' | 'unavailable';
  runId?: string;
}

export interface ScheduledLoopManagerHandle {
  start(): void;
  stop(): Promise<void>;
  status(): ScheduledLoopsFile;
  runNow(name: string): Promise<LoopActionResult>;
  disable(name: string): LoopActionResult;
  enable(name: string): LoopActionResult;
  reconcile(definitions: ResolvedRoleLoop[]): void;
}

export class ScheduledLoopManager implements ScheduledLoopManagerHandle {
  private readonly definitions = new Map<string, ResolvedRoleLoop>();
  private readonly store: ScheduledLoopStateStore;
  private timer?: unknown;
  private readonly runTimeouts = new Set<unknown>();
  private stopping = false;
  /** Consecutive unforeseen poll failures; drives the recovery backoff. */
  private pollFailures = 0;

  constructor(
    private readonly role: string, definitions: ResolvedRoleLoop[], stateDir: string,
    private readonly arbiter: RoleTurnArbiter, private readonly deps: LoopManagerDeps,
  ) {
    for (const definition of definitions) this.definitions.set(definition.name, definition);
    this.store = new ScheduledLoopStateStore(
      stateDir, role, definitions, deps.now(), deps.log, deps.writeState);
  }

  start(): void {
    if (!this.store.fresh) this.skipRestartMisses();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.arbiter.stopScheduledAdmission();
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    for (const timeout of this.runTimeouts) this.deps.clearTimer(timeout);
    this.runTimeouts.clear();
    this.store.state.clock.lastWallMs = this.deps.now();
    this.store.persist();
  }

  status(): ScheduledLoopsFile { return structuredClone(this.store.state); }

  async runNow(name: string): Promise<LoopActionResult> {
    const definition = this.definitions.get(name);
    const state = this.store.state.loops[name];
    if (!definition || !state || this.stopping) return { state: 'unavailable' };
    if (!definition.enabled || state.operatorDisabled) return { state: 'disabled' };
    return this.attempt(definition, state, this.deps.now());
  }

  disable(name: string): LoopActionResult {
    const state = this.store.state.loops[name];
    if (!state) return { state: 'unavailable' };
    state.operatorDisabled = true;
    state.lastOutcome = 'operator_disabled';
    this.store.persist();
    this.schedule();
    return { state: 'disabled' };
  }

  enable(name: string): LoopActionResult {
    const definition = this.definitions.get(name);
    const state = this.store.state.loops[name];
    if (!definition || !state) return { state: 'unavailable' };
    if (!definition.enabled) return { state: 'disabled' };
    state.operatorDisabled = false;
    state.lastOutcome = 'operator_enabled';
    this.store.persist();
    this.schedule();
    return { state: 'started' };
  }

  reconcile(definitions: ResolvedRoleLoop[]): void {
    if (this.stopping) return;
    this.definitions.clear();
    for (const definition of definitions) this.definitions.set(definition.name, definition);
    this.store.reconcile(definitions, this.deps.now());
    this.schedule();
  }

  /** Public fake-clock seam; timer callbacks call the same transition. */
  async poll(): Promise<void> {
    if (this.stopping) return;
    const now = this.deps.now();
    if (now < this.store.state.clock.lastWallMs - 5 * 60_000) {
      this.store.state.health = 'degraded';
      this.store.state.anomaly = 'clock_regression';
      this.store.state.clock.lastWallMs = now;
      this.store.persist();
      this.deps.log(`[${this.role}] scheduled loops paused after backward clock jump`);
      this.schedule();
      return;
    }
    const due = [...this.definitions.values()].filter(definition => {
      const state = this.store.state.loops[definition.name];
      return definition.enabled && !state.operatorDisabled && Date.parse(state.nextDueAt) <= now;
    }).sort((a, b) => a.name.localeCompare(b.name));
    for (const definition of due) {
      const state = this.store.state.loops[definition.name];
      if (now >= Date.parse(state.nextDueAt) + definition.intervalMs) {
        this.skipMissed(definition, state, now);
        continue;
      }
      const scheduledAt = Date.parse(state.nextScheduledAt);
      this.advance(definition, state);
      // The claim has to be durable before the turn is submitted: a run that is
      // not on disk is a run a restart cannot see, and the occurrence would be
      // submitted a second time. At-most-once outranks running this occurrence.
      if (!this.store.persist()) { this.skipUnpersisted(definition, state, now); continue; }
      await this.attempt(definition, state, scheduledAt);
    }
    this.store.state.clock.lastWallMs = now;
    if (this.pollFailures) {
      this.store.clearAnomaly('manager_task_failed');
      this.deps.log(`[${this.role}] scheduled loop manager recovered after ${this.pollFailures} failed poll(s)`);
      this.pollFailures = 0;
    }
    this.store.persist();
    this.schedule();
  }

  private async attempt(
    definition: ResolvedRoleLoop, state: LoopRuntimeState, scheduledAt: number,
  ): Promise<LoopActionResult> {
    const runId = `sl_${randomUUID()}`;
    const origin = { kind: 'scheduled-loop' as const, loop: definition.name, runId };
    const prompt = this.envelope(definition, runId, scheduledAt);
    let claimed = false;
    const result = await this.arbiter.tryScheduled(prompt, origin, () => {
      claimed = true;
      state.activeRunId = runId;
      state.lastRunId = runId;
      state.lastStartedAt = new Date(this.deps.now()).toISOString();
      state.lastOutcome = 'running';
      state.lastError = null;
      state.counts.started = increment(state.counts.started);
      this.store.persist();
    });
    if (result.state === 'skipped_busy') {
      state.counts.skipped = increment(state.counts.skipped);
      state.counts.skippedBusy = increment(state.counts.skippedBusy);
      state.lastOutcome = 'skipped_busy';
      state.lastFinishedAt = new Date(this.deps.now()).toISOString();
      this.store.persist();
      this.deps.log(`[${this.role}] loop ${definition.name} skipped_busy at ${new Date(scheduledAt).toISOString()}`);
      return { state: 'skipped_busy' };
    }
    if (result.state === 'unavailable') {
      state.activeRunId = null;
      state.counts.failed = increment(state.counts.failed);
      state.lastOutcome = claimed ? 'queue_failed' : 'unavailable';
      state.lastFinishedAt = new Date(this.deps.now()).toISOString();
      state.lastError = { kind: claimed ? 'queue_failed' : 'unavailable', at: state.lastFinishedAt };
      this.store.persist();
      this.deps.log(`[${this.role}] loop ${definition.name} ${state.lastOutcome} run=${runId.slice(0, 11)}`);
      return { state: 'unavailable', runId };
    }
    this.deps.log(`[${this.role}] loop ${definition.name} started run=${runId.slice(0, 11)} scheduled=${new Date(scheduledAt).toISOString()}`);
    // Maintenance is best-effort and must never monopolize a persistent role.
    // A cancellation which the ACP adapter ignores is escalated by AcpSession
    // into an adapter restart, preserving the session and deferred owner mail.
    const timeoutMs = Math.max(60_000, Math.min(5 * 60_000, Math.floor(definition.intervalMs / 2)));
    const timeout = this.deps.setTimer(() => {
      this.runTimeouts.delete(timeout);
      if (state.activeRunId !== runId || this.stopping) return;
      this.deps.log(`[${this.role}] loop ${definition.name} timed out run=${runId.slice(0, 11)} after ${timeoutMs}ms; cancelling`);
      void this.arbiter.interrupt('scheduled-loop').then(outcome => {
        // Forced recovery IS a successful cancellation; record how it ended
        // rather than reporting the interrupt itself as a failure.
        if (outcome?.state === 'forced')
          this.deps.log(`[${this.role}] loop ${definition.name} cancellation enforced `
            + `run=${runId.slice(0, 11)} reason=${outcome.reasonCode ?? 'forced'}`);
      }).catch(error => {
        this.deps.log(`[${this.role}] loop ${definition.name} timeout cancellation failed: ${(error as Error)?.name ?? 'Error'}`);
      });
      this.armAbandon(definition, state, runId);
    }, timeoutMs);
    this.runTimeouts.add(timeout);
    void result.queued.completion.then(turn => {
      this.deps.clearTimer(timeout);
      this.runTimeouts.delete(timeout);
      this.finish(definition, state, runId, turn);
    });
    return { state: 'started', runId };
  }

  /**
   * Last resort for a run whose cancellation never settles. Without it a single
   * unsettled turn keeps `activeRunId` set for the life of the process, and
   * every later tick reports `skipped_busy` forever — the loop looks scheduled
   * while nothing has run since. Releasing the slot is honest, and it is safe
   * because `finish` still refuses to double-report a run it no longer owns.
   */
  private armAbandon(
    definition: ResolvedRoleLoop, state: LoopRuntimeState, runId: string,
  ): void {
    const abandon = this.deps.setTimer(() => {
      this.runTimeouts.delete(abandon);
      if (state.activeRunId !== runId || this.stopping) return;
      state.activeRunId = null;
      state.lastFinishedAt = new Date(this.deps.now()).toISOString();
      state.counts.failed = increment(state.counts.failed);
      state.lastOutcome = 'abandoned_unsettled';
      state.lastError = { kind: 'abandoned_unsettled', at: state.lastFinishedAt };
      this.store.state.health = 'degraded';
      this.store.state.anomaly = 'abandoned_unsettled';
      this.store.persist();
      this.deps.log(`[${this.role}] loop ${definition.name} abandoned run=${runId.slice(0, 11)}: `
        + 'cancellation never settled');
    }, this.deps.cancelAbandonMs ?? LOOP_CANCEL_ABANDON_MS);
    this.runTimeouts.add(abandon);
  }

  private finish(
    definition: ResolvedRoleLoop, state: LoopRuntimeState, runId: string, result: TurnResult,
  ): void {
    if (state.activeRunId !== runId) return;
    state.activeRunId = null;
    state.lastFinishedAt = new Date(this.deps.now()).toISOString();
    state.lastCancellationSource = result.cancellationSource ?? null;
    if (result.outcome === 'completed') {
      state.counts.completed = increment(state.counts.completed);
      state.lastOutcome = 'completed';
    } else if (result.outcome === 'cancelled') {
      state.counts.cancelled = increment(state.counts.cancelled);
      state.lastOutcome = `cancelled${result.cancellationSource ? `(${result.cancellationSource})` : ''}`;
    } else {
      state.counts.failed = increment(state.counts.failed);
      state.lastOutcome = result.outcome;
      state.lastError = { kind: result.outcome, at: state.lastFinishedAt };
    }
    this.store.persist();
    const duration = Date.parse(state.lastFinishedAt) - Date.parse(state.lastStartedAt!);
    this.deps.log(`[${this.role}] loop ${definition.name} finished run=${runId.slice(0, 11)} outcome=${state.lastOutcome} duration=${duration}ms`);
  }

  private advance(definition: ResolvedRoleLoop, state: LoopRuntimeState): void {
    const current = Date.parse(state.nextScheduledAt);
    state.lastScheduledAt = new Date(current).toISOString();
    const next = current + definition.intervalMs;
    state.nextScheduledAt = new Date(next).toISOString();
    state.nextDueAt = new Date(next + deterministicJitter(
      this.role, definition.name, next, definition.jitterMs)).toISOString();
  }

  private skipMissed(definition: ResolvedRoleLoop, state: LoopRuntimeState, now: number): void {
    let missed = 0;
    while (Date.parse(state.nextDueAt) <= now) {
      this.advance(definition, state);
      missed++;
    }
    state.counts.skipped = increment(state.counts.skipped, missed);
    state.counts.skippedMissed = increment(state.counts.skippedMissed, missed);
    state.lastOutcome = 'skipped_missed';
    state.lastFinishedAt = new Date(now).toISOString();
    this.store.persist();
    this.deps.log(`[${this.role}] loop ${definition.name} skipped_missed count=${missed}`);
  }

  private skipRestartMisses(): void {
    const now = this.deps.now();
    for (const definition of this.definitions.values()) {
      const state = this.store.state.loops[definition.name];
      if (definition.enabled && !state.operatorDisabled && Date.parse(state.nextDueAt) <= now)
        this.skipMissed(definition, state, now);
    }
  }

  /**
   * A run the store could not record is dropped, not retried: the cursor has
   * already moved, so this can never become a busy loop, and the outage is
   * visible as a skip with a failed health rather than as silence.
   */
  private skipUnpersisted(definition: ResolvedRoleLoop, state: LoopRuntimeState, now: number): void {
    state.counts.skipped = increment(state.counts.skipped);
    state.lastOutcome = 'skipped_unpersisted';
    state.lastFinishedAt = new Date(now).toISOString();
    state.lastError = { kind: 'persist_failed', at: state.lastFinishedAt };
    this.deps.log(`[${this.role}] loop ${definition.name} skipped_unpersisted `
      + `(${this.store.lastPersistError ?? 'state write failed'})`);
  }

  private schedule(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    if (this.stopping) return;
    const due = [...this.definitions.values()].filter(definition => {
      const state = this.store.state.loops[definition.name];
      return definition.enabled && !state.operatorDisabled;
    }).map(definition => Date.parse(this.store.state.loops[definition.name].nextDueAt));
    // While writes are failing the manager keeps a bounded probe armed even with
    // nothing due, so health stops lying the moment the disk comes back.
    const probe = this.store.persistFailures ? backoffMs(this.store.persistFailures) : undefined;
    if (!due.length && probe === undefined) return;
    const delay = due.length ? Math.max(0, Math.min(...due) - this.deps.now()) : POLL_CEILING_MS;
    this.arm(Math.min(delay, POLL_CEILING_MS, probe ?? POLL_CEILING_MS));
  }

  private arm(delayMs: number): void {
    this.timer = this.deps.setTimer(
      () => { void this.poll().catch(error => this.recover(error)); }, delayMs);
  }

  /**
   * The residual safety net. Persistence failures are absorbed by the store, so
   * reaching here means something unforeseen threw — and whatever it was, the
   * manager must stay armed. The previous behaviour left no timer at all, which
   * turned one transient ENOSPC into every loop on the role being silently gone
   * until the process was restarted.
   */
  private recover(error: unknown): void {
    this.pollFailures = increment(this.pollFailures);
    this.store.state.health = 'failed';
    this.store.state.anomaly = 'manager_task_failed';
    this.store.persist();
    this.deps.log(`[${this.role}] scheduled loop manager failed: ${(error as Error)?.name ?? 'Error'}`
      + ` (attempt ${this.pollFailures}, retrying in ${backoffMs(this.pollFailures)}ms)`);
    if (this.stopping) return;
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.arm(backoffMs(this.pollFailures));
  }

  private envelope(definition: ResolvedRoleLoop, runId: string, scheduledAt: number): string {
    return [
      '[fleet-loop]',
      `loop: ${definition.name}`,
      `run: ${runId}`,
      `scheduled_at: ${new Date(scheduledAt).toISOString()}`,
      'origin: local-trusted-config',
      '',
      'This is a scheduled internal maintenance turn, not an owner message and not ordinary ours mail.',
      'Perform one bounded pass. Do not wait for the next tick. Do not report to an owner unless your',
      'configured policy and an existing authenticated proactive-report route authorize a material report.',
      '',
      definition.prompt,
    ].join('\n');
  }
}
