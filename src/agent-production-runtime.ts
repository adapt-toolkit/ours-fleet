import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { ResolvedRole } from './config.js';
import type { CreationPlan } from './application/role-creation-service.js';
import type { IdentityProvisioner, IdentityProvisionProfile } from './creation.js';
import { loadConfigResourceSnapshotFromDocuments } from './config-resource-loader.js';
import { createProductionAgentLaunchComposition } from './agent-production-launch-composition.js';
import { agentRuntimeSessionRequestBindings, type AgentLaunchRequest } from './agent-launch-composition-root.js';
import { readAgentSupervisorHandoff } from './agent-supervisor-handoff.js';
import { readTempAgentSupervisorHandoff } from './temp-agent-supervisor-handoff.js';
import type { PermanentAgentCreationResult, ProductionIngressContext } from './agent-creation-composition-root.js';
import type { AgentCompositionRequest } from './agent-composition-service.js';
import { AgentCompositionError } from './agent-composition-service.js';
import type { SessionHandle } from './session/types.js';
import type { AcpSessionOptions } from './session/acp.js';
import { effectiveRoleModel } from './model-env.js';
import { runtimeCanonical } from './agent-runtime-record.js';

export interface AgentProductionRuntimeDeps {
  trustedStateRoot: string;
  identityProvisioner: IdentityProvisioner;
  identityProfile?: IdentityProvisionProfile;
  now?: () => number;
}

export interface AgentProductionCreationInput {
  plan: CreationPlan;
  actionId: string;
}

export type AgentProductionCreationResult = PermanentAgentCreationResult | Readonly<{
  state: 'reserved'; agentId: string; generation: number; actionId: string;
  lifetime: 'temporary'; completion: 'deferred';
}>;

export interface AgentProductionSessionInput {
  agentId: string;
  lifetime: 'persistent' | 'temporary';
  session: Omit<AcpSessionOptions, 'argv' | 'env'>;
  cwd: string;
  env: Readonly<Record<string, string>>;
}
export interface AgentProductionRoleInput {
  role: ResolvedRole; lifetime: 'persistent' | 'temporary'; actionId: string;
}

export interface AgentProductionRuntime {
  create(input: Readonly<AgentProductionCreationInput>): Promise<AgentProductionCreationResult>;
  createRole(input: Readonly<AgentProductionRoleInput>): Promise<AgentProductionCreationResult>;
  launch(input: Readonly<AgentProductionSessionInput>): Promise<SessionHandle>;
}

const digest = (value: unknown): string => `sha256:${createHash('sha256')
  .update(runtimeCanonical(value)).digest('hex')}`;

function roleDocument(role: ResolvedRole): Buffer {
  return Buffer.from(stringify({ kind: 'Role', version: 1, id: role.name, spec: {
    ...(role.bio === undefined ? {} : { bio: role.bio }),
    ...(role.persona === undefined ? {} : { persona: role.persona }),
    ...(role.mission === undefined ? {} : { mission: role.mission }),
  } }));
}

