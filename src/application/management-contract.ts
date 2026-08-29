import type { ResourceKind, TypedResource } from '../config-resources.js';
import type { FleetErrorShape } from './errors.js';

export const MANAGEMENT_PROTOCOL_VERSION = 1 as const;

export type ManagementResourceKind = ResourceKind;
export type ManagementMutation = 'create' | 'update' | 'delete';
export type ManagementResourceMutation =
  | { mutation: 'create'|'update'; resource: TypedResource }
  | { mutation: 'delete'; kind: ManagementResourceKind; id: string };

export interface ManagementPrincipal {
  surface: 'cli' | 'room' | 'owner' | 'web';
  /** Authenticated container id for remote principals. Display names are never authority. */
  cid?: string;
  local?: boolean;
}

export type ManagementCommand =
  | { operation: 'resource.list'; kind?: ManagementResourceKind }
  | { operation: 'resource.get'; kind: ManagementResourceKind; id: string }
  | { operation: 'resource.create'; resource: TypedResource; expectedDigest: string }
  | { operation: 'resource.update'; resource: TypedResource; expectedDigest: string }
  | { operation: 'resource.delete'; kind: ManagementResourceKind; id: string; expectedDigest: string }
  | { operation: 'resource.apply'; mutations: ManagementResourceMutation[]; expectedDigest: string;
      bootstrap?: { expectedRevision: string; contents: string } }
  | { operation: 'agent.start'; id: string }
  | { operation: 'agent.resume'; id: string }
  | { operation: 'agent.reconfigure'; id: string; expectedDigest: string }
  | { operation: 'agent.retire'; id: string }
  | { operation: 'task.create'; title: string; brief?: string; template?: string; backlog?: boolean;
      noRoom?: boolean; list?: string; origin: 'cli'|'owner_channel'|'web' }
  | { operation: 'task.start'; id: string; expectedStateDigest: string }
  | { operation: 'task.list'; state?: string; list?: string; groupByList?: boolean }
  | { operation: 'task.get'; id: string }
  | { operation: 'task.block'; id: string; reason: string; expectedStateDigest: string }
  | { operation: 'task.unblock'; id: string; expectedStateDigest: string }
  | { operation: 'task.review'; id: string; expectedStateDigest: string }
  | { operation: 'task.delete'; id: string; confirmationId: string; expectedStateDigest: string }
  | { operation: 'task.complete'; id: string; outcome?: unknown; expectedStateDigest: string }
  | { operation: 'task.cancel'; id: string; confirmationId: string; expectedStateDigest: string }
  | { operation: 'task.recover'; id: string; expectedStateDigest: string }
  | { operation: 'room.create'; name: string; template?: string; goal?: string; brief?: string }
  | { operation: 'room.list'; state?: 'active'|'provisioning' }
  | { operation: 'room.get'; id: string }
  | { operation: 'room.members.list'; id: string }
  | { operation: 'room.delete'; id: string; confirmationId: string; expectedStateDigest: string }
  | { operation: 'room.recover'; id: string; expectedStateDigest: string };

export interface ManagementRequest {
  version: typeof MANAGEMENT_PROTOCOL_VERSION;
  requestId: string;
  idempotencyKey?: string;
  command: ManagementCommand;
}

export type ManagementResult =
  | { type: 'resources'; digest: string; resources: TypedResource[] }
  | { type: 'resource'; digest: string; resource: TypedResource }
  | { type: 'deleted'; digest: string; kind: ManagementResourceKind; id: string }
  | { type: 'resource-batch'; digest: string; resources: TypedResource[];
      deleted: Array<{ kind: ManagementResourceKind; id: string }> }
  | { type: 'agent'; id: string; desired: 'running' | 'retired'; observed: 'running' | 'stopped' | 'unknown'; detail: string }
  | { type: 'task'|'task-detail'|'task-settlement'|'task-recovery'|'tasks'
      |'room'|'room-detail'|'room-members'|'room-close'|'room-recovery'; value: unknown };

export type ManagementResponse =
  | { version: typeof MANAGEMENT_PROTOCOL_VERSION; requestId: string; ok: true; result: ManagementResult;
      replay?: { source: 'journal'; redacted: boolean } }
  | { version: typeof MANAGEMENT_PROTOCOL_VERSION; requestId: string; ok: false; error: FleetErrorShape;
      replay?: { source: 'journal'; redacted: boolean } };
