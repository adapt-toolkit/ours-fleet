import { describe, expect, it } from 'vitest';

import {
  CompactionTracker, interceptCompactionStream, parseCompactionNotification,
  type CompactionNotification,
} from '../src/session/acp-compaction.js';

const notification = (overrides: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 's1', update: { sessionUpdate: 'compaction_update',
      compactionId: 'c1', status: 'in_progress', ...overrides },
  },
});
const update = (status: CompactionNotification['status'], compactionId = 'c1', sessionId = 's1') =>
  ({ sessionId, compactionId, status });
const live = { sessionId: 's1', mode: 'live' as const };
const replay = { sessionId: 's1', mode: 'replay' as const };

describe('compaction compatibility parsing', () => {
  it('extracts only body-free lifecycle fields from the exact notification variant', () => {
    expect(parseCompactionNotification(notification({ summary: 'SECRET-SUMMARY',
      content: [{ text: 'SECRET-CONTENT' }], _meta: { token: 'SECRET-TOKEN' } }))).toEqual({
      kind: 'update', update: update('in_progress'),
    });
  });

  it('consumes negotiated summary chunks without inspecting or retaining hidden content', async () => {
    const summary = notification({ sessionUpdate: 'compaction_summary_chunk', content: { type: 'text', text: 'SECRET-SUMMARY' } });
    expect(parseCompactionNotification(summary)).toEqual({ kind: 'summary' });
    const response = { jsonrpc: '2.0', id: 1, result: {} };
    const stream = interceptCompactionStream({ writable: new WritableStream<unknown>(),
      readable: new ReadableStream<unknown>({ start(controller) {
        controller.enqueue(summary); controller.enqueue(response); controller.close();
      } }),
    }, () => { throw new Error('summary is not lifecycle'); }, () => { throw new Error('valid summary'); });
    const reader = stream.readable.getReader();
    expect((await reader.read()).value).toBe(response);
    expect((await reader.read()).done).toBe(true);
  });

  it.each([
    { type: 'text', text: 'private' }, { type: 'image', data: 'private', mimeType: 'image/png' },
    { type: 'audio', data: 'private', mimeType: 'audio/wav' },
    { type: 'resource_link', name: 'private', uri: 'private://resource' },
    { type: 'resource', resource: { uri: 'private://resource', text: 'private' } },
    { type: 'resource', resource: { uri: 'private://resource', blob: 'private' } },
  ])('accepts and discards required ContentBlock fields for summary %j', content => {
    expect(parseCompactionNotification(notification({ sessionUpdate: 'compaction_summary_chunk', content })))
      .toEqual({ kind: 'summary' });
  });

  it.each([undefined, { type: 'text' }, { type: 'image', data: 'private' },
    { type: 'audio', mimeType: 'audio/wav' }, { type: 'resource_link', uri: 'private' },
    { type: 'resource', resource: { uri: 'private' } }, { type: 'future-content' }])
  ('rejects malformed summaries body-free: %j', content => {
    expect(parseCompactionNotification(notification({ sessionUpdate: 'compaction_summary_chunk', content })))
      .toEqual({ kind: 'invalid' });
  });

  it('rejects summary chunks without a bounded compaction ID', () => {
    expect(parseCompactionNotification(notification({ sessionUpdate: 'compaction_summary_chunk',
      compactionId: '', content: { type: 'text', text: 'private' } }))).toEqual({ kind: 'invalid' });
  });

  it('normalizes unknown statuses while retaining bounded opaque wire metadata', () => {
    expect(parseCompactionNotification(notification({ status: 'SECRET-FUTURE-STATUS' })))
      .toEqual({ kind: 'update', update: { ...update('unknown'), wireStatus: 'SECRET-FUTURE-STATUS' } });
  });

  it.each([
    { compactionId: '' }, { compactionId: 'a'.repeat(257) }, { compactionId: 'a\n' },
    { status: null }, { status: '' }, { status: 'a'.repeat(65) }, { status: 'a\n' },
  ])('rejects malformed lifecycle fields without retaining their values: %j', overrides => {
    expect(parseCompactionNotification(notification(overrides))).toEqual({ kind: 'invalid' });
  });

  it('validates session identity and notification envelope', () => {
    const frame = notification();
    expect(parseCompactionNotification({ ...frame, jsonrpc: '1.0' })).toEqual({ kind: 'invalid' });
    expect(parseCompactionNotification({ ...frame, params: { ...frame.params, sessionId: '' } }))
      .toEqual({ kind: 'invalid' });
  });

  it('leaves requests, batches, responses, and unrelated notifications to the SDK', () => {
    for (const frame of [
      { ...notification(), id: 7 }, { ...notification(), id: null }, [notification()],
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'private' } },
      { ...notification(), method: 'other/update' },
      notification({ sessionUpdate: 'agent_message_chunk' }), null,
    ]) expect(parseCompactionNotification(frame)).toEqual({ kind: 'pass' });
  });

  it('handles lifecycle synchronously before forwarding the following prompt response', async () => {
    const order: string[] = [];
    const response = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } };
    const request = { ...notification(), id: 3 };
    const output: unknown[] = [];
    const writable = new WritableStream<unknown>({ write: value => { output.push(value); } });
    const stream = interceptCompactionStream({
      writable, readable: new ReadableStream<unknown>({ start(controller) {
        controller.enqueue(notification());
        controller.enqueue(notification({ compactionId: '' }));
        controller.enqueue(response);
        controller.enqueue(request);
        controller.close();
      } }),
    }, event => { order.push(event.status); }, () => { order.push('invalid'); });
    const reader = stream.readable.getReader();
    expect((await reader.read()).value).toBe(response);
    order.push('response');
    expect((await reader.read()).value).toBe(request);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(order).toEqual(['in_progress', 'invalid', 'response']);
    expect(stream.writable).toBe(writable);
    const writer = stream.writable.getWriter();
    await writer.write(request);
    expect(output).toEqual([request]);
    await writer.close();
  });
});

