import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from './atomic-file.js';
import { formatNotificationLine, type NotifyEvent } from './monitor.js';
import { ACP_PROMPT_NOT_DISPATCHED, ACP_SESSION_RECOVERY_REQUIRED } from './session/acp.js';
import type { AgentSession } from './session/types.js';

/** Trusted daemon metadata only; never a source message body or Owner authority. */
export interface MonitorAdmission {
  scope: string;
  cursor?: number;
  events: Array<{ key: string; event: NotifyEvent }>;
}
export interface MonitorAdmissionReceipt { admitted: true; outcome: 'queued' | 'duplicate' }
interface WakeRow {
  id: string;
  keys: string[];
  scope?: string;
  text: string;
  state: 'queued' | 'dispatching' | 'terminal' | 'unknown';
  outcome?: string;
  generation?: string;
}
interface Journal { version: 1; owner: string; scope?: string; coveredCursor?: number; rows: WakeRow[] }

/**
 * Durable responsibility for body-free hints, before the monitor commits its
 * stream cursor. The runner owns a single instance under its existing launch
 * lease. Only idle prompts enter the arbiter; there is no adapter-side queue.
 * A new, synchronized session can drain unstarted rows, but must never replay
 * a row whose dispatch may already have produced model/tool side effects.
 */
export class DurableMonitorDelivery {
  private readonly path: string;
  private readonly owner = randomUUID();
  private journal: Journal;
  private started = false;
  private closed = false;
  private pumping = false;
  private scheduled = false;
  private failed = false;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: { stateDir: string; session: AgentSession; currentScope?(): string; log(line: string): void }) {
    this.path = join(options.stateDir, '.monitor-ingress.json');
    const old = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as Journal : undefined;
    if (old && (old.version !== 1 || !Array.isArray(old.rows)
        || old.rows.some(r => !r || typeof r.id !== 'string' || typeof r.text !== 'string'
          || !Array.isArray(r.keys) || r.keys.some(k => typeof k !== 'string')
          || !['queued', 'dispatching', 'terminal', 'unknown'].includes(r.state))))
      throw new Error('monitor ingress journal invalid; operator recovery required');
    this.journal = { version: 1, owner: this.owner, scope: old?.scope, coveredCursor: old?.coveredCursor,
      rows: (old?.rows ?? []).map(row => row.state === 'dispatching'
        ? { ...row, state: 'unknown', outcome: 'unknown_after_restart' } : row) };
    if (old) {
      this.write(this.journal);
      this.reportUnknown();
    }
  }

  /** Call only after startup has established a usable session boundary. */
  start(scope: string): void {
    if (this.started || this.closed) return;
    if (!scope) throw new Error('monitor source scope unavailable');
    this.validateSource(scope);
    this.assertOwner();
    if (this.journal.scope && this.journal.scope !== scope) {
      const oldScope = this.journal.scope;
      const next: Journal = { ...this.journal, scope, coveredCursor: undefined, rows: this.journal.rows.map(row => ({
        ...row, scope: row.scope ?? oldScope,
        ...(row.state === 'queued' || row.state === 'dispatching'
          ? { state: 'unknown' as const, outcome: 'source_scope_changed' } : {}),
      })) };
      this.write(next); this.journal = next; this.reportUnknown();
    } else if (!this.journal.scope) {
      const next = { ...this.journal, scope };
      this.write(next); this.journal = next;
    }
    this.started = true;
    this.unsubscribe = this.options.session.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.schedule(), 1000);
    this.timer.unref();
    this.schedule();
  }

  async admit(batch: MonitorAdmission): Promise<MonitorAdmissionReceipt> {
    if (this.closed || this.failed) throw new Error('monitor ingress unavailable; recovery required');
    this.assertOwner();
    this.validateSource(batch.scope);
    if (!batch.scope || (this.journal.scope && this.journal.scope !== batch.scope))
      throw new Error('monitor ingress scope mismatch; operator recovery required');
    if (!Array.isArray(batch.events) || batch.events.some(item => typeof item.key !== 'string' || !item.key))
      throw new Error('monitor event identity unavailable');
    const seen = new Set(this.journal.rows.filter(row => (row.scope ?? this.journal.scope) === batch.scope).flatMap(row => row.keys));
    const fresh = batch.events.filter(item => {
      if (!item.key || seen.has(item.key)) return false;
      seen.add(item.key); return true;
    });
    if (batch.cursor !== undefined && (!Number.isSafeInteger(batch.cursor) || batch.cursor < 0))
      throw new Error('invalid monitor cursor');
    const coveredCursor = batch.cursor === undefined ? this.journal.coveredCursor
      : Math.max(this.journal.coveredCursor ?? 0, batch.cursor);
    if (!fresh.length) {
      if (coveredCursor !== this.journal.coveredCursor) {
        const next = { ...this.journal, coveredCursor };
        try { this.write(next); } catch (error) { this.failed = true; throw error; }
        this.journal = next;
      }
      return { admitted: true, outcome: 'duplicate' };
    }
    const next: Journal = { ...this.journal, scope: batch.scope, coveredCursor, rows: [...this.journal.rows, {
      id: randomUUID(), scope: batch.scope, keys: fresh.map(item => item.key),
      text: formatNotificationLine(fresh.map(item => item.event)), state: 'queued',
    }] };
    // Publish in memory only AFTER fsync + atomic replace succeeds.
    try { this.write(next); } catch (error) { this.failed = true; throw error; }
    this.journal = next;
    this.schedule();
    return { admitted: true, outcome: 'queued' };
  }

  admittedCursor(scope: string): number | undefined {
    this.validateSource(scope);
    return this.journal.scope === scope ? this.journal.coveredCursor : undefined;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  private validateSource(scope: string): void {
    if (this.options.currentScope && this.options.currentScope() !== scope)
      throw new Error('monitor source incarnation changed; recovery required');
  }

  private assertOwner(): void {
    if (existsSync(this.path)) {
      const disk = JSON.parse(readFileSync(this.path, 'utf8')) as Journal;
      if (disk.owner !== this.owner) throw new Error('monitor ingress generation retired');
    }
  }

  private write(journal: Journal): void {
    replaceFileAtomically(this.path, JSON.stringify(journal) + '\n');
  }

  private update(id: string, patch: Partial<WakeRow>): void {
    this.assertOwner();
    const next = { ...this.journal, rows: this.journal.rows.map(r => r.id === id ? { ...r, ...patch } : r) };
    this.write(next); this.journal = next;
  }

  private schedule(): void {
    if (!this.started || this.closed || this.failed || this.pumping || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; void this.pump(); });
  }

  private async pump(): Promise<void> {
    if (!this.started || this.closed || this.failed || this.pumping) return;
    try { this.validateSource(this.journal.scope!); }
    catch {
      this.failed = true;
      this.options.log('monitor ingress source unavailable or replaced; queued hints retained, source reconciliation required');
      return;
    }
    const snapshot = this.options.session.snapshot();
    if (!snapshot.alive || snapshot.readiness !== 'idle' || (snapshot.activity?.activeToolCalls ?? 0) > 0) return;
    const row = this.journal.rows.find(r => r.state === 'queued' && (r.scope ?? this.journal.scope) === this.journal.scope);
    if (!row) return;
    this.pumping = true;
    try {
      this.update(row.id, { state: 'dispatching', generation: this.owner });
      const result = await this.options.session.submitPrompt(row.text, {
        interrupt: false, steer: false, origin: { kind: 'fleet-monitor' },
      });
      if (this.closed) return;
      if (result.detail?.startsWith(`${ACP_PROMPT_NOT_DISPATCHED}:`)) {
        this.update(row.id, { state: 'queued', outcome: 'awaiting_session_recovery' });
        this.failed = true;
        this.options.log(`monitor ingress ${row.id}: not dispatched; retained for synchronized session recovery`);
        return;
      }
      if (result.outcome === 'failed' || result.detail?.startsWith(ACP_SESSION_RECOVERY_REQUIRED)) {
        this.update(row.id, { state: 'unknown', outcome: 'rpc_outcome_unknown' });
        this.failed = true; this.reportUnknown(); return;
      }
      // Even a refused/cancelled execution is an execution, not a fresh wake.
      this.update(row.id, { state: 'terminal', outcome: result.outcome });
      if (!result.succeeded)
        this.options.log(`monitor ingress ${row.id}: execution ${result.outcome}; not replayed`);
    } catch {
      if (this.closed) return;
      // Includes ambiguous RPC errors and failed terminal persistence. Never
      // acknowledge execution or retry an uncertain row; retain disk evidence.
      this.failed = true;
      this.options.log('monitor ingress recovery required; inspect .monitor-ingress.json; uncertain dispatch is not replayed');
    } finally {
      this.pumping = false;
      this.schedule();
    }
  }

  private reportUnknown(): void {
    const unknown = this.journal.rows.filter(row => row.state === 'unknown');
    if (unknown.length)
      this.options.log(`monitor ingress: ${unknown.length} uncertain dispatch(es) retained in .monitor-ingress.json; operator must inspect source unread/history before explicitly requesting another wake; no automatic replay`);
  }
}
