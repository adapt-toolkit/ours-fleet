import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig, type FleetConfig, ConfigError, findRole } from '../config.js';
import { provisionMembers, getBinPath } from './provision.js';
import {
  acceptManagedRoomClose, deleteLegacyClosedRooms, deleteManagedRoom,
  recordManagedRoomCloseError,
} from './close.js';
import { launchFleetWorker } from './external-worker.js';
import {
  resolveTemplate, listTemplates, sealTemplateSnapshot, snapshotTemplate, hashTemplate,
} from './templates.js';
import { acquireLaunchSnapshotLock, releaseLaunchSnapshot } from './launch-snapshot.js';
import { parseGroupedMemberArgs, readMembersFile, type MemberOverrides } from './member-overrides.js';

const MEMBER_ARG_FLAGS = new Set([
  '--member', '--agent-template', '--brain', '--role', '--approval', '--filesystem', '--unattended',
  '--cwd', '--model', '--effort',
]);

export function cliMemberOverrides(membersFile?: string, argv = process.argv.slice(2)): MemberOverrides | undefined {
  const grouped: string[] = [];
  for (let i = 0; i < argv.length; i++) if (MEMBER_ARG_FLAGS.has(argv[i])) {
    grouped.push(argv[i], argv[i + 1]); i += 1;
  }
  if (membersFile && grouped.length) throw new Error('--members-file cannot be combined with grouped --member options');
  if (membersFile) return readMembersFile(membersFile);
  return grouped.length ? parseGroupedMemberArgs(grouped) : undefined;
}
function commandArgv(command: Command): string[] {
  let root = command;
  while (root.parent) root = root.parent;
  return (root as Command & { rawArgs?: string[] }).rawArgs ?? process.argv.slice(2);
}
import {
  createTask, getTask, getDeletingTask, listTasks, startTask, activateTask,
  blockTask, unblockTask, reviewTask,
  updateTaskRoom, updateTaskTemplate, updateTaskMembers, failTask, TaskStateError,
} from './task-state.js';
import {
  createRoomRecord, getRoomRecord, listRoomRecords,
  advanceSaga, setOwnerSeat,
  setSagaError, activateRoom, updateMemberSeats, RoomStateError,
} from './room-state.js';
import { createCoworkAdapter, CoworkProtocolError, CoworkUnavailableError } from './cowork-adapter.js';
import { TASK_CANCELLABLE_STATES, TASK_TERMINAL_STATES } from './types.js';
import type { RoomOrchestrationRecord, TaskOrigin, TemplateDefinition, TemplateSnapshot } from './types.js';
import {
  markdownCode, markdownProse, renderMarkdownFailure, renderMarkdownList,
  renderMarkdownResult, roomStatus, taskStatus,
} from './markdown.js';
import { TaskRoomApplicationError, TaskRoomApplicationService } from '../application/task-room-service.js';
import { TaskListError } from './task-lists.js';
import {
  recordFleetAuditFailure, recordFleetAuditPresentation, recordFleetAuditResource,
} from '../fleet-command-audit.js';

type TaskRoomPublicErrorCode =
  | 'task_confirmation_mismatch' | 'room_confirmation_mismatch'
  | 'task_terminal' | 'task_terminal_already' | 'task_non_resumable'
  | 'template_not_found' | 'template_mismatch' | 'task_template_drift'
  | 'room_filter' | 'room_not_found' | 'room_record_not_found';

class TaskRoomPublicError extends Error {
  constructor(
    readonly code: TaskRoomPublicErrorCode,
    readonly fields: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = 'TaskRoomPublicError';
  }
}

const PUBLIC_ERROR_FIELD = /^[A-Za-z0-9._:@-]{1,160}$/u;

function taskRoomPublicError(
  code: TaskRoomPublicErrorCode, fields: Record<string, unknown> = {},
): TaskRoomPublicError {
  const validated = Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => {
    const text = String(value ?? '');
    return PUBLIC_ERROR_FIELD.test(text) ? [[key, text]] : [];
  }));
  return new TaskRoomPublicError(code, validated);
}

function taskRoomPublicFailure(error: TaskRoomPublicError): {
  legacy: string; kind: 'usage' | 'not_found' | 'state'; detail: string; action: string;
} {
  const f = error.fields;
  switch (error.code) {
    case 'task_confirmation_mismatch': return {
      legacy: 'confirmation ID must match task ID', kind: 'usage',
      detail: 'The two task IDs must match.', action: 'Repeat the same task ID twice.',
    };
    case 'room_confirmation_mismatch': return {
      legacy: 'confirmation ID must match room ID', kind: 'usage',
      detail: 'The two room IDs must match.', action: 'Repeat the same room ID twice.',
    };
    case 'template_not_found': return {
      legacy: `template not found: ${f.template ?? 'requested-template'}`, kind: 'not_found',
      detail: `The requested template ${f.template ?? ''}`.trim() + ' was not found.',
      action: 'Run ours-fleet init to seed missing file-backed presets, then run ours-fleet template list.',
    };
    case 'template_mismatch': return {
      legacy: `template ${f.requested ?? 'requested-template'} does not match room ${f.room ?? 'requested-room'}'s provisioned template ${f.provisioned ?? 'recorded-template'}`,
      kind: 'state', detail: 'The requested template does not match the room’s provisioned template.',
      action: 'Use the room’s recorded template or create a new room.',
    };
    case 'task_template_drift': return {
      legacy: `task template snapshot no longer matches ${f.template ?? 'the recorded template'}`,
      kind: 'state', detail: 'The task template snapshot no longer matches the recorded template.',
      action: 'Run the matching show and recover commands before retrying.',
    };
    case 'task_terminal': return {
      legacy: `task ${f.task ?? 'requested-task'} is in terminal state '${f.state ?? 'terminal'}'`,
      kind: 'state', detail: 'The task is already in a terminal state.',
      action: 'Run ours-fleet task show to inspect the completed task.',
    };
    case 'task_terminal_already': return {
      legacy: `task ${f.task ?? 'requested-task'} is already in terminal state '${f.state ?? 'terminal'}'`,
      kind: 'state', detail: 'The task is already in a terminal state.',
      action: 'Run ours-fleet task show to inspect the completed task.',
    };
    case 'task_non_resumable': return {
      legacy: `task ${f.task ?? 'requested-task'} has room ${f.room ?? 'requested-room'} in a non-resumable state — run 'task recover ${f.task ?? 'requested-task'}'`,
      kind: 'state', detail: 'The task’s room is in a non-resumable state.',
      action: `Run ours-fleet task recover ${f.task ?? '<id>'}.`,
    };
    case 'room_filter': return {
      legacy: 'room state filter must be active, provisioning, or all', kind: 'usage',
      detail: 'The room state filter must be active, provisioning, or all.',
      action: 'Choose one of the supported room state filters.',
    };
    case 'room_not_found': return {
      legacy: `room not found: ${f.room ?? 'requested-room'}`, kind: 'not_found',
      detail: `Room ${f.room ?? ''}`.trim() + ' was not found.',
      action: 'Run ours-fleet room list to find a live room ID.',
    };
    case 'room_record_not_found': return {
      legacy: `room not found in Fleet orchestration: ${f.room ?? 'requested-room'}`, kind: 'not_found',
      detail: `Room ${f.room ?? ''}`.trim() + ' was not found in Fleet orchestration.',
      action: 'Run ours-fleet room list to find a live room ID.',
    };
  }
}

