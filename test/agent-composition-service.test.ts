import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentCompositionError, AgentCompositionService,
  type AgentCompositionAuthority, type AgentCompositionRequest,
  type TrustedCompositionContext, type VerifiedCreationCallerEvidence,
} from '../src/agent-composition-service.js';
import {
  computeBrainDigest, computePermissionsDigest,
  type AgentPlan, type OwnerDelegationGrant, type TrustedCreatorPlanBindings,
  type TrustedOwnerDelegationBindings, type VerifiedCreatorPlanEvidence,
  type VerifiedOwnerDelegationEvidence,
} from '../src/agent-plan.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import {
  computeBrainAdapterPolicyDigest, type BrainAdapterEvidenceAuthority,
  type BrainAdapterPolicy, type TrustedAdapterEnforcementBindings,
  type VerifiedAdapterEnforcementEvidence,
} from '../src/harness/brain-adapter.js';
import type { BrainSpec, PermissionSpec } from '../src/config-resources.js';

let root: string;
let contexts: WeakMap<object, Readonly<TrustedCompositionContext>>;
let creators: WeakMap<object, { plan: AgentPlan; trusted: TrustedCreatorPlanBindings }>;
let owners: WeakMap<object, { grant: OwnerDelegationGrant; trusted: TrustedOwnerDelegationBindings }>;
let adapterTrust: WeakMap<object, TrustedAdapterEnforcementBindings>;
let nextGeneration: number;
let allocate: ReturnType<typeof vi.fn>;
let policyCalls: ReturnType<typeof vi.fn>;
let authority: AgentCompositionAuthority;
let service: AgentCompositionService;

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const brain: BrainSpec = { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high', session: 'acp' };
const permissions: PermissionSpec = { approval: 'ask', filesystem: 'workspace', unattended: 'deny' };
const source = (agentId = 'worker-1', patch: Record<string, unknown> = {}) => ({
  kind: 'runtime_composition' as const, agentId, role: 'Builder',
  identity: { name: agentId, ownership: 'create_temporary' as const }, lifecycle: 'temporary' as const,
  brain: { ...brain }, permissions: { ...permissions }, ...patch,
});
const request = (callerEvidence: VerifiedCreationCallerEvidence, patch: Partial<AgentCompositionRequest> = {}) =>
  ({ callerEvidence, source: source(), ...patch }) as AgentCompositionRequest;

function write(relative: string, contents: string): void {
  const path = join(root, 'fleet.conf.d', relative); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
function caller(kind: 'owner' | 'agent' = 'owner', id = kind === 'owner' ? 'owner-1' : 'creator-1') {
  const evidence = {} as VerifiedCreationCallerEvidence;
  const snapshot = loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') });
  contexts.set(evidence as object, freeze({
    principal: { id, kind }, operation: { id: 'op-1', type: 'agent.create', resourceScope: 'agents/worker-1' },
    authorizationRevision: 'auth-1', ...(kind === 'owner' ? { authenticatedOwnerCid: 'owner-cid' } : {}),
    snapshot, snapshotRevision: 'graph-1', issuedAt: 100,
  }));
  return evidence;
}
function policyFor(selectedBrain: Readonly<BrainSpec>, selectedPermissions: PermissionSpec) {
  const value: BrainAdapterPolicy = {
    schemaVersion: 1, kind: 'codex_acp', adapterVersion: '1.1.7',
    modelPolicy: { schemaVersion: 1, kind: 'syntax_only', revision: 'syntax-1' },
    launch: { kind: 'bundled' },
  };
  const policy = { revision: 'policy-1', digest: computeBrainAdapterPolicyDigest('policy-1', value), value };
  const evidence = {} as VerifiedAdapterEnforcementEvidence;
  adapterTrust.set(evidence as object, {
    harness: 'codex', session: 'acp', adapterId: 'codex-acp', adapterVersion: '1.1.7',
    policyDigest: policy.digest, brainDigest: computeBrainDigest(selectedBrain as BrainSpec),
    permissionsDigest: computePermissionsDigest(selectedPermissions),
    launch: {
      kind: 'bundled', packageName: '@agentclientprotocol/codex-acp',
      manifestPath: '/trusted/codex/package.json', entrypointPath: '/trusted/codex/index.js',
      version: '1.1.7', identity: {
        manifest: { path: '/trusted/codex/package.json', dev: '1', ino: '2', size: 10,
          mtimeNs: '3', sha256: `sha256:${'a'.repeat(64)}` },
        entrypoint: { path: '/trusted/codex/index.js', dev: '1', ino: '4', size: 10,
          mtimeNs: '3', sha256: `sha256:${'b'.repeat(64)}` },
      },
    },
    enforcement: { approval: 'native_adapter', filesystem: 'native_adapter', unattended: 'body_controller' },
  });
  return { policy, enforcementEvidence: evidence };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-composition-')); mkdirSync(join(root, 'fleet.conf.d'));
  writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
  write('roles.d/builder.yaml', 'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: secret mission\n  persona: secret persona\n');
  write('agents.d/persist.yaml', `kind: Agent\nversion: 1\nid: persist\nspec:\n  role: Builder\n  brain: {harness: codex, model: gpt-5.6-sol, effort: high, session: acp}\n  identity: {name: persist, ownership: existing}\n  lifecycle: persistent\n  permissions: {approval: ask, filesystem: workspace, unattended: deny}\n`);
  contexts = new WeakMap(); creators = new WeakMap(); owners = new WeakMap(); adapterTrust = new WeakMap(); nextGeneration = 1;
  allocate = vi.fn(input => ({
    agentId: input.agentId, operationId: input.operation.id,
    authorizationRevision: input.authorizationRevision,
    snapshotDigest: input.snapshotDigest, snapshotRevision: input.snapshotRevision,
    generation: nextGeneration++,
  }));
  authority = {
    authenticateContext: evidence => contexts.get(evidence as object), allocateGeneration: allocate,
    authenticateCreator: evidence => creators.get(evidence as object),
    authenticateOwnerDelegation: evidence => owners.get(evidence as object),
  };
  const adapterAuthority: BrainAdapterEvidenceAuthority = {
    authenticateAdapterEvidence: evidence => adapterTrust.get(evidence as object),
  };
  policyCalls = vi.fn((selected: Readonly<BrainSpec>, selectedPermissions: PermissionSpec) =>
    policyFor(selected, selectedPermissions));
  service = new AgentCompositionService(authority, { resolvePolicy: policyCalls }, adapterAuthority, () => 200);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('authenticated inert Agent composition', () => {
  it('prepares direct Owner input once and exposes only an opaque redacted summary', () => {
    const prepared = service.prepare(request(caller()));
    expect(prepared).toMatchObject({ redacted: true, agentId: 'worker-1', generation: 1, brain, permissions });
    expect(allocate).toHaveBeenCalledOnce(); expect(policyCalls).toHaveBeenCalledOnce();
    expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(service.consume(prepared))).toBe(true);
    expect(() => JSON.stringify(prepared)).toThrow(/foreign_prepared/u);
    const shown = JSON.stringify(service.inspect(prepared));
    expect(shown).not.toMatch(/secret mission|secret persona|owner-cid|roles\.d/u);
    expect(() => service.consume({ ...prepared } as never)).toThrow(/foreign_prepared/u);
  });

  it('rejects absent/foreign context and caller-controlled graph or adapter fields before allocation', () => {
    expect(() => service.prepare(request({} as VerifiedCreationCallerEvidence))).toThrow(/unauthenticated/u);
    const raw = { ...request(caller()), snapshot: {}, adapter: {} } as unknown as AgentCompositionRequest;
    expect(() => service.prepare(raw)).toThrow(/invalid_request/u);
    expect(allocate).not.toHaveBeenCalled(); expect(policyCalls).not.toHaveBeenCalled();
  });

  it('requires exact own enumerable request keys and rejects symbols/non-enumerables', () => {
    const evidence = caller();
    for (const raw of [{ callerEvidence: evidence }, { source: source() }])
      expect(() => service.prepare(raw as AgentCompositionRequest)).toThrow(/invalid_request/u);
    const symbolExtra = request(evidence) as AgentCompositionRequest & Record<symbol, unknown>;
    symbolExtra[Symbol('extra')] = true;
    expect(() => service.prepare(symbolExtra)).toThrow(/invalid_request/u);
    const hidden = request(evidence) as AgentCompositionRequest & { hidden?: boolean };
    Object.defineProperty(hidden, 'hidden', { value: true });
    expect(() => service.prepare(hidden)).toThrow(/invalid_request/u);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each([
    ['principal id', { principal: { id: '../bad', kind: 'owner' } }],
    ['principal kind', { principal: { id: 'owner-1', kind: 'other' } }],
    ['operation', { operation: { id: 'bad id', type: 'agent.create', resourceScope: 'agents/x' } }],
    ['revision', { authorizationRevision: '../bad' }],
    ['owner cid', { authenticatedOwnerCid: '../bad' }],
    ['snapshot revision', { snapshotRevision: '../bad' }],
    ['issued time', { issuedAt: -1 }],
  ])('rejects malformed trusted context %s before allocation', (_name, patch) => {
    const goodEvidence = caller(); const good = contexts.get(goodEvidence as object)!;
    const evidence = {} as VerifiedCreationCallerEvidence;
    contexts.set(evidence as object, freeze({ ...good, ...patch } as TrustedCompositionContext));
    expect(() => service.prepare(request(evidence))).toThrow(/invalid_context/u);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('rejects mutable, spread, accessor, digest-only, and foreign-authority contexts', () => {
    for (const bad of [
      { snapshot: { schemaVersion: 2, digest: `sha256:${'a'.repeat(64)}` } },
      { snapshot: { ...loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') }) } },
    ]) {
      const evidence = {} as VerifiedCreationCallerEvidence;
      contexts.set(evidence as object, bad as unknown as TrustedCompositionContext);
      expect(() => service.prepare(request(evidence))).toThrow(/invalid_context/u);
    }
    const accessor = {} as TrustedCompositionContext;
    Object.defineProperty(accessor, 'snapshot', { enumerable: true, get: () => { throw new Error('secret'); } });
    const evidence = {} as VerifiedCreationCallerEvidence; contexts.set(evidence as object, Object.freeze(accessor));
    expect(() => service.prepare(request(evidence))).toThrow(AgentCompositionError);
    const otherEvidence = caller(); const other = new AgentCompositionService({ ...authority,
      authenticateContext: () => undefined }, { resolvePolicy: policyCalls },
      { authenticateAdapterEvidence: e => adapterTrust.get(e as object) });
    expect(() => other.prepare(request(otherEvidence))).toThrow(/unauthenticated/u);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('binds generation to selected target and exact trusted snapshot context, rejecting reuse', () => {
    const evidence = caller(); service.prepare(request(evidence));
    nextGeneration = 1;
    expect(() => service.prepare(request(evidence))).toThrow(/generation_reuse/u);
    allocate.mockImplementationOnce(input => ({
      agentId: input.agentId, operationId: input.operation.id,
      authorizationRevision: input.authorizationRevision,
      snapshotDigest: `sha256:${'f'.repeat(64)}`, snapshotRevision: input.snapshotRevision,
      generation: 3,
    }));
    expect(() => service.prepare(request(evidence, { source: source('worker-2') }))).toThrow(/invalid_generation/u);
    expect(policyCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['agent', { agentId: 'wrong' }], ['operation', { operationId: 'wrong' }],
    ['revision', { authorizationRevision: 'wrong' }], ['snapshot revision', { snapshotRevision: 'wrong' }],
    ['zero', { generation: 0 }], ['negative', { generation: -1 }],
  ])('rejects allocation %s mismatch before adapter', (_name, patch) => {
    allocate.mockImplementationOnce(input => ({
      agentId: input.agentId, operationId: input.operation.id,
      authorizationRevision: input.authorizationRevision, snapshotDigest: input.snapshotDigest,
      snapshotRevision: input.snapshotRevision, generation: 1, ...patch,
    }));
    expect(() => service.prepare(request(caller()))).toThrow(/invalid_generation/u);
    expect(policyCalls).not.toHaveBeenCalled();
  });

  it('selects a persistent target only from the authenticated snapshot', () => {
    const prepared = service.prepare(request(caller(), {
      source: { kind: 'persistent_resource', agentId: 'persist' },
    }));
    expect(prepared).toMatchObject({ agentId: 'persist', lifecycle: 'persistent' });
    expect(() => service.prepare(request(caller(), {
      source: { kind: 'persistent_resource', agentId: 'absent' },
    }))).toThrow(/invalid_request/u);
  });

  it('requires agent caller identity to equal trusted creator agentId and plan.agentId', () => {
    const ownerPrepared = service.prepare(request(caller(), { source: source('creator-1') }));
    const creatorPlan = service.consume(ownerPrepared);
    const creatorEvidence = {} as VerifiedCreatorPlanEvidence;
    creators.set(creatorEvidence as object, { plan: creatorPlan, trusted: {
      agentId: creatorPlan.agentId, generation: creatorPlan.generation,
      planDigest: creatorPlan.planDigest, snapshotDigest: creatorPlan.snapshotDigest,
    } });
    const agentEvidence = caller('agent', 'creator-1');
    expect(service.prepare(request(agentEvidence, { creatorEvidence })).generation).toBe(2);
    const wrongAgent = caller('agent', 'agent-a');
    expect(() => service.prepare(request(wrongAgent, { creatorEvidence }))).toThrow(/invalid_lineage/u);
  });

  it('authenticates creator evidence once and cannot substitute a second record', () => {
    const creatorPrepared = service.prepare(request(caller(), { source: source('creator-1') }));
    const creatorPlan = service.consume(creatorPrepared); const evidence = {} as VerifiedCreatorPlanEvidence;
    let calls = 0;
    authority.authenticateCreator = () => { calls += 1; return calls === 1 ? { plan: creatorPlan, trusted: {
      agentId: creatorPlan.agentId, generation: creatorPlan.generation,
      planDigest: creatorPlan.planDigest, snapshotDigest: creatorPlan.snapshotDigest,
    } } : undefined; };
    service.prepare(request(caller('agent', 'creator-1'), { creatorEvidence: evidence }));
    expect(calls).toBe(1);
  });

  it('passes valid Owner delegation once and rejects invalid service-level evidence', () => {
    const creatorPrepared = service.prepare(request(caller(), { source: source('creator-1') }));
    const creatorPlan = service.consume(creatorPrepared); const creatorEvidence = {} as VerifiedCreatorPlanEvidence;
    creators.set(creatorEvidence as object, { plan: creatorPlan, trusted: {
      agentId: creatorPlan.agentId, generation: creatorPlan.generation,
      planDigest: creatorPlan.planDigest, snapshotDigest: creatorPlan.snapshotDigest,
    } });
    const grant: OwnerDelegationGrant = {
      grantId: 'grant-1', authenticatedOwnerCid: 'owner-cid', subjectPrincipalId: 'creator-1',
      operationId: 'op-1', operationType: 'agent.create', resourceScope: 'agents/worker-1',
      revision: 'auth-1', expiresAt: 300, ceilings: { approval: 'allow' },
    };
    const trusted: TrustedOwnerDelegationBindings = {
      pinnedOwnerCid: 'owner-cid', subjectPrincipalId: 'creator-1', operationId: 'op-1',
      operationType: 'agent.create', resourceScope: 'agents/worker-1', authorizationRevision: 'auth-1',
    };
    const ownerEvidence = {} as VerifiedOwnerDelegationEvidence; owners.set(ownerEvidence as object, { grant, trusted });
    const elevated = source(); elevated.permissions.approval = 'allow';
    const prepared = service.prepare(request(caller('agent', 'creator-1'), {
      source: elevated, creatorEvidence, ownerDelegationEvidence: ownerEvidence,
    }));
    expect(service.consume(prepared).delegation.approval.decision).toBe('owner_grant');
    const bad = {} as VerifiedOwnerDelegationEvidence;
    expect(() => service.prepare(request(caller('agent', 'creator-1'), {
      source: elevated, creatorEvidence, ownerDelegationEvidence: bad,
    }))).toThrow(/invalid_lineage/u);
  });

  it('inherits Brain atomically and permissions per field from the authenticated creator', () => {
    const creatorPrepared = service.prepare(request(caller(), { source: source('creator-1') }));
    const creatorPlan = service.consume(creatorPrepared); const creatorEvidence = {} as VerifiedCreatorPlanEvidence;
    creators.set(creatorEvidence as object, { plan: creatorPlan, trusted: {
      agentId: creatorPlan.agentId, generation: creatorPlan.generation,
      planDigest: creatorPlan.planDigest, snapshotDigest: creatorPlan.snapshotDigest,
    } });
    const inherited = source('child'); delete (inherited as Partial<typeof inherited>).brain;
    (inherited as typeof inherited).permissions = { approval: 'ask' } as PermissionSpec;
    const prepared = service.prepare(request(caller('agent', 'creator-1'), {
      source: inherited as never, creatorEvidence,
    }));
    const child = service.consume(prepared);
    expect(child.brain).toEqual(creatorPlan.brain);
    expect(child.permissionProvenance.filesystem.layer).toBe('creator');
  });

  it('mints nothing consumable after allocation or adapter failure and redacts causes', () => {
    allocate.mockImplementationOnce(() => { throw new Error(`${root}/secret allocation`); });
    expect(() => service.prepare(request(caller()))).toThrow('agent composition: invalid_generation');
    policyCalls.mockImplementationOnce(() => { throw new Error(`${root}/secret adapter`); });
    expect(() => service.prepare(request(caller()))).toThrow('agent composition: adapter_rejected');
    nextGeneration = 1;
    expect(() => service.prepare(request(caller()))).toThrow('agent composition: generation_reuse');
  });

  it('rejects request accessors without evaluating or leaking them', () => {
    const raw = request(caller()) as unknown as Record<string, unknown>;
    Object.defineProperty(raw, 'source', {
      enumerable: true, get: () => { throw new Error(`${root}/secret accessor`); },
    });
    expect(() => service.prepare(raw as unknown as AgentCompositionRequest))
      .toThrow('agent composition: invalid_request');
    expect(allocate).not.toHaveBeenCalled();
  });

  it('rejects nested source/layer/membership accessors without invoking them', () => {
    const evidence = caller(); let invoked = 0;
    for (const patch of [
      { source: Object.defineProperty(source(), 'agentId', {
        enumerable: true, get: () => { invoked += 1; return invoked === 1 ? 'agent-a' : 'agent-b'; },
      }) },
      { explicitOperation: { source: { kind: 'current_operation' },
        permissions: Object.defineProperty({}, 'approval', {
          enumerable: true, get: () => { invoked += 1; return 'ask'; },
        }) } },
      { membership: Object.defineProperty({}, 'roomId', {
        enumerable: true, get: () => { invoked += 1; return 'room-secret'; },
      }) },
    ] as Partial<AgentCompositionRequest>[]) {
      expect(() => service.prepare(request(evidence, patch))).toThrow(/invalid_request/u);
    }
    expect(invoked).toBe(0); expect(allocate).not.toHaveBeenCalled();
  });

  it('owns selections before allocation and policy callbacks can mutate caller objects', () => {
    const evidence = caller(); const mutable = source();
    allocate.mockImplementationOnce(input => {
      mutable.agentId = 'substituted'; mutable.brain.model = 'mutated-during-allocation';
      return { agentId: input.agentId, operationId: input.operation.id,
        authorizationRevision: input.authorizationRevision, snapshotDigest: input.snapshotDigest,
        snapshotRevision: input.snapshotRevision, generation: 1 };
    });
    policyCalls.mockImplementationOnce((selected: BrainSpec, selectedPermissions: PermissionSpec) => {
      mutable.permissions.filesystem = 'unrestricted';
      return policyFor(selected, selectedPermissions);
    });
    const prepared = service.prepare(request(evidence, { source: mutable }));
    expect(prepared).toMatchObject({ agentId: 'worker-1', brain: { model: 'gpt-5.6-sol' },
      permissions: { filesystem: 'workspace' } });
    expect(service.consume(prepared).agentId).toBe('worker-1');
  });

  it('owns request values after return and rejects foreign-service Prepared objects', () => {
    const evidence = caller(); const mutable = source(); const prepared = service.prepare(request(evidence, { source: mutable }));
    mutable.brain.model = 'mutated'; mutable.permissions.filesystem = 'unrestricted';
    expect(service.consume(prepared).brain.model).toBe('gpt-5.6-sol');
    const foreign = new AgentCompositionService(authority, { resolvePolicy: policyCalls },
      { authenticateAdapterEvidence: e => adapterTrust.get(e as object) });
    expect(() => foreign.consume(prepared)).toThrow(/foreign_prepared/u);
    expect(() => service.consume({ ...prepared } as never)).toThrow(/foreign_prepared/u);
  });
});
