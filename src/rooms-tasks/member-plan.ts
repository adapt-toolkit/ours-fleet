import { createHash } from 'node:crypto';
import type { ConfigResourceSnapshot } from '../config-resource-loader.js';
import type { ExplicitBrainRoomTemplateMemberSpec, PermissionSpec } from '../config-resources.js';
import type { AgentProductionRuntime } from '../agent-production-runtime.js';
import type { ProductionIngressContext } from '../agent-creation-composition-root.js';
import type { AgentCompositionRequest } from '../agent-composition-service.js';
import { runtimeCanonical } from '../agent-runtime-record.js';
import { previewRoomMemberComposition } from './member-composition.js';
import type { CanonicalRoomMemberPlanBinding } from './types.js';

export interface CanonicalRoomMemberPlanInput {
  snapshot: ConfigResourceSnapshot;
  templateId: string;
  member: Readonly<ExplicitBrainRoomTemplateMemberSpec>;
  roomId: string;
  taskId?: string;
  memberId: string;
  identityName: string;
  ordinal: number;
  actionId: string;
  issuedAt: number;
}

const digest = (value: unknown): string => `sha256:${createHash('sha256')
  .update(runtimeCanonical(value)).digest('hex')}`;

function completePermissions(value: ExplicitBrainRoomTemplateMemberSpec['permissions']): PermissionSpec {
  if (!value || value.approval === undefined || value.filesystem === undefined
      || value.unattended === undefined)
    throw new TypeError('canonical room member requires complete permissions');
  return value as PermissionSpec;
}

export async function reserveCanonicalRoomMemberPlan(
  runtime: AgentProductionRuntime, input: Readonly<CanonicalRoomMemberPlanInput>,
): Promise<Readonly<CanonicalRoomMemberPlanBinding>> {
  const preview = previewRoomMemberComposition(
    input.snapshot, input.member, `RoomTemplate/${input.templateId}`, '$.member',
  );
  const permissions = completePermissions(input.member.permissions);
  const operation = Object.freeze({
    id: input.actionId, type: 'room.member.reserve',
    resourceScope: `rooms/${input.roomId}/members/${input.memberId}`,
  });
  const authorizationRevision = digest({ operation, snapshot: input.snapshot.digest });
  const context: ProductionIngressContext = Object.freeze({
    operation, authorizationRevision, snapshot: input.snapshot,
    snapshotRevision: input.snapshot.digest, issuedAt: input.issuedAt,
  });
  const request: Omit<AgentCompositionRequest, 'callerEvidence'> = Object.freeze({
    source: Object.freeze({
      kind: 'runtime_composition' as const, agentId: input.memberId, role: preview.role.id,
      identity: Object.freeze({ name: input.identityName, ownership: 'create_temporary' as const }),
      lifecycle: 'temporary' as const, brain: input.member.brain, permissions,
    }),
    templateMember: Object.freeze({
      source: Object.freeze({
        kind: 'resource' as const, resourceKind: 'RoomTemplate' as const, resourceId: input.templateId,
      }),
      brain: input.member.brain, permissions,
    }),
    ...(input.member.role_context ? { roleContext: Object.freeze({ template: Object.freeze({
      source: Object.freeze({
        kind: 'resource' as const, resourceKind: 'RoomTemplate' as const,
        resourceId: input.templateId,
      }), ...input.member.role_context,
    }) }) } : {}),
    membership: Object.freeze({
      roomId: input.roomId, ...(input.taskId ? { taskId: input.taskId } : {}),
      slot: input.member.slot, ordinal: input.ordinal, memberId: input.memberId,
    }),
  });
  const handoff = await runtime.reserveTemporaryComposition({
    context, request, actionId: input.actionId,
  });
  return Object.freeze({
    kind: 'canonical_agent_plan', agent_id: handoff.agentId, generation: handoff.generation,
    action_id: handoff.actionId, plan_digest: handoff.planDigest,
    snapshot_digest: handoff.snapshotDigest, brain_digest: digest(preview.brain.spec),
    role_id: preview.role.id, reservation_digest: handoff.reservationDigest,
    handoff_digest: handoff.handoffDigest, authorization_revision: handoff.authorizationRevision,
    identity_ownership: 'create_temporary',
  });
}