function die(e: unknown): never {
  const msg = e instanceof TaskRoomPublicError
    ? taskRoomPublicFailure(e).legacy : e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`);
  recordFleetAuditFailure(classifyTaskRoomFailure(e));
  process.exit(1);
}

function classifyTaskRoomFailure(e: unknown): {
  class: 'validation' | 'runtime'; effect: 'not_started' | 'unknown';
} {
  if (e instanceof TaskRoomApplicationError)
    e = taskRoomPublicError(e.code as TaskRoomPublicErrorCode, e.fields);
  if (e instanceof TaskRoomPublicError || e instanceof TaskListError || e instanceof ConfigError)
    return { class: 'validation', effect: 'not_started' };
  if (e instanceof TaskStateError) {
    const known = /^task not found: [A-Za-z0-9_-]{1,128}$/u.test(e.message)
      || e.message === 'invalid task ID: expected the canonical 17-character lowercase ID'
      || isKnownTaskStateMessage(e.message);
    return known ? { class: 'validation', effect: 'not_started' }
      : { class: 'runtime', effect: 'unknown' };
  }
  if (e instanceof RoomStateError) {
    const known = /^room not found: [A-Za-z0-9_-]{1,128}$/u.test(e.message)
      || isKnownRoomStateMessage(e.message);
    return known ? { class: 'validation', effect: 'not_started' }
      : { class: 'runtime', effect: 'unknown' };
  }
  return { class: 'runtime', effect: 'unknown' };
}

const TASK_STATE_WORD = '(?:backlog|provisioning|active|review|done|cancelled|failed)';
const SAFE_ID_WORD = '[A-Za-z0-9_-]{1,128}';

function isKnownTaskStateMessage(message: string): boolean {
  return [
    new RegExp(`^cannot transition from '${TASK_STATE_WORD}' to '${TASK_STATE_WORD}'$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} has a pending '(?:done|cancelled)' terminal intent$`, 'u'),
    new RegExp(`^cannot (?:block|cancel) a '${TASK_STATE_WORD}' task$`, 'u'),
    /^task is not blocked$/u,
    new RegExp(`^task ${SAFE_ID_WORD} already has a conflicting '(?:done|cancelled)' terminal intent$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} is already in terminal state '${TASK_STATE_WORD}'$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} is not tied to room ${SAFE_ID_WORD}$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} has no terminal intent$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} reached terminal state '${TASK_STATE_WORD}' outside its intent$`, 'u'),
    new RegExp(`^task ${SAFE_ID_WORD} is pending deletion; run 'ours-fleet task delete ${SAFE_ID_WORD} ${SAFE_ID_WORD}' to retry cleanup$`, 'u'),
  ].some(pattern => pattern.test(message));
}

function isKnownRoomStateMessage(message: string): boolean {
  return [
    new RegExp(`^room ${SAFE_ID_WORD} history cursor cannot move backward$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} is not closing$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} has no recorded member .{1,128}$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} member .{1,128} (?:launch|briefing|retirement) cannot move backward to [A-Za-z_]+$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} member .{1,128} launch changed from ${SAFE_ID_WORD} to ${SAFE_ID_WORD}$`, 'u'),
    new RegExp(`^room ${SAFE_ID_WORD} close cannot move backward to [A-Za-z_]+$`, 'u'),
  ].some(pattern => pattern.test(message));
}

function dieTaskRoom(e: unknown): never {
  if (e instanceof TaskRoomApplicationError)
    e = taskRoomPublicError(e.code as TaskRoomPublicErrorCode, e.fields);
  if (e instanceof TaskRoomPublicError) {
    const failure = taskRoomPublicFailure(e);
    const output = renderMarkdownFailure({
      kind: failure.kind, subject: 'ours-fleet task/room', detail: failure.detail,
      action: failure.action,
    });
    process.stderr.write(`${output}\n`);
    recordFleetAuditFailure({ class: 'validation', effect: 'not_started' });
    process.exit(1);
  }
  if (e instanceof TaskListError) {
    const notFound = e.code === 'list_not_found';
    const conflict = ['duplicate_name', 'reserved_name', 'default_immutable',
      'destination_required', 'same_destination'].includes(e.code);
    const output = renderMarkdownFailure({
      kind: notFound ? 'not_found' : conflict ? 'state' : 'usage',
      subject: 'ours-fleet task list',
      detail: e.message,
      action: notFound ? 'Run ours-fleet task lists to find a valid list.'
        : conflict ? 'Choose a different list name or an explicit valid destination.'
          : 'Use a valid NFC-normalized name of at most 64 Unicode code points.',
    });
    process.stderr.write(`${output}\n`);
    recordFleetAuditFailure({ class: 'validation', effect: 'not_started' });
    process.exit(1);
  }
  const taskMissing = e instanceof TaskStateError
    ? /^task not found: ([A-Za-z0-9_-]{1,128})$/u.exec(e.message) : null;
  const roomMissing = e instanceof RoomStateError
    ? /^room not found: ([A-Za-z0-9_-]{1,128})$/u.exec(e.message) : null;
  const notFoundId = taskMissing?.[1] ?? roomMissing?.[1];
  const state = e instanceof TaskStateError ? isKnownTaskStateMessage(e.message)
    : e instanceof RoomStateError ? isKnownRoomStateMessage(e.message) : false;
  const validation = e instanceof ConfigError
    || (e instanceof TaskStateError
      && e.message === 'invalid task ID: expected the canonical 17-character lowercase ID');
  const kind = notFoundId ? 'not_found' : state ? 'state' : validation ? 'usage' : 'unexpected';
  const output = renderMarkdownFailure({
    kind,
    subject: 'ours-fleet task/room',
    ...(notFoundId ? { detail: `${taskMissing ? 'Task' : 'Room'} ${notFoundId} was not found.` }
      : state ? { detail: 'The current task or room state does not allow that action.' }
        : validation ? { detail: 'Fleet configuration is invalid or incomplete.' } : {}),
    action: notFoundId ? 'Run the matching list command to find a valid ID.'
      : state ? 'Run the matching show command to inspect the current state.'
        : validation ? 'Check the command options and configuration, then retry.'
          : 'Retry once; if it repeats, run ours-fleet doctor and inspect the role logs.',
  });
  process.stderr.write(`${output}\n`);
  recordFleetAuditFailure(classifyTaskRoomFailure(e));
  process.exit(1);
}

const taskListMarkdown = (tasks: ReturnType<typeof listTasks>, title = 'Tasks'): string =>
  renderMarkdownList({
    icon: '📋', title, empty: 'No tasks found.',
    records: tasks.map(t =>
      `${taskStatus(t.state)} ${markdownCode(t.task_id)} — ${markdownProse(t.title)}`
      + ` — List ${markdownCode(t.list_name ?? 'default')}`
      + (t.blocked ? ` — 🚧 Blocked: ${markdownProse(t.blocked.reason)}` : '')),
  });

const taskActionMarkdown = (
  title: string, task: ReturnType<typeof getTask>,
  fields: Parameters<typeof renderMarkdownResult>[0]['fields'] = [],
): string => {
  recordFleetAuditResource('task', task.task_id);
  if (task.room_id) recordFleetAuditResource('room', task.room_id);
  return renderMarkdownResult({
  icon: '📋', title,
  fields: [
    { label: 'ID', value: task.task_id, kind: 'code' },
    { label: 'Status', value: taskStatus(task.state), kind: 'markdown' },
    { label: 'List', value: task.list_name ?? 'default', kind: 'code' },
    ...fields,
  ],
  });
};

function safeSelectionSummary(definition: Record<string, unknown> | undefined, kind: 'brain' | 'role'): string {
  const selected = definition?.[kind];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return 'unresolved';
  const selection = selected as Record<string, unknown>;
  if (selection.kind === 'ref' && typeof selection.id === 'string')
    return `ref:${selection.id} (reference)`;
  if (selection.kind === 'inline' && typeof selection.fingerprint === 'string')
    return `inline:${selection.fingerprint} (inline)`;
  if (typeof selection.ref === 'string') return `ref:${selection.ref}`;
  if (!Object.hasOwn(selection, 'inline')) return 'unresolved';
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
      : JSON.stringify(value);
  const fingerprint = createHash('sha256').update(canonical(selection.inline)).digest('hex').slice(0, 16);
  return `inline:sha256:${fingerprint}`;
}

function safePermissionsSummary(definition: Record<string, unknown> | undefined): string | undefined {
  const permissions = definition?.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return undefined;
  const policy = permissions as Record<string, unknown>;
  const fields = ['approval', 'filesystem', 'unattended'].flatMap(key =>
    typeof policy[key] === 'string' ? [`${key}=${policy[key]}`] : []);
  return fields.length ? fields.join(',') : undefined;
}

function auditTask(operation: string, task: ReturnType<typeof getTask>, previousState: string,
  newState: string = task.state, revision?: string): void {
  const materialSameState = operation === 'block' || operation === 'unblock' || operation === 'settling';
  if (previousState === newState && !materialSameState) return;
  recordFleetAuditResource('task', task.task_id);
  if (task.room_id) recordFleetAuditResource('room', task.room_id);
  const room = task.room_id ? getRoomRecord(task.room_id) : undefined;
  const definitions = new Map(room?.member_seats.map(seat =>
    [seat.role_name, seat.launch?.agent_definition]) ?? []);
  const semanticOperation = operation === 'recover'
    ? newState === 'active' ? 'work' : newState === 'done' ? 'done'
      : newState === 'cancelled' ? 'cancel' : undefined
    : operation as 'create' | 'start' | 'work' | 'block' | 'unblock' | 'review'
      | 'done' | 'cancel' | 'finish' | 'delete' | 'settling';
  if (!semanticOperation) return;
  recordFleetAuditPresentation({ kind: 'task', operation: semanticOperation, id: task.task_id, title: task.title,
    previousState, newState,
    revision: revision ?? task.blocked?.at ?? task.ended_at ?? task.started_at ?? task.created_at,
    list: task.list_name ?? 'default',
    template: task.template ? `${task.template.name}@${task.template.version}` : undefined,
    roomId: task.room_id, agents: [...task.member_roles].sort((a, b) => a.name.localeCompare(b.name)).map(member => ({ name: member.name,
      brain: safeSelectionSummary(definitions.get(member.name), 'brain'),
      role: safeSelectionSummary(definitions.get(member.name), 'role') === 'unresolved'
        ? member.cowork_role : safeSelectionSummary(definitions.get(member.name), 'role'),
      permissions: safePermissionsSummary(definitions.get(member.name)) })) });
}

function auditRoom(operation: string, room: RoomOrchestrationRecord, previousState: string,
  newState: string = room.state): void {
  if (previousState === newState) return;
  recordFleetAuditResource('room', room.room_id);
  const semanticOperation = operation === 'recover'
    ? newState === 'active' ? 'activate' : newState === 'deleted' ? 'delete'
      : newState === 'closing' ? 'close' : undefined
    : operation as 'create' | 'activate' | 'close' | 'delete';
  if (!semanticOperation) return;
  recordFleetAuditPresentation({ kind: 'room', operation: semanticOperation, id: room.room_id, previousState, newState,
    revision: room.closed_at ?? room.activated_at ?? room.close?.accepted_at ?? room.created_at,
    name: room.room_name, taskId: room.task_id,
    template: room.template_snapshot ? `${room.template_snapshot.name}@${room.template_snapshot.version}` : undefined,
    participants: [...room.member_seats].sort((a, b) => a.role_name.localeCompare(b.role_name)).map(member => ({ name: member.role_name, id: member.identity_cid,
      brain: safeSelectionSummary(member.launch?.agent_definition, 'brain'),
      role: safeSelectionSummary(member.launch?.agent_definition, 'role') === 'unresolved'
        ? member.cowork_role : safeSelectionSummary(member.launch?.agent_definition, 'role'),
      permissions: safePermissionsSummary(member.launch?.agent_definition) })) });
}


const roomActionMarkdown = (
  title: string, room: RoomOrchestrationRecord,
  fields: Parameters<typeof renderMarkdownResult>[0]['fields'] = [],
): string => {
  recordFleetAuditResource('room', room.room_id);
  return renderMarkdownResult({
  icon: '🏠', title,
  fields: [
    { label: 'ID', value: room.room_id, kind: 'code' },
    { label: 'Status', value: roomStatus(room.state), kind: 'markdown' },
    ...fields,
  ],
  });
};

const PUBLIC_SETTLE_WAIT_MS = 60_000;
const PUBLIC_SETTLE_POLL_MS = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms); });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function launchTaskSettleWorker(
  taskId: string, configPath?: string,
): Promise<{ task: ReturnType<typeof getTask>; timedOut: boolean }> {
  const previousErrorAt = getTask(taskId).terminal_intent?.error_at;
  try {
    await launchFleetWorker(['task', '_settle', taskId], `task-settle-${taskId}`, configPath);
  } catch (error) {
    await taskRoomService(configPath).recordSettlementError({
      actor: { kind: 'local_control', surface: 'cli' }, taskId, error: errorText(error),
      recoveryHint: `External settle worker failed to start. Retry task recover ${taskId}.`,
    });
    const task = getTask(taskId);
    recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Task', id: taskId,
      state: task.state, category: 'settlement_failed',
      eventId: task.terminal_intent?.error_at ?? task.terminal_intent?.accepted_at ?? task.created_at });
    throw error;
  }
  const deadline = Date.now() + PUBLIC_SETTLE_WAIT_MS;
  while (Date.now() < deadline) {
    const task = getTask(taskId);
    if (task.terminal_intent?.status === 'settled') return { task, timedOut: false };
    if (task.terminal_intent?.error_at !== previousErrorAt && task.terminal_intent?.error) {
      throw new TaskStateError(task.terminal_intent.error);
    }
    await sleep(PUBLIC_SETTLE_POLL_MS);
  }
  const task = getTask(taskId);
  recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Task', id: taskId,
    state: task.state, category: 'settlement_pending',
    eventId: task.terminal_intent?.accepted_at ?? task.created_at });
  return { task, timedOut: true };
}

/** Launch the deletion settle worker and wait boundedly for physical absence. */
async function launchTaskDeleteWorker(
  taskId: string, configPath?: string,
): Promise<{ deleted: boolean; timedOut: boolean }> {
  const readDeletion = (): { present: boolean; errorAt?: string; error?: string } => {
    try {
      const task = getDeletingTask(taskId);
      return { present: true, errorAt: task.deletion?.error_at, error: task.deletion?.error };
    } catch (error) {
      // Only proven physical absence counts as deleted; anything else propagates.
      if (error instanceof TaskStateError && /task not found/.test(error.message))
        return { present: false };
      throw error;
    }
  };
  const before = readDeletion();
  if (!before.present) return { deleted: true, timedOut: false };
  try {
    await launchFleetWorker(['task', '_settle_delete', taskId], `task-delete-${taskId}`, configPath);
  } catch (error) {
    await taskRoomService(configPath).recordDeletionError({
      actor: { kind: 'local_control', surface: 'cli' }, taskId, error: errorText(error),
      recoveryHint: `External delete worker failed to start. Retry task delete ${taskId} ${taskId}.`,
    }).catch(() => {});
    recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Task', id: taskId,
      state: 'deleting', category: 'settlement_failed', eventId: new Date().toISOString() });
    throw error;
  }
  const deadline = Date.now() + PUBLIC_SETTLE_WAIT_MS;
  while (Date.now() < deadline) {
    const current = readDeletion();
    if (!current.present) return { deleted: true, timedOut: false };
    if (current.errorAt !== before.errorAt && current.error) {
      throw new TaskStateError(current.error);
    }
    await sleep(PUBLIC_SETTLE_POLL_MS);
  }
  recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Task', id: taskId,
    state: 'deleting', category: 'settlement_pending', eventId: new Date().toISOString() });
  return { deleted: false, timedOut: true };
}

async function launchRoomDeleteWorker(
  roomId: string, configPath?: string,
): Promise<{ deleted: boolean; timedOut: boolean }> {
  const previousErrorAt = getRoomRecord(roomId)?.close?.error_at;
  try {
    await launchFleetWorker(['room', '_delete', roomId], `room-delete-${roomId}`, configPath);
  } catch (error) {
    await taskRoomService(configPath).recordRoomSettlementError({
      actor: { kind: 'local_control', surface: 'cli' }, roomId, error: errorText(error),
      recoveryHint: `External delete worker failed to start. Retry room delete ${roomId} ${roomId}.`,
    });
    const room = getRoomRecord(roomId);
    if (room) recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Room', id: roomId,
      state: room.state, category: 'cleanup_failed',
      eventId: room.close?.error_at ?? room.close?.accepted_at ?? room.created_at });
    throw error;
  }
  const deadline = Date.now() + PUBLIC_SETTLE_WAIT_MS;
  while (Date.now() < deadline) {
    const room = getRoomRecord(roomId);
    if (!room) return { deleted: true, timedOut: false };
    if (room.close?.error_at !== previousErrorAt && room.close?.error) {
      throw new RoomStateError(room.close.error);
    }
    await sleep(PUBLIC_SETTLE_POLL_MS);
  }
  const remaining = getRoomRecord(roomId);
  if (remaining) recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Room', id: roomId,
    state: remaining.state, category: 'cleanup_pending',
    eventId: remaining.close?.accepted_at ?? remaining.created_at });
  return { deleted: remaining === undefined, timedOut: true };
}

function loadCfg(opts: { configuration?: string }): FleetConfig {
  return loadConfig(opts.configuration);
}

function taskRoomService(configuration?: string): TaskRoomApplicationService {
  return new TaskRoomApplicationService(configuration, {
    loadConfiguration: loadConfig,
    cowork: coworkFor,
    binPath: getBinPath,
    provisionMembers,
  });
}

function allTemplates(cfg: FleetConfig): Record<string, TemplateDefinition> {
  return cfg.roomTemplates ?? {};
}

function coworkFor(cfg: FleetConfig) {
  if (!cfg.rooms)
    throw new ConfigError('rooms: configuration is required before creating or querying rooms');
  return createCoworkAdapter({ configPath: cfg.rooms.cowork?.config });
}

function resolveRoomTemplate(cfg: FleetConfig, name?: string): TemplateSnapshot | undefined {
  if (!name) return undefined;
  const template = resolveTemplate(name, allTemplates(cfg));
  if (!template) throw new Error(`template not found: ${name}`);
  return snapshotTemplate(template, cfg.agentTemplates);
}

function durableTaskRoomTemplate(
  task: ReturnType<typeof getTask>, room: RoomOrchestrationRecord,
): TemplateSnapshot {
  const snapshot = room.template_snapshot;
  if (!snapshot) throw new Error(`room ${room.room_id} has no durable template snapshot`);
  const ref = task.template;
  if (!ref || ref.name !== snapshot.name || ref.version !== snapshot.version
      || ref.content_hash !== snapshot.content_hash) {
    throw new Error(`task ${task.task_id} template reference does not match room ${room.room_id}'s durable snapshot`);
  }
  return snapshot;
}

