import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentityActionBindings } from '../src/agent-creation-transaction.js';
import { AgentProductionIdentityAuthority } from '../src/agent-production-identity-authority.js';
import { AgentCreationCompositionRoot, createProductionAgentCreationCompositionRoot } from '../src/agent-creation-composition-root.js';
import type { AgentCompositionRequest } from '../src/agent-composition-service.js';
import { computeBrainDigest, computePermissionsDigest } from '../src/agent-plan.js';
import { loadConfigResourceSnapshot } from '../src/config-resource-loader.js';
import { computeBrainAdapterPolicyDigest } from '../src/harness/brain-adapter.js';
import type { BrainAdapterPolicy, TrustedAdapterEnforcementBindings,
  VerifiedAdapterEnforcementEvidence } from '../src/harness/brain-adapter.js';
import { readAgentSupervisorHandoff } from '../src/agent-supervisor-handoff.js';
import { createInternalTempAgentPrelaunchAuthority } from '../src/temp-agent-supervisor-rehydration.js';
import { AgentInstallationService } from '../src/agent-installation.js';

const bindings = (): IdentityActionBindings => ({
  actionKey: `sha256:${'1'.repeat(64)}`, actionId: 'action-1', agentId: 'agent-1',
  generation: 1, name: 'agent-1', ownership: 'create_persistent',
  planDigest: `sha256:${'2'.repeat(64)}`, reservationDigest: `sha256:${'3'.repeat(64)}`,
});
const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('production Agent identity authority', () => {
  it('issues created ownership only to the same instance after exact post-create presence', async () => {
    let present = false;
    const cid = 'A'.repeat(64);
    const provisioner = {
      exists: vi.fn(async () => present),
      inspect: vi.fn(async () => present ? { state: 'present' as const, cid } : { state: 'absent' as const }),
      create: vi.fn(async () => { present = true; return { state: 'created_here' as const, cid }; }),
      remove: vi.fn(async () => { present = false; }),
    };
    const authority = new AgentProductionIdentityAuthority(provisioner, { exposeLocal: true });
    const input = bindings();
    const initial = await authority.reconcileAcquisition(input);
    expect(authority.authenticateAcquisition(initial)).toMatchObject({ outcome: 'not_started' });
    const capability = await authority.createPersistent(input);
    const acquired = await authority.reconcileAcquisition({ ...input, receiptHint: capability });
    const proof = authority.authenticateAcquisition(acquired)!;
    expect(proof).toMatchObject({ outcome: 'created_by_action' });
    const verification = await authority.verifyIdentity({ ...input, acquisition: 'created',
      receiptDigest: proof.receiptDigest });
    expect(authority.authenticateVerification(verification)).toMatchObject({
      outcome: 'verified', authenticatedIdentityId: cid,
    });
    const ownership = await authority.reconcileReceipt({ ...input, receiptDigest: proof.receiptDigest! });
    expect(authority.authenticateOwnership(ownership)).toMatchObject({ currentOwner: true });
    await expect(authority.removeCreated(ownership)).rejects.toThrow(/conditional CID/u);
    expect(provisioner.remove).not.toHaveBeenCalled();
  });

  it('does not recover ownership or deletion authority from presence after restart', async () => {
    let present = false;
    const cid = 'B'.repeat(64);
    const provisioner = {
      exists: vi.fn(async () => present),
      inspect: vi.fn(async () => present ? { state: 'present' as const, cid } : { state: 'absent' as const }),
      create: vi.fn(async () => { present = true; return { state: 'created_here' as const, cid }; }),
      remove: vi.fn(async () => { present = false; }),
    };
    const first = new AgentProductionIdentityAuthority(provisioner, {});
    const input = bindings();
    await first.reconcileAcquisition(input);
    await first.createPersistent(input); // process dies before durable receipt transition

    const restarted = new AgentProductionIdentityAuthority(provisioner, {});
    const observed = await restarted.reconcileAcquisition(input);
    expect(restarted.authenticateAcquisition(observed)).toMatchObject({ outcome: 'unknown' });
    expect(restarted.authenticateAcquisition(observed)).not.toMatchObject({ outcome: 'existing_before_action' });
    const ownership = await restarted.reconcileReceipt({ ...input, receiptDigest: `sha256:${'4'.repeat(64)}` });
    expect(restarted.authenticateOwnership(ownership)).toBeUndefined();
    await expect(restarted.removeCreated(ownership)).rejects.toThrow(/deletion authority unavailable/u);
    expect(provisioner.remove).not.toHaveBeenCalled();
  });

  it('accepts existing_before_action only from an explicit existing lookup', async () => {
    const authority = new AgentProductionIdentityAuthority({ exists: async () => true,
      inspect: async () => ({ state: 'present', cid: 'C'.repeat(64) }) }, {});
    const raw = await authority.lookupExisting(bindings());
    expect(authority.authenticateAcquisition(raw)).toMatchObject({ outcome: 'existing_before_action' });
  });

  it('does not claim creation when another reconciler won and authenticates the exact CID', async () => {
    const cid = 'D'.repeat(64); let present = false;
    const authority = new AgentProductionIdentityAuthority({ exists: async () => present,
      inspect: async () => present ? { state: 'present', cid } : { state: 'absent' },
      create: async () => { present = true; return { state: 'existing', cid }; } }, {});
    const input = bindings(); await authority.reconcileAcquisition(input);
    const hint = await authority.createPersistent(input);
    const raw = await authority.reconcileAcquisition({ ...input, receiptHint: hint });
    expect(authority.authenticateAcquisition(raw)).toMatchObject({ outcome: 'unknown' });
    expect(authority.authenticateOwnership(hint)).toBeUndefined();
  });

  it('rejects CID mismatch and absent or foreign created receipts', async () => {
    const cid = 'E'.repeat(64); let observedCid = cid;
    // Establish an absent preflight before the create outcome becomes visible.
    let first = true;
    const dynamic = new AgentProductionIdentityAuthority({ exists: async () => false,
      inspect: async () => first ? (first = false, { state: 'absent' }) : { state: 'present', cid: observedCid },
      create: async () => ({ state: 'created_here', cid }) }, {});
    const input = bindings(); await dynamic.reconcileAcquisition(input);
    const capability = await dynamic.createPersistent(input);
    const acquired = dynamic.authenticateAcquisition(await dynamic.reconcileAcquisition({ ...input,
      receiptHint: capability }))!;
    const missing = await dynamic.verifyIdentity({ ...input, acquisition: 'created' });
    expect(dynamic.authenticateVerification(missing)).toMatchObject({ outcome: 'mismatch' });
    const foreign = await dynamic.verifyIdentity({ ...input, acquisition: 'created',
      receiptDigest: `sha256:${'f'.repeat(64)}` });
    expect(dynamic.authenticateVerification(foreign)).toMatchObject({ outcome: 'mismatch' });
    observedCid = 'F'.repeat(64);
    const changed = await dynamic.verifyIdentity({ ...input, acquisition: 'created',
      receiptDigest: acquired.receiptDigest });
    expect(dynamic.authenticateVerification(changed)).toMatchObject({ outcome: 'mismatch' });
  });
});

