import { spawn as spawnChild } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { agentDir, defaultConfigPath } from './paths.js';
import { validateIsolationConfig } from './isolation/policy.js';
import type { IsolationConfig } from './isolation/types.js';
import type { AgentLoopsConfig, ResolvedRoleLoop } from './loops/config.js';
import {
  loadConfig, findRole, resolveAuthProxy, resolveModelChain, resolveMonitorConfig, resolveOwnerChannelConfig,
  resolvePermissions,
  resolveRoleModel, resolveWorklogPolicy, splitRootFor, validateMonitorConfig,
  type ApprovalMode, type FilesystemMode, type ResolvedRole, type RoleConfig,
  type CommonPermissions, type MonitorConfig, type SessionBackendId, type UnattendedMode,
  type RoomMemberStartup,
  type AgentDefinition, type AgentSelection, type FleetConfig,
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
import { recordGeneratedAgentSource } from './generated-agent-source.js';
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
  brain?: AgentSelection;
  role?: AgentSelection;
  /** Trusted canonical definition used by room provisioning; never a second schema. */
  agentDefinition?: AgentDefinition;
  identity?: string;
  cwd?: string;
  coordinator?: string;
  approval?: ApprovalMode;
  filesystem?: FilesystemMode;
  unattended?: UnattendedMode;
  /** Typed external monitor configuration used by trusted creation surfaces. */
  monitorConfig?: Partial<MonitorConfig>;
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
  /** Trusted YAML containing exactly a top-level `loops:` map. Temporary launches only. */
  loopsFile?: string;
  /** Explicitly override any selected Agent Template loops with none. */
  noLoops?: boolean;
  /** Internal source label retained after room-member plan resolution. */
  loopSource?: 'agent-template' | 'cli' | 'omitted';
  overseeInterval?: string;
  configPath?: string;
  dryRun?: boolean;
  json?: boolean;
}

export function agentDefinitionFromSpawn(o: SpawnOpts): AgentDefinition {
  if (o.agentDefinition) {
    if (o.brain !== undefined || o.role !== undefined || o.cwd !== undefined
        || o.coordinator !== undefined || o.approval !== undefined || o.filesystem !== undefined
        || o.unattended !== undefined || o.isolationFile !== undefined || o.monitorConfig !== undefined
        || o.loopsFile !== undefined)
      throw new Error('canonical agentDefinition conflicts with separate Agent fields');
    const definition = structuredClone(o.agentDefinition);
    if (o.noLoops === true && definition.loops !== undefined)
      throw new Error('canonical agentDefinition loops conflict with explicit no-loops policy');
    if (o.identity) definition.identity = o.identity;
    return definition;
  }
  if (!o.role) throw new Error('--role is required (declared ID or inline mapping)');
  if (!o.brain) throw new Error('--brain is required (declared ID or inline mapping)');
  const permissions = o.approval || o.filesystem || o.unattended ? {
    ...(o.approval ? { approval: o.approval } : {}),
    ...(o.filesystem ? { filesystem: o.filesystem } : {}),
    ...(o.unattended ? { unattended: o.unattended } : {}),
  } : undefined;
  return {
    role: structuredClone(o.role), brain: structuredClone(o.brain),
    ...(o.identity ? { identity: o.identity } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.coordinator ? { coordinator: o.coordinator } : {}),
    ...(permissions ? { permissions } : {}),
    ...(o.isolationFile ? { isolation: readIsolationFile(o.isolationFile) } : {}),
    ...(o.monitorConfig ? { monitor: structuredClone(o.monitorConfig) } : {}),
    ...(o.loopsFile ? { loops: readLoopsFile(o.loopsFile) } : {}),
  };
}

