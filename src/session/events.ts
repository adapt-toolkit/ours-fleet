import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import type { SessionEvent, SessionEventKind } from './types.js';

const MAX_EVENTS = 1_000;
const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;

/** Bounded, typed event stream shared by CLI frontends and future ACP/Toad facades. */
export class SessionEvents {
  private seq = 0;
  private readonly events: SessionEvent[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(private readonly path: string) {
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
    try {
      this.rotateIfNeeded();
      appendFileSync(this.path, JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch { /* diagnostics must never terminate a role */ }
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

  private restore(): void {
    try {
      if (!existsSync(this.path)) return;
      const lines = readFileSync(this.path, 'utf8').trim().split('\n').slice(-MAX_EVENTS);
      for (const line of lines) {
        const event = JSON.parse(line) as SessionEvent;
        if (event.version === 1 && typeof event.seq === 'number') {
          this.events.push(event);
          this.seq = Math.max(this.seq, event.seq);
        }
      }
    } catch { /* begin a fresh projection if the diagnostic file is corrupt */ }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path) || statSync(this.path).size < MAX_EVENT_FILE_BYTES) return;
    const rotated = this.path + '.1';
    try { renameSync(this.path, rotated); }
    catch { writeFileSync(this.path, '', { mode: 0o600 }); }
  }
}
