import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { parseFleetDocument } from '../config-yaml.js';
import { validateEffectiveAgentTemplate, type AgentDefinition, type AgentTemplateDefinition, type FleetConfig } from '../config.js';
import { analyzeRolePermissions } from '../permissions.js';
import { canonicalJson } from '../canonical-json.js';
import type { TemplateDefinition, TemplateSnapshot } from './types.js';
import { redactLaunchDefinition } from './launch-snapshot.js';
import { snapshotTemplate } from './templates.js';

export interface MemberOverride {
  agent_template?: string;
  brain?: string;
  role?: string;
  approval?: 'ask' | 'auto' | 'allow';
  filesystem?: 'read-only' | 'workspace' | 'unrestricted';
  unattended?: 'deny' | 'wait';
  cwd?: string;
  model?: string;
  effort?: string;
  overrides?: Partial<AgentDefinition>;
}
export type MemberOverrides = Record<string, MemberOverride>;

export function hashMemberOverrides(overrides: MemberOverrides): string {
  return createHash('sha256').update(canonicalJson(overrides)).digest('hex');
}

const OPTION_FIELDS: Record<string, keyof MemberOverride> = {
  '--agent-template': 'agent_template', '--brain': 'brain', '--role': 'role',
  '--approval': 'approval', '--filesystem': 'filesystem',
  '--unattended': 'unattended', '--cwd': 'cwd', '--model': 'model', '--effort': 'effort',
};

/** Parse only the ordered member-option subsequence supplied by the CLI action. */
export function parseGroupedMemberArgs(argv: string[]): MemberOverrides {
  if (argv.length % 2) throw new Error(`${argv.at(-1)}: value required`);
  const result: MemberOverrides = {};
  let current: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!value) throw new Error(`${flag}: value required`);
    if (flag === '--member') {
      if (result[value]) throw new Error(`duplicate member slot '${value}'`);
      current = value; result[current] = {}; continue;
    }
    const field = OPTION_FIELDS[flag];
    if (!field) throw new Error(`unknown member option '${flag}'`);
    if (!current) throw new Error(`${flag} must follow --member <slot>`);
    if (result[current][field] !== undefined) throw new Error(`duplicate ${flag} for member '${current}'`);
    (result[current] as Record<string, unknown>)[field] = value;
  }
  for (const [slot, value] of Object.entries(result)) validateMemberOverride(value, `member '${slot}'`);
  return result;
}

export function readMembersFile(path: string): MemberOverrides {
  const stat = lstatSync(path); const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000
      || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
    throw new Error(`${path}: members file must be a trusted regular file no larger than 1 MB`);
  const raw = parseFleetDocument(path, readFileSync(path, 'utf8'), 'strict').value;
  if (!raw.members || typeof raw.members !== 'object' || Array.isArray(raw.members)
      || Object.keys(raw).some(key => key !== 'members'))
    throw new Error(`${path}: expected exactly a members: mapping`);
  const members = structuredClone(raw.members) as MemberOverrides;
  for (const [slot, value] of Object.entries(members)) validateMemberOverride(value, `${path}: member '${slot}'`);
  return members;
}

