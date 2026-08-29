import type { AgentSupervisorControlAuthority, AgentSupervisorControlLease } from '../agent-supervisor-control.js';
import type { AgentSupervisorHandoff } from '../agent-supervisor-handoff.js';
import type { SupervisorBackend } from '../supervisor/types.js';
import { FleetError } from './errors.js';
import type { ManagementRequest, ManagementResult } from './management-contract.js';
import type { AgentManagementPort } from './management-kernel.js';

type AgentCommand = Extract<ManagementRequest['command'], { operation: `agent.${string}` }>;
export type HandoffAdmission =
  | { state: 'missing' }
  | { state: 'corrupt'; detail: string }
  | { state: 'present'; handoff: Readonly<AgentSupervisorHandoff> };

export interface AgentManagementDeps {
  control: AgentSupervisorControlAuthority;
  backend: SupervisorBackend;
  binPath: string;
  readHandoff(agentId: string): HandoffAdmission;
  /** Prepare, reserve and publish generation one while the supplied lease is held. */
  startInitial(agentId: string, actionId: string, lease: AgentSupervisorControlLease): Promise<Readonly<AgentSupervisorHandoff>>;
  /** Authenticate durable artifacts and resume only the exact published generation. */
  startExisting(handoff: Readonly<AgentSupervisorHandoff>, lease: AgentSupervisorControlLease): Promise<void>;
  reconfigure?(agentId: string, expectedDigest: string, actionId: string,
    lease: AgentSupervisorControlLease): Promise<Readonly<AgentSupervisorHandoff>>;
  retire?(handoff: Readonly<AgentSupervisorHandoff>, actionId: string,
    lease: AgentSupervisorControlLease): Promise<void>;
}

/** Canonical Agent lifecycle. RoleCommandService remains a compatibility-only Role facade. */
export class AgentManagementService implements AgentManagementPort {
  constructor(private readonly deps: AgentManagementDeps) {}
  execute(command: AgentCommand, context: Readonly<{ operationId: string }> = { operationId: command.operation }): Promise<ManagementResult> {
    if (command.operation === 'agent.start') return this.start(command.id, false, context.operationId);
    if (command.operation === 'agent.resume') return this.start(command.id, true, context.operationId);
    if (command.operation === 'agent.reconfigure') return this.reconfigure(command.id, command.expectedDigest, context.operationId);
    return this.retire(command.id, context.operationId);
  }
  private start(agentId: string, requireExisting: boolean, actionId: string): Promise<ManagementResult> {
    return this.deps.control.exclusive(agentId, async lease => {
      const admission = this.deps.readHandoff(agentId);
      if (admission.state === 'corrupt')
        throw new FleetError('stale_state', `Agent '${agentId}' has a corrupt active handoff`);
      if (admission.state === 'missing' && requireExisting)
        throw new FleetError('resource_not_found', `Agent '${agentId}' has no active generation`);
      const handoff = admission.state === 'missing'
        ? await this.deps.startInitial(agentId, actionId, lease)
        : admission.handoff;
      if (admission.state === 'present') await this.deps.startExisting(handoff, lease);
      const liveness = await this.deps.backend.liveness(agentId);
      if (liveness.state === 'running') return this.result(agentId, 'running', liveness.state, liveness.detail);
      if (liveness.state === 'unknown')
        throw new FleetError('control_unavailable', `Agent '${agentId}' liveness is unknown`, { retryable: true });
      if (this.deps.backend.id === 'none')
        throw new FleetError('capability_unavailable', `Agent '${agentId}' cannot be started with backend none`);
      const installed = await this.deps.backend.install(agentId, this.deps.binPath);
      try { await this.deps.backend.start(agentId); }
      catch (error) {
        if (installed.created) {
          try { await this.deps.backend.uninstall(agentId); }
          catch (rollback) { throw new FleetError('rollback_incomplete', `Agent '${agentId}' start failed and registration rollback failed`,
            { details: { start: String(error), rollback: String(rollback) } }); }
        }
        throw error;
      }
      const observed = await this.deps.backend.liveness(agentId);
      if (observed.state === 'unknown')
        throw new FleetError('control_unavailable', `Agent '${agentId}' liveness is unknown after start`, { retryable: true });
      if (observed.state === 'stopped')
        throw new FleetError('launched_unconfirmed', `Agent '${agentId}' remained stopped after start`, { retryable: true });
      return this.result(agentId, 'running', observed.state, observed.detail);
    });
  }
  private reconfigure(agentId: string, expectedDigest: string, actionId: string): Promise<ManagementResult> {
    return this.deps.control.exclusive(agentId, async lease => {
      const admission = this.deps.readHandoff(agentId);
      if (admission.state !== 'present') throw new FleetError(admission.state === 'corrupt' ? 'stale_state' : 'resource_not_found',
        `Agent '${agentId}' has no valid active generation`);
      if (!this.deps.reconfigure) throw new FleetError('capability_unavailable', 'Agent reconfigure is unavailable');
      await this.deps.reconfigure(agentId, expectedDigest, actionId, lease);
      const live = await this.deps.backend.liveness(agentId);
      if (live.state === 'unknown') throw new FleetError('control_unavailable', `Agent '${agentId}' liveness is unknown`);
      if (this.deps.backend.id === 'none')
        throw new FleetError('capability_unavailable', `Agent '${agentId}' cannot be reconfigured with backend none`);
      if (live.state === 'running') await this.deps.backend.restart(agentId);
      else await this.deps.backend.start(agentId);
      const observed = await this.deps.backend.liveness(agentId);
      if (observed.state !== 'running') throw new FleetError(observed.state === 'unknown'
        ? 'control_unavailable' : 'launched_unconfirmed',
      `Agent '${agentId}' did not become running after reconfigure`, { retryable: true });
      return this.result(agentId, 'running', observed.state, observed.detail);
    });
  }
  private retire(agentId: string, actionId: string): Promise<ManagementResult> {
    return this.deps.control.exclusive(agentId, async lease => {
      const admission = this.deps.readHandoff(agentId);
      if (admission.state !== 'present') throw new FleetError(admission.state === 'corrupt' ? 'stale_state' : 'resource_not_found',
        `Agent '${agentId}' has no valid active generation`);
      const live = await this.deps.backend.liveness(agentId);
      if (live.state === 'unknown') throw new FleetError('control_unavailable', `Agent '${agentId}' liveness is unknown`);
      if (live.state === 'running') await this.deps.backend.stop(agentId);
      if (!this.deps.retire) throw new FleetError('capability_unavailable', 'Agent retirement is unavailable');
      if (!this.deps.control.bind(lease, { agentId, operation: 'retire',
        priorGeneration: admission.handoff.generation, targetGeneration: admission.handoff.generation,
        actionId, planDigest: admission.handoff.planDigest, snapshotDigest: admission.handoff.snapshotDigest,
        rootId: 'production-agent-creation', publisherId: 'agent-supervisor-handoff' }))
        throw new FleetError('stale_state', `Agent '${agentId}' retirement authority is unavailable`);
      await this.deps.retire(admission.handoff, actionId, lease);
      await this.deps.backend.uninstall(agentId);
      return this.result(agentId, 'retired', 'stopped', 'retired');
    });
  }
  private result(id: string, desired: 'running'|'retired', observed: 'running'|'stopped'|'unknown', detail: string): ManagementResult {
    return { type: 'agent', id, desired, observed, detail };
  }
}
