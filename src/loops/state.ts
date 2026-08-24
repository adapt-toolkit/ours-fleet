import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { replaceFileAtomically } from '../atomic-file.js';
import type { ResolvedRoleLoop } from './config.js';

export interface LoopCounts {
  started: number; completed: number; failed: number; cancelled: number;
  skipped: number; skippedBusy: number; skippedMissed: number;
}

/**
 * A coalesced run of occurrences that were never submitted, held until a run
 * actually starts and can be told about it. Without it a dropped occurrence
 * survives only as a counter, which says how many were lost but never when or
 * for how long — and an oversight role cannot report an outage it cannot date.
 */
export interface LoopMissedGap {
  /** Occurrences coalesced away, summed across every skip since the last run. */
  count: number;
  /** Nominal time of the earliest occurrence in the gap. */
  fromAt: string;
  /** Nominal time of the latest occurrence in the gap. */
  throughAt: string;
  /** When the manager noticed — the end of the outage, not of the last skip. */
  detectedAt: string;
}

export interface LoopRuntimeState {
  definitionHash: string;
  promptHash: string;
  enabled: boolean;
  operatorDisabled: boolean;
  /** Unreported gap, cleared by the first run that carries it. */
  missedGap: LoopMissedGap | null;
  nextScheduledAt: string;
  nextDueAt: string;
  lastScheduledAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: string | null;
  lastCancellationSource: string | null;
  lastRunId: string | null;
  activeRunId: string | null;
  counts: LoopCounts;
  lastError: { kind: string; at: string } | null;
}

export interface ScheduledLoopsFile {
  version: 1;
  role: string;
  generation: string;
  clock: { lastWallMs: number };
  health: 'healthy' | 'degraded' | 'failed';
  anomaly: string | null;
  loops: Record<string, LoopRuntimeState>;
}

const zeroCounts = (): LoopCounts => ({
  started: 0, completed: 0, failed: 0, cancelled: 0,
  skipped: 0, skippedBusy: 0, skippedMissed: 0,
});

export const increment = (value: number, amount = 1): number =>
  Math.min(Number.MAX_SAFE_INTEGER, value + Math.max(0, amount));

export function deterministicJitter(
  role: string, loop: string, nominalMs: number, maximumMs: number,
): number {
  if (maximumMs <= 0) return 0;
  const digest = createHash('sha256').update(`${role}\0${loop}\0${nominalMs}`).digest();
  const value = digest.readUIntBE(0, 6);
  return value % (maximumMs + 1);
}

export function scheduledLoopsPath(stateDir: string): string {
  return join(stateDir, '.scheduled-loops.json');
}

/**
 * A live manager rewrites the checkpoint at least once per poll ceiling (60s).
 * Past this bound the recorded `health` describes a manager that is no longer
 * updating it — a dead scheduler, or one whose writes are failing, which is
 * exactly the case where the field still reads `healthy` because the flip to
 * `failed` could not be written. Readers must not repeat a stale field as fact.
 */
export const STORED_STATE_STALE_MS = 5 * 60_000;

export interface StoredLoopVerdict {
  health: ScheduledLoopsFile['health'] | 'stale';
  recorded: ScheduledLoopsFile['health'];
  stale: boolean;
  ageMs: number;
  /** Whether any loop still owes a run — nothing is expected of the file if not. */
  scheduled: boolean;
}

/** Truthful health for a reader that only has the stored file to go on. */
export function storedLoopHealth(file: ScheduledLoopsFile, now: number): StoredLoopVerdict {
  const ageMs = Math.max(0, now - file.clock.lastWallMs);
  // A role with nothing left to schedule stops polling on purpose, so its
  // checkpoint stops advancing on purpose too. Only a role that still owes
  // someone a run can be stale; calling a deliberately idle one stale would
  // teach operators to ignore the word.
  const scheduled = Object.values(file.loops).some(loop => loop.enabled && !loop.operatorDisabled);
  const stale = scheduled && ageMs > STORED_STATE_STALE_MS;
  return { health: stale ? 'stale' : file.health, recorded: file.health, stale, ageMs, scheduled };
}

