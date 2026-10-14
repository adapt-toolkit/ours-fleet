import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from './atomic-file.js';

/** Body-free recovery cursor. Dispatching is uncertain after a crash, never
 * permission to replay an initial task which may already have caused effects. */
export interface ManagedRecovery {
  version: 1;
  session: 'pending' | 'established';
  readiness: boolean;
  initial: 'pending' | 'dispatching' | 'completed';
  active: boolean;
}
export const managedRecoveryPath = (dir: string) => join(dir, '.managed-recovery.json');
export function readManagedRecovery(dir: string): ManagedRecovery | undefined {
  const path = managedRecoveryPath(dir);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('MANAGED_RECOVERY_UNSAFE_PROOF');
  const value = JSON.parse(readFileSync(path, 'utf8')) as ManagedRecovery;
  if (value.version !== 1 || !['pending', 'established'].includes(value.session)
      || !['pending', 'dispatching', 'completed'].includes(value.initial)
      || typeof value.readiness !== 'boolean' || typeof value.active !== 'boolean')
    throw Error('MANAGED_RECOVERY_INVALID_PROOF');
  return value;
}
export function writeManagedRecovery(dir: string, value: ManagedRecovery): void {
  replaceFileAtomically(managedRecoveryPath(dir), JSON.stringify(value) + '\n');
}
export function firstManagedSessionMayStart(dir: string): boolean {
  const proof = readManagedRecovery(dir);
  return Boolean(proof?.session === 'pending' && proof.initial === 'pending' && !proof.readiness && !proof.active);
}
