import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  ConversationEventV1, PromptReceipt,
} from './conversation-types.js';

/**
 * Durable, append-only, single-writer conversation ledger for one role
 * The per-role runner is the only writer; readers page by seq.
 *
 * Unlike `SessionEvents` (a bounded diagnostic projection that may drop
 * writes silently), this store is the transcript of record: an acknowledged
 * browser prompt exists here before the browser hears "accepted", so
 * `append` THROWS on failure. Agent-stream normalization uses `appendSafe`,
 * which degrades visibly instead of killing role work already in progress.
 */

const MANIFEST = 'manifest.json';
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
/** In-memory tail kept for fast paging and follow backfill. */
const TAIL_EVENTS = 1_000;

interface Manifest {
  schemaVersion: 1;
  nextSeq: number;
  segments: string[];
}

interface CommandRecord {
  receipt: PromptReceipt;
  bodyDigest: string;
}

export interface ConversationStoreOptions {
  roleId: string;
  segmentBytes?: number;
  log?(line: string): void;
}

export interface OpenPrompt {
  promptId: string;
  state: 'admitted' | 'started';
  /** The prompt body, when it was persisted (browser/local sources). */
  text?: string;
  commandId?: string;
  sessionGeneration: string;
}

export interface ConversationPageRequest {
  after?: string;
  limit?: number;
}

export interface ConversationStorePage {
  events: ConversationEventV1[];
  firstAvailableCursor?: string;
  nextCursor?: string;
  hasMore: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key reused with a different body');
    this.name = 'IdempotencyConflictError';
  }
}

type EventDraft = Omit<ConversationEventV1, 'schemaVersion' | 'roleId' | 'eventId' | 'seq' | 'at'>;

export class ConversationEventStore {
  private nextSeq = 1;
  private segments: string[] = [];
  private tail: ConversationEventV1[] = [];
  private readonly listeners = new Set<(event: ConversationEventV1) => void>();
  private readonly commands = new Map<string, CommandRecord>();
  private readonly promptStates = new Map<string, OpenPrompt>();
  private activeFd?: number;
  private activeBytes = 0;
  private _degraded = false;
  private degradedReason?: string;
  private readonly segmentBytes: number;
  private readonly roleId: string;
  private readonly log: (line: string) => void;

