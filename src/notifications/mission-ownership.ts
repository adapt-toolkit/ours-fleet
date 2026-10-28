import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { pendingMissionCleanups, settleMissionCleanup } from '../rooms-tasks/notification-manifest.js';
import { notificationRoomCids, recordNotificationRooms } from '../rooms-tasks/task-state.js';
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
 * Register a room as this task's before the Owner can join it: with own-room messages off, the service must know
 * the room before the room can message the Owner. Unreachable service → throws, so room activation waits and retries.
 * No producer configured → nothing to gate. An older service without the route → admitted with a warning (it cannot
 * suppress own-room messages either).
 */
export async function associateRoomNotifications(taskId: string, roomCid: string, options: {
  config?: ProducerConfig | undefined; warn?: (line: string) => void; request?: typeof fetch;
} = {}): Promise<void> {
  const manifest = recordNotificationRooms(taskId, [roomCid]);
  const config = 'config' in options ? options.config : producerConfig();
  if (!config) return;
  try {
    const { status } = await missionRequest(config, '/api/v1/missions/associate',
      { taskId, revision: manifest.revision, contactIds: manifest.room_cids }, options.request);
    // 409 stale: a newer manifest revision is already registered. 409 deleted: the task is being retired.
    if (status >= 200 && status < 300) return;
    if (status === 409) return;
    throw new MissionOwnershipUnavailable(`notification service refused room registration (HTTP ${status})`);
  } catch (error) {
    if (error instanceof MissionOwnershipUnsupported) { options.warn?.('Notification service does not support mission rooms; own-room message preferences are unavailable'); return; }
    if (error instanceof MissionOwnershipUnavailable) throw new Error('Waiting for notification service to register the mission room');
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
  return pending || pendingMissionCleanups().length > 32;
}

const bootstrapFile = () => join(stateRoot(), 'notifications', 'mission-bootstrap.json');
function nextGeneration(): number {
  let generation = 0;
  try { const value = JSON.parse(readFileSync(bootstrapFile(), 'utf8')); if (Number.isSafeInteger(value?.generation)) generation = value.generation; } catch { /* first run */ }
  mkdirSync(dirname(bootstrapFile()), { recursive: true, mode: 0o700 });
  replaceFileAtomically(bootstrapFile(), JSON.stringify({ generation: generation + 1 }) + '\n', 0o600);
  return generation + 1;
}

/**
 * Register every existing task's rooms under one numbered run, then mark the run complete. Until a run completes
 * the service refuses own-room OFF, so no room that existed before this release can escape the preference.
 */
export async function bootstrapMissionRooms(config: ProducerConfig, tasks: () => TaskRecord[], layoutRooms: (task: TaskRecord) => string[],
  request: typeof fetch = fetch): Promise<void> {
  const generation = nextGeneration();
  const begin = await missionRequest(config, '/api/v1/missions/bootstrap', { generation, complete: false }, request);
  if (begin.status < 200 || begin.status >= 300) throw new MissionOwnershipUnavailable(`bootstrap refused (HTTP ${begin.status})`);
  for (const task of tasks()) {
    if (task.deletion?.status === 'pending') continue;
    const cids = [...notificationRoomCids(task), ...layoutRooms(task)];
    if (!cids.length) continue;
    const manifest = recordNotificationRooms(task.task_id, cids);
    const { status } = await missionRequest(config, '/api/v1/missions/associate',
      { taskId: task.task_id, revision: manifest.revision, contactIds: manifest.room_cids }, request);
    if ((status < 200 || status >= 300) && status !== 409) throw new MissionOwnershipUnavailable(`room registration refused (HTTP ${status})`);
  }
  const done = await missionRequest(config, '/api/v1/missions/bootstrap', { generation, complete: true }, request);
  if (done.status < 200 || done.status >= 300) throw new MissionOwnershipUnavailable(`bootstrap completion refused (HTTP ${done.status})`);
}
