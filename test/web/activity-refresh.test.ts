import { describe, expect, it } from 'vitest';
import { mergeOutput } from '../../web/src/RoleWorkspace.js';

describe('activity polling merge', () => {
  it('preserves raw events, deduplicates replay, and advances the cursor', () => {
    const current = { events: [{ seq: 1, kind: 'agent_text', text: 'a' }, { seq: 2, kind: 'tool_update' }], lastSeq: 2, truncated: false };
    const next = { events: [{ seq: 2, kind: 'tool_update' }, { seq: 3, kind: 'agent_text', text: 'b' }], firstSeq: 2, lastSeq: 3, truncated: false };
    expect(mergeOutput(current, next)).toMatchObject({
      events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], firstSeq: 1, lastSeq: 3, truncated: false,
    });
  });

  it('replaces tmux pane snapshots instead of concatenating them', () => {
    expect(mergeOutput({ text: 'old', events: [] }, { text: 'new', events: [], truncated: false }).text).toBe('new');
  });
});
