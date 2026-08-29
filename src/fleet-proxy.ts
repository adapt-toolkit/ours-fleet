import type { MonitorConfig, ResolvedRole } from './config.js';
import type { SpawnOpts } from './spawn.js';
import { inheritedPermissionMode } from './permissions.js';

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
  const take = <K extends keyof SpawnOpts>(key: K, value: SpawnOpts[K]) => {
    if (options[key] !== undefined || value === undefined) return;
    options[key] = value;
    inherited.push(String(key));
  };

  const sameHarness = requested.harness === undefined || requested.harness === caller.harness;
  take('harness', caller.harness);
  take('session', caller.session);
  take('cwd', caller.cwd);
  take('coordinator', caller.name);
  if (options.approval === undefined)
    take('approval', inheritedPermissionMode(caller));
  take('filesystem', caller.permissions.filesystem);
  take('unattended', caller.permissions.unattended);
  take('monitorConfig', structuredClone(caller.monitor));
  // A model name and native harness options are not portable across harnesses.
  // When the caller explicitly switches harness, let that harness/fleet defaults
  // select its model instead of copying (for example) a Codex model into Claude.
  if (sameHarness) take('model', caller.model);

  options.configPath = configPath;
  options.surface = 'agent';
  options.callerRole = caller.name;
  options.inheritedFromCaller = [...inherited];
  return { options, inherited };
}
