import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT_BYTES, normalizeSessionUpdate,
} from '../src/session/conversation-normalizer.js';
import type {
  CapabilitiesUpdatedPayload, MessageChunkPayload, NormalizedText, PlanReplacePayload,
  SessionInfoPayload, SessionStatePayload, ThoughtChunkPayload, ToolUpsertPayload,
  UnsupportedPayload, UsageUpdatedPayload,
} from '../src/session/conversation-types.js';

const text = (value: string) => ({ type: 'text' as const, text: value });

describe('normalizeSessionUpdate', () => {
  it('maps agent message chunks with the optional messageId', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'agent_message_chunk', content: text('hello'), messageId: 'm-1',
    });
    expect(result.kind).toBe('message.chunk');
    expect(result.messageId).toBe('m-1');
    const payload = result.payload as MessageChunkPayload;
    expect(payload.role).toBe('assistant');
    expect(payload.content).toMatchObject({ type: 'text', text: 'hello', bytes: 5 });
  });

  it('maps user message chunks to user-role message chunks', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'user_message_chunk', content: text('question'),
    });
    expect(result.kind).toBe('message.chunk');
    expect((result.payload as MessageChunkPayload).role).toBe('user');
    expect(result.messageId).toBeUndefined();
  });

  it('maps thought chunks and never mislabels them as messages', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'agent_thought_chunk', content: text('thinking'),
    });
    expect(result.kind).toBe('thought.chunk');
    expect((result.payload as ThoughtChunkPayload).content)
      .toMatchObject({ type: 'text', text: 'thinking' });
  });

  it('caps oversized text, keeping original byte count and a digest', () => {
    const oversized = 'x'.repeat(MAX_TEXT_BYTES + 10);
    const result = normalizeSessionUpdate({
      sessionUpdate: 'agent_message_chunk', content: text(oversized),
    });
    const content = (result.payload as MessageChunkPayload).content as NormalizedText;
    expect(content.truncated).toBe(true);
    expect(content.bytes).toBe(MAX_TEXT_BYTES + 10);
    expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(content.digest).toMatch(/^[0-9a-f]{24}$/);
  });

  it('redacts text when asked, preserving bytes and digest but not content', () => {
    const result = normalizeSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: text('secret payload') },
      { redactText: '[scheduled-loop output redacted]' },
    );
    const content = (result.payload as MessageChunkPayload).content as NormalizedText;
    expect(content.redacted).toBe(true);
    expect(content.text).toBe('[scheduled-loop output redacted]');
    expect(content.text).not.toContain('secret');
    expect(content.bytes).toBe(Buffer.byteLength('secret payload'));
    expect(content.digest).toMatch(/^[0-9a-f]{24}$/);
  });

  it('describes non-text content blocks without carrying media payloads', () => {
    const image = normalizeSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    });
    expect((image.payload as MessageChunkPayload).content).toMatchObject({
      type: 'image', mimeType: 'image/png', bytes: 4,
    });
    expect(JSON.stringify(image)).not.toContain('AAAA');

    const link = normalizeSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'resource_link', uri: 'https://example.test/doc', name: 'doc' },
    });
    expect((link.payload as MessageChunkPayload).content).toMatchObject({
      type: 'resource_link', uri: 'https://example.test/doc', name: 'doc',
    });
  });

  it('maps a full tool_call to a snapshot upsert with rich content', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'in_progress',
      locations: [{ path: '/repo/a.ts', line: 3 }],
      rawInput: { command: 'npm test' },
      content: [
        { type: 'content', content: text('output line') },
        { type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' },
        { type: 'terminal', terminalId: 'term-1' },
      ],
    });
    expect(result.kind).toBe('tool.upsert');
    expect(result.toolCallId).toBe('tool-1');
    const payload = result.payload as ToolUpsertPayload;
    expect(payload).toMatchObject({
      toolCallId: 'tool-1', snapshot: true, title: 'Run tests',
      kind: 'execute', status: 'in_progress',
      locations: [{ path: '/repo/a.ts', line: 3 }],
    });
    expect(payload.rawInput?.json).toEqual({ command: 'npm test' });
    expect(payload.content).toHaveLength(3);
    expect(payload.content?.[1]).toMatchObject({
      type: 'diff', path: '/repo/a.ts',
      oldText: { text: 'old' }, newText: { text: 'new' },
    });
    expect(payload.content?.[2]).toEqual({ type: 'terminal', terminalId: 'term-1' });
  });

  it('maps a tool_call_update to a patch upsert carrying only present fields', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed',
      rawOutput: { ok: true },
    });
    const payload = result.payload as ToolUpsertPayload;
    expect(payload.snapshot).toBe(false);
    expect(payload.status).toBe('completed');
    expect(payload.title).toBeUndefined();
    expect(payload.rawOutput?.json).toEqual({ ok: true });
  });

  it('maps standard plans to whole-session plan.replace snapshots', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'map the stream', priority: 'high', status: 'completed' },
        { content: 'design the store', priority: 'medium', status: 'pending' },
      ],
    });
    expect(result.kind).toBe('plan.replace');
    const payload = result.payload as PlanReplacePayload;
    expect(payload.planId).toBeUndefined();
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries?.[0]).toMatchObject({
      content: { text: 'map the stream' }, priority: 'high', status: 'completed',
    });
  });

  it('maps unstable plan_update and plan_removed without crashing', () => {
    const items = normalizeSessionUpdate({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items', planId: 'p-1',
        entries: [{ content: 'step', priority: 'low', status: 'pending' }],
      },
    });
    expect(items.kind).toBe('plan.replace');
    expect((items.payload as PlanReplacePayload).planId).toBe('p-1');
    expect((items.payload as PlanReplacePayload).entries).toHaveLength(1);

    const markdown = normalizeSessionUpdate({
      sessionUpdate: 'plan_update',
      plan: { type: 'markdown', planId: 'p-2', content: '# plan' },
    });
    expect((markdown.payload as PlanReplacePayload).markdown)
      .toMatchObject({ text: '# plan' });

    const removed = normalizeSessionUpdate({
      sessionUpdate: 'plan_removed', planId: 'p-1',
    });
    expect(removed.kind).toBe('plan.replace');
    expect(removed.payload as PlanReplacePayload).toMatchObject({
      planId: 'p-1', removed: true,
    });
  });

  it('maps usage updates including the optional cost', () => {
    const bare = normalizeSessionUpdate({
      sessionUpdate: 'usage_update', used: 42_000, size: 200_000,
    });
    expect(bare.kind).toBe('usage.updated');
    expect(bare.payload as UsageUpdatedPayload)
      .toEqual({ used: 42_000, size: 200_000 });

    const priced = normalizeSessionUpdate({
      sessionUpdate: 'usage_update', used: 1, size: 2,
      cost: { amount: 0.5, currency: 'USD' },
    });
    expect((priced.payload as UsageUpdatedPayload).cost)
      .toEqual({ amount: 0.5, currency: 'USD' });
  });

  it('maps mode, session-info, command and config updates', () => {
    const mode = normalizeSessionUpdate({
      sessionUpdate: 'current_mode_update', currentModeId: 'plan',
    });
    expect(mode.kind).toBe('session.state');
    expect((mode.payload as SessionStatePayload).currentModeId).toBe('plan');

    const info = normalizeSessionUpdate({
      sessionUpdate: 'session_info_update', title: 'Research replay', updatedAt: null,
    });
    expect(info.kind).toBe('session.info');
    expect(info.payload as SessionInfoPayload)
      .toEqual({ title: 'Research replay', updatedAt: null });

    const commands = normalizeSessionUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'create_plan', description: 'Plan work', input: { hint: 'topic' } },
      ],
    });
    expect(commands.kind).toBe('capabilities.updated');
    expect((commands.payload as CapabilitiesUpdatedPayload).commands).toEqual([
      { name: 'create_plan', description: expect.objectContaining({ text: 'Plan work' }), inputHint: 'topic' },
    ]);

    const config = normalizeSessionUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'model', name: 'Model', value: 'opus' }],
    });
    expect(config.kind).toBe('capabilities.updated');
    const options = (config.payload as CapabilitiesUpdatedPayload).configOptions;
    expect(options?.json).toEqual([{ id: 'model', name: 'Model', value: 'opus' }]);
  });

  it('quarantines namespaced _meta instead of flattening or dropping it', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'tool_call', toolCallId: 't', title: 'x',
      _meta: { codex: { subagent: 'reviewer' }, claudeCode: { taskId: '7' } },
    });
    expect(result.adapterMeta).toEqual(expect.arrayContaining([
      { namespace: 'codex', value: { subagent: 'reviewer' } },
      { namespace: 'claudeCode', value: { taskId: '7' } },
    ]));
    // _meta stays quarantined: the payload itself carries no adapter namespace.
    expect(JSON.stringify(result.payload)).not.toContain('subagent');
  });

  it('drops oversized _meta values but keeps the namespace and byte count', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'agent_message_chunk', content: text('hi'),
      _meta: { codex: { blob: 'y'.repeat(64 * 1024) } },
    });
    const meta = result.adapterMeta?.find(entry => entry.namespace === 'codex');
    expect(meta?.truncated).toBe(true);
    expect(meta?.value).toBeUndefined();
    expect(meta?.bytes).toBeGreaterThan(64 * 1024);
  });

  it('reduces an unknown update to a bounded unsupported diagnostic', () => {
    const result = normalizeSessionUpdate({
      sessionUpdate: 'future_hologram_update',
      payload: { giant: 'z'.repeat(512 * 1024) },
    } as never);
    expect(result.kind).toBe('unsupported');
    const payload = result.payload as UnsupportedPayload;
    expect(payload.sessionUpdate).toBe('future_hologram_update');
    expect(payload.bytes).toBeGreaterThan(512 * 1024);
    expect((payload.preview ?? '').length).toBeLessThanOrEqual(2_048);
    expect(JSON.stringify(result).length).toBeLessThan(8_192);
  });

  it('never throws, even for hostile shapes', () => {
    const hostile: unknown[] = [
      null, undefined, 42, 'text', {}, { sessionUpdate: 42 },
      { sessionUpdate: 'agent_message_chunk' },                       // missing content
      { sessionUpdate: 'agent_message_chunk', content: null },
      { sessionUpdate: 'tool_call' },                                 // missing toolCallId
      { sessionUpdate: 'plan', entries: 'not-an-array' },
      { sessionUpdate: 'usage_update', used: 'NaN', size: null },
      { sessionUpdate: 'plan_update', plan: { type: 'wormhole' } },
    ];
    for (const update of hostile) {
      const result = normalizeSessionUpdate(update as never);
      expect(result.kind).toBeDefined();
      expect(() => JSON.stringify(result)).not.toThrow();
    }
  });

  it('normalizes circular or unserializable raw tool data without crashing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = normalizeSessionUpdate({
      sessionUpdate: 'tool_call_update', toolCallId: 't', rawInput: circular,
    });
    const payload = result.payload as ToolUpsertPayload;
    expect(payload.rawInput?.truncated).toBe(true);
    expect(payload.rawInput?.json).toBeUndefined();
  });
});
