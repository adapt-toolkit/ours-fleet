import { spawn as spawnChild } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { agentDir, fleetDDir } from './paths.js';
import { validateIsolationConfig } from './isolation/policy.js';
import type { IsolationConfig } from './isolation/types.js';
import {
  loadConfig, resolveAuthProxy, resolveModelChain, resolveMonitorConfig, resolveOwnerChannelConfig,
  resolvePermissions,
  resolveRoleModel, resolveWorklogPolicy, validateMonitorConfig,
  type ApprovalMode, type FilesystemMode, type ResolvedRole, type RoleConfig,
  type CommonPermissions, type MonitorConfig, type SessionBackendId, type UnattendedMode,
  type RoomMemberStartup,
} from './config.js';
import { resolveRoleModelEnv } from './model-env.js';
import { applyRole, up, type OpsDeps } from './ops.js';
import { START_STAGGER_FILE } from './runner.js';
import {
  buildProvenance, daemonIdentityProvisioner,
  ensureIdentity, provenanceOf,
  withCreationTransaction, writeProvenance, writeRoleFile,
  type CreationDeps, type CreationProvenance, type CreationTransaction,
  type ProvenanceEntry,
} from './creation.js';
import { VERSION } from './version.js';
import './harness/claude-code.js';
import './harness/codex.js';
import { getAdapter } from './harness/registry.js';
import {
  archiveTempState, makeTempSupervisorLauncher, prepareTempSupervisor, reclaimStaleTempState,
  type SupervisorLauncher,
} from './temp-lifecycle.js';

/**
 * The provenance record written by the most recent spawn in this process, so
 * the CLI can print the same summary it persisted rather than rebuilding it.
 */
export let lastProvenance: CreationProvenance | undefined;

export interface SpawnOpts {
  name: string;
  temp?: boolean;
  harness?: string;
  session?: SessionBackendId;
  mission?: string;
  missionFile?: string;
  identity?: string;
  cwd?: string;
  coordinator?: string;
  /** null explicitly selects the harness default; undefined retains normal fleet inheritance. */
  model?: string | null;
  permissionMode?: string;
  approval?: ApprovalMode;
  filesystem?: FilesystemMode;
  unattended?: UnattendedMode;
  sandbox?: string;
  profile?: string;
  launcher?: string;
  search?: boolean;
  codexConfig?: Record<string, string | number | boolean>;
  reasoningEffort?: string | null;
  addDirs?: string[];
  monitor?: boolean;
  /** Typed external monitor configuration used by trusted creation surfaces. */
  monitorConfig?: Partial<MonitorConfig>;
  bioFile?: string;
  personaFile?: string;
  /** Inline profile values for trusted typed callers such as the local web service. */
  bio?: string;
  persona?: string;
  /** Internal, non-sensitive provenance correlation for typed presentation layers. */
  surface?: 'cli' | 'web' | 'agent';
  creationActionId?: string;
  /** Set only by a live role supervisor after a role-scoped proxy request. */
  callerRole?: string;
  /** Trusted Fleet-internal first-boot payload for a Cowork room member. */
  roomMemberStartup?: RoomMemberStartup;
  /** Internal provenance labels for values filled by the caller's supervisor. */
  inheritedFromCaller?: string[];
  /**
   * Path to a file holding exactly the existing `isolation:` mapping — the same
   * schema fleet.yaml uses, not a second policy language. The ONE new operator
   * input in this release.
   */
  isolationFile?: string;
  overseeInterval?: string;
  configPath?: string;
  dryRun?: boolean;
  json?: boolean;
}

export function profileValues(o: SpawnOpts): { bio?: string; persona?: string } {
  if (o.bio !== undefined && o.bioFile)
    throw new Error('bio and bioFile are mutually exclusive');
  if (o.persona !== undefined && o.personaFile)
    throw new Error('persona and personaFile are mutually exclusive');
  return {
    bio: o.bio !== undefined ? o.bio.trim()
      : o.bioFile ? readFileSync(o.bioFile, 'utf8').trim() : undefined,
    persona: o.persona !== undefined ? o.persona.trim()
      : o.personaFile ? readFileSync(o.personaFile, 'utf8').trim() : undefined,
  };
}

