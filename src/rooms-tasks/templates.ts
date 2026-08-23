import { createHash } from 'node:crypto';
import type { TemplateDefinition, TemplateSnapshot } from './types.js';

const DEVELOPMENT_TEAM: TemplateDefinition = {
  name: 'development-team',
  version: 1,
  builtin: true,
  description: 'Four equal Developer peers: implement, review, test, and cross-validate',
  room: { quiet_membership: false, anonymous: false },
  contract: [
    'Work in the room. Preserve evidence. Review independently before consensus.',
    'Every material change needs independent review from another peer.',
    'Peers reproduce, test, stress, criticize, and cross-validate each other\'s work.',
    'Evidence and decisions are posted into the Room; detailed scratch work stays in role worklogs.',
    'Completion requires the room\'s agreed acceptance criteria, not merely one agent declaring success.',
  ].join('\n'),
  members: [
    { slot: 'developer', role: 'Developer', count: 4, role_ref: 'Developer' },
  ],
};

const RESEARCH_DECISION: TemplateDefinition = {
  name: 'research-decision',
  version: 1,
  builtin: true,
  description: 'Two Researchers, one Critic, one Synthesizer for evidence-based decisions',
  room: { quiet_membership: false, anonymous: false },
  contract: [
    'Researchers gather independent evidence. Critic attacks assumptions and missing cases.',
    'Synthesizer produces the final decision record with cited evidence, alternatives, and recommendation.',
    'No code mutation is implied by this template.',
    'Completion requires cited evidence, alternatives considered, and an explicit recommendation.',
  ].join('\n'),
  members: [
    { slot: 'researcher', role: 'Researcher', count: 2, role_ref: 'Researcher' },
    { slot: 'critic', role: 'Critic', count: 1, role_ref: 'Critic' },
    { slot: 'synthesizer', role: 'Synthesizer', count: 1, role_ref: 'Synthesizer' },
  ],
};

export const BUILTIN_TEMPLATES: readonly TemplateDefinition[] = [DEVELOPMENT_TEAM, RESEARCH_DECISION];

export function hashTemplate(t: TemplateDefinition): string {
  const canonical = JSON.stringify({
    name: t.name, version: t.version, description: t.description,
    room: t.room, contract: t.contract, members: t.members,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function snapshotTemplate(t: TemplateDefinition): TemplateSnapshot {
  return { ...t, content_hash: hashTemplate(t) };
}

export function resolveTemplate(
  name: string,
  customTemplates: Record<string, TemplateDefinition>,
): TemplateDefinition | undefined {
  const atIdx = name.lastIndexOf('@');
  const baseName = atIdx > 0 ? name.slice(0, atIdx) : name;
  const versionStr = atIdx > 0 ? name.slice(atIdx + 1) : undefined;
  const version = versionStr ? parseInt(versionStr, 10) : undefined;

  const custom = customTemplates[baseName];
  if (custom) {
    if (version !== undefined && custom.version !== version) return undefined;
    return custom;
  }
  const builtin = BUILTIN_TEMPLATES.find(b => b.name === baseName);
  if (builtin) {
    if (version !== undefined && builtin.version !== version) return undefined;
    return builtin;
  }
  return undefined;
}

export function listTemplates(
  customTemplates: Record<string, TemplateDefinition>,
): TemplateDefinition[] {
  const result: TemplateDefinition[] = [];
  const overridden = new Set<string>();
  for (const [name, t] of Object.entries(customTemplates)) {
    result.push({ ...t, name });
    if (BUILTIN_TEMPLATES.some(b => b.name === name)) overridden.add(name);
  }
  for (const b of BUILTIN_TEMPLATES) {
    if (!overridden.has(b.name)) result.push(b);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
