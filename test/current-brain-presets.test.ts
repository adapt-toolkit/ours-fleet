import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateCatalog, generateSetup } from '../src/init-wizard.js';
import { claudeModelCatalog } from '../src/application/model-catalog.js';

const catalog = validateCatalog(JSON.parse(readFileSync('presets/brain-catalog.json', 'utf8')));
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('current Brain presets', () => {
  it('ships the complete verified harness matrix with no unsupported combinations', () => {
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
      const model = catalog.models.find(model => model.model === id)!;
      expect(model.efforts).toEqual(efforts);
      for (const effort of efforts.length ? efforts : [undefined]) {
        const filename = `${model.harness === 'codex' ? 'codex' : 'claude'}-${id.replace(/^claude-/, '').replace(/\./g, '-')}-${effort ?? 'default'}.yaml`;
        const brain = parse(readFileSync(join('presets/fleet/brains', filename), 'utf8'));
        expect(brain).toEqual({ harness: model.harness, session: 'acp', model: id,
          ...(effort ? { effort } : {}) });
      }
    }
    execFileSync(process.execPath, ['scripts/generate-brain-presets.mjs', '--check']);
  });

  it.each([
    ['quick', 'low'], ['balanced', 'medium'], ['thorough', 'high'],
  ] as const)('generates GPT-6.1 Sol setup with %s reasoning', (reasoning, effort) => {
    const model = catalog.models.find(model => model.model === 'gpt-6.1-sol')!;
    const setup = generateSetup({ subscriptions: ['codex'], assignmentStrategy: 'one-model',
      models: { development: model, review: model, coordination: model }, reasoning });
    expect(parse(setup.files.get(`brains/codex-gpt-6-1-sol-${effort}.yaml`)!)).toEqual({
      harness: 'codex', session: 'acp', model: 'gpt-6.1-sol', effort,
    });
    for (const holder of ['agent_templates/Developer.yaml', 'agent_templates/Critic.yaml', 'agents/FleetCoordinator.yaml'])
      expect(setup.files.get(holder)).toContain(`brain: { ref: codex-gpt-6-1-sol-${effort} }`);
  });

  it('keeps Haiku effort-free in the picker and rejects assigning wizard reasoning to it', () => {
    const model = catalog.models.find(model => model.model === 'claude-haiku-4-5-20251001')!;
    expect(claudeModelCatalog().models.find(item => item.id === model.model)?.reasoningEfforts).toEqual([]);
    expect(() => generateSetup({ subscriptions: ['claude'], assignmentStrategy: 'one-model',
      models: { development: model, review: model, coordination: model }, reasoning: 'balanced' }))
      .toThrow(/does not support balanced reasoning/);
  });
});
