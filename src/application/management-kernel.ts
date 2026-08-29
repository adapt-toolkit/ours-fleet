import { FleetError, normalizeError, type FleetErrorShape } from './errors.js';
import { MANAGEMENT_PROTOCOL_VERSION, type ManagementPrincipal, type ManagementRequest,
  type ManagementResponse, type ManagementResult } from './management-contract.js';
import { ManagementOperationStore, managementDigest } from './management-operation-store.js';
import { ResourceManagementService } from './resource-management-service.js';

export interface AgentManagementPort {
  execute(command: Extract<ManagementRequest['command'], { operation: `agent.${string}` }>,
    context?: Readonly<{ operationId: string }>): Promise<ManagementResult>;
}
export interface TaskRoomManagementPort {
  execute(command: Extract<ManagementRequest['command'], { operation: `task.${string}`|`room.${string}` }>,
    principal: ManagementPrincipal, context?: TaskRoomOperationContext): Promise<ManagementResult>;
  reconcile?(command: Extract<ManagementRequest['command'], { operation: `task.${string}`|`room.${string}` }>,
    principal: ManagementPrincipal, context: TaskRoomOperationContext): Promise<ManagementResult | undefined>;
  finalize?(command: Extract<ManagementRequest['command'], { operation: `task.${string}`|`room.${string}` }>,
    context: TaskRoomOperationContext): Promise<void>;
}
export interface TaskRoomOperationContext { keyHash: string; principalHash: string; requestHash: string }
export interface ManagementAuthorization { authorize(principal: ManagementPrincipal, request: ManagementRequest): boolean }

