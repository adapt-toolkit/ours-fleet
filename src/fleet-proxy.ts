import type { MonitorConfig, ResolvedRole } from './config.js';
import type { AgentLaunchConfiguration } from './lifecycle-summary.js';
import type { SpawnOpts } from './spawn.js';
import { inheritedPermissionMode } from './permissions.js';
import { isSensitiveConfigKey } from './sensitive-config.js';

/** Present only inside a managed role process. The CLI treats it as a routing hint, not authority. */
export const FLEET_PROXY_STATE_DIR_ENV = 'OURS_FLEET_PROXY_STATE_DIR';
export const FLEET_PROXY_CALLER_ENV = 'OURS_FLEET_PROXY_CALLER';

export interface ManagedFleetSpawnResult {
  caller: string;
  role: string;
  lifetime: 'permanent' | 'temporary';
  statePath: string;
  harness: string;
  session: 'acp';
  model?: string;
  monitor: Pick<MonitorConfig, 'mode' | 'interrupt'>;
  /** Adapter-resolved portable policy and exact native runtime mode. */
  permissionMode?: { fleetMode: 'ask' | 'auto' | 'allow'; nativeMode: string };
  inherited: string[];
  creationActionId: string;
  brainSummary: string;
  roleSummary: string;
  /** Launch configuration captured from the exact resolved role; absent only from pre-upgrade daemons. */
  configuration?: AgentLaunchConfiguration;
}

/**
 * Fill only omitted spawn settings from the live caller. Explicit agent choices
 * always win. This is convenience attribution, not an authorization boundary.
 */
export function inheritCallerSpawnDefaults(
  caller: ResolvedRole, requested: SpawnOpts, configPath: string | undefined,
): { options: SpawnOpts; inherited: string[] } {
  const options: SpawnOpts = { ...requested };
  const inherited: string[] = [];
  if (requested.agentDefinition) {
    options.configPath = configPath;
    options.surface = 'agent';
    options.callerRole = caller.name;
    options.inheritedFromCaller = [];
    return { options, inherited };
  }
  const take = <K extends keyof SpawnOpts>(key: K, value: SpawnOpts[K]) => {
    if (options[key] !== undefined || value === undefined) return;
    options[key] = value;
    inherited.push(String(key));
  };

  const sensitive = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(sensitive);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value as Record<string, unknown>)
      .some(([key, child]) => isSensitiveConfigKey(key) || sensitive(child));
  };
  if (options.brain === undefined) {
    const brain = caller.agentSelections?.brain;
    if (!brain) throw new Error('caller has no inspectable Brain selection; pass --brain explicitly');
    if ('inline' in brain && sensitive(brain.inline))
      throw new Error('caller inline Brain contains sensitive configuration; pass --brain explicitly');
    take('brain', structuredClone(brain));
  }
  if (options.role === undefined) {
    const role = caller.agentSelections?.role;
    if (!role) throw new Error('caller has no inspectable Role selection; pass --role explicitly');
    take('role', structuredClone(role));
  }
  take('cwd', caller.cwd);
  take('coordinator', caller.name);
  if (options.approval === undefined)
    take('approval', inheritedPermissionMode(caller));
  take('filesystem', caller.permissions.filesystem);
  take('unattended', caller.permissions.unattended);
  take('monitorConfig', structuredClone(caller.monitor));

  options.configPath = configPath;
  options.surface = 'agent';
  options.callerRole = caller.name;
  options.inheritedFromCaller = [...inherited];
  return { options, inherited };
}
