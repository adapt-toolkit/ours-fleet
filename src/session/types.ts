import type { SessionBackendId } from '../config.js';

export type SessionReadiness =
  | 'starting'
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'failed';

export interface TurnResult {
  accepted: boolean;
  outcome: 'completed' | 'refused' | 'cancelled' | 'failed' | 'inconclusive';
  detail?: string;
}

export interface SessionSnapshot {
  backend: SessionBackendId;
  alive: boolean;
  readiness: SessionReadiness;
  sessionId?: string;
  lastError?: string;
  pendingPermissionId?: string;
}

export type SessionEventKind =
  | 'state'
  | 'agent_text'
  | 'thought'
  | 'tool_call'
  | 'tool_update'
  | 'permission'
  | 'turn_stop'
  | 'error';

export interface SessionEvent {
  version: 1;
  seq: number;
  at: string;
  kind: SessionEventKind;
  turnId?: string;
  toolCallId?: string;
  permissionId?: string;
  text?: string;
  title?: string;
  status?: string;
  stopReason?: string;
  options?: Array<{ optionId: string; name: string; kind: string }>;
}

export interface SessionHandle {
  readonly backend: SessionBackendId;
  readonly pid: number;
  isAlive(): boolean;
  snapshot(): SessionSnapshot;
  submitPrompt(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  respondPermission(permissionId: string, optionId: string): boolean;
  eventsSince(seq: number): SessionEvent[];
  subscribe(listener: (event: SessionEvent) => void): () => void;
  setControllerAttached(attached: boolean): void;
  close(): Promise<void>;
}