/** Pure option-to-role mapping shared by CLI and application services. */
export function buildRoleConfig(o: SpawnOpts, defaultHarness?: string): RoleConfig {
  const r: RoleConfig = {};
  if (o.harness) r.harness = o.harness;
  if (o.session) r.session = o.session;
  if (o.identity) r.identity = o.identity;
  if (o.cwd) r.cwd = o.cwd;
  if (o.coordinator) r.coordinator = o.coordinator;
  if (o.missionFile) r.mission = readMissionFile(o.missionFile);
  else if (o.mission !== undefined) r.mission = o.mission;
  if (o.model === null) r.model = null;
  else if (o.model?.trim()) r.model = o.model.trim();
  const harness = o.harness ?? defaultHarness;
  const harnessOptions: Record<string, unknown> = {};
  if (o.permissionMode) harnessOptions[harness === 'claude-code' ? 'permission_mode' : 'approval'] = o.permissionMode;
  if (o.sandbox) harnessOptions.sandbox = o.sandbox;
  if (o.profile) harnessOptions.profile = o.profile;
  if (o.launcher) harnessOptions.launcher = o.launcher;
  if (o.search === true) harnessOptions.search = true;
  const codexConfig = { ...(o.codexConfig ?? {}) };
  if (o.reasoningEffort && harness === 'codex') codexConfig.model_reasoning_effort = o.reasoningEffort;
  if (Object.keys(codexConfig).length) harnessOptions.config = codexConfig;
  if (o.reasoningEffort && harness === 'claude-code') harnessOptions.effort = o.reasoningEffort;
  if (o.addDirs?.length) harnessOptions.add_dirs = o.addDirs;
  if (o.monitor === true) harnessOptions.monitor = true;
  if (Object.keys(harnessOptions).length) r.harness_options = harnessOptions;
  if (o.approval || o.filesystem || o.unattended) {
    r.permissions = {
      ...(o.approval ? { approval: o.approval } : {}),
      ...(o.filesystem ? { filesystem: o.filesystem } : {}),
      ...(o.unattended ? { unattended: o.unattended } : {}),
    };
  }
  const profile = profileValues(o);
  if (profile.bio) r.bio = profile.bio;
  if (profile.persona) r.persona = profile.persona;
  if (o.isolationFile) r.isolation = readIsolationFile(o.isolationFile);
  if (o.monitorConfig) r.monitor = { ...o.monitorConfig };
  return r;
}

/**
 * Read and validate an `--isolation-file`. The file is the existing
 * `isolation:` mapping and nothing else — the same schema, the same validator
 * (`validateIsolationConfig`), so a policy written here cannot mean something
 * different from the identical block in fleet.yaml.
 *
 * Called BEFORE the creation transaction reserves anything: an invalid file
 * must fail before any artifact exists.
 */
export function readIsolationFile(path: string): IsolationConfig {
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8')); }
  catch (e) {
    throw new Error(`--isolation-file ${path}: ${(e as Error).message}`);
  }
  // A file holding only comments parses to null; treat it as an empty policy,
  // which is a meaningful request ("sandbox me with defaults").
  const cfg = (raw ?? {}) as IsolationConfig;
  const problems = validateIsolationConfig(cfg);
  if (problems.length) throw new Error(`--isolation-file ${path}: ${problems.join('; ')}`);
  return cfg;
}

export function validateSpawnOpts(o: SpawnOpts): void {
  if (o.mission !== undefined && o.missionFile)
    throw new Error('--mission and --mission-file are mutually exclusive');
  if ((o.session as string | undefined) === 'tmux')
    throw new Error("invalid --session 'tmux'; tmux is no longer supported; use --session acp");
  if (o.session && o.session !== 'acp')
    throw new Error(`invalid --session '${o.session}'; allowed: acp`);
  if (o.approval && !['ask', 'auto', 'allow', 'deny'].includes(o.approval))
    throw new Error(
      `invalid --approval '${o.approval}'; allowed: ask, auto, allow (deprecated alias: deny)`);
  if (o.filesystem && !['read-only', 'workspace', 'unrestricted'].includes(o.filesystem))
    throw new Error(
      `invalid --filesystem '${o.filesystem}'; allowed: read-only, workspace, unrestricted`);
  if (o.unattended && !['deny', 'wait'].includes(o.unattended))
    throw new Error(`invalid --unattended '${o.unattended}'; allowed: deny, wait`);
  if (!/^[A-Za-z0-9_-]+$/.test(o.name))
    throw new Error(`invalid role name '${o.name}'`);
  if (o.identity && !/^[A-Za-z0-9_-]+$/.test(o.identity))
    throw new Error(`invalid identity name '${o.identity}'`);
  if (o.model && (o.model.length > 128 || /[\0-\x1f\x7f]/.test(o.model)))
    throw new Error('model must be printable and at most 128 characters');
  if (o.monitorConfig) {
    const problems = validateMonitorConfig(o.monitorConfig);
    if (problems.length) throw new Error(problems.join('; '));
  }
}