describe('permanent Agent creation composition root', () => {
  const request = (lifecycle: 'persistent' | 'temporary' = 'persistent') => ({
    callerEvidence: {}, source: { kind: 'runtime_composition', agentId: 'agent-1', role: 'Builder',
      identity: { name: 'agent-1', ownership: lifecycle === 'persistent' ? 'create_persistent' : 'create_temporary' },
      lifecycle, brain: { harness: 'codex', model: 'gpt', effort: 'high', session: 'acp' },
      permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'deny' } },
  } as unknown as AgentCompositionRequest);

  it('publishes the handoff only after authenticated complete', async () => {
    const prepared = { lifecycle: 'persistent', identity: { ownership: 'create_persistent' },
      operation: { id: 'action-1' } };
    const reservation = {}; const complete = {};
    const composition = { prepare: vi.fn(() => prepared) };
    const transaction = { persistPrepared: vi.fn(async () => ({ state: 'complete', reservation })),
      resume: vi.fn(), validateComplete: vi.fn(() => complete),
      authenticateComplete: vi.fn(() => ({ identity: { acquisition: 'created' } })) };
    const locators = { publish: vi.fn(() => ({ kind: 'AgentStartLocator' })) };
    const root = new AgentCreationCompositionRoot(composition as never, transaction as never, locators as never);
    await expect(root.createPermanent(request(), 'action-1')).resolves.toMatchObject({
      state: 'complete', locator: { kind: 'AgentStartLocator' }, identityAcquisition: 'created',
    });
    expect(transaction.persistPrepared).toHaveBeenCalledWith(prepared, { actionId: 'action-1' });
    expect(transaction.validateComplete).toHaveBeenCalledWith(reservation);
    expect(locators.publish).toHaveBeenCalledWith(complete);
  });

  it('does not expose an active generation when locator publication succeeds but handoff publication fails', async () => {
    const trusted = mkdtempSync(join(tmpdir(), 'composition-handoff-failure-')); tempRoots.push(trusted);
    const agentRoot = join(trusted, 'agents', Buffer.from('agent-1').toString('base64url'));
    mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
    const locatorPath = join(agentRoot, 'agent-start-locator.json'); const activePath = join(agentRoot, 'active.json');
    const reservation = {}; const complete = {}; const order: string[] = [];
    const composition = { prepare: () => ({ lifecycle: 'persistent', identity: { ownership: 'create_persistent' },
      operation: { id: 'action-1' } }) };
    const transaction = { persistPrepared: async () => ({ state: 'complete', reservation }), resume: vi.fn(),
      validateComplete: () => complete,
      authenticateComplete: () => ({ identity: { acquisition: 'created', name: 'agent-1' } }) };
    const locators = { publish: () => { order.push('locator'); writeFileSync(locatorPath, '{}\n', { mode: 0o600 });
      return { kind: 'AgentStartLocator' }; } };
    const handoffs = { publish: async () => { order.push('handoff'); throw new Error('handoff fsync failed'); } };
    const root = new AgentCreationCompositionRoot(composition as never, transaction as never,
      locators as never, handoffs as never);
    await expect(root.createPermanent(request(), 'action-1')).rejects.toThrow(/handoff fsync failed/u);
    expect(order).toEqual(['locator', 'handoff']); expect(existsSync(locatorPath)).toBe(true);
    expect(existsSync(activePath)).toBe(false);
    expect(() => readAgentSupervisorHandoff(trusted, 'agent-1')).toThrow(/invalid_handoff/u);
  });

  it('does not publish for ambiguous creation and rejects temporary requests', async () => {
    const composition = { prepare: vi.fn((input: AgentCompositionRequest) => ({
      lifecycle: input.source.kind === 'runtime_composition' ? input.source.lifecycle : 'persistent',
      identity: { ownership: input.source.kind === 'runtime_composition'
        ? input.source.identity.ownership : 'existing' },
      operation: { id: input.source.kind === 'runtime_composition' && input.source.lifecycle === 'temporary'
        ? 'action-2' : 'action-1' },
    })) };
    const transaction = { persistPrepared: vi.fn(async () => ({ state: 'ambiguous', reservation: {} })),
      resume: vi.fn(), validateComplete: vi.fn(), authenticateComplete: vi.fn() };
    const locators = { publish: vi.fn() };
    const root = new AgentCreationCompositionRoot(composition as never, transaction as never, locators as never);
    await expect(root.createPermanent(request(), 'action-1')).resolves.toMatchObject({ state: 'ambiguous' });
    expect(locators.publish).not.toHaveBeenCalled();
    await expect(root.createPermanent(request('temporary'), 'action-2')).rejects.toThrow(/invalid_request/u);
    expect(composition.prepare).toHaveBeenCalledTimes(2);
    expect(transaction.persistPrepared).toHaveBeenCalledOnce();
  });

  it('delegates hostile request ownership to authenticated preparation before any effect', async () => {
    let reads = 0;
    const requestWithGetter = {} as AgentCompositionRequest;
    Object.defineProperty(requestWithGetter, 'source', { enumerable: true, get: () => { reads++; return {}; } });
    const composition = { prepare: vi.fn(() => { throw new Error('unauthenticated caller'); }) };
    const transaction = { persistPrepared: vi.fn(), resume: vi.fn(), validateComplete: vi.fn(),
      authenticateComplete: vi.fn() };
    const locators = { publish: vi.fn() };
    const root = new AgentCreationCompositionRoot(composition as never, transaction as never, locators as never);
    await expect(root.createPermanent(requestWithGetter, 'action-1')).rejects.toThrow(/unauthenticated/u);
    expect(reads).toBe(0);
    expect(transaction.persistPrepared).not.toHaveBeenCalled();
    expect(locators.publish).not.toHaveBeenCalled();
  });

  it('binds the authenticated operation id to the durable action id', async () => {
    const composition = { prepare: vi.fn(() => ({ lifecycle: 'persistent',
      identity: { ownership: 'create_persistent' }, operation: { id: 'authorized-action' } })) };
    const transaction = { persistPrepared: vi.fn(), resume: vi.fn(), validateComplete: vi.fn(),
      authenticateComplete: vi.fn() };
    const root = new AgentCreationCompositionRoot(composition as never, transaction as never,
      { publish: vi.fn() } as never);
    await expect(root.createPermanent(request(), 'other-action')).rejects.toThrow(/invalid_request/u);
    expect(transaction.persistPrepared).not.toHaveBeenCalled();
  });
});

