import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import {
  loadConfig, NOTIFY_EVENT_TYPES, resolveMonitorConfig, resolveRoleModel,
  resolvePermissions, ROLE_NAME_RE, validateMonitorConfig,
  type CommonPermissions, type MonitorConfig, type MonitorInterrupt, type NotifyEventType,
} from '../config.js';
import {
  daemonIdentityProvisioner,
  type CreationCoreStage, type CreationDeps, type IdentityProvisioner,
} from '../creation.js';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import {
  buildRoleConfig, spawnPermanent, spawnTemp, validateSpawnOpts,
  type SpawnOpts, type SupervisorLauncher,
} from '../spawn.js';
import type { OpsDeps } from '../ops.js';
import { FleetError, normalizeError } from './errors.js';
import {
  claudeModelCatalog, codexModelCatalog, type HarnessModelCatalog, type HarnessModelOption,
} from './model-catalog.js';

export interface CreateRoleSessionRequest {
  name: string;
  harness: 'codex' | 'claude-code';
  /** null means the selected harness's own default; web blank fields send null. */
  model?: string | null;
  reasoningEffort?: string | null;
  session: 'acp' | 'tmux';
  cwd?: string;
  lifetime: 'permanent' | 'temporary';
  mission?: string;
  coordinator?: string;
  permissions: CommonPermissions;
  bio?: string;
  persona?: string;
  monitor?: WebCreationMonitor;
  openAfterCreate: boolean;
  highRiskAcknowledged?: boolean;
  reuseExistingIdentityAcknowledged?: boolean;
  unverifiedIdentityAcknowledged?: boolean;
}

export type WebCreationMonitor =
  | { mode: 'native' }
  | {
    mode: 'fleet'; interrupt: MonitorInterrupt; wake_sources: NotifyEventType[];
    batch_ms: number; inject: 'notification';
  };

export interface CreationCapabilities {
  available: boolean;
  reasons: string[];
  harnesses: Array<{
    id: 'codex' | 'claude-code'; available: boolean;
    sessions: Array<'acp' | 'tmux'>; defaultModel?: string; models: string[];
    modelOptions: HarnessModelOption[]; catalogSource: string; customModelAllowed: true;
    warnings: string[];
  }>;
  lifetimes: Array<'permanent' | 'temporary'>;
  identityBootstrap: {
    mode: 'current-fleet-first-boot';
    existingIdentity: IdentityPreflight;
    bindingEvidence: 'not-structured';
    warnings: string[];
  };
  safePermissionSchemaVersion: 1;
  monitor: {
    modes: Array<'fleet' | 'native'>;
    wakeSources: NotifyEventType[];
    injectModes: ['notification'];
    defaults: MonitorConfig;
  };
}

export type IdentityPreflight = 'verified' | 'missing' | 'unknown';

export interface CreationPreview {
  request: CreateRoleSessionRequest;
  effective: {
    name: string; identity: string; harness: string; session: 'acp' | 'tmux';
    model?: string; reasoningEffort?: string; cwd?: string; lifetime: 'permanent' | 'temporary';
    permissions: CommonPermissions;
    monitor: MonitorConfig;
  };
  provenance: Record<string, 'request' | 'fleet-default' | 'built-in'>;
  warnings: string[];
  prerequisites: string[];
  identityBootstrap: {
    existingIdentity: IdentityPreflight;
    derivedIdentity: string;
    mode: 'current-fleet-first-boot';
    bindingEvidence: 'not-structured';
  };
  previewHash: string;
}

export type CreationStage =
  | 'validating' | 'reserving' | 'checking_identity' | 'writing_role'
  | 'registering_supervisor' | 'starting_temp' | 'launched'
  | 'identity_bootstrap_pending' | 'waiting_for_session'
  | 'session_reachable' | 'attention' | 'launched_unconfirmed'
  | 'failed' | 'rollback_incomplete';

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
  identityCheck?: IdentityPreflight;
  identityBindingEvidence: 'not-structured';
  /** Hash only; the browser's raw idempotency key is never persisted. */
  idempotencyHash?: string;
}

export interface RoleCreationServiceOptions {
  configPath?: string;
  ops: OpsDeps;
  binPath: string;
  /** Test seam for today's authenticated GET /identities existence check. */
  identityProvisioner?: IdentityProvisioner;
  tempLauncher?: SupervisorLauncher;
  allowedCwdRoots?: string[];
  journalDir?: string;
  probeReady?: (name: string, session: 'acp' | 'tmux') => Promise<'ready' | 'attention' | 'unknown'>;
  onProgress?: (action: CreationAction) => void;
  modelCatalogs?: Partial<Record<'codex' | 'claude-code', () => HarnessModelCatalog>>;
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
  private readonly identityProvisioner: IdentityProvisioner;

