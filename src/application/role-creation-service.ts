import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { loadConfig, resolvePermissions, ROLE_NAME_RE, type CommonPermissions } from '../config.js';
import type { CreationDeps, IdentityProvisioner, IdentityRegistry } from '../creation.js';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import {
  buildRoleConfig, spawnPermanent, spawnTemp, validateSpawnOpts,
  type SpawnOpts, type SupervisorLauncher,
} from '../spawn.js';
import type { OpsDeps } from '../ops.js';
import { FleetError, normalizeError } from './errors.js';
import type { IdentityProviderCapability } from '../infrastructure/daemon-identity.js';

export interface CreateRoleSessionRequest {
  name: string;
  identity?: string;
  harness: 'codex' | 'claude-code';
  model?: string;
  session: 'acp' | 'tmux';
  cwd?: string;
  lifetime: 'permanent' | 'temporary';
  mission?: string;
  coordinator?: string;
  permissions: CommonPermissions;
  bio?: string;
  persona?: string;
  openAfterCreate: boolean;
  highRiskAcknowledged?: boolean;
}

export interface CreationCapabilities {
  available: boolean;
  reasons: string[];
  harnesses: Array<{
    id: 'codex' | 'claude-code'; available: boolean;
    sessions: Array<'acp' | 'tmux'>; defaultModel?: string; warnings: string[];
  }>;
  lifetimes: Array<'permanent' | 'temporary'>;
  identityProvisioning: 'atomic' | 'unavailable' | 'incompatible';
  safePermissionSchemaVersion: 1;
}

export interface CreationPreview {
  request: CreateRoleSessionRequest;
  effective: {
    name: string; identity: string; harness: string; session: 'acp' | 'tmux';
    model?: string; cwd?: string; lifetime: 'permanent' | 'temporary';
    permissions: CommonPermissions;
  };
  provenance: Record<string, 'request' | 'fleet-default' | 'built-in'>;
  warnings: string[];
  prerequisites: string[];
  previewHash: string;
}

export type CreationStage =
  | 'validating' | 'reserving' | 'provisioning_identity' | 'writing_role'
  | 'registering_supervisor' | 'starting_temp' | 'launched' | 'waiting_for_session'
  | 'ready' | 'attention' | 'launched_unconfirmed' | 'failed' | 'rollback_incomplete';

export interface CreationAction {
  actionId: string;
  requestHash: string;
  roleId: string;
  session: 'acp' | 'tmux';
  lifetime: 'permanent' | 'temporary';
  state: CreationStage;
  stages: Array<{ stage: CreationStage; at: string; detail?: string }>;
  createdAt: string;
  updatedAt: string;
  error?: ReturnType<FleetError['toJSON']>;
  openPath?: string;
}

export interface AtomicCreationIdentityProvider extends IdentityProvisioner, IdentityRegistry {
  capability(): Promise<IdentityProviderCapability>;
  reserve(name: string): Promise<boolean>;
  release(name: string): Promise<void>;
}

