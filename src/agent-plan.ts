import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import {
  MAX_ROLE_TEXT_BYTES, parseBrainRef, parseTypedResource,
  type AgentRuntimeSpec, type BrainRef, type BrainSpec,
  type PartialPermissionSpec, type PermissionSpec, type RoleContextSpec,
  type ResourceKind, type RoleResource,
} from './config-resources.js';
import type { ConfigResourceSnapshot } from './config-resource-loader.js';

export const AGENT_PLAN_SCHEMA_VERSION = 1;
export const ROLE_CONTEXT_SEPARATOR = '\n\n--- instance context ---\n\n';
const MAX_ID_BYTES = 256;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export type ResolutionLayer =
  | 'explicit_operation' | 'task_default' | 'room_default' | 'template_member' | 'creator';
export type PermissionField = keyof PermissionSpec;
const PROVENANCE_RESOURCE_KIND: Readonly<Record<Exclude<ResolutionLayer, 'creator'>, ResourceKind>> = {
  explicit_operation: 'Agent', task_default: 'TasksPolicy',
  room_default: 'RoomsPolicy', template_member: 'RoomTemplate',
};
const APPEND_RESOURCE_KIND = {
  template: 'RoomTemplate', room: 'RoomsPolicy', task_member: 'TasksPolicy',
} as const;

export interface RuntimeIdentityIntent {
  name: string;
  ownership: 'existing' | 'create_persistent' | 'create_temporary';
}

export type AgentPlanSource =
  | { kind: 'persistent_resource'; agentId: string }
  | {
    kind: 'runtime_composition';
    agentId: string;
    role: string;
    identity: RuntimeIdentityIntent;
    lifecycle: 'persistent' | 'temporary';
    runtime?: AgentRuntimeSpec;
    brain?: BrainRef;
    permissions?: PartialPermissionSpec;
  };

export interface CompositionLayerInput {
  source: LayerSourceEvidence;
  brain?: BrainRef;
  permissions?: PartialPermissionSpec;
}

export type LayerResourceKind = 'Agent' | 'RoomTemplate' | 'RoomsPolicy' | 'TasksPolicy';
export type LayerSourceEvidence =
  | { kind: 'resource'; resourceKind: LayerResourceKind; resourceId: string }
  | { kind: 'current_operation' };

export interface RoleContextLayerInput extends RoleContextSpec {
  /** Stable source identity recorded in the plan. */
  source: LayerSourceEvidence;
}

export interface RequestPrincipal {
  id: string;
  kind: 'agent' | 'owner' | 'system';
}

export interface PlanOperation {
  id: string;
  type: string;
  resourceScope: string;
}

export interface AgentMembership {
  roomId?: string;
  taskId?: string;
  slot?: string;
  ordinal?: number;
  memberId?: string;
}

export interface AdapterValidationRecord {
  redacted: true;
  adapterId: string;
  adapterVersion: string;
  policyRevision: string;
  policyDigest: string;
  brainDigest: string;
  permissionsDigest: string;
  portableDescriptor: Readonly<PermissionSpec>;
  nativeDescriptor: Readonly<{
    approvalMode: 'ask' | 'auto' | 'allow' | 'untrusted' | 'on-request' | 'never'
      | 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan';
    filesystemMode: 'read-only' | 'workspace' | 'unrestricted'
      | 'sandbox-read' | 'sandbox-workspace' | 'sandbox-unrestricted' | 'external-isolation';
    unattendedMode: 'deny' | 'wait' | 'native-deny' | 'native-block';
    exact: boolean;
  }>;
  enforcement: Readonly<Record<PermissionField, Readonly<{
    owner: 'native_adapter' | 'fleet_isolation' | 'body_controller';
    policyDigest: string;
  }>>>;
}

export interface OwnerDelegationGrant {
  grantId: string;
  authenticatedOwnerCid: string;
  subjectPrincipalId: string;
  operationId: string;
  operationType: string;
  resourceScope: string;
  revision: string;
  expiresAt: number;
  ceilings: PartialPermissionSpec;
}

export interface TrustedCreatorPlanBindings {
  agentId: string;
  generation: number;
  planDigest: string;
  snapshotDigest: string;
}

export interface TrustedOwnerDelegationBindings {
  pinnedOwnerCid: string;
  subjectPrincipalId: string;
  operationId: string;
  operationType: string;
  resourceScope: string;
  authorizationRevision: string;
}

declare const creatorEvidenceBrand: unique symbol;
declare const ownerEvidenceBrand: unique symbol;
export interface VerifiedCreatorPlanEvidence {
  readonly [creatorEvidenceBrand]: true;
}
export interface VerifiedOwnerDelegationEvidence {
  readonly [ownerEvidenceBrand]: true;
}

export interface AgentPlanEvidenceAuthority {
  authenticateCreator(evidence: VerifiedCreatorPlanEvidence): Readonly<{
    plan: AgentPlan;
    trusted: Readonly<TrustedCreatorPlanBindings>;
  }> | undefined;
  authenticateOwnerDelegation(evidence: VerifiedOwnerDelegationEvidence): Readonly<{
    grant: Readonly<OwnerDelegationGrant>;
    trusted: Readonly<TrustedOwnerDelegationBindings>;
  }> | undefined;
}

export interface AgentPlanResolutionInput {
  snapshot: ConfigResourceSnapshot;
  source: AgentPlanSource;
  explicitOperation?: CompositionLayerInput;
  taskDefault?: CompositionLayerInput;
  roomDefault?: CompositionLayerInput;
  templateMember?: CompositionLayerInput;
  roleContext?: {
    template?: RoleContextLayerInput;
    room?: RoleContextLayerInput;
    taskMember?: RoleContextLayerInput;
  };
  creatorEvidence?: VerifiedCreatorPlanEvidence;
  principal: RequestPrincipal;
  operation: PlanOperation;
  authorizationRevision: string;
  ownerDelegationEvidence?: VerifiedOwnerDelegationEvidence;
  membership?: AgentMembership;
  generation: number;
  evaluatedAt: number;
  adapter: AdapterValidationRecord;
}

export type AgentPlanCompositionInput = Omit<AgentPlanResolutionInput,
  'snapshot' | 'principal' | 'operation' | 'authorizationRevision' | 'generation'
  | 'evaluatedAt' | 'adapter'>;
export interface TrustedAgentPlanContext {
  snapshot: ConfigResourceSnapshot;
  principal: RequestPrincipal;
  operation: PlanOperation;
  authorizationRevision: string;
  generation: number;
  evaluatedAt: number;
}
export interface AgentPlanAdapterResolver {
  resolve(brain: Readonly<BrainSpec>, permissions: Readonly<PermissionSpec>): AdapterValidationRecord;
}

export interface ValueProvenance {
  layer: ResolutionLayer;
  sourceType: 'resource' | 'runtime_operation' | 'creator_plan';
  sourceId: string;
  sourceDigest?: string;
  principalId?: string;
  operationId?: string;
  creatorAgentId?: string;
  creatorGeneration?: number;
  creatorPlanDigest?: string;
  creatorSnapshotDigest?: string;
}

export type BrainSelection =
  | { kind: 'inline' }
  | { kind: 'template'; brainId: string }
  | { kind: 'creator_plan' };
export type BrainProvenance = ValueProvenance & { brainSelection: BrainSelection };

export interface RoleAppendProvenance {
  layer: 'template' | 'room' | 'task_member';
  sourceType: 'resource' | 'runtime_operation';
  sourceId: string;
  sourceDigest?: string;
  missionBytes: number;
  personaBytes: number;
}

export interface PermissionDelegationRecord {
  field: PermissionField;
  requested: string;
  effective: string;
  creator?: string;
  grantCeiling?: string;
  decision: 'no_creator_explicit' | 'within_creator' | 'owner_grant';
  grantId?: string;
}

