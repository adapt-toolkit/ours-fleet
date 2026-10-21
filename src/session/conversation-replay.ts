import { open } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { ConversationEventV1 } from './conversation-types.js';

export const MAX_REPLAY_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_CONVERSATION_RECORD_BYTES = 16 * 1024 * 1024;
export interface ConversationReplayRequest {
  expectedGeneration: string;
  after: number;
  through: number;
  pageSize?: number;
  signal?: AbortSignal;
}
export interface ConversationReplayPage {
  events: ConversationEventV1[];
  /** Storage coverage, including invisible events; never a visible-event cursor. */
  coveredThrough: number;
}
export class ReplayCoverageError extends Error {
  constructor(detail: string) { super(`replay coverage unavailable: ${detail}`); }
}

/** Bounded reads and explicit scheduling even when a whole segment is cached by the OS. */
export async function* replayLines(path: string, signal?: AbortSignal): AsyncGenerator<string> {
  const file = await open(path, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        if (i - start > MAX_CONVERSATION_RECORD_BYTES) throw new ReplayCoverageError('record exceeds assembly limit');
        yield data.toString('utf8', start, i);
        start = i + 1;
      }
      pending = Buffer.from(data.subarray(start));
      if (pending.length > MAX_CONVERSATION_RECORD_BYTES) throw new ReplayCoverageError('record exceeds assembly limit');
      await yieldTurn();
    }
    if (pending.length) throw new ReplayCoverageError('unterminated record');
  } finally { await file.close(); }
}

import type { ConversationObservation, ConversationObservationState } from './conversation-types.js';

export interface PassiveConversationFollowRequest {
  expectedGeneration: string;
  after?: number;
  controller: false;
  signal?: AbortSignal;
}
export interface ConversationReplayReady {
  snapshot: ConversationObservationState;
  coveredThrough: number;
}
interface ReplayOwner {
  observeConversation?(listener: (state: ConversationObservationState) => void): ConversationObservation;
  subscribeConversationFailure?(listener: (generation: string) => void): () => void;
  subscribeConversation?(listener: (event: ConversationEventV1) => void): () => void;
  replayConversation?(request: ConversationReplayRequest): AsyncIterable<ConversationReplayPage>;
}
export interface ConversationReplaySink {
  replay(page: ConversationReplayPage): void | Promise<void>;
  ready(ready: ConversationReplayReady): void | Promise<void>;
  event(event: ConversationEventV1): void | Promise<void>;
  state(state: ConversationObservationState): void | Promise<void>;
  close(reason?: string): void;
}

