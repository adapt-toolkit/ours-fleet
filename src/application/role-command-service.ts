import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { up, restartRoles, type OpsDeps } from '../ops.js';
import { FleetError, normalizeError } from './errors.js';
import { RoleRepository } from './role-repository.js';
import type { RoleStatus } from './types.js';

export interface RestartBatchPlan {
  readonly roleIds: readonly string[];
  readonly mode: 'keep' | 'fresh';
  readonly config: ReturnType<typeof loadConfig>;
  readonly configPath?: string;
}

/** Shared restart kernel. Receipt policy and surface rendering stay with callers. */
export class RoleLifecycleService {
  constructor(private readonly options: RoleCommandOptions) {}

  async prepareRestart(input: {
    roleIds: string[]; mode: 'keep' | 'fresh'; config?: ReturnType<typeof loadConfig>;
  }): Promise<RestartBatchPlan> {
    const config = input.config ?? loadConfig(this.options.configPath);
    const selected = input.roleIds.length ? input.roleIds : config.roles.map(role => role.name);
    for (const roleId of selected) {
      const role = await this.options.repository.get(roleId);
      if (!role) throw new FleetError('role_not_found', `no such role '${roleId}'`);
      if (role.lifetime !== 'permanent')
        throw new FleetError('capability_unavailable', 'lifecycle is unavailable for temporary/orphan roles');
    }
    return Object.freeze({
      roleIds: Object.freeze([...input.roleIds]), mode: input.mode, config,
      ...(this.options.configPath ? { configPath: this.options.configPath } : {}),
    });
  }

  async executeRestart(plan: RestartBatchPlan): Promise<void> {
    await (this.options.restart ?? restartRoles)(
      plan.config, [...plan.roleIds], this.options.ops, plan.mode, plan.configPath,
    );
  }

  status(roleId: string): Promise<RoleStatus> { return this.options.status(roleId); }
}

/** Adapter-facing batch entry point used by CLI and detached Messenger workers. */
export async function executeRestartBatch(
  lifecycle: Pick<RoleLifecycleService, 'prepareRestart' | 'executeRestart'>,
  input: { roleIds: string[]; mode: 'keep' | 'fresh'; config?: ReturnType<typeof loadConfig> },
): Promise<RestartBatchPlan> {
  const plan = await lifecycle.prepareRestart(input);
  await lifecycle.executeRestart(plan);
  return plan;
}

export type LifecycleAction = 'start' | 'stop' | 'restart_resume' | 'restart_fresh';
export interface CommandReceipt {
  actionId: string;
  roleId: string;
  action: LifecycleAction;
  acceptedAt: string;
  completedAt?: string;
  state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  error?: ReturnType<FleetError['toJSON']>;
  postcondition?: Pick<RoleStatus, 'overall' | 'observedAt'>;
}

export interface RoleCommandOptions {
  repository: RoleRepository;
  ops: OpsDeps;
  configPath?: string;
  status(roleId: string): Promise<RoleStatus>;
  onProgress?: (receipt: CommandReceipt) => void;
  restart?: typeof restartRoles;
  lifecycle?: RoleLifecycleService;
}

export class RoleCommandService {
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly locks = new Map<string, Promise<void>>();
  readonly lifecycle: RoleLifecycleService;
  constructor(private readonly options: RoleCommandOptions) {
    this.lifecycle = options.lifecycle ?? new RoleLifecycleService(options);
  }

  async execute(input: {
    roleId: string; action: LifecycleAction; actionId?: string; confirmation?: string;
  }): Promise<CommandReceipt> {
    const actionId = input.actionId ?? randomUUID();
    const prior = this.receipts.get(actionId);
    if (prior) {
      if (prior.roleId !== input.roleId || prior.action !== input.action)
        throw new FleetError('idempotency_conflict', 'action ID already belongs to another operation');
      return prior;
    }
    const role = await this.options.repository.get(input.roleId);
    if (!role) throw new FleetError('role_not_found', `no such role '${input.roleId}'`);
    if (role.lifetime !== 'permanent')
      throw new FleetError('capability_unavailable', 'lifecycle is unavailable for temporary/orphan roles');
    if (input.action === 'restart_fresh' && input.confirmation !== input.roleId)
      throw new FleetError('invalid_request', 'fresh restart requires the exact role name');
    const receipt: CommandReceipt = {
      actionId, roleId: input.roleId, action: input.action,
      acceptedAt: new Date().toISOString(), state: 'accepted',
    };
    this.receipts.set(actionId, receipt);
    void this.serial(input.roleId, async () => this.run(receipt));
    return receipt;
  }

  get(actionId: string): CommandReceipt | undefined { return this.receipts.get(actionId); }

  private async run(receipt: CommandReceipt): Promise<void> {
    receipt.state = 'running';
    this.options.onProgress?.(structuredClone(receipt));
    try {
      const config = loadConfig(this.options.configPath);
      if (receipt.action === 'start')
        await up(config, [receipt.roleId], this.options.ops, this.options.configPath);
      else if (receipt.action === 'stop')
        await this.options.ops.backend.stop(receipt.roleId);
      else {
        const plan = await this.lifecycle.prepareRestart({
          roleIds: [receipt.roleId],
          mode: receipt.action === 'restart_fresh' ? 'fresh' : 'keep', config,
        });
        await this.lifecycle.executeRestart(plan);
      }
      try {
        const status = await this.options.status(receipt.roleId);
        receipt.postcondition = { overall: status.overall, observedAt: status.observedAt };
        const expected = receipt.action === 'stop' ? status.supervisor.liveness === 'stopped'
          : status.supervisor.liveness === 'running';
        receipt.state = expected ? 'succeeded' : 'uncertain';
      } catch {
        receipt.state = 'uncertain';
      }
    } catch (error) {
      const normalized = normalizeError(error);
      receipt.error = normalized.toJSON();
      receipt.state = 'failed';
    }
    receipt.completedAt = new Date().toISOString();
    this.options.onProgress?.(structuredClone(receipt));
  }

  private async serial<T>(roleId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(roleId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const chain = prior.then(() => gate);
    this.locks.set(roleId, chain);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(roleId) === chain) this.locks.delete(roleId);
    }
  }
}