export class ManagementKernel {
  constructor(private readonly resources: ResourceManagementService, private readonly agents: AgentManagementPort,
    private readonly authorization: ManagementAuthorization, private readonly operations: ManagementOperationStore,
    private readonly now: () => Date = () => new Date(), private readonly taskRooms?: TaskRoomManagementPort) {}
  async execute(principal: ManagementPrincipal, request: ManagementRequest): Promise<ManagementResponse> {
    if (request.version !== MANAGEMENT_PROTOCOL_VERSION || !request.requestId)
      return this.failure(request.requestId || 'invalid', new FleetError('incompatible_version', 'management protocol version must be 1'));
    if (!this.authorization.authorize(principal, request))
      return this.failure(request.requestId, new FleetError('forbidden', 'management operation is not authorized'));
    const operation = request.command.operation;
    const query = operation === 'resource.list' || operation === 'resource.get'
      || operation === 'task.list' || operation === 'task.get'
      || operation === 'room.list' || operation === 'room.get' || operation === 'room.members.list';
    if (!query && !request.idempotencyKey)
      return this.failure(request.requestId, new FleetError('invalid_request', 'mutation requires an idempotency key'));
    if ((operation === 'task.delete' || operation === 'task.cancel' || operation === 'room.delete')
        && request.command.confirmationId !== request.command.id)
      return this.failure(request.requestId, new FleetError('invalid_request',
        `confirmation must exactly match '${request.command.id}'`, { details: { reason: 'confirmation_mismatch' } }));
    const requestHash = managementDigest(idempotencyIdentity(request.command));
    const keyHash = request.idempotencyKey ? managementDigest(request.idempotencyKey) : undefined;
    if (keyHash) return this.operations.exclusive(keyHash,
      () => this.executeIdempotent(principal, request, requestHash, keyHash));
    return this.executeEffect(principal, request, request.requestId);
  }
  private async executeIdempotent(principal: ManagementPrincipal, request: ManagementRequest, requestHash: string,
    keyHash: string): Promise<ManagementResponse> {
      const prior = this.operations.read(keyHash);
      const principalHash = managementDigest(principal.cid
        ? { authority: 'cid', cid: principal.cid.toLowerCase() }
        : principal.local ? { authority: 'local' } : { authority: 'unverified' });
      if (prior && prior.principalHash !== principalHash)
        return this.failure(request.requestId, new FleetError('idempotency_conflict', 'idempotency key is unavailable'));
      if (prior && prior.requestHash !== requestHash)
        return this.failure(request.requestId, new FleetError('idempotency_conflict', 'idempotency key was used for another request'));
      if (prior?.response) {
        if (prior.phase === 'completed' && /^(?:task|room)\./u.test(prior.checkpoint?.operation ?? '')) {
          try { await this.taskRooms?.finalize?.(request.command as Extract<ManagementRequest['command'],
            { operation: `task.${string}`|`room.${string}` }>, { keyHash, principalHash, requestHash }); } catch {}
        }
        return { ...prior.response, requestId: request.requestId,
          replay: { source: 'journal', redacted: /^(?:task|room)\./u.test(prior.checkpoint?.operation ?? '') } };
      }
      const at = this.now().toISOString(); const operation = request.command.operation;
      const checkpoint = prior?.checkpoint ?? { operation,
        ...('expectedDigest' in request.command ? { resourceVersion: request.command.expectedDigest } : {}),
        ...('id' in request.command && operation.startsWith('agent.') ? {
          actionId: `${keyHash.slice(0, 24)}-${request.command.id}`,
        } : {}),
      };
      if (!prior) this.operations.write({ version: 1, keyHash, requestHash, principalHash, phase: 'prepared',
        createdAt: at, updatedAt: at, checkpoint });
      if (prior?.phase === 'effecting') {
        const recovered = this.reconcileResourceEffect(request);
        if (recovered) {
          const response: ManagementResponse = { version: 1, requestId: request.requestId, ok: true,
            result: recovered };
          this.operations.write({ version: 1, keyHash, requestHash, principalHash, phase: 'completed',
            createdAt: prior.createdAt, updatedAt: at, checkpoint, response });
          return response;
        }
        if (/^(?:task|room)\./u.test(operation) && this.taskRooms?.reconcile) {
          let recoveredTaskRoom: ManagementResult | undefined;
          try { recoveredTaskRoom = await this.taskRooms.reconcile(request.command as Extract<ManagementRequest['command'],
            { operation: `task.${string}`|`room.${string}` }>, principal, { keyHash, principalHash, requestHash }); }
          catch (error) { return this.failure(request.requestId, normalizeError(error, request.requestId)); }
          if (recoveredTaskRoom) {
            const response: ManagementResponse = { version: 1, requestId: request.requestId, ok: true,
              result: recoveredTaskRoom, replay: { source: 'journal', redacted: true } };
            this.operations.write({ version: 1, keyHash, requestHash, principalHash, phase: 'completed',
              createdAt: prior.createdAt, updatedAt: at, checkpoint, response: redactJournalResponse(response) });
            try { await this.taskRooms.finalize?.(request.command as Extract<ManagementRequest['command'],
              { operation: `task.${string}`|`room.${string}` }>, { keyHash, principalHash, requestHash }); } catch {}
            return response;
          }
        }
      }
      this.operations.write({ version: 1, keyHash, requestHash, principalHash, phase: 'effecting',
        createdAt: prior?.createdAt ?? at, updatedAt: at, checkpoint });
      const response = await this.executeEffect(principal, request, keyHash);
      const completed = this.now().toISOString();
      const journaled = redactJournalResponse(response);
      this.operations.write({ version: 1, keyHash, requestHash, principalHash,
        phase: response.ok ? 'completed' : 'failed', createdAt: prior?.createdAt ?? at,
        updatedAt: completed, checkpoint, response: journaled });
      if (response.ok && /^(?:task|room)\./u.test(operation)) {
        try { await this.taskRooms?.finalize?.(request.command as Extract<ManagementRequest['command'],
          { operation: `task.${string}`|`room.${string}` }>, { keyHash, principalHash, requestHash }); } catch {}
      }
      return response;
  }
  private reconcileResourceEffect(request: ManagementRequest): ManagementResult | undefined {
    const command = request.command;
    if (command.operation === 'resource.create' || command.operation === 'resource.update') {
      const recovered = this.resources.reconcile([{ mutation: command.operation.slice('resource.'.length) as 'create'|'update',
        resource: command.resource }], command.expectedDigest);
      return recovered ? { type: 'resource', digest: recovered.digest, resource: recovered.resources[0]! } : undefined;
    }
    if (command.operation === 'resource.delete') {
      const recovered = this.resources.reconcile([{ mutation: 'delete', kind: command.kind, id: command.id }],
        command.expectedDigest);
      return recovered ? { type: 'deleted', digest: recovered.digest, kind: command.kind, id: command.id } : undefined;
    }
    if (command.operation === 'resource.apply') {
      const recovered = this.resources.reconcile(command.mutations, command.expectedDigest,
        command.bootstrap?.contents);
      return recovered ? { type: 'resource-batch', ...recovered } : undefined;
    }
    return undefined;
  }
  private async executeEffect(principal: ManagementPrincipal, request: ManagementRequest,
    operationId: string): Promise<ManagementResponse> {
    let response: ManagementResponse;
    try { response = { version: 1, requestId: request.requestId, ok: true,
      result: await this.dispatch(principal, request, operationId) }; }
    catch (error) { response = this.failure(request.requestId, normalizeError(error, request.requestId)); }
    return response;
  }
  private async dispatch(principal: ManagementPrincipal, request: ManagementRequest,
    operationId: string): Promise<ManagementResult> {
    const command = request.command;
    if (command.operation === 'resource.list') return { type: 'resources', ...this.resources.list(command.kind) };
    if (command.operation === 'resource.get') return { type: 'resource', ...this.resources.get(command.kind, command.id) };
    if (command.operation === 'resource.create') return { type: 'resource', ...await this.resources.create(command.resource, command.expectedDigest) };
    if (command.operation === 'resource.update') return { type: 'resource', ...await this.resources.update(command.resource, command.expectedDigest) };
    if (command.operation === 'resource.delete') return { type: 'deleted', ...await this.resources.delete(command.kind, command.id, command.expectedDigest) };
    if (command.operation === 'resource.apply') return { type: 'resource-batch',
      ...await this.resources.apply(command.mutations, command.expectedDigest, command.bootstrap) };
    if (command.operation.startsWith('agent.'))
      return this.agents.execute(command as Extract<typeof command, { operation: `agent.${string}` }>, { operationId });
    if (!this.taskRooms) throw new FleetError('capability_unavailable', 'task and room management is unavailable');
    return this.taskRooms.execute(command as Extract<typeof command,
      { operation: `task.${string}`|`room.${string}` }>, principal, {
        keyHash: operationId, principalHash: principalIdentityHash(principal),
        requestHash: managementDigest(idempotencyIdentity(command)),
      });
  }
  private failure(requestId: string, error: FleetError): ManagementResponse {
    return { version: 1, requestId, ok: false, error: error.toJSON() };
  }
}