/** Read mission text without trimming or newline rewriting. */
export function readMissionFile(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (e) { throw new Error(`--mission-file ${path}: ${(e as Error).message}`); }
}

/**
 * Reject names that are already USED. This is a precondition, not a claim: it
 * runs INSIDE the creation transaction, after both names are reserved, so the
 * gap between checking and creating that let two spawns both succeed is closed
 * by the reservation rather than by this function.
 */
function assertNameFree(o: SpawnOpts): void {
  const cfg = loadConfig(o.configPath);
  if (cfg.roles.some(r => r.name === o.name))
    throw new Error(`role '${o.name}' already exists (${cfg.roles.find(r => r.name === o.name)!.sourceFile})`);
  if (existsSync(agentDir(o.name)) || existsSync(agentDir(o.name, true)))
    throw new Error(`agent dir for '${o.name}' already exists — pick another name or 'ours-fleet rm ${o.name}'`);
  const identity = effectiveIdentity(o);
  const owner = cfg.roles.find(role => role.identity === identity);
  if (owner)
    throw new Error(
      `identity '${identity}' is already used by role '${owner.name}' (${owner.sourceFile}); `
      + 'identity sharing is unsupported because binding is exclusive');
}

/** The ours identity a spawn will bind: explicit, else the role name. */
export const effectiveIdentity = (o: SpawnOpts): string => o.identity ?? o.name;

export interface SpawnDryRun {
  schemaVersion: 1;
  warning: string;
  roleDocument: { roles: Record<string, RoleConfig> };
  resolvedRole: ResolvedRole;
}

/**
 * Validate and resolve a spawn without reserving names, contacting the daemon,
 * or writing state. Collision checks are necessarily a point-in-time snapshot.
 */
export function spawnDryRun(o: SpawnOpts): SpawnDryRun {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);
  if (o.missionFile) readMissionFile(o.missionFile);
  assertNameFree(o);
  const cfg = loadConfig(o.configPath);
  const raw = buildRoleConfig(o, cfg.defaults.harness as string | undefined);
  const harnessOptions = {
    ...((cfg.defaults.harness_options ?? {}) as Record<string, unknown>),
    ...(raw.harness_options ?? {}),
  };
  const harness = raw.harness ?? (cfg.defaults.harness as string | undefined) ?? 'claude-code';
  const defaultHarness = (cfg.defaults.harness as string | undefined) ?? 'claude-code';
  const inheritsModelDefaults = harness === defaultHarness && raw.model !== null;
  const authProxy = resolveAuthProxy(cfg.defaults.auth_proxy, raw.auth_proxy);
  // One resolution for the environment and the model it pins (src/model-env.ts).
  const modelEnv = resolveRoleModelEnv({
    harness,
    model: resolveRoleModel(raw.model, raw.harness, cfg.defaults),
    modelWasExplicit: raw.model !== undefined,
    defaultsEnv: (cfg.defaults.env ?? {}) as Record<string, string>,
    roleEnv: raw.env,
    ...(authProxy ? { authProxyBaseUrl: authProxy.base_url } : {}),
  });
  const model = modelEnv.model;
  const session = raw.session ?? (cfg.defaults.session as SessionBackendId | undefined) ?? 'acp';
  const resolvedRole: ResolvedRole = {
    ...raw,
    name: o.name,
    sourceFile: o.temp ? '(temp dry-run)' : join(fleetDDir(), `${o.name}.yaml`),
    harness,
    session,
    session_options: raw.session_options,
    permissions: resolvePermissions(cfg.defaults.permissions, raw.permissions),
    permissionsDeclared: raw.permissions !== undefined || cfg.defaults.permissions !== undefined,
    identity: effectiveIdentity(o),
    model,
    model_chain: resolveModelChain(
      model,
      raw.model_chain ?? (inheritsModelDefaults
        ? cfg.defaults.model_chain as string[] | undefined
        : undefined),
    ),
    harness_options: Object.keys(harnessOptions).length ? harnessOptions : undefined,
    isolation: raw.isolation ?? (cfg.defaults.isolation as IsolationConfig | undefined),
    monitor: resolveMonitorConfig(cfg.defaults.monitor, raw.monitor),
    owner_channel: resolveOwnerChannelConfig(
      cfg.defaults.owner_channel, raw.owner_channel, session),
    worklog: resolveWorklogPolicy(cfg.defaults.worklog, raw.worklog),
    auth_proxy: authProxy,
  };
  resolvedRole.env = modelEnv.env;
  const adapter = getAdapter(resolvedRole.harness);
  if (resolvedRole.auth_proxy && resolvedRole.harness !== 'claude-code')
    throw new Error('auth_proxy is supported only by claude-code');
  const optionProblems = adapter.validateOptions(resolvedRole.harness_options, resolvedRole);
  if (optionProblems.length)
    throw new Error(optionProblems.map(problem => `${problem.path}: ${problem.message}`).join('; '));
  return {
    schemaVersion: 1,
    warning: 'collision checks are a snapshot; a real spawn reserves names atomically',
    roleDocument: { roles: { [o.name]: raw } },
    resolvedRole,
  };
}