function productionAdmission(role: ResolvedRole, lifetime: 'persistent' | 'temporary', actionId: string,
  now: number): Readonly<{
  context: ProductionIngressContext;
  request: Omit<AgentCompositionRequest, 'callerEvidence'>;
}> {
  if (role.session !== 'acp') throw new TypeError('production Agent runtime requires ACP');
  const root = resolve('/agent-production-runtime', role.name);
  const snapshot = loadConfigResourceSnapshotFromDocuments({
    bootstrapFile: resolve(root, 'fleet.yaml'), configDir: resolve(root, 'fleet.conf.d'),
    bootstrapBytes: Buffer.from('schema_version: 2\nconfig_dir: fleet.conf.d\npolicy: {}\n'),
    documents: [{ relativePath: `roles.d/${role.name}.yaml`, bytes: roleDocument(role) }],
  });
  const operation = Object.freeze({ id: actionId, type: 'agent.create',
    resourceScope: `agents/${role.name}` });
  const authorizationRevision = digest({ operation, snapshot: snapshot.digest, role: role.name });
  const context = Object.freeze({ operation, authorizationRevision, snapshot,
    snapshotRevision: snapshot.digest, issuedAt: now });
  const effort = typeof role.harness_options?.effort === 'string'
    ? role.harness_options.effort : 'medium';
  const request = Object.freeze({ source: Object.freeze({ kind: 'runtime_composition' as const,
    agentId: role.name, role: role.name, identity: Object.freeze({ name: role.identity,
      ownership: lifetime === 'temporary' ? 'create_temporary' as const : 'create_persistent' as const }),
    lifecycle: lifetime, brain: Object.freeze({ harness: role.harness,
      model: effectiveRoleModel(role) ?? 'default', effort, session: 'acp' }),
    permissions: Object.freeze({ approval: role.permissions.approval === 'deny'
      ? 'ask' as const : role.permissions.approval, filesystem: role.permissions.filesystem,
    unattended: role.permissions.unattended }),
    ...(!role.cwd ? {} : { runtime: Object.freeze({ scheduling: Object.freeze({ cwd: role.cwd }) }) }),
  }) });
  return Object.freeze({ context, request });
}

/** Product facade: callers see Agent create/launch only; artifact authorities remain private. */
export function createAgentProductionRuntime(deps: AgentProductionRuntimeDeps): AgentProductionRuntime {
  const now = deps.now ?? Date.now;
  const composed = createProductionAgentLaunchComposition({ trustedStateRoot: deps.trustedStateRoot,
    identityProvisioner: deps.identityProvisioner, identityProfile: deps.identityProfile ?? {}, now });
  const createRole = async (input: Readonly<AgentProductionRoleInput>): Promise<AgentProductionCreationResult> => {
      if (input.lifetime === 'persistent') {
        const path = join(resolve(deps.trustedStateRoot), 'agents',
          Buffer.from(input.role.name).toString('base64url'), 'active.json');
        let activeExists = false;
        try { lstatSync(path); activeExists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (activeExists) {
          const active = readAgentSupervisorHandoff(deps.trustedStateRoot, input.role.name);
          if (active.actionId !== input.actionId) throw new AgentCompositionError('invalid_request');
          return composed.creation.root.resumePermanent(active.agentId, active.actionId);
        }
      }
      const admission = productionAdmission(input.role, input.lifetime, input.actionId, now());
      const callerEvidence = composed.creation.ingress.direct(admission.context);
      const request = Object.freeze({ ...admission.request, callerEvidence });
      if (input.lifetime === 'temporary') {
        const reserved = await composed.creation.temporary.reserve(request, input.actionId);
        return Object.freeze({ state: 'reserved' as const, agentId: reserved.agentId,
          generation: reserved.generation, actionId: input.actionId, lifetime: 'temporary' as const,
          completion: 'deferred' as const });
      }
      return composed.creation.root.createPermanent(request, input.actionId);
    };
  return Object.freeze({
    create: (input: Readonly<AgentProductionCreationInput>) => createRole({
      role: input.plan.preview.resolvedRole,
      lifetime: input.plan.options.temp ? 'temporary' : 'persistent', actionId: input.actionId }),
    createRole,
    launch: async (input: Readonly<AgentProductionSessionInput>) => {
      const active = input.lifetime === 'temporary'
        ? readTempAgentSupervisorHandoff(deps.trustedStateRoot, input.agentId)
        : readAgentSupervisorHandoff(deps.trustedStateRoot, input.agentId);
      const sessionRequest = agentRuntimeSessionRequestBindings(input.session);
      const sessionRequestId = randomUUID();
      const runtimeLaunchContext = composed.runtimeLaunchContexts.issue({ agentId: active.agentId,
        generation: active.generation, actionId: active.actionId, sessionRequestId, sessionRequest,
        cwd: input.cwd, env: input.env });
      const request: AgentLaunchRequest = Object.freeze({ agentId: input.agentId,
        lifetime: input.lifetime, session: input.session, runtimeLaunchContext, sessionRequestId });
      return composed.launch.launch(request);
    },
  });
}
