import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { agentDir, fleetDDir } from './paths.js';
import { loadConfig, type ResolvedRole, type RoleConfig } from './config.js';
import { applyRole, up, type OpsDeps } from './ops.js';
import { shq } from './exec.js';
import type { Tmux } from './tmux.js';

export interface SpawnOpts {
  name: string;
  temp?: boolean;
  harness?: string;
  mission?: string;
  identity?: string;
  cwd?: string;
  coordinator?: string;
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

/** Temp spawn: state under ~/.ours-fleet/tmp, plain tmux, auto-clean on exit. */
export async function spawnTemp(o: SpawnOpts, tmux: Tmux, binPath: string): Promise<string> {
  assertNameFree(o);
  const cfg = loadConfig(o.configPath);
  const role: ResolvedRole = {
    ...roleFromOpts(o),
    name: o.name,
    harness: o.harness ?? (cfg.defaults.harness as string | undefined) ?? 'claude-code',
    identity: o.identity ?? o.name,
    sourceFile: '(temp)',
  };
  const dir = applyRole(role, { temp: true });
  writeFileSync(join(dir, 'role.yaml'), stringify(role));
  await tmux.newSession(o.name, dir, `${shq(binPath)} _run-temp ${shq(o.name)}`);
  return dir;
}
