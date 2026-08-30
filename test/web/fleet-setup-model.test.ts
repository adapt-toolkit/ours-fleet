import { describe, expect, it } from 'vitest';

import { agentEditorState, editInlineAgentField } from '../../web/src/FleetSetup.js';

describe('FleetSetup split Agent editing seam', () => {
  it('renders Role/Brain refs as preset-backed and refuses implicit edits', () => {
    const agent = { role: { ref: 'developer' }, brain: { ref: 'claude-default' } };
    expect(agentEditorState(agent)).toMatchObject({
      roleRef: 'developer', brainRef: 'claude-default',
      roleInline: undefined, brainInline: undefined,
    });
    expect(editInlineAgentField(agent, 'role', 'mission', 'changed')).toBe(false);
    expect(editInlineAgentField(agent, 'brain', 'harness', 'codex')).toBe(false);
    expect(agent).toEqual({ role: { ref: 'developer' }, brain: { ref: 'claude-default' } });
  });

  it('keeps inline Role/Brain fields editable', () => {
    const agent = {
      role: { inline: { mission: 'before' } },
      brain: { inline: { harness: 'claude-code' } },
    };
    expect(editInlineAgentField(agent, 'role', 'mission', 'after')).toBe(true);
    expect(editInlineAgentField(agent, 'brain', 'harness', 'codex')).toBe(true);
    expect(agent).toMatchObject({
      role: { inline: { mission: 'after' } }, brain: { inline: { harness: 'codex' } },
    });
  });
});
