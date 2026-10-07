import { it, expect } from 'vitest';
import { StartupTelemetry } from '../src/startup-telemetry.js';
import type { ConversationEventV1 } from '../src/session/conversation-types.js';
it('counts distinct calls, ignores replay/other turns, and emits no message or tool bodies', () => {
  let time = 10; const lines: string[] = [];
  const t = new StartupTelemetry(() => time, line => lines.push(line));
  const event = (kind: string, payload: unknown, extra = {}) => ({ kind, payload, ...extra }) as ConversationEventV1;
  t.mark('supervisor_started'); time = 20; t.mark('identity_ready');
  time = 30; t.mark('startup_submitted');
  t.observe(event('prompt.started', {}, { source: 'startup', promptId: 'boot' }));
  t.observe(event('tool.upsert', { toolCallId: 'a', rawInput: { secret: 'private-arguments' } }, { promptId: 'boot' }));
  t.observe(event('tool.upsert', { toolCallId: 'a', status: 'completed' }, { promptId: 'boot' }));
  t.observe(event('tool.upsert', { toolCallId: 'b' }, { promptId: 'other' }));
  t.observe(event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'replayed-private' } }, { source: 'agent_replay' }));
  time = 50;
  t.observe(event('message.chunk', { role: 'assistant', content: { type: 'text', text: 'private-message' } }, { promptId: 'boot' }));
  time = 60; t.finish(); t.finish();
  t.observe(event('tool.upsert', { toolCallId: 'c' }));
  expect(lines).toEqual([
    'startup stage=supervisor_started elapsed_ms=0',
    'startup stage=identity_ready elapsed_ms=10',
    'startup stage=startup_submitted elapsed_ms=20',
    'startup stage=first_assistant_output elapsed_ms=40 model_and_tools_ms=20 tools=1',
    'startup stage=turn_settled elapsed_ms=50 tools=1 first_output=true',
  ]);
});
