import { createProductionAgentCreationCompositionRoot,
  type ProductionAgentCreationDeps } from './agent-creation-composition-root.js';
import { AgentLaunchCompositionRoot, type TempAgentBrainLauncher } from './agent-launch-composition-root.js';
import { ProductionBrainAuthority } from './agent-production-brain-authority.js';
import { ProductionAgentRuntimeReconciliationAuthority } from './agent-runtime-reconciliation.js';
import { createInternalAgentSupervisorRehydration } from './agent-supervisor-rehydration.js';
import { createInternalTempAgentPrelaunchAuthority } from './temp-agent-supervisor-rehydration.js';
import { createAcpBodyBrainDriver } from './session/acp-body-brain-driver.js';
import { BrainAdapterPreparationAuthority } from './harness/brain-adapter.js';
import { getBodyBrainAdapterDescriptor } from './harness/registry.js';
import { AgentConversationRelay } from './agent-conversation-control.js';
import { createInjectedAcpSession } from './session/acp.js';
import { runtimeCanonical, runtimeDigest } from './agent-runtime-record.js';
import { CODEX_DISABLE_INHERITED_MCP_ENV } from './session/acp.js';

const CONTEXT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,4095}$/u;
export interface AgentRuntimeLaunchContextBindings {
  agentId: string; generation: number; actionId: string; sessionRequestId: string;
  sessionRequest: Readonly<Record<string, unknown>>;
}
export interface AgentRuntimeLaunchContextInput extends AgentRuntimeLaunchContextBindings {
  cwd: string; env: Readonly<Record<string, string>>;
}
export interface AuthenticatedAgentRuntimeLaunchContext {
  cwd: string; env: Readonly<Record<string, string>>;
}
function ownedContextJson(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new TypeError('runtime launch context unavailable');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => ownedContextJson(item, depth + 1)));
  if (!value || typeof value !== 'object') throw new TypeError('runtime launch context unavailable');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('runtime launch context unavailable');
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError('runtime launch context unavailable');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set)
      throw new TypeError('runtime launch context unavailable');
    output[key] = ownedContextJson(descriptor.value, depth + 1);
  }
  return Object.freeze(output);
}
function dataProperties(value: unknown, exactKeys?: ReadonlySet<string>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('runtime launch context unavailable');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('runtime launch context unavailable');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') || (exactKeys
    && (keys.length !== exactKeys.size || keys.some(key => !exactKeys.has(key as string)))))
    throw new TypeError('runtime launch context unavailable');
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value'))
      throw new TypeError('runtime launch context unavailable');
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
const CONTEXT_INPUT_KEYS = new Set(['agentId', 'generation', 'actionId', 'sessionRequestId', 'sessionRequest', 'cwd', 'env']);
export class AgentRuntimeLaunchContextAuthority {
  readonly #issued = new WeakMap<object, Readonly<AgentRuntimeLaunchContextInput>>();
  issue(input: Readonly<AgentRuntimeLaunchContextInput>): object {
    try {
      const top = dataProperties(input, CONTEXT_INPUT_KEYS);
      const envRaw = dataProperties(top.env); const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(envRaw)) {
        if (!CONTEXT_TOKEN.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 || /\0/u.test(value))
          throw new TypeError('runtime launch context unavailable');
        env[key] = value;
      }
      const sessionRequest = ownedContextJson(top.sessionRequest) as Readonly<Record<string, unknown>>;
      if (!CONTEXT_TOKEN.test(top.agentId as string) || !Number.isSafeInteger(top.generation)
          || (top.generation as number) < 1 || !CONTEXT_TOKEN.test(top.actionId as string)
          || !CONTEXT_TOKEN.test(top.sessionRequestId as string) || typeof top.cwd !== 'string'
          || !top.cwd.startsWith('/') || sessionRequest.cwd !== top.cwd
          || env.OURS_FLEET_PROXY_CALLER !== top.agentId
          || env.OURS_FLEET_PROXY_STATE_DIR !== sessionRequest.stateDir)
        throw new TypeError('runtime launch context unavailable');
      const evidence = Object.freeze({});
      this.#issued.set(evidence, Object.freeze({ agentId: top.agentId as string, generation: top.generation as number,
        actionId: top.actionId as string, sessionRequestId: top.sessionRequestId as string, cwd: top.cwd,
        sessionRequest, env: Object.freeze(env) }));
      return evidence;
    } catch { throw new TypeError('runtime launch context unavailable'); }
  }
  consume(evidence: unknown, expected: Readonly<AgentRuntimeLaunchContextBindings>): Readonly<AuthenticatedAgentRuntimeLaunchContext> | undefined {
    if (!evidence || typeof evidence !== 'object') return undefined;
    const value = this.#issued.get(evidence as object);
    if (value) this.#issued.delete(evidence as object);
    if (!value || value.agentId !== expected.agentId || value.generation !== expected.generation
        || value.actionId !== expected.actionId || value.sessionRequestId !== expected.sessionRequestId
        || runtimeCanonical(value.sessionRequest) !== runtimeCanonical(expected.sessionRequest)) return undefined;
    return Object.freeze({ cwd: value.cwd, env: Object.freeze({ ...value.env }) });
  }
}

