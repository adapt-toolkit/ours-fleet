import { realExec, type Exec } from '../exec.js';
import { makeFleetBackend } from './fleet.js';
import { makeNoneBackend } from './none.js';
import type { SupervisorBackend } from './types.js';

export type { SupervisorBackend } from './types.js';
export { makeSystemdBackend, unitFor } from './systemd.js';
export { makeLaunchdBackend, labelFor } from './launchd.js';
export { makeNoneBackend } from './none.js';

export function pickBackend(exec: Exec = realExec, platform: NodeJS.Platform = process.platform): SupervisorBackend {
  if (process.env.OURS_FLEET_SUPERVISOR === 'none') return makeNoneBackend(exec);
  if (platform === 'darwin' || platform === 'linux') return makeFleetBackend(exec, platform);
  throw new Error(`unsupported platform '${platform}' (linux and darwin only)`);
}