describe('compaction lifecycle tracking', () => {
  it('matches exact sessions and keeps distinct IDs independently active', () => {
    const tracker = new CompactionTracker();
    expect(tracker.observe(update('in_progress', 'c1', 'other'), live).ignored).toBe(true);
    tracker.observe(update('in_progress'), live);
    tracker.observe(update('in_progress', 'c2'), live);
    tracker.observe(update('completed'), live);
    expect(tracker.activeIds()).toEqual(['c2']);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('first %s is terminal and cannot be reopened', status => {
    const tracker = new CompactionTracker();
    const terminal = tracker.observe(update(status), live);
    expect(terminal.event).toEqual({ ...update(status), replayed: false });
    expect(tracker.observe(update(status), live).event).toBeUndefined();
    expect(tracker.observe(update('in_progress'), live).event).toBeUndefined();
    expect(tracker.observe(update('unknown'), live).event).toBeUndefined();
    expect(tracker.observe(update(status === 'completed' ? 'failed' : 'completed'), live).event).toBeUndefined();
    expect(tracker.activeIds()).toEqual([]);
  });

  it('deduplicates starts and treats unknown live status as active uncertainty', () => {
    const tracker = new CompactionTracker();
    tracker.observe(update('in_progress'), live);
    expect(tracker.observe(update('in_progress'), live).event).toBeUndefined();
    tracker.observe(update('unknown'), live);
    tracker.observe(update('unknown', 'c2'), live);
    expect(tracker.activeIds()).toEqual(['c1', 'c2']);
    tracker.observe(update('cancelled'), live);
    expect(tracker.activeIds()).toEqual(['c2']);
  });

  it('preserves bounded opaque future status distinctions while keeping both active', () => {
    const tracker = new CompactionTracker();
    tracker.observe({ ...update('unknown'), wireStatus: 'future_a' }, live);
    expect(tracker.observe({ ...update('unknown'), wireStatus: 'future_b' }, live).event?.wireStatus)
      .toBe('future_b');
    expect(tracker.activeIds()).toEqual(['c1']);
  });

  it('rebuilds replay history without activating or reopening terminal history', () => {
    const tracker = new CompactionTracker();
    expect(tracker.observe(update('in_progress'), replay).event?.replayed).toBe(true);
    tracker.observe(update('completed'), replay);
    expect(tracker.observe(update('in_progress'), replay).event).toBeUndefined();
    expect(tracker.observe(update('in_progress'), live).event).toBeUndefined();
    expect(tracker.activeIds()).toEqual([]);
  });

  it('does not let replay terminal traffic clear or overwrite live occupancy', () => {
    const tracker = new CompactionTracker();
    tracker.observe(update('in_progress'), live);
    expect(tracker.observe(update('completed'), replay).event).toBeUndefined();
    expect(tracker.activeIds()).toEqual(['c1']);
    expect(tracker.observe(update('completed'), live).event?.replayed).toBe(false);
    expect(tracker.activeIds()).toEqual([]);
  });

  it('promotes a replayed nonterminal entity when genuine live work arrives', () => {
    const tracker = new CompactionTracker();
    tracker.observe(update('in_progress'), replay);
    expect(tracker.observe(update('in_progress'), live).event?.replayed).toBe(false);
    expect(tracker.activeIds()).toEqual(['c1']);
  });

  it('ends missing live terminals as unknown_ended once, never as completed', () => {
    const tracker = new CompactionTracker();
    tracker.observe(update('in_progress'), live);
    tracker.observe(update('unknown', 'c2'), live);
    tracker.observe(update('in_progress', 'history'), replay);
    expect(tracker.endTurn()).toEqual([
      { ...update('in_progress'), status: 'unknown_ended', replayed: false },
      { ...update('unknown', 'c2'), status: 'unknown_ended', replayed: false },
    ]);
    expect(tracker.activeIds()).toEqual([]);
    expect(tracker.endTurn()).toEqual([]);
    expect(tracker.observe(update('completed'), live).event?.status).toBe('completed');
    expect(tracker.activeIds()).toEqual([]);
  });

  it('allows authoritative replay terminal to refine local unknown_ended without reopening it', () => {
    const tracker = new CompactionTracker();
    tracker.observe(update('in_progress'), live);
    tracker.endTurn();
    expect(tracker.observe(update('in_progress'), replay).event).toBeUndefined();
    expect(tracker.observe(update('completed'), replay).event?.status).toBe('completed');
    expect(tracker.activeIds()).toEqual([]);
  });

  it('ends replay uncertainty historically without clearing live state or permitting a reopen', () => {
    const tracker = new CompactionTracker();
    tracker.observe(update('in_progress'), replay);
    tracker.observe(update('in_progress', 'live'), live);
    expect(tracker.endReplay('s1')).toEqual([{ ...update('in_progress'), status: 'unknown_ended', replayed: true }]);
    expect(tracker.activeIds()).toEqual(['live']);
    expect(tracker.observe(update('in_progress'), live).event).toBeUndefined();
  });

  it('fails closed on bounded state exhaustion without evicting active IDs', () => {
    const tracker = new CompactionTracker({ maxEntries: 2 });
    tracker.observe(update('in_progress'), live);
    tracker.observe(update('completed', 'terminal'), replay);
    const overflow = tracker.observe(update('in_progress', 'overflow'), live);
    expect(overflow).toEqual({ ignored: false, recoveryRequired: true });
    expect(tracker.recoveryRequired).toBe(true);
    expect(tracker.activeIds()).toEqual(['c1']);
    expect(tracker.observe(update('in_progress', 'other'), live).recoveryRequired).toBe(true);
  });

  it('rejects invalid capacity settings', () => {
    for (const maxEntries of [0, -1, 1.5, NaN, Infinity])
      expect(() => new CompactionTracker({ maxEntries })).toThrow();
  });
});
