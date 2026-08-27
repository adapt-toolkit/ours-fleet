import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AdapterValidationRecord } from '../agent-plan.js';
import { computeBrainDigest, computePermissionsDigest } from '../agent-plan.js';
import type { BrainSpec, PermissionSpec } from '../config-resources.js';
import {
  recheckBundledAcpAgent, resolveAuthenticatedBundledAcpAgent,
  type AcpAgentResolution, type AcpBundleIdentity,
} from './acp-agent.js';
import { getBodyBrainAdapterDescriptor } from './registry.js';
import {
  createAcpBodyBrainPreparedLaunch, type AcpBodyBrainPreparedLaunch,
} from '../session/acp-body-brain-provider.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FIELD = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_FIELD_BYTES = 256;

export type EnforcementOwner = 'native_adapter' | 'fleet_isolation' | 'body_controller';
export interface EnforcementRecord { owner: EnforcementOwner; policyDigest: string }

export type AdapterLaunchPolicy =
  | { kind: 'bundled' }
  | { kind: 'custom' };
export type ModelValidationPolicy =
  | { schemaVersion: 1; kind: 'syntax_only'; revision: string }
  | {
    schemaVersion: 1; kind: 'catalog'; revision: string;
    catalogDigest: string; models: readonly string[];
  };

export interface CodexAcpPolicy {
  schemaVersion: 1;
  kind: 'codex_acp';
  adapterVersion: string;
  modelPolicy: ModelValidationPolicy;
  launch: AdapterLaunchPolicy;
}

export interface ClaudeCodeAcpPolicy {
  schemaVersion: 1;
  kind: 'claude_code_acp';
  adapterVersion: string;
  modelPolicy: ModelValidationPolicy;
  launch: AdapterLaunchPolicy;
}

export type BrainAdapterPolicy = CodexAcpPolicy | ClaudeCodeAcpPolicy;
export interface BrainAdapterPolicyEvidence {
  revision: string;
  digest: string;
  value: BrainAdapterPolicy;
}
export interface BrainAdapterResolutionInput {
  brain: BrainSpec;
  permissions: PermissionSpec;
  policy: BrainAdapterPolicyEvidence;
  enforcementEvidence: VerifiedAdapterEnforcementEvidence;
}

export interface BrainAdapter {
  readonly harness: string;
  readonly session: string;
  readonly adapterId: 'codex-acp' | 'claude-code-acp';
  readonly adapterVersion: string;
}

declare const adapterEvidenceBrand: unique symbol;
export interface VerifiedAdapterEnforcementEvidence {
  readonly [adapterEvidenceBrand]: true;
}
export interface TrustedAdapterEnforcementBindings {
  harness: 'codex' | 'claude-code';
  session: 'acp';
  adapterId: 'codex-acp' | 'claude-code-acp';
  adapterVersion: string;
  policyDigest: string;
  brainDigest: string;
  permissionsDigest: string;
  launch: Readonly<{
    kind: 'bundled' | 'fallback';
    packageName: string;
    manifestPath?: string;
    entrypointPath?: string;
    version?: string;
    identity?: Readonly<AcpBundleIdentity>;
  }>;
  enforcement: Readonly<Record<'approval' | 'filesystem' | 'unattended', EnforcementOwner>>;
}
export interface BrainAdapterEvidenceAuthority {
  authenticateAdapterEvidence(
    evidence: VerifiedAdapterEnforcementEvidence,
  ): Readonly<TrustedAdapterEnforcementBindings> | undefined;
}

export class BrainAdapterPolicyError extends Error {}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BrainAdapterPolicyError('adapter policy number must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') throw new BrainAdapterPolicyError('adapter policy must be JSON');
  return `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new BrainAdapterPolicyError(`adapter policy.${key} must not be undefined`);
    return `${JSON.stringify(key)}:${canonical(child)}`;
  }).join(',')}}`;
}