function roomStartupSections(
  room: RoomOrchestrationRecord,
): NonNullable<Parameters<typeof renderMarkdownResult>[0]['sections']> {
  const sections: NonNullable<Parameters<typeof renderMarkdownResult>[0]['sections']> = [];
  const definitions = Object.values(room.role_briefings ?? {});
  if (definitions.length) {
    sections.push({
      heading: 'Role briefings',
      markdownItems: definitions.sort((a, b) => a.role.localeCompare(b.role)).map(definition =>
        `${markdownCode(definition.role)} — version ${markdownCode(definition.version ?? '?')} — ${markdownProse(definition.state)}`),
    });
  }
  if (room.member_seats.length) {
    sections.push({
      heading: 'Fleet startup evidence',
      markdownItems: room.member_seats.map(seat => {
        const launch = seat.launch?.state ?? 'unrecorded';
        return `${markdownCode(seat.role_name)} — ${markdownProse(seat.cowork_role)} — `
          + `seat ${markdownProse(seat.seat_state)}, launch ${markdownProse(launch)}`
          + (seat.launch?.error ? ' — launch failure recorded; inspect role logs' : '');
      }),
    });
  }
  return sections;
}

async function provisionRoom(cfg: FleetConfig, input: {
  name: string;
  goal?: string;
  brief?: string;
  template?: TemplateSnapshot;
  taskId?: string;
  onCreated?: (room: RoomOrchestrationRecord) => void;
}): Promise<RoomOrchestrationRecord> {
  const rooms = cfg.rooms;
  if (!rooms) throw new ConfigError('rooms: configuration is required');
  const attachOwner = rooms.defaults?.attach_owner !== false;
  if (attachOwner && !cfg.ownerInvite)
    throw new ConfigError('rooms.owner: public_invite or public_invite_file is required when attach_owner is enabled');
  const cowork = coworkFor(cfg);
  const goal = input.goal?.trim() || input.name;
  const unlockSnapshot = input.template ? acquireLaunchSnapshotLock() : undefined;
  let launchTemplate: TemplateSnapshot | undefined;
  let record: RoomOrchestrationRecord;
  try {
    launchTemplate = input.template
      ? sealTemplateSnapshot(input.template, cfg.agentTemplates ?? {}) : undefined;
    const briefing = input.brief?.trim() || launchTemplate?.contract?.trim() || goal;
    const created = await cowork.createRoom({
    room_name: input.name,
    goal,
    briefing,
    quiet_membership: launchTemplate?.room?.quiet_membership,
    anonymous: launchTemplate?.room?.anonymous,
  });
    record = createRoomRecord({
    room_id: created.room_id,
    room_name: input.name,
    room_identity_cid: created.identity_cid,
    task_id: input.taskId,
    template_snapshot: launchTemplate,
  });
    input.onCreated?.(record);
  } catch (error) {
    unlockSnapshot?.();
    if (launchTemplate?.launch_snapshot_hash) releaseLaunchSnapshot(launchTemplate.launch_snapshot_hash);
    throw error;
  }
  unlockSnapshot?.();
  record = advanceSaga(record.room_id, 'create_room', 1);

  if (attachOwner) {
    try {
      record = advanceSaga(record.room_id, 'attach_owner', 2);
      const accepted = await cowork.acceptInvite(record.room_id, cfg.ownerInvite!, {
        role: rooms.owner.role,
        expected_cid: rooms.owner.expected_cid,
      });
      record = setOwnerSeat(
        record.room_id,
        accepted.seat_cid,
        cfg.ownerInviteFingerprint ?? '',
      );
    } catch (error) {
      const mismatch = error instanceof CoworkProtocolError && /CID|expected/i.test(error.message);
      setSagaError(
        record.room_id,
        error instanceof Error ? error.message : String(error),
        mismatch
          ? 'Verify rooms.owner.expected_cid and rotate the configured invite if necessary.'
          : 'Rotate rooms.owner.public_invite or public_invite_file, then run room recover.',
        mismatch ? 'owner_cid_mismatch' : 'waiting_owner_invite',
      );
      const failed = getRoomRecord(record.room_id);
      if (failed) recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Room',
        id: failed.room_id, state: failed.state, category: 'provision_failed',
        eventId: `${failed.created_at}:${failed.saga.phase}:${failed.saga.step_index}` });
      throw error;
    }
  }
  record = advanceSaga(record.room_id, 'create_members', 3);

  if (launchTemplate && launchTemplate.members.length > 0) {
    try {
      record = await provisionMembers({
        cfg,
        cowork,
        roomId: record.room_id,
        taskId: input.taskId,
        template: launchTemplate,
        binPath: getBinPath(),
        brief: input.brief,
        goal: input.goal,
      });
    } catch (error) {
      const failed = getRoomRecord(record.room_id);
      if (failed) recordFleetAuditPresentation({ kind: 'lifecycle_failure', resource: 'Room',
        id: failed.room_id, state: failed.state, category: 'provision_failed',
        eventId: `${failed.created_at}:${failed.saga.phase}:${failed.saga.step_index}` });
      throw error;
    }
  } else {
    record = activateRoom(record.room_id);
    if (input.taskId) activateTask(input.taskId);
  }
  return record;
}

