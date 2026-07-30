import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { agentDir, fleetDDir } from './paths.js';
import {
  loadConfig, resolveMonitorConfig, resolvePermissions,
  type ApprovalMode, type FilesystemMode, type ResolvedRole, type RoleConfig,
  type SessionBackendId, type UnattendedMode,
} from './config.js';
import { applyRole, up, type OpsDeps } from './ops.js';
import { START_STAGGER_FILE } from './runner.js';
import {
  withCreationTransaction, writeRoleFile,
  type CreationDeps, type CreationTransaction,
} from './creation.js';

export interface SpawnOpts {
  name: string;
  temp?: boolean;
  harness?: string;
  session?: SessionBackendId;
  mission?: string;
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
  overseeInterval?: string;
  configPath?: string;
}

function roleFromOpts(o: SpawnOpts, defaultHarness?: string): RoleConfig {
  const r: RoleConfig = {};
  if (o.harness) r.harness = o.harness;
  if (o.session) r.session = o.session;
  if (o.identity) r.identity = o.identity;
  if (o.cwd) r.cwd = o.cwd;
  if (o.coordinator) r.coordinator = o.coordinator;
  if (o.mission) r.mission = o.mission;
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
  return r;
}

function validateSpawnOpts(o: SpawnOpts): void {
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
}

/** The ours identity a spawn will bind: explicit, else the role name. */
export const effectiveIdentity = (o: SpawnOpts): string => o.identity ?? o.name;

/** Permanent spawn: persist to ~/fleet.d/<Name>.yaml, then bring it up. */
export async function spawnPermanent(
  o: SpawnOpts, deps: OpsDeps, creation: CreationDeps = {},
): Promise<string> {
  validateSpawnOpts(o);
  // Name AND identity reserved together, before anything is written or started
  // (6.4). A loser of the race creates no config, no state, no service.
  return withCreationTransaction(
    { role: o.name, identity: effectiveIdentity(o) },
    async tx => {
      assertNameFree(o);
      const cfg = loadConfig(o.configPath);
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
      await up(loadConfig(o.configPath), [o.name], deps, o.configPath);
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
  // Temporary roles go through the SAME reservation boundary as permanent ones
  // (6.4): a temp agent competes for the same names.
  return withCreationTransaction(
    { role: o.name, identity: effectiveIdentity(o) },
    async tx => spawnTempInner(o, binPath, launch, tx),
    creation,
  );
}

async function spawnTempInner(
  o: SpawnOpts, binPath: string, launch: SupervisorLauncher, tx: CreationTransaction,
): Promise<string> {
  assertNameFree(o);
  const cfg = loadConfig(o.configPath);
  const defaultHarness = cfg.defaults.harness as string | undefined;
  const fromOpts = roleFromOpts(o, defaultHarness);
  const mergedHarnessOptions = {
    ...((cfg.defaults.harness_options ?? {}) as Record<string, unknown>),
    ...(fromOpts.harness_options ?? {}),
  };
  const role: ResolvedRole = {
    ...fromOpts,
    name: o.name,
    harness: o.harness ?? defaultHarness ?? 'claude-code',
    session: o.session ?? (cfg.defaults.session as SessionBackendId | undefined) ?? 'tmux',
    identity: o.identity ?? o.name,
    model: o.model?.trim() || (cfg.defaults.model as string | undefined),
    harness_options: Object.keys(mergedHarnessOptions).length ? mergedHarnessOptions : undefined,
    permissions: resolvePermissions(cfg.defaults.permissions, fromOpts.permissions),
    permissionsDeclared:
      fromOpts.permissions !== undefined || cfg.defaults.permissions !== undefined,
    // Temp agents inherit the fleet-wide monitor defaults via the snapshot (design §2).
    monitor: resolveMonitorConfig(cfg.defaults.monitor, fromOpts.monitor),
    sourceFile: '(temp)',
  };
  const dir = applyRole(role, { temp: true });
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