/**
 * Which settings came from the operator, from fleet defaults, or from a
 * built-in. Built while the options are still separable — once they are
 * merged into a ResolvedRole the distinction is gone.
 *
 * `env`, `bio`, `persona` and `harness_options` are deliberately absent: the
 * record exists to be read, and must not become a place credentials collect.
 */
function provenanceSettings(
  o: SpawnOpts, defaults: Record<string, unknown>,
): Record<string, ProvenanceEntry> {
  const perms = (defaults.permissions ?? {}) as Partial<CommonPermissions>;
  const callerDefaults = new Set(o.inheritedFromCaller ?? []);
  const tagged = (key: string, entry: ProvenanceEntry): ProvenanceEntry =>
    callerDefaults.has(key) ? { ...entry, source: 'caller-role' } : entry;
  const explicitModel = typeof o.model === 'string' ? o.model.trim() : undefined;
  const inheritedModel = resolveRoleModel(undefined, o.harness, defaults);
  return {
    harness: tagged('harness', provenanceOf(o.harness, defaults.harness, 'claude-code')),
    session: tagged('session', provenanceOf(o.session, defaults.session, 'acp')),
    identity: o.identity
      ? { value: o.identity, source: 'cli' }
      : { value: o.name, source: 'built-in' },     // defaults to the role name
    cwd: tagged('cwd', provenanceOf(o.cwd, undefined, undefined)),
    model: tagged('model', o.model === null
      ? { value: undefined, source: 'cli' }
      : explicitModel
        ? { value: explicitModel, source: 'cli' }
        : { value: inheritedModel, source: inheritedModel ? 'fleet-default' : 'built-in' }),
    coordinator: tagged('coordinator', provenanceOf(o.coordinator, undefined, undefined)),
    permission_mode: provenanceOf(o.permissionMode, undefined, undefined),
    approval: tagged('approval', provenanceOf(o.approval, perms.approval, 'ask')),
    filesystem: tagged('filesystem', provenanceOf(o.filesystem, perms.filesystem, 'workspace')),
    unattended: tagged('unattended', provenanceOf(o.unattended, perms.unattended, 'deny')),
    isolation: o.isolationFile
      ? { value: 'declared via --isolation-file', source: 'cli' }
      : { value: defaults.isolation ? 'from fleet defaults' : undefined, source: defaults.isolation ? 'fleet-default' : 'built-in' },
    monitor: tagged('monitorConfig', provenanceOf(o.monitorConfig, defaults.monitor, { mode: 'fleet' })),
  };
}