function rejectAccessors(value: unknown, name: string, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  seen.add(value as object);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set)
      throw new BrainAdapterPolicyError(`${name} must contain only immutable data properties`);
    rejectAccessors(descriptor.value, `${name}.${key}`, seen);
  }
}

export const computeBrainAdapterPolicyDigest = (revision: string, value: BrainAdapterPolicy): string =>
  `sha256:${createHash('sha256').update(canonical({ revision, value })).digest('hex')}`;
export const computeModelCatalogDigest = (models: readonly string[]): string =>
  `sha256:${createHash('sha256').update(canonical(models)).digest('hex')}`;

function exactObject(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrainAdapterPolicyError(`${name} must be an object`);
  const actual = Object.keys(value);
  const missing = keys.filter(key => !actual.includes(key));
  const extra = actual.filter(key => !keys.includes(key));
  if (missing.length || extra.length) throw new BrainAdapterPolicyError(`${name} has invalid keys`);
  for (const [key, child] of Object.entries(value as object))
    if (child === undefined) throw new BrainAdapterPolicyError(`${name}.${key} must not be undefined`);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, name: string, pattern = FIELD): string {
  if (typeof value !== 'string' || !pattern.test(value) || Buffer.byteLength(value) > MAX_FIELD_BYTES)
    throw new BrainAdapterPolicyError(`${name} must be a bounded stable value`);
  return value;
}

function validateLaunch(value: AdapterLaunchPolicy): void {
  exactObject(value, 'adapter policy launch', ['kind']);
  if (value.kind !== 'bundled' && value.kind !== 'custom')
    throw new BrainAdapterPolicyError('adapter policy launch kind is invalid');
}

function validateModelPolicy(value: ModelValidationPolicy, model: string): void {
  exactObject(value, 'adapter model policy', value?.kind === 'catalog'
    ? ['schemaVersion', 'kind', 'revision', 'catalogDigest', 'models']
    : ['schemaVersion', 'kind', 'revision']);
  if (value.schemaVersion !== 1 || !['syntax_only', 'catalog'].includes(value.kind))
    throw new BrainAdapterPolicyError('adapter model policy kind or schema is invalid');
  bounded(value.revision, 'adapter model policy revision', TOKEN);
  if (value.kind === 'catalog') {
    if (!Array.isArray(value.models) || !value.models.length || value.models.length > 512)
      throw new BrainAdapterPolicyError('adapter model catalog has invalid size');
    for (const [index, candidate] of value.models.entries())
      bounded(candidate, `adapter model catalog[${index}]`);
    if (new Set(value.models).size !== value.models.length
        || [...value.models].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join('\0')
          !== value.models.join('\0'))
      throw new BrainAdapterPolicyError('adapter model catalog must be unique and bytewise ordered');
    if (!SHA256.test(value.catalogDigest)
        || computeModelCatalogDigest(value.models) !== value.catalogDigest)
      throw new BrainAdapterPolicyError('adapter model catalog digest is invalid');
    if (!value.models.includes(model))
      throw new BrainAdapterPolicyError('Brain model is not in the bound adapter catalog');
  }
}

function validatePolicyEvidence(
  evidence: BrainAdapterPolicyEvidence, harness: 'codex' | 'claude-code',
): BrainAdapterPolicy {
  exactObject(evidence, 'adapter policy evidence', ['revision', 'digest', 'value']);
  bounded(evidence.revision, 'adapter policy revision', TOKEN);
  if (!SHA256.test(evidence.digest)) throw new BrainAdapterPolicyError('adapter policy digest is invalid');
  const value = evidence.value;
  const codex = harness === 'codex';
  exactObject(value, 'adapter policy', codex
    ? ['schemaVersion', 'kind', 'adapterVersion', 'modelPolicy', 'launch']
    : ['schemaVersion', 'kind', 'adapterVersion', 'modelPolicy', 'launch']);
  if (value.schemaVersion !== 1 || value.kind !== (codex ? 'codex_acp' : 'claude_code_acp'))
    throw new BrainAdapterPolicyError('adapter policy kind or schema is invalid');
  bounded(value.adapterVersion, 'adapter policy adapterVersion', TOKEN);
  validateLaunch(value.launch);
  if (computeBrainAdapterPolicyDigest(evidence.revision, value) !== evidence.digest)
    throw new BrainAdapterPolicyError('adapter policy digest does not match its typed value');
  return value;
}