const MEMBER_KEYS = new Set(['agent_template', 'brain', 'role', 'approval', 'filesystem', 'unattended', 'cwd', 'model', 'effort', 'overrides']);
function validateMemberOverride(value: unknown, where: string): asserts value is MemberOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: must be a mapping`);
  const item = value as Record<string, unknown>;
  const unknown = Object.keys(item).filter(key => !MEMBER_KEYS.has(key));
  if (unknown.length) throw new Error(`${where}: unknown key '${unknown[0]}'`);
  const allowed = {
    approval: ['ask', 'auto', 'allow'], filesystem: ['read-only', 'workspace', 'unrestricted'],
    unattended: ['deny', 'wait'],
  } as const;
  for (const [key, choices] of Object.entries(allowed)) if (item[key] !== undefined && !choices.includes(item[key] as never))
    throw new Error(`${where}: ${key} must be one of ${choices.join(', ')}`);
  for (const key of ['agent_template', 'brain', 'role', 'cwd', 'model', 'effort']) if (item[key] !== undefined
      && (typeof item[key] !== 'string' || !(item[key] as string).trim())) throw new Error(`${where}: ${key} must be a non-blank string`);
  if (item.overrides !== undefined && (!item.overrides || typeof item.overrides !== 'object' || Array.isArray(item.overrides)))
    throw new Error(`${where}: overrides must be a mapping`);
}

const MAPS = new Set(['permissions', 'env', 'isolation', 'monitor', 'owner_channel', 'worklog', 'auth_proxy']);
function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) throw new Error(`member override ${key}: null deletion is not supported`);
    out[key] = MAPS.has(key) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
      && typeof value === 'object' && !Array.isArray(value)
      ? merge(out[key] as Record<string, unknown>, value as Record<string, unknown>) : structuredClone(value);
  }
  return out;
}

export interface PreparedExecutionPlan {
  snapshot: TemplateSnapshot;
  launchDefinitions: Record<string, AgentTemplateDefinition>;
  overrides: MemberOverrides;
  planHash: string;
  overridesHash: string;
}

export function prepareExecutionPlan(
  template: TemplateDefinition, cfg: FleetConfig, overrides: MemberOverrides = {},
): PreparedExecutionPlan {
  const slots = new Set(template.members.map(member => member.slot));
  for (const slot of Object.keys(overrides)) if (!slots.has(slot)) throw new Error(`unknown member slot '${slot}'`);
  const snapshot = snapshotTemplate(template, cfg.agentTemplates);
  const launchDefinitions: Record<string, AgentTemplateDefinition> = {};
  snapshot.members = snapshot.members.map(member => {
    const input = overrides[member.slot] ?? {};
    const source = input.agent_template ?? member.agent_template;
    const base = cfg.agentTemplates?.[source];
    if (!base) throw new Error(`Agent Template '${source}' not found`);
    let definition = merge(base as unknown as Record<string, unknown>,
      (input.overrides ?? {}) as Record<string, unknown>) as unknown as AgentTemplateDefinition;
    const rolePreset = input.role ? cfg.rolePresets?.[input.role] : undefined;
    if (input.role && !rolePreset) throw new Error(`Role '${input.role}' not found`);
    const brainPreset = input.brain ? cfg.brainPresets?.[input.brain] : undefined;
    if (input.brain && !brainPreset) throw new Error(`Brain '${input.brain}' not found`);
    if (rolePreset) definition.role = { inline: structuredClone(rolePreset) };
    if (brainPreset) definition.brain = { inline: structuredClone(brainPreset) };
    const permissions = { ...(definition.permissions ?? {}) };
    if (input.approval) permissions.approval = input.approval;
    if (input.filesystem) permissions.filesystem = input.filesystem;
    if (input.unattended) permissions.unattended = input.unattended;
    if (Object.keys(permissions).length) definition.permissions = permissions;
    if (input.cwd) definition.cwd = input.cwd;
    if (input.model || input.effort) {
      const brain = 'inline' in definition.brain ? structuredClone(definition.brain.inline) : {};
      if (input.model) brain.model = input.model;
      if (input.effort) brain.effort = input.effort;
      definition.brain = { inline: brain };
    }
    definition = validateEffectiveAgentTemplate(definition, member.slot);
    {
      if (!cfg.resolveAgentDefinition) throw new Error('configuration has no effective Agent resolver');
      const role = cfg.resolveAgentDefinition(`RoomMember_${member.slot}`, {
        ...definition, identity: `RoomMember_${member.slot}`,
      });
      const analysis = analyzeRolePermissions(role);
      if (analysis.conflicts?.length) throw new Error(
        `member '${member.slot}' has native permission conflicts: ${analysis.conflicts.map(item => item.warning).join('; ')}`);
      if (analysis.floor && !analysis.floor.meets && analysis.floorSeverity === 'fail') throw new Error(
        `member '${member.slot}' fails unattended floor: ${analysis.floor.missing.join(', ')}`);
    }
    const id = `${member.slot}:${source}`;
    launchDefinitions[id] = definition;
    const hash = createHash('sha256').update(canonicalJson(definition)).digest('hex');
    return { ...member, agent_template: source, launch_definition_id: id,
      agent_template_hash: hash,
      ...(input.role ? { role_preset: { id: input.role, hash: createHash('sha256').update(canonicalJson(rolePreset)).digest('hex') } } : {}),
      ...(input.brain ? { brain_preset: { id: input.brain, hash: createHash('sha256').update(canonicalJson(brainPreset)).digest('hex') } } : {}),
      agent_projection: redactLaunchDefinition(definition) as Record<string, unknown> };
  });
  const planHash = createHash('sha256').update(canonicalJson({
    template: snapshot.content_hash, members: snapshot.members.map(member => ({
      slot: member.slot, source: member.agent_template, hash: member.agent_template_hash,
    })), overrides,
  })).digest('hex');
  snapshot.content_hash = planHash;
  return { snapshot, launchDefinitions, overridesHash: hashMemberOverrides(overrides),
    overrides: redactLaunchDefinition(overrides) as MemberOverrides, planHash };
}
