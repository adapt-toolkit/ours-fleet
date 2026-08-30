import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeModelCatalog, codexModelCatalog } from '../../src/application/model-catalog.js';

describe('local harness model catalogs', () => {
  it('uses only picker-visible exact Codex IDs and their catalog effort contract', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-catalog-')), 'models.json');
    writeFileSync(path, JSON.stringify({ models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list',
        default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
      { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: [] },
    ] }));
    expect(codexModelCatalog(path).models).toEqual([expect.objectContaining({
      id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoningEfforts: ['low', 'ultra'],
      defaultReasoningEffort: 'low', source: 'codex-runtime-catalog',
    })]);
  });

  it('exposes exact Claude 2.1 IDs', () => {
    expect(claudeModelCatalog().models.map(model => model.id)).toEqual([
      'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
    ]);
  });
});
