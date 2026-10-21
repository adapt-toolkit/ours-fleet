import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../paths.js';
import { binderKey } from '../agent-ours/state.js';
import { FleetError } from './errors.js';

/** Read-only compatibility proof for supervisors predating descriptor identity metadata. */
export function legacySupervisorIdentity(role: string, name: string, temporary: boolean, generation: number): {
  name: string; cid: string; generation: number; proof: string;
} {
  const root = join(stateRoot(), 'private-ours');
  try {
    const matches: { name: string; cid: string; generation: number; proof: string }[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const dir = join(root, entry.name);
      const instance = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
      if (instance.role !== role) continue;
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      const pin = JSON.parse(readFileSync(join(dir, 'identity-pin.json'), 'utf8'));
      if (!Number.isSafeInteger(generation) || generation < 1
          || typeof state.action !== 'string' || !state.action
          || instance.temporary !== temporary || typeof instance.instance !== 'string' || !instance.instance
          || state.version !== 1 || state.instance !== instance.instance
          || state.name !== name || state.lifetime !== (temporary ? 'temporary' : 'permanent')
          || state.generation !== generation || !['READY', 'SERVING'].includes(state.phase)
          || typeof state.daemon !== 'string' || !state.daemon || binderKey(state.daemon, name) !== entry.name
          || !/^[a-f0-9]{64}$/i.test(state.cid ?? '')
          || pin.daemon !== state.daemon || pin.name !== name || pin.cid !== state.cid)
        throw new Error('mismatched legacy ownership proof');
      matches.push({ name, cid: state.cid, generation, proof: createHash('sha256').update(JSON.stringify([
        instance.instance, state.action, state.daemon, name, state.cid, state.lifetime, generation,
      ])).digest('hex') });
    }
    if (matches.length !== 1) throw new Error('missing or ambiguous legacy ownership proof');
    return matches[0];
  } catch {
    // The private directory also contains ownership material: never echo parse errors.
    throw new FleetError('capability_unavailable', 'legacy supervisor ownership proof is missing, ambiguous, or mismatched');
  }
}
