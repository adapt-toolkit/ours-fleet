import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface NotificationInput { eventId: string; title: string; body: string; url: string; }
interface Entry { id: string; value: unknown; payload?: NotificationInput; }
export interface ProducerConfig { origin: string; token: string; }
export function producerConfig(env: NodeJS.ProcessEnv = process.env): ProducerConfig | undefined {
  const origin = env.OURS_NOTIFICATIONS_ORIGIN, token = env.OURS_NOTIFICATIONS_PRODUCER_TOKEN;
  if (!origin && !token) return;
  if (!origin || !token || token.length < 32) throw new Error('notifications producer requires origin and scoped token');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('invalid notification service origin');
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('notification credentials require HTTPS or loopback');
  return { origin, token };
}

/** Durable producer queue. Service dedupe makes crash-after-acceptance replay safe. */
export class NotificationOutbox {
  private entries: Entry[];
  cursor?: number;
  checkpoint?: unknown;
  private running?: Promise<void>;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly file: string, private readonly config: ProducerConfig,
    private readonly project: (value: unknown, id: string) => Promise<NotificationInput>,
    private readonly warn: (message: string) => void = () => {}) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { entries: [] };
    this.entries = Array.isArray(saved) ? saved : saved.entries;
    this.cursor = saved.cursor;
    this.checkpoint = saved.checkpoint;
    if (!Array.isArray(this.entries)) throw new Error('invalid notification outbox');
    this.timer = setInterval(() => { void this.drain(); }, 3000); this.timer.unref();
  }
  private persist(entries: Entry[], cursor = this.cursor, checkpoint = this.checkpoint): void {
    const tmp = this.file + '.tmp', fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ entries, cursor, checkpoint })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const dir = openSync(dirname(this.file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    this.entries = entries; this.cursor = cursor; this.checkpoint = checkpoint;
  }
  advance(cursor: number): void { this.persist(this.entries, cursor); }
  saveCheckpoint(checkpoint: unknown): void { this.persist(this.entries, this.cursor, checkpoint); }
  enqueue(id: string, value: unknown, cursor = this.cursor): boolean {
    if (this.entries.some(e => e.id === id)) { if (cursor !== this.cursor) this.advance(cursor!); return true; }
    if (this.entries.length >= 2000) return false;
    this.persist([...this.entries, { id, value }], cursor);
    return true;
  }
  drain(): Promise<void> {
    return this.running ??= this.drainOnce().finally(() => { this.running = undefined; });
  }
  private async drainOnce(): Promise<void> {
    for (const entry of [...this.entries].slice(0, 32)) {
      try {
        const value = entry.payload ?? await this.project(entry.value, entry.id);
        // Freeze the canonical projection before any network attempt. A crash
        // after service acceptance must replay the identical dedupe payload.
        if (!entry.payload) this.persist(this.entries.map(e => e.id === entry.id ? { ...e, payload: value } : e));
        const response = await fetch(this.config.origin + '/api/v1/send', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('notification service rejected event');
        this.persist(this.entries.filter(e => e.id !== entry.id));
      } catch { this.warn('Notification producer delivery pending; retrying from durable outbox'); break; }
    }
  }
  async close(): Promise<void> { clearInterval(this.timer); await this.running; }
}