  constructor(private readonly options: RoleCreationServiceOptions) {
    this.journalDir = options.journalDir ?? `${stateRoot()}/web/creation-actions`;
    mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    this.identityProvisioner = options.identityProvisioner ?? daemonIdentityProvisioner();
    this.restore();
  }

  async capabilities(): Promise<CreationCapabilities> {
    const reasons: string[] = [];
    let defaults: Record<string, unknown> = {};
    let roles: ReturnType<typeof loadConfig>['roles'] = [];
    try {
      const config = loadConfig(this.options.configPath);
      defaults = config.defaults;
      roles = config.roles;
    }
    catch (error) { reasons.push(`configuration is invalid: ${(error as Error).message}`); }
    const modelsFor = (harness: 'codex' | 'claude-code', catalog: HarnessModelCatalog) => {
      const configured = roles.filter(role => role.harness === harness)
        .flatMap(role => [role.model, ...(role.model_chain ?? [])])
        .filter((model): model is string => Boolean(model));
      const inherited = resolveRoleModel(undefined, harness, defaults);
      const configuredOptions: HarnessModelOption[] = [...new Set([...(inherited ? [inherited] : []), ...configured])]
        .filter(id => !catalog.models.some(model => model.id === id))
        .map(id => ({ id, label: `${id} (configured)`, reasoningEfforts: [], source: 'fleet-config' as const }));
      const modelOptions = [...configuredOptions, ...catalog.models];
      return { modelOptions, models: modelOptions.map(model => model.id) };
    };
    const codexCatalog = this.options.modelCatalogs?.codex?.() ?? codexModelCatalog();
    const claudeCatalog = this.options.modelCatalogs?.['claude-code']?.() ?? claudeModelCatalog();
    const codexModels = modelsFor('codex', codexCatalog);
    const claudeModels = modelsFor('claude-code', claudeCatalog);
    return {
      available: reasons.length === 0,
      reasons,
      harnesses: [
        {
          id: 'codex', available: true, sessions: ['acp', 'tmux'],
          defaultModel: resolveRoleModel(undefined, 'codex', defaults),
          ...codexModels, catalogSource: 'codex-runtime-catalog', customModelAllowed: true,
          warnings: codexCatalog.warnings,
        },
        {
          id: 'claude-code', available: true, sessions: ['acp', 'tmux'],
          defaultModel: resolveRoleModel(undefined, 'claude-code', defaults),
          ...claudeModels, catalogSource: 'claude-adapter-2.1', customModelAllowed: true,
          warnings: claudeCatalog.warnings,
        },
      ],
      lifetimes: ['permanent', 'temporary'],
      identityBootstrap: {
        mode: 'current-fleet-first-boot',
        existingIdentity: 'unknown',
        bindingEvidence: 'not-structured',
        warnings: [
          'Identity binding is completed by the new harness from its generated first-boot briefing.',
        ],
      },
      safePermissionSchemaVersion: 1,
      monitor: {
        modes: ['fleet', 'native'], wakeSources: [...NOTIFY_EVENT_TYPES],
        injectModes: ['notification'],
        defaults: resolveMonitorConfig(defaults.monitor, undefined),
      },
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
      name: request.name, identity: request.name,
      harness: request.harness ?? (defaults.harness as string | undefined) ?? 'claude-code',
      session: request.session ?? (defaults.session as 'acp' | 'tmux' | undefined) ?? 'tmux',
      model: resolveRoleModel(request.model, request.harness, defaults),
      reasoningEffort: request.reasoningEffort ?? undefined,
      cwd, lifetime: request.lifetime,
      permissions: resolvePermissions(defaults.permissions, request.permissions),
      monitor: resolveMonitorConfig(defaults.monitor, request.monitor),
    };
    const warnings: string[] = [];
    if (request.permissions.approval === 'allow')
      warnings.push(effective.harness === 'codex' && effective.session === 'acp'
        ? 'approval=allow maps to elevated Codex ACP agent-full-access and widens the native sandbox to danger-full-access'
        : 'approval=allow maps to an elevated native permission mode');
    if (request.permissions.filesystem === 'unrestricted')
      warnings.push('filesystem=unrestricted grants access outside the workspace');
    if (request.permissions.unattended === 'wait')
      warnings.push('unattended permission requests may hold until a controller attaches');
    if (request.lifetime === 'temporary')
      warnings.push('temporary sessions are gone on exit or reboot');
    const existingIdentity = await this.checkIdentity(request.name);
    if (existingIdentity === 'verified')
      warnings.push(`local identity '${request.name}' already exists and will be reused`);
    else if (existingIdentity === 'missing')
      warnings.push(`identity '${request.name}' will be created and bound by the harness on first boot`);
    else
      warnings.push('identity existence could not be verified; first-boot creation may be required');
    if (warnings.some(warning => /elevated|outside/.test(warning)) && !request.highRiskAcknowledged)
      throw new FleetError('invalid_request', 'high-risk permissions require explicit acknowledgment');
    const capabilities = await this.capabilities();
    const prerequisites = [...capabilities.reasons];
    if (existingIdentity === 'verified' && !request.reuseExistingIdentityAcknowledged)
      prerequisites.push('confirm reuse of the existing local identity');
    if (existingIdentity === 'unknown' && !request.unverifiedIdentityAcknowledged)
      prerequisites.push('confirm creation with an unverified identity preflight');
    const provenance = {
      harness: 'request', session: 'request', identity: 'built-in',
      model: request.model !== undefined ? 'request'
        : resolveRoleModel(undefined, request.harness, defaults) ? 'fleet-default' : 'built-in',
      cwd: request.cwd ? 'request' : 'built-in', permissions: 'request',
      monitor: request.monitor ? 'request' : defaults.monitor ? 'fleet-default' : 'built-in',
    } as const;
    const fingerprint = this.configFingerprint(cfg.files);
    const identityBootstrap = {
      existingIdentity, derivedIdentity: request.name,
      mode: 'current-fleet-first-boot' as const,
      bindingEvidence: 'not-structured' as const,
    };
    const previewHash = hash({ request, effective, identityBootstrap, fingerprint });
    return {
      request, effective, provenance, warnings, prerequisites,
      identityBootstrap, previewHash,
    };
  }