function principalIdentityHash(principal: ManagementPrincipal): string {
  return managementDigest(principal.cid ? { authority: 'cid', cid: principal.cid.toLowerCase() }
    : principal.local ? { authority: 'local' } : { authority: 'unverified' });
}

function idempotencyIdentity(command: ManagementRequest['command']): unknown {
  if ((command.operation.startsWith('task.') || command.operation === 'room.recover')
      && 'expectedStateDigest' in command) {
    const { expectedStateDigest: _concurrencyGuard, ...identity } = command;
    return identity;
  }
  return command;
}

const keys = (...value: string[]): ReadonlySet<string> => new Set(value);
const TASK_KEYS = ['task_id', 'title', 'state', 'status', 'kind', 'room_id', 'list', 'blocked',
  'created_at', 'started_at', 'ended_at', 'reason'] as const;
const ROOM_KEYS = ['room_id', 'room_name', 'state', 'status', 'kind', 'role', 'seat_state',
  'phase', 'step_index', 'created_at'] as const;
const JOURNAL_KEYS_BY_TYPE: Partial<Record<ManagementResult['type'], ReadonlySet<string>>> = {
  task: keys(...TASK_KEYS, 'task', 'room', 'deleted'),
  'task-detail': keys(...TASK_KEYS, ...ROOM_KEYS, 'task', 'room', 'orchestration', 'saga'),
  'task-settlement': keys(...TASK_KEYS, ...ROOM_KEYS, 'task', 'room', 'settlementRequired'),
  'task-recovery': keys(...TASK_KEYS, ...ROOM_KEYS, 'task', 'room', 'orchestration', 'issues', 'reason'),
  tasks: keys(...TASK_KEYS, 'tasks', 'groups', 'list', 'built_in'),
  room: keys(...ROOM_KEYS, 'room', 'orchestration'),
  'room-detail': keys(...ROOM_KEYS, 'room', 'orchestration', 'saga'),
  'room-members': keys(...ROOM_KEYS, 'room', 'orchestration', 'members', 'saga'),
  'room-close': keys(...ROOM_KEYS, 'room', 'orchestration', 'settlementRequired'),
  'room-recovery': keys(...ROOM_KEYS, 'room', 'orchestration', 'issues', 'reason'),
};
const JOURNAL_ERROR_KEYS = new Set([
  'reason', 'task', 'room', 'state', 'template', 'requested', 'provisioned', 'migration', 'stepIndex',
]);
function projectJournalValue(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(child => projectJournalValue(child, allowed));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => allowed.has(key))
    .map(([key, child]) => [key, projectJournalValue(child, allowed)]));
}
function redactJournalResponse(response: ManagementResponse): ManagementResponse {
  if (!response.ok) return { ...response, error: { ...response.error,
    details: projectJournalValue(response.error.details, JOURNAL_ERROR_KEYS) as FleetErrorShape['details'] } };
  if (!('value' in response.result)) return response;
  return { ...response, result: { ...response.result,
    value: projectJournalValue(response.result.value,
      JOURNAL_KEYS_BY_TYPE[response.result.type] ?? keys()) } };
}
