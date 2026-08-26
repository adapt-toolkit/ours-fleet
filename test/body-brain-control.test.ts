import { describe, expect, it, vi } from 'vitest';
import {
  dispatchBodyBrain, followBodyBrain,
} from '../src/session/body-brain-control.js';
import type {
  BodyBrainAdmissionResult, BodyBrainCompletionResult, BodyBrainEvent, BodyBrainGenerationRequest,
  BodyBrainMutationResult, BodyBrainPageRequest, BodyBrainPageResult, BodyBrainPermissionResponse,
  BodyBrainPermissionResult, BodyBrainPromptRequest, BodyBrainRecoveryRecord, BodyBrainSession,
  BodyBrainSnapshot,
} from '../src/session/body-brain.js';

class ScriptedSession implements BodyBrainSession {
  readonly sessionRef = 'session-control';
  readonly generation = 'generation-A';
  readonly events: BodyBrainEvent[] = [];
  readonly listeners = new Set<(event: BodyBrainEvent) => void>();
  snapshotHook?: () => void;
  pageHook?: () => void;
  pageGeneration = this.generation;
  snapshotGeneration = this.generation;
  unsubscribes = 0;

  snapshot(): Readonly<BodyBrainSnapshot> {
    this.snapshotHook?.();
    return Object.freeze({ protocolVersion: 1, sessionRef: this.sessionRef,
      generation: this.snapshotGeneration, state: 'running', cursor: `bb:${this.events.length}`,
      activePermissionIds: Object.freeze([]) });
  }
  page(request: BodyBrainPageRequest = {}): BodyBrainPageResult {
    this.pageHook?.();
    const after = Number((request.after ?? 'bb:0').slice(3));
    if (!Number.isSafeInteger(after) || after < 0 || after > this.events.length)
      return { state: 'invalid_cursor', generation: this.pageGeneration };
    const limit = request.limit ?? 256;
    const events = this.events.filter(event => event.seq > after).slice(0, limit);
    return { state: 'ok', generation: this.pageGeneration, events,
      nextCursor: `bb:${events.at(-1)?.seq ?? after}`,
      hasMore: this.events.length > (events.at(-1)?.seq ?? after) };
  }
  subscribe(listener: (event: BodyBrainEvent) => void): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false; this.unsubscribes++; this.listeners.delete(listener);
    };
  }
  emit(): BodyBrainEvent {
    const seq = this.events.length + 1;
    const event = Object.freeze({ schemaVersion: 1 as const, eventId: `event-${seq}`, seq,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), generation: this.generation,
      kind: 'cancel_requested' as const, commandId: `command-${seq}` });
    this.events.push(event);
    this.notify(event);
    return event;
  }
  notify(event: BodyBrainEvent): void { for (const listener of [...this.listeners]) listener(event); }
  admitPrompt(_request: BodyBrainPromptRequest): BodyBrainAdmissionResult { return { state: 'invalid_request' }; }
  awaitCompletion(_generation: string, _promptId: string): BodyBrainCompletionResult | { state: 'stale_generation' } {
    return { state: 'unknown_prompt' };
  }
  respondPermission(_request: BodyBrainPermissionResponse): BodyBrainPermissionResult {
    return { state: 'unknown_permission' };
  }
  requestCancel(_request: BodyBrainGenerationRequest): BodyBrainMutationResult { return { state: 'accepted' }; }
  forceTerminate(_request: BodyBrainGenerationRequest): BodyBrainMutationResult { return { state: 'terminated' }; }
  close(_request: BodyBrainGenerationRequest): BodyBrainMutationResult { return { state: 'closed' }; }
  retire(_request: BodyBrainGenerationRequest): BodyBrainMutationResult { return { state: 'retired' }; }
  recoveryRecord(): Readonly<BodyBrainRecoveryRecord> { throw new Error('not used'); }
}

