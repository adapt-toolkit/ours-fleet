import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { canonicalCid, pendingMissionCleanups, settleMissionCleanup, unavailableMissionCleanups, validRoomCid, type TaskNotificationManifest } from '../rooms-tasks/notification-manifest.js';
import { advanceNotificationRevision, notificationRoomCids, recordNotificationRooms } from '../rooms-tasks/task-state.js';
import type { TaskRecord } from '../rooms-tasks/types.js';
import { producerConfig, type ProducerConfig } from './outbox.js';

/** The service predates mission ownership: it has no such route. Work is retained, never reported as done. */
export class MissionOwnershipUnsupported extends Error {}
export class MissionOwnershipUnavailable extends Error {}

export async function missionRequest(config: ProducerConfig, path: string, body: unknown, request: typeof fetch = fetch): Promise<{ status: number; data: any }> {
  let response: Response;
  try {
    response = await request(config.origin + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...(config.gatewayCredential
        ? { 'X-Ours-Api-Token': config.gatewayCredential, 'X-Ours-Notifications-Producer': config.token }
        : { Authorization: `Bearer ${config.token}` }), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw new MissionOwnershipUnavailable('notification service unreachable'); }
  const data = await response.json().catch(() => undefined);
  if (response.status === 404) throw new MissionOwnershipUnsupported('notification service does not support mission ownership');
  return { status: response.status, data };
}

/**
 * Register the task's current manifest. Only a 2xx response whose `contactIds` include every requested room proves
 * coverage. A 409 (mission deleted, stale or conflicting revision) proves nothing about these rooms: the local revision
 * is moved past the refused one, so a later retry registers the full union under a newer revision, and this attempt fails.
 */
async function registerMission(config: ProducerConfig, taskId: string, manifest: TaskNotificationManifest, request?: typeof fetch): Promise<void> {
  const { status, data } = await missionRequest(config, '/api/v1/missions/associate',
    { taskId, revision: manifest.revision, contactIds: manifest.room_cids }, request);
  if (status >= 200 && status < 300) {
    const registered = Array.isArray(data?.contactIds) ? new Set((data.contactIds as unknown[]).filter(validRoomCid).map(canonicalCid)) : undefined;
    if (registered && manifest.room_cids.every(cid => registered.has(cid))) return;
    throw new MissionOwnershipUnavailable('notification service did not confirm every mission room');
  }
  if (status === 409) advanceNotificationRevision(taskId, manifest.revision);
  throw new MissionOwnershipUnavailable(`notification service refused room registration (HTTP ${status})`);
}

/**
 * Attempt to register the task room before the Owner joins, so preferences apply from its first message when confirmed.
 * Unreachable service or unconfirmed coverage throws to the caller, which continues admission with ordinary notifications.
 * No producer configured → nothing to register. An older service without the route returns with a warning.
 */
export async function associateRoomNotifications(taskId: string, roomCid: string, options: {
  config?: ProducerConfig | undefined; warn?: (line: string) => void; request?: typeof fetch;
} = {}): Promise<void> {
  const manifest = recordNotificationRooms(taskId, [roomCid]);
  const config = 'config' in options ? options.config : producerConfig();
  if (!config) return;
  try { await registerMission(config, taskId, manifest, options.request); }
  catch (error) {
    if (error instanceof MissionOwnershipUnsupported) { options.warn?.('Notification service does not support mission rooms; own-room message preferences are unavailable'); return; }
    if (error instanceof MissionOwnershipUnavailable) throw new Error('Notification service did not register the mission room');
    throw error;
  }
}

/** Retire every queued deleted task's notifications; an intent is removed only after the service acknowledged it. */
export async function drainMissionCleanup(config: ProducerConfig, warn: (line: string) => void, request: typeof fetch = fetch): Promise<boolean> {
  let pending = false;
  for (const intent of pendingMissionCleanups().slice(0, 32)) {
    try {
      const { status } = await missionRequest(config, '/api/v1/missions/delete', { taskId: intent.taskId, contactIds: intent.contactIds }, request);
      if (status >= 200 && status < 300) { if (!settleMissionCleanup(intent)) pending = true; continue; }
      warn(`Mission notification cleanup pending (HTTP ${status}); intent retained`);
    } catch (error) {
      warn(error instanceof MissionOwnershipUnsupported
        ? 'Notification service does not support mission cleanup; cleanup pending'
        : 'Mission notification cleanup pending; intent retained');
    }
    return true;
  }
  // An unreadable intent stays pending (and its file retained): overall cleanup is never reported done around it.
  const unavailable = unavailableMissionCleanups();
  if (unavailable.length) warn(`Mission notification cleanup unavailable for ${unavailable.length} unreadable intent(s); files retained`);
  return pending || unavailable.length > 0 || pendingMissionCleanups().length > 32;
}

const bootstrapFile = () => join(stateRoot(), 'notifications', 'mission-bootstrap.json');
/** Only a missing file starts at 0. Unreadable, corrupt or out-of-range state is refused and its bytes are kept. */
function nextGeneration(): number {
  let text: string | undefined;
  try { text = readFileSync(bootstrapFile(), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MissionOwnershipUnavailable('mission bootstrap state unreadable'); }
  let generation = 0;
  if (text !== undefined) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new MissionOwnershipUnavailable('mission bootstrap state corrupt; file retained'); }
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? (value as { generation?: unknown }).generation : undefined;
    if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0) throw new MissionOwnershipUnavailable('mission bootstrap state invalid; file retained');
    generation = stored;
  }
  if (!Number.isSafeInteger(generation + 1)) throw new MissionOwnershipUnavailable('mission bootstrap generation exhausted');
  mkdirSync(dirname(bootstrapFile()), { recursive: true, mode: 0o700 });
  replaceFileAtomically(bootstrapFile(), JSON.stringify({ generation: generation + 1 }) + '\n', 0o600);
  return generation + 1;
}

/**
 * Register every existing task's rooms under one numbered run, then mark the run complete. Until a run completes
 * the service refuses own-room OFF, so no room that existed before this release can escape the preference.
 * The inventory is read in full before the run starts: an unreadable task or layout throws, and the run never
 * completes on partial evidence. Every task must be confirmed by the service before completion.
 */
export async function bootstrapMissionRooms(config: ProducerConfig, tasks: () => TaskRecord[], layoutRooms: (task: TaskRecord) => string[],
  request: typeof fetch = fetch): Promise<void> {
  const inventory = tasks().filter(task => task.deletion?.status !== 'pending')
    .map(task => ({ task, cids: [...notificationRoomCids(task), ...layoutRooms(task)] })).filter(entry => entry.cids.length);
  const generation = nextGeneration();
  const begin = await missionRequest(config, '/api/v1/missions/bootstrap', { generation, complete: false }, request);
  if (begin.status < 200 || begin.status >= 300) throw new MissionOwnershipUnavailable(`bootstrap refused (HTTP ${begin.status})`);
  for (const { task, cids } of inventory) await registerMission(config, task.task_id, recordNotificationRooms(task.task_id, cids), request);
  const done = await missionRequest(config, '/api/v1/missions/bootstrap', { generation, complete: true }, request);
  if (done.status < 200 || done.status >= 300) throw new MissionOwnershipUnavailable(`bootstrap completion refused (HTTP ${done.status})`);
}
