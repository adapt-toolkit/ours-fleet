import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withConfigGraphLock, type ConfigGraphLockOptions } from './config-graph-lock.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const safe = (id: string): string => {
  if (!TOKEN.test(id)) throw new AgentSupervisorControlError('invalid_agent');
  return Buffer.from(id).toString('base64url');
};
export class AgentSupervisorControlError extends Error {
  constructor(readonly code: 'invalid_agent'|'invalid_lease'|'unsafe_root') {
    super(`agent supervisor control: ${code}`); this.name = 'AgentSupervisorControlError';
  }
}
export type AgentSupervisorControlLease = object;
export interface AgentSupervisorControlBinding {
  agentId: string; operation: 'create'|'resume'|'reconfigure'|'retire';
  priorGeneration: number; targetGeneration: number; actionId: string;
  planDigest: string; snapshotDigest: string; rootId: 'production-agent-creation';
  publisherId: 'agent-supervisor-handoff';
}

/**
 * Internal cross-process authority for all name-keyed supervisor effects.
 * Lease objects carry no data and are authenticated solely by this instance's
 * WeakMap; they cannot be serialized, forged, reused, or consumed by a sibling
 * authority instance.
 */
export class AgentSupervisorControlAuthority {
  readonly #leases = new WeakMap<object, { agentId: string; operation?: AgentSupervisorControlBinding['operation'];
    binding?: Readonly<AgentSupervisorControlBinding>; active: boolean }>();
  readonly #root: string;
  constructor(trustedStateRoot: string, private readonly lockOptions: ConfigGraphLockOptions = {}) {
    this.#root = resolve(trustedStateRoot, 'agent-control');
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.#root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
      throw new AgentSupervisorControlError('unsafe_root');
  }
  async exclusive<T>(agentId: string,
    effect: (lease: AgentSupervisorControlLease) => T | Promise<T>,
    operation?: AgentSupervisorControlBinding['operation']): Promise<T> {
    const encoded = safe(agentId);
    return withConfigGraphLock(join(this.#root, encoded), 'exclusive', async () => {
      const lease = Object.freeze(Object.create(null)) as object;
      this.#leases.set(lease, { agentId, operation, active: true });
      try { return await effect(lease); }
      finally { const state = this.#leases.get(lease); if (state) state.active = false; this.#leases.delete(lease); }
    }, this.lockOptions);
  }
  bind(lease: AgentSupervisorControlLease, binding: Readonly<AgentSupervisorControlBinding>): boolean {
    const state = this.#leases.get(lease);
    if (!state?.active || state.agentId !== binding.agentId
        || state.operation && state.operation !== binding.operation
        || state.binding) return false;
    state.binding = Object.freeze({ ...binding }); return true;
  }
  consume(lease: AgentSupervisorControlLease, binding: Readonly<AgentSupervisorControlBinding>): boolean {
    const state = this.#leases.get(lease);
    if (!state?.active || !state.binding
        || JSON.stringify(state.binding) !== JSON.stringify(binding)) return false;
    state.active = false;
    return true;
  }
  authenticate(lease: AgentSupervisorControlLease, agentId: string): boolean {
    const state = this.#leases.get(lease); return !!state?.active && state.agentId === agentId;
  }
}
