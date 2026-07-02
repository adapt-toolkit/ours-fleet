import { homedir } from 'node:os';
import { join } from 'node:path';

/** Home root for config + state. OURS_FLEET_HOME overrides (tests, exotic setups). */
export const home = () => process.env.OURS_FLEET_HOME ?? homedir();
export const stateRoot = () => join(home(), '.ours-fleet');
export const agentsRoot = () => join(stateRoot(), 'agents');
export const tmpRoot = () => join(stateRoot(), 'tmp');
export const logsRoot = () => join(stateRoot(), 'logs');
export const agentDir = (name: string, temp = false) => join(temp ? tmpRoot() : agentsRoot(), name);
export const defaultConfigPath = () => join(home(), 'fleet.yaml');
export const fleetDDir = () => join(home(), 'fleet.d');