export interface RoleCreationServiceOptions {
  configPath?: string;
  ops: OpsDeps;
  binPath: string;
  identityProvider?: AtomicCreationIdentityProvider;
  tempLauncher?: SupervisorLauncher;
  allowedCwdRoots?: string[];
  journalDir?: string;
  probeReady?: (name: string, session: 'acp' | 'tmux') => Promise<'ready' | 'attention' | 'unknown'>;
  onProgress?: (action: CreationAction) => void;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

function bounded(value: string | undefined, name: string, max: number): void {
  if (value === undefined) return;
  if (value.length > max || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new FleetError('invalid_request', `${name} is invalid or exceeds ${max} characters`);
}

export class RoleCreationService {
  private readonly actions = new Map<string, CreationAction>();
  private readonly idempotency = new Map<string, { requestHash: string; actionId: string }>();
  private readonly inFlight = new Set<string>();
  private readonly journalDir: string;

  constructor(private readonly options: RoleCreationServiceOptions) {
    this.journalDir = options.journalDir ?? `${stateRoot()}/web/creation-actions`;
    mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    this.restore();
  }

  async capabilities(): Promise<CreationCapabilities> {
    const reasons: string[] = [];
    let identityProvisioning: CreationCapabilities['identityProvisioning'] = 'unavailable';
    if (this.options.identityProvider) {
      const capability = await this.options.identityProvider.capability();
      identityProvisioning = capability.available ? 'atomic'
        : capability.version === undefined ? 'unavailable' : 'incompatible';
      if (!capability.available) reasons.push(capability.reason ?? 'atomic identity provisioning unavailable');
    } else reasons.push('atomic identity provisioning is not configured');
    try { loadConfig(this.options.configPath); }
    catch (error) { reasons.push(`configuration is invalid: ${(error as Error).message}`); }
    return {
      available: reasons.length === 0,
      reasons,
      harnesses: [
        { id: 'codex', available: true, sessions: ['acp', 'tmux'], warnings: [] },
        { id: 'claude-code', available: true, sessions: ['acp', 'tmux'], warnings: [] },
      ],
      lifetimes: ['permanent', 'temporary'],
      identityProvisioning,
      safePermissionSchemaVersion: 1,
    };
  }

  async preview(input: CreateRoleSessionRequest): Promise<CreationPreview> {
    const request = this.validate(input);
    const cfg = loadConfig(this.options.configPath);
    const defaults = cfg.defaults;
    const opts = this.spawnOptions(request);
    validateSpawnOpts(opts);
    buildRoleConfig(opts, defaults.harness as string | undefined);
    const cwd = request.cwd ? this.resolveCwd(request.cwd) : undefined;
    const effective = {
      name: request.name, identity: request.identity ?? request.name,
      harness: request.harness ?? (defaults.harness as string | undefined) ?? 'claude-code',
      session: request.session ?? (defaults.session as 'acp' | 'tmux' | undefined) ?? 'tmux',
      model: request.model?.trim() || (defaults.model as string | undefined),
      cwd, lifetime: request.lifetime,
      permissions: resolvePermissions(defaults.permissions, request.permissions),
    };
    const warnings: string[] = [];
    if (request.permissions.approval === 'allow')
      warnings.push('approval=allow maps to an elevated native permission mode');
    if (request.permissions.filesystem === 'unrestricted')
      warnings.push('filesystem=unrestricted grants access outside the workspace');
    if (request.permissions.unattended === 'wait')
      warnings.push('unattended permission requests may hold until a controller attaches');
    if (request.lifetime === 'temporary')
      warnings.push('temporary sessions are gone on exit or reboot');
    if (warnings.some(warning => /elevated|outside/.test(warning)) && !request.highRiskAcknowledged)
      throw new FleetError('invalid_request', 'high-risk permissions require explicit acknowledgment');
    const capabilities = await this.capabilities();
    const prerequisites = capabilities.reasons;
    const provenance = {
      harness: 'request', session: 'request', identity: request.identity ? 'request' : 'built-in',
      model: request.model ? 'request' : defaults.model ? 'fleet-default' : 'built-in',
      cwd: request.cwd ? 'request' : 'built-in', permissions: 'request',
    } as const;
    const fingerprint = this.configFingerprint(cfg.files);
    const previewHash = hash({ request, effective, fingerprint });
    return { request, effective, provenance, warnings, prerequisites, previewHash };
  }

  async create(
    input: CreateRoleSessionRequest, previewHash: string, idempotencyKey: string, browserSession: string,
  ): Promise<CreationAction> {
    if (!/^[A-Za-z0-9_-]{22,256}$/.test(idempotencyKey))
      throw new FleetError('invalid_request', 'Idempotency-Key must contain at least 128 bits');
    const preview = await this.preview(input);
    if (preview.previewHash !== previewHash)
      throw new FleetError('stale_state', 'preview is stale; review the effective plan again');
    const capabilities = await this.capabilities();
    if (!capabilities.available)
      throw new FleetError('prerequisite_unavailable', capabilities.reasons.join('; '));
    const requestHash = hash(input);
    const key = `${browserSession}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new FleetError('idempotency_conflict', 'Idempotency-Key was already used for another request');
      return this.actions.get(existing.actionId)!;
    }
    if (this.inFlight.has(preview.effective.name))
      throw new FleetError('conflict', `role '${preview.effective.name}' is already being created`);
    const now = new Date().toISOString();
    const action: CreationAction = {
      actionId: randomUUID(), requestHash, roleId: preview.effective.name,
      session: preview.effective.session, lifetime: preview.effective.lifetime,
      state: 'validating', stages: [{ stage: 'validating', at: now }],
      createdAt: now, updatedAt: now,
    };
    this.idempotency.set(key, { requestHash, actionId: action.actionId });
    this.actions.set(action.actionId, action);
    this.persist(action);
    this.inFlight.add(action.roleId);
    void this.run(action, preview).finally(() => this.inFlight.delete(action.roleId));
    return action;
  }

  get(actionId: string): CreationAction | undefined { return this.actions.get(actionId); }

  private async run(action: CreationAction, preview: CreationPreview): Promise<void> {
    try {
      this.stage(action, 'reserving');
      this.stage(action, 'provisioning_identity');
      const provider = this.options.identityProvider!;
      const creation: CreationDeps = { identityRegistry: provider, identityProvisioner: provider };
      this.stage(action, 'writing_role');
      if (preview.effective.lifetime === 'permanent') {
        this.stage(action, 'registering_supervisor');
        await spawnPermanent(this.spawnOptions(preview.request), this.options.ops, creation);
      } else {
        this.stage(action, 'starting_temp');
        await spawnTemp(
          this.spawnOptions(preview.request), this.options.binPath,
          this.options.tempLauncher, creation);
      }
      this.stage(action, 'launched', 'launch accepted; readiness not yet confirmed');
      this.stage(action, 'waiting_for_session');
      const ready = await this.waitForReady(action.roleId, action.session);
      if (ready === 'ready') {
        action.openPath = action.session === 'acp'
          ? `/roles/${encodeURIComponent(action.roleId)}/activity`
          : `/roles/${encodeURIComponent(action.roleId)}/terminal`;
        this.stage(action, 'ready');
      } else if (ready === 'attention') {
        action.openPath = `/roles/${encodeURIComponent(action.roleId)}`;
        this.stage(action, 'attention');
      } else {
        action.openPath = `/roles/${encodeURIComponent(action.roleId)}`;
        this.stage(action, 'launched_unconfirmed', 'launch committed; session readiness timed out');
      }
    } catch (error) {
      const fleetError = normalizeError(error);
      const rollbackIncomplete = /rollback also failed/i.test(fleetError.message);
      action.error = new FleetError(
        rollbackIncomplete ? 'rollback_incomplete' : fleetError.code,
        fleetError.message, { retryable: fleetError.retryable, provesOffline: fleetError.provesOffline },
      ).toJSON();
      this.stage(action, rollbackIncomplete ? 'rollback_incomplete' : 'failed');
    }
  }

  private async waitForReady(
    role: string, session: 'acp' | 'tmux',
  ): Promise<'ready' | 'attention' | 'unknown'> {
    if (!this.options.probeReady) return 'unknown';
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await this.options.probeReady(role, session).catch(() => 'unknown' as const);
      if (state !== 'unknown') return state;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return 'unknown';
  }

  private validate(input: CreateRoleSessionRequest): CreateRoleSessionRequest {
    if (!ROLE_NAME_RE.test(input.name)) throw new FleetError('invalid_request', 'invalid role name');
    if (input.identity && !ROLE_NAME_RE.test(input.identity))
      throw new FleetError('invalid_request', 'invalid identity name');
    if (!['codex', 'claude-code'].includes(input.harness))
      throw new FleetError('invalid_request', 'unsupported harness');
    if (!['acp', 'tmux'].includes(input.session))
      throw new FleetError('invalid_request', 'unsupported session backend');
    if (!['permanent', 'temporary'].includes(input.lifetime))
      throw new FleetError('invalid_request', 'unsupported lifetime');
    bounded(input.model, 'model', 128);
    bounded(input.mission, 'mission', 4_096);
    bounded(input.coordinator, 'coordinator', 128);
    bounded(input.bio, 'bio', 8_192);
    bounded(input.persona, 'persona', 16_384);
    resolvePermissions(undefined, input.permissions);
    return {
      ...input, identity: input.identity || undefined, model: input.model?.trim() || undefined,
      mission: input.mission?.trim() || undefined, coordinator: input.coordinator?.trim() || undefined,
      bio: input.bio?.trim() || undefined, persona: input.persona?.trim() || undefined,
    };
  }

  private resolveCwd(path: string): string {
    if (!isAbsolute(path)) throw new FleetError('invalid_request', 'cwd must be absolute');
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(path);
      if (!statSync(canonicalPath).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      throw new FleetError('invalid_request', `cwd must be an existing directory: ${(error as Error).message}`);
    }
    const roots = this.options.allowedCwdRoots ?? [realpathSync(process.env.OURS_FLEET_HOME ?? process.cwd())];
    if (!roots.some(root => {
      const rel = relative(realpathSync(root), canonicalPath);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    })) throw new FleetError('forbidden', 'cwd is outside configured roots');
    return canonicalPath;
  }

  private spawnOptions(request: CreateRoleSessionRequest): SpawnOpts {
    return {
      name: request.name, identity: request.identity, harness: request.harness,
      model: request.model, session: request.session, cwd: request.cwd,
      mission: request.mission, coordinator: request.coordinator,
      approval: request.permissions.approval, filesystem: request.permissions.filesystem,
      unattended: request.permissions.unattended, bio: request.bio, persona: request.persona,
      configPath: this.options.configPath,
    };
  }

  private configFingerprint(files: string[]): Array<{ file: string; mtimeMs: number; size: number }> {
    return files.map(file => {
      const stat = statSync(file);
      return { file, mtimeMs: stat.mtimeMs, size: stat.size };
    });
  }

  private stage(action: CreationAction, stage: CreationStage, detail?: string): void {
    action.state = stage;
    action.updatedAt = new Date().toISOString();
    action.stages.push({ stage, at: action.updatedAt, detail });
    this.persist(action);
    this.options.onProgress?.(structuredClone(action));
  }

  private persist(action: CreationAction): void {
    replaceFileAtomically(
      `${this.journalDir}/${action.actionId}.json`,
      JSON.stringify(action, null, 2) + '\n', 0o600);
  }

  private restore(): void {
    try {
      for (const file of readdirSync(this.journalDir).filter(name => /^[0-9a-f-]+\.json$/.test(name))) {
        try {
          const action = JSON.parse(readFileSync(`${this.journalDir}/${file}`, 'utf8')) as CreationAction;
          if (!['ready', 'attention', 'launched_unconfirmed', 'failed', 'rollback_incomplete'].includes(action.state)) {
            action.state = 'launched_unconfirmed';
            action.updatedAt = new Date().toISOString();
            action.stages.push({
              stage: 'launched_unconfirmed', at: action.updatedAt,
              detail: 'server restarted; artifacts require reconciliation',
            });
          }
          this.actions.set(action.actionId, action);
        } catch { /* isolate corrupt journal entry */ }
      }
    } catch { /* no journal yet */ }
  }
}
