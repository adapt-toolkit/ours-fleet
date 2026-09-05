import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { writeV2Fixture } from './v2-fixture.js';

describe('writeV2Fixture contract', () => {
  it('keeps only operational defaults in the manifest and materializes Brain defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'ours-v2-fixture-'));
    try {
      const manifest = join(root, 'fleet.yaml');
      writeV2Fixture(manifest, {
        defaults: {
          harness: 'codex', model: 'gpt-5.6', model_chain: ['gpt-5.5'], max_tokens: 42,
          harness_options: { profile: 'fleet' }, permissions: { approval: 'ask' },
          mission: 'must not be invented', persona: 'must not be invented',
        },
        roles: {
          Alice: {},
          Claude: { harness: 'claude-code', model: 'claude-explicit' },
        },
      });
      const emittedManifest = parse(readFileSync(manifest, 'utf8'));
      expect(emittedManifest.defaults).toEqual({ permissions: { approval: 'ask' } });
      for (const forbidden of [
        'harness', 'model', 'model_chain', 'max_tokens', 'harness_options', 'session',
        'session_options', 'autocompact_pct', 'effort', 'mission', 'persona', 'bio',
        'briefing_file',
      ]) expect(emittedManifest.defaults).not.toHaveProperty(forbidden);

      const agent = parse(readFileSync(join(root, 'fleet', 'agents', 'Alice.yaml'), 'utf8'));
      expect(agent.brain.inline).toMatchObject({
        harness: 'codex', model: 'gpt-5.6', model_chain: ['gpt-5.5'], max_tokens: 42,
        harness_options: { profile: 'fleet' },
      });
      expect(agent.role.inline).not.toHaveProperty('mission');
      expect(agent.role.inline).not.toHaveProperty('persona');

      const crossHarness = parse(
        readFileSync(join(root, 'fleet', 'agents', 'Claude.yaml'), 'utf8'),
      );
      expect(crossHarness.brain.inline.model).toBe('claude-explicit');
      expect(crossHarness.brain.inline).not.toHaveProperty('model_chain');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
