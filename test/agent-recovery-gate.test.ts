import { describe, expect, it } from 'vitest';

import { evaluateAgentRecovery, recoverAgentIdentity } from '../src/agent-recovery-gate.js';
import type { AgentSession } from '../src/session/types.js';
import type {
  ConversationEventKind, ConversationEventV1, ConversationPayload,
} from '../src/session/conversation-types.js';

let seq = 0;
const event = (
  kind: ConversationEventKind, payload: ConversationPayload,
  over: Partial<ConversationEventV1> = {},
): ConversationEventV1 => ({
  schemaVersion: 1, roleId: 'Role', eventId: `e${++seq}`, seq,
  at: '2026-08-30T00:00:00Z', sessionGeneration: 'session-a', kind, payload, ...over,
});
const tool = (
  promptId: string, id: string, title: string, rawInput: unknown,
  status = 'completed', over: Partial<ConversationEventV1> = {},
) => event('tool.upsert', {
  toolCallId: id, snapshot: true, title, status,
  rawInput: { json: rawInput, bytes: 2 },
}, { promptId, toolCallId: id, ...over });
const validTurn = (promptId = 'recovery', identity = 'Role') => [
  event('prompt.admitted', { text: { type: 'text', text: 'recovery', bytes: 8 }, queuedBehind: 0 }, { promptId }),
  tool(promptId, 'choose', 'mcp__ours__choose_identity', { name: identity, force: false }),
  tool(promptId, 'current', 'ours.current_identity', {}),
  tool(promptId, 'messages', 'get_messages', { limit: 200 }),
  event('turn.completed', { outcome: 'completed' }, { promptId }),
];

