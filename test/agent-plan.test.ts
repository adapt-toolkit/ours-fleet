import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeAgentPlanDigest, computeBrainDigest, computeOperationDigest, computePermissionsDigest,
  createAgentPlanResolver, resolveAgentPlan as resolveWithoutAuthority, ROLE_CONTEXT_SEPARATOR,
  validateCreatorPlanAgainstTrustedBindings, validateOwnerDelegationAgainstTrustedBindings,
  type AdapterValidationRecord, type AgentPlan, type AgentPlanEvidenceAuthority,
  type AgentPlanResolutionInput, type OwnerDelegationGrant, type TrustedCreatorPlanBindings,
  type TrustedOwnerDelegationBindings, type VerifiedCreatorPlanEvidence,
  type VerifiedOwnerDelegationEvidence,
} from '../src/agent-plan.js';
import { loadConfigResourceSnapshot, type ConfigResourceSnapshot } from '../src/config-resource-loader.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';

let root: string;
let bootstrap: string;
let configDir: string;
let snapshot: ConfigResourceSnapshot;

const brain = (model: string): BrainSpec => ({ harness: 'codex', model, effort: 'high', session: 'acp' });
const permissions = (approval: PermissionSpec['approval'] = 'ask'): PermissionSpec =>
  ({ approval, filesystem: 'workspace', unattended: 'deny' });
const adapter = (value: BrainSpec, policy = permissions()): AdapterValidationRecord => ({
  redacted: true, adapterId: 'codex-acp', adapterVersion: '1', policyRevision: 'policy-7',
  policyDigest: `sha256:${'1'.repeat(64)}`, brainDigest: computeBrainDigest(value),
  permissionsDigest: computePermissionsDigest(policy),
  portableDescriptor: { ...policy },
  nativeDescriptor: {
    approvalMode: policy.approval, filesystemMode: policy.filesystem,
    unattendedMode: policy.unattended, exact: true,
  },
});
class TestEvidenceAuthority implements AgentPlanEvidenceAuthority {
  private readonly creators = new WeakMap<object, { plan: AgentPlan; trusted: TrustedCreatorPlanBindings }>();
  private readonly owners = new WeakMap<object, { grant: OwnerDelegationGrant; trusted: TrustedOwnerDelegationBindings }>();
  issueCreator(plan: AgentPlan, trusted: TrustedCreatorPlanBindings): VerifiedCreatorPlanEvidence {
    validateCreatorPlanAgainstTrustedBindings(plan, trusted);
    const evidence = Object.freeze({}) as VerifiedCreatorPlanEvidence;
    this.creators.set(evidence, { plan, trusted });
    return evidence;
  }
  issueOwner(grant: OwnerDelegationGrant, trusted: TrustedOwnerDelegationBindings): VerifiedOwnerDelegationEvidence {
    validateOwnerDelegationAgainstTrustedBindings(grant, trusted);
    const evidence = Object.freeze({}) as VerifiedOwnerDelegationEvidence;
    this.owners.set(evidence, { grant, trusted });
    return evidence;
  }
  authenticateCreator(evidence: VerifiedCreatorPlanEvidence) { return this.creators.get(evidence); }
  authenticateOwnerDelegation(evidence: VerifiedOwnerDelegationEvidence) { return this.owners.get(evidence); }
}
let testAuthority: TestEvidenceAuthority;
let resolveAgentPlan: (input: AgentPlanResolutionInput) => AgentPlan;
const verifiedCreator = (plan: AgentPlan) => testAuthority.issueCreator(plan, {
  agentId: plan.agentId, generation: plan.generation, planDigest: plan.planDigest,
  snapshotDigest: plan.snapshotDigest,
});
const operationSource = () => ({ kind: 'current_operation' as const });
const verifiedGrant = (grant: OwnerDelegationGrant) =>
  testAuthority.issueOwner(grant, {
    pinnedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1', operationId: 'op-1',
    operationType: 'agent.create', resourceScope: 'agents/worker-1', authorizationRevision: 'auth-3',
  });

