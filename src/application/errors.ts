import { randomUUID } from 'node:crypto';
import { SessionControlError } from '../session/types.js';
import { CreationConflictError } from '../creation.js';

export type FleetErrorCode =
  | 'role_not_found' | 'resource_not_found' | 'capability_unavailable' | 'invalid_request'
  | 'offline' | 'control_unavailable' | 'timeout' | 'rejected'
  | 'backend_failure' | 'conflict' | 'stale_state'
  | 'prerequisite_unavailable' | 'idempotency_conflict'
  | 'rollback_incomplete' | 'launched_unconfirmed'
  | 'unauthorized' | 'forbidden' | 'rate_limited'
  | 'incompatible_version' | 'internal';

export interface FleetErrorShape {
  code: FleetErrorCode;
  message: string;
  provesOffline: boolean;
  retryable: boolean;
  requestId: string;
  details?: Record<string, string | number | boolean>;
}

const CONTROL_CODES = {
  offline: 'offline',
  'control-unavailable': 'control_unavailable',
  timeout: 'timeout',
  rejected: 'rejected',
  backend: 'backend_failure',
} as const;

export class FleetError extends Error implements FleetErrorShape {
  readonly requestId: string;
  constructor(
    readonly code: FleetErrorCode,
    message: string,
    readonly options: {
      provesOffline?: boolean;
      retryable?: boolean;
      requestId?: string;
      details?: Record<string, string | number | boolean>;
    } = {},
  ) {
    super(safeLine(message));
    this.name = 'FleetError';
    this.requestId = options.requestId ?? randomUUID();
  }
  get provesOffline(): boolean { return this.options.provesOffline ?? this.code === 'offline'; }
  get retryable(): boolean {
    return this.options.retryable
      ?? ['timeout', 'control_unavailable', 'backend_failure', 'launched_unconfirmed'].includes(this.code);
  }
  get details(): Record<string, string | number | boolean> | undefined { return this.options.details; }
  toJSON(): FleetErrorShape {
    return {
      code: this.code, message: this.message, provesOffline: this.provesOffline,
      retryable: this.retryable, requestId: this.requestId, details: this.details,
    };
  }
}

export function safeLine(input: string, max = 512): string {
  return input.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeError(error: unknown, requestId?: string): FleetError {
  if (error instanceof FleetError) return error;
  if (error instanceof CreationConflictError)
    return new FleetError('conflict', error.message, { requestId, retryable: true });
  if (error instanceof SessionControlError) {
    const code = CONTROL_CODES[error.kind];
    return new FleetError(code, error.message, {
      requestId, provesOffline: error.kind === 'offline',
      retryable: error.kind === 'timeout' || error.kind === 'control-unavailable' || error.kind === 'backend',
    });
  }
  return new FleetError('internal', error instanceof Error ? error.message : String(error), { requestId });
}