const ADAPTER_OWNED_ENV = new Set([
  'CODEX_APPROVAL', 'CODEX_SANDBOX',
  'OURS_FLEET_CODEX_APPROVAL', 'OURS_FLEET_CODEX_SANDBOX', CODEX_DISABLE_INHERITED_MCP_ENV,
  'OURS_FLEET_REAL_CODEX_PATH', 'OURS_FLEET_CODEX_ACP_MANIFEST',
]);
const RUNTIME_PROXY_ENV = new Set(['OURS_FLEET_PROXY_STATE_DIR', 'OURS_FLEET_PROXY_CALLER']);
export function composeAgentRuntimeChildContext(preparedEnv: Readonly<Record<string, string>>,
  context: Readonly<AuthenticatedAgentRuntimeLaunchContext>, adapterId: string, model: string,
  disableInheritedCodexMcp: boolean): Readonly<AuthenticatedAgentRuntimeLaunchContext> {
  const env = { ...preparedEnv };
  for (const [key, value] of Object.entries(context.env)) {
    if (RUNTIME_PROXY_ENV.has(key)) {
      if (preparedEnv[key] !== undefined) throw new TypeError('runtime launch context unavailable');
      env[key] = value; continue;
    }
    if (key === 'CODEX_PATH' && adapterId === 'codex-acp' && preparedEnv.CODEX_PATH !== undefined) {
      if (preparedEnv.OURS_FLEET_REAL_CODEX_PATH !== undefined
          && preparedEnv.OURS_FLEET_REAL_CODEX_PATH !== value)
        throw new TypeError('runtime launch context unavailable');
      env.OURS_FLEET_REAL_CODEX_PATH = value; continue;
    }
    if (ADAPTER_OWNED_ENV.has(key) && key !== CODEX_DISABLE_INHERITED_MCP_ENV
        && (env[key] === undefined || env[key] !== value)) throw new TypeError('runtime launch context unavailable');
    if (key === CODEX_DISABLE_INHERITED_MCP_ENV && env[key] !== undefined && env[key] !== value)
      throw new TypeError('runtime launch context unavailable');
    if ((key === 'ANTHROPIC_MODEL' || key === 'ANTHROPIC_BASE_URL')
        && env[key] !== undefined && env[key] !== value) throw new TypeError('runtime launch context unavailable');
    env[key] = value;
  }
  delete env.OURS_AUTOSTART;
  if (adapterId === 'codex-acp') {
    const expected = disableInheritedCodexMcp ? '1' : '0';
    if (context.env[CODEX_DISABLE_INHERITED_MCP_ENV] !== undefined
        && context.env[CODEX_DISABLE_INHERITED_MCP_ENV] !== expected)
      throw new TypeError('runtime launch context unavailable');
    env[CODEX_DISABLE_INHERITED_MCP_ENV] = expected;
  }
  if (adapterId === 'claude-code-acp' && env.ANTHROPIC_MODEL !== model)
    throw new TypeError('runtime launch context unavailable');
  return Object.freeze({ cwd: context.cwd, env: Object.freeze(env) });
}

export type ProductionAgentLaunchCompositionDeps = Omit<ProductionAgentCreationDeps,
  'policies'|'adapterAuthority'>;