function write(relative: string, value: string): void {
  const path = join(configDir, relative); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value);
}

function reload(): void { snapshot = loadConfigResourceSnapshot({ bootstrapFile: bootstrap }); }

function baseInput(selectedBrain = brain('explicit')): AgentPlanResolutionInput {
  return {
    snapshot,
    source: {
      kind: 'runtime_composition', agentId: 'worker-1', role: 'Builder',
      identity: { name: 'worker-1', ownership: 'create_temporary' }, lifecycle: 'temporary',
      brain: selectedBrain, permissions: permissions(),
    },
    principal: { id: 'owner-1', kind: 'owner' },
    operation: { id: 'op-1', type: 'agent.create', resourceScope: 'agents/worker-1' },
    authorizationRevision: 'auth-3',
    generation: 1, evaluatedAt: 1000, adapter: adapter(selectedBrain),
  };
}

beforeEach(() => {
  testAuthority = new TestEvidenceAuthority();
  resolveAgentPlan = createAgentPlanResolver(testAuthority);
  root = mkdtempSync(join(tmpdir(), 'agent-plan-')); bootstrap = join(root, 'fleet.yaml');
  configDir = join(root, 'fleet.conf.d'); mkdirSync(configDir);
  writeFileSync(bootstrap, 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  write('roles.d/builder.yaml', `kind: Role\nversion: 1\nid: Builder\nspec:\n  bio: Builds things\n  mission: Base mission\n  persona: Base persona\n  capabilities: [implementation]\n`);
  for (const model of ['explicit', 'task', 'room', 'template', 'creator', 'persistent']) {
    write(`brains.d/${model}.yaml`, `kind: Brain\nversion: 1\nid: ${model}\nspec:\n  harness: codex\n  model: ${model}\n  effort: high\n  session: acp\n`);
  }
  write('room-templates.d/template.yaml', `kind: RoomTemplate\nversion: 1\nid: template-1\nspec:\n  version: 1\n  description: template\n  members: [{slot: worker, role: Builder, count: 1}]\n`);
  write('rooms.d/default.yaml', `kind: RoomsPolicy\nversion: 1\nid: default\nspec:\n  owner:\n    provider: ours\n    expected_cid: ${'a'.repeat(64)}\n    role: Owner\n`);
  write('tasks.d/default.yaml', `kind: TasksPolicy\nversion: 1\nid: default\nspec: {}\n`);
  reload();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pure AgentPlan resolution', () => {
  it.each([
    ['explicit', { explicitOperation: { source: operationSource(), brain: { template: 'explicit' } } }],
    ['task', { taskDefault: { source: { kind: 'resource', resourceKind: 'TasksPolicy', resourceId: 'default' }, brain: { template: 'task' } } }],
    ['room', { roomDefault: { source: { kind: 'resource', resourceKind: 'RoomsPolicy', resourceId: 'default' }, brain: { template: 'room' } } }],
    ['template', { templateMember: { source: { kind: 'resource', resourceKind: 'RoomTemplate', resourceId: 'template-1' }, brain: { template: 'template' } } }],
  ] as const)('selects the %s Brain as one atomic value at its precedence layer', (model, layers) => {
    const input = baseInput();
    delete (input.source as { brain?: BrainSpec }).brain;
    Object.assign(input, layers);
    if (model !== 'explicit') {
      input.creatorEvidence = verifiedCreator(resolveAgentPlan(baseInput(brain('creator'))));
      input.adapter = adapter(brain(model));
    }
    const plan = resolveAgentPlan(input);
    expect(plan.brain).toEqual(brain(model));
    expect(plan.brainProvenance.layer).toBe(model === 'explicit' ? 'explicit_operation'
      : model === 'template' ? 'template_member' : `${model}_default`);
  });

  it('makes explicit > task > room > template and never field-patches Brain', () => {
    const input = baseInput(brain('explicit'));
    input.explicitOperation = { source: operationSource(), brain: { harness: 'codex', model: 'explicit', effort: 'high', session: 'acp' } };
    input.taskDefault = { source: { kind: 'resource', resourceKind: 'TasksPolicy', resourceId: 'default' }, brain: { template: 'task' } };
    input.roomDefault = { source: { kind: 'resource', resourceKind: 'RoomsPolicy', resourceId: 'default' }, brain: { template: 'room' } };
    input.templateMember = { source: { kind: 'resource', resourceKind: 'RoomTemplate', resourceId: 'template-1' }, brain: { template: 'template' } };
    expect(resolveAgentPlan(input).brain).toEqual(brain('explicit'));
    delete input.explicitOperation;
    delete (input.source as { brain?: BrainSpec }).brain;
    input.creatorEvidence = verifiedCreator(resolveAgentPlan(baseInput(brain('creator'))));
    input.adapter = adapter(brain('task'));
    expect(resolveAgentPlan(input).brain.model).toBe('task');
  });

  it('overlays permissions independently with task above room and records provenance', () => {
    const input = baseInput();
    delete (input.source as { permissions?: Partial<PermissionSpec> }).permissions;
    const creatorInput = baseInput();
    (creatorInput.source as { permissions: PermissionSpec }).permissions.approval = 'allow';
    (creatorInput.source as { permissions: PermissionSpec }).permissions.unattended = 'wait';
    creatorInput.adapter = adapter(brain('explicit'), {
      approval: 'allow', filesystem: 'workspace', unattended: 'wait',
    });
    input.creatorEvidence = verifiedCreator(resolveAgentPlan(creatorInput));
    input.explicitOperation = { source: operationSource(), permissions: { approval: 'auto' } };
    input.taskDefault = { source: { kind: 'resource', resourceKind: 'TasksPolicy', resourceId: 'default' }, permissions: { filesystem: 'read-only' } };
    input.roomDefault = { source: { kind: 'resource', resourceKind: 'RoomsPolicy', resourceId: 'default' }, permissions: { filesystem: 'unrestricted', unattended: 'deny' } };
    input.templateMember = { source: { kind: 'resource', resourceKind: 'RoomTemplate', resourceId: 'template-1' }, permissions: { unattended: 'wait' } };
    input.adapter = adapter(brain('explicit'), {
      approval: 'auto', filesystem: 'read-only', unattended: 'deny',
    });
    const plan = resolveAgentPlan(input);
    expect(plan.permissions).toEqual({ approval: 'auto', filesystem: 'read-only', unattended: 'deny' });
    expect(plan.permissionProvenance.approval.layer).toBe('explicit_operation');
    expect(plan.permissionProvenance.filesystem.layer).toBe('task_default');
    expect(plan.permissionProvenance.unattended.layer).toBe('room_default');
  });

  it('requires complete Brain and permissions for runtime/direct Owner input without creator', () => {
    const input = baseInput();
    delete (input.source as { brain?: BrainSpec }).brain;
    expect(() => resolveAgentPlan(input)).toThrow(/complete Brain/u);
    (input.source as { brain?: BrainSpec }).brain = brain('explicit');
    (input.source as { permissions?: Partial<PermissionSpec> }).permissions = { approval: 'ask' };
    input.taskDefault = { source: { kind: 'resource', resourceKind: 'TasksPolicy', resourceId: 'default' }, permissions: { filesystem: 'workspace', unattended: 'deny' } };
    expect(() => resolveAgentPlan(input)).toThrow(/explicit complete Brain and permissions/u);
  });

  it('resolves a complete persistent Agent resource through the strict source arm', () => {
    write('agents.d/persistent.yaml', `kind: Agent\nversion: 1\nid: persistent-agent\nspec:\n  role: Builder\n  brain: {template: persistent}\n  identity: {name: persistent-worker, ownership: existing}\n  lifecycle: persistent\n  permissions: {approval: ask, filesystem: workspace, unattended: deny}\n`);
    reload();
    const input = baseInput(brain('persistent'));
    input.source = { kind: 'persistent_resource', agentId: 'persistent-agent' };
    input.adapter = adapter(brain('persistent'));
    const plan = resolveAgentPlan(input);
    expect(plan).toMatchObject({ agentId: 'persistent-agent', lifecycle: 'persistent', identity: { ownership: 'existing' } });
    expect(plan.sourceRevisions.map(item => item.id)).toEqual(['persistent-agent', 'persistent', 'Builder']);
  });

  it('inherits atomic Brain and missing permission fields from a verified creator plan', () => {
    const creator = resolveAgentPlan(baseInput(brain('creator')));
    const input = baseInput();
    delete (input.source as { brain?: BrainSpec }).brain;
    (input.source as { permissions?: Partial<PermissionSpec> }).permissions = { approval: 'ask' };
    input.creatorEvidence = verifiedCreator(creator); input.adapter = adapter(brain('creator'));
    const plan = resolveAgentPlan(input);
    expect(plan.brain.model).toBe('creator');
    expect(plan.brainProvenance).toMatchObject({ layer: 'creator', creatorPlanDigest: creator.planDigest });
    expect(plan.permissionProvenance.filesystem.layer).toBe('creator');
    expect(plan.identity).toEqual({ name: 'worker-1', ownership: 'create_temporary' });
    expect(plan.sourceRevisions).toEqual(expect.arrayContaining(creator.sourceRevisions));
  });

  it('rejects stale or tampered creator plan digests', () => {
    const creator = resolveAgentPlan(baseInput(brain('creator')));
    const tampered = JSON.parse(JSON.stringify(creator)) as AgentPlan;
    (tampered.permissions as { filesystem: string }).filesystem = 'unrestricted';
    expect(() => validateCreatorPlanAgainstTrustedBindings(tampered, {
      agentId: creator.agentId, generation: creator.generation,
      planDigest: creator.planDigest, snapshotDigest: creator.snapshotDigest,
    })).toThrow(/stale or tampered/u);
  });

  it('rejects internally inconsistent creator evidence even with a recomputed digest', () => {
    const creator = JSON.parse(JSON.stringify(resolveAgentPlan(baseInput()))) as AgentPlan;
    if (creator.source.kind !== 'runtime_composition') throw new Error('expected runtime source');
    creator.source.identity.name = 'different-identity';
    const { planDigest: _oldDigest, ...unsigned } = creator;
    creator.planDigest = computeAgentPlanDigest(unsigned);
    expect(() => validateCreatorPlanAgainstTrustedBindings(creator, {
      agentId: creator.agentId, generation: creator.generation,
      planDigest: creator.planDigest, snapshotDigest: creator.snapshotDigest,
    })).toThrow(/source, Role, IdentityIntent, or lifecycle binding/u);
  });

  it('rejects structurally forged creator evidence and mismatched independent bindings', () => {
    const creator = resolveAgentPlan(baseInput());
    const forged = { plan: creator, trusted: {
      agentId: creator.agentId, generation: creator.generation,
      planDigest: creator.planDigest, snapshotDigest: creator.snapshotDigest,
    } } as unknown as AgentPlanResolutionInput['creatorEvidence'];
    const input = baseInput(); input.creatorEvidence = forged;
    expect(() => resolveAgentPlan(input)).toThrow(/not authenticated by the configured authority/u);
    expect(() => validateCreatorPlanAgainstTrustedBindings(creator, {
      agentId: 'another-agent', generation: creator.generation,
      planDigest: creator.planDigest, snapshotDigest: creator.snapshotDigest,
    })).toThrow(/independently trusted bindings/u);
    const authorityIssued = baseInput(); authorityIssued.creatorEvidence = verifiedCreator(creator);
    expect(() => resolveWithoutAuthority(authorityIssued)).toThrow(/not authenticated by the configured authority/u);
  });

  it.each([
    ['subject', { subjectPrincipalId: 'someone-else' }],
    ['scope', { resourceScope: 'agents/elsewhere' }],
    ['expiry', { expiresAt: 999 }],
    ['revision', { revision: 'auth-2' }],
    ['ceiling', { ceilings: { approval: 'auto' } }],
  ])('rejects an Owner grant with invalid %s binding', (_name, patch) => {
    const creator = resolveAgentPlan(baseInput());
    const input = baseInput(brain('explicit')); input.creatorEvidence = verifiedCreator(creator);
    (input.source as { permissions: PermissionSpec }).permissions.approval = 'allow';
    const grant = {
      grantId: 'grant-1', authenticatedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1',
      operationId: 'op-1', operationType: 'agent.create', resourceScope: 'agents/worker-1',
      revision: 'auth-3', expiresAt: 2000, ceilings: { approval: 'allow' }, ...patch,
    } as import('../src/agent-plan.js').OwnerDelegationGrant;
    expect(() => {
      input.ownerDelegationEvidence = verifiedGrant(grant);
      resolveAgentPlan(input);
    }).toThrow(/grant|ceiling|expired|trusted bindings/u);
  });

  it('allows only each broadened field covered by a bound Owner grant and records the decision', () => {
    const creator = resolveAgentPlan(baseInput());
    const input = baseInput(); input.creatorEvidence = verifiedCreator(creator);
    (input.source as { permissions: PermissionSpec }).permissions = {
      approval: 'allow', filesystem: 'unrestricted', unattended: 'deny',
    };
    input.adapter = adapter(brain('explicit'), {
      approval: 'allow', filesystem: 'unrestricted', unattended: 'deny',
    });
    const grant = {
      grantId: 'grant-1', authenticatedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1',
      operationId: 'op-1', operationType: 'agent.create', resourceScope: 'agents/worker-1',
      revision: 'auth-3', expiresAt: 1000, ceilings: { approval: 'allow', filesystem: 'unrestricted' },
    } as const;
    input.ownerDelegationEvidence = verifiedGrant(grant);
    const plan = resolveAgentPlan(input);
    expect(plan.delegation.approval).toMatchObject({ creator: 'ask', grantCeiling: 'allow', decision: 'owner_grant' });
    expect(plan.delegation.filesystem.decision).toBe('owner_grant');
    expect(plan.delegation.unattended.decision).toBe('within_creator');
    expect(plan.ownerDelegation).toEqual({ grant, trusted: {
      pinnedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1', operationId: 'op-1',
      operationType: 'agent.create', resourceScope: 'agents/worker-1', authorizationRevision: 'auth-3',
    } });
  });

  it('rejects delegation grants without creator context and binds adapter evidence to permissions', () => {
    const noCreator = baseInput();
    const grant = {
      grantId: 'grant-1', authenticatedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1',
      operationId: 'op-1', operationType: 'agent.create', resourceScope: 'agents/worker-1',
      revision: 'auth-3', expiresAt: 2000, ceilings: { approval: 'allow' },
    } as const;
    noCreator.ownerDelegationEvidence = verifiedGrant(grant);
    expect(() => resolveAgentPlan(noCreator)).toThrow(/requires authenticated creator/u);
    const wrongPolicy = baseInput();
    wrongPolicy.adapter.permissionsDigest = computePermissionsDigest(permissions('allow'));
    expect(() => resolveAgentPlan(wrongPolicy)).toThrow(/another permission policy/u);
  });

  it('rejects structurally forged Owner evidence', () => {
    const creator = resolveAgentPlan(baseInput());
    const grant = {
      grantId: 'grant-1', authenticatedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1',
      operationId: 'op-1', operationType: 'agent.create', resourceScope: 'agents/worker-1',
      revision: 'auth-3', expiresAt: 2000, ceilings: { approval: 'allow' as const },
    };
    const input = baseInput(); input.creatorEvidence = verifiedCreator(creator);
    input.ownerDelegationEvidence = { grant, trusted: {
      pinnedOwnerCid: 'owner-cid', subjectPrincipalId: 'owner-1', operationId: 'op-1',
      operationType: 'agent.create', resourceScope: 'agents/worker-1', authorizationRevision: 'auth-3',
    } } as unknown as AgentPlanResolutionInput['ownerDelegationEvidence'];
    expect(() => resolveAgentPlan(input)).toThrow(/not authenticated by the configured authority/u);
  });

  it('keeps stable Agent ID independent from a valid bounded identity name', () => {
    const input = baseInput();
    if (input.source.kind !== 'runtime_composition') throw new Error('expected runtime source');
    input.source.identity.name = 'Worker Person@host';
    const plan = resolveAgentPlan(input);
    expect(plan.agentId).toBe('worker-1');
    expect(plan.identity.name).toBe('Worker Person@host');
  });

  it('requires exact resource revisions or digest-bound runtime provenance', () => {
    const creator = verifiedCreator(resolveAgentPlan(baseInput()));
    const missing = baseInput(); missing.creatorEvidence = creator;
    missing.taskDefault = {
      source: { kind: 'resource', resourceKind: 'TasksPolicy', resourceId: 'missing' },
      brain: { template: 'task' },
    };
    expect(() => resolveAgentPlan(missing)).toThrow(/requires TasksPolicy 'missing' source revision/u);
    const unbound = baseInput(); unbound.taskDefault = {
      source: { kind: 'current_operation' },
      brain: { template: 'explicit' },
    };
    expect(() => resolveAgentPlan(unbound)).toThrow(/current_operation is not allowed/u);
    const current = resolveAgentPlan(baseInput());
    expect(current.brainProvenance).toMatchObject({
      sourceType: 'runtime_operation', sourceId: 'op-1',
      sourceDigest: computeOperationDigest(baseInput().operation),
    });
  });

  it('appends Role context only in template → room → task/member order with byte provenance', () => {
    const input = baseInput();
    input.roleContext = {
      template: { source: { kind: 'resource', resourceKind: 'RoomTemplate', resourceId: 'template-1' }, mission_append: 'T mission', persona_append: 'T persona' },
      room: { source: operationSource(), mission_append: 'R mission' },
      taskMember: { source: operationSource(), mission_append: 'M mission', persona_append: 'M persona' },
    };
    const role = resolveAgentPlan(input).role;
    expect(role.effective.mission).toBe(`Base mission${ROLE_CONTEXT_SEPARATOR}T mission${ROLE_CONTEXT_SEPARATOR}R mission${ROLE_CONTEXT_SEPARATOR}M mission`);
    expect(role.effective.persona).toBe(`Base persona${ROLE_CONTEXT_SEPARATOR}T persona${ROLE_CONTEXT_SEPARATOR}M persona`);
    expect(role.appendProvenance.map(item => item.layer)).toEqual(['template', 'room', 'task_member']);
    expect(role.missionBytes).toBe(Buffer.byteLength(role.effective.mission!));
  });

  it('rejects Role replacement keys and per-layer or effective context overflow', () => {
    const unknown = baseInput() as AgentPlanResolutionInput & { roleContext: { room: Record<string, unknown> } };
    unknown.roleContext = { room: { source: operationSource(), bio: 'override' } };
    expect(() => resolveAgentPlan(unknown)).toThrow(/unknown key.*bio/u);
    const overflow = baseInput();
    overflow.roleContext = { room: { source: operationSource(), mission_append: 'x'.repeat(64 * 1024 + 1) } };
    expect(() => resolveAgentPlan(overflow)).toThrow(/at most 65536/u);
    const finalOverflow = baseInput();
    finalOverflow.roleContext = { room: { source: operationSource(), mission_append: 'x'.repeat(64 * 1024) } };
    expect(() => resolveAgentPlan(finalOverflow)).toThrow(/effective Role context/u);
  });

  it('binds adapter validation to Brain and rejects unredacted or sensitive descriptors', () => {
    const wrong = baseInput(); wrong.adapter.brainDigest = computeBrainDigest(brain('room'));
    expect(() => resolveAgentPlan(wrong)).toThrow(/another Brain/u);
    const unredacted = baseInput(); (unredacted.adapter as { redacted: boolean }).redacted = false;
    expect(() => resolveAgentPlan(unredacted)).toThrow(/explicitly redacted/u);
    for (const alias of ['binary', 'credential', 'headers', 'launch']) {
      const sensitive = baseInput();
      (sensitive.adapter.nativeDescriptor as unknown as Record<string, unknown>)[alias] = 'leak';
      expect(() => resolveAgentPlan(sensitive)).toThrow(/unknown key/u);
    }
    const arbitraryMode = baseInput();
    (arbitraryMode.adapter.nativeDescriptor as unknown as Record<string, unknown>).approvalMode = 'secret-value';
    expect(() => resolveAgentPlan(arbitraryMode)).toThrow(/approval mode code is invalid/u);
  });

  it('is deterministic, deep-freezes output, records membership, and never mutates input', () => {
    const input = baseInput();
    input.membership = { roomId: 'room-1', taskId: 'task-1', slot: 'secretary', ordinal: 2, memberId: 'member-2' };
    input.adapter.nativeDescriptor = {
      approvalMode: 'ask', filesystemMode: 'workspace', unattendedMode: 'deny',
      exact: true,
    };
    const before = JSON.stringify(input);
    const left = resolveAgentPlan(input);
    expect(JSON.stringify(input)).toBe(before);
    const reordered = JSON.parse(JSON.stringify(input)) as AgentPlanResolutionInput;
    reordered.adapter.nativeDescriptor = {
      exact: true, unattendedMode: 'deny',
      filesystemMode: 'workspace', approvalMode: 'ask',
    };
    const right = resolveAgentPlan(reordered);
    expect(left.planDigest).toBe(right.planDigest);
    expect(left.membership).toEqual({ roomId: 'room-1', taskId: 'task-1', slot: 'secretary', ordinal: 2, memberId: 'member-2' });
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.permissionProvenance.approval)).toBe(true);
  });

  it('rejects undefined ambiguity and unknown source keys', () => {
    const undefinedField = baseInput() as AgentPlanResolutionInput & { mystery?: undefined };
    Object.defineProperty(undefinedField, 'mystery', { value: undefined, enumerable: true });
    expect(() => resolveAgentPlan(undefinedField)).toThrow(/undefined|unknown key/u);
    const xor = baseInput();
    (xor.source as unknown as Record<string, unknown>).persistentResource = 'also-persistent';
    expect(() => resolveAgentPlan(xor)).toThrow(/unknown key.*persistentResource/u);
    const permission = baseInput();
    ((permission.source as { permissions: Record<string, unknown> }).permissions).network = 'all';
    expect(() => resolveAgentPlan(permission)).toThrow(/unknown key.*network/u);
    const sourceKind = baseInput();
    (sourceKind.source as unknown as Record<string, unknown>).kind = 'mystery';
    expect(() => resolveAgentPlan(sourceKind)).toThrow(/source.kind must be/u);
    const layerKind = baseInput();
    layerKind.taskDefault = {
      source: { kind: 'mystery' } as never, brain: { template: 'task' },
    };
    expect(() => resolveAgentPlan(layerKind)).toThrow(/source.kind is invalid/u);
  });
});
