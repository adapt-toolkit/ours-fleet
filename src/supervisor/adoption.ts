import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, defaultConfigPath, stateRoot } from '../paths.js';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { loadConfig, findRole } from '../config.js';
import { realExec, type Exec } from '../exec.js';
import { migrateLegacyTaskMembers } from '../task-supervisor-service.js';
import { readMember, memberKey, unregisterMember, registerMember } from './catalog.js';
import { migrateLegacyPermanentMembers } from './legacy.js';
import { ensureFleetParent } from './fleet.js';

export async function adoptConfiguredFleet(binPath: string, exec: Exec, platform: NodeJS.Platform, configPath?: string, selectedRole?: string): Promise<void> {
  const path = configPath || defaultConfigPath();
  if (existsSync(path)) {
    const config = loadConfig(path);
    await migrateLegacyPermanentMembers({
      roles: selectedRole ? [findRole(config, selectedRole)] : config.roles, binPath, configPath: path, exec, platform,
      prepareParent: () => ensureFleetParent(exec, platform),
      register: async (name, desired, selectedConfig) => {
        await registerMember({ name, kind: 'permanent', dir: agentDir(name), configPath: selectedConfig }, { initialDesired: desired, preserveExisting: true });
      },
    });
  } else await ensureFleetParent(exec, platform);
  if (!selectedRole) await migrateLegacyTaskMembers(exec);
}

/** Boot resumes recorded transfers only. It does not rediscover removed agents
 * or decide that every configured role should be started. */
export async function resumeFleetTransfers(binPath: string, exec: Exec = realExec, platform: NodeJS.Platform = process.platform): Promise<void> {
  const root = join(stateRoot(), 'supervisor/legacy-permanent');
  let names: string[];
  try { names = readdirSync(root).filter(name => name.endsWith('.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error; }
  for (const name of names) {
    const path = join(root, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('LEGACY_PERMANENT_UNSAFE_PROOF');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt.phase === 'registered') continue;
    if (name !== receipt.name + '.json') throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
    const configPath = receipt.configPath || defaultConfigPath();
    const role = findRole(loadConfig(configPath), receipt.name);
    await migrateLegacyPermanentMembers({
      roles: [role], binPath, configPath, exec, platform,
      // This runs inside the parent. No recursive OS start, unit writes or reload.
      prepareParent: async () => {},
      register: async (name, desired, selectedConfig) => {
        await registerMember({ name, kind: 'permanent', dir: agentDir(name), configPath: selectedConfig }, { initialDesired: desired, preserveExisting: true });
      },
    });
  }
  await migrateLegacyTaskMembers(exec);
}

/** A remove racing the native-retired → registered seam must not be undone by
 * boot receipt recovery. Serialize with that seam and close its cursor first. */
export async function retirePermanentRegistration(name: string, exec: Exec): Promise<boolean> {
  memberKey(name, 'permanent');
  return withFileLock(join(stateRoot(), 'locks/legacy-permanent', name), async () => {
    const member = readMember(memberKey(name, 'permanent'));
    const path = join(stateRoot(), 'supervisor/legacy-permanent', name + '.json');
    if (member && existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('LEGACY_PERMANENT_UNSAFE_PROOF');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.version !== 1 || receipt.name !== name || !['native-retired', 'registered'].includes(receipt.phase))
        throw Error('LEGACY_PERMANENT_RECEIPT_MISMATCH');
      replaceFileAtomically(path, JSON.stringify({ ...receipt, phase: 'registered' }) + '\n');
    }
    return unregisterMember(memberKey(name, 'permanent'), { exec });
  });
}
