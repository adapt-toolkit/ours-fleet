import type { CommonPermissions, SessionBackendId } from '../config.js';
import type { ExitRecord, SessionEvent, SessionSnapshot } from '../session/types.js';

export type RoleLifetime = 'permanent' | 'temporary' | 'orphan';
export type DetectedBackend = SessionBackendId | 'none' | 'ambiguous';

export interface ResolvedRoleView {
  name: string;
  harness: string;
  session: SessionBackendId;
  identity: string;
  mission?: string;
  coordinator?: string;
  model?: string;
  cwd?: string;
  permissions: CommonPermissions;
}

export interface RoleRecord {
  id: string;
  lifetime: RoleLifetime;
  configured: boolean;
  config?: ResolvedRoleView;
  stateRef?: { lifetime: 'permanent' | 'temporary' };
  stateHealth: 'present' | 'missing' | 'corrupt';
  configuredBackend?: SessionBackendId;
  detectedBackend: DetectedBackend;
  compatibility: { compatible: boolean; detail?: string };
  problems: Problem[];
}

export interface Problem {
  code: string;
  severity: 'info' | 'warning' | 'error';
  detail: string;
  source?: string;
}

export interface RoleStatus {
  roleId: string;
  observedAt: string;
  overall: 'ready' | 'busy' | 'attention' | 'offline' | 'unknown';
  supervisor: {
    backend: 'systemd' | 'launchd' | 'none';
    liveness: 'running' | 'stopped' | 'unknown';
    nativeState?: string;
    detail: string;
  };
  session: {
    backend: SessionBackendId | 'unknown';
    reachability: 'online' | 'offline' | 'unavailable' | 'unknown';
    readiness: 'starting' | 'idle' | 'running' | 'awaiting_permission' | 'failed' | 'unknown';
    evidence: 'authoritative' | 'inferred';
    sessionId?: string;
    lastError?: string;
    pendingPermissionId?: string;
  };
  restart: {
    circuit: 'closed' | 'open';
    consecutiveImmediateFailures: number;
    nextDelayMs: number;
    lastReason?: string;
    openedAt?: string;
  };
  monitor: {
    mode: 'fleet' | 'native' | 'unknown';
    health: 'armed' | 'degraded' | 'failed' | 'unknown';
    updatedAt?: string;
    detail?: string;
    stale: boolean;
  };
  lastExit?: ExitRecord;
  isolation: { degraded: boolean; detail?: string };
  problems: Problem[];
}

export interface RoleCapabilities {
  protocolVersion: number;
  inventory: true;
  status: true;
  output: { recent: boolean; stream: boolean; structured: boolean; replayCursor: boolean };
  input: { text: boolean; rawKeys: boolean; interrupt: boolean; steering: boolean };
  permissions: { observe: boolean; respond: boolean };
  terminal: {
    available: boolean;
    reason?: 'wrong_backend' | 'pty_unavailable' | 'offline' | 'incompatible_runner';
    multiViewer: boolean;
    writerLease: boolean;
  };
  lifecycle: {
    start: boolean; stop: boolean; restartResume: boolean; restartFresh: boolean; remove: boolean;
  };
  logs: { tail: boolean; follow: boolean; cursor: boolean };
}

export interface OutputPage {
  events: SessionEvent[];
  text?: string;
  firstSeq?: number;
  lastSeq?: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface SendReceipt {
  accepted: boolean;
  promptId: string;
  queuedBehind: number;
  terminalOutcomeKnown: boolean;
  detail: string;
}

export interface SessionDescriptor {
  backend: SessionBackendId;
  protocolVersion: number;
  features: string[];
  snapshot?: SessionSnapshot;
}

export interface LogRecord {
  at?: string;
  text: string;
  cursor?: string;
  redactionApplied: boolean;
  compacted?: {
    kind: 'monitor_stream_hiccup';
    reason: string;
    count: number;
    firstAt?: string;
    lastAt?: string;
  };
}

export interface LogPage { records: LogRecord[]; nextCursor?: string; truncated: boolean }