export function registerTemplateCommands(parent: Command, cOpt: (cmd: Command) => Command): void {
  const templateCmd = parent.command('template').description('room template operations');

  cOpt(templateCmd.command('list'))
    .description('list available room templates')
    .option('--json', 'JSON output')
    .action((opts: { configuration?: string; json?: boolean }) => {
      try {
        const templates = taskRoomService(opts.configuration).listTemplates();
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, templates }, null, 2));
          return;
        }
        if (!templates.length) {
          console.log('No templates configured. Run ours-fleet init to seed missing file-backed presets.');
          return;
        }
        for (const t of templates) {
          console.log(`${t.name}@${t.version}  ${t.description}  [file: ${t.sourceFile ?? 'manifest'}]`);
        }
      } catch (e) { die(e); }
    });

  cOpt(templateCmd.command('show <name>'))
    .description('show template details')
    .option('--json', 'JSON output')
    .action((name: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const t = taskRoomService(opts.configuration).getTemplate(name);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, template: t }, null, 2));
          return;
        }
        console.log(`${t.name}@${t.version}  ${t.description}`);
        console.log(`Source: ${t.sourceFile ?? 'manifest'}`);
        if (t.contract) console.log(`\nContract:\n${t.contract}`);
        console.log(`\nMembers:`);
        for (const m of t.members)
          console.log(`  ${m.slot}: ${m.count}× ${m.role} (`
            + `agent template: ${m.agent_template})`);
        console.log(`\nContent hash: ${t.content_hash}`);
      } catch (e) { die(e); }
    });

  cOpt(templateCmd.command('validate'))
    .description('validate all room templates')
    .option('--json', 'JSON output')
    .action((opts: { configuration?: string; json?: boolean }) => {
      try {
        const problems = taskRoomService(opts.configuration).validateTemplates();
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, valid: !problems.length, problems }, null, 2));
          return;
        }
        if (!problems.length) { console.log('All templates valid.'); return; }
        for (const p of problems) {
          console.log(`${p.template}:`);
          for (const i of p.issues) console.log(`  - ${i}`);
        }
        process.exit(1);
      } catch (e) { die(e); }
    });
}

