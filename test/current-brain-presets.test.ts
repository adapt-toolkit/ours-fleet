import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { generateSetup, type PurposeChoice } from '../src/init-wizard.js';
import { claudeModelCatalog, packagedModelCatalog } from '../src/application/model-catalog.js';
import { getAdapter } from '../src/harness/registry.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';
import '../src/harness/hermes.js';

const catalog = packagedModelCatalog();
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('current Brain presets', () => {
  it('keeps the verified harness matrix in the adapters\' catalog', () => {
    const expected = {
      'gpt-6.1-sol': [...levels, 'ultra'],
      'gpt-6-sol': [...levels, 'ultra'],
      'gpt-6-luna': levels,
      'claude-fable-5-1': levels,
      'claude-opus-5-5': levels,
      'claude-sonnet-5': levels,
      'claude-haiku-4-5-20251001': [],
    };
    for (const [id, efforts] of Object.entries(expected)) {
      const model = catalog.find(model => model.model === id)!;
      expect(model.efforts).toEqual(efforts);
      const adapter = getAdapter(model.harness).modelCapabilities!();
      expect(adapter.models.find(item => item.id === id)).toEqual({ id, label: model.label, efforts });
    }
  });

  it('ships no combinatorial Brain presets, only the harness-default Brain', () => {
    expect(readdirSync('presets/fleet/brains')).toEqual(['claude-default.yaml']);
  });

  it('freezes every earlier generated Brain preset for honest provenance', () => {
    const legacy = JSON.parse(readFileSync('presets/legacy/generated-brains-rev4.json', 'utf8')).brains;
    expect(Object.keys(legacy)).toHaveLength(82);
    expect(legacy['codex-gpt-6-1-sol-ultra']).toEqual({ harness: 'codex', session: 'acp', model: 'gpt-6.1-sol', effort: 'ultra' });
    expect(legacy['claude-haiku-4-5-20251001-default']).toEqual({ harness: 'claude-code', session: 'acp', model: 'claude-haiku-4-5-20251001' });
  });

  it.each(['low', 'xhigh', 'ultra'])('creates the GPT-6.1 Sol purpose Brains with exactly %s effort', effort => {
    const choice: PurposeChoice = { harness: 'codex', session: 'acp', model: 'gpt-6.1-sol', effort };
    const setup = generateSetup({ subscriptions: ['codex'], assignmentStrategy: 'one-model',
      models: { development: choice, review: choice, coordination: choice } });
    for (const id of ['development', 'critic', 'coordination'])
      expect(parse(setup.files.get(`brains/${id}.yaml`)!)).toEqual({ harness: 'codex', session: 'acp', model: 'gpt-6.1-sol', effort });
    expect(setup.files.get('agent_templates/Developer.yaml')).toContain('brain: { ref: development }');
    expect(setup.files.get('agent_templates/Critic.yaml')).toContain('brain: { ref: critic }');
    expect(setup.files.get('agents/FleetCoordinator.yaml')).toContain('brain: { ref: coordination }');
  });

  it('keeps Haiku effort-free and rejects assigning an effort to it', () => {
    const haiku = (effort: string | null): PurposeChoice =>
      ({ harness: 'claude-code', session: 'acp', model: 'claude-haiku-4-5-20251001', effort });
    expect(claudeModelCatalog().models.find(item => item.id === 'claude-haiku-4-5-20251001')?.reasoningEfforts).toEqual([]);
    expect(() => generateSetup({ subscriptions: ['claude'], assignmentStrategy: 'one-model',
      models: { development: haiku('medium'), review: haiku('medium'), coordination: haiku('medium') } }))
      .toThrow(/has no effort setting/);
    const setup = generateSetup({ subscriptions: ['claude'], assignmentStrategy: 'one-model',
      models: { development: haiku(null), review: haiku(null), coordination: haiku(null) } });
    expect(parse(setup.files.get('brains/critic.yaml')!)).toEqual({ harness: 'claude-code', session: 'acp', model: 'claude-haiku-4-5-20251001' });
  });
});
