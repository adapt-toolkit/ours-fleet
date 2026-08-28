import { createHash } from 'node:crypto';
import type { ConfigResourceSource } from '../config-resource-loader.js';
import {
  parseBrainRef,
  type BrainRef, type RoleResource, type RoomTemplateResource,
} from '../config-resources.js';

const DEFINITIONS = [
  ['team', 'Phased task pipeline: Architect specifies, Developer implements, Tester verifies',
    [['architect', 'Architect'], ['developer', 'Developer'], ['tester', 'Tester']]],
  ['pair', 'Deliberation pair: Secretary writes code and Critic reviews',
    [['secretary', 'Secretary'], ['critic', 'Critic']]],
  ['single', 'Solo agent works the task with owner oversight', [['agent', 'Agent']]],
] as const;

const REQUIRED_ROLE_IDS = Object.freeze([
  'Architect', 'Developer', 'Tester', 'Secretary', 'Critic', 'Agent',
] as const);

export interface BuiltinCompositionResources {
  roles: readonly Readonly<RoleResource>[];
  templates: readonly Readonly<RoomTemplateResource>[];
  sources: readonly Readonly<ConfigResourceSource>[];
}

function deepFreeze<T>(value: T): Readonly<T> {
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

export function createBuiltinCompositionResources(
  suppliedRoles: Readonly<Record<string, Readonly<RoleResource>>>, brain: BrainRef,
): Readonly<BuiltinCompositionResources> {
  const selectedBrain = parseBrainRef(brain, 'built-in room templates', '$.brain');
  if (suppliedRoles === null || typeof suppliedRoles !== 'object' || Array.isArray(suppliedRoles))
    throw new TypeError('built-in room templates: $.roles must be a mapping');
  const suppliedIds = Object.keys(suppliedRoles).sort();
  const requiredIds = [...REQUIRED_ROLE_IDS].sort();
  const missing = requiredIds.filter(id => !Object.hasOwn(suppliedRoles, id));
  const extra = suppliedIds.filter(id => !requiredIds.includes(id as typeof REQUIRED_ROLE_IDS[number]));
  if (missing.length || extra.length)
    throw new TypeError(
      `built-in room templates: $.roles must contain exactly ${requiredIds.join(', ')}`
      + `${missing.length ? `; missing: ${missing.join(', ')}` : ''}`
      + `${extra.length ? `; extra: ${extra.join(', ')}` : ''}`,
    );
  const roles = REQUIRED_ROLE_IDS.map((id): RoleResource => {
    const role = suppliedRoles[id];
    if (role.kind !== 'Role' || role.id !== id || role.version !== 1)
      throw new TypeError(`built-in room templates: $.roles.${id} must be Role version 1 with id '${id}'`);
    return structuredClone(role);
  });
  const templates = DEFINITIONS.map(([id, description, members]): RoomTemplateResource => ({
    kind: 'RoomTemplate', version: 1, id,
    spec: {
      version: 1, description,
      members: members.map(([slot, role]) => ({
        slot, role, count: 1, brain: structuredClone(selectedBrain),
      })),
    },
  }));
  const sources = [...roles, ...templates].map((resource): ConfigResourceSource => {
    const bytes = Buffer.from(JSON.stringify(resource));
    const directory = resource.kind === 'Role' ? 'roles.d' : 'room-templates.d';
    return {
      kind: resource.kind, id: resource.id,
      sourceFile: `builtin:${directory}/${resource.id}.json`,
      relativePath: `${directory}/${resource.id}.json`, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), resource,
    };
  });
  return deepFreeze({ roles, templates, sources });
}
