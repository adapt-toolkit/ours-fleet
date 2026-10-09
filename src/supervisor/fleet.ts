import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { agentDir } from '../paths.js';
import { realExec, type Exec } from '../exec.js';
import { home } from '../paths.js';
import { makeSystemdBackend } from './systemd.js';
import { makeLaunchdBackend } from './launchd.js';
import { catalogLiveness, memberKey, readMember, registerMember, stopMember, unregisterMember, waitMember } from './catalog.js';
import type { SupervisorBackend } from './types.js';

export function fleetHostBackend(exec: Exec = realExec, platform: NodeJS.Platform = process.platform): SupervisorBackend {
  if (platform === 'linux') return makeSystemdBackend(exec);
  if (platform === 'darwin') return makeLaunchdBackend(exec);
  throw Error('Fleet service requires Linux or macOS');
}
/** Registration only starts an explicitly installed parent; it cannot repoint
 * the fleet at the invoking task/development binary or rewrite user settings. */
export async function ensureFleetParent(exec: Exec = realExec, platform: NodeJS.Platform = process.platform): Promise<void> {
  const host = fleetHostBackend(exec, platform);
  const path = platform === 'linux' ? join(home(), '.config/systemd/user/ours-fleet.service')
    : join(home(), 'Library/LaunchAgents/network.ours.fleet.plist');
  if (!existsSync(path)) throw Error('FLEET_SERVICE_NOT_INSTALLED: run ours-fleet init');
  const live = await host.liveness('fleet');
  if (live.state === 'unknown') throw Error('FLEET_SERVICE_LIVENESS_UNKNOWN');
  if (live.state === 'stopped') await host.install('fleet', '');
}
/** OS operations refer only to the Fleet parent; member operations refer only to its catalog. */
export function makeFleetBackend(exec: Exec = realExec, platform: NodeJS.Platform = process.platform): SupervisorBackend {
  const host = fleetHostBackend(exec, platform);
  return {
    id: host.id,
    async init(binPath) {
      const messages = await host.init(binPath);
      const { adoptConfiguredFleet } = await import('./adoption.js');
      await adoptConfiguredFleet(binPath, exec, platform);
      return messages;
    },
    async install(name, binPath) {
      const { adoptConfiguredFleet } = await import('./adoption.js');
      let configPath: string | undefined;
      try { configPath = readFileSync(join(agentDir(name), '.config-path'), 'utf8').trim() || undefined; }
      catch { /* a new state directory may not carry a config marker yet */ }
      await adoptConfiguredFleet(binPath, exec, platform, configPath, name);
      const result = await registerMember({ name, kind: 'permanent', dir: agentDir(name) });
      try {
        await waitMember(result.member.key, 'running', { exec });
      } catch (error) {
        // Preserve existing intent. New registration rollback is exact and waits
        // for process quiescence before its creation evidence can be discarded.
        if (result.created) await unregisterMember(result.member.key, { exec });
        throw error;
      }
      return { created: result.created, detail: `Fleet member ${name} registered` };
    },
    async start(name) {
      const key = memberKey(name, 'permanent'), member = readMember(key);
      if (!member) throw Error('Fleet member not registered; use up');
      await registerMember(member);
      await ensureFleetParent(exec, platform);
      await waitMember(key, 'running', { exec });
    },
    async stop(name) { await stopMember(memberKey(name, 'permanent'), { exec }); },
    async restart(name) {
      await this.stop(name);
      await this.start(name);
    },
    async status(name) { return (await this.liveness(name)).detail; },
    liveness(name) {
      const key = memberKey(name, 'permanent');
      if (!readMember(key) && existsSync(agentDir(name))) return Promise.resolve({ state: 'unknown' as const, detail: 'unmigrated member; preserving context until legacy inspection' });
      return catalogLiveness(key, exec);
    },
    async inspect(name) { return { backend: host.id, ...await this.liveness(name), nativeState: 'fleet-member' }; },
    async uninstall(name) {
      const { retirePermanentRegistration } = await import('./adoption.js');
      return { removed: await retirePermanentRegistration(name, exec), detail: `Fleet member ${name} unregistered` };
    },
    logsArgs(name, follow) { return { cmd: 'tail', args: [follow ? '-f' : '-n', ...(follow ? [] : ['200']), join(agentDir(name), 'supervisor.log')] }; },
  };
}
