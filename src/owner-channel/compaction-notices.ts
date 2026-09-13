import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { replaceFileAtomically } from '../atomic-file.js';

type SendState = 'sending' | 'sent' | 'unknown';
interface Row { key: string; start?: SendState; terminal?: SendState }
interface Notice {
  sessionId: string; compactionId: string; status: string; replayed?: boolean;
  contact: string; replyTo?: string;
}
interface Options {
  path: string; enabled: boolean;
  authorized(contact: string): boolean;
  send(contact: string, text: string, replyTo?: string): Promise<void>;
  log(text: string): void;
}
const terminalText: Record<string, string> = {
  completed: 'Compaction done.', failed: 'Compaction failed.', cancelled: 'Compaction cancelled.',
  unknown_ended: 'Compaction outcome unknown; session recovery is required.',
};

/** Opt-in, body-free outbox: uncertain sends are never retried automatically. */
export class CompactionNotices {
  private rows = new Map<string, Row>();
  private tail: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly options: Options) {
    if (!options.enabled || !existsSync(options.path)) return;
    try {
      const data = readFileSync(options.path, 'utf8');
      if (Buffer.byteLength(data) > 1024 * 1024) throw new Error();
      const parsed = JSON.parse(data) as { version?: unknown; rows?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.rows) || parsed.rows.length > 4096) throw new Error();
      for (const row of parsed.rows as Row[]) {
        if (!row || typeof row.key !== 'string' || !/^[a-f0-9]{64}$/.test(row.key)
            || this.rows.has(row.key) || ![undefined, 'sending', 'sent', 'unknown'].includes(row.start)
            || ![undefined, 'sending', 'sent', 'unknown'].includes(row.terminal)) throw new Error();
        this.rows.set(row.key, { key: row.key,
          ...(row.start ? { start: row.start === 'sending' ? 'unknown' : row.start } : {}),
          ...(row.terminal ? { terminal: row.terminal === 'sending' ? 'unknown' : row.terminal } : {}),
        });
      }
      this.persist(this.rows);
    } catch { this.disable(); }
  }

  observe(notice: Notice): Promise<void> {
    if (!this.options.enabled || this.failed || notice.replayed) return Promise.resolve();
    const phase = notice.status === 'in_progress' ? 'start' : Object.hasOwn(terminalText, notice.status) ? 'terminal' : undefined;
    if (!phase) return Promise.resolve();
    // Capture only routing and allowlisted presentation; no future raw statuses/content.
    const text = phase === 'start' ? 'Compacting the conversation…' : terminalText[notice.status];
    const key = createHash('sha256').update(JSON.stringify([
      notice.sessionId, notice.compactionId, notice.contact.toUpperCase(),
    ])).digest('hex');
    const { contact, replyTo } = notice;
    this.tail = this.tail.then(async () => {
      if (this.failed || !this.options.authorized(contact)) return;
      const current = this.rows.get(key) ?? { key };
      if (current[phase] || (phase === 'start' && current.terminal)) return;
      if (!this.rows.has(key) && this.rows.size >= 4096) { this.disable(); return; }
      if (phase === 'terminal' && current.start !== 'sent') {
        const silent = new Map(this.rows);
        silent.set(key, { ...current, terminal: 'unknown' });
        try { this.persist(silent); } catch { this.disable(); }
        return;
      }
      const claim = new Map(this.rows);
      claim.set(key, { ...current, [phase]: 'sending' });
      try { this.persist(claim); }
      catch { this.disable(); return; }
      let result: SendState = 'sent';
      try {
        if (!this.options.authorized(contact)) throw new Error();
        await this.options.send(contact, text, replyTo);
      } catch {
        result = 'unknown';
        this.options.log('Compaction notice delivery unknown; automatic resend disabled');
      }
      const finished = new Map(this.rows);
      finished.set(key, { ...this.rows.get(key)!, [phase]: result });
      try { this.persist(finished); } catch { this.disable(); }
    }).catch(() => { this.disable(); });
    return this.tail;
  }

  private persist(rows: Map<string, Row>): void {
    replaceFileAtomically(this.options.path, JSON.stringify({ version: 1, rows: [...rows.values()] }), 0o600);
    this.rows = rows;
  }

  private disable(): void {
    if (!this.failed) this.options.log('Compaction notices disabled; outbox state requires reconciliation');
    this.failed = true;
  }
}
