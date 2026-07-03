import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { agentDir, fleetDDir } from './paths.js';
import { loadConfig, type ResolvedRole, type RoleConfig } from './config.js';
import { applyRole, up, type OpsDeps } from './ops.js';

export interface SpawnOpts {
  name: string;
  temp?: boolean;
  harness?: string;
  mission?: string;
  identity?: string;
  cwd?: string;
  coordinator?: string;
  model?: string;
  bioFile?: string;
  personaFile?: string;
  overseeInterval?: string;
  configPath?: string;
}

function roleFromOpts(o: SpawnOpts): RoleConfig {
  const r: RoleConfig = {};
  if (o.harness) r.harness = o.harness;
  if (o.identity) r.identity = o.identity;
  if (o.cwd) r.cwd = o.cwd;
  if (o.coordinator) r.coordinator = o.coordinator;
  if (o.mission) r.mission = o.mission;
  if (o.model?.trim()) r.model = o.model.trim();
  if (o.bioFile) r.bio = readFileSync(o.bioFile, 'utf8').trim();
  if (o.personaFile) r.persona = readFileSync(o.personaFile, 'utf8').trim();
  return r;
}

function assertNameFree(o: SpawnOpts): void {
  const cfg = loadConfig(o.configPath);
  if (cfg.roles.some(r => r.name === o.name))
    throw new Error(`role '${o.name}' already exists (${cfg.roles.find(r => r.name === o.name)!.sourceFile})`);
  if (existsSync(agentDir(o.name)) || existsSync(agentDir(o.name, true)))
    throw new Error(`agent dir for '${o.name}' already exists — pick another name or 'ours-fleet rm ${o.name}'`);
}

/** Permanent spawn: persist to ~/fleet.d/<Name>.yaml, then bring it up. */
export async function spawnPermanent(o: SpawnOpts, deps: OpsDeps): Promise<string> {
  assertNameFree(o);
  mkdirSync(fleetDDir(), { recursive: true });
  const file = join(fleetDDir(), `${o.name}.yaml`);
  writeFileSync(file, stringify({ roles: { [o.name]: roleFromOpts(o) } }));
  await up(loadConfig(o.configPath), [o.name], deps);
  return file;
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
): Promise<string> {
  assertNameFree(o);
  const cfg = loadConfig(o.configPath);
  const role: ResolvedRole = {
    ...roleFromOpts(o),
    name: o.name,
    harness: o.harness ?? (cfg.defaults.harness as string | undefined) ?? 'claude-code',
    identity: o.identity ?? o.name,
    model: o.model?.trim() || (cfg.defaults.model as string | undefined),
    sourceFile: '(temp)',
  };
  const dir = applyRole(role, { temp: true });
  writeFileSync(join(dir, 'role.yaml'), stringify(role));
  // Run the supervisor DETACHED — NOT inside a tmux session named <name>.
  // `_run-temp` -> runOnce() creates AND kills the tmux session <name> for the
  // agent itself; a supervisor sharing that session name would SIGHUP its own
  // process before the agent ever launches. Detaching mirrors how systemd hosts
  // the supervisor for permanent roles, leaving runOnce to own the <name> session.
  launch(binPath, ['_run-temp', o.name], dir);
  return dir;
}
