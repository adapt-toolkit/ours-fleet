import type { ResolvedRole } from '../config.js';
import { AcpSession } from '../session/acp.js';
import { CodexAppServerSession } from '../session/codex-app-server.js';
import type { AcpMcpServer, SessionPrep } from './types.js';
import type {
  AgentSessionAdapter, AgentSessionStartOptions,
  PreparedAgentSessionLaunch,
} from './agent-session.js';
import {
  acpAdapterState, type AcpSessionTransport,
} from './acp-session-transport.js';

export interface CodexSessionStrategy {
  resolveBrain: AgentSessionAdapter['resolveBrain'];
  modelEnvironmentVariable: AgentSessionAdapter['modelEnvironmentVariable'];
  prepareLaunch(role: ResolvedRole, prep: SessionPrep): PreparedAgentSessionLaunch;
  sessionConfigSelections(role: ResolvedRole): ReturnType<AgentSessionAdapter['sessionConfigSelections']>;
  permissionModeId(role: ResolvedRole): string | undefined;
  mcpServers(role: ResolvedRole): AcpMcpServer[] | undefined;
  sessionMeta(role: ResolvedRole, prep: SessionPrep): Record<string, unknown> | undefined;
  approvalPolicy(role: ResolvedRole): string;
  sandbox(role: ResolvedRole): string;
  nativeConfig(role: ResolvedRole): Record<string, unknown> | undefined;
  addDirs(role: ResolvedRole): string[] | undefined;
}

export type CodexAppServerSessionTransport = typeof CodexAppServerSession.start;

/** Explicit Codex implementation of Fleet's shared agent-session factory. */
export class CodexAgentSessionAdapter implements AgentSessionAdapter {
  constructor(
    private readonly strategy: CodexSessionStrategy,
    private readonly transport: AcpSessionTransport = AcpSession.start,
    private readonly nativeTransport: CodexAppServerSessionTransport = CodexAppServerSession.start,
  ) {}

  resolveBrain(brain: Parameters<AgentSessionAdapter['resolveBrain']>[0]) {
    return this.strategy.resolveBrain(brain);
  }

  modelEnvironmentVariable() { return this.strategy.modelEnvironmentVariable(); }

  prepareLaunch(role: ResolvedRole, prep: SessionPrep): PreparedAgentSessionLaunch {
    return this.strategy.prepareLaunch(role, prep);
  }
  sessionConfigSelections(role: ResolvedRole) {
    return this.strategy.sessionConfigSelections(role);
  }

  start(options: AgentSessionStartOptions) {
    const { role, prep, launch } = options;
    if (role.session === 'codex-app-server') return this.nativeTransport({
      name: role.name, argv: launch.argv, cwd: options.cwd, env: launch.env,
      stateDir: options.stateDir, mode: options.mode, permissions: options.permissions,
      permissionMode: options.permissionMode,
      model: role.model, effort: role.effort,
      approvalPolicy: this.strategy.approvalPolicy(role),
      sandbox: this.strategy.sandbox(role),
      config: this.strategy.nativeConfig(role),
      addDirs: this.strategy.addDirs(role),
      log: options.log,
    });
    return this.transport({
      name: role.name, harness: role.harness,
      argv: launch.argv, cwd: options.cwd, env: launch.env,
      stateDir: options.stateDir, mode: options.mode, permissions: options.permissions,
      modeId: this.strategy.permissionModeId(role),
      mcpServers: this.strategy.mcpServers(role),
      sessionMeta: this.strategy.sessionMeta(role, prep),
      configSelections: this.strategy.sessionConfigSelections(role),
      permissionMode: options.permissionMode,
      permissionMetadataSource: acpAdapterState(launch.adapterState).permissionMetadataSource,
      scrubObsoleteOursAutostart: true,
      ...(role.monitor?.mode === 'fleet' && role.monitor.stall_recovery ? {
        stallRecovery: { timeoutMs: role.monitor.stall_timeout_ms },
      } : {}),
      log: options.log,
    });
  }
}
