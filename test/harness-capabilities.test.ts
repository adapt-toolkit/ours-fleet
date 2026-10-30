import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessCapabilities, validateBrainChoice, type HarnessCapabilitiesReport } from '../src/application/harness-capabilities.js';
import { PresetProvenance } from '../src/application/preset-provenance.js';
import { bootstrapPresets } from '../src/preset-bootstrap.js';
import { loadConfig, splitRootFor } from '../src/config.js';
import { prepareExecutionPlan } from '../src/rooms-tasks/member-overrides.js';
import { getAdapter } from '../src/harness/registry.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';
import '../src/harness/hermes.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'harness-capabilities-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const facts = (codexModels?: Parameters<typeof harnessCapabilities>[0]['codexModels']) =>
  harnessCapabilities({ harnesses: ['codex', 'claude-code', 'hermes'], codexModels, checkReadiness: false });

describe('adapter-owned model capabilities', () => {
  it('reports each adapter\'s models, distinguishing no-effort from unknown efforts', async () => {
    const report = await facts(async () => ({ state: 'known', models: ['gpt-6.1-sol', 'gpt-7-preview'] }));
    const [codex, claude, hermes] = report.harnesses;
    expect(codex.models.find(model => model.id === 'gpt-6.1-sol')).toEqual({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], available: true, source: 'adapter' });
    expect(codex.models.find(model => model.id === 'gpt-6-luna')).toMatchObject({ available: false,
      reason: 'The active Codex account does not offer this model.' });
    // Offered by the account, not maintained by the adapter: efforts unknown (null), not "no effort" ([]).
    expect(codex.models.find(model => model.id === 'gpt-7-preview')).toEqual({ id: 'gpt-7-preview', label: 'gpt-7-preview',
      efforts: null, available: true, source: 'runtime-discovery' });
    expect(claude.models.find(model => model.id === 'claude-haiku-4-5-20251001')?.efforts).toEqual([]);
    expect(claude.discovery).toBeUndefined();
    expect(hermes).toMatchObject({ models: [], modelRequired: true, customModels: true });
    expect(codex.sessions).toEqual(['acp', 'codex-app-server']);
  });

  it('marks Codex models unavailable with the reason when the account cannot be asked', async () => {
    const report = await facts(async () => ({ state: 'unknown', reason: 'codex app-server exited' }));
    const codex = report.harnesses[0];
    expect(codex.discovery).toEqual({ state: 'unknown', reason: 'codex app-server exited' });
    expect(codex.models.every(model => !model.available && model.reason?.includes('codex app-server exited'))).toBe(true);
    expect(validateBrainChoice(report, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' }))
      .toMatchObject({ ok: false, code: 'model_unavailable' });
  });

  it('validates a new choice exactly and never substitutes a model or effort', async () => {
    const report: HarnessCapabilitiesReport = await facts(async () => ({ state: 'known', models: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-7-preview'] }));
    const check = (choice: Parameters<typeof validateBrainChoice>[1]) => validateBrainChoice(report, choice);
    expect(check({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' })).toMatchObject({ ok: true });
    expect(check({ harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toMatchObject({ ok: false, code: 'effort_unsupported',
      message: expect.stringContaining('choose one of: low, medium, high, xhigh, max') });
    // Harness default effort is an explicit omission, kept as such.
    expect(check({ harness: 'codex', model: 'gpt-6-luna' })).toMatchObject({ ok: true });
    expect(check({ harness: 'claude-code', model: 'claude-haiku-4-5-20251001', effort: 'low' }))
      .toMatchObject({ ok: false, code: 'effort_unsupported', message: expect.stringContaining('has no effort setting') });
    expect(check({ harness: 'claude-code', model: 'claude-haiku-4-5-20251001' })).toMatchObject({ ok: true });
    for (const model of ['gpt-7-preview', 'my-provider-model'])
      expect(check({ harness: 'codex', model, effort: 'high' })).toMatchObject({ ok: false, code: 'effort_unknown' });
    expect(check({ harness: 'codex', model: 'my-provider-model' })).toMatchObject({ ok: true });
    expect(check({ harness: 'codex', model: null, effort: 'high' })).toMatchObject({ ok: false, code: 'effort_unknown' });
    expect(check({ harness: 'hermes' })).toMatchObject({ ok: false, code: 'model_required' });
    expect(check({ harness: 'hermes', model: 'llama3', effort: 'low' })).toMatchObject({ ok: false, code: 'effort_unknown' });
    expect(check({ harness: 'codex', session: 'tmux', model: 'gpt-6.1-sol' })).toMatchObject({ ok: false, code: 'session_unsupported' });
    expect(check({ harness: 'invented' })).toMatchObject({ ok: false, code: 'harness_unsupported' });
  });
});

describe('existing installations', () => {
  it('keeps loading previously valid Brains unchanged and reports retired generated presets as legacy', () => {
    const configPath = join(root, 'fleet.yaml');
    bootstrapPresets(configPath);
    const brains = join(splitRootFor(configPath), 'brains');
    const existing = {
      'codex-gpt-6-1-sol-medium.yaml': 'harness: codex\nsession: acp\nmodel: gpt-6.1-sol\neffort: medium\n',
      'codex-gpt-6-sol-high.yaml': 'harness: codex\nsession: acp\nmodel: gpt-6-sol\neffort: max\n',
      'provider.yaml': 'harness: codex\nsession: acp\nmodel: my-provider-model\neffort: high\n',
      'review.yaml': 'harness: codex\nsession: acp\nmodel: gpt-6-sol\n',
    };
    for (const [name, text] of Object.entries(existing)) writeFileSync(join(brains, name), text, { mode: 0o600 });
    writeFileSync(join(splitRootFor(configPath), 'agent_templates', 'Developer.yaml'),
      readFileSync(join(splitRootFor(configPath), 'agent_templates', 'Developer.yaml'), 'utf8')
        .replace('brain: { ref: claude-default }', 'brain: { ref: codex-gpt-6-1-sol-medium }'), { mode: 0o600 });
    const cfg = loadConfig(configPath);
    // A custom model with an effort and an omitted effort still load: strict checks apply to new choices only.
    expect(cfg.brainPresets?.provider).toEqual({ harness: 'codex', session: 'acp', model: 'my-provider-model', effort: 'high' });
    expect(cfg.brainPresets?.review).toEqual({ harness: 'codex', session: 'acp', model: 'gpt-6-sol' });
    expect(cfg.brainPresets?.['claude-default']).toMatchObject({ harness: 'claude-code', model: null, effort: 'high' });
    expect(cfg.agentTemplates?.Developer.brain).toEqual({ inline: expect.objectContaining({ model: 'gpt-6.1-sol', effort: 'medium' }) });
    const provenance = new PresetProvenance(configPath).read().brain;
    expect(provenance['codex-gpt-6-1-sol-medium']).toMatchObject({ status: 'legacy' });
    expect(provenance['codex-gpt-6-sol-high']).toMatchObject({ status: 'changed' });
    expect(provenance.provider).toEqual({ status: 'custom' });
    expect(provenance['claude-default']).toMatchObject({ status: 'predefined' });
    for (const [name, text] of Object.entries(existing)) expect(readFileSync(join(brains, name), 'utf8')).toBe(text);
  });
});

describe('manual harness/model/effort for one member', () => {
  const template = { name: 'additional-member', version: 1, description: 'x', members: [
    { slot: 'helper', role: 'helper', count: 1, agent_template: 'Developer' },
  ] };

  it('launches the exact triple without saving a Brain, and keeps an unchanged template default', () => {
    const configPath = join(root, 'fleet.yaml');
    bootstrapPresets(configPath);
    const brains = join(splitRootFor(configPath), 'brains');
    const before = readdirSync(brains).sort();
    const cfg = loadConfig(configPath);

    const manual = prepareExecutionPlan(template, cfg, { helper: { role: 'Developer',
      overrides: { brain: { inline: { harness: 'codex', session: 'acp', model: 'gpt-6-luna', effort: 'xhigh' } } } } });
    const definition = manual.launchDefinitions['helper:Developer'];
    expect(definition.brain).toEqual({ inline: { harness: 'codex', session: 'acp', model: 'gpt-6-luna', effort: 'xhigh' } });
    expect(manual.snapshot.members[0].brain_preset).toBeUndefined();
    const role = cfg.resolveAgentDefinition!('RoomMember_helper', { ...definition, identity: 'RoomMember_helper' });
    // The values the Codex ACP session is configured with at launch.
    expect(getAdapter('codex').agentSession.sessionConfigSelections(role)).toEqual([
      { configId: 'model', value: 'gpt-6-luna' }, { configId: 'reasoning_effort', value: 'xhigh' },
    ]);

    const claude = prepareExecutionPlan(template, cfg, { helper: { role: 'Developer',
      overrides: { brain: { inline: { harness: 'claude-code', session: 'acp', model: 'claude-opus-5-5', effort: 'max' } } } } });
    const claudeRole = cfg.resolveAgentDefinition!('RoomMember_helper', { ...claude.launchDefinitions['helper:Developer'], identity: 'RoomMember_helper' });
    expect(claudeRole.model).toBe('claude-opus-5-5');
    expect(getAdapter('claude-code').agentSession.sessionConfigSelections(claudeRole)).toEqual([{ configId: 'effort', value: 'max' }]);

    // No override: the template's own default reaches the launch unchanged.
    const unchanged = prepareExecutionPlan(template, cfg, { helper: { role: 'Developer' } });
    expect(unchanged.launchDefinitions['helper:Developer'].brain).toEqual(cfg.agentTemplates!.Developer.brain);
    expect(readdirSync(brains).sort()).toEqual(before);
    expect(existsSync(join(brains, 'gpt-6-luna-xhigh.yaml'))).toBe(false);
  });
});
