import { describe, expect, it } from 'vitest';
import { runtimeMetadata } from '../../web/src/runtime-metadata.js';

const values = (detail: any) => Object.fromEntries(
  runtimeMetadata(detail).map(item => [item.label, item.value]));

describe('runtime metadata presentation', () => {
  it.each([
    ['openai/gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['openai/gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['anthropic/claude-fable-5', 'Claude Fable 5'],
    ['anthropic/claude-opus-5', 'Claude Opus 5'],
  ])('preserves exact model variant %s with authoritative label', (value, label) => {
    const shown = values({ role: { config: { model: 'default', harness: 'codex',
      permissions: { approval: 'ask', filesystem: 'workspace' } } },
    status: { session: { backend: 'acp', protocolVersion: 3,
      runtimeModel: { value, label } } } });
    expect(shown.Model).toBe(`${label} · ${value}`);
    expect(shown.Model).not.toContain('Default');
  });

  it('uses honest fallbacks and never substitutes the creation-time selector', () => {
    const shown = values({ role: { config: { model: 'default' } }, status: { session: {} } });
    expect(shown.Model).toBe('Not reported');
    expect(shown.Reasoning).toBe('Not reported');
    expect(shown.Model).not.toBe('default');
  });
});