export interface AgentPlan {
  schemaVersion: 1;
  agentId: string;
  generation: number;
  snapshotDigest: string;
  source: Readonly<AgentPlanSource>;
  sourceRevisions: readonly Readonly<{ kind: ResourceKind; id: string; relativePath: string; sha256: string }>[];
  role: Readonly<{
    id: string;
    effective: Readonly<RoleResource['spec']>;
    appendProvenance: readonly Readonly<RoleAppendProvenance>[];
    missionBytes: number;
    personaBytes: number;
  }>;
  brain: Readonly<BrainSpec>;
  brainProvenance: Readonly<BrainProvenance>;
  identity: Readonly<RuntimeIdentityIntent>;
  lifecycle: 'persistent' | 'temporary';
  runtime?: Readonly<AgentRuntimeSpec>;
  permissions: Readonly<PermissionSpec>;
  permissionProvenance: Readonly<Record<PermissionField, Readonly<ValueProvenance>>>;
  delegation: Readonly<Record<PermissionField, Readonly<PermissionDelegationRecord>>>;
  principal: Readonly<RequestPrincipal>;
  operation: Readonly<PlanOperation>;
  authorizationRevision: string;
  membership?: Readonly<AgentMembership>;
  adapter: Readonly<AdapterValidationRecord>;
  ownerDelegation?: Readonly<{
    grant: Readonly<OwnerDelegationGrant>;
    trusted: Readonly<TrustedOwnerDelegationBindings>;
  }>;
  evaluatedAt: number;
  planDigest: string;
}

export class AgentPlanResolutionError extends Error {}

type AuthorizedResolutionInput = Omit<
  AgentPlanResolutionInput, 'creatorEvidence' | 'ownerDelegationEvidence'
> & {
  creatorEvidence?: Readonly<{ plan: AgentPlan; trusted: Readonly<TrustedCreatorPlanBindings> }>;
  ownerDelegationEvidence?: Readonly<{
    grant: Readonly<OwnerDelegationGrant>; trusted: Readonly<TrustedOwnerDelegationBindings>;
  }>;
};

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentPlanResolutionError(`${name} must be an object`);
  const raw = value as Record<string, unknown>;
  const extras = Object.keys(raw).filter(key => !keys.includes(key));
  if (extras.length) throw new AgentPlanResolutionError(`${name} has unknown key(s): ${extras.sort().join(', ')}`);
  for (const [key, child] of Object.entries(raw)) {
    if (child === undefined) throw new AgentPlanResolutionError(`${name}.${key} must not be undefined`);
  }
  return raw;
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value) || Buffer.byteLength(value) > MAX_ID_BYTES)
    throw new AgentPlanResolutionError(`${name} must be a bounded stable ASCII token`);
  return value;
}

function scope(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SCOPE.test(value) || value.includes('..')
      || Buffer.byteLength(value) > MAX_ID_BYTES)
    throw new AgentPlanResolutionError(`${name} must be a bounded canonical resource scope`);
  return value;
}

