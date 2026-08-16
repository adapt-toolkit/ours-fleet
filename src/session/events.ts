import { existsSync, renameSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  appendLineAtomic, findSequenceGaps, quarantineDamage, readLog,
  type DamagedLine, type SequenceGap,
} from './event-log.js';
import type { SessionEvent, SessionEventKind } from './types.js';

const MAX_EVENTS = 1_000;
const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;

/** What the on-disk stream is known to have lost or mangled. Never optimistic. */
export interface StreamIntegrity {
  healthy: boolean;
  damaged: DamagedLine[];
  gaps: SequenceGap[];
  quarantined: boolean;
  quarantineError?: string;
  /** Appends that failed outright; their events survive in memory only. */
  writeFailures: number;
  lastWriteError?: string;
  /** Appends that had to close off a dangling partial record first. */
  boundaryRepairs: number;
  rotationFailed: boolean;
}

/** Bounded, typed event stream shared by CLI frontends and future ACP/Toad facades. */
export class SessionEvents {
  private seq = 0;
  private readonly events: SessionEvent[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly integrityState: StreamIntegrity = {
    healthy: true, damaged: [], gaps: [], quarantined: false,
    writeFailures: 0, boundaryRepairs: 0, rotationFailed: false,
  };

  private readonly rotatedPath: string;

  constructor(private readonly path: string) {
    this.rotatedPath = path + '.1';
    this.restore();
  }

  emit(kind: SessionEventKind, fields: Omit<SessionEvent, 'version' | 'seq' | 'at' | 'kind'> = {}): SessionEvent {
    const event: SessionEvent = {
      version: 1,
      seq: ++this.seq,
      at: new Date().toISOString(),
      kind,
      ...fields,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.persist(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  since(seq: number): SessionEvent[] {
    return this.events.filter(event => event.seq > seq);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Snapshot of what is known to be wrong with the persisted stream. */
  integrity(): StreamIntegrity {
    return { ...this.integrityState, damaged: [...this.integrityState.damaged], gaps: [...this.integrityState.gaps] };
  }

  private persist(event: SessionEvent): void {
    this.rotateIfNeeded();
    // Owner-visible commentary remains live/in-memory for the authenticated
    // bridge, but its plaintext must not become diagnostic state on disk.
    const persisted = event.kind === 'agent_text' && event.messagePhase === 'commentary'
      ? { ...event, text: '[assistant commentary redacted]' }
      : event;
    try {
      const { repairedBoundary } = appendLineAtomic(this.path, JSON.stringify(persisted));
      if (repairedBoundary) {
        this.integrityState.boundaryRepairs++;
        this.integrityState.healthy = false;
      }
    } catch (error) {
      // Diagnostics must never terminate a role, but a silent loss is how the
      // 06:32 incident stayed invisible for an hour — record it instead.
      this.integrityState.writeFailures++;
      this.integrityState.lastWriteError = error instanceof Error ? error.message : String(error);
      this.integrityState.healthy = false;
    }
  }

  private restore(): void {
    // Rotation renames the live stream to `.1` and only then starts a new one.
    // A crash in that window leaves no live file at all, so reading only the
    // live path would restart at seq 1 and re-issue numbers `.1` already holds.
    const rotated = readLog(this.rotatedPath);
    const live = readLog(this.path);
    const records = [...rotated.records, ...live.records];
    for (const record of records.slice(-MAX_EVENTS)) this.events.push(record as unknown as SessionEvent);
    // Monotonic even across damage and rotation: a sequence number already on
    // disk, readable or not, is never handed out again.
    this.seq = Math.max(this.seq, rotated.maxSeq, live.maxSeq);

    const damaged = [...rotated.damaged, ...live.damaged];
    // Records that parse perfectly still leave a hole when the writes between
    // them never landed, and a hole on the rotated/live boundary is invisible to
    // either file alone — so gaps are computed over the combined ordered run,
    // and reported whether or not any bytes were mangled.
    const gaps = findSequenceGaps([...rotated.sequence, ...live.sequence]);
    if (damaged.length === 0 && gaps.length === 0) return;

    this.integrityState.healthy = false;
    this.integrityState.damaged = damaged;
    this.integrityState.gaps = gaps;
    let error: string | undefined;
    if (damaged.length > 0) {
      const results = [
        quarantineDamage(this.path, rotated.damaged, this.rotatedPath),
        quarantineDamage(this.path, live.damaged, this.path),
      ].filter(result => result.quarantined || result.error);
      this.integrityState.quarantined = results.every(result => result.quarantined);
      error = results.find(result => result.error)?.error;
      if (error) this.integrityState.quarantineError = error;
    }
    // Reported through the ordinary stream so it reaches replay and audit;
    // never through a second attempt at the writer that just failed.
    this.emit('error', { text: this.describeLoss(damaged, gaps, error) });
  }

  private describeLoss(damaged: DamagedLine[], gaps: SequenceGap[], error?: string): string {
    const interior = damaged.filter(line => line.reason === 'interior_corruption');
    const tails = damaged.filter(line => line.reason === 'truncated_tail');
    const parts: string[] = ['event stream integrity'];
    if (interior.length) {
      parts.push(`${interior.length} interior corruption at line ${interior.map(l => l.lineNumber).join(', ')}`);
    }
    if (tails.length) parts.push(`${tails.length} truncated tail discarded`);
    const missing = gaps.reduce((total, gap) => total + gap.missing, 0);
    if (missing) {
      const span = gaps.map(gap => `${gap.afterSeq}..${gap.beforeSeq}`).join(', ');
      parts.push(`${missing} record${missing === 1 ? '' : 's'} lost between seq ${span} (irrecoverable)`);
    }
    if (damaged.length) {
      parts.push(this.integrityState.quarantined
        ? `damaged bytes quarantined to ${basename(this.path)}.corrupt`
        : `damaged bytes NOT quarantined${error ? ` (${error})` : ''}`);
    }
    return parts.join('; ');
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    try { if (statSync(this.path).size < MAX_EVENT_FILE_BYTES) return; }
    catch { return; }
    try {
      renameSync(this.path, this.rotatedPath);
      this.integrityState.rotationFailed = false;
    } catch {
      // Fail closed: the previous fallback truncated the live stream, which
      // destroys exactly the evidence an incident needs.
      this.integrityState.rotationFailed = true;
      this.integrityState.healthy = false;
    }
  }
}
