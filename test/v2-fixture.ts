import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { RoleConfig } from '../src/config.js';
import { splitRootFor } from '../src/config.js';
import '../src/harness/claude-code.js';
import '../src/harness/codex.js';

function buildAgentDocument(raw: RoleConfig): Record<string, unknown> {
  const role = Object.fromEntries(['mission', 'persona', 'bio', 'briefing_file']
    .filter(key => raw[key as keyof RoleConfig] !== undefined)
    .map(key => [key, raw[key as keyof RoleConfig]]));
  const brain = Object.fromEntries([
    'harness', 'session', 'session_options', 'model', 'model_chain', 'max_tokens',
    'autocompact_pct', 'harness_options', 'effort',
  ].filter(key => raw[key as keyof RoleConfig] !== undefined)
    .map(key => [key, raw[key as keyof RoleConfig]]));
  const operational = Object.fromEntries([
    'permissions', 'identity', 'cwd', 'coordinator', 'env', 'oversee', 'isolation',
    'monitor', 'owner_channel', 'worklog', 'auth_proxy',
  ].filter(key => raw[key as keyof RoleConfig] !== undefined)
    .map(key => [key, raw[key as keyof RoleConfig]]));
  return { role: { inline: role }, brain: { inline: brain }, ...operational };
}

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
  const watchdogs = (model.watchdogs ?? {}) as Record<string, Record<string, unknown>>;
  for (const entry of Object.values(watchdogs)) {
    if (entry.agent) continue;
    const brain = Object.fromEntries(['harness', 'model', 'session']
      .filter(key => entry[key] !== undefined || defaults[key] !== undefined)
      .map(key => [key, entry[key] ?? defaults[key]]));
    const isolation = entry.isolation;
    for (const key of ['harness', 'model', 'session', 'isolation']) delete entry[key];
    entry.agent = { role: { inline: {} }, brain: { inline: {
      harness: 'claude-code', ...brain,
    } }, ...(isolation === undefined ? {} : { isolation }) };
  }
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
  const agentTemplates = join(root, 'agent_templates');
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(agentTemplates, { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(agents, 0o700);
  chmodSync(agentTemplates, 0o700);
  writeFileSync(manifestPath, stringify(model), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  const referencedTemplates = new Set<string>(['Agent']);
  for (const template of Object.values((model.room_templates ?? {}) as Record<string, { members?: Array<{ agent_template?: string }> }>))
    for (const member of template.members ?? []) if (member.agent_template) referencedTemplates.add(member.agent_template);
  for (const name of referencedTemplates) {
    const templatePath = join(agentTemplates, `${name}.yaml`);
    writeFileSync(templatePath, stringify({
      role: { inline: { mission: 'Complete the assigned room task.' } },
      brain: { inline: { harness: (defaults.harness as string | undefined) ?? 'claude-code' } },
      permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' },
    }), { mode: 0o600 });
    chmodSync(templatePath, 0o600);
  }

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
