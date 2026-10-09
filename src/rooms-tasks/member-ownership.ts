import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, agentsRoot } from '../paths.js';

/** A room seat is never authority to retire a standalone persistent agent.
 * Check both role-name collisions and a permanent role using the seat's
 * identity name. Missing legacy task state must not bypass this fence.
 */
export function assertMemberNotPermanent(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(name)) throw new Error('Invalid retirement member name');
  if (existsSync(agentDir(name)))
    throw new Error(`room member '${name}' conflicts with permanent agent state; refusing retirement`);
  let entries;
  try { entries = readdirSync(agentsRoot(), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(agentsRoot(), entry.name, '.identity');
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
      throw new Error('Permanent identity ownership proof is unsafe; refusing member retirement');
    if (readFileSync(path, 'utf8').trim() === name)
      throw new Error(`room member '${name}' identity belongs to permanent agent '${entry.name}'; refusing retirement`);
  }
}
