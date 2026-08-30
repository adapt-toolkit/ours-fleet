import type { ResolvedRole } from '../config.js';
import { AcpSession } from '../session/acp.js';
import type { AcpMcpServer, SessionPrep } from './types.js';
import type {
  AgentSessionAdapter, AgentSessionStartOptions,
  PreparedAgentSessionLaunch,
} from './agent-session.js';
import {
  acpAdapterState, type AcpSessionTransport,
} from './acp-session-transport.js';

export interface ClaudeCodeSessionStrategy {
  resolveBrain: AgentSessionAdapter['resolveBrain'];
  modelEnvironmentVariable: AgentSessionAdapter['modelEnvironmentVariable'];
  prepareLaunch(role: ResolvedRole, prep: SessionPrep): PreparedAgentSessionLaunch;
  permissionModeId(role: ResolvedRole): string | undefined;
  mcpServers(role: ResolvedRole): AcpMcpServer[] | undefined;
  sessionMeta(role: ResolvedRole, prep: SessionPrep): Record<string, unknown> | undefined;
}

/** Explicit Claude Code implementation of Fleet's shared agent-session factory. */
export class ClaudeCodeAgentSessionAdapter implements AgentSessionAdapter {
  constructor(
    private readonly strategy: ClaudeCodeSessionStrategy,
    private readonly transport: AcpSessionTransport = AcpSession.start,
  ) {}

  resolveBrain(brain: Parameters<AgentSessionAdapter['resolveBrain']>[0]) {
    return this.strategy.resolveBrain(brain);
  }

  modelEnvironmentVariable() { return this.strategy.modelEnvironmentVariable(); }

  prepareLaunch(role: ResolvedRole, prep: SessionPrep): PreparedAgentSessionLaunch {
    return this.strategy.prepareLaunch(role, prep);
  }

  start(options: AgentSessionStartOptions) {
    const { role, prep, launch } = options;
    return this.transport({
      name: role.name, argv: launch.argv, cwd: options.cwd, env: launch.env,
      stateDir: options.stateDir, mode: options.mode, permissions: options.permissions,
      modeId: this.strategy.permissionModeId(role),
      mcpServers: this.strategy.mcpServers(role),
      sessionMeta: this.strategy.sessionMeta(role, prep),
      permissionMode: options.permissionMode,
      permissionMetadataSource: acpAdapterState(launch.adapterState).permissionMetadataSource,
      scrubObsoleteOursAutostart: true,
      log: options.log,
    });
  }
}