/** Passive owner-turn registration, complete replay, ready, then buffered post-barrier delivery. */
export function startConversationReplay(owner: ReplayOwner, request: PassiveConversationFollowRequest, sink: ConversationReplaySink) {
  if (request.controller !== false || !owner.observeConversation || !owner.subscribeConversation || !owner.subscribeConversationFailure || !owner.replayConversation)
    throw new ReplayCoverageError('passive observation is unavailable');
  const after = request.after ?? 0;
  if (!request.expectedGeneration || !Number.isSafeInteger(after) || after < 0)
    throw new ReplayCoverageError('invalid cursor or generation');
  const abort = new AbortController();
  const disposers: Array<() => void> = [];
  type Pending = { event: ConversationEventV1; state?: never } | { state: ConversationObservationState; event?: never };
  const pending: Array<{ value: Pending; bytes: number }> = [];
  let pendingBytes = 0; let closed = false; let committed = false; let draining = false;
  let snapshot!: ConversationObservationState;
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Consumers can attach later without an unhandled rejection during synchronous registration.
  void ready.catch(() => {});
  const close = (reason?: string) => {
    if (closed) return;
    closed = true; abort.abort(new Error(reason ?? 'conversation follow closed'));
    for (const dispose of disposers.splice(0)) dispose();
    pending.length = 0; pendingBytes = 0;
    rejectReady(new Error(reason ?? 'conversation follow closed'));
    sink.close(reason);
  };
  const own = (dispose: () => void) => { if (closed) dispose(); else disposers.push(dispose); };
  const drain = async () => {
    if (!committed || draining || closed) return;
    draining = true;
    try {
      while (pending.length && !closed) {
        const next = pending[0];
        if (next.value.event) {
          if (next.value.event.seq > snapshot.ledgerBarrier) await sink.event(next.value.event);
        } else if (next.value.state.stateRevision > snapshot.stateRevision) await sink.state(next.value.state);
        if (!closed) { pending.shift(); pendingBytes -= next.bytes; }
      }
    } catch (error) { close((error as Error).message); }
    finally { draining = false; }
  };
  const enqueue = (value: Pending) => {
    if (closed) return;
    if (value.state?.observationFailure) { close('conversation observation failed'); return; }
    if ((value.event ?? value.state).sessionGeneration !== request.expectedGeneration) {
      close('session generation changed'); return;
    }
    const recordBytes = Buffer.byteLength(JSON.stringify(value.event ?? value.state));
    const bytes = recordBytes + 10; // {"event":...} or {"state":...} queued envelope
    if (recordBytes > MAX_CONVERSATION_RECORD_BYTES) { close('conversation record exceeds assembly limit'); return; }
    // One active record goes straight to the progressive writer. Only waiting
    // records count against the 8 MiB queue; the active assembly is bounded separately.
    if (committed && !draining && pending.length === 0) {
      draining = true;
      void (async () => {
        try {
          if (value.event) { if (value.event.seq > snapshot.ledgerBarrier) await sink.event(value.event); }
          else if (value.state.stateRevision > snapshot.stateRevision) await sink.state(value.state);
        } catch (error) { close((error as Error).message); }
        finally { draining = false; void drain(); }
      })();
      return;
    }
    if (pendingBytes + bytes > MAX_REPLAY_BUFFER_BYTES) { close('conversation live replay buffer exceeded'); return; }
    pending.push({ value, bytes }); pendingBytes += bytes;
    void drain();
  };
  try {
    // No await between registration and the owner's coherent snapshot/barrier capture.
    own(owner.subscribeConversation(event => enqueue({ event })));
    own(owner.subscribeConversationFailure(generation => {
      if (generation === request.expectedGeneration) close('conversation generation has non-durable events');
    }));
    const observation = owner.observeConversation(state => enqueue({ state }));
    own(observation.unsubscribe);
    snapshot = observation.snapshot;
    if (snapshot.observationFailure) throw new ReplayCoverageError('conversation observation failed');
    if (snapshot.sessionGeneration !== request.expectedGeneration) throw new ReplayCoverageError('session generation changed');
    if (after > snapshot.ledgerBarrier) throw new ReplayCoverageError('cursor exceeds barrier');
    if (request.signal) {
      const onAbort = () => close('conversation follow aborted');
      request.signal.addEventListener('abort', onAbort, { once: true });
      own(() => request.signal!.removeEventListener('abort', onAbort));
      if (request.signal.aborted) onAbort();
    }
  } catch (error) { close((error as Error).message); }
  if (!closed) void (async () => {
    try {
      let coveredThrough = after;
      for await (const page of owner.replayConversation!({expectedGeneration:request.expectedGeneration,after,through:snapshot.ledgerBarrier,signal:abort.signal})) {
        abort.signal.throwIfAborted();
        if (page.coveredThrough <= coveredThrough || page.coveredThrough > snapshot.ledgerBarrier)
          throw new ReplayCoverageError('non-progressing page');
        await sink.replay(page);
        coveredThrough = page.coveredThrough;
      }
      abort.signal.throwIfAborted();
      if (coveredThrough !== snapshot.ledgerBarrier) throw new ReplayCoverageError('incomplete replay');
      await sink.ready({ snapshot, coveredThrough });
      abort.signal.throwIfAborted();
      committed = true; resolveReady();
      await drain();
    } catch (error) { close((error as Error).message); }
  })();
  return { ready, close: () => close() };
}
