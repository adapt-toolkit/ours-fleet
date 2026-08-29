export const RESOURCE_KINDS = ['Role', 'Brain', 'Agent', 'RoomTemplate', 'RoomsPolicy', 'TasksPolicy'] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
export type TypedResource = { kind: ResourceKind; version: 1; id: string; display_name?: string; spec: Record<string, unknown> };
const ID = /^[A-Za-z0-9_-]+$/;

export function parseResourceDraft(text: string): TypedResource {
  const value = JSON.parse(text) as Partial<TypedResource>;
  if (!value || typeof value !== 'object' || !RESOURCE_KINDS.includes(value.kind as ResourceKind)
      || value.version !== 1 || typeof value.id !== 'string' || !ID.test(value.id)
      || !value.spec || typeof value.spec !== 'object' || Array.isArray(value.spec))
    throw new Error('Resource must be version 1 with a supported kind, stable id, and spec object.');
  return value as TypedResource;
}

export function blankResource(kind: ResourceKind): TypedResource {
  const spec: Record<ResourceKind, Record<string, unknown>> = {
    Role: { mission: '' }, Brain: { harness: 'codex', model: '', effort: 'medium', session: 'acp' },
    Agent: { role: '', brain: { template: '' }, identity: { name: '', ownership: 'existing' },
      lifecycle: 'persistent', permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' } },
    RoomTemplate: { version: 1, description: '', members: [] },
    RoomsPolicy: { owner: { provider: 'ours', expected_cid: '', role: '' } }, TasksPolicy: {},
  };
  return { kind, version: 1, id: '', spec: spec[kind] };
}

export const stableResources = (resources: TypedResource[]): TypedResource[] => [...resources]
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