/** Permanent spawn: persist to ~/fleet.d/<Name>.yaml, then bring it up. */
export async function spawnPermanent(
  o: SpawnOpts, deps: OpsDeps, creation: CreationDeps = {},
): Promise<string> {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);   // fail before reserving
  if (o.missionFile) readMissionFile(o.missionFile);         // fail before reserving
  // Reserve name and identity together before anything is written or started.
  // A loser of the race creates no config, state, or service.
  creation.onStage?.('reserving');
  return withCreationTransaction(
    { role: o.name, identity: effectiveIdentity(o) },
    async tx => {
      assertNameFree(o);
      const cfg = loadConfig(o.configPath);
      // Establish the identity BEFORE the service is enabled, and record
      // what was actually guaranteed so the briefing can say something true.
      creation.onStage?.('checking_identity');
      const guarantee = await ensureIdentity(
        effectiveIdentity(o),
        profileValues(o),
        creation.identityProvisioner ?? deps.identityProvisioner ?? daemonIdentityProvisioner(),
        deps.log);
      creation.onStage?.('checking_identity', {
        result: guarantee.evidence, guarantee: guarantee.state,
      });
      if (guarantee.state === 'created')
        // We minted it; a failed creation must not leave an orphan identity
        // behind. Only ever removes an identity THIS transaction created.
        tx.record({
          stage: `ours identity ${effectiveIdentity(o)}`,
          undo: async () => {
            await creation.identityProvisioner?.remove?.(effectiveIdentity(o));
          },
        });
      mkdirSync(fleetDDir(), { recursive: true });
      creation.onStage?.('writing_role');
      const file = join(fleetDDir(), `${o.name}.yaml`);
      writeRoleFile(tx, file, stringify({
        roles: { [o.name]: buildRoleConfig(o, cfg.defaults.harness as string | undefined) },
      }));
      // `up` materialises the state dir and registers the service. Journal the
      // dir before it exists so a failure leaves the name genuinely reusable
      // rather than blocked by a half-built directory.
      const stateDir = agentDir(o.name);
      const stateExisted = existsSync(stateDir);
      tx.record({
        stage: `state dir ${stateDir}`,
        undo: () => { if (!stateExisted) rmSync(stateDir, { recursive: true, force: true }); },
      });
      // Journal the service registration BEFORE it happens, and undo only the
      // registrations this transaction actually created. `registered` is
      // filled by `up`'s onInstalled hook at the moment each registration is
      // made — not from its return value, which never arrives when `up` throws
      // after registering.
      const registered: string[] = [];
      tx.record({
        stage: `service registration for ${o.name}`,
        undo: async () => { for (const n of registered) await deps.backend.uninstall(n); },
      });
      // Provenance is written BEFORE the role starts, so a role that fails to
      // launch still records how it was asked for.
      const provenance = buildProvenance({
        role: o.name, lifetime: 'permanent', fleetVersion: VERSION,
        settings: provenanceSettings(o, cfg.defaults),
        surface: o.surface, creationActionId: o.creationActionId, callerRole: o.callerRole,
      });
      mkdirSync(agentDir(o.name), { recursive: true });
      writeProvenance(agentDir(o.name), provenance);
      creation.onStage?.('registering_supervisor');
      await up(
        loadConfig(o.configPath), [o.name],
        {
          ...deps,
          ...(creation.identityProvisioner
            ? { identityProvisioner: creation.identityProvisioner } : {}),
          onInstalled: outcome => registered.push(outcome.role),
        },
        o.configPath, guarantee.state);
      lastProvenance = provenance;
      return file;
    },
    creation,
  );
}

/** Fallback used only when service-manager supervision is explicitly disabled. */
const spawnDetached = (binPath: string, args: string[], dir: string): number => {
  // Log to the temp dir; the child fd stays valid when retirement moves the
  // directory into the evidence archive.
  const out = openSync(join(dir, 'supervisor.log'), 'a');
  let child: ReturnType<typeof spawnChild>;
  try {
    child = spawnChild(process.execPath, [binPath, ...args], {
      detached: true,
      stdio: ['ignore', out, out],
    });
  } finally { closeSync(out); }
  child.unref();
  if (!child.pid) throw new Error('detached temporary supervisor did not report a pid');
  return child.pid;
};

const independentSupervisor = makeTempSupervisorLauncher({ spawnDetached });
export type { SupervisorLauncher } from './temp-lifecycle.js';

/** Temp spawn: live state under ~/.ours-fleet/tmp, independent transient supervision. */
export async function spawnTemp(
  o: SpawnOpts,
  binPath: string,
  launch: SupervisorLauncher = independentSupervisor,
  creation: CreationDeps = {},
): Promise<string> {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);   // fail before reserving
  if (o.missionFile) readMissionFile(o.missionFile);         // fail before reserving
  // Retire only supervisors whose recorded owner is definitively stopped. This
  // bounded pass keeps the active roster clean without deleting old evidence.
  await reclaimStaleTempState();
  // Temporary roles go through the same reservation boundary as permanent ones:
  // a temp agent competes for the same names.
  creation.onStage?.('reserving');
  return withCreationTransaction(
    { role: o.name, identity: effectiveIdentity(o) },
    async tx => {
      creation.onStage?.('checking_identity');
      assertNameFree(o);
      creation.onStage?.('checking_identity', {
        result: 'unknown', guarantee: 'unverified',
      });
      return spawnTempInner(o, binPath, launch, tx, creation.onStage);
    },
    creation,
  );
}

