import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyEvents, collectHistory, describeTurnState, emptyModel, isAtTail,
} from '../../web/src/conversation-model.js';
import type { ConversationEvent, ConversationPage } from '../../web/src/conversation-model.js';

let seq = 0;
const event = (
  kind: string, payload: Record<string, unknown> = {},
  extra: Partial<ConversationEvent> = {},
): ConversationEvent => ({
  schemaVersion: 1, roleId: 'A', eventId: `e${++seq}`, seq,
  at: new Date(1750000000000 + seq * 1000).toISOString(),
  sessionGeneration: 'gen-1', kind, payload, ...extra,
});

const turnEvents = (promptId: string) => [
  event('prompt.admitted', {
    text: { type: 'text', text: 'question', bytes: 8 }, queuedBehind: 0,
  }, { promptId, commandId: `cmd-${promptId}`, source: 'owner_admin_console' }),
  event('prompt.started', {}, { promptId }),
  event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'ans' } },
    { promptId, messageId: 'm1' }),
  event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'wer' } },
    { promptId, messageId: 'm1' }),
  event('turn.completed', { outcome: 'completed', stopReason: 'end_turn' }, { promptId }),
];

describe('conversation browser model', () => {
  it('groups a turn and merges assistant chunks by messageId', () => {
    const model = applyEvents(emptyModel(), turnEvents('p1'));
    expect(model.turns).toHaveLength(1);
    const turn = model.turns[0];
    expect(turn.user?.text).toBe('question');
    expect(turn.messages).toEqual([{ key: 'm1', text: 'answer' }]);
    expect(turn.state).toBe('completed');
    expect(describeTurnState(turn)).toBe('completed');
  });

  it('is idempotent: replayed events do not duplicate anything', () => {
    const events = turnEvents('p1');
    const model = applyEvents(emptyModel(), [...events, ...events]);
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0].messages).toEqual([{ key: 'm1', text: 'answer' }]);
  });

  it('keeps prompts in durable sequence when replay and live batches overlap', () => {
    const first = event('prompt.admitted', {
      text: { type: 'text', text: 'first', bytes: 5 }, queuedBehind: 0,
    }, { promptId: 'p-first', commandId: 'c-first', source: 'owner_admin_console' });
    const second = event('prompt.admitted', {
      text: { type: 'text', text: 'second', bytes: 6 }, queuedBehind: 0,
    }, { promptId: 'p-second', commandId: 'c-second', source: 'owner_admin_console' });
    const model = applyEvents(emptyModel(), [second]);
    applyEvents(model, [first, second]);
    expect(model.turns.map(turn => turn.user?.text)).toEqual(['first', 'second']);
    expect(model.turns).toHaveLength(2);
  });

  it('starts a new assistant message when the messageId changes', () => {
    const model = applyEvents(emptyModel(), [
      event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'one' } },
        { promptId: 'p', messageId: 'm1' }),
      event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'two' } },
        { promptId: 'p', messageId: 'm2' }),
    ]);
    expect(model.turns[0].messages).toEqual([
      { key: 'm1', text: 'one' }, { key: 'm2', text: 'two' },
    ]);
  });

  it('tracks tool upserts by toolCallId with patch semantics', () => {
    const model = applyEvents(emptyModel(), [
      event('tool.upsert', {
        toolCallId: 't1', snapshot: true, title: 'Run tests',
        kind: 'execute', status: 'in_progress',
      }, { promptId: 'p', toolCallId: 't1' }),
      event('tool.upsert', { toolCallId: 't1', snapshot: false, status: 'completed' },
        { promptId: 'p', toolCallId: 't1' }),
    ]);
    expect(model.turns[0].tools).toEqual([
      { toolCallId: 't1', title: 'Run tests', kind: 'execute', status: 'completed' },
    ]);
  });

  it('retains rich tool disclosure fields across patches', () => {
    const model = applyEvents(emptyModel(), [
      event('tool.upsert', {
        toolCallId: 't1', snapshot: true, title: 'Edit file', kind: 'edit',
        locations: [{ path: '/repo/a.ts', line: 3 }],
        rawInput: { json: { path: 'a.ts' }, bytes: 15 },
        content: [{ type: 'diff', path: '/repo/a.ts',
          oldText: { text: 'old', bytes: 3 }, newText: { text: 'new', bytes: 3 } }],
      }, { promptId: 'p', toolCallId: 't1' }),
      event('tool.upsert', {
        toolCallId: 't1', snapshot: false, status: 'completed',
        rawOutput: { json: { ok: true }, bytes: 11 },
      }, { promptId: 'p', toolCallId: 't1' }),
    ]);
    expect(model.turns[0].tools[0]).toMatchObject({
      status: 'completed', locations: [{ path: '/repo/a.ts', line: 3 }],
      rawInput: { json: { path: 'a.ts' } }, rawOutput: { json: { ok: true } },
      content: [{ type: 'diff', path: '/repo/a.ts' }],
    });
  });

  it('replaces plan snapshots in place and correlates usage to the turn', () => {
    const model = applyEvents(emptyModel(), [
      event('plan.replace', { entries: [{
        content: { text: 'inspect', bytes: 7 }, priority: 'high', status: 'pending',
      }] }, { promptId: 'p' }),
      event('plan.replace', { entries: [{
        content: { text: 'inspect', bytes: 7 }, priority: 'high', status: 'completed',
      }] }, { promptId: 'p' }),
      event('usage.updated', { used: 1200, size: 200000,
        cost: { amount: 0.02, currency: 'USD' } }, { promptId: 'p' }),
    ]);
    expect(model.turns[0].plans).toHaveLength(1);
    expect(model.turns[0].plans[0].entries?.[0].status).toBe('completed');
    expect(model.turns[0].usage).toMatchObject({ used: 1200, size: 200000 });
    expect(model.usage?.cost).toEqual({ amount: 0.02, currency: 'USD' });
  });

  it('renders the full available owner body while keeping dispatch text out of the model', () => {
    const model = applyEvents(emptyModel(), [
      event('prompt.admitted', {
        displayText: { type: 'text', text: '  complete owner body\nsecond line  ', bytes: 35 },
        external: { digest: 'd', bytes: 42 }, queuedBehind: 0,
      },
        { promptId: 'p', source: 'owner_channel' }),
    ]);
    expect(model.turns[0].user?.text).toBe('  complete owner body\nsecond line  ');
    expect(model.turns[0].user?.externalBytes).toBe(42);
  });

  it('settles pending permissions when the turn ends', () => {
    const model = applyEvents(emptyModel(), [
      event('permission.requested', {
        title: 'Run npm test',
        options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
      }, { promptId: 'p', permissionId: 'perm1' }),
      event('turn.completed', { outcome: 'cancelled' }, { promptId: 'p' }),
    ]);
    const card = model.turns[0].permissions[0];
    expect(card.sessionGeneration).toBe('gen-1');
    expect(card.status).toBe('resolved');
    expect(card.decision).toBe('cancelled');
    expect(model.turns[0].state).toBe('cancelled');
  });

  it('reports interrupt and unknown-after-restart states honestly', () => {
    const model = applyEvents(emptyModel(), [
      event('prompt.admitted', { text: { type: 'text', text: 'x', bytes: 1 }, queuedBehind: 0 },
        { promptId: 'p', source: 'browser' }),
      event('prompt.started', {}, { promptId: 'p' }),
      event('prompt.interrupt_requested', { cancellationSource: 'owner' }, { promptId: 'p' }),
    ]);
    expect(describeTurnState(model.turns[0])).toBe('interrupt requested');
    applyEvents(model, [
      event('turn.completed', { outcome: 'unknown_after_restart' }, { promptId: 'p' }),
    ]);
    expect(describeTurnState(model.turns[0])).toMatch(/unknown/);
  });

  it('keeps session-level usage, title and mode outside turns', () => {
    const model = applyEvents(emptyModel(), [
      event('usage.updated', { used: 100, size: 1_000 }),
      event('session.info', { title: 'My session' }),
      event('session.state', { currentModeId: 'plan' }),
    ]);
    expect(model.usage).toMatchObject({ used: 100, size: 1_000 });
    expect(model.sessionTitle).toBe('My session');
    expect(model.currentModeId).toBe('plan');
  });
});

