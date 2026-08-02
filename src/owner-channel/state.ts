import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface ChannelState { version: 1; handled: string[] }

/** Durable bounded dedupe containing wire IDs only — never message or reply plaintext. */
export class OwnerChannelState {
  private handled: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly path: string, private readonly limit = 5_000) {
    try {
      if (!existsSync(path)) return;
      const state = JSON.parse(readFileSync(path, 'utf8')) as Partial<ChannelState>;
      if (state.version !== 1 || !Array.isArray(state.handled)) return;
      this.handled = state.handled.filter(id => typeof id === 'string').slice(-limit);
      for (const id of this.handled) this.seen.add(id);
    } catch { /* a corrupt cache safely degrades to at-least-once delivery */ }
  }

  has(wireId: string): boolean { return this.seen.has(wireId); }

  remember(wireId: string): void {
    if (this.seen.has(wireId)) return;
    this.handled.push(wireId);
    this.seen.add(wireId);
    while (this.handled.length > this.limit) this.seen.delete(this.handled.shift()!);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, handled: this.handled }) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