/** One non-live library assembly owns creation and launch policy/evidence identity. */
export function createProductionAgentLaunchComposition(deps: ProductionAgentLaunchCompositionDeps) {
  const brains = new ProductionBrainAuthority();
  const contexts = new AgentRuntimeLaunchContextAuthority();
  const creation = createProductionAgentCreationCompositionRoot({ ...deps, policies: brains,
    adapterAuthority: brains });
  const reconciliation = new ProductionAgentRuntimeReconciliationAuthority();
  const driverFactory = (prepared: Parameters<typeof createAcpBodyBrainDriver>[0] | unknown,
    bindings: Parameters<typeof createAcpBodyBrainDriver>[1], canonicalDir: string, envelope: unknown,
    actionId: string) => {
    const launch = (prepared as { bodyBrainLaunch: { env: Readonly<Record<string, string>>;
      adapterId: string; translation: { model: string; mcpServers?: readonly unknown[] } } }).bodyBrainLaunch;
    const owned = envelope && typeof envelope === 'object' ? envelope as { evidence?: unknown; sessionRequestId?: unknown;
      sessionRequest?: Readonly<Record<string, unknown>> } : {};
    const context = contexts.consume(owned.evidence, { agentId: bindings.agentId, generation: bindings.generation,
      actionId, sessionRequestId: String(owned.sessionRequestId ?? ''), sessionRequest: owned.sessionRequest ?? {} });
    if (!context) throw new TypeError('runtime launch context unavailable');
    return createAcpBodyBrainDriver(canonicalDir, bindings, composeAgentRuntimeChildContext(launch.env, context,
      launch.adapterId, launch.translation.model, launch.translation.mcpServers?.length === 0));
  };
  const permanent = createInternalAgentSupervisorRehydration({ trustedStateRoot: deps.trustedStateRoot,
    policies: brains, adapterAuthority: brains, driverFactory: driverFactory as never, reconciliation,
    ...(deps.now ? { now: deps.now } : {}) });
  const temporary = createInternalTempAgentPrelaunchAuthority(deps.trustedStateRoot);
  const tempPreparer = new BrainAdapterPreparationAuthority(brains);
  const tempBrains: TempAgentBrainLauncher = Object.freeze({ start: async (
    input: Parameters<TempAgentBrainLauncher['start']>[0],
  ) => {
    const policy = brains.resolvePolicy(input.plan.brain, input.plan.permissions);
    const resolutionInput = Object.freeze({ brain: input.plan.brain, permissions: input.plan.permissions,
      policy: policy.policy, enforcementEvidence: policy.enforcementEvidence });
    const preparedEvidence = tempPreparer.prepare(resolutionInput);
    const prepared = tempPreparer.authenticateForRuntime(preparedEvidence, resolutionInput);
    if (!prepared) throw new TypeError('temporary production Brain preparation unavailable');
    const runtimeInstanceKey = runtimeDigest(runtimeCanonical({ agentId: input.reservation.agentId,
      generation: input.reservation.generation, planDigest: input.reservation.planDigest,
      reservationDigest: input.reservation.reservationDigest, lifecycle: 'temporary' }));
    const providerRuntimeId = `acp-${runtimeInstanceKey.slice(-32)}`;
    const adapterDescriptorDigest = runtimeDigest(runtimeCanonical(input.plan.adapter.nativeDescriptor));
    const bindings = Object.freeze({ agentId: input.reservation.agentId, generation: input.reservation.generation,
      planDigest: input.reservation.planDigest, snapshotDigest: input.reservation.snapshotDigest,
      reservationDigest: input.reservation.reservationDigest,
      identityEvidenceDigest: runtimeDigest(runtimeCanonical({ identityLifecycle: input.reservation.identityLifecycle,
        agentId: input.reservation.agentId, generation: input.reservation.generation })),
      runtimeInstanceKey, startEffectKey: runtimeDigest(runtimeCanonical({ kind: 'temp-runtime.start', runtimeInstanceKey })),
      adapterDescriptorDigest, providerRuntimeId });
    const context = contexts.consume(input.runtimeLaunchContext, { agentId: bindings.agentId,
      generation: bindings.generation, actionId: input.reservation.actionId,
      sessionRequestId: input.sessionRequestId, sessionRequest: input.sessionRequest });
    if (!context) throw new TypeError('runtime launch context unavailable');
    const driver = createAcpBodyBrainDriver(input.reservation.canonicalDir, bindings,
      composeAgentRuntimeChildContext(prepared.bodyBrainLaunch.env, context, prepared.bodyBrainLaunch.adapterId,
        prepared.bodyBrainLaunch.translation.model, prepared.bodyBrainLaunch.translation.mcpServers?.length === 0));
    const descriptor = getBodyBrainAdapterDescriptor(input.plan.brain.harness as 'codex'|'claude-code');
    const provider = descriptor.createProvider(prepared.bodyBrainLaunch, driver);
    const relay = new AgentConversationRelay({ agentId: bindings.agentId, generation: bindings.generation,
      runtimeInstanceKey, providerRuntimeId }, descriptor.adapterId, provider, driver.pid);
    const result = await relay.start({ protocolVersion: 1, generation: `g${bindings.generation}`,
      planDigest: bindings.planDigest });
    if (result.state !== 'accepted') { await provider.cleanup();
      throw new TypeError('temporary production Brain start unavailable'); }
    return createInjectedAcpSession(input.session, relay, relay.issue());
  } });
  const launch = new AgentLaunchCompositionRoot(permanent, temporary, tempBrains);
  return Object.freeze({ creation, launch, runtimeLaunchContexts: contexts });
}