async function spawnTempInner(
  o: SpawnOpts, binPath: string, launch: SupervisorLauncher, tx: CreationTransaction,
  onStage: CreationDeps['onStage'],
): Promise<string> {
  const cfg = loadConfig(o.configPath);
  const defaultHarness = cfg.defaults.harness as string | undefined;
  const fromOpts = buildRoleConfig(o, defaultHarness);
  const mergedHarnessOptions = {
    ...((cfg.defaults.harness_options ?? {}) as Record<string, unknown>),
    ...(fromOpts.harness_options ?? {}),
  };
  const harness = o.harness ?? defaultHarness ?? 'claude-code';
  const inheritsModelDefaults = harness === (defaultHarness ?? 'claude-code') && o.model !== null;
  const tempAuthProxy = resolveAuthProxy(cfg.defaults.auth_proxy, fromOpts.auth_proxy);
  // An explicitly requested --model must reach the child, not just the banner
  // (src/model-env.ts).
  const modelEnv = resolveRoleModelEnv({
    harness,
    model: resolveRoleModel(o.model, o.harness, cfg.defaults),
    modelWasExplicit: o.model !== undefined,
    defaultsEnv: (cfg.defaults.env ?? {}) as Record<string, string>,
    roleEnv: fromOpts.env,
    ...(tempAuthProxy ? { authProxyBaseUrl: tempAuthProxy.base_url } : {}),
  });
  const model = modelEnv.model;
  const session = o.session ?? (cfg.defaults.session as SessionBackendId | undefined) ?? 'acp';
  const role: ResolvedRole = {
    ...fromOpts,          // includes `isolation` when --isolation-file was given
    name: o.name,
    harness,
    session,
    identity: o.identity ?? o.name,
    model,
    model_chain: resolveModelChain(
      model,
      fromOpts.model_chain ?? (inheritsModelDefaults
        ? cfg.defaults.model_chain as string[] | undefined
        : undefined),
    ),
    harness_options: Object.keys(mergedHarnessOptions).length ? mergedHarnessOptions : undefined,
    permissions: resolvePermissions(cfg.defaults.permissions, fromOpts.permissions),
    permissionsDeclared:
      fromOpts.permissions !== undefined || cfg.defaults.permissions !== undefined,
    // Temp agents inherit the fleet-wide monitor defaults via the snapshot.
    monitor: resolveMonitorConfig(cfg.defaults.monitor, fromOpts.monitor),
    owner_channel: resolveOwnerChannelConfig(
      cfg.defaults.owner_channel, fromOpts.owner_channel, session),
    worklog: resolveWorklogPolicy(cfg.defaults.worklog, fromOpts.worklog),
    auth_proxy: tempAuthProxy,
    sourceFile: '(temp)',
    roomMemberStartup: o.roomMemberStartup,
  };
  role.env = modelEnv.env;
  if (role.auth_proxy && role.harness !== 'claude-code')
    throw new Error('auth_proxy is supported only by claude-code');
  onStage?.('writing_role');
  const dir = applyRole(role, { temp: true, identityGuarantee: 'unverified' });
  const provenance = buildProvenance({
    role: o.name, lifetime: 'temporary', fleetVersion: VERSION,
    settings: provenanceSettings(o, cfg.defaults),
    surface: o.surface, creationActionId: o.creationActionId, callerRole: o.callerRole,
  });
  writeProvenance(dir, provenance);
  lastProvenance = provenance;
  tx.record({
    stage: `temp state dir ${dir}`,
    undo: () => {
      // A failed launch is still lifecycle evidence: briefing, provenance,
      // metadata and supervisor output explain what happened. Remove it from
      // the live roster by atomic archive, never recursive deletion.
      archiveTempState(
        o.name, 'startup-failure', 'failed',
        'temporary creation rolled back after launch/setup failure; evidence preserved',
      );
    },
  });
  writeFileSync(join(dir, 'role.yaml'), stringify(role));
  // Snapshot the fleet start-stagger so the detached temp supervisor (no config path
  // threaded through it) honors the same launch gate — a burst of temp spawns spaces
  // out; a lone temp spawn still waits zero (time-based gate).
  if (cfg.startStaggerMs > 0)
    writeFileSync(join(dir, START_STAGGER_FILE), String(cfg.startStaggerMs));
  prepareTempSupervisor(dir, o.name);
  // Run the supervisor independently. On a service-managed host the temp
  // runner gets its own transient unit/job, so stopping the coordinator's unit
  // cannot kill a live worker in the coordinator's cgroup.
  onStage?.('starting_temp');
  await launch(binPath, ['_run-temp', o.name], dir);
  return dir;
}
