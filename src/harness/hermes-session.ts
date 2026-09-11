import type * as acp from '@agentclientprotocol/sdk';
import type { ResolvedRole } from '../config.js';
import { AcpSession } from '../session/acp.js';
import type { SessionPrep, ValidationError } from './types.js';
import type { AgentSessionAdapter, AgentSessionStartOptions, BrainSelection } from './agent-session.js';
import type { AcpSessionTransport } from './acp-session-transport.js';
import { hermesChildEnvironment, hermesMcpServers, validateHermesOptions, validateHermesRole } from './hermes-config.js';
import { hermesPermissionMode } from './hermes-permissions.js';

/** Native provider resolution and executable compatibility remain harness-owned. */
export interface HermesStartupChecks {
  /** Independently resolved native provider identity, never copied from the ACP report. */
  expectedProvider(role: ResolvedRole, prep: SessionPrep): string | Promise<string>;
  validateArtifact(initialized: acp.InitializeResponse): void | Promise<void>;
  /** Inspect the executable using the completed child environment before spawning it. */
  preflight?(options: AgentSessionStartOptions, env: Record<string, string>): void | Promise<void>;
}

function requireValid(errors: ValidationError[]): void {
  if (errors.length) throw new Error(errors.map(error => `${error.path}: ${error.message}`).join('; '));
}
function requireModel(model: unknown): string {
  if (typeof model !== 'string' || !model.trim()) throw new Error('Hermes requires an explicit non-empty Brain model');
  return model.trim();
}
function preparedHome(prep: SessionPrep): string {
  if (!prep.env.HERMES_HOME?.trim()) throw new Error('Hermes requires a prepared runtime home');
  return prep.env.HERMES_HOME;
}

/** Fresh-only Hermes implementation of Fleet's existing live-session factory. */
export class HermesAgentSessionAdapter implements AgentSessionAdapter {
  constructor(
    private readonly transport: AcpSessionTransport = AcpSession.start,
    private readonly checks?: HermesStartupChecks,
  ) {}

  resolveBrain(brain: BrainSelection): ReturnType<AgentSessionAdapter['resolveBrain']> {
    const model = requireModel(brain.model);
    if (brain.effort != null) throw new Error('Hermes does not support effort');
    requireValid(validateHermesOptions(brain.harnessOptions));
    return { model, ...(brain.harnessOptions ? { harnessOptions: brain.harnessOptions } : {}) };
  }

  modelEnvironmentVariable(): string | undefined { return undefined; }

  prepareLaunch(role: ResolvedRole, prep: SessionPrep): ReturnType<AgentSessionAdapter['prepareLaunch']> {
    requireValid(validateHermesRole(role));
    preparedHome(prep);
    const command = role.session_options?.acp?.command;
    const argv = Array.isArray(command) ? [...command]
      : typeof command === 'string' ? ['sh', '-c', command] : ['hermes-acp'];
    return { argv, env: { ...prep.env } };
  }

  sessionConfigSelections(role: ResolvedRole): ReturnType<AgentSessionAdapter['sessionConfigSelections']> {
    requireValid(validateHermesRole(role));
    return [];
  }

  async start(options: AgentSessionStartOptions): ReturnType<AgentSessionAdapter['start']> {
    const { role, prep, launch } = options;
    requireValid(validateHermesRole({ ...role, permissions: options.permissions }));
    const model = requireModel(role.model);
    if (!this.checks) throw new Error('Hermes startup checks are required before launching a managed session');
    // Reapply the complete environment boundary after runner routing/isolation
    // composition; no second ambient merge may reintroduce provider secrets.
    const env = hermesChildEnvironment(role, preparedHome(prep), launch.env, launch.env);
    delete env.OURS_AUTOSTART;
    await this.checks.preflight?.(options, env);
    const nativeProvider = await this.checks.expectedProvider(role, prep);
    if (typeof nativeProvider !== 'string' || !nativeProvider.trim())
      throw new Error('Hermes requires an independently resolved native provider');
    const provider = nativeProvider.trim().toLowerCase();
    // model_catalog.encode_model_choice preserves model colons; its catalog
    // constructor promotes Ollama to the named custom provider identity.
    const expectedModelId = `${provider === 'ollama' ? 'custom:ollama' : provider}:${model}`;
    const modeId = hermesPermissionMode(options.permissions);
    return this.transport({
      name: role.name, harness: 'hermes', argv: launch.argv, cwd: options.cwd, env,
      inheritEnvironment: false, stateDir: options.stateDir, mode: 'fresh',
      permissions: options.permissions, modeId, requireMode: true,
      permissionMode: { fleetMode: options.permissionMode.fleetMode, nativeMode: modeId },
      permissionTimeoutMs: 50_000,
      mcpServers: hermesMcpServers(role, env),
      scrubObsoleteOursAutostart: true,
      validateStartupResponse: async (initialized, created) => {
        await this.checks!.validateArtifact(initialized);
        if (typeof created.models?.currentModelId !== 'string'
            || created.models.currentModelId !== expectedModelId)
          throw new Error('Hermes fresh-session model/provider report does not match the Brain model and provisioned provider');
      },
      ...(role.monitor?.mode === 'fleet' && role.monitor.stall_recovery ? {
        stallRecovery: { timeoutMs: role.monitor.stall_timeout_ms },
      } : {}),
      log: options.log,
    });
  }
}
