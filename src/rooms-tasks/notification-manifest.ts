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

/** Merge rooms into the task's intent. An existing intent that cannot be read is never replaced: this throws and the
 * file keeps its bytes, so a later writer with only some rooms cannot erase coverage recorded earlier. */
export function queueMissionCleanup(taskId: string, contactIds: string[], dir = missionCleanupDir()): void {
  if (!TASK_ID.test(taskId)) throw new Error('invalid task ID');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${taskId}.json`), previous = readMissionCleanup(path, taskId);
  if (previous === 'unavailable') throw new Error(`mission cleanup intent for ${taskId} is unreadable; file retained`);
  const known = previous === 'absent' ? [] : previous.contactIds;
  const merged = [...new Set([...known, ...contactIds.filter(validRoomCid).map(canonicalCid)])];
  if (previous !== 'absent' && merged.length === known.length) return;
  replaceFileAtomically(path, JSON.stringify({ schema: 1, taskId, contactIds: merged } satisfies MissionCleanupIntent) + '\n', 0o600);
}
/** Only a missing file is absent. Unreadable, malformed or mismatched content is unavailable, never "no intent". */
function readMissionCleanup(path: string, taskId: string): MissionCleanupIntent | 'absent' | 'unavailable' {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable'; }
  try {
    const value = JSON.parse(text);
    if (value?.schema === 1 && value.taskId === taskId && Array.isArray(value.contactIds) && value.contactIds.every(validRoomCid)) return value;
  } catch { /* malformed */ }
  return 'unavailable';
}
const intentFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => /^[0-9a-z]{9}[0-9a-f]{8}\.json$/.test(name)) : [];
/** Readable intents, in directory order. Unreadable ones are reported by `unavailableMissionCleanups`, never dropped. */
export function pendingMissionCleanups(dir = missionCleanupDir()): MissionCleanupIntent[] {
  return intentFiles(dir).map(name => readMissionCleanup(join(dir, name), name.slice(0, -5)))
    .filter((intent): intent is MissionCleanupIntent => typeof intent === 'object');
}
/** Task IDs whose intent file exists but cannot be read. Their bytes are kept; they block nothing else but stay pending. */
export function unavailableMissionCleanups(dir = missionCleanupDir()): string[] {
  return intentFiles(dir).filter(name => readMissionCleanup(join(dir, name), name.slice(0, -5)) === 'unavailable').map(name => name.slice(0, -5));
}
/** Remove only the exact intent the service acknowledged; a merge since then, or an unreadable file, keeps it for another pass. */
export function settleMissionCleanup(intent: MissionCleanupIntent, dir = missionCleanupDir()): boolean {
  const path = join(dir, `${intent.taskId}.json`), current = readMissionCleanup(path, intent.taskId);
  if (typeof current !== 'object' || current.contactIds.length !== intent.contactIds.length) return false;
  rmSync(path, { force: true });
  return true;
}