describe('exact recovery-turn evidence', () => {
  it('accepts only the exact admitted/completed turn and narrow ours aliases', () => {
    seq = 0;
    expect(evaluateAgentRecovery(validTurn(), 'recovery', 'Role')).toEqual({
      ok: true, reason: 'RECOVERY_TOOLS_VERIFIED', chooseIdentity: true,
      currentIdentity: true, getMessages: true, turnCompleted: true,
    });
  });

  it('ignores identical tools before admission, after terminal, and in an overlapping ordinary turn', () => {
    seq = 0;
    const before = [
      tool('recovery', 'before-choose', 'choose_identity', { name: 'Role' }),
      tool('recovery', 'before-current', 'current_identity', {}),
      tool('recovery', 'before-messages', 'get_messages', {}),
    ];
    const admitted = event('prompt.admitted', { queuedBehind: 1 }, { promptId: 'recovery' });
    const overlap = [
      tool('ordinary', 'other-choose', 'choose_identity', { name: 'Role' }),
      tool('ordinary', 'other-current', 'current_identity', {}),
      tool('ordinary', 'other-messages', 'get_messages', {}),
    ];
    const terminal = event('turn.completed', { outcome: 'completed' }, { promptId: 'recovery' });
    const after = [
      tool('recovery', 'after-choose', 'choose_identity', { name: 'Role' }),
      tool('recovery', 'after-current', 'current_identity', {}),
      tool('recovery', 'after-messages', 'get_messages', {}),
    ];
    expect(evaluateAgentRecovery(
      [...before, admitted, ...overlap, terminal, ...after], 'recovery', 'Role',
    ).reason).toBe('RECOVERY_CHOOSE_MISSING');
  });

  it('merges in-turn tool patches but requires terminal completed status', () => {
    seq = 0;
    const admitted = event('prompt.admitted', { queuedBehind: 0 }, { promptId: 'recovery' });
    const chooseStart = tool('recovery', 'choose', 'choose_identity', { name: 'Role' }, 'in_progress');
    const chooseDone = event('tool.upsert', {
      toolCallId: 'choose', snapshot: false, status: 'completed',
    }, { promptId: 'recovery', toolCallId: 'choose' });
    const current = tool('recovery', 'current', 'current_identity', {});
    const messages = tool('recovery', 'messages', 'get_messages', {});
    const terminal = event('turn.completed', { outcome: 'completed' }, { promptId: 'recovery' });
    expect(evaluateAgentRecovery(
      [admitted, chooseStart, chooseDone, current, messages, terminal], 'recovery', 'Role',
    ).ok).toBe(true);
    chooseDone.payload = { toolCallId: 'choose', snapshot: false, status: 'failed' };
    expect(evaluateAgentRecovery(
      [admitted, chooseStart, chooseDone, current, messages, terminal], 'recovery', 'Role',
    ).reason).toBe('RECOVERY_CHOOSE_MISSING');
  });

  it.each([
    [{ name: 'Other', force: false }, 'wrong identity'],
    [{ name: 'Role', force: true }, 'force'],
    [{ name: 'Role', force: false, extra: 'x' }, 'extra input'],
  ])('rejects unsafe choose input: %s (%s)', (input) => {
    seq = 0;
    const events = validTurn();
    const choose = events.find(item => item.toolCallId === 'choose')!;
    choose.payload = {
      toolCallId: 'choose', snapshot: true, title: 'choose_identity', status: 'completed',
      rawInput: { json: input, bytes: 2 },
    };
    expect(evaluateAgentRecovery(events, 'recovery', 'Role').reason)
      .toBe('RECOVERY_CHOOSE_MISSING');
  });

  it('rejects unknown aliases, cancelled turns, and assistant prose', () => {
    seq = 0;
    const events = validTurn();
    const choose = events.find(item => item.toolCallId === 'choose')!;
    (choose.payload as { title?: string }).title = 'ours choose identity';
    events.splice(-1, 0, event('message.chunk', {
      content: { type: 'text', text: 'I called choose_identity, current_identity and get_messages', bytes: 63 },
    }, { promptId: 'recovery' }));
    expect(evaluateAgentRecovery(events, 'recovery', 'Role').reason)
      .toBe('RECOVERY_CHOOSE_MISSING');
    (events.at(-1)!.payload as { outcome: string }).outcome = 'cancelled';
    expect(evaluateAgentRecovery(events, 'recovery', 'Role').reason)
      .toBe('RECOVERY_TURN_FAILED');
  });

  it('rejects tool evidence from another session generation', () => {
    seq = 0;
    const events = validTurn();
    for (const item of events.filter(item => item.kind === 'tool.upsert'))
      item.sessionGeneration = 'session-old';
    expect(evaluateAgentRecovery(events, 'recovery', 'Role').reason)
      .toBe('RECOVERY_CHOOSE_MISSING');
  });

  it('correlates a live queued recovery prompt to its durable event stream', async () => {
    seq = 0;
    const listeners = new Set<(value: ConversationEventV1) => void>();
    const emit = (value: ConversationEventV1) => listeners.forEach(listener => listener(value));
    const session = {
      subscribeConversation: (listener: (value: ConversationEventV1) => void) => {
        listeners.add(listener); return () => listeners.delete(listener);
      },
      queuePrompt: async (text: string) => {
        expect(text).toContain('force false');
        for (const value of validTurn('live-recovery', 'Role')) emit(value);
        return {
          promptId: 'live-recovery', queuedBehind: 0,
          completion: Promise.resolve({ accepted: true, outcome: 'completed', succeeded: true }),
        };
      },
    } as unknown as AgentSession;
    await expect(recoverAgentIdentity(session, 'Role')).resolves.toMatchObject({
      ok: true, reason: 'RECOVERY_TOOLS_VERIFIED',
    });
    expect(listeners.size).toBe(0);
  });

  it.each([
    ['get before choose', ['messages', 'choose', 'current']],
    ['current before choose', ['current', 'choose', 'messages']],
    ['get before current', ['choose', 'messages', 'current']],
  ])('requires bind → verify → read ordering: %s', (_label, order) => {
    seq = 0;
    const admitted = event('prompt.admitted', { queuedBehind: 0 }, { promptId: 'recovery' });
    const calls = {
      choose: () => tool('recovery', 'choose', 'choose_identity', { name: 'Role' }),
      current: () => tool('recovery', 'current', 'current_identity', {}),
      messages: () => tool('recovery', 'messages', 'get_messages', {}),
    };
    const tools = order.map(name => calls[name as keyof typeof calls]());
    const terminal = event('turn.completed', { outcome: 'completed' }, { promptId: 'recovery' });
    expect(evaluateAgentRecovery([admitted, ...tools, terminal], 'recovery', 'Role').reason)
      .toBe('RECOVERY_TOOL_ORDER_INVALID');
  });

  it('accepts a later valid ordered attempt after an earlier invalid order in the same turn', () => {
    seq = 0;
    const admitted = event('prompt.admitted', { queuedBehind: 0 }, { promptId: 'recovery' });
    const early = [
      tool('recovery', 'early-messages', 'get_messages', {}),
      tool('recovery', 'early-choose', 'choose_identity', { name: 'Role' }),
      tool('recovery', 'early-current', 'current_identity', {}),
    ];
    const valid = [
      tool('recovery', 'late-choose', 'choose_identity', { name: 'Role' }),
      tool('recovery', 'late-current', 'current_identity', {}),
      tool('recovery', 'late-messages', 'get_messages', {}),
    ];
    const terminal = event('turn.completed', { outcome: 'completed' }, { promptId: 'recovery' });
    expect(evaluateAgentRecovery(
      [admitted, ...early, ...valid, terminal], 'recovery', 'Role',
    ).reason).toBe('RECOVERY_TOOLS_VERIFIED');
  });
});
