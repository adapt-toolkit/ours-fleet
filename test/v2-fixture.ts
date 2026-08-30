import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { RoleConfig } from '../src/config.js';
import { splitRootFor } from '../src/config.js';
import { buildAgentDocument } from '../src/spawn.js';

/**
 * Mechanical success-fixture migration only. Tests for malformed YAML, legacy
 * detection, trust, discovery, paths, and ordering must write their subjects
 * directly so this helper cannot repair the behavior under test.
 */
export function writeV2Fixture(
  manifestPath: string, input: string | Record<string, unknown>,
): void {
  const parsed = typeof input === 'string' ? parse(input) : structuredClone(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('v2 fixture input must be a mapping');
  const model = parsed as Record<string, unknown>;
  const roles = (model.roles ?? {}) as Record<string, RoleConfig | null>;
  const defaults = (model.defaults ?? {}) as Record<string, unknown>;
  const brainDefaultKeys = [
    'harness', 'session', 'session_options', 'model', 'model_chain', 'max_tokens',
    'autocompact_pct', 'harness_options', 'effort',
  ] as const;
  const roleDefaultKeys = ['mission', 'persona', 'bio', 'briefing_file'] as const;
  const documentDefaults = Object.fromEntries(
    brainDefaultKeys
      .filter(key => defaults[key] !== undefined)
      .map(key => [key, structuredClone(defaults[key])]),
  ) as Partial<RoleConfig>;
  const operationalDefaults = Object.fromEntries(
    Object.entries(defaults).filter(([key]) =>
      !brainDefaultKeys.includes(key as typeof brainDefaultKeys[number])
      && !roleDefaultKeys.includes(key as typeof roleDefaultKeys[number])),
  );
  delete model.roles;
  if (Object.keys(operationalDefaults).length) model.defaults = operationalDefaults;
  else delete model.defaults;
  model.api_version = 'ours.network/fleet/v2';

  const root = splitRootFor(manifestPath);
  const agents = join(root, 'agents');
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(agents, { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(agents, 0o700);
  writeFileSync(manifestPath, stringify(model), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);

  for (const [name, roleInput] of Object.entries(roles)) {
    const explicit = { ...(roleInput ?? {}) };
    const role = { ...documentDefaults, ...explicit };
    if (documentDefaults.harness_options !== undefined || explicit.harness_options !== undefined)
      role.harness_options = {
        ...((documentDefaults.harness_options ?? {}) as Record<string, unknown>),
        ...((explicit.harness_options ?? {}) as Record<string, unknown>),
      };
    role.harness ??= 'claude-code';
    const defaultHarness = (defaults.harness as string | undefined) ?? 'claude-code';
    if (role.harness !== defaultHarness) {
      if (explicit.model === undefined) delete role.model;
      if (explicit.model_chain === undefined) delete role.model_chain;
    }
    if (explicit.model === null && explicit.model_chain === undefined) delete role.model_chain;
    const path = join(agents, `${name}.yaml`);
    writeFileSync(path, stringify(buildAgentDocument(role)), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}