export function readScheduledLoops(stateDir: string): ScheduledLoopsFile | undefined {
  try {
    const path = scheduledLoopsPath(stateDir);
    if (!safeStateFile(path)) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as ScheduledLoopsFile;
    return validFile(value) ? value : undefined;
  } catch { return undefined; }
}

/** Persistence seam. Production uses the atomic replace; faults are injected here. */
export type StateWriter = (path: string, contents: string, mode: number) => void;

export class ScheduledLoopStateStore {
  readonly path: string;
  readonly fresh: boolean;
  state: ScheduledLoopsFile;
  /** Consecutive failed checkpoints; 0 whenever the stored file is current. */
  persistFailures = 0;
  lastPersistError: string | null = null;
  /** Health displaced by the persist_failed marker, restored when a write lands. */
  private suppressed: { health: ScheduledLoopsFile['health']; anomaly: string | null } | null = null;

  constructor(
    stateDir: string, role: string, definitions: ResolvedRoleLoop[], now: number,
    private readonly log: (line: string) => void,
    private readonly write: StateWriter = replaceFileAtomically,
  ) {
    this.path = scheduledLoopsPath(stateDir);
    let restored: ScheduledLoopsFile | undefined;
    let corrupt = false;
    if (existsSync(this.path)) {
      try {
        if (!safeStateFile(this.path)) throw new Error('insecure scheduled-loop state');
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as ScheduledLoopsFile;
        if (!validFile(parsed) || parsed.role !== role) throw new Error('invalid scheduled-loop state');
        restored = parsed;
        chmodSync(this.path, 0o600);
      } catch {
        corrupt = true;
        try { renameSync(this.path, `${this.path}.corrupt-${now}`); } catch {}
      }
    }
    this.fresh = !restored;
    this.state = restored ?? {
      version: 1, role, generation: '', clock: { lastWallMs: now },
      health: corrupt ? 'degraded' : 'healthy', anomaly: corrupt ? 'corrupt_state_recovered' : null,
      loops: {},
    };
    this.reconcile(definitions, now, Boolean(restored));
    if (corrupt) this.log(`[${role}] scheduled loops recovered corrupt state; delayed cadence reinitialized`);
  }

  reconcile(definitions: ResolvedRoleLoop[], now: number, recoverActive = false): void {
    const next: Record<string, LoopRuntimeState> = {};
    for (const definition of definitions) {
      const old = this.state.loops[definition.name];
      if (old?.definitionHash === definition.definitionHash) {
        next[definition.name] = {
          ...old, promptHash: definition.promptHash, enabled: definition.enabled,
          // A file written before this field existed restores as undefined; an
          // unreported gap is absent, not lost, so normalize rather than trust.
          missedGap: old.missedGap ?? null,
        };
      } else {
        const nominal = now + definition.initialDelayMs;
        next[definition.name] = {
          ...(old ?? {}),
          definitionHash: definition.definitionHash, promptHash: definition.promptHash,
          enabled: definition.enabled,
          nextScheduledAt: new Date(nominal).toISOString(),
          nextDueAt: new Date(nominal + deterministicJitter(
            definition.role, definition.name, nominal, definition.jitterMs)).toISOString(),
          lastScheduledAt: old?.lastScheduledAt ?? null,
          lastStartedAt: old?.lastStartedAt ?? null,
          lastFinishedAt: old?.lastFinishedAt ?? null,
          lastOutcome: old?.lastOutcome ?? null,
          lastCancellationSource: old?.lastCancellationSource ?? null,
          lastRunId: old?.lastRunId ?? null,
          activeRunId: old?.activeRunId ?? null,
          counts: old?.counts ?? zeroCounts(), lastError: old?.lastError ?? null,
          operatorDisabled: old?.operatorDisabled ?? false,
          missedGap: old?.missedGap ?? null,
        };
      }
      if (recoverActive && next[definition.name].activeRunId) {
        const item = next[definition.name];
        item.counts.failed = increment(item.counts.failed);
        item.lastOutcome = 'abandoned_restart';
        item.lastFinishedAt = new Date(now).toISOString();
        item.lastError = { kind: 'abandoned_restart', at: new Date(now).toISOString() };
        item.activeRunId = null;
        this.state.health = 'degraded';
        this.state.anomaly = 'abandoned_restart';
      }
    }
    this.state.loops = next;
    this.state.generation = createHash('sha256').update(JSON.stringify(definitions.map(item => ({
      name: item.name, definitionHash: item.definitionHash, promptHash: item.promptHash,
    })))).digest('hex');
    this.state.clock.lastWallMs = now;
    this.persist();
  }

