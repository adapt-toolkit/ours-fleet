import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadConfig, type FleetConfig, ConfigError, findRole } from '../config.js';
import { provisionMembers, getBinPath } from './provision.js';
import {
  acceptManagedRoomClose, deleteLegacyClosedRooms, deleteManagedRoom,
  recordManagedRoomCloseError,
} from './close.js';
import {
  acceptTaskTerminalIntent, recordTaskTerminalIntentError, settleTaskTerminalIntent,
} from './terminal.js';
import { launchFleetWorker } from './external-worker.js';
import {
  resolveTemplate, listTemplates, snapshotTemplate, hashTemplate,
  BUILTIN_TEMPLATES,
} from './templates.js';
import {
  createTask, getTask, listTasks, startTask, activateTask,
  blockTask, unblockTask, reviewTask,
  updateTaskRoom, updateTaskTemplate, updateTaskMembers, failTask, deleteTask, TaskStateError,
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
      action: 'Run ours-fleet template list and retry with an available template.',
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
  process.exit(1);
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
    new RegExp(`^cannot delete a '${TASK_STATE_WORD}' task; only 'done' tasks can be deleted$`, 'u'),
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
  if (e instanceof TaskRoomPublicError) {
    const failure = taskRoomPublicFailure(e);
    const output = renderMarkdownFailure({
      kind: failure.kind, subject: 'ours-fleet task/room', detail: failure.detail,
      action: failure.action,
    });
    process.stderr.write(`${output}\n`);
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
  process.exit(1);
}

const taskListMarkdown = (tasks: ReturnType<typeof listTasks>, title = 'Tasks'): string =>
  renderMarkdownList({
    icon: '📋', title, empty: 'No tasks found.',
    records: tasks.map(t =>
      `${taskStatus(t.state)} ${markdownCode(t.task_id)} — ${markdownProse(t.title)}`
      + (t.blocked ? ` — 🚧 Blocked: ${markdownProse(t.blocked.reason)}` : '')),
  });

const taskActionMarkdown = (
  title: string, task: ReturnType<typeof getTask>,
  fields: Parameters<typeof renderMarkdownResult>[0]['fields'] = [],
): string => renderMarkdownResult({
  icon: '📋', title,
  fields: [
    { label: 'ID', value: task.task_id, kind: 'code' },
    { label: 'Status', value: taskStatus(task.state), kind: 'markdown' },
    ...fields,
  ],
});

const roomActionMarkdown = (
  title: string, room: RoomOrchestrationRecord,
  fields: Parameters<typeof renderMarkdownResult>[0]['fields'] = [],
): string => renderMarkdownResult({
  icon: '🏠', title,
  fields: [
    { label: 'ID', value: room.room_id, kind: 'code' },
    { label: 'Status', value: roomStatus(room.state), kind: 'markdown' },
    ...fields,
  ],
});

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
    await recordTaskTerminalIntentError(
      taskId, errorText(error),
      `External settle worker failed to start. Retry task recover ${taskId}.`,
    );
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
  return { task: getTask(taskId), timedOut: true };
}

