import { describe, expect, it } from 'vitest';

import {
  addOptimisticPrompt, applyEvents, describeTurnState, emptyModel,
} from '../../web/src/conversation-model.js';
import type { ConversationEvent } from '../../web/src/conversation-model.js';

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
  }, { promptId, commandId: `cmd-${promptId}`, source: 'browser' }),
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

  it('reconciles an optimistic prompt with its durable admission', () => {
    const model = addOptimisticPrompt(emptyModel(), 'cmd-p1', 'question');
    expect(model.turns[0].optimistic).toBe(true);
    applyEvents(model, turnEvents('p1'));
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0].optimistic).toBeUndefined();
    expect(model.turns[0].promptId).toBe('p1');
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

  it('marks external prompts without leaking a body', () => {
    const model = applyEvents(emptyModel(), [
      event('prompt.admitted', { external: { digest: 'd', bytes: 42 }, queuedBehind: 0 },
        { promptId: 'p', source: 'owner_channel' }),
    ]);
    expect(model.turns[0].user?.text).toBeUndefined();
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
