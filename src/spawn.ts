import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { agentDir, fleetDDir } from './paths.js';
import { validateIsolationConfig } from './isolation/policy.js';
import type { IsolationConfig } from './isolation/types.js';
import {
  loadConfig, resolveAuthProxy, resolveModelChain, resolveMonitorConfig, resolvePermissions,
  resolveWorklogPolicy,
  type ApprovalMode, type FilesystemMode, type ResolvedRole, type RoleConfig,
  type CommonPermissions, type SessionBackendId, type UnattendedMode,
} from './config.js';
import { applyRole, up, type OpsDeps } from './ops.js';
import { START_STAGGER_FILE } from './runner.js';
import {
  buildProvenance, daemonIdentityProvisioner, ensureIdentity, provenanceOf,
  withCreationTransaction, writeProvenance, writeRoleFile,
  type CreationDeps, type CreationProvenance, type CreationTransaction,
  type IdentityGuarantee, type ProvenanceEntry,
} from './creation.js';
import { VERSION } from './version.js';
import { getAdapter } from './harness/registry.js';

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
  model?: string;
  permissionMode?: string;
  approval?: ApprovalMode;
  filesystem?: FilesystemMode;
  unattended?: UnattendedMode;
  sandbox?: string;
  profile?: string;
  launcher?: string;
  search?: boolean;
  codexConfig?: Record<string, string | number | boolean>;
  addDirs?: string[];
  monitor?: boolean;
  bioFile?: string;
  personaFile?: string;
  /**
   * Path to a file holding exactly the existing `isolation:` mapping — the same
   * schema fleet.yaml uses, not a second policy language. The ONE new operator
   * input in this release (6.3).
   */
  isolationFile?: string;
  overseeInterval?: string;
  configPath?: string;
  dryRun?: boolean;
  json?: boolean;
}

