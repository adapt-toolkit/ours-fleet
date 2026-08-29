import type {
  CommonPermissions, FleetPermissionMode, ResolvedRole,
} from '../config.js';
import type { AgentSession } from '../session/types.js';
import type { Launch, SessionPrep } from './types.js';

/**
 * Command selected by a harness adapter. The runner may wrap argv for its
 * isolation/resource boundary, but never interprets adapter-specific fields.
 */
export interface PreparedAgentSessionLaunch extends Launch {
  readonly adapterState?: unknown;
}

export interface AgentSessionStartOptions {
  role: ResolvedRole;
  prep: SessionPrep;
  launch: PreparedAgentSessionLaunch;
  cwd: string;
  stateDir: string;
  mode: 'fresh' | 'resume';
  permissions: CommonPermissions;
  permissionMode: { fleetMode: FleetPermissionMode; nativeMode: string };
  log(line: string): void;
}

/**
 * The sole harness-specific boundary for creating a live agent session.
 * Lifecycle orchestration remains in the runner; ACP normalization remains in
 * the shared transport implementation.
 */
export interface AgentSessionAdapter {
  prepareLaunch(role: ResolvedRole, prep: SessionPrep): PreparedAgentSessionLaunch;
  start(options: AgentSessionStartOptions): Promise<AgentSession>;
}
