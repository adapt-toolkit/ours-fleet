import { createHash } from 'node:crypto';
import type { TemplateDefinition, TemplateSnapshot } from './types.js';

const BRIEFING: TemplateDefinition = {
  name: 'briefing',
  version: 1,
  builtin: true,
  description: 'Phased task pipeline: Architect specifies, Developer implements, Tester verifies',
  room: { quiet_membership: false, anonymous: false },
  contract: [
    'Architect produces a spec and posts it to the room. Work pauses for owner approval.',
    'Developer implements per approved spec.',
    'Tester verifies spec conformance and test coverage.',
    'Completion requires tester sign-off.',
  ].join('\n'),
  members: [
    { slot: 'architect', role: 'Architect', count: 1, role_ref: 'Architect' },
    { slot: 'developer', role: 'Developer', count: 1, role_ref: 'Developer' },
    { slot: 'tester', role: 'Tester', count: 1, role_ref: 'Tester' },
  ],
};

const CONSILIUM: TemplateDefinition = {
  name: 'consilium',
  version: 1,
  builtin: true,
  description: 'Deliberation pair: Secretary writes code, Critic reviews — every decision deliberated together',
  room: { quiet_membership: false, anonymous: false },
  contract: [
    'Secretary and Critic deliberate every decision together before acting.',
    'Secretary writes code; Critic reviews and challenges.',
    'No material change lands without both agreeing.',
    'Completion requires joint sign-off.',
  ].join('\n'),
  members: [
    { slot: 'secretary', role: 'Secretary', count: 1, role_ref: 'Secretary' },
    { slot: 'critic', role: 'Critic', count: 1, role_ref: 'Critic' },
  ],
};

export const BUILTIN_TEMPLATES: readonly TemplateDefinition[] = [BRIEFING, CONSILIUM];

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