describe('BodyBrain control seam', () => {
  it('dispatches the exhaustive closed union without changing semantic result objects', () => {
    const sentinel = Object.freeze({ state: 'accepted' as const });
    const session = new ScriptedSession();
    session.requestCancel = vi.fn(() => sentinel);
    const request = { generation: 'generation-A', commandId: 'cancel' };
    expect(dispatchBodyBrain(session, { kind: 'cancel', request })).toBe(sentinel);
    expect(dispatchBodyBrain(session, { kind: 'snapshot' })).toBeInstanceOf(Object);
    expect(dispatchBodyBrain(session, { kind: 'page', request: { after: 'bb:0' } })).toMatchObject({ state: 'ok' });
    expect(dispatchBodyBrain(session, { kind: 'admit', request: {} })).toEqual({ state: 'invalid_request' });
    expect(dispatchBodyBrain(session, { kind: 'completion', generation: 'generation-A', promptId: 'missing' }))
      .toEqual({ state: 'unknown_prompt' });
    expect(dispatchBodyBrain(session, { kind: 'permission', request: {} })).toEqual({ state: 'unknown_permission' });
    expect(dispatchBodyBrain(session, { kind: 'force', request })).toEqual({ state: 'terminated' });
    expect(dispatchBodyBrain(session, { kind: 'close', request })).toEqual({ state: 'closed' });
    expect(dispatchBodyBrain(session, { kind: 'retire', request })).toEqual({ state: 'retired' });
    for (const malformed of [null, { kind: 'unknown' }, { kind: 'snapshot', extra: true },
      Object.assign(Object.create({ kind: 'snapshot' }), {})])
      expect(dispatchBodyBrain(session, malformed)).toEqual({ state: 'invalid_request' });
    session.requestCancel = vi.fn(() => { throw new Error('dependency failure'); });
    expect(() => dispatchBodyBrain(session, { kind: 'cancel', request })).toThrow('dependency failure');
  });

  it('uses a fixed replay watermark and merges snapshot/page-boundary overlap in strict order', () => {
    const session = new ScriptedSession();
    session.emit(); session.emit();
    session.snapshotHook = () => { session.snapshotHook = undefined; session.emit(); };
    let pageCalls = 0;
    session.pageHook = () => { if (pageCalls++ < 2) session.emit(); };
    const seen: number[] = [];
    const handle = followBodyBrain(session, { pageSize: 1, onEvent: event => seen.push(event.seq), onClose: vi.fn() });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(handle.cursor).toBe('bb:5');
    session.emit();
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('isolates event and terminal callback failures while advancing and closing once', () => {
    const session = new ScriptedSession(); session.emit();
    const onEvent = vi.fn(() => { throw new Error('render failure'); });
    const onClose = vi.fn(() => { throw new Error('close failure'); });
    const handle = followBodyBrain(session, { onEvent, onClose });
    expect(handle.cursor).toBe('bb:1');
    session.emit();
    expect(handle.cursor).toBe('bb:2');
    expect(() => handle.close()).not.toThrow();
    handle.close(); session.emit();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(session.unsubscribes).toBe(1);
  });

  it.each([
    ['invalid_cursor', { after: 'bad' }],
    ['invalid_cursor', { after: 'bb:9' }],
    ['invalid_cursor', { pageSize: 0 }],
    ['invalid_cursor', { bufferLimit: 0 }],
  ] as const)('closes with %s for invalid follow input', (reason, fields) => {
    const session = new ScriptedSession();
    const terminals: unknown[] = [];
    const handle = followBodyBrain(session, { ...fields, onEvent: vi.fn(), onClose: value => terminals.push(value) });
    expect(terminals).toEqual([{ state: 'closed', reason, generation: 'generation-A', cursor: 'bb:0' }]);
    expect(handle.closed).toBe(true);
    expect(session.unsubscribes).toBe(1);
    const retry = followBodyBrain(session, { after: 'bb:0', onEvent: vi.fn(), onClose: vi.fn() });
    expect(retry.closed).toBe(false);
    retry.close();
  });

  it('fails closed on page generation changes and unsubscribes before notification', () => {
    const session = new ScriptedSession(); session.emit(); session.pageGeneration = 'generation-B';
    const observedSubscriptions: number[] = [];
    const handle = followBodyBrain(session, { onEvent: vi.fn(),
      onClose: () => observedSubscriptions.push(session.listeners.size) });
    expect(handle.closed).toBe(true);
    expect(observedSubscriptions).toEqual([0]);
  });

  it.each(['snapshot', 'page'] as const)('fails closed on %s generation mismatch', boundary => {
    const session = new ScriptedSession(); session.emit();
    if (boundary === 'snapshot') session.snapshotGeneration = 'generation-B';
    else session.pageGeneration = 'generation-B';
    const terminals: string[] = [];
    const handle = followBodyBrain(session, { onEvent: vi.fn(), onClose: value => terminals.push(value.reason) });
    expect(handle.closed).toBe(true);
    expect(terminals).toEqual(['generation_changed']);
    expect(session.unsubscribes).toBe(1);
  });

  it('fails closed on an invalid page and a replay gap', () => {
    const invalid = new ScriptedSession(); invalid.emit();
    invalid.page = () => ({ state: 'invalid_cursor', generation: invalid.generation });
    const invalidReasons: string[] = [];
    followBodyBrain(invalid, { onEvent: vi.fn(), onClose: value => invalidReasons.push(value.reason) });
    expect(invalidReasons).toEqual(['invalid_cursor']);

    const gap = new ScriptedSession();
    const event = { ...gap.emit(), seq: 2, eventId: 'event-2' };
    gap.events.splice(0, 1, event);
    gap.snapshot = () => ({ protocolVersion: 1, sessionRef: gap.sessionRef, generation: gap.generation,
      state: 'running', cursor: 'bb:2', activePermissionIds: [] });
    const gapReasons: string[] = [];
    followBodyBrain(gap, { onEvent: vi.fn(), onClose: value => gapReasons.push(value.reason) });
    expect(gapReasons).toEqual(['discontinuity']);
  });

  it('defers synchronous subscription failure until it can unsubscribe before terminal notification', () => {
    const session = new ScriptedSession(); const order: string[] = [];
    session.subscribe = listener => {
      listener({ schemaVersion: 1, eventId: 'foreign', seq: 1, at: '2026-01-01T00:00:01.000Z',
        generation: 'generation-B', kind: 'closed' });
      return () => order.push('unsubscribe');
    };
    followBodyBrain(session, { onEvent: vi.fn(), onClose: () => order.push('close') });
    expect(order).toEqual(['unsubscribe', 'close']);
  });

  it('propagates follow dependency exceptions after unsubscribing without semantic coercion', () => {
    for (const boundary of ['snapshot', 'page'] as const) {
      const session = new ScriptedSession();
      if (boundary === 'snapshot') session.snapshot = () => { throw new Error('snapshot dependency'); };
      else { session.emit(); session.page = () => { throw new Error('page dependency'); }; }
      const onClose = vi.fn();
      expect(() => followBodyBrain(session, { onEvent: vi.fn(), onClose }))
        .toThrow(`${boundary} dependency`);
      expect(session.unsubscribes).toBe(1);
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it('fails closed on live generation changes and gaps without later delivery', () => {
    for (const bad of [
      { schemaVersion: 1 as const, eventId: 'foreign', seq: 1, at: '2026-01-01T00:00:01.000Z',
        generation: 'generation-B', kind: 'closed' as const },
      { schemaVersion: 1 as const, eventId: 'gap', seq: 2, at: '2026-01-01T00:00:02.000Z',
        generation: 'generation-A', kind: 'closed' as const },
    ]) {
      const session = new ScriptedSession(); const reasons: string[] = []; const seen: number[] = [];
      const handle = followBodyBrain(session, { onEvent: event => seen.push(event.seq),
        onClose: terminal => reasons.push(terminal.reason) });
      session.notify(bad);
      session.emit();
      expect(handle.closed).toBe(true);
      expect(reasons).toEqual([bad.generation === 'generation-B' ? 'generation_changed' : 'discontinuity']);
      expect(seen).toEqual([]);
      expect(session.listeners.size).toBe(0);
    }
  });

  it('counts replay duplicates toward buffer overflow and does not deliver after terminal', () => {
    const session = new ScriptedSession(); const first = session.emit();
    session.snapshotHook = () => { session.notify(first); session.notify(first); };
    const seen: number[] = []; const terminals: string[] = [];
    const handle = followBodyBrain(session, { bufferLimit: 1, onEvent: event => seen.push(event.seq),
      onClose: terminal => terminals.push(terminal.reason) });
    expect(handle.closed).toBe(true);
    expect(terminals).toEqual(['buffer_overflow']);
    expect(seen).toEqual([]);
    session.emit(); expect(seen).toEqual([]);
  });

  it('rejects conflicting overlap rather than guessing', () => {
    const session = new ScriptedSession(); const first = session.emit();
    session.snapshotHook = () => session.notify({ ...first, eventId: 'conflict' });
    const terminals: string[] = [];
    const handle = followBodyBrain(session, { onEvent: vi.fn(), onClose: terminal => terminals.push(terminal.reason) });
    expect(handle.closed).toBe(true);
    expect(terminals).toEqual(['discontinuity']);
  });

  it('promotes a valid nonzero cursor only after verification and ignores unknown pre-prefix overlap', () => {
    const session = new ScriptedSession();
    const first = session.emit(); const second = session.emit(); session.emit();
    session.snapshotHook = () => {
      session.notify({ ...first, eventId: 'unknown-pre-prefix-identity' });
      session.notify({ ...second, eventId: 'also-unknown-pre-prefix' });
    };
    const seen: number[] = []; const terminals: unknown[] = [];
    const handle = followBodyBrain(session, { after: 'bb:2', onEvent: event => seen.push(event.seq),
      onClose: terminal => terminals.push(terminal) });
    expect(seen).toEqual([3]);
    expect(handle.cursor).toBe('bb:3');
    expect(terminals).toEqual([]);
    handle.close();
    expect(terminals).toMatchObject([{ reason: 'caller_closed', cursor: 'bb:3' }]);
  });
});
