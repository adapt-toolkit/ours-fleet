import { eraseResourcePresentations } from '../erased-resources.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { replaceFileAtomically } from '../atomic-file.js';
import { agentDir, stateRoot } from '../paths.js';
import { readTempSupervisor, tempSupervisorLiveness, eraseTerminationEvents } from '../temp-lifecycle.js';
import { assertSafeAncestors, auditWorkspaceGit } from './workspace.js';
import type { RoomMemberSeat } from './types.js';

interface Manifest { launches: Array<{ role: string; launchId: string }>; version: 1; token: string; paths: string[]; stamps: Record<string, { dev: number; ino: number; proof: string }>; phases: Record<string, 'renamed' | 'removed'> }
function entries(path: string): string[] {
  try { return readdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function json(path: string): any {
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function fingerprint(path: string): string {
  const stat = lstatSync(path);
  const files = stat.isDirectory() ? ['creation.json', '.temp-supervisor.json', '.identity', 'role.yaml', 'state.json', 'instance.json'] : [''];
  const hash = createHash('sha256');
  for (const file of files) {
    const target = file ? join(path, file) : path;
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new Error('Unsafe erasure proof');
      hash.update(file).update(readFileSync(target));
    }
  }
  return hash.digest('hex');
}
/** Erase only proven launch artifacts. Each atomic rename transfers ownership to
 * a random, durable tombstone before recursive removal can destroy its proof.
 * The caller holds the task/room lifecycle lock and has retired all writers.
 */
export async function eraseMemberArtifacts(
  owner: 'room' | 'task', id: string, seats: readonly RoomMemberSeat[], roomIds: readonly string[],
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid erasure owner');
  const root = stateRoot();
  const manifestPath = join(root, 'erasure', `${owner}-${id}.json`);
  assertSafeAncestors(dirname(manifestPath));
  let manifest = json(manifestPath) as Manifest | undefined;
  const names = new Set(seats.map(s => s.role_name));
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(name)) throw new Error('Invalid erasure member');
    if (existsSync(agentDir(name, true))) throw new Error(`Member '${name}' still has live state during erasure`);
  }
  if (!manifest) {
    const paths: string[] = [];
    const launches = seats.flatMap(seat => { const launchId = seat.launch?.launch_id ?? seat.retirement?.launch_id;
      return launchId ? [{ role: seat.role_name, launchId }] : []; });
    const actions = new Map(seats.map(s => [s.role_name, new Set([s.launch?.action_id].filter((v): v is string => !!v))]));
    const recovery = join(root, 'recovery', 'temporary');
    assertSafeAncestors(recovery);
    for (const entry of entries(recovery)) {
      const path = join(recovery, entry);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const supervisor = readTempSupervisor(path);
      if (!supervisor || !names.has(supervisor.role)) continue;
      const seat = seats.find(s => s.role_name === supervisor.role)!;
      const creation = json(join(path, 'creation.json'));
      let room: string | undefined;
      const roleFile = join(path, 'role.yaml');
      if (existsSync(roleFile) && lstatSync(roleFile).isFile() && !lstatSync(roleFile).isSymbolicLink()) {
        const role = parse(readFileSync(roleFile, 'utf8'));
        if (role?.name === supervisor.role) room = role.roomMemberStartup?.room_id;
      }
      const exactLaunch = seat.launch?.launch_id === supervisor.launchId || seat.retirement?.launch_id === supervisor.launchId;
      const exactAction = creation?.role === supervisor.role && creation.creationActionId === seat.launch?.action_id;
      // Older attempts belong only when the launch descriptor pins the room.
      if (!(exactLaunch && (exactAction || !seat.launch?.action_id)) && !(room && roomIds.includes(room))) continue;
      if (existsSync(join(path, '.identity')) && readFileSync(join(path, '.identity'), 'utf8').trim() !== supervisor.role)
        throw new Error('Archive identity mismatch during erasure');
      if (await tempSupervisorLiveness(path) !== 'stopped') throw new Error('Archive writer is not stopped');
      if (creation?.role === supervisor.role && typeof creation.creationActionId === 'string')
        actions.get(supervisor.role)!.add(creation.creationActionId);
      auditWorkspaceGit(path);
      launches.push({ role: supervisor.role, launchId: supervisor.launchId });
      paths.push(path);
    }
    const privateRoot = join(root, 'private-ours');
    assertSafeAncestors(privateRoot);
    for (const entry of entries(privateRoot)) {
      const path = join(privateRoot, entry);
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) continue;
      if (entry === 'launches' || entry === 'room-inputs') {
        for (const file of entries(path)) {
          const child = join(path, file), value = json(child);
          if (!value) continue;
          const launchOwned = entry === 'launches' && value.role === value.identity
            && actions.get(value.role)?.has(value.action);
          const roomOwned = entry === 'room-inputs' && roomIds.includes(value.room_id)
            && names.has(value.identity_name);
          const readyOwned = entry === 'room-inputs' && file.endsWith('.ready.json')
            && roomIds.includes(value.room) && seats.some(seat => seat.invite_id === value.invite && (!seat.identity_cid || seat.identity_cid === value.cid));
          if (launchOwned || roomOwned || readyOwned) paths.push(child);
        }
        continue;
      }
      const state = json(join(path, 'state.json')), instance = json(join(path, 'instance.json'));
      if (state?.lifetime === 'temporary' && actions.get(state.name)?.has(state.action)
          && instance?.role === state.name && instance?.temporary === true && instance?.instance === state.instance) {
        auditWorkspaceGit(path);
        paths.push(path);
      }
    }
    manifest = { launches, version: 1, token: randomUUID(), paths, phases: {}, stamps: Object.fromEntries(paths.map(path => {
      const stat = lstatSync(path); return [path, { dev: stat.dev, ino: stat.ino, proof: fingerprint(path) }];
    })) };
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    replaceFileAtomically(manifestPath, JSON.stringify(manifest));
  }
  if (manifest.version !== 1 || !/^[a-f0-9-]{36}$/.test(manifest.token) || !Array.isArray(manifest.paths))
    throw new Error('Invalid erasure manifest');
  for (const path of manifest.paths) {
    const rel = relative(root, path);
    if (!rel.startsWith('recovery/temporary/') && !rel.startsWith('private-ours/'))
      throw new Error('Invalid erasure artifact path');
    if (rel.split('/').includes('..')) throw new Error('Invalid erasure artifact traversal');
    assertSafeAncestors(dirname(path));
    const tombstone = `${path}.erasing-${manifest.token}`;
    if (manifest.phases[path] === 'removed') continue;
    if (existsSync(path) && !existsSync(tombstone) && manifest.phases[path] !== 'renamed') {
      const stat = lstatSync(path), stamp = manifest.stamps[path];
      if (stat.isSymbolicLink() || !stamp || stamp.dev !== stat.dev || stamp.ino !== stat.ino || stamp.proof !== fingerprint(path))
        throw new Error('Erasure source ownership changed');
      renameSync(path, tombstone);
    }
    manifest.phases[path] = 'renamed';
    replaceFileAtomically(manifestPath, JSON.stringify(manifest));
    rmSync(tombstone, { recursive: true, force: true });
    manifest.phases[path] = 'removed';
    replaceFileAtomically(manifestPath, JSON.stringify(manifest));
  }
  eraseResourcePresentations([{ kind: owner, id }, ...roomIds.map(id => ({ kind: 'room' as const, id })),
    ...seats.map(seat => ({ kind: 'agent' as const, id: seat.role_name }))]);
  eraseTerminationEvents(manifest.launches);
  rmSync(manifestPath, { force: true });
}