export function registerTaskCommands(parent: Command, cOpt: (cmd: Command) => Command): void {
  const taskCmd = parent.command('task').description('task lifecycle operations');

  cOpt(taskCmd.command('create'))
    .description('create a new task')
    .requiredOption('--title <title>', 'task title')
    .option('--template <name>', 'room template')
    .option('--brief <text>', 'task brief')
    .option('--brief-file <path>', 'task brief from file')
    .option('--backlog', 'create in backlog (do not start immediately)')
    .option('--no-room', 'create task without a room')
    .option('--idempotency-key <key>', 'idempotency key')
    .option('--list <name>', 'task list (default: default)')
    .option('--members-file <path>', 'typed YAML member overrides')
    .option('--member <slot>', 'begin a typed member override block')
    .option('--agent-template <id>', 'Agent Template for the current member block')
    .option('--brain <id>', 'Brain preset for the current member block')
    .option('--role <id>', 'Role preset for the current member block')
    .option('--approval <mode>', 'approval for the current member block')
    .option('--filesystem <mode>', 'filesystem for the current member block')
    .option('--unattended <mode>', 'unattended policy for the current member block')
    .option('--cwd <path>', 'working directory for the current member block')
    .option('--model <id>', 'model for the current member block')
    .option('--effort <level>', 'reasoning effort for the current member block')
    .option('--json', 'JSON output')
    .action(async (opts: {
      configuration?: string; title: string; template?: string;
      brief?: string; briefFile?: string; backlog?: boolean;
      room?: boolean; idempotencyKey?: string; list?: string; json?: boolean; membersFile?: string;
    }, command: Command) => {
      try {
        const members = cliMemberOverrides(opts.membersFile, commandArgv(command));
        const record = await taskRoomService(opts.configuration).createTask({
          actor: { kind: 'local_control', surface: 'cli' }, title: opts.title,
          brief: opts.brief, briefFile: opts.briefFile, template: opts.template,
          backlog: opts.backlog, noRoom: opts.room === false,
          idempotencyKey: opts.idempotencyKey, origin: { type: 'cli' },
          list: opts.list,
          members,
        });

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: record }, null, 2));
          return;
        }
        console.log(taskActionMarkdown('Task created', record, [
          { label: 'Title', value: record.title },
          ...(record.template ? [{ label: 'Template', value: `${record.template.name}@${record.template.version}`, kind: 'code' as const }] : []),
        ]));
      } catch (e) {
        if (e instanceof TaskRoomApplicationError && e.code === 'template_not_found')
          e = taskRoomPublicError('template_not_found', { template: opts.template });
        if (opts.json) die(e); dieTaskRoom(e);
      }
    });

  cOpt(taskCmd.command('list'))
    .description('list tasks')
    .option('--state <state>', 'filter by state (backlog|active|provisioning|review|done|cancelled|failed|all)')
    .option('--list <name>', 'filter by task list')
    .option('--group-by-list', 'group deterministic results by list (JSON)')
    .option('--json', 'JSON output')
    .action(async (opts: { configuration?: string; state?: string; list?: string; groupByList?: boolean; json?: boolean }) => {
      try {
        let stateFilter: import('./types.js').TaskState | undefined;
        if (opts.state && opts.state !== 'all') {
          stateFilter = opts.state as import('./types.js').TaskState;
        }
        const service = taskRoomService(opts.configuration);
        const filter = { ...(stateFilter ? { state: stateFilter } : {}), ...(opts.list ? { list: opts.list } : {}) };
        const tasks = service.listTasks(filter);
        if (opts.json) {
          console.log(JSON.stringify(opts.groupByList
            ? { schema_version: 1, groups: service.groupedTasks(filter) }
            : { schema_version: 1, tasks }, null, 2));
          return;
        }
        console.log(taskListMarkdown(tasks));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('lists')
    .description('list named task lists')
    .option('--json', 'JSON output')
    .action(async (opts: { configuration?: string; json?: boolean }) => {
      try {
        const service = taskRoomService(opts.configuration);
        const lists = service.listTaskLists();
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, lists }, null, 2)); return; }
        console.log(renderMarkdownList({ icon: '📚', title: 'Task lists', empty: 'No task lists found.',
          records: lists.map(list => `${markdownCode(list.name)}${list.built_in ? ' — built-in' : ''}`) }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('list-create <name>')
    .description('create a named task list')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const list = await taskRoomService().createTaskList({ actor: { kind: 'local_control', surface: 'cli' }, name });
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, list }, null, 2)); return; }
        console.log(renderMarkdownResult({ icon: '📚', title: 'Task list created', fields: [{ label: 'Name', value: list.name }] }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('list-rename <name> <new-name>')
    .description('rename a named task list')
    .option('--json', 'JSON output')
    .action(async (name: string, newName: string, opts: { json?: boolean }) => {
      try {
        const list = await taskRoomService().renameTaskList({ actor: { kind: 'local_control', surface: 'cli' }, name, newName });
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, list }, null, 2)); return; }
        console.log(renderMarkdownResult({ icon: '📚', title: 'Task list renamed', fields: [{ label: 'Name', value: list.name }] }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('list-delete <name>')
    .description('delete a task list; non-empty lists require --move-to')
    .option('--move-to <name>', 'destination for assigned tasks')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: { moveTo?: string; json?: boolean }) => {
      try {
        const result = await taskRoomService().deleteTaskList({ actor: { kind: 'local_control', surface: 'cli' }, name, destination: opts.moveTo });
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2)); return; }
        console.log(renderMarkdownResult({ icon: '🗑️', title: 'Task list deleted', fields: [{ label: 'Name', value: result.deleted.name }, { label: 'Tasks moved', value: String(result.moved) }] }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('move <id>')
    .description('move a task to another list without changing its lifecycle')
    .requiredOption('--list <name>', 'destination task list')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { list: string; json?: boolean }) => {
      try {
        const task = await taskRoomService().moveTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId: id, list: opts.list });
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task }, null, 2)); return; }
        console.log(taskActionMarkdown('Task moved', task));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('show <id>')
    .description('show task details')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const service = taskRoomService();
        const { task: t, orchestration: room } = service.getTask(id);
        if (opts.json) {
          console.log(JSON.stringify({
            schema_version: 1, task: t, orchestration: room ?? null,
          }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '📋', title: 'Task details',
          fields: [
            { label: 'ID', value: t.task_id, kind: 'code' },
            { label: 'Title', value: t.title },
            { label: 'Status', value: taskStatus(t.state), kind: 'markdown' },
            ...(t.blocked ? [{ label: 'Blocked', value: t.blocked.reason }] : []),
            ...(t.template ? [{ label: 'Template', value: `${t.template.name}@${t.template.version}`, kind: 'code' as const }] : []),
            ...(t.room_id ? [{ label: 'Room', value: t.room_id, kind: 'code' as const }] : []),
            ...(t.room_identity_cid ? [{ label: 'Room CID', value: t.room_identity_cid, kind: 'code' as const }] : []),
            { label: 'Origin', value: t.origin.type },
            { label: 'Created', value: t.created_at, kind: 'code' },
            ...(t.started_at ? [{ label: 'Started', value: t.started_at, kind: 'code' as const }] : []),
            ...(t.ended_at ? [{ label: 'Ended', value: t.ended_at, kind: 'code' as const }] : []),
            ...(t.outcome ? [{ label: 'Outcome', value: t.outcome.summary, multiline: true }] : []),
          ],
          sections: [
            ...(t.member_roles.length ? [{
              heading: 'Members', markdownItems: t.member_roles.map(m =>
                `${markdownCode(m.name)} — ${markdownProse(m.cowork_role)} — ${markdownCode(m.identity_cid)}`),
            }] : []),
            ...(room ? roomStartupSections(room) : []),
          ],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('start <id>'))
    .description('idempotently select a plan, provision, and start a task')
    .option('--template <name>', 'room template')
    .option('--members-file <path>', 'typed YAML member overrides')
    .option('--member <slot>', 'begin a typed member override block')
    .option('--agent-template <id>', 'Agent Template for current member')
    .option('--brain <id>', 'Brain preset for current member')
    .option('--role <id>', 'Role preset for current member')
    .option('--approval <mode>', 'approval for current member')
    .option('--filesystem <mode>', 'filesystem for current member')
    .option('--unattended <mode>', 'unattended policy for current member')
    .option('--cwd <path>', 'working directory for current member')
    .option('--model <id>', 'model for current member')
    .option('--effort <level>', 'reasoning effort for current member')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean; template?: string; membersFile?: string }, command: Command) => {
      try {
        const t = await taskRoomService(opts.configuration).startTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id,
          template: opts.template, members: cliMemberOverrides(opts.membersFile, commandArgv(command)),
        });
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task started', t));
      } catch (e) {
        if (e instanceof TaskRoomApplicationError && e.code === 'task_template_drift')
          e = taskRoomPublicError('task_template_drift', {
            template: getTask(id).template
              ? `${getTask(id).template!.name}@${getTask(id).template!.version}` : undefined,
          });
        if (opts.json) die(e); dieTaskRoom(e);
      }
    });

  taskCmd.command('block <id>')
    .description('mark a task as blocked')
    .requiredOption('--reason <reason>', 'blocking reason')
    .option('--json', 'JSON output')
    .action((id: string, opts: { reason: string; json?: boolean }) => {
      try {
        const previous = getTask(id).state;
        const t = taskRoomService().blockTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id, reason: opts.reason,
        });
        auditTask('block', t, previous);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task blocked', t, [{ label: 'Reason', value: opts.reason }]));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('unblock <id>')
    .description('unblock a task')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const prior = getTask(id);
        const previous = prior.state;
        const t = taskRoomService().unblockTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id,
        });
        auditTask('unblock', t, previous, t.state, prior.blocked?.at);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task unblocked', t));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('review <id>')
    .description('move a task to review')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const previous = getTask(id).state;
        const t = taskRoomService().reviewTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id,
        });
        auditTask('review', t, previous);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task ready for review', t));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('done <id>'))
    .description('complete a task')
    .option('--summary <text>', 'completion summary')
    .option('--summary-file <path>', 'completion summary from file')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; summary?: string; summaryFile?: string; json?: boolean }) => {
      try {
        const previous = getTask(id).state;
        let summary = opts.summary;
        if (opts.summaryFile) summary = readFileSync(opts.summaryFile, 'utf8');
        const outcome = summary ? { summary } : undefined;
        const plan = await taskRoomService(opts.configuration).completeTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id, outcome,
        });
        if (plan.task.terminal_intent?.status === 'pending') auditTask('settling', plan.task,
          previous, previous, plan.task.terminal_intent.accepted_at);
        const settled = plan.settlementRequired
          ? await launchTaskSettleWorker(id, opts.configuration)
          : { task: plan.task, timedOut: false };
        const t = settled.task;
        auditTask('done', t, previous);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        if (settled.timedOut) {
          console.log(renderMarkdownFailure({
            kind: 'pending', subject: `task done ${id}`,
            detail: 'The completion request was accepted and is still being settled.',
            action: `Run ours-fleet task recover ${id}.`,
          }));
          return;
        }
        console.log(taskActionMarkdown('Task completed', t,
          t.outcome ? [{ label: 'Summary', value: t.outcome.summary, multiline: true }] : []));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('cancel <id> <confirm-id>'))
    .description('cancel a task (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action(async (id: string, confirmId: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        if (id !== confirmId)
          throw taskRoomPublicError('task_confirmation_mismatch');
        const previous = getTask(id).state;
        const plan = await taskRoomService(opts.configuration).cancelTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id,
        });
        if (plan.task.terminal_intent?.status === 'pending') auditTask('settling', plan.task,
          previous, previous, plan.task.terminal_intent.accepted_at);
        const settled = plan.settlementRequired
          ? await launchTaskSettleWorker(id, opts.configuration)
          : { task: plan.task, timedOut: false };
        const t = settled.task;
        auditTask('cancel', t, previous);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        if (settled.timedOut) {
          console.log(renderMarkdownFailure({
            kind: 'pending', subject: `task cancel ${id} ${id}`,
            detail: 'The cancellation request was accepted and is still being settled.',
            action: `Run ours-fleet task recover ${id}.`,
          }));
          return;
        }
        console.log(taskActionMarkdown('Task cancelled', t));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('delete <id> <confirm-id>'))
    .description('permanently delete a task in any lifecycle state (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action(async (id: string, confirmId: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        if (id !== confirmId) throw taskRoomPublicError('task_confirmation_mismatch');
        const accepted = await taskRoomService(opts.configuration).requestTaskDeletion({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id,
        });
        if (accepted.status === 'already_absent') {
          if (opts.json) {
            console.log(JSON.stringify({
              schema_version: 1, task_id: id, deleted: false, already_absent: true,
            }, null, 2));
            return;
          }
          console.log(renderMarkdownResult({
            icon: '🗑️', title: 'Task already absent',
            fields: [{ label: 'ID', value: id, kind: 'code' }],
          }));
          return;
        }
        const settled = await launchTaskDeleteWorker(id, opts.configuration);
        if (opts.json) {
          console.log(JSON.stringify({
            schema_version: 1, task_id: id, accepted: true,
            deleted: settled.deleted, pending: settled.timedOut,
          }, null, 2));
          return;
        }
        if (!settled.deleted) {
          console.log(renderMarkdownFailure({
            kind: 'pending', subject: `task delete ${id} ${id}`,
            detail: 'The deletion was accepted and cleanup is still settling.',
            action: `Re-run ours-fleet task delete ${id} ${id} or ours-fleet task recover ${id}.`,
          }));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🗑️', title: 'Task deleted',
          fields: [{ label: 'ID', value: id, kind: 'code' }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('recover <id>'))
    .description('attempt to recover a stuck task')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const previous = getTask(id).state;
        const app = taskRoomService(opts.configuration);
        const actor = { kind: 'local_control' as const, surface: 'cli' as const };
        const begin = await app.beginTaskRecovery({ actor, taskId: id });
        if (begin.kind === 'deletion_worker_required') {
          const settled = await launchTaskDeleteWorker(id, opts.configuration);
          const payload = { schema_version: 1, task_id: id, deleted: settled.deleted };
          if (opts.json) { console.log(JSON.stringify(payload, null, 2)); return; }
          console.log(settled.deleted
            ? renderMarkdownResult({
              icon: '🗑️', title: 'Task deletion completed by recovery',
              fields: [{ label: 'ID', value: id, kind: 'code' }],
            })
            : renderMarkdownFailure({
              kind: 'pending', subject: `task recover ${id}`,
              detail: 'The task is pending deletion and cleanup is still settling.',
              action: `Run ours-fleet task delete ${id} ${id} to retry.`,
            }));
          return;
        }
        const recovered = begin.kind === 'terminal_worker_required'
          ? await (async () => {
            const settled = await launchTaskSettleWorker(id, opts.configuration);
            return app.continueTaskRecovery({ actor, taskId: id, terminalTimedOut: settled.timedOut });
          })()
          : begin.result;
        const t = recovered.task;
        auditTask('recover', t, previous);
        const room = recovered.room;
        const recoveryActions = recovered.issues.map(issue => {
          if (issue.code === 'terminal_pending') return `Terminal intent remains pending — retry task recover ${id}`;
          if (issue.code === 'waiting_cowork') return 'Cowork management socket unreachable — check ours-cowork service';
          if (issue.code === 'waiting_owner_invite') return 'Owner invite invalid or expired — rotate rooms.owner.public_invite in config';
          if (issue.code === 'owner_cid_mismatch') return 'Owner CID mismatch — verify rooms.owner.expected_cid matches Messenger identity';
          if (issue.code === 'member_failed') return `Member creation failed at saga step ${issue.stepIndex} — inspect and retry`;
          if (issue.code === 'waiting_seats') return 'Members have not accepted their one-time room invites yet — inspect role logs, then retry recovery';
          if (issue.code === 'resume_failed') return `Resume failed: ${issue.error}`;
          return 'Provisioning resumed successfully';
        });
        const result = { task: t, room: room ?? null, recovery_actions: recoveryActions };
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🛟', title: 'Task recovery',
          fields: [
            { label: 'Task', value: t.task_id, kind: 'code' },
            { label: 'Status', value: taskStatus(t.state), kind: 'markdown' },
            ...(room ? [
              { label: 'Room', value: room.room_id, kind: 'code' as const },
              { label: 'Room status', value: roomStatus(room.state), kind: 'markdown' as const },
              { label: 'Saga', value: room.saga.phase, kind: 'code' as const },
            ] : []),
          ],
          sections: recoveryActions.length
            ? [{ heading: 'Next steps', items: recoveryActions }]
            : [{ heading: 'Result', items: ['No automated recovery action is available.'] }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('_settle <id>', { hidden: true }))
    .description('internal: settle a previously accepted task terminal intent')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const app = taskRoomService(opts.configuration);
        const t = await app.settleTask({
          actor: { kind: 'internal_worker', surface: 'cli' }, taskId: id,
        });
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2));
          return;
        }
        console.log(taskActionMarkdown('Task terminal action settled', t));
      } catch (e) {
        await taskRoomService(opts.configuration).recordSettlementError({
          actor: { kind: 'internal_worker', surface: 'cli' }, taskId: id,
          error: errorText(e), recoveryHint: `External settle worker failed. Retry task recover ${id}.`,
        }).catch(() => {});
        if (opts.json) die(e);
        dieTaskRoom(e);
      }
    });

  cOpt(taskCmd.command('_settle_delete <id>', { hidden: true }))
    .description('internal: settle a previously accepted task deletion')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const app = taskRoomService(opts.configuration);
        const result = await app.settleTaskDeletion({
          actor: { kind: 'internal_worker', surface: 'cli' }, taskId: id,
        });
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🗑️', title: result.deleted ? 'Task deletion settled' : 'Task already absent',
          fields: [{ label: 'ID', value: id, kind: 'code' }],
        }));
      } catch (e) {
        await taskRoomService(opts.configuration).recordDeletionError({
          actor: { kind: 'internal_worker', surface: 'cli' }, taskId: id,
          error: errorText(e),
          recoveryHint: `External delete worker failed. Retry task delete ${id} ${id}.`,
        }).catch(() => {});
        if (opts.json) die(e);
        dieTaskRoom(e);
      }
    });

  cOpt(taskCmd.command('_recover <id>', { hidden: true }))
    .description('internal: settle and continue task recovery')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      const app = taskRoomService(opts.configuration);
      const actor = { kind: 'internal_worker' as const, surface: 'cli' as const };
      try {
        const begin = await app.beginTaskRecovery({ actor, taskId: id });
        if (begin.kind === 'deletion_worker_required') {
          const settled = await app.settleTaskDeletion({ actor, taskId: id });
          console.log(JSON.stringify({ schema_version: 1, deletion: settled }, null, 2));
          return;
        }
        const result = begin.kind === 'terminal_worker_required'
          ? await (async () => {
            try { await app.settleTask({ actor, taskId: id }); }
            catch (error) {
              await app.recordSettlementError({
                actor, taskId: id, error: errorText(error),
                recoveryHint: `External settle worker failed. Retry task recover ${id}.`,
              }).catch(() => {});
              throw error;
            }
            return app.continueTaskRecovery({ actor, taskId: id, terminalTimedOut: false });
          })()
          : begin.result;
        console.log(JSON.stringify({ schema_version: 1, recovery: result }, null, 2));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('work <id>'))
    .description('deprecated alias for task start')
    .option('--template <name>', 'room template')
    .option('--members-file <path>', 'typed YAML member overrides')
    .option('--member <slot>', 'begin a typed member override block')
    .option('--agent-template <id>', 'Agent Template for current member')
    .option('--brain <id>', 'Brain preset for current member')
    .option('--role <id>', 'Role preset for current member')
    .option('--approval <mode>', 'approval for current member')
    .option('--filesystem <mode>', 'filesystem for current member')
    .option('--unattended <mode>', 'unattended policy for current member')
    .option('--cwd <path>', 'working directory for current member')
    .option('--model <id>', 'model for current member')
    .option('--effort <level>', 'reasoning effort for current member')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; template?: string; json?: boolean; membersFile?: string }, command: Command) => {
      try {
        const previous = getTask(id).state;
        console.error('warning: `fleet task work` is deprecated; use `fleet task start`');
        const result = await taskRoomService(opts.configuration).ensureTaskWork({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id, template: opts.template,
          members: cliMemberOverrides(opts.membersFile, commandArgv(command)),
        });
        const t = result.task;
        auditTask('work', t, previous);
        if (result.status === 'already_active') {
          if (opts.json) {
            console.log(JSON.stringify({ schema_version: 1, task: t, status: 'already_active' }, null, 2));
            return;
          }
          console.log(taskActionMarkdown('Task already active', t,
            t.room_id ? [{ label: 'Room', value: t.room_id, kind: 'code' }] : []));
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🛠️', title: 'Task work ready',
          fields: [
            { label: 'ID', value: t.task_id, kind: 'code' },
            { label: 'Status', value: taskStatus(t.state), kind: 'markdown' },
            ...(t.template ? [{ label: 'Template', value: `${t.template.name}@${t.template.version}`, kind: 'code' as const }] : []),
            ...(t.room_id ? [{ label: 'Room', value: t.room_id, kind: 'code' as const }] : []),
          ],
          sections: t.member_roles.length ? [{ heading: 'Agents', markdownItems: t.member_roles.map(m =>
            `${markdownCode(m.name)} — ${markdownProse(m.cowork_role)}`) }] : [],
        }));
      } catch (e) {
        if (e instanceof TaskRoomApplicationError)
          e = taskRoomPublicError(e.code as TaskRoomPublicErrorCode, e.fields);
        if (opts.json) die(e); dieTaskRoom(e);
      }
    });

  cOpt(taskCmd.command('finish <id>'))
    .description('finish a task: transition to done and close its room')
    .option('--summary <text>', 'completion summary')
    .option('--summary-file <path>', 'completion summary from file')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; summary?: string; summaryFile?: string; json?: boolean }) => {
      try {
        const previous = getTask(id).state;
        let summary = opts.summary;
        if (opts.summaryFile) summary = readFileSync(opts.summaryFile, 'utf8');
        const outcome = summary ? { summary } : undefined;

        const plan = await taskRoomService(opts.configuration).finishTask({
          actor: { kind: 'local_control', surface: 'cli' }, taskId: id, outcome,
        });
        if (plan.task.terminal_intent?.status === 'pending') auditTask('settling', plan.task,
          previous, previous, plan.task.terminal_intent.accepted_at);
        const settled = plan.settlementRequired
          ? await launchTaskSettleWorker(id, opts.configuration)
          : { task: plan.task, timedOut: false };
        const t = settled.task;
        auditTask('finish', t, previous);

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2));
          return;
        }
        if (settled.timedOut) {
          console.log(renderMarkdownFailure({
            kind: 'pending', subject: `task finish ${id}`,
            detail: 'The finish request was accepted and is still being settled.',
            action: `Run ours-fleet task recover ${id}.`,
          }));
          return;
        }
        console.log(taskActionMarkdown('Task finished', t,
          t.outcome ? [{ label: 'Summary', value: t.outcome.summary, multiline: true }] : []));
      } catch (e) {
        if (e instanceof TaskRoomApplicationError)
          e = taskRoomPublicError(e.code as TaskRoomPublicErrorCode, e.fields);
        if (opts.json) die(e); dieTaskRoom(e);
      }
    });
}