describe('real production Agent creation assembly', () => {
  function setup(presentInitially = false, cidSequence?: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'production-agent-root-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'fleet.conf.d', 'roles.d'), { recursive: true });
    writeFileSync(join(root, 'fleet.yaml'), 'schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n');
    writeFileSync(join(root, 'fleet.conf.d', 'roles.d', 'builder.yaml'),
      'kind: Role\nversion: 1\nid: Builder\nspec:\n  mission: Build\n');
    const snapshot = loadConfigResourceSnapshot({ bootstrapFile: join(root, 'fleet.yaml') });
    const brain = { harness: 'codex', model: 'gpt-test', effort: 'high', session: 'acp' } as const;
    const permissions = { approval: 'ask', filesystem: 'workspace', unattended: 'deny' } as const;
    const evidence = {} as VerifiedAdapterEnforcementEvidence;
    const policyValue: BrainAdapterPolicy = { schemaVersion: 1, kind: 'codex_acp', adapterVersion: '1.1.7',
      modelPolicy: { schemaVersion: 1, kind: 'syntax_only', revision: 'syntax-1' }, launch: { kind: 'bundled' } };
    const policy = { revision: 'policy-1', digest: computeBrainAdapterPolicyDigest('policy-1', policyValue),
      value: policyValue };
    const trusted: TrustedAdapterEnforcementBindings = { harness: 'codex', session: 'acp',
      adapterId: 'codex-acp', adapterVersion: '1.1.7', policyDigest: policy.digest,
      brainDigest: computeBrainDigest(brain), permissionsDigest: computePermissionsDigest(permissions),
      launch: { kind: 'bundled', packageName: '@agentclientprotocol/codex-acp',
        manifestPath: '/trusted/codex/package.json', entrypointPath: '/trusted/codex/index.js',
        version: '1.1.7', identity: { manifest: { path: '/trusted/codex/package.json', dev: '1', ino: '2',
          size: 1, mtimeNs: '3', sha256: `sha256:${'a'.repeat(64)}` }, entrypoint: {
          path: '/trusted/codex/index.js', dev: '1', ino: '4', size: 1, mtimeNs: '3',
          sha256: `sha256:${'b'.repeat(64)}` } } },
      enforcement: { approval: 'native_adapter', filesystem: 'native_adapter', unattended: 'body_controller' } };
    const present = new Set(presentInitially ? ['agent-1'] : []); const cid = 'A'.repeat(64); let creates = 0;
    let cidRead = 0;
    const identityCid = (name: string) => cidSequence?.[Math.min(cidRead++, cidSequence.length - 1)]
      ?? (name === 'agent-1' ? cid : 'B'.repeat(64));
    const provisioner = { exists: async (name: string) => present.has(name),
      inspect: async (name: string) => present.has(name)
        ? { state: 'present' as const, cid: identityCid(name) } : { state: 'absent' as const },
      create: async (name: string) => { creates++; present.add(name);
        return { state: 'created_here' as const, cid: identityCid(name) }; } };
    const make = (faults: Record<string, unknown> = {}) => createProductionAgentCreationCompositionRoot({ trustedStateRoot: join(root, 'trusted'),
      identityProvisioner: provisioner, identityProfile: {},
      policies: { resolvePolicy: () => ({ policy, enforcementEvidence: evidence }) },
      adapterAuthority: { authenticateAdapterEvidence: value => value === evidence ? trusted : undefined }, now: () => 2,
      ...faults });
    const context = { operation: Object.freeze({ id: 'action-1', type: 'agent.create',
      resourceScope: 'agents/agent-1' }), authorizationRevision: 'auth-1', snapshot,
      snapshotRevision: 'graph-1', issuedAt: 1 };
    const source = { kind: 'runtime_composition' as const, agentId: 'agent-1', role: 'Builder',
      identity: { name: 'agent-1', ownership: 'create_persistent' as const }, lifecycle: 'persistent' as const,
      brain, permissions };
    return { root, make, context, source, cid, creates: () => creates };
  }

  it('assembles real authorities and publishes generation-1 CID-bound 0600 handoff', async () => {
    const f = setup(); const assembly = f.make();
    const callerEvidence = assembly.ingress.direct(f.context);
    const result = await assembly.root.createPermanent({ callerEvidence, source: f.source }, 'action-1');
    expect(result).toMatchObject({ state: 'complete', identityAcquisition: 'created',
      locator: { generation: 1 } });
    const locatorPath = join(rootFromLocator(f.root), 'agent-start-locator.json');
    expect(statSync(locatorPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(rootFromLocator(f.root), 'identity-binding.json'), 'utf8')).toContain(f.cid);
    expect(readAgentSupervisorHandoff(join(f.root, 'trusted'), 'agent-1')).toMatchObject({
      actionId: 'action-1', generation: 1, identityEvidenceDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(f.creates()).toBe(1);
    const secondContext = { ...f.context, operation: Object.freeze({ id: 'action-2',
      type: 'agent.create', resourceScope: 'agents/agent-2' }) };
    const secondCaller = assembly.ingress.direct(secondContext);
    const secondSource = { ...f.source, agentId: 'agent-2', identity: {
      name: 'agent-2', ownership: 'create_persistent' as const } };
    const second = await assembly.root.createPermanent({ callerEvidence: secondCaller,
      source: secondSource }, 'action-2');
    expect(second).toMatchObject({ state: 'complete', locator: { generation: 1 } });
    expect(f.creates()).toBe(2);
  });

  it('reserves a temporary plan without identity effects and rehydrates only opaque prelaunch data', async () => {
    const f = setup(); const assembly = f.make(); const callerEvidence = assembly.ingress.direct(f.context);
    const source = { ...f.source, lifecycle: 'temporary' as const,
      identity: { name: 'agent-1', ownership: 'create_temporary' as const } };
    const installed = await assembly.temporary.reserve({ callerEvidence, source }, 'action-1');
    expect(installed).toEqual({ agentId: 'agent-1', generation: 1, lifetime: 'temporary', completion: 'deferred' });
    expect(f.creates()).toBe(0);
    const rehydrator = createInternalTempAgentPrelaunchAuthority(join(f.root, 'trusted'));
    const seam = rehydrator.rehydrate('agent-1');
    expect(seam).toMatchObject({ agentId: 'agent-1', generation: 1 });
    expect(Object.keys(seam).sort()).toEqual(['agentId', 'generation']);
    expect(rehydrator.authenticate(seam)).toMatchObject({ lifetime: 'temporary', actionId: 'action-1' });
    expect(() => readAgentSupervisorHandoff(join(f.root, 'trusted'), 'agent-1')).toThrow();
    const before = readFileSync(join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'),
      'temp-active.json'), 'utf8');
    const retryCaller = assembly.ingress.direct(f.context);
    await expect(assembly.temporary.reserve({ callerEvidence: retryCaller, source }, 'action-1'))
      .resolves.toEqual(installed);
    expect(readFileSync(join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'),
      'temp-active.json'), 'utf8')).toBe(before);
    expect(f.creates()).toBe(0);
  });

  it.each(['role', 'brain', 'identity', 'context', 'action'] as const)(
    'rejects a conflicting temporary replay with changed %s binding and preserves exact handoff', async changed => {
      const f = setup(); const assembly = f.make();
      const source = { ...f.source, lifecycle: 'temporary' as const,
        identity: { name: 'agent-1', ownership: 'create_temporary' as const } };
      const firstCaller = assembly.ingress.direct(f.context);
      await assembly.temporary.reserve({ callerEvidence: firstCaller, source }, 'action-1');
      const path = join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'),
        'temp-active.json'); const before = readFileSync(path, 'utf8');
      const context = changed === 'context' || changed === 'action' ? { ...f.context,
        operation: Object.freeze({ ...f.context.operation, id: changed === 'action' ? 'action-2' : 'action-1',
          resourceScope: changed === 'context' ? 'agents/other' : f.context.operation.resourceScope }) } : f.context;
      const changedSource = changed === 'role' ? { ...source, role: 'Other' }
        : changed === 'brain' ? { ...source, brain: { ...source.brain, model: 'other-model' } }
          : changed === 'identity' ? { ...source, identity: { ...source.identity, name: 'other-name' } }
            : source;
      await expect(assembly.temporary.reserve({ callerEvidence: assembly.ingress.direct(context),
        source: changedSource }, changed === 'action' ? 'action-2' : 'action-1')).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before); expect(f.creates()).toBe(0);
    });

  it('installs an existing permanent identity through real inspection and completion authorities', async () => {
    const f = setup(true); const assembly = f.make(); const installer = new AgentInstallationService(assembly);
    const result = await installer.installPermanent({ context: f.context, actionId: 'action-1',
      composition: { source: { ...f.source, identity: { name: 'agent-1', ownership: 'existing' as const } } } });
    expect(result).toMatchObject({ state: 'complete', identityAcquisition: 'external', identityName: 'agent-1' });
    expect(f.creates()).toBe(0);
    expect(readAgentSupervisorHandoff(join(f.root, 'trusted'), 'agent-1')).toMatchObject({ lifetime: 'persistent' });
    expect(() => createInternalTempAgentPrelaunchAuthority(join(f.root, 'trusted')).rehydrate('agent-1')).toThrow();
    const before = readFileSync(join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'), 'active.json'), 'utf8');
    await expect(installer.installPermanent({ context: f.context, actionId: 'action-1',
      composition: { source: { ...f.source, identity: { name: 'agent-1', ownership: 'existing' as const } } } }))
      .resolves.toMatchObject({ state: 'complete' });
    expect(readFileSync(join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'), 'active.json'), 'utf8')).toBe(before);
  });

  it.each(['role', 'brain', 'identity', 'context'] as const)(
    'rejects permanent replay authority confusion with changed %s binding', async changed => {
      const f = setup(true); const installer = new AgentInstallationService(f.make());
      const source = { ...f.source, identity: { name: 'agent-1', ownership: 'existing' as const } };
      await installer.installPermanent({ context: f.context, actionId: 'action-1', composition: { source } });
      const path = join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'), 'active.json');
      const before = readFileSync(path, 'utf8');
      const context = changed === 'context' ? { ...f.context, authorizationRevision: 'auth-2' } : f.context;
      const changedSource = changed === 'role' ? { ...source, role: 'Other' }
        : changed === 'brain' ? { ...source, brain: { ...source.brain, model: 'other-model' } }
          : changed === 'identity' ? { ...source, identity: { ...source.identity, name: 'other-name' } }
            : source;
      await expect(installer.installPermanent({ context, actionId: 'action-1',
        composition: { source: changedSource } })).rejects.toThrow(/invalid_request/u);
      expect(readFileSync(path, 'utf8')).toBe(before); expect(f.creates()).toBe(0);
    });

  it.each([{ name: 'missing identity', setup: () => setup(false) },
    { name: 'CID substitution', setup: () => setup(true, ['A'.repeat(64), 'B'.repeat(64)]) }])(
    'fails closed for $name without creating an identity or publishing active', async entry => {
      const f = entry.setup(); const installer = new AgentInstallationService(f.make());
      const result = await installer.installPermanent({ context: f.context, actionId: 'action-1',
        composition: { source: { ...f.source, identity: { name: 'agent-1', ownership: 'existing' as const } } } });
      expect(result.state).not.toBe('complete'); expect(f.creates()).toBe(0);
      expect(() => readAgentSupervisorHandoff(join(f.root, 'trusted'), 'agent-1')).toThrow();
    });

  it.each(['creation', 'handoff'] as const)('recovers exact installer replay after %s crash without duplicate identity effect', async boundary => {
    const f = setup(true); let crash = true;
    const assembly = f.make(boundary === 'creation' ? { creationFaults: { afterCreateAuthorized: () => {
      if (crash) { crash = false; throw new Error('crash'); }
    } } } : { handoffFaults: { beforeReplace: () => { if (crash) { crash = false; throw new Error('crash'); } } } });
    const installer = new AgentInstallationService(assembly); const input = { context: f.context, actionId: 'action-1',
      composition: { source: { ...f.source, identity: { name: 'agent-1', ownership: 'existing' as const } } } };
    await expect(installer.installPermanent(input)).rejects.toThrow();
    expect(f.creates()).toBe(0); expect(() => readAgentSupervisorHandoff(join(f.root, 'trusted'), 'agent-1')).toThrow();
    await expect(installer.installPermanent(input)).resolves.toMatchObject({ state: 'complete', identityAcquisition: 'external' });
    expect(f.creates()).toBe(0); expect(readAgentSupervisorHandoff(join(f.root, 'trusted'), 'agent-1')).toMatchObject({ generation: 1 });
  });

  it.each(['corrupt active', 'partial action index'] as const)('fails closed on %s without identity creation or overwrite', async corruption => {
    const f = setup(true); const agentRoot = join(f.root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'));
    mkdirSync(agentRoot, { recursive: true, mode: 0o700 }); let corruptPath: string;
    if (corruption === 'corrupt active') corruptPath = join(agentRoot, 'active.json');
    else { const actions = join(agentRoot, 'actions'); mkdirSync(actions, { mode: 0o700 });
      corruptPath = join(actions, `${Buffer.from('action-1').toString('base64url')}.json`); }
    writeFileSync(corruptPath, '{}\n', { mode: 0o600 }); const installer = new AgentInstallationService(f.make());
    await expect(installer.installPermanent({ context: f.context, actionId: 'action-1', composition: {
      source: { ...f.source, identity: { name: 'agent-1', ownership: 'existing' as const } } } })).rejects.toThrow();
    expect(f.creates()).toBe(0); expect(readFileSync(corruptPath, 'utf8')).toBe('{}\n');
    if (corruption === 'partial action index') expect(existsSync(join(agentRoot, 'active.json'))).toBe(false);
  });

  it('treats restart presence as terminal ambiguous and managed ingress without creator proof fails closed', async () => {
    const f = setup(true); const first = f.make();
    const direct = first.ingress.direct(f.context);
    const ambiguous = await first.root.createPermanent({ callerEvidence: direct, source: f.source }, 'action-1');
    expect(ambiguous).toMatchObject({ state: 'ambiguous' }); expect(ambiguous.locator).toBeUndefined();
    const restarted = f.make();
    const resumed = await restarted.root.resumePermanent('agent-1', 'action-1');
    expect(resumed).toMatchObject({ state: 'ambiguous' }); expect(resumed.locator).toBeUndefined();
    expect(f.creates()).toBe(0);
    const managed = restarted.ingress.managed('caller-agent', { ...f.context,
      operation: Object.freeze({ ...f.context.operation, id: 'action-2' }) });
    await expect(restarted.root.createPermanent({ callerEvidence: managed, source: f.source }, 'action-2'))
      .rejects.toThrow(/invalid_lineage/u);
  });

  it('accepts an explicitly existing identity through the real factory with exact CID and no create', async () => {
    const f = setup(true); const assembly = f.make();
    const callerEvidence = assembly.ingress.direct(f.context);
    const result = await assembly.root.createPermanent({ callerEvidence, source: { ...f.source,
      identity: { name: 'agent-1', ownership: 'existing' as const } } }, 'action-1');
    expect(result).toMatchObject({ state: 'complete', identityAcquisition: 'external',
      identityName: 'agent-1', locator: { agentId: 'agent-1', actionId: 'action-1', generation: 1 } });
    expect(readFileSync(join(rootFromLocator(f.root), 'identity-binding.json'), 'utf8')).toContain(f.cid);
    expect(f.creates()).toBe(0);
  });
});

function rootFromLocator(root: string): string {
  const base = join(root, 'trusted', 'agents', Buffer.from('agent-1').toString('base64url'), 'candidates',
    Buffer.from('action-1').toString('base64url'));
  return join(base, readdirSync(base)[0]!);
}
