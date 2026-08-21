import { chmodSync, existsSync, readFileSync } from 'node:fs';

import { replaceFileAtomically } from '../atomic-file.js';

const MAX_PENDING_MESSAGES = 5_000;
const MAX_WIRE_ID_CHARS = 1_024;

export interface PendingMessageClaim {
  wireId: string;
  seq: number;
  claimedAt: number;
}

interface MessageRecoveryFile {
  version: 1;
  pending: PendingMessageClaim[];
}

/**
 * Body-free crash journal for the SQLite getMessages read boundary.
 *
 * A claim lands before getMessages marks its exact oldest-first batch read.
 * After a crash, getHistoryItem can therefore recover the body by wire ID
 * without fleet ever duplicating message plaintext in its own state.
 */
export class MessageRecoveryState {
  private pending: PendingMessageClaim[] = [];
  private corrupt = false;

  constructor(private readonly path: string, private readonly limit = MAX_PENDING_MESSAGES) {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MessageRecoveryFile>;
      if (raw.version !== 1 || !Array.isArray(raw.pending)
          || raw.pending.length > limit || !raw.pending.every(validClaim)
          || new Set(raw.pending.map(item => item.wireId)).size !== raw.pending.length)
        throw new Error('invalid message recovery state');
      this.pending = raw.pending.map(item => ({ ...item }));
      chmodSync(path, 0o600);
    } catch {
      this.corrupt = true;
      this.pending = [];
      try { chmodSync(path, 0o600); } catch { /* retain the evidence */ }
    }
  }

  integrity(): boolean { return !this.corrupt; }

  list(): PendingMessageClaim[] {
    this.assertHealthy();
    return this.pending.map(item => ({ ...item }));
  }

  claim(items: PendingMessageClaim[]): void {
    this.assertHealthy();
    if (!items.length) return;
    if (!items.every(validClaim)) throw new Error('invalid message recovery claim');
    const next = this.pending.map(item => ({ ...item }));
    const byWire = new Map(next.map(item => [item.wireId, item]));
    for (const item of items) {
      const existing = byWire.get(item.wireId);
      if (existing) {
        if (existing.seq !== item.seq)
          throw new Error('message recovery wire ID changed sequence');
        continue;
      }
      if (next.length >= this.limit) throw new Error('too many pending message recoveries');
      const copy = { ...item };
      next.push(copy);
      byWire.set(copy.wireId, copy);
    }
    if (next.length === this.pending.length) return;
    const previous = this.pending;
    this.pending = next;
    try { this.persist(); }
    catch (error) { this.pending = previous; throw error; }
  }

  pruneHandled(handled: (wireId: string) => boolean): number {
    this.assertHealthy();
    const next = this.pending.filter(item => !handled(item.wireId));
    const removed = this.pending.length - next.length;
    if (!removed) return 0;
    const previous = this.pending;
    this.pending = next;
    try { this.persist(); }
    catch (error) { this.pending = previous; throw error; }
    return removed;
  }

  private assertHealthy(): void {
    if (this.corrupt) throw new Error('message recovery state is corrupt');
  }

  private persist(): void {
    replaceFileAtomically(this.path, JSON.stringify({
      version: 1, pending: this.pending,
    } satisfies MessageRecoveryFile) + '\n', 0o600);
    chmodSync(this.path, 0o600);
  }
}

function validClaim(value: unknown): value is PendingMessageClaim {
  if (!value || typeof value !== 'object') return false;
  const item = value as PendingMessageClaim;
  return typeof item.wireId === 'string' && item.wireId.length >= 1
    && Array.from(item.wireId).length <= MAX_WIRE_ID_CHARS
    && Number.isSafeInteger(item.seq) && item.seq >= 1
    && Number.isSafeInteger(item.claimedAt) && item.claimedAt >= 0;
}
