import { createHash } from 'node:crypto';
import type { TemplateDefinition, TemplateSnapshot } from './types.js';
import type { AgentTemplateDefinition } from '../config.js';
import { canonicalJson } from '../canonical-json.js';
import { redactLaunchDefinition, sealLaunchSnapshot } from './launch-snapshot.js';

export function hashTemplate(t: TemplateDefinition): string {
  const canonical = canonicalJson({
    name: t.name, version: t.version, description: t.description,
    room: t.room, contract: t.contract, members: t.members,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function snapshotTemplate(
  t: TemplateDefinition, agentTemplates?: Record<string, AgentTemplateDefinition>,
): TemplateSnapshot {
  const { sourceFile: _, ...semantic } = t;
  return { ...semantic, members: semantic.members.map(member => {
    const definition = agentTemplates?.[member.agent_template];
    return {
      ...member,
      ...(definition ? {
        agent_projection: redactLaunchDefinition(definition) as Record<string, unknown>,
        agent_template_hash: createHash('sha256').update(canonicalJson(definition)).digest('hex'),
      } : {}),
    };
  }), content_hash: agentTemplates ? createHash('sha256').update(canonicalJson({
    template: hashTemplate(t),
    members: semantic.members.map(member => ({
      agent_template: member.agent_template,
      agent_template_hash: agentTemplates?.[member.agent_template]
        ? createHash('sha256').update(canonicalJson(agentTemplates[member.agent_template])).digest('hex')
        : null,
    })),
  })).digest('hex') : hashTemplate(t) };
}

/** Explicit mutation boundary immediately before Task/Room plan persistence. */
export function sealTemplateSnapshot(
  snapshot: TemplateSnapshot, agentTemplates: Record<string, AgentTemplateDefinition>,
  launchDefinitions?: Record<string, AgentTemplateDefinition>,
): TemplateSnapshot {
  const referenced = Object.fromEntries([...new Set(snapshot.members.map(member =>
    member.launch_definition_id ?? member.agent_template))]
    .sort().map(id => {
      const member = snapshot.members.find(candidate =>
        (candidate.launch_definition_id ?? candidate.agent_template) === id)!;
      const definition = launchDefinitions?.[id] ?? agentTemplates[member.agent_template];
      if (!definition) throw new Error(`Agent Template '${id}' not found`);
      return [id, definition];
    }));
  return { ...snapshot, launch_snapshot_hash: sealLaunchSnapshot(referenced) };
}

export function resolveTemplate(
  name: string,
  customTemplates: Record<string, TemplateDefinition>,
): TemplateDefinition | undefined {
  const atIdx = name.lastIndexOf('@');
  const baseName = atIdx > 0 ? name.slice(0, atIdx) : name;
  const versionStr = atIdx > 0 ? name.slice(atIdx + 1) : undefined;
  const version = versionStr ? parseInt(versionStr, 10) : undefined;

  const template = customTemplates[baseName];
  if (!template || (version !== undefined && template.version !== version)) return undefined;
  return template;
}

export function listTemplates(
  customTemplates: Record<string, TemplateDefinition>,
): TemplateDefinition[] {
  return Object.entries(customTemplates)
    .map(([name, template]) => ({ ...template, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