function resourceId(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new AgentPlanResolutionError(`${name} must be a resource ID`);
  const parsed = parseTypedResource(`agent-plan:${name}`, stringify({
    kind: 'Role', version: 1, id: value, spec: {},
  }));
  return parsed.id;
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length || value !== value.trim()
      || Buffer.byteLength(value) > MAX_ID_BYTES || /[\r\n\0]/u.test(value))
    throw new AgentPlanResolutionError(`${name} must be a bounded non-empty single-line string`);
  return value;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256.test(value))
    throw new AgentPlanResolutionError(`${name} must be a sha256 digest`);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentPlanResolutionError('canonical numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new AgentPlanResolutionError('canonical value is not JSON');
  return `{${Object.keys(value as object).sort().map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new AgentPlanResolutionError(`canonical field '${key}' is undefined`);
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}

const hash = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T { return JSON.parse(canonical(value)) as T; }

function completePermissions(value: PartialPermissionSpec | undefined): value is PermissionSpec {
  return !!value && value.approval !== undefined && value.filesystem !== undefined
    && value.unattended !== undefined;
}

function normalizedPartialPermissions(
  value: PartialPermissionSpec | undefined, sourceId: string, roleId: string,
): PartialPermissionSpec | undefined {
  if (value === undefined) return undefined;
  const resource = parseTypedResource(`agent-plan:${sourceId}`, stringify({
    kind: 'RoomTemplate', version: 1, id: 'validation',
    spec: { version: 1, description: 'validation', members: [
      { slot: 'validation', role: roleId, count: 1, permissions: value },
    ] },
  }));
  if (resource.kind !== 'RoomTemplate') throw new AgentPlanResolutionError('internal permission validation failed');
  return resource.spec.members[0].permissions;
}

function normalizedRuntime(value: AgentRuntimeSpec | undefined, sourceId: string): AgentRuntimeSpec | undefined {
  if (value === undefined) return undefined;
  const resource = parseTypedResource(`agent-plan:${sourceId}`, stringify({
    kind: 'Agent', version: 1, id: 'validation', spec: {
      role: 'validation', brain: { harness: 'validation', model: 'validation', effort: 'validation', session: 'validation' },
      identity: { name: 'validation', ownership: 'existing' }, lifecycle: 'persistent',
      permissions: { approval: 'ask', filesystem: 'read-only', unattended: 'deny' }, runtime: value,
    },
  }));
  if (resource.kind !== 'Agent') throw new AgentPlanResolutionError('internal runtime validation failed');
  return resource.spec.runtime;
}

function normalizeBrain(value: BrainRef, snapshot: ConfigResourceSnapshot, name: string): {
  brain: BrainSpec; sourceId: string; sourceRevisionId?: string;
} {
  const parsed = parseBrainRef(value, name, '$');
  if (!('template' in parsed)) return { brain: parsed, sourceId: `${name}:inline` };
  const resource = snapshot.resources.Brain?.[parsed.template];
  if (!resource || resource.kind !== 'Brain')
    throw new AgentPlanResolutionError(`${name} references unknown Brain '${parsed.template}'`);
  return { brain: clone(resource.spec), sourceId: parsed.template, sourceRevisionId: parsed.template };
}

function provenance(
  layer: ResolutionLayer, source: LayerSourceEvidence | undefined, input: AuthorizedResolutionInput,
): ValueProvenance {
  return layer === 'creator' ? {
    layer, sourceType: 'creator_plan', sourceId: input.creatorEvidence!.plan.agentId,
    creatorAgentId: input.creatorEvidence!.plan.agentId,
    creatorGeneration: input.creatorEvidence!.plan.generation,
    creatorPlanDigest: input.creatorEvidence!.plan.planDigest,
    creatorSnapshotDigest: input.creatorEvidence!.plan.snapshotDigest,
  } : source?.kind === 'resource' ? {
    layer, sourceType: 'resource', sourceId: source.resourceId,
    principalId: input.principal.id, operationId: input.operation.id,
  } : {
    layer, sourceType: 'runtime_operation', sourceId: input.operation.id,
    sourceDigest: hash(input.operation),
    principalId: input.principal.id, operationId: input.operation.id,
  };
}

function validateLayerSource(
  source: LayerSourceEvidence, name: string, input: AuthorizedResolutionInput,
  allowedResourceKinds: readonly LayerResourceKind[], requireCurrentOperation = false,
): void {
  object(source, `${name}.source`, source.kind === 'resource'
    ? ['kind', 'resourceKind', 'resourceId'] : ['kind']);
  if (source.kind !== 'resource' && source.kind !== 'current_operation')
    throw new AgentPlanResolutionError(`${name}.source.kind is invalid`);
  if (source.kind === 'resource') {
    if (!allowedResourceKinds.includes(source.resourceKind))
      throw new AgentPlanResolutionError(`${name}.source.resourceKind is invalid for this layer`);
    resourceId(source.resourceId, `${name}.source.resourceId`);
    const revision = input.snapshot.sources.find(candidate =>
      candidate.kind === source.resourceKind && candidate.id === source.resourceId);
    if (!revision)
      throw new AgentPlanResolutionError(
        `${name} requires ${source.resourceKind} '${source.resourceId}' source revision`);
  } else if (!requireCurrentOperation)
    throw new AgentPlanResolutionError(`${name}.source current_operation is not allowed for this layer`);
}

function validateAdapter(
  value: AdapterValidationRecord, brain: BrainSpec, permissions?: PermissionSpec,
): AdapterValidationRecord {
  object(value, 'adapter', [
    'redacted', 'adapterId', 'adapterVersion', 'policyRevision', 'policyDigest', 'brainDigest',
    'permissionsDigest', 'portableDescriptor', 'nativeDescriptor', 'enforcement',
  ]);
  if (value.redacted !== true) throw new AgentPlanResolutionError('adapter result must be explicitly redacted');
  for (const field of ['adapterId', 'adapterVersion', 'policyRevision'] as const) token(value[field], `adapter.${field}`);
  digest(value.policyDigest, 'adapter.policyDigest');
  digest(value.brainDigest, 'adapter.brainDigest');
  digest(value.permissionsDigest, 'adapter.permissionsDigest');
  if (value.brainDigest !== hash(brain)) throw new AgentPlanResolutionError('adapter result is bound to another Brain');
  if (permissions && value.permissionsDigest !== hash(permissions))
    throw new AgentPlanResolutionError('adapter result is bound to another permission policy');
  object(value.portableDescriptor, 'adapter.portableDescriptor', ['approval', 'filesystem', 'unattended']);
  const portable = normalizedPartialPermissions(value.portableDescriptor, value.adapterId, 'validation');
  if (!completePermissions(portable) || (permissions && canonical(portable) !== canonical(permissions)))
    throw new AgentPlanResolutionError('adapter portable descriptor is not bound to effective permissions');
  object(value.nativeDescriptor, 'adapter.nativeDescriptor', [
    'approvalMode', 'filesystemMode', 'unattendedMode', 'exact',
  ]);
  if (![
    'ask', 'auto', 'allow', 'untrusted', 'on-request', 'never', 'default', 'acceptEdits',
    'dontAsk', 'bypassPermissions', 'plan',
  ].includes(value.nativeDescriptor.approvalMode))
    throw new AgentPlanResolutionError('adapter native approval mode code is invalid');
  if (![
    'read-only', 'workspace', 'unrestricted', 'sandbox-read', 'sandbox-workspace',
    'sandbox-unrestricted', 'external-isolation',
  ].includes(value.nativeDescriptor.filesystemMode))
    throw new AgentPlanResolutionError('adapter native filesystem mode code is invalid');
  if (!['deny', 'wait', 'native-deny', 'native-block'].includes(value.nativeDescriptor.unattendedMode))
    throw new AgentPlanResolutionError('adapter native unattended mode code is invalid');
  if (typeof value.nativeDescriptor.exact !== 'boolean')
    throw new AgentPlanResolutionError('adapter native descriptor exact must be boolean');
  if (value.nativeDescriptor.exact !== true)
    throw new AgentPlanResolutionError('adapter native descriptor must prove exact enforcement');
  object(value.enforcement, 'adapter.enforcement', ['approval', 'filesystem', 'unattended']);
  for (const field of ['approval', 'filesystem', 'unattended'] as const) {
    const enforcement = value.enforcement[field];
    object(enforcement, `adapter.enforcement.${field}`, ['owner', 'policyDigest']);
    if (!['native_adapter', 'fleet_isolation', 'body_controller'].includes(enforcement.owner))
      throw new AgentPlanResolutionError(`adapter.enforcement.${field}.owner is invalid`);
    if (enforcement.policyDigest !== value.policyDigest)
      throw new AgentPlanResolutionError(`adapter.enforcement.${field} is bound to another policy`);
    if (field === 'unattended' && enforcement.owner !== 'body_controller')
      throw new AgentPlanResolutionError('adapter unattended enforcement must belong to body_controller');
    if (field === 'approval' && enforcement.owner !== 'native_adapter')
      throw new AgentPlanResolutionError('adapter approval enforcement must belong to native_adapter');
    if (field === 'filesystem') {
      const expectedOwner = value.nativeDescriptor.filesystemMode === 'external-isolation'
        ? 'fleet_isolation' : 'native_adapter';
      if (enforcement.owner !== expectedOwner)
        throw new AgentPlanResolutionError(`adapter filesystem enforcement must belong to ${expectedOwner}`);
    }
  }
  return clone(value);
}

/**
 * Validate every persisted AgentPlan field and cross-field binding.
 *
 * This is deterministic integrity validation only. It does not authenticate the
 * plan, revive an authorization grant, or issue either opaque evidence type.
 */
export function validateAgentPlanStructure(plan: AgentPlan): void {
  const required = [
    'schemaVersion', 'agentId', 'generation', 'snapshotDigest', 'source', 'sourceRevisions', 'role',
    'brain', 'brainProvenance', 'identity', 'lifecycle', 'permissions', 'permissionProvenance',
    'delegation', 'principal', 'operation', 'authorizationRevision', 'adapter', 'evaluatedAt', 'planDigest',
  ];
  const optional = ['runtime', 'membership', 'ownerDelegation'].filter(key => own(plan, key));
  object(plan, 'creatorPlan', [...required, ...optional]);
  if (required.some(key => !own(plan, key)))
    throw new AgentPlanResolutionError('creator plan is missing required fields');
  if (plan.schemaVersion !== 1 || !Number.isSafeInteger(plan.generation) || plan.generation < 1)
    throw new AgentPlanResolutionError('creator plan has invalid schema or generation');
  if (!Number.isSafeInteger(plan.evaluatedAt) || plan.evaluatedAt < 0)
    throw new AgentPlanResolutionError('creator plan evaluatedAt is invalid');
  if (!['persistent', 'temporary'].includes(plan.lifecycle))
    throw new AgentPlanResolutionError('creator plan lifecycle is invalid');
  resourceId(plan.agentId, 'creatorPlan.agentId');
  digest(plan.snapshotDigest, 'creatorPlan.snapshotDigest');
  digest(plan.planDigest, 'creatorPlan.planDigest');
  if (!completePermissions(plan.permissions)) throw new AgentPlanResolutionError('creator plan permissions are incomplete');
  object(plan.role, 'creatorPlan.role', [
    'id', 'effective', 'appendProvenance', 'missionBytes', 'personaBytes',
  ]);
  object(plan.source, 'creatorPlan.source', [
    'kind', 'agentId', 'role', 'identity', 'lifecycle', 'runtime', 'brain', 'permissions',
  ]);
  const { planDigest, ...unsigned } = plan;
  if (hash(unsigned) !== planDigest) throw new AgentPlanResolutionError('creator plan digest is stale or tampered');
  normalizedPartialPermissions(plan.permissions, plan.agentId, plan.role.id);
  validateAdapter(plan.adapter, plan.brain, plan.permissions);
  resourceId(plan.role.id, 'creatorPlan.role.id');
  const parsedRole = parseTypedResource('agent-plan:persisted-role', stringify({
    kind: 'Role', version: 1, id: plan.role.id, spec: plan.role.effective,
  }));
  if (parsedRole.kind !== 'Role' || canonical(parsedRole.spec) !== canonical(plan.role.effective))
    throw new AgentPlanResolutionError('creator plan effective Role is invalid');
  if (!Array.isArray(plan.role.appendProvenance))
    throw new AgentPlanResolutionError('creator plan Role append provenance must be an array');
  if (!Number.isSafeInteger(plan.role.missionBytes) || plan.role.missionBytes < 0
      || !Number.isSafeInteger(plan.role.personaBytes) || plan.role.personaBytes < 0
      || plan.role.missionBytes !== Buffer.byteLength(plan.role.effective.mission ?? '')
      || plan.role.personaBytes !== Buffer.byteLength(plan.role.effective.persona ?? ''))
    throw new AgentPlanResolutionError('creator plan effective Role byte counts are inconsistent');
  for (const [index, append] of plan.role.appendProvenance.entries()) {
    object(append, `creatorPlan.role.appendProvenance[${index}]`, [
      'layer', 'sourceType', 'sourceId',
      ...(own(append, 'sourceDigest') ? ['sourceDigest'] : []), 'missionBytes', 'personaBytes',
    ]);
    if (!['template', 'room', 'task_member'].includes(append.layer)
        || !['resource', 'runtime_operation'].includes(append.sourceType))
      throw new AgentPlanResolutionError(`creatorPlan.role.appendProvenance[${index}] is invalid`);
    token(append.sourceId, `creatorPlan.role.appendProvenance[${index}].sourceId`);
    if (append.sourceType === 'runtime_operation') digest(append.sourceDigest,
      `creatorPlan.role.appendProvenance[${index}].sourceDigest`);
    else if (own(append, 'sourceDigest'))
      throw new AgentPlanResolutionError(`creatorPlan.role.appendProvenance[${index}] resource has a digest`);
    if (!Number.isSafeInteger(append.missionBytes) || append.missionBytes < 0
        || !Number.isSafeInteger(append.personaBytes) || append.personaBytes < 0)
      throw new AgentPlanResolutionError(`creatorPlan.role.appendProvenance[${index}] byte count is invalid`);
    if (append.sourceType === 'runtime_operation' && append.sourceDigest !== hash(plan.operation))
      throw new AgentPlanResolutionError(`creatorPlan.role.appendProvenance[${index}] operation binding is inconsistent`);
  }
  const appendOrder = { template: 0, room: 1, task_member: 2 } as const;
  if (plan.role.appendProvenance.some((append, index, all) =>
    index > 0 && appendOrder[append.layer as keyof typeof appendOrder]
      <= appendOrder[all[index - 1].layer as keyof typeof appendOrder]))
    throw new AgentPlanResolutionError('creator plan Role append provenance is not in fixed order');
  if (plan.role.appendProvenance.reduce((sum, append) => sum + append.missionBytes, 0) > plan.role.missionBytes
      || plan.role.appendProvenance.reduce((sum, append) => sum + append.personaBytes, 0) > plan.role.personaBytes)
    throw new AgentPlanResolutionError('creator plan Role append byte counts exceed effective Role');
  const parsedBrain = parseTypedResource('agent-plan:persisted-brain', stringify({
    kind: 'Brain', version: 1, id: 'validation', spec: plan.brain,
  }));
  if (parsedBrain.kind !== 'Brain' || canonical(parsedBrain.spec) !== canonical(plan.brain))
    throw new AgentPlanResolutionError('creator plan Brain is invalid');
  if (plan.source.agentId !== plan.agentId)
    throw new AgentPlanResolutionError('creator plan source is bound to another Agent ID');
  if (plan.source.kind !== 'persistent_resource' && plan.source.kind !== 'runtime_composition')
    throw new AgentPlanResolutionError('creator plan source kind is invalid');
  object(plan.source, 'creatorPlan.source', plan.source.kind === 'persistent_resource'
    ? ['kind', 'agentId'] : ['kind', 'agentId', 'role', 'identity', 'lifecycle', 'runtime', 'brain', 'permissions']);
  resourceId(plan.source.agentId, 'creatorPlan.source.agentId');
  if (plan.source.kind === 'persistent_resource' && plan.lifecycle !== 'persistent')
    throw new AgentPlanResolutionError('persistent Agent source must have persistent lifecycle');
  if (plan.source.kind === 'runtime_composition') {
    if (plan.source.role !== plan.role.id || canonical(plan.source.identity) !== canonical(plan.identity)
        || plan.source.lifecycle !== plan.lifecycle)
      throw new AgentPlanResolutionError('creator plan source, Role, IdentityIntent, or lifecycle binding is inconsistent');
    resourceId(plan.source.role, 'creatorPlan.source.role');
    object(plan.source.identity, 'creatorPlan.source.identity', ['name', 'ownership']);
    boundedText(plan.source.identity.name, 'creatorPlan.source.identity.name');
    if (plan.source.runtime) normalizedRuntime(plan.source.runtime, plan.agentId);
    if (plan.source.brain) parseBrainRef(plan.source.brain, 'creatorPlan.source.brain', '$');
    if (plan.source.permissions) normalizedPartialPermissions(plan.source.permissions, plan.agentId, plan.role.id);
  }
  if (canonical(plan.runtime ?? null) !== canonical(
    plan.source.kind === 'runtime_composition' ? plan.source.runtime ?? null : plan.runtime ?? null))
    throw new AgentPlanResolutionError('creator plan runtime binding is inconsistent');
  if (plan.runtime) normalizedRuntime(plan.runtime, plan.agentId);
  object(plan.identity, 'creatorPlan.identity', ['name', 'ownership']);
  boundedText(plan.identity.name, 'creatorPlan.identity.name');
  if (!['existing', 'create_persistent', 'create_temporary'].includes(plan.identity.ownership))
    throw new AgentPlanResolutionError('creator plan IdentityIntent ownership is invalid');
  if ((plan.lifecycle === 'temporary' && plan.identity.ownership === 'create_persistent')
      || (plan.lifecycle === 'persistent' && plan.identity.ownership === 'create_temporary'))
    throw new AgentPlanResolutionError('creator plan lifecycle and IdentityIntent are inconsistent');
  object(plan.principal, 'creatorPlan.principal', ['id', 'kind']); token(plan.principal.id, 'creatorPlan.principal.id');
  if (!['agent', 'owner', 'system'].includes(plan.principal.kind))
    throw new AgentPlanResolutionError('creator plan principal.kind is invalid');
  object(plan.operation, 'creatorPlan.operation', ['id', 'type', 'resourceScope']);
  token(plan.operation.id, 'creatorPlan.operation.id'); token(plan.operation.type, 'creatorPlan.operation.type');
  scope(plan.operation.resourceScope, 'creatorPlan.operation.resourceScope');
  token(plan.authorizationRevision, 'creatorPlan.authorizationRevision');
  if (!Array.isArray(plan.sourceRevisions))
    throw new AgentPlanResolutionError('creator plan source revisions must be an array');
  for (const [index, source] of plan.sourceRevisions.entries()) {
    object(source, `creatorPlan.sourceRevisions[${index}]`, ['kind', 'id', 'relativePath', 'sha256']);
    if (!['Role', 'Brain', 'Agent', 'RoomTemplate', 'RoomsPolicy', 'TasksPolicy'].includes(source.kind))
      throw new AgentPlanResolutionError(`creatorPlan.sourceRevisions[${index}].kind is invalid`);
    resourceId(source.id, `creatorPlan.sourceRevisions[${index}].id`);
    boundedText(source.relativePath, `creatorPlan.sourceRevisions[${index}].relativePath`);
    if (!/^[a-f0-9]{64}$/u.test(source.sha256))
      throw new AgentPlanResolutionError(`creatorPlan.sourceRevisions[${index}].sha256 is invalid`);
  }
  const sortedRevisions = [...plan.sourceRevisions].sort((a, b) => Buffer.compare(
    Buffer.from(`${a.kind}\0${a.id}\0${a.relativePath}\0${a.sha256}`),
    Buffer.from(`${b.kind}\0${b.id}\0${b.relativePath}\0${b.sha256}`),
  ));
  if (canonical(sortedRevisions) !== canonical(plan.sourceRevisions)
      || new Set(plan.sourceRevisions.map(source => `${source.kind}\0${source.id}`)).size
        !== plan.sourceRevisions.length)
    throw new AgentPlanResolutionError('creator plan source revisions are not unique and bytewise ordered');
  if (!plan.sourceRevisions.some(source => source.kind === 'Role' && source.id === plan.role.id)
      || (plan.source.kind === 'persistent_resource'
        && !plan.sourceRevisions.some(source => source.kind === 'Agent' && source.id === plan.agentId)))
    throw new AgentPlanResolutionError('creator plan is missing its defining resource revision');
  const layers: readonly ResolutionLayer[] = [
    'explicit_operation', 'task_default', 'room_default', 'template_member', 'creator',
  ];
  const revisionFor = (kind: ResourceKind, id: string): boolean =>
    plan.sourceRevisions.some(source => source.kind === kind && source.id === id);
  for (const [index, append] of plan.role.appendProvenance.entries()) {
    const kind = APPEND_RESOURCE_KIND[append.layer as keyof typeof APPEND_RESOURCE_KIND];
    if (append.sourceType === 'resource'
        && !revisionFor(kind, append.sourceId))
      throw new AgentPlanResolutionError(
        `creatorPlan.role.appendProvenance[${index}] lacks its exact ${kind} source revision`);
  }
  const validateProvenance = (value: ValueProvenance, name: string, brain = false): void => {
    const creatorLayer = value.layer === 'creator';
    object(value, name, creatorLayer
      ? ['layer', 'sourceType', 'sourceId', 'creatorAgentId', 'creatorGeneration', 'creatorPlanDigest', 'creatorSnapshotDigest',
        ...(brain ? ['brainSelection'] : [])]
      : value.sourceType === 'runtime_operation'
        ? ['layer', 'sourceType', 'sourceId', 'sourceDigest', 'principalId', 'operationId',
          ...(brain ? ['brainSelection'] : [])]
        : ['layer', 'sourceType', 'sourceId', 'principalId', 'operationId',
          ...(brain ? ['brainSelection'] : [])]);
    if (!layers.includes(value.layer)) throw new AgentPlanResolutionError(`${name}.layer is invalid`);
    if (creatorLayer ? value.sourceType !== 'creator_plan'
      : !['resource', 'runtime_operation'].includes(value.sourceType))
      throw new AgentPlanResolutionError(`${name}.sourceType is invalid`);
    token(value.sourceId, `${name}.sourceId`);
    if (creatorLayer) {
      resourceId(value.creatorAgentId, `${name}.creatorAgentId`);
      if (!Number.isSafeInteger(value.creatorGeneration) || value.creatorGeneration! < 1)
        throw new AgentPlanResolutionError(`${name}.creatorGeneration is invalid`);
      digest(value.creatorPlanDigest, `${name}.creatorPlanDigest`);
      digest(value.creatorSnapshotDigest, `${name}.creatorSnapshotDigest`);
    } else if (value.principalId !== plan.principal.id || value.operationId !== plan.operation.id) {
      throw new AgentPlanResolutionError(`${name} principal or operation binding is inconsistent`);
    }
    if (value.sourceType === 'resource') {
      const kind = PROVENANCE_RESOURCE_KIND[value.layer as Exclude<ResolutionLayer, 'creator'>];
      if (!revisionFor(kind, value.sourceId))
        throw new AgentPlanResolutionError(`${name} lacks its exact ${kind} source revision`);
    }
    if (value.sourceType === 'runtime_operation') {
      digest(value.sourceDigest, `${name}.sourceDigest`);
      if (value.sourceDigest !== hash(plan.operation))
        throw new AgentPlanResolutionError(`${name} operation digest binding is inconsistent`);
    }
    if (brain) {
      const selection = (value as BrainProvenance).brainSelection;
      object(selection, `${name}.brainSelection`, selection?.kind === 'template'
        ? ['kind', 'brainId'] : ['kind']);
      if (selection.kind === 'template') resourceId(selection.brainId, `${name}.brainSelection.brainId`);
      else if (!['inline', 'creator_plan'].includes(selection.kind))
        throw new AgentPlanResolutionError(`${name}.brainSelection.kind is invalid`);
      if ((creatorLayer && selection.kind !== 'creator_plan')
          || (!creatorLayer && selection.kind === 'creator_plan'))
        throw new AgentPlanResolutionError(`${name}.brainSelection is inconsistent with provenance`);
    }
  };
  validateProvenance(plan.brainProvenance, 'creatorPlan.brainProvenance', true);
  object(plan.permissionProvenance, 'creatorPlan.permissionProvenance', ['approval', 'filesystem', 'unattended']);
  object(plan.delegation, 'creatorPlan.delegation', ['approval', 'filesystem', 'unattended']);
  for (const field of ['approval', 'filesystem', 'unattended'] as const) {
    validateProvenance(plan.permissionProvenance[field], `creatorPlan.permissionProvenance.${field}`);
    const decision = plan.delegation[field];
    object(decision, `creatorPlan.delegation.${field}`, [
      'field', 'requested', 'effective', 'creator', 'grantCeiling', 'decision', 'grantId',
    ].filter(key => own(decision, key)));
    if (decision.field !== field || decision.effective !== plan.permissions[field]
        || decision.requested !== plan.permissions[field])
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} binding is inconsistent`);
    if (!['no_creator_explicit', 'within_creator', 'owner_grant'].includes(decision.decision))
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} decision is invalid`);
    if (decision.creator !== undefined)
      normalizedPartialPermissions({ [field]: decision.creator }, plan.agentId, plan.role.id);
    if (decision.grantCeiling !== undefined)
      normalizedPartialPermissions({ [field]: decision.grantCeiling }, plan.agentId, plan.role.id);
    const effectiveRank = (RANK[field] as Record<string, number>)[decision.effective];
    const creatorRank = decision.creator === undefined ? undefined
      : (RANK[field] as Record<string, number>)[decision.creator];
    const retainedCeiling = plan.ownerDelegation?.grant.ceilings[field];
    const retainedCeilingRank = retainedCeiling === undefined ? undefined
      : (RANK[field] as Record<string, number>)[retainedCeiling];
    if (decision.grantCeiling !== retainedCeiling)
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} retained grant ceiling is inconsistent`);
    if (decision.decision === 'owner_grant') {
      token(decision.grantId, `creatorPlan.delegation.${field}.grantId`);
      if (!decision.grantCeiling || !plan.ownerDelegation
          || decision.grantId !== plan.ownerDelegation.grant.grantId)
        throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} Owner grant binding is inconsistent`);
      if (decision.creator === undefined)
        throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} Owner grant lacks creator policy`);
      if (effectiveRank <= creatorRank! || effectiveRank > retainedCeilingRank!)
        throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} Owner grant rank is inconsistent`);
    } else if (decision.grantId !== undefined)
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} unexpectedly references an Owner grant`);
    if (decision.decision === 'no_creator_explicit' && decision.creator !== undefined)
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} unexpectedly has creator policy`);
    if (decision.decision === 'no_creator_explicit'
        && (decision.grantCeiling !== undefined || plan.ownerDelegation))
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} unexpectedly has Owner grant policy`);
    if (decision.decision === 'within_creator' && decision.creator === undefined)
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} lacks creator policy`);
    if (decision.decision === 'within_creator' && effectiveRank > creatorRank!)
      throw new AgentPlanResolutionError(`creatorPlan.delegation.${field} exceeds creator policy`);
  }
  if (plan.membership) {
    object(plan.membership, 'creatorPlan.membership', [
      ...(own(plan.membership, 'roomId') ? ['roomId'] : []),
      ...(own(plan.membership, 'taskId') ? ['taskId'] : []),
      ...(own(plan.membership, 'slot') ? ['slot'] : []),
      ...(own(plan.membership, 'ordinal') ? ['ordinal'] : []),
      ...(own(plan.membership, 'memberId') ? ['memberId'] : []),
    ]);
    for (const field of ['roomId', 'taskId', 'slot', 'memberId'] as const)
      if (plan.membership[field] !== undefined) token(plan.membership[field], `creatorPlan.membership.${field}`);
    if (plan.membership.ordinal !== undefined
        && (!Number.isSafeInteger(plan.membership.ordinal) || plan.membership.ordinal < 1))
      throw new AgentPlanResolutionError('creator plan membership ordinal is invalid');
  }
  if (plan.ownerDelegation) {
    object(plan.ownerDelegation, 'creatorPlan.ownerDelegation', ['grant', 'trusted']);
    const { grant, trusted } = plan.ownerDelegation;
    object(trusted, 'creatorPlan.ownerDelegation.trusted', [
      'pinnedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType', 'resourceScope',
      'authorizationRevision',
    ]);
    object(grant, 'creatorPlan.ownerDelegation.grant', [
      'grantId', 'authenticatedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType',
      'resourceScope', 'revision', 'expiresAt', 'ceilings',
    ]);
    for (const field of ['grantId', 'authenticatedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType', 'revision'] as const)
      token(grant[field], `creatorPlan.ownerDelegation.grant.${field}`);
    scope(grant.resourceScope, 'creatorPlan.ownerDelegation.grant.resourceScope');
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 0)
      throw new AgentPlanResolutionError('creator plan Owner delegation expiry is invalid');
    validateOwnerDelegationAgainstTrustedBindings(grant, trusted);
    if (grant.authenticatedOwnerCid !== trusted.pinnedOwnerCid
        || grant.subjectPrincipalId !== trusted.subjectPrincipalId
        || grant.operationId !== trusted.operationId || grant.operationType !== trusted.operationType
        || grant.resourceScope !== trusted.resourceScope || grant.revision !== trusted.authorizationRevision
        || grant.subjectPrincipalId !== plan.principal.id || grant.operationId !== plan.operation.id
        || grant.operationType !== plan.operation.type || grant.resourceScope !== plan.operation.resourceScope
        || grant.revision !== plan.authorizationRevision || plan.evaluatedAt > grant.expiresAt)
      throw new AgentPlanResolutionError('creator plan Owner delegation bindings are inconsistent');
    normalizedPartialPermissions(grant.ceilings, grant.grantId, plan.role.id);
  }
  const expectedRevisionKeys = new Set<string>([`Role\0${plan.role.id}`]);
  if (plan.source.kind === 'persistent_resource') expectedRevisionKeys.add(`Agent\0${plan.agentId}`);
  for (const value of [plan.brainProvenance, ...Object.values(plan.permissionProvenance)]) {
    if (value.sourceType === 'resource')
      expectedRevisionKeys.add(`${PROVENANCE_RESOURCE_KIND[value.layer as Exclude<ResolutionLayer, 'creator'>]}\0${value.sourceId}`);
  }
  for (const append of plan.role.appendProvenance) {
    if (append.sourceType === 'resource')
      expectedRevisionKeys.add(`${APPEND_RESOURCE_KIND[append.layer as keyof typeof APPEND_RESOURCE_KIND]}\0${append.sourceId}`);
  }
  if (plan.brainProvenance.brainSelection.kind === 'template')
    expectedRevisionKeys.add(`Brain\0${plan.brainProvenance.brainSelection.brainId}`);
  const actualRevisionKeys = new Set(plan.sourceRevisions.map(source => `${source.kind}\0${source.id}`));
  if (canonical([...actualRevisionKeys].sort()) !== canonical([...expectedRevisionKeys].sort()))
    throw new AgentPlanResolutionError('creator plan source revisions are not the exact selected resource closure');
}

/** Structural check only; this does not issue authority evidence. */
export function validateCreatorPlanAgainstTrustedBindings(
  plan: AgentPlan, trusted: TrustedCreatorPlanBindings,
): void {
  object(trusted, 'trustedCreatorBindings', ['agentId', 'generation', 'planDigest', 'snapshotDigest']);
  resourceId(trusted.agentId, 'trustedCreatorBindings.agentId');
  if (!Number.isSafeInteger(trusted.generation) || trusted.generation < 1)
    throw new AgentPlanResolutionError('trusted creator generation is invalid');
  digest(trusted.planDigest, 'trustedCreatorBindings.planDigest');
  digest(trusted.snapshotDigest, 'trustedCreatorBindings.snapshotDigest');
  validateAgentPlanStructure(plan);
  if (plan.agentId !== trusted.agentId || plan.generation !== trusted.generation
      || plan.planDigest !== trusted.planDigest || plan.snapshotDigest !== trusted.snapshotDigest)
    throw new AgentPlanResolutionError('creator plan does not match independently trusted bindings');
}

/** Structural check only; this does not issue authority evidence. */
export function validateOwnerDelegationAgainstTrustedBindings(
  grant: OwnerDelegationGrant, trusted: TrustedOwnerDelegationBindings,
): void {
  object(trusted, 'trustedOwnerBindings', [
    'pinnedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType', 'resourceScope',
    'authorizationRevision',
  ]);
  for (const field of [
    'pinnedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType', 'authorizationRevision',
  ] as const) token(trusted[field], `trustedOwnerBindings.${field}`);
  scope(trusted.resourceScope, 'trustedOwnerBindings.resourceScope');
  object(grant, 'ownerGrant', [
    'grantId', 'authenticatedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType',
    'resourceScope', 'revision', 'expiresAt', 'ceilings',
  ]);
  token(grant.grantId, 'ownerGrant.grantId');
  normalizedPartialPermissions(grant.ceilings, grant.grantId, 'validation');
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 0)
    throw new AgentPlanResolutionError('Owner grant expiry is invalid');
  if (grant.authenticatedOwnerCid !== trusted.pinnedOwnerCid
      || grant.subjectPrincipalId !== trusted.subjectPrincipalId
      || grant.operationId !== trusted.operationId || grant.operationType !== trusted.operationType
      || grant.resourceScope !== trusted.resourceScope || grant.revision !== trusted.authorizationRevision)
    throw new AgentPlanResolutionError('Owner grant does not match independently trusted bindings');
}

function validateGrant(input: AuthorizedResolutionInput, roleId: string): OwnerDelegationGrant {
  const evidence = input.ownerDelegationEvidence!;
  const grant = evidence.grant;
  object(grant, 'ownerGrant', [
    'grantId', 'authenticatedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType',
    'resourceScope', 'revision', 'expiresAt', 'ceilings',
  ]);
  for (const field of [
    'grantId', 'authenticatedOwnerCid', 'subjectPrincipalId', 'operationId', 'operationType',
    'revision',
  ] as const) token(grant[field], `ownerGrant.${field}`);
  scope(grant.resourceScope, 'ownerGrant.resourceScope');
  if (grant.authenticatedOwnerCid !== evidence.trusted.pinnedOwnerCid
      || grant.subjectPrincipalId !== input.principal.id || grant.operationId !== input.operation.id
      || grant.operationType !== input.operation.type || grant.resourceScope !== input.operation.resourceScope)
    throw new AgentPlanResolutionError('Owner grant subject, operation, scope, or authenticated CID mismatch');
  if (!Number.isSafeInteger(grant.expiresAt) || input.evaluatedAt > grant.expiresAt)
    throw new AgentPlanResolutionError('Owner grant is expired');
  if (grant.revision !== input.authorizationRevision)
    throw new AgentPlanResolutionError('Owner grant revision does not match authorization revision');
  return { ...clone(grant), ceilings: normalizedPartialPermissions(grant.ceilings, grant.grantId, roleId) ?? {} };
}

const RANK = {
  approval: { ask: 0, auto: 1, allow: 2 },
  filesystem: { 'read-only': 0, workspace: 1, unrestricted: 2 },
  unattended: { deny: 0, wait: 1 },
} as const;

function resolveRole(input: AuthorizedResolutionInput, roleId: string): AgentPlan['role'] {
  const resource = input.snapshot.resources.Role?.[roleId];
  if (!resource || resource.kind !== 'Role') throw new AgentPlanResolutionError(`unknown Role '${roleId}'`);
  let mission = resource.spec.mission ?? '';
  let persona = resource.spec.persona ?? '';
  const appendProvenance: RoleAppendProvenance[] = [];
  const layers = [
    ['template', input.roleContext?.template], ['room', input.roleContext?.room],
    ['task_member', input.roleContext?.taskMember],
  ] as const;
  for (const [layer, context] of layers) {
    if (!context) continue;
    object(context, `roleContext.${layer}`, ['source', 'mission_append', 'persona_append']);
    validateLayerSource(context.source, `roleContext.${layer}`, input,
      layer === 'template' ? ['RoomTemplate'] : layer === 'room' ? ['RoomsPolicy'] : ['TasksPolicy'],
      layer !== 'template' && context.source.kind === 'current_operation');
    const sourceId = context.source.kind === 'resource'
      ? context.source.resourceId : input.operation.id;
    const validated = parseTypedResource(`agent-plan:${sourceId}`, stringify({
      kind: 'RoomTemplate', version: 1, id: 'validation',
      spec: { version: 1, description: 'validation', members: [{
        slot: 'validation', role: roleId, count: 1,
        role_context: {
          ...(context.mission_append === undefined ? {} : { mission_append: context.mission_append }),
          ...(context.persona_append === undefined ? {} : { persona_append: context.persona_append }),
        },
      }] },
    }));
    if (validated.kind !== 'RoomTemplate') throw new AgentPlanResolutionError('internal Role validation failed');
    const normalized = validated.spec.members[0].role_context;
    const missionAppend = normalized?.mission_append ?? '';
    const personaAppend = normalized?.persona_append ?? '';
    if (typeof missionAppend !== 'string' || typeof personaAppend !== 'string')
      throw new AgentPlanResolutionError(`roleContext.${layer} append values must be strings`);
    for (const [name, text] of [['mission', missionAppend], ['persona', personaAppend]] as const) {
      if (Buffer.byteLength(text) > MAX_ROLE_TEXT_BYTES)
        throw new AgentPlanResolutionError(`roleContext.${layer}.${name}_append exceeds limit`);
    }
    if (missionAppend) mission += `${ROLE_CONTEXT_SEPARATOR}${missionAppend}`;
    if (personaAppend) persona += `${ROLE_CONTEXT_SEPARATOR}${personaAppend}`;
    appendProvenance.push({
      layer, sourceType: context.source.kind === 'resource' ? 'resource' : 'runtime_operation', sourceId,
      ...(context.source.kind === 'current_operation' ? { sourceDigest: hash(input.operation) } : {}),
      missionBytes: Buffer.byteLength(missionAppend), personaBytes: Buffer.byteLength(personaAppend),
    });
  }
  const missionBytes = Buffer.byteLength(mission);
  const personaBytes = Buffer.byteLength(persona);
  if (missionBytes > MAX_ROLE_TEXT_BYTES || personaBytes > MAX_ROLE_TEXT_BYTES)
    throw new AgentPlanResolutionError('effective Role context exceeds final byte limit');
  return {
    id: roleId,
    effective: clone({ ...resource.spec, ...(mission ? { mission } : {}), ...(persona ? { persona } : {}) }),
    appendProvenance, missionBytes, personaBytes,
  };
}

function sourceValues(input: AuthorizedResolutionInput): {
  agentId: string; role: string; identity: RuntimeIdentityIntent; lifecycle: 'persistent' | 'temporary';
  runtime?: AgentRuntimeSpec; explicit: CompositionLayerInput; sourceRevisionId?: string;
} {
  if (input.source.kind !== 'persistent_resource' && input.source.kind !== 'runtime_composition')
    throw new AgentPlanResolutionError('source.kind must be persistent_resource or runtime_composition');
  object(input.source, 'source', input.source.kind === 'persistent_resource'
    ? ['kind', 'agentId'] : ['kind', 'agentId', 'role', 'identity', 'lifecycle', 'runtime', 'brain', 'permissions']);
  if (input.source.kind === 'persistent_resource') {
    const resource = input.snapshot.resources.Agent?.[input.source.agentId];
    if (!resource || resource.kind !== 'Agent')
      throw new AgentPlanResolutionError(`unknown Agent '${input.source.agentId}'`);
    const identity = input.operation.type === 'agent.reconfigure' && input.generation > 1
      ? { ...resource.spec.identity, ownership: 'existing' as const } : clone(resource.spec.identity);
    return {
      agentId: resource.id, role: resource.spec.role, identity,
      lifecycle: resource.spec.lifecycle,
      ...(resource.spec.runtime ? { runtime: normalizedRuntime(resource.spec.runtime, resource.id) } : {}),
      explicit: { source: { kind: 'resource', resourceKind: 'Agent', resourceId: resource.id },
        brain: resource.spec.brain, permissions: resource.spec.permissions },
      sourceRevisionId: resource.id,
    };
  }
  resourceId(input.source.agentId, 'source.agentId');
  resourceId(input.source.role, 'source.role');
  object(input.source.identity, 'source.identity', ['name', 'ownership']);
  boundedText(input.source.identity.name, 'source.identity.name');
  if (!['existing', 'create_persistent', 'create_temporary'].includes(input.source.identity.ownership))
    throw new AgentPlanResolutionError('source.identity.ownership is invalid');
  if (!['persistent', 'temporary'].includes(input.source.lifecycle))
    throw new AgentPlanResolutionError('source.lifecycle is invalid');
  if (input.source.lifecycle === 'temporary' && input.source.identity.ownership === 'create_persistent')
    throw new AgentPlanResolutionError('temporary lifecycle cannot create a persistent identity');
  if (input.source.lifecycle === 'persistent' && input.source.identity.ownership === 'create_temporary')
    throw new AgentPlanResolutionError('persistent lifecycle cannot create a temporary identity');
  const agentId = input.source.agentId;
  return {
    agentId: token(agentId, 'agentId'), role: input.source.role, identity: clone(input.source.identity),
    lifecycle: input.source.lifecycle,
    ...(input.source.runtime ? { runtime: normalizedRuntime(input.source.runtime, agentId) } : {}),
    explicit: { source: { kind: 'current_operation' },
      ...(input.source.brain ? { brain: input.source.brain } : {}),
      ...(input.source.permissions ? { permissions: input.source.permissions } : {}) },
  };
}

export function computeAgentPlanDigest(plan: Omit<AgentPlan, 'planDigest'>): string { return hash(plan); }
export function computeBrainDigest(brain: BrainSpec): string { return hash(brain); }
export function computePermissionsDigest(permissions: PermissionSpec): string { return hash(permissions); }
export function computeOperationDigest(operation: PlanOperation): string { return hash(operation); }

function resolveAgentPlanAuthorized(
  rawInput: AgentPlanResolutionInput | (AgentPlanCompositionInput & TrustedAgentPlanContext),
  authority?: AgentPlanEvidenceAuthority,
  adapterResolver?: AgentPlanAdapterResolver,
): AgentPlan {
  const creatorRecord = rawInput.creatorEvidence
    ? authority?.authenticateCreator(rawInput.creatorEvidence) : undefined;
  if (rawInput.creatorEvidence && !creatorRecord)
    throw new AgentPlanResolutionError('creator evidence was not authenticated by the configured authority');
  const ownerRecord = rawInput.ownerDelegationEvidence
    ? authority?.authenticateOwnerDelegation(rawInput.ownerDelegationEvidence) : undefined;
  if (rawInput.ownerDelegationEvidence && !ownerRecord)
    throw new AgentPlanResolutionError('Owner delegation evidence was not authenticated by the configured authority');
  if (creatorRecord)
    validateCreatorPlanAgainstTrustedBindings(creatorRecord.plan, creatorRecord.trusted);
  if (ownerRecord)
    validateOwnerDelegationAgainstTrustedBindings(ownerRecord.grant, ownerRecord.trusted);
  const input = clone({
    ...rawInput,
    ...(creatorRecord ? { creatorEvidence: {
      plan: creatorRecord.plan, trusted: creatorRecord.trusted,
    } } : {}),
    ...(ownerRecord ? { ownerDelegationEvidence: {
      grant: ownerRecord.grant, trusted: ownerRecord.trusted,
    } } : {}),
  }) as AuthorizedResolutionInput;
  object(input, 'input', [
    'snapshot', 'source', 'explicitOperation', 'taskDefault', 'roomDefault', 'templateMember',
    'roleContext', 'creatorEvidence', 'principal', 'operation', 'ownerDelegationEvidence',
    'membership', 'generation', 'evaluatedAt', 'adapter', 'authorizationRevision',
  ]);
  if (input.snapshot.schemaVersion !== 2 || !SHA256.test(input.snapshot.digest))
    throw new AgentPlanResolutionError('snapshot is not a valid v2 immutable snapshot');
  object(input.principal, 'principal', ['id', 'kind']); token(input.principal.id, 'principal.id');
  if (!['agent', 'owner', 'system'].includes(input.principal.kind))
    throw new AgentPlanResolutionError('principal.kind is invalid');
  object(input.operation, 'operation', ['id', 'type', 'resourceScope']);
  for (const field of ['id', 'type'] as const) token(input.operation[field], `operation.${field}`);
  scope(input.operation.resourceScope, 'operation.resourceScope');
  token(input.authorizationRevision, 'authorizationRevision');
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new AgentPlanResolutionError('generation must be a positive safe integer');
  if (!Number.isSafeInteger(input.evaluatedAt) || input.evaluatedAt < 0)
    throw new AgentPlanResolutionError('evaluatedAt must be a non-negative safe integer');
  if (input.roleContext)
    object(input.roleContext, 'roleContext', ['template', 'room', 'taskMember']);

  const selected = sourceValues(input);
  const explicit: CompositionLayerInput = {
    ...selected.explicit, ...(input.explicitOperation ?? {}),
    permissions: { ...(selected.explicit.permissions ?? {}), ...(input.explicitOperation?.permissions ?? {}) },
  };
  if (!input.creatorEvidence && (!explicit.brain || !completePermissions(explicit.permissions)))
    throw new AgentPlanResolutionError(
      'no-creator resolution requires explicit complete Brain and permissions from the Agent source or operation');
  const ordered = [
    ['explicit_operation', explicit], ['task_default', input.taskDefault],
    ['room_default', input.roomDefault], ['template_member', input.templateMember],
  ] as const;
  for (const [name, layer] of ordered) {
    if (layer) {
      object(layer, name, ['source', 'brain', 'permissions']);
      validateLayerSource(layer.source, name, input,
        name === 'explicit_operation' ? ['Agent']
          : name === 'task_default' ? ['TasksPolicy']
            : name === 'room_default' ? ['RoomsPolicy'] : ['RoomTemplate'],
        name === 'explicit_operation' && layer.source.kind === 'current_operation');
      const evidenceId = layer.source.kind === 'resource' ? layer.source.resourceId : input.operation.id;
      layer.permissions = normalizedPartialPermissions(layer.permissions, evidenceId, selected.role);
    }
  }
  let resolvedBrain: BrainSpec | undefined;
  let brainProvenance: BrainProvenance | undefined;
  const sourceRevisionKeys = new Set<string>([`Role\0${selected.role}`]);
  if (selected.sourceRevisionId) sourceRevisionKeys.add(`Agent\0${selected.sourceRevisionId}`);
  for (const [layer, value] of ordered) {
    if (!value?.brain) continue;
    const result = normalizeBrain(value.brain, input.snapshot, layer);
    resolvedBrain = result.brain;
    if (result.sourceRevisionId) sourceRevisionKeys.add(`Brain\0${result.sourceRevisionId}`);
    brainProvenance = {
      ...provenance(layer, value.source, input),
      brainSelection: result.sourceRevisionId
        ? { kind: 'template', brainId: result.sourceRevisionId } : { kind: 'inline' },
    }; break;
  }
  if (!resolvedBrain && input.creatorEvidence) {
    resolvedBrain = clone(input.creatorEvidence.plan.brain);
    brainProvenance = {
      ...provenance('creator', undefined, input), brainSelection: { kind: 'creator_plan' },
    };
  }
  if (!resolvedBrain || !brainProvenance)
    throw new AgentPlanResolutionError('complete Brain is required without authenticated creator context');

  const permissions = {} as PermissionSpec;
  const permissionProvenance = {} as Record<PermissionField, ValueProvenance>;
  for (const field of ['approval', 'filesystem', 'unattended'] as const) {
    let found = false;
    for (const [layer, value] of ordered) {
      if (value?.permissions?.[field] === undefined) continue;
      permissions[field] = value.permissions[field] as never;
      permissionProvenance[field] = provenance(layer, value.source, input); found = true; break;
    }
    if (!found && input.creatorEvidence) {
      permissions[field] = input.creatorEvidence.plan.permissions[field] as never;
      permissionProvenance[field] = provenance('creator', undefined, input); found = true;
    }
    if (!found) throw new AgentPlanResolutionError(`complete permissions.${field} is required without creator context`);
  }

  const broadened = (['approval', 'filesystem', 'unattended'] as const).filter(field =>
    input.creatorEvidence && RANK[field][permissions[field] as never]
      > RANK[field][input.creatorEvidence.plan.permissions[field] as never]);
  if (input.ownerDelegationEvidence && !input.creatorEvidence)
    throw new AgentPlanResolutionError('Owner delegation grant requires authenticated creator context');
  const grant = input.ownerDelegationEvidence ? validateGrant(input, selected.role) : undefined;
  if (broadened.length && !grant)
    throw new AgentPlanResolutionError(`permission escalation requires Owner grant: ${broadened.join(', ')}`);
  const delegation = {} as Record<PermissionField, PermissionDelegationRecord>;
  for (const field of ['approval', 'filesystem', 'unattended'] as const) {
    const effective = permissions[field];
    if (!input.creatorEvidence) {
      delegation[field] = { field, requested: effective, effective, decision: 'no_creator_explicit' };
      continue;
    }
    const creator = input.creatorEvidence.plan.permissions[field];
    if (!broadened.includes(field)) {
      delegation[field] = {
        field, requested: effective, effective, creator,
        ...(grant?.ceilings[field] === undefined ? {} : { grantCeiling: grant.ceilings[field] }),
        decision: 'within_creator',
      };
      continue;
    }
    const ceiling = grant!.ceilings[field];
    if (ceiling === undefined || RANK[field][effective as never] > RANK[field][ceiling as never])
      throw new AgentPlanResolutionError(`Owner grant ceiling does not permit permissions.${field}`);
    delegation[field] = {
      field, requested: effective, effective, creator, grantCeiling: ceiling,
      decision: 'owner_grant', grantId: grant!.grantId,
    };
  }

  const adapter = validateAdapter(
    adapterResolver ? adapterResolver.resolve(deepFreeze(clone(resolvedBrain)), deepFreeze(clone(permissions)))
      : input.adapter,
    resolvedBrain, permissions,
  );
  const role = resolveRole(input, selected.role);
  if (input.membership) {
    object(input.membership, 'membership', ['roomId', 'taskId', 'slot', 'ordinal', 'memberId']);
    for (const field of ['roomId', 'taskId', 'slot', 'memberId'] as const) {
      if (input.membership[field] !== undefined) token(input.membership[field], `membership.${field}`);
    }
    if (input.membership.ordinal !== undefined
        && (!Number.isSafeInteger(input.membership.ordinal) || input.membership.ordinal < 1))
      throw new AgentPlanResolutionError('membership.ordinal must be a positive safe integer');
  }
  for (const value of [brainProvenance, ...Object.values(permissionProvenance)]) {
    if (value.sourceType === 'resource')
      sourceRevisionKeys.add(`${PROVENANCE_RESOURCE_KIND[value.layer as Exclude<ResolutionLayer, 'creator'>]}\0${value.sourceId}`);
  }
  for (const append of role.appendProvenance) {
    if (append.sourceType === 'resource')
      sourceRevisionKeys.add(`${APPEND_RESOURCE_KIND[append.layer]}\0${append.sourceId}`);
  }
  const currentSourceRevisions = input.snapshot.sources
    .filter(source => sourceRevisionKeys.has(`${source.kind}\0${source.id}`))
    .map(({ kind, id, relativePath, sha256 }) => ({ kind, id, relativePath, sha256 }));
  const sourceRevisions = currentSourceRevisions
    .sort((a, b) => Buffer.compare(
      Buffer.from(`${a.kind}\0${a.id}\0${a.relativePath}\0${a.sha256}`),
      Buffer.from(`${b.kind}\0${b.id}\0${b.relativePath}\0${b.sha256}`),
    ));
  const unsigned: Omit<AgentPlan, 'planDigest'> = {
    schemaVersion: 1, agentId: selected.agentId, generation: input.generation,
    snapshotDigest: input.snapshot.digest, source: clone(input.source), sourceRevisions,
    role, brain: resolvedBrain, brainProvenance, identity: selected.identity,
    lifecycle: selected.lifecycle, ...(selected.runtime ? { runtime: selected.runtime } : {}),
    permissions, permissionProvenance, delegation, principal: input.principal,
    operation: input.operation, authorizationRevision: input.authorizationRevision,
    ...(input.membership ? { membership: input.membership } : {}),
    adapter, ...(grant ? { ownerDelegation: {
      grant, trusted: clone(input.ownerDelegationEvidence!.trusted),
    } } : {}), evaluatedAt: input.evaluatedAt,
  };
  return deepFreeze({ ...unsigned, planDigest: computeAgentPlanDigest(unsigned) });
}

/** Public pure resolver has no authority issuer and therefore rejects all opaque evidence. */
export function resolveAgentPlan(input: AgentPlanResolutionInput): AgentPlan {
  return resolveAgentPlanAuthorized(input);
}

/** Bind a resolver instance to the real authorization boundary (or an explicit test authority). */
export function createAgentPlanResolver(
  authority: AgentPlanEvidenceAuthority,
): (input: AgentPlanResolutionInput) => AgentPlan {
  if (!authority || typeof authority.authenticateCreator !== 'function'
      || typeof authority.authenticateOwnerDelegation !== 'function')
    throw new AgentPlanResolutionError('AgentPlan evidence authority is invalid');
  const authenticateCreator = authority.authenticateCreator.bind(authority);
  const authenticateOwnerDelegation = authority.authenticateOwnerDelegation.bind(authority);
  const bound: AgentPlanEvidenceAuthority = { authenticateCreator, authenticateOwnerDelegation };
  return input => resolveAgentPlanAuthorized(input, bound);
}

/** Compose from an authority-owned context; request data cannot supply graph, actor, generation, or adapter. */
export function createAuthenticatedAgentPlanComposer(
  authority: AgentPlanEvidenceAuthority,
  context: TrustedAgentPlanContext,
  adapterResolver: AgentPlanAdapterResolver,
): (input: AgentPlanCompositionInput) => AgentPlan {
  if (!adapterResolver || typeof adapterResolver.resolve !== 'function')
    throw new AgentPlanResolutionError('AgentPlan adapter resolver is invalid');
  if (!authority || typeof authority.authenticateCreator !== 'function'
      || typeof authority.authenticateOwnerDelegation !== 'function')
    throw new AgentPlanResolutionError('AgentPlan evidence authority is invalid');
  const bound: AgentPlanEvidenceAuthority = {
    authenticateCreator: authority.authenticateCreator.bind(authority),
    authenticateOwnerDelegation: authority.authenticateOwnerDelegation.bind(authority),
  };
  const boundAdapter = { resolve: adapterResolver.resolve.bind(adapterResolver) };
  return input => resolveAgentPlanAuthorized({ ...input, ...context }, bound, boundAdapter);
}