export interface PortablePermissionCodes {
  approvalMode: AdapterValidationRecord['nativeDescriptor']['approvalMode'];
  filesystemMode: AdapterValidationRecord['nativeDescriptor']['filesystemMode'];
  unattendedMode: AdapterValidationRecord['nativeDescriptor']['unattendedMode'];
  legacyNative: Record<string, string>;
  coupledAcpMode?: 'read-only' | 'agent' | 'agent-full-access';
}
interface PortablePermissionInput {
  approval: 'ask' | 'auto' | 'allow' | 'deny';
  filesystem: 'read-only' | 'workspace' | 'unrestricted';
  unattended: 'deny' | 'wait';
}

/** One pure translation vocabulary shared by durable validation and legacy helpers. */
export function translatePortablePermissionCodes(
  harness: 'codex' | 'claude-code', permissions: PortablePermissionInput,
): PortablePermissionCodes {
  if (!['ask', 'auto', 'allow', 'deny'].includes(permissions.approval)
      || !['read-only', 'workspace', 'unrestricted'].includes(permissions.filesystem)
      || !['deny', 'wait'].includes(permissions.unattended))
    throw new BrainAdapterPolicyError('portable permission value is invalid');
  if (harness === 'codex') {
    const approvalMode = permissions.approval === 'allow' ? 'never'
      : permissions.approval === 'ask' ? 'untrusted' : 'on-request';
    const sandbox = permissions.filesystem === 'read-only' ? 'read-only'
      : permissions.filesystem === 'unrestricted' ? 'danger-full-access' : 'workspace-write';
    return {
      approvalMode, filesystemMode: permissions.filesystem,
      unattendedMode: permissions.unattended,
      legacyNative: { approval: approvalMode, sandbox },
      coupledAcpMode: permissions.approval === 'allow' ? 'agent-full-access'
        : permissions.approval === 'auto' ? 'agent'
          : sandbox === 'read-only' ? 'read-only'
            : sandbox === 'danger-full-access' ? 'agent-full-access' : 'agent',
    };
  }
  const approvalMode = permissions.approval === 'allow' ? 'bypassPermissions'
    : permissions.approval === 'auto' ? 'acceptEdits'
      : permissions.approval === 'deny' ? 'plan' : 'default';
  return {
    approvalMode, filesystemMode: 'external-isolation', unattendedMode: permissions.unattended,
    legacyNative: { permission_mode: approvalMode },
  };
}

const EFFORTS = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
} as const;

