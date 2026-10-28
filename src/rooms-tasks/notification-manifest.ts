import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';

/**
 * Notification ownership of a task's rooms. Room identity CIDs are recorded when Fleet records the room, and are
 * never removed (a room erased early stays attributable), so deleting the task can retire its rooms' notifications
 * even after room records are gone.
 */
export interface TaskNotificationManifest { revision: number; room_cids: string[]; }

const CID = /^[A-Za-z0-9_-]{1,512}$/;
export const canonicalCid = (cid: string) => /^[a-f0-9]{64}$/i.test(cid) ? cid.toUpperCase() : cid;
export function validRoomCid(cid: unknown): cid is string { return typeof cid === 'string' && CID.test(cid); }

/** Union of rooms; the revision advances only when a room is added. */
export function withManifestRooms(manifest: TaskNotificationManifest | undefined, cids: string[]): TaskNotificationManifest {
  const current = manifest ?? { revision: 0, room_cids: [] };
  const added = cids.filter(validRoomCid).map(canonicalCid).filter(cid => !current.room_cids.includes(cid));
  return added.length ? { revision: current.revision + 1, room_cids: [...current.room_cids, ...new Set(added)] } : current;
}

/** Durable intent to retire a deleted task's notifications; written at deletion acceptance, merged, removed on service acknowledgement. */
export interface MissionCleanupIntent { schema: 1; taskId: string; contactIds: string[]; }
export const missionCleanupDir = () => join(stateRoot(), 'notifications', 'mission-cleanup');
const TASK_ID = /^[0-9a-z]{9}[0-9a-f]{8}$/;

export function queueMissionCleanup(taskId: string, contactIds: string[], dir = missionCleanupDir()): void {
  if (!TASK_ID.test(taskId)) throw new Error('invalid task ID');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${taskId}.json`), previous = readMissionCleanup(path);
  const merged = [...new Set([...(previous?.contactIds ?? []), ...contactIds.filter(validRoomCid).map(canonicalCid)])];
  if (previous && merged.length === previous.contactIds.length) return;
  replaceFileAtomically(path, JSON.stringify({ schema: 1, taskId, contactIds: merged } satisfies MissionCleanupIntent) + '\n', 0o600);
}
function readMissionCleanup(path: string): MissionCleanupIntent | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.schema === 1 && TASK_ID.test(value.taskId) && Array.isArray(value.contactIds) && value.contactIds.every(validRoomCid)) return value;
  } catch { /* absent or unreadable: not an intent */ }
  return undefined;
}
export function pendingMissionCleanups(dir = missionCleanupDir()): MissionCleanupIntent[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[0-9a-z]{9}[0-9a-f]{8}\.json$/.test(name))
    .map(name => readMissionCleanup(join(dir, name))).filter((intent): intent is MissionCleanupIntent => !!intent);
}
/** Remove only the exact intent the service acknowledged; a merge since then keeps the file for another pass. */
export function settleMissionCleanup(intent: MissionCleanupIntent, dir = missionCleanupDir()): boolean {
  const path = join(dir, `${intent.taskId}.json`), current = readMissionCleanup(path);
  if (!current || current.contactIds.length !== intent.contactIds.length) return false;
  rmSync(path, { force: true });
  return true;
}