function resolvedSpawn(o: SpawnOpts): { definition: AgentDefinition; role: ResolvedRole } {
  const definition = agentDefinitionFromSpawn(o);
  const cfg = loadConfig(o.configPath, {
    additionalAgent: { id: o.name, definition, temporary: o.temp === true },
  });
  const role = findRole(cfg, o.name);
  if (o.temp) role.temporaryLoopSource = o.loopSource
    ?? (role.temporaryLoops?.length ? 'agent-template' : 'omitted');
  if (o.noLoops === true) role.temporaryLoops = [];
  return { definition, role };
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

/** Read a private canonical temporary-loop override before any creation side effect. */
export function readLoopsFile(path: string): AgentLoopsConfig {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000
      || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600)
    throw new Error(`${path}: loops file must be an owner-only regular file no larger than 1 MB`);
  let raw: unknown;
  try { raw = parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`--loops-file ${path}: ${(error as Error).message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !Object.hasOwn(raw, 'loops')
      || Object.keys(raw as Record<string, unknown>).some(key => key !== 'loops'))
    throw new Error(`${path}: expected exactly a top-level loops: mapping`);
  const loops = (raw as { loops: unknown }).loops;
  if (!loops || typeof loops !== 'object' || Array.isArray(loops)
      || !Object.keys(loops as Record<string, unknown>).length)
    throw new Error(`${path}: loops must be a non-empty mapping; use --no-loops to disable loops`);
  return structuredClone(loops as AgentLoopsConfig);
}

export function validateSpawnOpts(o: SpawnOpts): void {
  if (o.loopsFile && o.noLoops === true)
    throw new Error('--loops-file and --no-loops are mutually exclusive');
  if ((o.loopsFile || o.noLoops === true || o.agentDefinition?.loops !== undefined) && !o.temp)
    throw new Error('temporary Agent loops require --temp');
  if (o.loopsFile) readLoopsFile(o.loopsFile);
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
  if (o.monitorConfig) {
    const problems = validateMonitorConfig(o.monitorConfig);
    if (problems.length) throw new Error(problems.join('; '));
  }
}

/**
 * Reject names that are already USED. This is a precondition, not a claim: it
 * runs INSIDE the creation transaction, after both names are reserved, so the
 * gap between checking and creating that let two spawns both succeed is closed
 * by the reservation rather than by this function.
 */
function assertNameFree(o: SpawnOpts): void {
  let cfg: FleetConfig;
  try {
    cfg = loadConfig(o.configPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes(`resolve to duplicate identity '${effectiveIdentity(o)}'`))
      throw new Error(`ours identity '${effectiveIdentity(o)}' is already taken or being created right now`);
    throw error;
  }
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
  roleDocument: Record<string, unknown>;
  resolvedRole: ResolvedRole;
}

/**
 * Validate and resolve a spawn without reserving names, contacting the daemon,
 * or writing state. Collision checks are necessarily a point-in-time snapshot.
 */
export function spawnDryRun(o: SpawnOpts): SpawnDryRun {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);
  assertNameFree(o);
  const resolved = resolvedSpawn(o);
  const resolvedRole = resolved.role;
  return {
    schemaVersion: 1,
    warning: 'collision checks are a snapshot; a real spawn reserves names atomically',
    roleDocument: structuredClone(resolved.definition) as unknown as Record<string, unknown>,
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
  o: SpawnOpts, defaults: Record<string, unknown>, resolvedLoops: ResolvedRoleLoop[] = [],
): Record<string, ProvenanceEntry> {
  const perms = (defaults.permissions ?? {}) as Partial<CommonPermissions>;
  const callerDefaults = new Set(o.inheritedFromCaller ?? []);
  const tagged = (key: string, entry: ProvenanceEntry): ProvenanceEntry =>
    callerDefaults.has(key) ? { ...entry, source: 'caller-role' } : entry;
  const selection = (value: AgentSelection | undefined): string | undefined =>
    value && 'ref' in value ? `ref:${value.ref}` : value ? 'inline' : undefined;
  return {
    brain: tagged('brain', provenanceOf(selection(o.brain), undefined, undefined)),
    role: tagged('role', provenanceOf(selection(o.role), undefined, undefined)),
    identity: o.identity
      ? { value: o.identity, source: 'cli' }
      : { value: o.name, source: 'built-in' },     // defaults to the role name
    cwd: tagged('cwd', provenanceOf(o.cwd, undefined, undefined)),
    coordinator: tagged('coordinator', provenanceOf(o.coordinator, undefined, undefined)),
    approval: tagged('approval', provenanceOf(o.approval, perms.approval, 'ask')),
    filesystem: tagged('filesystem', provenanceOf(o.filesystem, perms.filesystem, 'workspace')),
    unattended: tagged('unattended', provenanceOf(o.unattended, perms.unattended, 'deny')),
    isolation: o.isolationFile
      ? { value: 'declared via --isolation-file', source: 'cli' }
      : { value: defaults.isolation ? 'from fleet defaults' : undefined, source: defaults.isolation ? 'fleet-default' : 'built-in' },
    monitor: tagged('monitorConfig', provenanceOf(o.monitorConfig, defaults.monitor, { mode: 'fleet' })),
    loops: {
      value: o.noLoops ? { enabled: false, loops: [] }
        : resolvedLoops.length ? resolvedLoops.map(loop => ({
          name: loop.name, enabled: loop.enabled, intervalMs: loop.intervalMs,
          initialDelayMs: loop.initialDelayMs, jitterMs: loop.jitterMs,
          prompt: { bytes: loop.promptBytes, sha256: loop.promptHash },
        })) : 'omitted (legacy no temporary loops)',
      source: o.loopSource === 'agent-template' ? 'agent-template'
        : o.loopsFile || o.noLoops || o.loopSource === 'cli' ? 'cli' : 'built-in',
    },
  };
}

/** Permanent spawn: persist one bare Agent document under the selected v2 root. */
export async function spawnPermanent(
  o: SpawnOpts, deps: OpsDeps, creation: CreationDeps = {},
): Promise<string> {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);   // fail before reserving
  // Preserve the detailed owner/source diagnostic for an existing identity.
  // The check is repeated inside the reservation boundary to close races.
  assertNameFree(o);
  const prepared = resolvedSpawn(o);                         // canonical validation before mutation
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
        { bio: prepared.role.bio, persona: prepared.role.persona },
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
      const agentRoot = join(splitRootFor(o.configPath ?? defaultConfigPath()), 'agents');
      mkdirSync(agentRoot, { recursive: true });
      creation.onStage?.('writing_role');
      const file = join(agentRoot, `${o.name}.yaml`);
      writeRoleFile(tx, file, stringify(agentDefinitionFromSpawn(o)));
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
        settings: provenanceSettings(o, cfg.defaults, prepared.role.temporaryLoops),
        surface: o.surface, creationActionId: o.creationActionId, callerRole: o.callerRole,
      });
      mkdirSync(agentDir(o.name), { recursive: true });
      writeProvenance(agentDir(o.name), provenance);
      recordGeneratedAgentSource(
        agentDir(o.name), o.configPath ?? defaultConfigPath(), file,
      );
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
  const prepared = resolvedSpawn(o);                         // canonical validation before mutation
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
      return spawnTempInner(o, prepared.role, binPath, launch, tx, creation.onStage);
    },
    creation,
  );
}

async function spawnTempInner(
  o: SpawnOpts, preparedRole: ResolvedRole, binPath: string, launch: SupervisorLauncher, tx: CreationTransaction,
  onStage: CreationDeps['onStage'],
): Promise<string> {
  const cfg = loadConfig(o.configPath);
  const { temporaryLoops, ...launchRole } = preparedRole;
  const role: ResolvedRole = {
    ...launchRole, sourceFile: '(temp)',
    ...(o.noLoops === true ? { loops: [] as ResolvedRoleLoop[] }
      : temporaryLoops?.length ? { loops: temporaryLoops } : { loops: undefined }),
    temporaryLoopSource: o.loopSource ?? (temporaryLoops?.length ? 'agent-template' : 'omitted'),
    roomMemberStartup: o.roomMemberStartup,
  };
  onStage?.('writing_role');
  const dir = applyRole(role, { temp: true, identityGuarantee: 'unverified' });
  const provenance = buildProvenance({
    role: o.name, lifetime: 'temporary', fleetVersion: VERSION,
    settings: provenanceSettings(o, cfg.defaults, preparedRole.temporaryLoops),
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
