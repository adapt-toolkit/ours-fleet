import { randomUUID } from 'node:crypto';

import type { ResolvedRoleLoop } from './config.js';
import {
  ScheduledLoopStateStore, deterministicJitter, increment, type LoopRuntimeState,
  type ScheduledLoopsFile,
} from './state.js';
import { RoleTurnArbiter } from '../session/arbiter.js';
import type { TurnResult } from '../session/types.js';

export interface LoopManagerDeps {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  log(line: string): void;
}

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
  private stopping = false;

  constructor(
    private readonly role: string, definitions: ResolvedRoleLoop[], stateDir: string,
    private readonly arbiter: RoleTurnArbiter, private readonly deps: LoopManagerDeps,
  ) {
    for (const definition of definitions) this.definitions.set(definition.name, definition);
    this.store = new ScheduledLoopStateStore(stateDir, role, definitions, deps.now(), deps.log);
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
      this.store.persist();
      await this.attempt(definition, state, scheduledAt);
    }
    this.store.state.clock.lastWallMs = now;
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
    void result.queued.completion.then(turn => this.finish(definition, state, runId, turn));
    return { state: 'started', runId };
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

  private schedule(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    if (this.stopping) return;
    const due = [...this.definitions.values()].filter(definition => {
      const state = this.store.state.loops[definition.name];
      return definition.enabled && !state.operatorDisabled;
    }).map(definition => Date.parse(this.store.state.loops[definition.name].nextDueAt));
    if (!due.length) return;
    const delay = Math.max(0, Math.min(...due) - this.deps.now());
    this.timer = this.deps.setTimer(() => { void this.poll().catch(error => {
      this.store.state.health = 'failed';
      this.store.state.anomaly = 'manager_task_failed';
      try { this.store.persist(); } catch {}
      this.deps.log(`[${this.role}] scheduled loop manager failed: ${(error as Error)?.name ?? 'Error'}`);
    }); }, Math.min(delay, 60_000));
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
