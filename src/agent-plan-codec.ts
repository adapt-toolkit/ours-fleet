import { createHash } from 'node:crypto';
import {
  validateAgentPlanStructure,
  type AgentPlan, type BrainProvenance, type PermissionDelegationRecord, type ValueProvenance,
} from './agent-plan.js';

export const AGENT_PLAN_ENVELOPE_SCHEMA_VERSION = 1;
export const MAX_AGENT_PLAN_ENVELOPE_BYTES = 1024 * 1024;
const MAX_STRUCTURE_DEPTH = 64;
const MAX_STRUCTURE_NODES = 16_384;
const MAX_STRUCTURE_STRING_BYTES = 128 * 1024;
const HUMAN_LIST_LIMIT = 3;
const HUMAN_PREFIX_CODE_POINTS = 96;

export interface AgentPlanEnvelope {
  schemaVersion: 1;
  kind: 'AgentPlan';
  agentId: string;
  generation: number;
  planDigest: string;
  snapshotDigest: string;
  plan: AgentPlan;
}

export class AgentPlanCodecError extends Error {}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentPlanCodecError('AgentPlan envelope contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object')
    throw new AgentPlanCodecError('AgentPlan envelope contains a non-JSON value');
  return `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new AgentPlanCodecError(`AgentPlan envelope field '${key}' is undefined`);
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}

function structuralBounds(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES) throw new AgentPlanCodecError('AgentPlan envelope has too many values');
    if (current.depth > MAX_STRUCTURE_DEPTH) throw new AgentPlanCodecError('AgentPlan envelope is too deeply nested');
    if (typeof current.value === 'string'
        && Buffer.byteLength(current.value) > MAX_STRUCTURE_STRING_BYTES)
      throw new AgentPlanCodecError('AgentPlan envelope contains an oversized string');
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === 'object') {
      const entries = Object.entries(current.value as Record<string, unknown>);
      for (const [key, child] of entries) {
        if (Buffer.byteLength(key) > 256) throw new AgentPlanCodecError('AgentPlan envelope contains an oversized key');
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactObject(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentPlanCodecError(`${name} must be an object`);
  const actual = Object.keys(value);
  const missing = keys.filter(key => !actual.includes(key));
  const extra = actual.filter(key => !keys.includes(key));
  if (missing.length || extra.length)
    throw new AgentPlanCodecError(`${name} keys are invalid`);
  return value as Record<string, unknown>;
}

function envelopeFor(plan: AgentPlan): AgentPlanEnvelope {
  return {
    schemaVersion: AGENT_PLAN_ENVELOPE_SCHEMA_VERSION,
    kind: 'AgentPlan', agentId: plan.agentId, generation: plan.generation,
    planDigest: plan.planDigest, snapshotDigest: plan.snapshotDigest, plan,
  };
}

/**
 * Encode one canonical UTF-8 JSON record, terminated by exactly one LF.
 * The digest and codec provide deterministic integrity, not authenticity or authorization.
 */
export function encodeAgentPlan(plan: AgentPlan): Buffer {
  validateAgentPlanStructure(plan);
  const envelope = envelopeFor(plan);
  structuralBounds(envelope);
  const bytes = Buffer.from(`${canonical(envelope)}\n`, 'utf8');
  if (bytes.length > MAX_AGENT_PLAN_ENVELOPE_BYTES)
    throw new AgentPlanCodecError('AgentPlan envelope exceeds the byte limit');
  return bytes;
}

/** Decode canonical bytes without creating creator/Owner authority evidence. */
export function decodeAgentPlan(bytes: Buffer | string): Readonly<AgentPlanEnvelope> {
  const source = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  if (!source.length || source.length > MAX_AGENT_PLAN_ENVELOPE_BYTES)
    throw new AgentPlanCodecError('AgentPlan envelope has an invalid byte length');
  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) throw new AgentPlanCodecError('AgentPlan envelope is not valid UTF-8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new AgentPlanCodecError('AgentPlan envelope is not valid JSON'); }
  structuralBounds(parsed);
  exactObject(parsed, 'AgentPlan envelope', [
    'schemaVersion', 'kind', 'agentId', 'generation', 'planDigest', 'snapshotDigest', 'plan',
  ]);
  if (`${canonical(parsed)}\n` !== text)
    throw new AgentPlanCodecError('AgentPlan envelope is not in canonical byte form');
  const envelope = parsed as AgentPlanEnvelope;
  if (envelope.schemaVersion !== 1 || envelope.kind !== 'AgentPlan')
    throw new AgentPlanCodecError('AgentPlan envelope schema or kind is unsupported');
  try { validateAgentPlanStructure(envelope.plan); } catch (error) {
    if (error instanceof Error)
      throw new AgentPlanCodecError(`AgentPlan envelope contains an invalid plan: ${error.message}`);
    throw new AgentPlanCodecError('AgentPlan envelope contains an invalid plan');
  }
  if (envelope.agentId !== envelope.plan.agentId
      || envelope.generation !== envelope.plan.generation
      || envelope.planDigest !== envelope.plan.planDigest
      || envelope.snapshotDigest !== envelope.plan.snapshotDigest)
    throw new AgentPlanCodecError('AgentPlan envelope index fields do not match the plan');
  return deepFreeze(envelope);
}

function provenancePresentation(value: ValueProvenance): Record<string, unknown> {
  return value.sourceType === 'resource'
    ? { layer: value.layer, sourceType: value.sourceType, sourceId: value.sourceId }
    : value.sourceType === 'runtime_operation'
      ? { layer: value.layer, sourceType: value.sourceType, sourceDigest: value.sourceDigest }
      : {
        layer: value.layer, sourceType: value.sourceType,
        creatorAgentId: value.creatorAgentId, creatorGeneration: value.creatorGeneration,
        creatorPlanDigest: value.creatorPlanDigest, creatorSnapshotDigest: value.creatorSnapshotDigest,
      };
}

function brainProvenancePresentation(value: BrainProvenance): Record<string, unknown> {
  return {
    ...provenancePresentation(value),
    brainSelection: value.brainSelection.kind === 'template'
      ? { kind: 'template', brainId: value.brainSelection.brainId }
      : { kind: value.brainSelection.kind },
  };
}

function delegationPresentation(value: PermissionDelegationRecord): Record<string, unknown> {
  return {
    field: value.field, requested: value.requested, effective: value.effective,
    decision: value.decision,
    ...(value.creator === undefined ? {} : { creator: value.creator }),
    ...(value.grantCeiling === undefined ? {} : { grantCeiling: value.grantCeiling }),
    ...(value.grantId === undefined ? {} : { grantId: value.grantId }),
  };
}

/** Newly constructed, exact allowlist suitable for machine-facing presentation. */
export function presentAgentPlan(plan: AgentPlan): Readonly<Record<string, unknown>> {
  validateAgentPlanStructure(plan);
  return deepFreeze({
    schemaVersion: 1,
    agentId: plan.agentId, generation: plan.generation, lifecycle: plan.lifecycle,
    identity: { name: plan.identity.name, ownership: plan.identity.ownership },
    role: {
      id: plan.role.id, missionBytes: plan.role.missionBytes, personaBytes: plan.role.personaBytes,
      appendProvenance: plan.role.appendProvenance.map(value => ({
        layer: value.layer, sourceType: value.sourceType,
        ...(value.sourceType === 'resource' ? { sourceId: value.sourceId } : { sourceDigest: value.sourceDigest }),
        missionBytes: value.missionBytes, personaBytes: value.personaBytes,
      })),
    },
    brain: {
      harness: plan.brain.harness, model: plan.brain.model,
      effort: plan.brain.effort, session: plan.brain.session,
    },
    brainProvenance: brainProvenancePresentation(plan.brainProvenance),
    permissions: {
      approval: plan.permissions.approval,
      filesystem: plan.permissions.filesystem,
      unattended: plan.permissions.unattended,
    },
    permissionProvenance: {
      approval: provenancePresentation(plan.permissionProvenance.approval),
      filesystem: provenancePresentation(plan.permissionProvenance.filesystem),
      unattended: provenancePresentation(plan.permissionProvenance.unattended),
    },
    delegation: {
      approval: delegationPresentation(plan.delegation.approval),
      filesystem: delegationPresentation(plan.delegation.filesystem),
      unattended: delegationPresentation(plan.delegation.unattended),
    },
    ...(plan.membership ? { membership: {
      ...(plan.membership.roomId === undefined ? {} : { roomId: plan.membership.roomId }),
      ...(plan.membership.taskId === undefined ? {} : { taskId: plan.membership.taskId }),
      ...(plan.membership.slot === undefined ? {} : { slot: plan.membership.slot }),
      ...(plan.membership.ordinal === undefined ? {} : { ordinal: plan.membership.ordinal }),
      ...(plan.membership.memberId === undefined ? {} : { memberId: plan.membership.memberId }),
    } } : {}),
    sourceRevisions: plan.sourceRevisions.map(source => ({
      kind: source.kind, id: source.id, relativePath: source.relativePath, sha256: source.sha256,
    })),
    adapter: {
      id: plan.adapter.adapterId, version: plan.adapter.adapterVersion,
      policyRevision: plan.adapter.policyRevision, policyDigest: plan.adapter.policyDigest,
      brainDigest: plan.adapter.brainDigest, permissionsDigest: plan.adapter.permissionsDigest,
      native: {
        approvalMode: plan.adapter.nativeDescriptor.approvalMode,
        filesystemMode: plan.adapter.nativeDescriptor.filesystemMode,
        unattendedMode: plan.adapter.nativeDescriptor.unattendedMode,
        exact: plan.adapter.nativeDescriptor.exact,
      },
      enforcement: {
        approval: { ...plan.adapter.enforcement.approval },
        filesystem: { ...plan.adapter.enforcement.filesystem },
        unattended: { ...plan.adapter.enforcement.unattended },
      },
    },
    authorizationRevision: plan.authorizationRevision,
    snapshotDigest: plan.snapshotDigest, planDigest: plan.planDigest, evaluatedAt: plan.evaluatedAt,
  });
}

const digestValue = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
const safe = (value: string): string => JSON.stringify(value);
const prefix = (value: string): string => {
  const points = Array.from(value);
  return safe(points.length <= HUMAN_PREFIX_CODE_POINTS
    ? value : `${points.slice(0, HUMAN_PREFIX_CODE_POINTS).join('')}…`);
};

function boundedList(label: string, values: readonly string[]): string[] {
  const shown = values.slice(0, HUMAN_LIST_LIMIT);
  const lines = shown.map((value, index) => `${label}[${index}]=${prefix(value)}`);
  if (values.length > shown.length) {
    const omitted = values.slice(shown.length);
    lines.push(`${label}.omitted=${omitted.length} ${label}.omittedDigest=${digestValue(omitted)}`);
  }
  return lines;
}

function humanProvenance(value: ValueProvenance): string {
  const base = `layer=${value.layer} sourceType=${value.sourceType}`;
  if (value.sourceType === 'resource') return `${base} sourceId=${safe(value.sourceId)}`;
  if (value.sourceType === 'runtime_operation') return `${base} sourceDigest=${value.sourceDigest}`;
  return `${base} creatorAgentId=${safe(value.creatorAgentId!)} creatorGeneration=${value.creatorGeneration}`
    + ` creatorPlanDigest=${value.creatorPlanDigest} creatorSnapshotDigest=${value.creatorSnapshotDigest}`;
}

function humanBrainProvenance(value: BrainProvenance): string {
  const selection = value.brainSelection.kind === 'template'
    ? `template=${safe(value.brainSelection.brainId)}` : `selection=${value.brainSelection.kind}`;
  return `${humanProvenance(value)} ${selection}`;
}

/** Bounded deterministic text; security-critical scalar values are never truncated. */
export function renderAgentPlanSummary(plan: AgentPlan): string {
  const view = presentAgentPlan(plan);
  void view;
  const identity = plan.identity;
  const lines = [
    `Agent ${safe(plan.agentId)} generation=${plan.generation} lifecycle=${plan.lifecycle}`,
    `Identity name=${safe(identity.name)} ownership=${identity.ownership}`,
    `Brain harness=${safe(plan.brain.harness)} model=${safe(plan.brain.model)} effort=${safe(plan.brain.effort)} session=${safe(plan.brain.session)}`,
    `Permissions approval=${plan.permissions.approval} filesystem=${plan.permissions.filesystem} unattended=${plan.permissions.unattended}`,
    ...(['approval', 'filesystem', 'unattended'] as const).map(field => {
      const value = plan.delegation[field];
      return `Delegation ${field} decision=${value.decision} requested=${value.requested} effective=${value.effective}`
        + (value.creator === undefined ? '' : ` creator=${value.creator}`)
        + (value.grantCeiling === undefined ? '' : ` ceiling=${value.grantCeiling}`)
        + (value.grantId === undefined ? '' : ` grant=${safe(value.grantId)}`);
    }),
    `Digests plan=${plan.planDigest} snapshot=${plan.snapshotDigest} brain=${plan.adapter.brainDigest} permissions=${plan.adapter.permissionsDigest}`,
    `Adapter id=${safe(plan.adapter.adapterId)} version=${safe(plan.adapter.adapterVersion)} policyRevision=${safe(plan.adapter.policyRevision)} policyDigest=${plan.adapter.policyDigest}`,
    `Native approval=${plan.adapter.nativeDescriptor.approvalMode} filesystem=${plan.adapter.nativeDescriptor.filesystemMode} unattended=${plan.adapter.nativeDescriptor.unattendedMode} exact=${plan.adapter.nativeDescriptor.exact}`,
    `Enforcement approval=${plan.adapter.enforcement.approval.owner} filesystem=${plan.adapter.enforcement.filesystem.owner} unattended=${plan.adapter.enforcement.unattended.owner} policyDigest=${plan.adapter.policyDigest}`,
    `Role id=${safe(plan.role.id)} missionBytes=${plan.role.missionBytes} personaBytes=${plan.role.personaBytes}`,
    `Brain provenance ${humanBrainProvenance(plan.brainProvenance)}`,
    ...(['approval', 'filesystem', 'unattended'] as const).map(field =>
      `Permission provenance ${field} ${humanProvenance(plan.permissionProvenance[field])}`),
  ];
  if (plan.membership) lines.push(`Membership ${canonical({
    ...(plan.membership.roomId === undefined ? {} : { roomId: plan.membership.roomId }),
    ...(plan.membership.taskId === undefined ? {} : { taskId: plan.membership.taskId }),
    ...(plan.membership.slot === undefined ? {} : { slot: plan.membership.slot }),
    ...(plan.membership.ordinal === undefined ? {} : { ordinal: plan.membership.ordinal }),
    ...(plan.membership.memberId === undefined ? {} : { memberId: plan.membership.memberId }),
  })}`);
  lines.push(...boundedList('SourceRevision', plan.sourceRevisions.map(source =>
    `${source.kind}:${source.id}:${source.relativePath}:${source.sha256}`)));
  lines.push(...boundedList('RoleAppend', plan.role.appendProvenance.map(value =>
    `${value.layer}:${value.sourceType}:${value.sourceType === 'resource' ? value.sourceId : value.sourceDigest}:${value.missionBytes}:${value.personaBytes}`)));
  return `${lines.join('\n')}\n`;
}