  /**
   * Drop a transient anomaly once its cause is over — including one currently
   * displaced by `persist_failed`, which would otherwise come back the moment a
   * write finally lands.
   */
  clearAnomaly(kind: string): void {
    if (this.suppressed?.anomaly === kind) this.suppressed = { health: 'healthy', anomaly: null };
    if (this.state.anomaly === kind) {
      this.state.health = 'healthy';
      this.state.anomaly = null;
    }
  }

  /**
   * Checkpoint the state. A write failure — ENOSPC is the one seen in the field —
   * must never propagate: every caller sits under a timer callback, and an
   * exception there kills the scheduling chain for the life of the process while
   * the last-written file goes on claiming the loops are healthy. So the failure
   * is recorded in memory instead, where `status()` and the live control socket
   * report it immediately, and the caller decides what to do with `false`.
   *
   * The `failed` marker is applied optimistically-in-reverse: it is rolled back
   * just before each attempt, so that the write which finally lands records the
   * real health rather than the outage that is now over.
   */
  persist(): boolean {
    if (this.suppressed && this.state.anomaly === 'persist_failed') {
      this.state.health = this.suppressed.health;
      this.state.anomaly = this.suppressed.anomaly;
    }
    try {
      this.write(this.path, JSON.stringify(this.state, null, 2) + '\n', 0o600);
      chmodSync(this.path, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'Error';
      if (this.state.anomaly !== 'persist_failed')
        this.suppressed = { health: this.state.health, anomaly: this.state.anomaly };
      this.state.health = 'failed';
      this.state.anomaly = 'persist_failed';
      this.lastPersistError = code;
      this.persistFailures = increment(this.persistFailures);
      if (this.persistFailures === 1)
        this.log(`[${this.state.role}] scheduled loop state write failing (${code}); `
          + 'cadence held and health reported failed until it lands');
      return false;
    }
    if (this.persistFailures) {
      this.log(`[${this.state.role}] scheduled loop persistence recovered after `
        + `${this.persistFailures} failed write(s) (${this.lastPersistError})`);
      this.persistFailures = 0;
      this.lastPersistError = null;
    }
    this.suppressed = null;
    return true;
  }
}

function validFile(value: unknown): value is ScheduledLoopsFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as ScheduledLoopsFile;
  if (file.version !== 1 || typeof file.role !== 'string' || !file.clock
      || !Number.isSafeInteger(file.clock.lastWallMs) || !file.loops || typeof file.loops !== 'object')
    return false;
  return (file.health === 'healthy' || file.health === 'degraded' || file.health === 'failed')
    && (file.anomaly === null || typeof file.anomaly === 'string')
    && Object.values(file.loops).every(item => item && typeof item === 'object'
    && typeof item.definitionHash === 'string' && typeof item.promptHash === 'string'
    && typeof item.nextScheduledAt === 'string' && typeof item.nextDueAt === 'string'
    && Number.isFinite(Date.parse(item.nextScheduledAt)) && Number.isFinite(Date.parse(item.nextDueAt))
    && typeof item.enabled === 'boolean' && typeof item.operatorDisabled === 'boolean'
    && item.counts && Object.values(item.counts).every(count => Number.isSafeInteger(count) && count >= 0)
    && (item.activeRunId === null || typeof item.activeRunId === 'string'));
}

function safeStateFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600
      && (uid === undefined || stat.uid === uid);
  } catch { return false; }
}