  async create(
    input: CreateRoleSessionRequest, previewHash: string, idempotencyKey: string, browserSession: string,
  ): Promise<CreationAction> {
    if (!/^[A-Za-z0-9_-]{22,256}$/.test(idempotencyKey))
      throw new FleetError('invalid_request', 'Idempotency-Key must contain at least 128 bits');
    const requestHash = hash(this.validate(input));
    const key = hash(`${browserSession}\0${idempotencyKey}`);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new FleetError('idempotency_conflict', 'Idempotency-Key was already used for another request');
      return this.actions.get(existing.actionId)!;
    }
    const preview = await this.preview(input);
    if (preview.previewHash !== previewHash)
      throw new FleetError('stale_state', 'preview is stale; review the effective plan again');
    if (preview.prerequisites.length)
      throw new FleetError('prerequisite_unavailable', preview.prerequisites.join('; '));
    const capabilities = await this.capabilities();
    if (!capabilities.available)
      throw new FleetError('prerequisite_unavailable', capabilities.reasons.join('; '));
    if (this.inFlight.has(preview.effective.name))
      throw new FleetError('conflict', `role '${preview.effective.name}' is already being created`);
    const now = new Date().toISOString();
    const action: CreationAction = {
      actionId: randomUUID(), requestHash, roleId: preview.effective.name,
      session: preview.effective.session, lifetime: preview.effective.lifetime,
      state: 'validating', stages: [{ stage: 'validating', at: now }],
      createdAt: now, updatedAt: now,
      idempotencyHash: key,
      identityBindingEvidence: 'not-structured',
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
      const latestIdentity = await this.checkIdentity(action.roleId);
      if (
        latestIdentity === 'verified'
        && preview.identityBootstrap.existingIdentity !== 'verified'
        && !preview.request.reuseExistingIdentityAcknowledged
      ) {
        throw new FleetError(
          'stale_state',
          `identity '${action.roleId}' appeared after preview; review and confirm reuse`,
        );
      }
      const creation: CreationDeps = {
        // Deliberately strip any mutation methods from the test seam. The web
        // uses today's read-only daemon preflight; first-boot owns create/bind.
        identityProvisioner: { exists: name => this.identityProvisioner.exists(name) },
        onStage: (stage, evidence) => this.coreStage(action, stage, evidence),
      };
      if (preview.effective.lifetime === 'permanent') {
        await spawnPermanent(this.spawnOptions(preview.request, action.actionId), this.options.ops, creation);
      } else {
        await spawnTemp(
          this.spawnOptions(preview.request, action.actionId), this.options.binPath,
          this.options.tempLauncher, creation);
      }
      this.stage(action, 'launched', 'launch accepted; readiness not yet confirmed');
      this.stage(
        action, 'identity_bootstrap_pending',
        'the harness must choose or create and bind its identity from the generated briefing',
      );
      this.stage(action, 'waiting_for_session');
      const ready = await this.waitForReady(action.roleId, action.session);
      if (ready === 'ready') {
        action.openPath = action.session === 'acp'
          ? `/roles/${encodeURIComponent(action.roleId)}/activity`
          : `/roles/${encodeURIComponent(action.roleId)}/terminal`;
        this.stage(
          action, 'session_reachable',
          'session is reachable; identity binding has no structured evidence in this version',
        );
      } else if (ready === 'attention') {
        action.openPath = `/roles/${encodeURIComponent(action.roleId)}`;
        this.stage(
          action, 'attention',
          'session evidence needs attention; first-boot identity binding remains unconfirmed',
        );
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
    if (!['codex', 'claude-code'].includes(input.harness))
      throw new FleetError('invalid_request', 'unsupported harness');
    if (!['acp', 'tmux'].includes(input.session))
      throw new FleetError('invalid_request', 'unsupported session backend');
    if (!['permanent', 'temporary'].includes(input.lifetime))
      throw new FleetError('invalid_request', 'unsupported lifetime');
    bounded(input.model ?? undefined, 'model', 128);
    bounded(input.reasoningEffort ?? undefined, 'reasoning effort', 16);
    if (input.reasoningEffort != null && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.reasoningEffort))
      throw new FleetError('invalid_request', 'unsupported reasoning effort');
    bounded(input.mission, 'mission', 4_096);
    bounded(input.coordinator, 'coordinator', 128);
    bounded(input.bio, 'bio', 8_192);
    bounded(input.persona, 'persona', 16_384);
    resolvePermissions(undefined, input.permissions);
    if (input.monitor) {
      const problems = validateMonitorConfig(input.monitor);
      if (problems.length) throw new FleetError('invalid_request', problems.join('; '));
      if ('inject' in input.monitor && input.monitor.inject !== 'notification')
        throw new FleetError('invalid_request', 'web creation supports monitor.inject=notification only');
    }
    return {
      ...input, model: input.model === null ? null : input.model?.trim() || undefined,
      reasoningEffort: input.reasoningEffort === null ? null : input.reasoningEffort?.trim() || undefined,
      mission: input.mission?.trim() || undefined, coordinator: input.coordinator?.trim() || undefined,
      bio: input.bio?.trim() || undefined, persona: input.persona?.trim() || undefined,
      monitor: input.monitor ? structuredClone(input.monitor) : undefined,
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

  private spawnOptions(request: CreateRoleSessionRequest, creationActionId?: string): SpawnOpts {
    return {
      name: request.name, identity: request.name, harness: request.harness,
      model: request.model, session: request.session, cwd: request.cwd,
      reasoningEffort: request.reasoningEffort,
      mission: request.mission, coordinator: request.coordinator,
      approval: request.permissions.approval, filesystem: request.permissions.filesystem,
      unattended: request.permissions.unattended, bio: request.bio, persona: request.persona,
      monitorConfig: request.monitor,
      configPath: this.options.configPath,
      surface: creationActionId ? 'web' : undefined, creationActionId,
    };
  }

  private async checkIdentity(name: string): Promise<IdentityPreflight> {
    try {
      const present = await this.identityProvisioner.exists(name);
      return present === true ? 'verified' : present === false ? 'missing' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private coreStage(
    action: CreationAction, stage: CreationCoreStage,
    evidence?: Record<string, string | boolean>,
  ): void {
    if (stage === 'checking_identity' && evidence?.result) {
      action.identityCheck = evidence.result as IdentityPreflight;
      this.stage(
        action, stage,
        `${evidence.result}; host guarantee ${String(evidence.guarantee ?? 'unverified')}`,
      );
      return;
    }
    this.stage(action, stage);
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
    const previous = action.stages.at(-1);
    if (previous?.stage === stage) {
      previous.at = action.updatedAt;
      previous.detail = detail ?? previous.detail;
    } else {
      action.stages.push({ stage, at: action.updatedAt, detail });
    }
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
          action.identityBindingEvidence ??= 'not-structured';
          if (![
            'session_reachable', 'attention', 'launched_unconfirmed',
            'failed', 'rollback_incomplete',
          ].includes(action.state)) {
            action.state = 'launched_unconfirmed';
            action.updatedAt = new Date().toISOString();
            action.stages.push({
              stage: 'launched_unconfirmed', at: action.updatedAt,
              detail: 'server restarted; artifacts require reconciliation',
            });
          }
          this.actions.set(action.actionId, action);
          if (action.idempotencyHash)
            this.idempotency.set(action.idempotencyHash, {
              requestHash: action.requestHash, actionId: action.actionId,
            });
        } catch { /* isolate corrupt journal entry */ }
      }
    } catch { /* no journal yet */ }
  }
}