function resolveExactPolicy(
  adapter: BrainAdapter, input: BrainAdapterResolutionInput,
  authority?: BrainAdapterEvidenceAuthority, actualLaunch?: AcpAgentResolution,
): AdapterValidationRecord {
  rejectAccessors(input.brain, 'Brain');
  rejectAccessors(input.permissions, 'permissions');
  rejectAccessors(input.policy, 'adapter policy evidence');
  exactObject(input, 'Brain adapter input', ['brain', 'permissions', 'policy', 'enforcementEvidence']);
  exactObject(input.brain, 'Brain', ['harness', 'model', 'effort', 'session']);
  exactObject(input.permissions, 'permissions', ['approval', 'filesystem', 'unattended']);
  if (!['ask', 'auto', 'allow'].includes(input.permissions.approval)
      || !['read-only', 'workspace', 'unrestricted'].includes(input.permissions.filesystem)
      || !['deny', 'wait'].includes(input.permissions.unattended))
    throw new BrainAdapterPolicyError('durable Agent permission value is invalid');
  const harness = adapter.harness as 'codex' | 'claude-code';
  if (input.brain.harness !== harness) throw new BrainAdapterPolicyError('Brain harness does not match adapter');
  if (input.brain.session !== 'acp') throw new BrainAdapterPolicyError('Brain session is unsupported; expected acp');
  bounded(input.brain.model, 'Brain model');
  if ((harness === 'codex' && /^claude(?:-|$)/iu.test(input.brain.model))
      || (harness === 'claude-code' && /^(?:gpt-|o[0-9])/iu.test(input.brain.model)))
    throw new BrainAdapterPolicyError(`Brain model is a known ${harness} adapter mismatch`);
  bounded(input.brain.effort, 'Brain effort', TOKEN);
  if (!(EFFORTS[harness] as readonly string[]).includes(input.brain.effort))
    throw new BrainAdapterPolicyError(`Brain effort is unsupported by ${harness}`);
  const policy = validatePolicyEvidence(input.policy, harness);
  if (policy.adapterVersion !== adapter.adapterVersion)
    throw new BrainAdapterPolicyError('adapter policy version does not match the registered adapter');
  validateModelPolicy(policy.modelPolicy, input.brain.model);
  if (policy.launch.kind !== 'bundled')
    throw new BrainAdapterPolicyError('custom or unverifiable ACP commands cannot prove exact policy enforcement');
  const codes = translatePortablePermissionCodes(harness, input.permissions);
  const policyDigest = input.policy.digest;
  const brainDigest = computeBrainDigest(input.brain);
  const permissionsDigest = computePermissionsDigest(input.permissions);
  const authenticated = authority?.authenticateAdapterEvidence(input.enforcementEvidence);
  if (!authenticated) throw new BrainAdapterPolicyError('adapter enforcement evidence was not authenticated');
  rejectAccessors(authenticated, 'trusted adapter bindings');
  const trusted = JSON.parse(canonical(authenticated)) as TrustedAdapterEnforcementBindings;
  exactObject(trusted, 'trusted adapter bindings', [
    'harness', 'session', 'adapterId', 'adapterVersion', 'policyDigest', 'brainDigest',
    'permissionsDigest', 'launch', 'enforcement',
  ]);
  exactObject(trusted.launch, 'trusted adapter launch', [
    'kind', 'packageName', ...(trusted.launch.manifestPath === undefined ? [] : ['manifestPath']),
    ...(trusted.launch.entrypointPath === undefined ? [] : ['entrypointPath']),
    ...(trusted.launch.version === undefined ? [] : ['version']),
    ...(trusted.launch.identity === undefined ? [] : ['identity']),
  ]);
  exactObject(trusted.enforcement, 'trusted adapter enforcement', ['approval', 'filesystem', 'unattended']);
  const expectedPackage = harness === 'codex'
    ? '@agentclientprotocol/codex-acp' : '@agentclientprotocol/claude-agent-acp';
  const expectedOwners = harness === 'codex'
    ? { approval: 'native_adapter', filesystem: 'native_adapter', unattended: 'body_controller' } as const
    : { approval: 'native_adapter', filesystem: 'fleet_isolation', unattended: 'body_controller' } as const;
  if (trusted.harness !== harness || trusted.session !== 'acp'
      || trusted.adapterId !== adapter.adapterId || trusted.adapterVersion !== adapter.adapterVersion
      || trusted.policyDigest !== policyDigest || trusted.brainDigest !== brainDigest
      || trusted.permissionsDigest !== permissionsDigest
      || trusted.launch.kind !== 'bundled' || trusted.launch.packageName !== expectedPackage
      || trusted.launch.version !== adapter.adapterVersion || !trusted.launch.manifestPath
      || !isAbsolute(trusted.launch.manifestPath) || !trusted.launch.entrypointPath
      || !isAbsolute(trusted.launch.entrypointPath) || !trusted.launch.identity
      || trusted.enforcement.approval !== expectedOwners.approval
      || trusted.enforcement.filesystem !== expectedOwners.filesystem
      || trusted.enforcement.unattended !== expectedOwners.unattended)
    throw new BrainAdapterPolicyError('trusted adapter enforcement bindings do not match this resolution');
  if (actualLaunch && (!actualLaunch.bundled || !actualLaunch.identity
      || actualLaunch.manifestPath !== trusted.launch.manifestPath
      || actualLaunch.entrypointPath !== trusted.launch.entrypointPath
      || actualLaunch.version !== trusted.launch.version
      || canonical(actualLaunch.identity) !== canonical(trusted.launch.identity)))
    throw new BrainAdapterPolicyError('actual ACP bundle does not match trusted launch evidence');
  const enforcement = {
    approval: { owner: expectedOwners.approval, policyDigest },
    filesystem: { owner: expectedOwners.filesystem, policyDigest },
    unattended: { owner: expectedOwners.unattended, policyDigest },
  };
  return Object.freeze({
    redacted: true as const,
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    policyRevision: input.policy.revision, policyDigest,
    brainDigest, permissionsDigest,
    portableDescriptor: Object.freeze({ ...input.permissions }),
    nativeDescriptor: Object.freeze({
      approvalMode: codes.approvalMode, filesystemMode: codes.filesystemMode,
      unattendedMode: codes.unattendedMode, exact: true,
    }),
    enforcement: Object.freeze({
      approval: Object.freeze(enforcement.approval),
      filesystem: Object.freeze(enforcement.filesystem),
      unattended: Object.freeze(enforcement.unattended),
    }),
  });
}