  constructor(private readonly dir: string, options: ConversationStoreOptions) {
    this.roleId = options.roleId;
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
    this.log = options.log ?? (() => {});
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.recover();
    } catch (error) {
      this.markDegraded(`store unavailable: ${(error as Error).message}`);
    }
  }

  /** First 24 hex chars of sha-256; the idempotency body-digest convention. */
  static bodyDigest(body: string): string {
    return createHash('sha256').update(body).digest('hex').slice(0, 24);
  }

  get degraded(): boolean { return this._degraded; }
  get degradedDetail(): string | undefined { return this.degradedReason; }

  /**
   * Durably append one event. Throws when the record cannot be persisted —
   * the caller must fail its command rather than acknowledge a lost prompt.
   */
  append(draft: EventDraft): ConversationEventV1 {
    const event: ConversationEventV1 = {
      schemaVersion: 1,
      roleId: this.roleId,
      eventId: `e${this.nextSeq}`,
      seq: this.nextSeq,
      at: new Date().toISOString(),
      ...draft,
    };
    const line = JSON.stringify(event) + '\n';
    const fd = this.segmentFd(Buffer.byteLength(line));
    writeSync(fd, line);
    fsyncSync(fd);
    this.nextSeq++;
    this.activeBytes += Buffer.byteLength(line);
    this.tail.push(event);
    if (this.tail.length > TAIL_EVENTS) this.tail.shift();
    this.trackPromptState(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /**
   * Append an agent-stream event; on failure record degradation and keep the
   * role alive. Conversation durability may degrade, active work must not die.
   */
  appendSafe(draft: EventDraft): ConversationEventV1 | undefined {
    try {
      return this.append(draft);
    } catch (error) {
      this.markDegraded(`event append failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  page(request: ConversationPageRequest = {}): ConversationStorePage {
    const after = cursorSeq(request.after);
    const limit = Math.min(Math.max(request.limit ?? 200, 1), 1_000);
    const events = this.eventsAfter(after, limit + 1);
    const hasMore = events.length > limit;
    const pageEvents = hasMore ? events.slice(0, limit) : events;
    const firstStored = this.firstStoredSeq();
    return {
      events: pageEvents,
      ...(firstStored !== undefined ? { firstAvailableCursor: String(firstStored) } : {}),
      ...(pageEvents.length ? { nextCursor: String(pageEvents.at(-1)!.seq) } : {}),
      hasMore,
    };
  }

  subscribe(listener: (event: ConversationEventV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Store the receipt a repeated command must get back. */
  recordReceipt(commandId: string, receipt: PromptReceipt, bodyDigest: string): void {
    this.commands.set(commandId, { receipt, bodyDigest });
  }

  /**
   * The receipt for a previously accepted command, or undefined for a new one.
   * A reused ID with a different body digest is a conflict, never a replay.
   */
  receiptFor(commandId: string, bodyDigest: string): PromptReceipt | undefined {
    const record = this.commands.get(commandId);
    if (!record) return undefined;
    if (record.bodyDigest !== bodyDigest) throw new IdempotencyConflictError();
    return record.receipt;
  }

  /**
   * Prompts with no terminal event, classified for restart recovery:
   * `admitted` never started and is safe to restore into the FIFO;
   * `started` may already have had side effects and must not be replayed.
   */
  openPrompts(): OpenPrompt[] {
    return [...this.promptStates.values()];
  }

  lastCursor(): string | undefined {
    return this.nextSeq > 1 ? String(this.nextSeq - 1) : undefined;
  }

  close(): void {
    if (this.activeFd !== undefined) {
      try { closeSync(this.activeFd); } catch { /* already closed */ }
      this.activeFd = undefined;
    }
    this.listeners.clear();
  }

  // ── recovery ───────────────────────────────────────────────────────────────

  private recover(): void {
    const manifest = this.readManifest();
    this.segments = manifest?.segments.filter(name =>
      existsSync(join(this.dir, name))) ?? this.discoverSegments();
    if (!this.segments.length) this.segments = this.discoverSegments();
    let maxSeq = 0;
    for (const segment of this.segments) {
      for (const event of this.readSegment(segment)) {
        maxSeq = Math.max(maxSeq, event.seq);
        this.tail.push(event);
        if (this.tail.length > TAIL_EVENTS) this.tail.shift();
        this.trackPromptState(event);
        this.rebuildCommandIndex(event);
      }
    }
    this.nextSeq = maxSeq + 1;
    if (this.segments.length) {
      const active = join(this.dir, this.segments.at(-1)!);
      this.activeBytes = existsSync(active) ? statSync(active).size : 0;
    }
    this.writeManifest();
  }

  private readManifest(): Manifest | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, MANIFEST), 'utf8')) as Manifest;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.segments)) return parsed;
    } catch { /* recover from segments instead */ }
    return undefined;
  }

  private discoverSegments(): string[] {
    try {
      return readdirSync(this.dir)
        .filter(name => /^events-\d{6}\.jsonl$/.test(name))
        .sort();
    } catch { return []; }
  }

  private readSegment(name: string): ConversationEventV1[] {
    const events: ConversationEventV1[] = [];
    let raw: string;
    try { raw = readFileSync(join(this.dir, name), 'utf8'); }
    catch (error) {
      this.markDegraded(`segment ${name} unreadable: ${(error as Error).message}`);
      return events;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as ConversationEventV1;
        if (event.schemaVersion === 1 && typeof event.seq === 'number') events.push(event);
        else this.markDegraded(`segment ${name} holds a record of an unknown schema`);
      } catch {
        // A torn final line after a crash: everything before it stays readable.
        this.markDegraded(`segment ${name} ends in a torn or corrupt line`);
      }
    }
    return events;
  }

  private rebuildCommandIndex(event: ConversationEventV1): void {
    if (event.kind !== 'prompt.admitted' || !event.commandId || !event.promptId) return;
    const payload = event.payload as {
      text?: { text?: string }; external?: { digest?: string };
      queuedBehind?: number;
    };
    const bodyDigest = payload.text?.text !== undefined
      ? ConversationEventStore.bodyDigest(payload.text.text)
      : payload.external?.digest ?? '';
    this.commands.set(event.commandId, {
      bodyDigest,
      receipt: {
        commandId: event.commandId,
        promptId: event.promptId,
        state: 'queued',
        queuedBehind: payload.queuedBehind ?? 0,
        acceptedAt: event.at,
        eventCursor: String(event.seq),
      },
    });
  }

  private trackPromptState(event: ConversationEventV1): void {
    if (!event.promptId) return;
    switch (event.kind) {
      case 'prompt.admitted': {
        const payload = event.payload as { text?: { text?: string } };
        this.promptStates.set(event.promptId, {
          promptId: event.promptId,
          state: 'admitted',
          sessionGeneration: event.sessionGeneration,
          ...(payload.text?.text !== undefined ? { text: payload.text.text } : {}),
          ...(event.commandId ? { commandId: event.commandId } : {}),
        });
        return;
      }
      case 'prompt.started': {
        const open = this.promptStates.get(event.promptId);
        if (open) open.state = 'started';
        return;
      }
      case 'turn.completed':
        this.promptStates.delete(event.promptId);
        return;
      default:
    }
  }

  // ── segment management ─────────────────────────────────────────────────────

  private segmentFd(incomingBytes: number): number {
    if (this.activeFd !== undefined
        && this.activeBytes + incomingBytes > this.segmentBytes) {
      try { closeSync(this.activeFd); } catch { /* rotating anyway */ }
      this.activeFd = undefined;
    }
    if (this.activeFd === undefined) {
      const needsNew = !this.segments.length
        || this.activeBytes + incomingBytes > this.segmentBytes;
      if (needsNew) {
        const name = `events-${String(this.segments.length + 1).padStart(6, '0')}.jsonl`;
        this.segments.push(name);
        this.activeBytes = 0;
        this.writeManifest();
      }
      const path = join(this.dir, this.segments.at(-1)!);
      this.activeFd = openSync(path, 'a', 0o600);
      if (!this.activeBytes) this.activeBytes = statSync(path).size;
    }
    return this.activeFd;
  }

  private writeManifest(): void {
    const manifest: Manifest = {
      schemaVersion: 1, nextSeq: this.nextSeq, segments: this.segments,
    };
    const tmp = join(this.dir, MANIFEST + '.tmp');
    try {
      writeFileSync(tmp, JSON.stringify(manifest) + '\n', { mode: 0o600 });
      renameSync(tmp, join(this.dir, MANIFEST));
    } catch (error) {
      // The manifest is a recovery accelerator, not the source of truth;
      // segments alone can always rebuild it.
      this.log(`conversation manifest write failed: ${(error as Error).message}`);
    }
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  private firstStoredSeq(): number | undefined {
    if (this.tail.length && this.tail[0].seq === 1) return 1;
    for (const segment of this.segments) {
      const events = this.readSegment(segment);
      if (events.length) return events[0].seq;
    }
    return this.tail[0]?.seq;
  }

  private eventsAfter(after: number, limit: number): ConversationEventV1[] {
    // Serve from the in-memory tail whenever the range allows it.
    if (this.tail.length && after >= this.tail[0].seq - 1)
      return this.tail.filter(event => event.seq > after).slice(0, limit);
    const events: ConversationEventV1[] = [];
    for (const segment of this.segments) {
      for (const event of this.readSegment(segment)) {
        if (event.seq <= after) continue;
        events.push(event);
        if (events.length >= limit) return events;
      }
    }
    return events;
  }

  private markDegraded(reason: string): void {
    if (!this._degraded) this.log(`conversation store degraded: ${reason}`);
    this._degraded = true;
    this.degradedReason = reason;
  }
}

function cursorSeq(cursor: string | undefined): number {
  const value = Number(cursor);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
