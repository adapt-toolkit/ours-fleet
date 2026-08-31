import { describe, expect, it } from 'vitest';

import {
  addAgentTemplate, agentEditorState, editInlineAgentField, fleetSetupSections,
  removeAgentTemplate, renameAgentTemplate, type FleetSetupModel,
} from '../../web/src/FleetSetup.js';

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

  it('keeps persistent and inert-template sections and mutations independent', () => {
    const model: FleetSetupModel = {
      manifest: {}, agents: { Coordinator: { template: 'Worker', overrides: {} } },
      agent_templates: { Worker: { role: { inline: {} }, brain: { inline: { harness: 'codex' } } } },
    };
    expect(fleetSetupSections(model)).toEqual({
      persistentAgents: ['Coordinator'], inertAgentTemplates: ['Worker'],
    });
    expect(agentEditorState(model.agents.Coordinator)).toMatchObject({
      templateRef: 'Worker', directEditors: false, roleInline: undefined, brainInline: undefined,
    });
    const added = addAgentTemplate(model);
    expect(added).toBe('Template1');
    expect(renameAgentTemplate(model, added, 'Reviewer')).toBe(true);
    expect(removeAgentTemplate(model, 'Reviewer')).toBe(true);
    expect(model.agents).toEqual({ Coordinator: { template: 'Worker', overrides: {} } });
    expect(Object.keys(model.agent_templates)).toEqual(['Worker']);
  });
});
