import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { home } from '../paths.js';
import { realExec, type Exec } from '../exec.js';

/** OS user services have one namespace. Isolated homes must not hijack it.
 * Injected executors exercise isolated definitions without touching a user manager. */
export function assertNativeFleetScope(exec: Exec): void {
  if (exec === realExec && resolve(home()) !== resolve(homedir()))
    throw Error('FLEET_SERVICE_HOME_CONFLICT: managed OS supervision requires the OS user home; use OURS_FLEET_SUPERVISOR=none for isolated fleets');
}
