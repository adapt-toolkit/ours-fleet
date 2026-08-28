import type { ConfigResourceSnapshot, ConfigResourceSource } from '../config-resource-loader.js';
import {
  ResourceValidationError,
  type BrainRef, type BrainSpec, type ExplicitBrainRoomTemplateMemberSpec,
  type RoleSpec, type RoomTemplateMemberSpec,
} from '../config-resources.js';

export interface ResolvedResourcePreview<T> {
  id: string;
  spec: Readonly<T>;
  sourceFile: string;
  sha256: string;
}

export interface RoomMemberCompositionPreview {
  member: Readonly<ExplicitBrainRoomTemplateMemberSpec>;
  role: Readonly<ResolvedResourcePreview<RoleSpec>>;
  brain: Readonly<{
    spec: Readonly<BrainSpec>;
    selection: 'named' | 'inline';
    sourceId: string;
    sourceFile?: string;
    sha256?: string;
  }>;
}

function ownedFrozen<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function sourceFor(
  snapshot: ConfigResourceSnapshot, kind: 'Role' | 'Brain', id: string,
  source: string, path: string,
): Readonly<ConfigResourceSource> {
  const found = snapshot.sources.find(candidate => candidate.kind === kind && candidate.id === id);
  if (!found)
    throw new ResourceValidationError(source, path, `${kind} resource '${id}' has no snapshot source evidence`);
  return found;
}

export function previewRoomMemberComposition(
  snapshot: ConfigResourceSnapshot,
  member: Readonly<RoomTemplateMemberSpec>,
  source = 'room member',
  path = '$.member',
): Readonly<RoomMemberCompositionPreview> {
  if (member.brain === undefined)
    throw new ResourceValidationError(source, `${path}.brain`, 'an explicit atomic Brain selection is required');
  const role = snapshot.resources.Role?.[member.role];
  if (!role || role.kind !== 'Role')
    throw new ResourceValidationError(source, `${path}.role`, `Role resource '${member.role}' not found`);
  const roleSource = sourceFor(snapshot, 'Role', member.role, source, `${path}.role`);
  const rolePreview = ownedFrozen({
    id: role.id, spec: role.spec, sourceFile: roleSource.sourceFile, sha256: roleSource.sha256,
  });

  const selection: BrainRef = member.brain;
  let brainPreview: RoomMemberCompositionPreview['brain'];
  if ('template' in selection) {
    const brain = snapshot.resources.Brain?.[selection.template];
    if (!brain || brain.kind !== 'Brain')
      throw new ResourceValidationError(
        source, `${path}.brain.template`, `Brain resource '${selection.template}' not found`,
      );
    const brainSource = sourceFor(
      snapshot, 'Brain', selection.template, source, `${path}.brain.template`,
    );
    brainPreview = ownedFrozen({
      spec: brain.spec, selection: 'named' as const, sourceId: brain.id,
      sourceFile: brainSource.sourceFile, sha256: brainSource.sha256,
    });
  } else {
    brainPreview = ownedFrozen({
      spec: selection, selection: 'inline' as const, sourceId: `${source}:${path}.brain:inline`,
    });
  }

  return ownedFrozen({
    member: member as ExplicitBrainRoomTemplateMemberSpec, role: rolePreview, brain: brainPreview,
  });
}
