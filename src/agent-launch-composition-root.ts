import type { InternalAgentSupervisorRehydration } from './agent-supervisor-rehydration.js';
import type { AcpSessionOptions } from './session/acp.js';
import type { SessionHandle } from './session/types.js';
import { readStoredAgentPlan } from './agent-plan-store.js';
import type { AgentPlan } from './agent-plan.js';
import type { AuthenticatedTempAgentPrelaunchBindings,
  InternalTempAgentPrelaunchAuthority } from './temp-agent-supervisor-rehydration.js';

export interface TempAgentBrainLauncher {
  start(input: Readonly<{ reservation: AuthenticatedTempAgentPrelaunchBindings; plan: AgentPlan;
    session: Omit<AcpSessionOptions, 'argv' | 'env'> }>): Promise<SessionHandle>;
}
export type AgentLaunchRequest = Readonly<{
  agentId: string; lifetime: 'persistent'; session: Omit<AcpSessionOptions, 'argv' | 'env'>;
} | {
  agentId: string; lifetime: 'temporary'; session: Omit<AcpSessionOptions, 'argv' | 'env'>;
}>;

/** Internal atomic launch boundary; no identity, provider, driver, or raw authority is returned. */
export class AgentLaunchCompositionRoot {
  constructor(private readonly permanent: InternalAgentSupervisorRehydration,
    private readonly temporary: InternalTempAgentPrelaunchAuthority,
    private readonly tempBrains: TempAgentBrainLauncher) {}

  async launch(request: AgentLaunchRequest): Promise<SessionHandle> {
    if (request.lifetime === 'persistent')
      return this.permanent.rehydrate(request.agentId).startSession(request.session);
    const reservation = this.temporary.rehydrate(request.agentId);
    const bindings = this.temporary.authenticate(reservation);
    if (!bindings || bindings.lifetime !== 'temporary' || bindings.completion !== 'deferred'
        || bindings.identityLifecycle !== 'connector_session_owned')
      throw new TypeError('temporary prelaunch reservation unavailable');
    const plan = readStoredAgentPlan(bindings.canonicalDir, { agentId: bindings.agentId,
      generation: bindings.generation, planDigest: bindings.planDigest,
      snapshotDigest: bindings.snapshotDigest }, 'temp-runtime-prelaunch').plan;
    if (plan.agentId !== bindings.agentId || plan.generation !== bindings.generation
        || plan.planDigest !== bindings.planDigest || plan.snapshotDigest !== bindings.snapshotDigest
        || plan.authorizationRevision !== bindings.authorizationRevision
        || plan.operation.id !== bindings.actionId || plan.lifecycle !== 'temporary'
        || plan.identity.ownership !== 'create_temporary')
      throw new TypeError('temporary prelaunch plan mismatch');
    return this.tempBrains.start(Object.freeze({ reservation: bindings, plan, session: request.session }));
  }
}