describe('transcript hydration lands on the newest message', () => {
  const page = (from: number, count: number, hasMore: boolean): ConversationPage => ({
    events: Array.from({ length: count }, (_, index) =>
      event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'x' } },
        { promptId: `p${from + index}`, messageId: `m${from + index}` })),
    nextCursor: hasMore ? String(from + count) : undefined,
    hasMore,
  });

  it('returns a paged history as one batch so nothing renders mid-replay', async () => {
    const cursors: Array<string | undefined> = [];
    const pages = [page(0, 500, true), page(500, 500, true), page(1_000, 7, false)];
    const events = await collectHistory(async after => {
      cursors.push(after);
      return pages[cursors.length - 1];
    });
    // One batch for the caller to absorb: three commits would replay the
    // transcript from its oldest page while the reader watches.
    expect(events).toHaveLength(1_007);
    expect(cursors).toEqual([undefined, '500', '1000']);
  });

  it('resumes paging from the last seen cursor and stops when exhausted', async () => {
    const cursors: Array<string | undefined> = [];
    const events = await collectHistory(async after => {
      cursors.push(after);
      return page(42, 3, false);
    }, '41');
    expect(cursors).toEqual(['41']);
    expect(events).toHaveLength(3);
  });

  it('stops on a cursor that does not advance instead of paging forever', async () => {
    let calls = 0;
    const events = await collectHistory(async () => {
      calls += 1;
      return { ...page(0, 1, true), nextCursor: 'stuck' };
    }, 'stuck');
    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('follows only while the reader is parked at the tail', () => {
    expect(isAtTail({ scrollTop: 940, clientHeight: 400, scrollHeight: 1_340 })).toBe(true);
    expect(isAtTail({ scrollTop: 910, clientHeight: 400, scrollHeight: 1_340 })).toBe(true);
    expect(isAtTail({ scrollTop: 0, clientHeight: 400, scrollHeight: 1_340 })).toBe(false);
    expect(isAtTail({ scrollTop: 400, clientHeight: 400, scrollHeight: 1_340 })).toBe(false);
  });

  it('positions the transcript before paint, never after', () => {
    // jsdom is not installed, so the component cannot be rendered here. A
    // post-paint useEffect is exactly what made the console show the oldest
    // message first and then scroll down, so pin it at the source.
    const source = readFileSync(resolve('web/src/ConversationView.tsx'), 'utf8');
    const positioning = source.slice(source.indexOf('scrollRef.current?.scrollTo') - 400,
      source.indexOf('scrollRef.current?.scrollTo'));
    expect(positioning).toContain('useLayoutEffect');
    expect(positioning).not.toContain('useEffect(');
  });
});
