import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Home root for config + state. OURS_FLEET_HOME overrides (tests, exotic setups). */
export const home = () => process.env.OURS_FLEET_HOME ?? homedir();

/**
 * systemctl/journalctl --user locate the user bus via $XDG_RUNTIME_DIR/bus.
 * sudo/su shells run inside the CALLING user's logind session, so the target
 * user's shell gets no XDG_RUNTIME_DIR even when linger keeps the user manager
 * (and the bus socket) alive at /run/user/<uid>. Derive the standard path once
 * at CLI startup: never override an existing value, and only fire when the dir
 * actually exists — when it doesn't, the real problem is missing linger and the
 * systemctl error (plus its hint) is the right signal. (#9)
 */
export function deriveXdgRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (!env.XDG_RUNTIME_DIR && uid !== undefined) {
    const runDir = `/run/user/${uid}`;
    if (exists(runDir)) env.XDG_RUNTIME_DIR = runDir;
  }
  return env.XDG_RUNTIME_DIR;
}
export const stateRoot = () => join(home(), '.ours-fleet');
export const agentsRoot = () => join(stateRoot(), 'agents');
export const tmpRoot = () => join(stateRoot(), 'tmp');
export const logsRoot = () => join(stateRoot(), 'logs');
export const agentDir = (name: string, temp = false) => join(temp ? tmpRoot() : agentsRoot(), name);
export const defaultConfigPath = () => join(home(), 'fleet.yaml');
export const fleetDDir = () => join(home(), 'fleet.d');