const tuple = (harness: string, session: string): string => `${harness}\0${session}`;

/** Non-authoritative tuple catalog. Entries can never issue exact validation records. */
export class BrainAdapterRegistry {
  readonly #adapters = new Map<string, BrainAdapter>();
  register(adapter: BrainAdapter): void {
    exactObject(adapter, 'Brain adapter descriptor', ['harness', 'session', 'adapterId', 'adapterVersion']);
    bounded(adapter.harness, 'Brain adapter harness', TOKEN);
    bounded(adapter.session, 'Brain adapter session', TOKEN);
    bounded(adapter.adapterVersion, 'Brain adapter version', TOKEN);
    const key = tuple(adapter.harness, adapter.session);
    if (this.#adapters.has(key))
      throw new BrainAdapterPolicyError(`duplicate Brain adapter tuple '${adapter.harness}/${adapter.session}'`);
    this.#adapters.set(key, Object.freeze({ ...adapter }));
  }
  get(harness: string, session: string): BrainAdapter {
    const adapter = this.#adapters.get(tuple(harness, session));
    if (!adapter) throw new BrainAdapterPolicyError(`unknown Brain adapter tuple '${harness}/${session}'`);
    return adapter;
  }
}

const productionRegistry = new BrainAdapterRegistry();
productionRegistry.register({ harness: 'codex', session: 'acp', adapterId: 'codex-acp', adapterVersion: '1.1.7' });
productionRegistry.register({
  harness: 'claude-code', session: 'acp', adapterId: 'claude-code-acp', adapterVersion: '0.63.0',
});

export function getBrainAdapter(harness: string, session: string): BrainAdapter {
  return productionRegistry.get(harness, session);
}

export function resolveBrainAdapterPolicy(input: BrainAdapterResolutionInput): AdapterValidationRecord {
  return resolveExactPolicy(getBrainAdapter(input.brain.harness, input.brain.session), input);
}

export function createBrainAdapterPolicyResolver(
  authority: BrainAdapterEvidenceAuthority,
): (input: BrainAdapterResolutionInput) => AdapterValidationRecord {
  if (!authority || typeof authority.authenticateAdapterEvidence !== 'function')
    throw new BrainAdapterPolicyError('Brain adapter evidence authority is invalid');
  const authenticateAdapterEvidence = authority.authenticateAdapterEvidence.bind(authority);
  const bound: BrainAdapterEvidenceAuthority = { authenticateAdapterEvidence };
  return input => resolveExactPolicy(
    getBrainAdapter(input.brain.harness, input.brain.session), input, bound,
  );
}

const ephemeralLaunchBrand: unique symbol = Symbol('ephemeral Brain launch');
export interface EphemeralPreparedBrainLaunch {
  readonly [ephemeralLaunchBrand]: true;
  readonly validation: AdapterValidationRecord;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly model: string;
  readonly effort: string;
  readonly native: PortablePermissionCodes;
  readonly bodyBrainLaunch: Readonly<AcpBodyBrainPreparedLaunch>;
  recheckAtSideEffectBoundary(): boolean;
  toJSON(): never;
}

export interface AuthenticatedPreparedBrainLaunchBindings {
  readonly input: Readonly<BrainAdapterResolutionInput>;
  readonly adapter: Readonly<BrainAdapter>;
  readonly validation: AdapterValidationRecord;
  readonly native: PortablePermissionCodes;
  readonly bodyBrainLaunch: Readonly<AcpBodyBrainPreparedLaunch>;
  readonly artifactIdentity: AcpBundleIdentity;
}

/**
 * Bind durable validation and ephemeral launch material to one immutable, zero-launch snapshot.
 * Availability evidence still comes only from the configured owning authority.
 */
export class BrainAdapterPreparationAuthority {
  readonly #issued = new WeakMap<object, AuthenticatedPreparedBrainLaunchBindings>();
  readonly #bound: BrainAdapterEvidenceAuthority;

