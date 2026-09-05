import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { loadConfig, splitRootFor } from '../src/config.js';
import { spawnDryRun } from '../src/spawn.js';
import '../src/harness/codex.js';

let root: string;
let configPath: string;

function write(path: string, value: unknown): void {
  writeFileSync(path, stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brain-role-spawn-'));
  process.env.HOME = root;
  configPath = join(root, 'fleet.yaml');
  const split = splitRootFor(configPath);
  for (const dir of [split, join(split, 'agents'), join(split, 'brains'), join(split, 'roles')]) {
    mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o700);
  }
  write(configPath, { api_version: 'ours.network/fleet/v2', defaults: {
    permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' },
  } });
  write(join(split, 'brains', 'safe.yaml'), { harness: 'codex', model: 'gpt-test', effort: 'high' });
  write(join(split, 'roles', 'worker.yaml'), { mission: 'Implement safely', persona: 'Scoped worker' });
  write(join(split, 'agents', 'Parent.yaml'), {
    brain: { ref: 'safe' }, role: { ref: 'worker' }, identity: 'Parent',
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Brain/Role-first spawn', () => {
  it('resolves references through the canonical loader and retains inspectable references', () => {
    const result = spawnDryRun({
      name: 'Child', configPath, brain: { ref: 'safe' }, role: { ref: 'worker' },
    });
    expect(result.roleDocument).toMatchObject({ brain: { ref: 'safe' }, role: { ref: 'worker' } });
    expect(result.resolvedRole).toMatchObject({ harness: 'codex', model: 'gpt-test', mission: 'Implement safely' });
    expect(result.resolvedRole.agentSelections).toEqual({ brain: { ref: 'safe' }, role: { ref: 'worker' } });
  });

  it('supports validated inline definitions without a second resolver', () => {
    const result = spawnDryRun({ name: 'Inline', configPath,
      brain: { inline: { harness: 'codex', model: 'gpt-inline' } },
      role: { inline: { mission: 'Inline mission' } },
    });
    expect(result.resolvedRole.model).toBe('gpt-inline');
    expect(result.roleDocument).toMatchObject({
      brain: { inline: { harness: 'codex', model: 'gpt-inline' } },
      role: { inline: { mission: 'Inline mission' } },
    });
  });

  it('reports missing references without rendering inline or secret values', () => {
    expect(() => spawnDryRun({ name: 'Missing', configPath,
      brain: { ref: 'absent' }, role: { ref: 'worker' },
    })).toThrow("E_REF_MISSING: brain 'absent' not found");
  });

  it('rejects Brain-owned manifest defaults with migration guidance', () => {
    write(configPath, { api_version: 'ours.network/fleet/v2', defaults: { model: 'legacy-secret-model' } });
    expect(() => loadConfig(configPath)).toThrow(/E_LEGACY.*move them to a Brain definition/);
  });

  it('rejects ambiguous full-definition and separate-field construction', () => {
    expect(() => spawnDryRun({ name: 'Conflict', configPath,
      agentDefinition: { brain: { ref: 'safe' }, role: { ref: 'worker' } },
      brain: { ref: 'safe' },
    })).toThrow('canonical agentDefinition conflicts with separate Agent fields');
  });
});
