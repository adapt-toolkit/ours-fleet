import { createHash } from 'node:crypto';
import type { TemplateDefinition, TemplateSnapshot } from './types.js';

export function hashTemplate(t: TemplateDefinition): string {
  const canonical = JSON.stringify({
    name: t.name, version: t.version, description: t.description,
    room: t.room, contract: t.contract, members: t.members,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function snapshotTemplate(t: TemplateDefinition): TemplateSnapshot {
  const { sourceFile: _, ...semantic } = t;
  return { ...semantic, content_hash: hashTemplate(t) };
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
