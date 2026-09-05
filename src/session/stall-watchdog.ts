import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60_000;
export const STALL_RECOVERY_PROMPT = 'This is a diagnostic interruption. The previous turn showed no progress. '
  + 'Inspect recorded terminal events and re-check completed actions before continuing. '
  + 'Never assume an issued side effect failed: do not replay ambiguous or already-completed mutations. '
  + 'Continue the previous task if safe; otherwise report an actionable blocker.';

export type StallStatus = 'interrupt_requested' | 'recovery_started' | 'progress_resumed'
  | 'recovery_completed' | 'blocked_cancel' | 'blocked_recovery' | 'blocked_restall'
  | 'blocked_persistence' | 'blocked_previous_attempt' | 'blocked_evidence' | 'superseded';
export interface StallDiagnostic {
  version: 1;
  kind: 'stall_recovery';
  eventId: string;
  session: string;
  turn: string;
  status: StallStatus;
  evidence: 'adapter_transport' | 'no_progress';
  idleMs: number;
}
export interface StallObservation {
  sessionId: string;
  generation: string;
  turnId: string;
  startedAt: number;
  lastProgressAt: number;
  progressCount: number;
  transportFailures: number;
  safe: boolean;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * One durable attempt per ACP session, deliberately stricter than one per turn.
 * A restarted supervisor never guesses whether cancellation or recovery ran.
 * Claim files are never reclaimed automatically, including malformed/empty ones.
 */
export class StallWatchdog {
  private checking = false;
  private disabled = false;
  private unavailableTurn?: string;
  constructor(private readonly options: {
    stateDir: string;
    timeoutMs: number;
    now(): number;
    observe(): StallObservation | undefined;
    recover(observed: StallObservation, report: (status: StallStatus) => void): Promise<void>;
    diagnostic(event: StallDiagnostic): void;
  }) {}

  async tick(): Promise<void> {
    if (this.checking || this.disabled) return;
    const observed = this.options.observe();
    if (!observed?.safe) return;
    const missingEvidence = observed.progressCount === 0;
    // Turn age can only produce an informational blocker, never cancellation.
    const idleMs = this.options.now() - (missingEvidence ? observed.startedAt : observed.lastProgressAt);
    // Generic silence needs two full windows. Authenticated repeated transport
    // failures strengthen evidence, but never bypass protected-operation checks.
    const threshold = this.options.timeoutMs * (!missingEvidence && observed.transportFailures >= 2 ? 1 : 2);
    if (!Number.isFinite(idleMs) || idleMs < threshold) return;
    this.checking = true;
    const session = digest(observed.sessionId);
    const turn = digest(observed.generation + '\0' + observed.turnId);
    const directory = join(this.options.stateDir, '.stall-recovery');
    const report = (status: StallStatus) => {
      const event: StallDiagnostic = {
        version: 1, kind: 'stall_recovery', eventId: `${turn}:${status}`,
        session, turn, status, idleMs: Math.floor(idleMs),
        evidence: observed.transportFailures >= 2 ? 'adapter_transport' : 'no_progress',
      };
      const fd = openSync(join(directory, 'audit.jsonl'), 'a', 0o600);
      try { writeFileSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      this.options.diagnostic(event);
    };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const parentFd = openSync(this.options.stateDir, 'r');
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      if (missingEvidence) {
        if (this.unavailableTurn !== turn) {
          this.unavailableTurn = turn;
          report('blocked_evidence');
        }
        return;
      }
      let fd: number;
      try { fd = openSync(join(directory, `${session}.claim`), 'wx', 0o600); }
      catch (error) {
        this.disabled = true;
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          report('blocked_previous_attempt');
          return;
        }
        throw error;
      }
      // Even a crash before this write leaves a permanent conservative fence.
      try { writeFileSync(fd, JSON.stringify({ version: 1, session, turn }) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      const dirFd = openSync(directory, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      this.disabled = true;
      report('interrupt_requested');
      // No await between the durable claim and the adapter's final atomic
      // observation check. Recovery itself must re-check before session/cancel.
      await this.options.recover(observed, report);
    } catch {
      this.disabled = true;
      // Never include an exception string: it may contain paths or wire data.
      this.options.diagnostic({ version: 1, kind: 'stall_recovery',
        eventId: `${turn}:blocked_persistence`, session, turn,
        status: 'blocked_persistence', evidence: 'no_progress', idleMs: Math.floor(idleMs) });
    } finally { this.checking = false; }
  }
}