  constructor(authority: BrainAdapterEvidenceAuthority) {
    if (!authority || typeof authority.authenticateAdapterEvidence !== 'function')
      throw new BrainAdapterPolicyError('Brain adapter preparer boundary is invalid');
    const authenticateAdapterEvidence = authority.authenticateAdapterEvidence.bind(authority);
    this.#bound = { authenticateAdapterEvidence };
  }

  prepare(rawInput: BrainAdapterResolutionInput): EphemeralPreparedBrainLaunch {
    rejectAccessors(rawInput, 'Brain adapter input');
    const snapshot = JSON.parse(canonical({
      brain: rawInput.brain, permissions: rawInput.permissions, policy: rawInput.policy,
    })) as Omit<BrainAdapterResolutionInput, 'enforcementEvidence'>;
    const frozenSnapshot = deepFreezeBrainSnapshot(snapshot);
    const input = Object.freeze({ ...frozenSnapshot, enforcementEvidence: rawInput.enforcementEvidence });
    const adapter = getBrainAdapter(input.brain.harness, input.brain.session);
    const codex = adapter.harness === 'codex';
    const packageName = codex
      ? '@agentclientprotocol/codex-acp' : '@agentclientprotocol/claude-agent-acp';
    const binName = codex ? 'codex-acp' : 'claude-agent-acp';
    const resolution = resolveAuthenticatedBundledAcpAgent(packageName, binName, binName);
    if (!resolution.bundled || !resolution.identity)
      throw new BrainAdapterPolicyError('authenticated bundled ACP launch is unavailable');
    if (!Array.isArray(resolution.argv) || !resolution.argv.length || resolution.argv.length > 64
        || resolution.argv.some(arg => typeof arg !== 'string' || !arg.length
          || Buffer.byteLength(arg) > 4096 || /[\0\r\n]/u.test(arg)))
      throw new BrainAdapterPolicyError('prepared ACP argv is invalid or exceeds bounds');
    const validation = resolveExactPolicy(adapter, input, this.#bound, resolution);
    const native = deepFreezeBrainSnapshot(translatePortablePermissionCodes(
      adapter.harness as 'codex' | 'claude-code', input.permissions,
    ));
    let descriptor;
    try { descriptor = getBodyBrainAdapterDescriptor(adapter.harness as 'codex' | 'claude-code'); }
    catch { throw new BrainAdapterPolicyError('production BodyBrain adapter descriptor is unavailable'); }
    if (descriptor.harnessId !== adapter.harness || descriptor.adapterId !== adapter.adapterId
        || descriptor.adapterVersion !== adapter.adapterVersion
        || descriptor.adapterId !== validation.adapterId || descriptor.adapterVersion !== validation.adapterVersion
        || descriptor.adapterVersion !== resolution.version)
      throw new BrainAdapterPolicyError('BodyBrain adapter descriptor does not match authenticated policy and launch');
    const modeId = adapter.harness === 'codex'
      ? native.coupledAcpMode
      : native.approvalMode === 'default' ? undefined : native.approvalMode;
    const bodyBrainLaunch = createAcpBodyBrainPreparedLaunch({
      schemaVersion: 1, adapterId: descriptor.adapterId, adapterVersion: descriptor.adapterVersion,
      argv: resolution.argv, env: {},
      translation: {
        model: input.brain.model, effort: input.brain.effort,
        ...(modeId ? { modeId } : {}),
        ...(adapter.harness === 'codex' ? { permissionMetadataSource: 'codex-acp' as const } : {}),
      },
    });
    if (bodyBrainLaunch.adapterId !== descriptor.adapterId
        || bodyBrainLaunch.adapterVersion !== descriptor.adapterVersion
        || bodyBrainLaunch.translation.model !== input.brain.model
        || bodyBrainLaunch.translation.effort !== input.brain.effort)
      throw new BrainAdapterPolicyError('prepared BodyBrain launch does not match registered descriptor');
    const evidence = deepFreezeBrainSnapshot({
      [ephemeralLaunchBrand]: true as const, validation,
      argv: Object.freeze([...resolution.argv]), env: Object.freeze({}),
      model: input.brain.model, effort: input.brain.effort, native, bodyBrainLaunch,
      recheckAtSideEffectBoundary: () => recheckBundledAcpAgent(resolution),
      toJSON: (): never => { throw new BrainAdapterPolicyError('ephemeral Brain launch cannot be serialized'); },
    });
    const artifactIdentity = deepFreezeBrainSnapshot(JSON.parse(canonical(resolution.identity)) as AcpBundleIdentity);
    this.#issued.set(evidence, Object.freeze({
      input, adapter, validation, native, bodyBrainLaunch, artifactIdentity,
    }));
    return evidence;
  }

  authenticate(
    evidence: EphemeralPreparedBrainLaunch, expectedInput: BrainAdapterResolutionInput,
    expectedAdapter: BrainAdapter, expectedArtifactIdentity: AcpBundleIdentity,
  ): AuthenticatedPreparedBrainLaunchBindings | undefined {
    const issued = this.#issued.get(evidence as object);
    if (!issued || issued.adapter !== expectedAdapter
        || expectedInput.enforcementEvidence !== issued.input.enforcementEvidence) return undefined;
    try {
      if (canonical({ brain: expectedInput.brain, permissions: expectedInput.permissions, policy: expectedInput.policy })
          !== canonical({ brain: issued.input.brain, permissions: issued.input.permissions, policy: issued.input.policy })
          || canonical(expectedArtifactIdentity) !== canonical(issued.artifactIdentity)) return undefined;
    } catch { return undefined; }
    return issued;
  }
}

function deepFreezeBrainSnapshot<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (descriptor && 'value' in descriptor) deepFreezeBrainSnapshot(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export function createBrainAdapterPreparer(
  authority: BrainAdapterEvidenceAuthority,
): (input: BrainAdapterResolutionInput) => EphemeralPreparedBrainLaunch {
  const issuer = new BrainAdapterPreparationAuthority(authority);
  return issuer.prepare.bind(issuer);
}