function roleFromOpts(o: SpawnOpts, defaultHarness?: string): RoleConfig {
  const r: RoleConfig = {};
  if (o.harness) r.harness = o.harness;
  if (o.session) r.session = o.session;
  if (o.identity) r.identity = o.identity;
  if (o.cwd) r.cwd = o.cwd;
  if (o.coordinator) r.coordinator = o.coordinator;
  if (o.missionFile) r.mission = readMissionFile(o.missionFile);
  else if (o.mission !== undefined) r.mission = o.mission;
  if (o.model?.trim()) r.model = o.model.trim();
  const harness = o.harness ?? defaultHarness;
  const harnessOptions: Record<string, unknown> = {};
  if (o.permissionMode) harnessOptions[harness === 'claude-code' ? 'permission_mode' : 'approval'] = o.permissionMode;
  if (o.sandbox) harnessOptions.sandbox = o.sandbox;
  if (o.profile) harnessOptions.profile = o.profile;
  if (o.launcher) harnessOptions.launcher = o.launcher;
  if (o.search === true) harnessOptions.search = true;
  if (o.codexConfig && Object.keys(o.codexConfig).length) harnessOptions.config = o.codexConfig;
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
  if (o.bioFile) r.bio = readFileSync(o.bioFile, 'utf8').trim();
  if (o.personaFile) r.persona = readFileSync(o.personaFile, 'utf8').trim();
  if (o.isolationFile) r.isolation = readIsolationFile(o.isolationFile);
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

function validateSpawnOpts(o: SpawnOpts): void {
  if (o.mission !== undefined && o.missionFile)
    throw new Error('--mission and --mission-file are mutually exclusive');
  if (o.session && !['tmux', 'acp'].includes(o.session))
    throw new Error(`invalid --session '${o.session}'; allowed: tmux, acp`);
  if (o.approval && !['ask', 'allow', 'deny'].includes(o.approval))
    throw new Error(`invalid --approval '${o.approval}'; allowed: ask, allow, deny`);
  if (o.filesystem && !['read-only', 'workspace', 'unrestricted'].includes(o.filesystem))
    throw new Error(
      `invalid --filesystem '${o.filesystem}'; allowed: read-only, workspace, unrestricted`);
  if (o.unattended && !['deny', 'wait'].includes(o.unattended))
    throw new Error(`invalid --unattended '${o.unattended}'; allowed: deny, wait`);
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
  const raw = roleFromOpts(o, cfg.defaults.harness as string | undefined);
  const harnessOptions = {
    ...((cfg.defaults.harness_options ?? {}) as Record<string, unknown>),
    ...(raw.harness_options ?? {}),
  };
  const resolvedRole: ResolvedRole = {
    ...raw,
    name: o.name,
    sourceFile: o.temp ? '(temp dry-run)' : join(fleetDDir(), `${o.name}.yaml`),
    harness: raw.harness ?? (cfg.defaults.harness as string | undefined) ?? 'claude-code',
    session: raw.session ?? (cfg.defaults.session as SessionBackendId | undefined) ?? 'tmux',
    session_options: raw.session_options,
    permissions: resolvePermissions(cfg.defaults.permissions, raw.permissions),
    permissionsDeclared: raw.permissions !== undefined || cfg.defaults.permissions !== undefined,
    identity: effectiveIdentity(o),
    model: raw.model ?? (cfg.defaults.model as string | undefined),
    model_chain: resolveModelChain(
      raw.model ?? (cfg.defaults.model as string | undefined),
      raw.model_chain ?? (cfg.defaults.model_chain as string[] | undefined),
    ),
    harness_options: Object.keys(harnessOptions).length ? harnessOptions : undefined,
    isolation: raw.isolation ?? (cfg.defaults.isolation as IsolationConfig | undefined),
    monitor: resolveMonitorConfig(cfg.defaults.monitor, raw.monitor),
    worklog: resolveWorklogPolicy(cfg.defaults.worklog, raw.worklog),
    auth_proxy: resolveAuthProxy(cfg.defaults.auth_proxy, raw.auth_proxy),
  };
  resolvedRole.env = {
    ...((cfg.defaults.env ?? {}) as Record<string, string>),
    ...(raw.env ?? {}),
    ...(resolvedRole.auth_proxy
      ? { ANTHROPIC_BASE_URL: resolvedRole.auth_proxy.base_url }
      : {}),
  };
  const adapter = getAdapter(resolvedRole.harness);
  if (resolvedRole.auth_proxy && resolvedRole.harness !== 'claude-code')
    throw new Error('auth_proxy is supported only by claude-code');
  const optionProblems = adapter.validateOptions(resolvedRole.harness_options);
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
 * built-in (6.6). Built while the options are still separable — once they are
 * merged into a ResolvedRole the distinction is gone.
 *
 * `env`, `bio`, `persona` and `harness_options` are deliberately absent: the
 * record exists to be read, and must not become a place credentials collect.
 */
function provenanceSettings(
  o: SpawnOpts, defaults: Record<string, unknown>,
): Record<string, ProvenanceEntry> {
  const perms = (defaults.permissions ?? {}) as Partial<CommonPermissions>;
  return {
    harness: provenanceOf(o.harness, defaults.harness, 'claude-code'),
    session: provenanceOf(o.session, defaults.session, 'tmux'),
    identity: o.identity
      ? { value: o.identity, source: 'cli' }
      : { value: o.name, source: 'built-in' },     // defaults to the role name
    cwd: provenanceOf(o.cwd, undefined, undefined),
    model: provenanceOf(o.model?.trim(), defaults.model, undefined),
    coordinator: provenanceOf(o.coordinator, undefined, undefined),
    approval: provenanceOf(o.approval, perms.approval, 'ask'),
    filesystem: provenanceOf(o.filesystem, perms.filesystem, 'workspace'),
    unattended: provenanceOf(o.unattended, perms.unattended, 'deny'),
    isolation: o.isolationFile
      ? { value: 'declared via --isolation-file', source: 'cli' }
      : { value: defaults.isolation ? 'from fleet defaults' : undefined, source: defaults.isolation ? 'fleet-default' : 'built-in' },
  };
}

/** Permanent spawn: persist to ~/fleet.d/<Name>.yaml, then bring it up. */
export async function spawnPermanent(
  o: SpawnOpts, deps: OpsDeps, creation: CreationDeps = {},
): Promise<string> {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);   // fail before reserving
  if (o.missionFile) readMissionFile(o.missionFile);         // fail before reserving
  // Name AND identity reserved together, before anything is written or started
  // (6.4). A loser of the race creates no config, no state, no service.
  return withCreationTransaction(
    { role: o.name, identity: effectiveIdentity(o) },
    async tx => {
      assertNameFree(o);
      const cfg = loadConfig(o.configPath);
      // Establish the identity BEFORE the service is enabled (7.3), and record
      // what was actually guaranteed so the briefing can say something true.
      const guarantee = await ensureIdentity(
        effectiveIdentity(o),
        { bio: o.bioFile ? readFileSync(o.bioFile, 'utf8').trim() : undefined,
          persona: o.personaFile ? readFileSync(o.personaFile, 'utf8').trim() : undefined },
        creation.identityProvisioner ?? daemonIdentityProvisioner(),
        deps.log);
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
      const file = join(fleetDDir(), `${o.name}.yaml`);
      writeRoleFile(tx, file, stringify({
        roles: { [o.name]: roleFromOpts(o, cfg.defaults.harness as string | undefined) },
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
      // registrations this transaction actually created (6.2). `registered` is
      // filled by `up`'s onInstalled hook at the moment each registration is
      // made — not from its return value, which never arrives when `up` throws
      // after registering.
      const registered: string[] = [];
      tx.record({
        stage: `service registration for ${o.name}`,
        undo: async () => { for (const n of registered) await deps.backend.uninstall(n); },
      });
      // Provenance is written BEFORE the role starts, so a role that fails to
      // launch still records how it was asked for (6.6).
      const provenance = buildProvenance({
        role: o.name, lifetime: 'permanent', fleetVersion: VERSION,
        settings: provenanceSettings(o, cfg.defaults),
      });
      mkdirSync(agentDir(o.name), { recursive: true });
      writeProvenance(agentDir(o.name), provenance);
      await up(
        loadConfig(o.configPath), [o.name],
        { ...deps, onInstalled: outcome => registered.push(outcome.role) },
        o.configPath, guarantee.state);
      lastProvenance = provenance;
      return file;
    },
    creation,
  );
}

/** Launches the detached temp supervisor (`_run-temp <name>`). Injectable for tests. */
export type SupervisorLauncher = (binPath: string, args: string[], dir: string) => void;

const detachedSupervisor: SupervisorLauncher = (binPath, args, dir) => {
  // Log to the temp dir; the fd stays valid even after runTemp removes the dir.
  const out = openSync(join(dir, 'supervisor.log'), 'a');
  const child = spawnChild(process.execPath, [binPath, ...args], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
};

/** Temp spawn: state under ~/.ours-fleet/tmp, plain tmux, auto-clean on exit. */
export async function spawnTemp(
  o: SpawnOpts,
  binPath: string,
  launch: SupervisorLauncher = detachedSupervisor,
  creation: CreationDeps = {},
): Promise<string> {
  validateSpawnOpts(o);
  if (o.isolationFile) readIsolationFile(o.isolationFile);   // fail before reserving
  if (o.missionFile) readMissionFile(o.missionFile);         // fail before reserving
  // Temporary roles go through the SAME reservation boundary as permanent ones
  // (6.4): a temp agent competes for the same names.
  return withCreationTransaction(
    { role: o.name, identity: effectiveIdentity(o) },
    async tx => {
      assertNameFree(o);
      const guarantee = await ensureIdentity(
        effectiveIdentity(o),
        { bio: o.bioFile ? readFileSync(o.bioFile, 'utf8').trim() : undefined,
          persona: o.personaFile ? readFileSync(o.personaFile, 'utf8').trim() : undefined },
        creation.identityProvisioner ?? daemonIdentityProvisioner(),
        creation.log);
      return spawnTempInner(o, binPath, launch, tx, guarantee);
    },
    creation,
  );
}

async function spawnTempInner(
  o: SpawnOpts, binPath: string, launch: SupervisorLauncher, tx: CreationTransaction,
  guarantee: IdentityGuarantee,
): Promise<string> {
  const cfg = loadConfig(o.configPath);
  const defaultHarness = cfg.defaults.harness as string | undefined;
  const fromOpts = roleFromOpts(o, defaultHarness);
  const mergedHarnessOptions = {
    ...((cfg.defaults.harness_options ?? {}) as Record<string, unknown>),
    ...(fromOpts.harness_options ?? {}),
  };
  const role: ResolvedRole = {
    ...fromOpts,          // includes `isolation` when --isolation-file was given
    name: o.name,
    harness: o.harness ?? defaultHarness ?? 'claude-code',
    session: o.session ?? (cfg.defaults.session as SessionBackendId | undefined) ?? 'tmux',
    identity: o.identity ?? o.name,
    model: o.model?.trim() || (cfg.defaults.model as string | undefined),
    model_chain: resolveModelChain(
      o.model?.trim() || (cfg.defaults.model as string | undefined),
      fromOpts.model_chain ?? (cfg.defaults.model_chain as string[] | undefined),
    ),
    harness_options: Object.keys(mergedHarnessOptions).length ? mergedHarnessOptions : undefined,
    permissions: resolvePermissions(cfg.defaults.permissions, fromOpts.permissions),
    permissionsDeclared:
      fromOpts.permissions !== undefined || cfg.defaults.permissions !== undefined,
    // Temp agents inherit the fleet-wide monitor defaults via the snapshot (design §2).
    monitor: resolveMonitorConfig(cfg.defaults.monitor, fromOpts.monitor),
    worklog: resolveWorklogPolicy(cfg.defaults.worklog, fromOpts.worklog),
    auth_proxy: resolveAuthProxy(cfg.defaults.auth_proxy, fromOpts.auth_proxy),
    sourceFile: '(temp)',
  };
  role.env = {
    ...((cfg.defaults.env ?? {}) as Record<string, string>),
    ...(fromOpts.env ?? {}),
    ...(role.auth_proxy ? { ANTHROPIC_BASE_URL: role.auth_proxy.base_url } : {}),
  };
  if (role.auth_proxy && role.harness !== 'claude-code')
    throw new Error('auth_proxy is supported only by claude-code');
  const dir = applyRole(role, { temp: true, identityGuarantee: guarantee.state });
  const provenance = buildProvenance({
    role: o.name, lifetime: 'temporary', fleetVersion: VERSION,
    settings: provenanceSettings(o, cfg.defaults),
  });
  writeProvenance(dir, provenance);
  lastProvenance = provenance;
  tx.record({ stage: `temp state dir ${dir}`, undo: () => rmSync(dir, { recursive: true, force: true }) });
  writeFileSync(join(dir, 'role.yaml'), stringify(role));
  // Snapshot the fleet start-stagger so the detached temp supervisor (no config path
  // threaded through it) honors the same launch gate — a burst of temp spawns spaces
  // out; a lone temp spawn still waits zero (time-based gate).
  if (cfg.startStaggerMs > 0)
    writeFileSync(join(dir, START_STAGGER_FILE), String(cfg.startStaggerMs));
  // Run the supervisor DETACHED — NOT inside a tmux session named <name>.
  // `_run-temp` -> runOnce() creates AND kills the tmux session <name> for the
  // agent itself; a supervisor sharing that session name would SIGHUP its own
  // process before the agent ever launches. Detaching mirrors how systemd hosts
  // the supervisor for permanent roles, leaving runOnce to own the <name> session.
  launch(binPath, ['_run-temp', o.name], dir);
  return dir;
}