export function registerRoomCommands(parent: Command, cOpt: (cmd: Command) => Command): void {
  const roomCmd = parent.command('room').description('room orchestration operations');

  cOpt(roomCmd.command('create'))
    .description('create a standalone room')
    .requiredOption('--name <name>', 'room name')
    .option('--template <name>', 'room template')
    .option('--goal <text>', 'room goal')
    .option('--brief <text>', 'room briefing')
    .option('--brief-file <path>', 'room briefing from file')
    .option('--members-file <path>', 'typed YAML member overrides')
    .option('--member <slot>', 'begin a typed member override block')
    .option('--agent-template <id>', 'Agent Template for current member')
    .option('--brain <id>', 'Brain preset for current member')
    .option('--role <id>', 'Role preset for current member')
    .option('--approval <mode>', 'approval for current member')
    .option('--filesystem <mode>', 'filesystem for current member')
    .option('--unattended <mode>', 'unattended policy for current member')
    .option('--cwd <path>', 'working directory for current member')
    .option('--model <id>', 'model for current member')
    .option('--effort <level>', 'reasoning effort for current member')
    .option('--json', 'JSON output')
    .action(async (opts: {
      configuration?: string; name: string; template?: string;
      goal?: string; brief?: string; briefFile?: string; json?: boolean; membersFile?: string;
    }, command: Command) => {
      try {
        const record = await taskRoomService(opts.configuration).createRoom({
          actor: { kind: 'local_control', surface: 'cli' }, name: opts.name,
          template: opts.template, goal: opts.goal, brief: opts.brief, briefFile: opts.briefFile,
          members: cliMemberOverrides(opts.membersFile, commandArgv(command)),
        });

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: record }, null, 2));
          return;
        }
        console.log(roomActionMarkdown('Room created', record, [
          { label: 'Name', value: record.room_name },
          ...(record.template_snapshot ? [{ label: 'Template', value: `${record.template_snapshot.name}@${record.template_snapshot.version}`, kind: 'code' as const }] : []),
        ]));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(roomCmd.command('list'))
    .description('list rooms')
    .option('--state <state>', 'filter live rooms by state (active|provisioning|all)')
    .option('--json', 'JSON output')
    .action(async (opts: { configuration?: string; state?: string; json?: boolean }) => {
      try {
        if (opts.state && !['active', 'provisioning', 'all'].includes(opts.state))
          throw taskRoomPublicError('room_filter');
        const stateFilter = opts.state === 'active' || opts.state === 'provisioning'
          ? opts.state : undefined;
        const rooms = await taskRoomService(opts.configuration).listRooms(
          stateFilter ? { state: stateFilter } : undefined);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, rooms }, null, 2));
          return;
        }
        console.log(renderMarkdownList({
          icon: '🏠', title: 'Rooms', empty: 'No rooms found.',
          records: rooms.map(r =>
            `${roomStatus(r.state)} ${markdownCode(r.room_id)} — ${markdownProse(r.room_name)}`
            + (r.orchestration?.task_id ? ` — Task ${markdownCode(r.orchestration.task_id)}` : '')),
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(roomCmd.command('show <id>'))
    .description('show room details')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const { room: cowork, orchestration: r } =
          await taskRoomService(opts.configuration).getRoomDetail(id);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: cowork, orchestration: r ?? null }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🏠', title: 'Room details',
          fields: [
            { label: 'ID', value: cowork.room_id, kind: 'code' },
            { label: 'Name', value: cowork.room_name },
            { label: 'Status', value: roomStatus(cowork.state), kind: 'markdown' },
            { label: 'Identity CID', value: cowork.identity_cid, kind: 'code' },
            ...(r?.task_id ? [{ label: 'Task', value: r.task_id, kind: 'code' as const }] : []),
            ...(r ? [{ label: 'Saga', value: `${r.saga.phase} (step ${r.saga.step_index})` }] : []),
            ...(r?.provisioning_detail ? [{ label: 'Detail', value: r.provisioning_detail }] : []),
            ...(r?.saga.error ? [{ label: 'Last error', value: 'Provisioning failure recorded; inspect role logs.' }] : []),
            ...(r ? [{ label: 'Tracked since', value: r.created_at, kind: 'code' as const }] : []),
          ],
          sections: [
            ...(cowork.seats.length ? [{
              heading: 'Members', markdownItems: cowork.seats.map(s =>
                `${markdownCode(s.identity_cid)} — ${markdownProse(s.role)} — ${markdownProse(s.seat_state)}`),
            }] : []),
            ...(r ? roomStartupSections(r) : []),
          ],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(roomCmd.command('open <id>'))
    .description('open room in Cowork local console')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const { room, orchestration } = await taskRoomService(opts.configuration).getRoomDetail(id);
        const url = `http://localhost:4460/room/${id}`;
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room_id: id, url, room_name: room.room_name }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🏠', title: 'Room console',
          fields: [
            { label: 'Room', value: id, kind: 'code' },
            { label: 'Name', value: room.room_name },
            { label: 'Local console', value: url, kind: 'code' },
          ],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(roomCmd.command('members <id>'))
    .description('show room members')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const { orchestration: r, members } =
          await taskRoomService(opts.configuration).getRoomMembers(id);
        if (opts.json) {
          console.log(JSON.stringify({
            schema_version: 1,
            room_id: id,
            members,
            owner_seat_cid: r?.owner_seat_cid ?? null,
          }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '👥', title: 'Room members',
          fields: [
            { label: 'Room', value: id, kind: 'code' },
            ...(r ? [{ label: 'Name', value: r.room_name }] : []),
            ...(r?.owner_seat_cid ? [{ label: 'Owner', value: r.owner_seat_cid, kind: 'code' as const }] : []),
          ],
          sections: [{
            heading: 'Members',
            ...(members.length ? { markdownItems: members.map(s =>
              `${markdownCode(s.identity_cid)} — ${markdownProse(s.role)} — ${markdownProse(s.seat_state)}`) }
              : { items: ['No members found.'] }),
          }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  const deleteAction = async (
    id: string, confirmId: string,
    opts: { configuration?: string; json?: boolean },
  ): Promise<void> => {
      try {
        if (id !== confirmId) throw taskRoomPublicError('room_confirmation_mismatch');
        const previous = getRoomRecord(id);
        await taskRoomService(opts.configuration).requestRoomDeletion({
          actor: { kind: 'local_control', surface: 'cli' }, roomId: id,
        });
        const closing = getRoomRecord(id);
        if (previous && closing && previous.state !== closing.state)
          auditRoom('close', closing, previous.state, closing.state);
        const settled = await launchRoomDeleteWorker(id, opts.configuration);
        if (closing) auditRoom('delete', closing, closing.state,
          settled.deleted ? 'deleted' : 'closing');
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room_id: id, deleted: settled.deleted }, null, 2));
          return;
        }
        if (settled.timedOut) {
          console.log(renderMarkdownFailure({
            kind: 'pending', subject: `room delete ${id} ${id}`,
            detail: 'The deletion request was accepted and is still being settled.',
            action: `Run ours-fleet room delete ${id} ${id} or room recover ${id}.`,
          }));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🗑️', title: 'Room deleted',
          fields: [{ label: 'ID', value: id, kind: 'code' }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    };

  cOpt(roomCmd.command('delete <id> <confirm-id>'))
    .description('delete a room (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action(deleteAction);

  cOpt(roomCmd.command('close <id> <confirm-id>'))
    .description('deprecated alias for room delete (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action(deleteAction);

  cOpt(roomCmd.command('recover <id>'))
    .description('attempt to recover a stuck room')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const previous = getRoomRecord(id);
        const recovered = await taskRoomService(opts.configuration).recoverRoom({
          actor: { kind: 'local_control', surface: 'cli' }, roomId: id,
        });
        if (recovered.kind === 'deletion_worker_required') {
          const settled = await launchRoomDeleteWorker(id, opts.configuration);
          if (previous) auditRoom('recover', previous, previous.state,
            settled.deleted ? 'deleted' : 'closing');
          if (opts.json) {
            console.log(JSON.stringify({
              schema_version: 1, room: null, orchestration: null,
              recovery_actions: [settled.timedOut
                ? `Deletion remains pending — retry room delete ${id} ${id}`
                : 'Deletion completed successfully'],
            }, null, 2));
            return;
          }
          console.log(renderMarkdownResult({
            icon: settled.timedOut ? '⏳' : '🗑️',
            title: settled.timedOut ? 'Room deletion pending' : 'Room deleted',
            fields: [{ label: 'ID', value: id, kind: 'code' }],
            sections: [{ heading: 'Next step', items: [settled.timedOut
              ? `Run ours-fleet room delete ${id} ${id} or room recover ${id} again.`
              : 'No recovery action is needed.'] }],
          }));
          return;
        }
        const { room: cowork, orchestration: r, issues: actions } = recovered;
        if (r) auditRoom('recover', r, previous?.state ?? 'unresolved', r.state);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: cowork, orchestration: r ?? null, recovery_actions: actions }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🛟', title: 'Room recovery',
          fields: [
            { label: 'Room', value: cowork.room_id, kind: 'code' },
            { label: 'Status', value: roomStatus(cowork.state), kind: 'markdown' },
            ...(r ? [{ label: 'Saga', value: r.saga.phase, kind: 'code' as const }] : []),
          ],
          sections: actions.length ? [{ heading: 'Next steps', items: actions }]
            : [{ heading: 'Result', items: ['No recovery action is needed.'] }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  const internalDeleteAction = async (
    id: string, opts: { configuration?: string; json?: boolean },
  ): Promise<void> => {
      try {
        const app = taskRoomService(opts.configuration);
        const result = await app.settleRoomDeletion({
          actor: { kind: 'internal_worker', surface: 'cli' }, roomId: id,
        });
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🗑️', title: 'Room deleted',
          fields: [{ label: 'ID', value: id, kind: 'code' }],
        }));
      } catch (e) {
        await taskRoomService(opts.configuration).recordRoomSettlementError({
          actor: { kind: 'internal_worker', surface: 'cli' }, roomId: id, error: errorText(e),
          recoveryHint: `External delete worker failed. Retry room delete ${id} ${id}.`,
        }).catch(() => {});
        if (opts.json) die(e);
        dieTaskRoom(e);
      }
    };

  cOpt(roomCmd.command('_delete <id>', { hidden: true }))
    .description('internal: settle an accepted room deletion')
    .option('--json', 'JSON output')
    .action(internalDeleteAction);

  cOpt(roomCmd.command('_close <id>', { hidden: true }))
    .description('deprecated internal alias for room _delete')
    .option('--json', 'JSON output')
    .action(internalDeleteAction);
}