async function launchRoomDeleteWorker(
  roomId: string, configPath?: string,
): Promise<{ deleted: boolean; timedOut: boolean }> {
  const previousErrorAt = getRoomRecord(roomId)?.close?.error_at;
  try {
    await launchFleetWorker(['room', '_delete', roomId], `room-delete-${roomId}`, configPath);
  } catch (error) {
    await recordManagedRoomCloseError(
      roomId, errorText(error),
      `External delete worker failed to start. Retry room delete ${roomId} ${roomId}.`,
    );
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
  return { deleted: getRoomRecord(roomId) === undefined, timedOut: true };
}

function loadCfg(opts: { configuration?: string }): FleetConfig {
  return loadConfig(opts.configuration);
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
  return snapshotTemplate(template);
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
      const briefing = seat.briefing?.state ?? 'unrecorded';
        return `${markdownCode(seat.role_name)} — ${markdownProse(seat.cowork_role)} — `
          + `seat ${markdownProse(seat.seat_state)}, launch ${markdownProse(launch)}, briefing ${markdownProse(briefing)}`
          + (seat.briefing?.acknowledgement_message_id ? ' — acknowledgement recorded' : '')
          + (seat.briefing?.last_rejected_ack_reason
            ? ' — rejected acknowledgement recorded; inspect role logs' : '')
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
  const briefing = input.brief?.trim() || input.template?.contract?.trim() || goal;
  const created = await cowork.createRoom({
    room_name: input.name,
    goal,
    briefing,
    quiet_membership: input.template?.room?.quiet_membership,
    anonymous: input.template?.room?.anonymous,
  });
  let record = createRoomRecord({
    room_id: created.room_id,
    room_name: input.name,
    room_identity_cid: created.identity_cid,
    task_id: input.taskId,
    template_snapshot: input.template,
  });
  input.onCreated?.(record);
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
      throw error;
    }
  }
  record = advanceSaga(record.room_id, 'create_members', 3);

  if (input.template && input.template.members.length > 0) {
    record = await provisionMembers({
      cfg,
      cowork,
      roomId: record.room_id,
      taskId: input.taskId,
      template: input.template,
      binPath: getBinPath(),
      brief: input.brief,
      goal: input.goal,
    });
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
        const cfg = loadCfg(opts);
        const templates = listTemplates(allTemplates(cfg));
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, templates }, null, 2));
          return;
        }
        if (!templates.length) { console.log('No templates configured.'); return; }
        for (const t of templates) {
          const tag = t.builtin ? ' (built-in)' : '';
          console.log(`${t.name}@${t.version}${tag}  ${t.description}`);
        }
      } catch (e) { die(e); }
    });

  cOpt(templateCmd.command('show <name>'))
    .description('show template details')
    .option('--json', 'JSON output')
    .action((name: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        const t = resolveTemplate(name, allTemplates(cfg));
        if (!t) die(new Error(`template not found: ${name}`));
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, template: { ...t, content_hash: hashTemplate(t) } }, null, 2));
          return;
        }
        console.log(`${t.name}@${t.version}  ${t.description}`);
        if (t.contract) console.log(`\nContract:\n${t.contract}`);
        console.log(`\nMembers:`);
        for (const m of t.members)
          console.log(`  ${m.slot}: ${m.count}× ${m.role} (ref: ${m.role_ref})`);
        console.log(`\nContent hash: ${hashTemplate(t)}`);
      } catch (e) { die(e); }
    });

  cOpt(templateCmd.command('validate'))
    .description('validate all room templates')
    .option('--json', 'JSON output')
    .action((opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        const templates = listTemplates(allTemplates(cfg));
        const problems: { template: string; issues: string[] }[] = [];
        for (const t of templates) {
          const issues: string[] = [];
          for (const m of t.members) {
            if (!cfg.roles.some(r => r.name === m.role_ref))
              issues.push(`member ${m.slot}: role_ref '${m.role_ref}' not found in fleet roles`);
          }
          if (issues.length) problems.push({ template: `${t.name}@${t.version}`, issues });
        }
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
    .option('--json', 'JSON output')
    .action(async (opts: {
      configuration?: string; title: string; template?: string;
      brief?: string; briefFile?: string; backlog?: boolean;
      room?: boolean; idempotencyKey?: string; json?: boolean;
    }) => {
      try {
        const cfg = loadCfg(opts);
        let templateRef;
        if (opts.template) {
          const t = resolveTemplate(opts.template, allTemplates(cfg));
          if (!t) throw taskRoomPublicError('template_not_found', { template: opts.template });
          const snap = snapshotTemplate(t);
          templateRef = { name: snap.name, version: snap.version, content_hash: snap.content_hash };
        } else if (opts.room !== false) {
          const defaultTpl = cfg.tasks?.default_room_template ?? cfg.rooms?.defaults?.template ?? 'team';
          const t = resolveTemplate(defaultTpl, allTemplates(cfg));
          if (t) {
            const snap = snapshotTemplate(t);
            templateRef = { name: snap.name, version: snap.version, content_hash: snap.content_hash };
          }
        }

        let brief = opts.brief;
        if (opts.briefFile) {
          brief = readFileSync(opts.briefFile, 'utf8');
        }

        const origin: TaskOrigin = { type: 'cli' };
        let record = createTask({
          title: opts.title,
          brief,
          brief_file: opts.briefFile,
          template: templateRef,
          origin,
          idempotency_key: opts.idempotencyKey,
          start: !opts.backlog,
        });

        if (!opts.backlog && opts.room !== false && templateRef && !record.room_id) {
          const template = resolveRoomTemplate(cfg, templateRef.name);
          try {
            await provisionRoom(cfg, {
              name: opts.title,
              goal: opts.title,
              brief,
              template,
              taskId: record.task_id,
              onCreated: room => {
                record = updateTaskRoom(record.task_id, room.room_id, room.room_identity_cid!);
              },
            });
            record = getTask(record.task_id);
          } catch (error) {
            if (error instanceof CoworkUnavailableError) {
              blockTask(record.task_id, 'Cowork management socket is unavailable');
            }
            throw error;
          }
        }

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: record }, null, 2));
          return;
        }
        console.log(taskActionMarkdown('Task created', record, [
          { label: 'Title', value: record.title },
          ...(templateRef ? [{ label: 'Template', value: `${templateRef.name}@${templateRef.version}`, kind: 'code' as const }] : []),
        ]));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('list'))
    .description('list tasks')
    .option('--state <state>', 'filter by state (backlog|active|provisioning|review|done|cancelled|failed|all)')
    .option('--json', 'JSON output')
    .action((opts: { configuration?: string; state?: string; json?: boolean }) => {
      try {
        let stateFilter: import('./types.js').TaskState | undefined;
        if (opts.state && opts.state !== 'all') {
          stateFilter = opts.state as import('./types.js').TaskState;
        }
        const tasks = listTasks(stateFilter ? { state: stateFilter } : undefined);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, tasks }, null, 2));
          return;
        }
        console.log(taskListMarkdown(tasks));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('show <id>')
    .description('show task details')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = getTask(id);
        const room = t.room_id ? getRoomRecord(t.room_id) : undefined;
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
    .description('start a backlog task')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        let t = startTask(id);
        if (t.template && !t.room_id) {
          const template = resolveRoomTemplate(cfg, t.template.name);
          if (!template || template.content_hash !== t.template.content_hash)
            throw taskRoomPublicError('task_template_drift', {
              template: `${t.template.name}@${t.template.version}`,
            });
          await provisionRoom(cfg, {
            name: t.title,
            goal: t.title,
            brief: t.brief,
            template,
            taskId: t.task_id,
            onCreated: room => {
              t = updateTaskRoom(t.task_id, room.room_id, room.room_identity_cid!);
            },
          });
          t = getTask(t.task_id);
        }
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task started', t));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('block <id>')
    .description('mark a task as blocked')
    .requiredOption('--reason <reason>', 'blocking reason')
    .option('--json', 'JSON output')
    .action((id: string, opts: { reason: string; json?: boolean }) => {
      try {
        const t = blockTask(id, opts.reason);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task blocked', t, [{ label: 'Reason', value: opts.reason }]));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('unblock <id>')
    .description('unblock a task')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = unblockTask(id);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(taskActionMarkdown('Task unblocked', t));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  taskCmd.command('review <id>')
    .description('move a task to review')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = reviewTask(id);
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
        let summary = opts.summary;
        if (opts.summaryFile) summary = readFileSync(opts.summaryFile, 'utf8');
        const outcome = summary ? { summary } : undefined;
        const current = getTask(id);
        if (TASK_TERMINAL_STATES.includes(current.state))
          throw new TaskStateError(`task ${id} is already in terminal state '${current.state}'`);
        if (current.state !== 'review')
          throw new TaskStateError(`cannot transition from '${current.state}' to 'done'`);
        let roomId: string | undefined;
        let cfg: FleetConfig | undefined;
        if (current.room_id) {
          cfg = loadCfg(opts);
          const shouldClose = cfg.tasks?.close_room_on_done
            ?? cfg.rooms?.defaults?.close_when_task_done
            ?? false;
          if (shouldClose) roomId = current.room_id;
        }
        await acceptTaskTerminalIntent({ taskId: id, kind: 'done', roomId, outcome });
        const settled = roomId
          ? await launchTaskSettleWorker(id, opts.configuration)
          : { task: getTask(id), timedOut: false };
        const t = settled.task;
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
        const current = getTask(id);
        if (!TASK_CANCELLABLE_STATES.includes(current.state))
          throw new TaskStateError(`cannot cancel a '${current.state}' task`);
        if (current.room_id) loadCfg(opts);
        await acceptTaskTerminalIntent({
          taskId: id, kind: 'cancelled', roomId: current.room_id,
        });
        const settled = current.room_id
          ? await launchTaskSettleWorker(id, opts.configuration)
          : { task: getTask(id), timedOut: false };
        const t = settled.task;
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
    .description('delete a done task from the backlog (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action((id: string, confirmId: string, opts: { json?: boolean }) => {
      try {
        if (id !== confirmId) throw taskRoomPublicError('task_confirmation_mismatch');
        const deleted = deleteTask(id);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task_id: id, deleted }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🗑️', title: deleted ? 'Task deleted' : 'Task already absent',
          fields: [{ label: 'ID', value: id, kind: 'code' }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('recover <id>'))
    .description('attempt to recover a stuck task')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        let t = getTask(id);
        let terminalTimedOut = false;
        if (t.terminal_intent?.status === 'pending') {
          const settled = await launchTaskSettleWorker(id, opts.configuration);
          t = settled.task;
          terminalTimedOut = settled.timedOut;
        }
        let room = t.room_id ? getRoomRecord(t.room_id) : undefined;
        const result = {
          task: t,
          room: room ?? null,
          recovery_actions: [] as string[],
        };
        if (terminalTimedOut) {
          result.recovery_actions.push(`Terminal intent remains pending — retry task recover ${id}`);
        }
        if (t.state === 'provisioning' && room) {
          if (room.provisioning_detail === 'waiting_cowork')
            result.recovery_actions.push('Cowork management socket unreachable — check ours-cowork service');
          if (room.provisioning_detail === 'waiting_owner_invite')
            result.recovery_actions.push('Owner invite invalid or expired — rotate rooms.owner.public_invite in config');
          if (room.provisioning_detail === 'owner_cid_mismatch')
            result.recovery_actions.push('Owner CID mismatch — verify rooms.owner.expected_cid matches Messenger identity');
          if (room.provisioning_detail === 'member_failed')
            result.recovery_actions.push(`Member creation failed at saga step ${room.saga.step_index} — inspect and retry`);
          if (room.provisioning_detail === 'waiting_briefing_acks')
            result.recovery_actions.push('Members are not ready — inspect per-seat briefing and ACK evidence, then retry recovery');
          if (room.provisioning_detail === 'briefing_delivery_failed')
            result.recovery_actions.push('Cowork briefing relay failed terminally — replace the seat or use a Cowork-supported redelivery');

          const resumable: import('./types.js').SagaPhase[] =
            ['create_members', 'configure_briefings', 'join_role_groups', 'wait_seats',
              'launch_work', 'wait_briefing_acks', 'activate'];
          if (resumable.includes(room.saga.phase)) {
            const template = durableTaskRoomTemplate(t, room);
            if (template) {
              try {
                await provisionMembers({
                  cfg,
                  cowork: coworkFor(cfg),
                  roomId: room.room_id,
                  taskId: t.task_id,
                  template,
                  binPath: getBinPath(),
                  brief: t.brief,
                  goal: t.title,
                });
                t = getTask(t.task_id);
                room = getRoomRecord(room.room_id);
                result.task = t;
                result.room = room ?? null;
                result.recovery_actions = ['Provisioning resumed successfully'];
              } catch (error) {
                result.recovery_actions.push(
                  `Resume failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          }
        }
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
          sections: result.recovery_actions.length
            ? [{ heading: 'Next steps', items: result.recovery_actions }]
            : [{ heading: 'Result', items: ['No automated recovery action is available.'] }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('_settle <id>', { hidden: true }))
    .description('internal: settle a previously accepted task terminal intent')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        const t = await settleTaskTerminalIntent({ taskId: id, cowork: coworkFor(cfg) });
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2));
          return;
        }
        console.log(taskActionMarkdown('Task terminal action settled', t));
      } catch (e) {
        await recordTaskTerminalIntentError(
          id, errorText(e), `External settle worker failed. Retry task recover ${id}.`,
        ).catch(() => {});
        if (opts.json) die(e);
        dieTaskRoom(e);
      }
    });

  cOpt(taskCmd.command('work <id>'))
    .description('ensure a task has a room and agents running')
    .option('--template <name>', 'room template')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; template?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        let t = getTask(id);

        if (TASK_TERMINAL_STATES.includes(t.state))
          throw taskRoomPublicError('task_terminal', { task: id, state: t.state });

        if (t.state === 'active' && t.room_id) {
          // An explicit --template must agree with the room the task already
          // runs in; a conflicting override is an error, not a silent no-op.
          if (opts.template) {
            const override = resolveTemplate(opts.template, allTemplates(cfg));
            if (!override) throw taskRoomPublicError('template_not_found', { template: opts.template });
            const overrideSnap = snapshotTemplate(override);
            const roomSnap = getRoomRecord(t.room_id)?.template_snapshot ?? t.template;
            if (roomSnap && (roomSnap.name !== overrideSnap.name || roomSnap.content_hash !== overrideSnap.content_hash))
              throw taskRoomPublicError('template_mismatch', {
                requested: `${overrideSnap.name}@${overrideSnap.version}`, room: t.room_id,
                provisioned: `${roomSnap.name}@${roomSnap.version}`,
              });
          }
          if (opts.json) {
            console.log(JSON.stringify({ schema_version: 1, task: t, status: 'already_active' }, null, 2));
            return;
          }
          console.log(taskActionMarkdown('Task already active', t,
            t.room_id ? [{ label: 'Room', value: t.room_id, kind: 'code' }] : []));
          return;
        }

        // Select and validate the template snapshot before any state change or
        // provisioning. An explicit --template re-pins the task; a stored ref
        // must still match its snapshot (same contract as `task start`).
        const existingRoom = t.room_id ? getRoomRecord(t.room_id) : undefined;
        const durableSnapshot = existingRoom ? durableTaskRoomTemplate(t, existingRoom) : undefined;
        const templateName = opts.template
          ?? durableSnapshot?.name
          ?? t.template?.name
          ?? cfg.tasks?.default_room_template
          ?? cfg.rooms?.defaults?.template
          ?? 'single';
        const resolved = durableSnapshot && !opts.template
          ? undefined : resolveTemplate(templateName, allTemplates(cfg));
        if (!durableSnapshot && !resolved)
          throw taskRoomPublicError('template_not_found', { template: templateName });
        if (opts.template && !resolved)
          throw taskRoomPublicError('template_not_found', { template: templateName });
        if (durableSnapshot && resolved) {
          const requested = snapshotTemplate(resolved);
          if (requested.name !== durableSnapshot.name
              || requested.content_hash !== durableSnapshot.content_hash) {
            throw taskRoomPublicError('template_mismatch', {
              requested: `${requested.name}@${requested.version}`, room: existingRoom!.room_id,
              provisioned: `${durableSnapshot.name}@${durableSnapshot.version}`,
            });
          }
        }
        const snap = durableSnapshot ?? snapshotTemplate(resolved!);
        if (!opts.template && t.template && snap.content_hash !== t.template.content_hash)
          throw taskRoomPublicError('task_template_drift', {
            template: `${t.template.name}@${t.template.version}`,
          });
        // A provisioned room is pinned to its snapshot: never resume or re-pin
        // an existing room under a different template.
        if (t.room_id) {
          const roomSnap = getRoomRecord(t.room_id)?.template_snapshot;
          if (roomSnap && (roomSnap.name !== snap.name || roomSnap.content_hash !== snap.content_hash))
            throw taskRoomPublicError('template_mismatch', {
              requested: `${snap.name}@${snap.version}`, room: t.room_id,
              provisioned: `${roomSnap.name}@${roomSnap.version}`,
            });
        }
        let templateRef = t.template;
        if (!templateRef || templateRef.name !== snap.name || templateRef.content_hash !== snap.content_hash) {
          templateRef = { name: snap.name, version: snap.version, content_hash: snap.content_hash };
          t = updateTaskTemplate(t.task_id, templateRef);
        }

        if (t.state === 'backlog') {
          t = startTask(id);
        }

        if (!t.room_id) {
          try {
            await provisionRoom(cfg, {
              name: t.title,
              goal: t.title,
              brief: t.brief,
              template: snap,
              taskId: t.task_id,
              onCreated: room => {
                t = updateTaskRoom(t.task_id, room.room_id, room.room_identity_cid!);
              },
            });
            t = getTask(t.task_id);
          } catch (error) {
            if (error instanceof CoworkUnavailableError) {
              blockTask(t.task_id, 'Cowork management socket is unavailable');
            }
            throw error;
          }
        } else if (t.state === 'provisioning') {
          // The task already has a room mid-provisioning (e.g. seats were still
          // pending on the last run). Resume it exactly as `task recover` does.
          const room = getRoomRecord(t.room_id);
          const resumable: import('./types.js').SagaPhase[] =
            ['create_members', 'configure_briefings', 'join_role_groups', 'wait_seats',
              'launch_work', 'wait_briefing_acks', 'activate'];
          if (room && resumable.includes(room.saga.phase)) {
            try {
              await provisionMembers({
                cfg,
                cowork: coworkFor(cfg),
                roomId: room.room_id,
                taskId: t.task_id,
                template: snap,
                binPath: getBinPath(),
                brief: t.brief,
                goal: t.title,
              });
            } catch (error) {
              if (error instanceof CoworkUnavailableError) {
                blockTask(t.task_id, 'Cowork management socket is unavailable');
              }
              throw error;
            }
            t = getTask(t.task_id);
          } else {
            throw taskRoomPublicError('task_non_resumable', { task: id, room: t.room_id });
          }
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
            ...(templateRef ? [{ label: 'Template', value: `${templateRef.name}@${templateRef.version}`, kind: 'code' as const }] : []),
            ...(t.room_id ? [{ label: 'Room', value: t.room_id, kind: 'code' as const }] : []),
          ],
          sections: t.member_roles.length ? [{
            heading: 'Agents', markdownItems: t.member_roles.map(m =>
              `${markdownCode(m.name)} — ${markdownProse(m.cowork_role)}`),
          }] : [],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(taskCmd.command('finish <id>'))
    .description('finish a task: transition to done and close its room')
    .option('--summary <text>', 'completion summary')
    .option('--summary-file <path>', 'completion summary from file')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; summary?: string; summaryFile?: string; json?: boolean }) => {
      try {
        let summary = opts.summary;
        if (opts.summaryFile) summary = readFileSync(opts.summaryFile, 'utf8');
        const outcome = summary ? { summary } : undefined;

        let t = getTask(id);

        if (TASK_TERMINAL_STATES.includes(t.state))
          throw taskRoomPublicError('task_terminal_already', { task: id, state: t.state });

        if (t.state === 'active') {
          reviewTask(id);
        }

        if (t.room_id) loadCfg(opts); // validate configuration before durable acceptance
        await acceptTaskTerminalIntent({ taskId: id, kind: 'done', roomId: t.room_id, outcome });
        const settled = t.room_id
          ? await launchTaskSettleWorker(id, opts.configuration)
          : { task: getTask(id), timedOut: false };
        t = settled.task;

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
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
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
    .option('--json', 'JSON output')
    .action(async (opts: {
      configuration?: string; name: string; template?: string;
      goal?: string; brief?: string; briefFile?: string; json?: boolean;
    }) => {
      try {
        const cfg = loadCfg(opts);
        let brief = opts.brief;
        if (opts.briefFile) brief = readFileSync(opts.briefFile, 'utf8');

        let templateSnapshot;
        if (opts.template) {
          const t = resolveTemplate(opts.template, allTemplates(cfg));
          if (!t) throw taskRoomPublicError('template_not_found', { template: opts.template });
          templateSnapshot = snapshotTemplate(t);
        }

        const record = await provisionRoom(cfg, {
          name: opts.name,
          goal: opts.goal,
          brief,
          template: templateSnapshot,
        });

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: record }, null, 2));
          return;
        }
        console.log(roomActionMarkdown('Room created', record, [
          { label: 'Name', value: record.room_name },
          ...(templateSnapshot ? [{ label: 'Template', value: `${templateSnapshot.name}@${templateSnapshot.version}`, kind: 'code' as const }] : []),
        ]));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  cOpt(roomCmd.command('list'))
    .description('list rooms')
    .option('--state <state>', 'filter live rooms by state (active|provisioning|all)')
    .option('--json', 'JSON output')
    .action(async (opts: { configuration?: string; state?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        if (opts.state && !['active', 'provisioning', 'all'].includes(opts.state))
          throw taskRoomPublicError('room_filter');
        const stateFilter = opts.state === 'active' || opts.state === 'provisioning'
          ? opts.state : undefined;
        const adapter = coworkFor(cfg);
        await deleteLegacyClosedRooms({ cowork: adapter });
        const local = new Map(listRoomRecords().map(room => [room.room_id, room]));
        const coworkRooms = await adapter.listRooms();
        const rooms = coworkRooms
          .filter(room => room.state === 'active' || room.state === 'provisioning')
          .filter(room => {
            const tracked = local.get(room.room_id);
            return !tracked || tracked.state === 'active' || tracked.state === 'provisioning';
          })
          .filter(room => !stateFilter || room.state === stateFilter)
          .map(room => ({ ...room, orchestration: local.get(room.room_id) ?? null }));
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
        const cfg = loadCfg(opts);
        const tracked = getRoomRecord(id);
        if (tracked?.state === 'closing' || tracked?.state === 'closed')
          throw taskRoomPublicError('room_not_found', { room: id });
        const cowork = await coworkFor(cfg).getRoom(id);
        if (!cowork || cowork.state === 'closing' || cowork.state === 'closed')
          throw taskRoomPublicError('room_not_found', { room: id });
        const r = tracked;
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
        const cfg = loadCfg(opts);
        const tracked = getRoomRecord(id);
        if (tracked?.state === 'closing' || tracked?.state === 'closed')
          throw taskRoomPublicError('room_not_found', { room: id });
        const room = await coworkFor(cfg).getRoom(id);
        if (!room || room.state === 'closing' || room.state === 'closed')
          throw taskRoomPublicError('room_not_found', { room: id });
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
        const cfg = loadCfg(opts);
        const r = getRoomRecord(id);
        if (r?.state === 'closing' || r?.state === 'closed')
          throw taskRoomPublicError('room_not_found', { room: id });
        const adapter = coworkFor(cfg);
        const room = await adapter.getRoom(id);
        if (!room || room.state === 'closing' || room.state === 'closed')
          throw taskRoomPublicError('room_not_found', { room: id });
        const members = await adapter.getSeats(id);
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
        coworkFor(loadCfg(opts));
        const existing = getRoomRecord(id);
        if (!existing) throw taskRoomPublicError('room_record_not_found', { room: id });
        await acceptManagedRoomClose(id);
        const settled = await launchRoomDeleteWorker(id, opts.configuration);
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
        const cfg = loadCfg(opts);
        const adapter = coworkFor(cfg);
        let r = getRoomRecord(id);
        if (r?.state === 'closing' || r?.state === 'closed') {
          const settled = await launchRoomDeleteWorker(id, opts.configuration);
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
            sections: [{ heading: 'Next step', items: [
              settled.timedOut
                ? `Run ours-fleet room delete ${id} ${id} or room recover ${id} again.`
                : 'No recovery action is needed.',
            ] }],
          }));
          return;
        }
        const cowork = await adapter.recoverRoom(id);
        r = getRoomRecord(id);
        if (r && !r.owner_seat_cid
          && (r.provisioning_detail === 'waiting_owner_invite'
            || r.provisioning_detail === 'owner_cid_mismatch')) {
          const expected = cfg.rooms!.owner.expected_cid.toLowerCase();
          const existing = (await adapter.getSeats(id))
            .find(seat => seat.identity_cid.toLowerCase() === expected && seat.seat_state !== 'removed');
          if (!existing && !cfg.ownerInvite)
            throw new ConfigError('rooms.owner: configure public_invite or public_invite_file before recovery');
          let acceptedCid = existing?.identity_cid;
          if (!acceptedCid) {
            const accepted = await adapter.acceptInvite(id, cfg.ownerInvite!, {
              role: cfg.rooms!.owner.role,
              expected_cid: cfg.rooms!.owner.expected_cid,
            });
            acceptedCid = accepted.seat_cid;
          }
          setOwnerSeat(id, acceptedCid, cfg.ownerInviteFingerprint ?? '');
          r = advanceSaga(id, 'create_members', 3);
        }
        const actions: string[] = [];
        if (r?.saga.error) actions.push('A provisioning failure is recorded; inspect role logs for diagnostics.');
        if (r?.saga.recovery_hint) actions.push('Recovery guidance is recorded; inspect role logs for diagnostics.');
        if (r?.provisioning_detail === 'waiting_cowork')
          actions.push('Check ours-cowork service status');
        if (r?.provisioning_detail === 'waiting_owner_invite')
          actions.push('Rotate rooms.owner.public_invite in config, then re-run recover');
        if (r?.provisioning_detail === 'waiting_briefing_acks')
          actions.push('Inspect per-seat briefing and ACK evidence, then re-run recover');
        if (r?.provisioning_detail === 'briefing_delivery_failed')
          actions.push('Replace the failed seat or use a Cowork-supported briefing redelivery');

        if (r && r.state === 'provisioning') {
          const resumable: import('./types.js').SagaPhase[] =
            ['create_members', 'configure_briefings', 'join_role_groups', 'wait_seats',
              'launch_work', 'wait_briefing_acks', 'activate'];
          if (resumable.includes(r.saga.phase) && r.template_snapshot) {
            try {
              const template = r.task_id
                ? durableTaskRoomTemplate(getTask(r.task_id), r)
                : r.template_snapshot;
              if (template) {
                await provisionMembers({
                  cfg,
                  cowork: adapter,
                  roomId: r.room_id,
                  taskId: r.task_id,
                  template,
                  binPath: getBinPath(),
                  goal: r.room_name,
                });
                r = getRoomRecord(id);
                actions.splice(0, actions.length, 'Provisioning resumed successfully');
              }
            } catch (error) {
              actions.push(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

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
          sections: actions.length
            ? [{ heading: 'Next steps', items: actions }]
            : [{ heading: 'Result', items: ['No recovery action is needed.'] }],
        }));
      } catch (e) { if (opts.json) die(e); dieTaskRoom(e); }
    });

  const internalDeleteAction = async (
    id: string, opts: { configuration?: string; json?: boolean },
  ): Promise<void> => {
      try {
        const cfg = loadCfg(opts);
        const result = await deleteManagedRoom({ roomId: id, cowork: coworkFor(cfg) });
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, ...result }, null, 2));
          return;
        }
        console.log(renderMarkdownResult({
          icon: '🗑️', title: 'Room deleted',
          fields: [{ label: 'ID', value: id, kind: 'code' }],
        }));
      } catch (e) {
        await recordManagedRoomCloseError(
          id, errorText(e), `External delete worker failed. Retry room delete ${id} ${id}.`,
        ).catch(() => {});
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
