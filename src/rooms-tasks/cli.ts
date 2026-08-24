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

function die(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

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

function printRoomStartupEvidence(room: RoomOrchestrationRecord): void {
  const definitions = Object.values(room.role_briefings ?? {});
  if (definitions.length) {
    console.log('Role briefings:');
    for (const definition of definitions.sort((a, b) => a.role.localeCompare(b.role)))
      console.log(`  ${definition.role} v${definition.version ?? '?'} ${definition.state} sha256:${definition.sha256}`);
  }
  if (room.member_seats.length) {
    console.log('Fleet startup evidence:');
    for (const seat of room.member_seats) {
      const launch = seat.launch?.state ?? 'unrecorded';
      const briefing = seat.briefing?.state ?? 'unrecorded';
      console.log(`  ${seat.role_name} ${seat.identity_cid} role=${seat.cowork_role} seat=${seat.seat_state} launch=${launch} briefing=${briefing}`);
      if (seat.briefing?.message_id)
        console.log(`    briefing_message=${seat.briefing.message_id} relay=${seat.briefing.relay_result_record_id ?? 'pending'} ack=${seat.briefing.acknowledgement_message_id ?? 'pending'}`);
      if (seat.briefing?.last_rejected_ack_reason)
        console.log(`    rejected_ack_seq=${seat.briefing.last_rejected_ack_seq} reason=${seat.briefing.last_rejected_ack_reason}`);
      if (seat.launch?.error) console.log(`    launch_error=${seat.launch.error}`);
    }
  }
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
          if (!t) die(new Error(`template not found: ${opts.template}`));
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
        console.log(`Task ${record.task_id} created · ${record.state}`);
        if (templateRef) console.log(`Template: ${templateRef.name}@${templateRef.version}`);
      } catch (e) { die(e); }
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
        if (!tasks.length) { console.log('No tasks.'); return; }
        for (const t of tasks) {
          const blocked = t.blocked ? ` [BLOCKED: ${t.blocked.reason}]` : '';
          console.log(`${t.task_id}  ${t.state}${blocked}  ${t.title}`);
        }
      } catch (e) { die(e); }
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
        console.log(`Task: ${t.task_id}`);
        console.log(`Title: ${t.title}`);
        console.log(`State: ${t.state}${t.blocked ? ` [BLOCKED: ${t.blocked.reason}]` : ''}`);
        if (t.template) console.log(`Template: ${t.template.name}@${t.template.version}`);
        if (t.room_id) console.log(`Room: ${t.room_id}`);
        if (t.room_identity_cid) console.log(`Room CID: ${t.room_identity_cid}`);
        if (t.member_roles.length) {
          console.log('Members:');
          for (const m of t.member_roles)
            console.log(`  ${m.name} (${m.cowork_role}) ${m.identity_cid}`);
        }
        if (room) printRoomStartupEvidence(room);
        console.log(`Origin: ${t.origin.type}`);
        console.log(`Created: ${t.created_at}`);
        if (t.started_at) console.log(`Started: ${t.started_at}`);
        if (t.ended_at) console.log(`Ended: ${t.ended_at}`);
        if (t.outcome) console.log(`Outcome: ${t.outcome.summary}`);
      } catch (e) { die(e); }
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
            throw new Error(`task template snapshot no longer matches ${t.template.name}@${t.template.version}`);
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
        console.log(`Task ${t.task_id} · provisioning`);
      } catch (e) { die(e); }
    });

  taskCmd.command('block <id>')
    .description('mark a task as blocked')
    .requiredOption('--reason <reason>', 'blocking reason')
    .option('--json', 'JSON output')
    .action((id: string, opts: { reason: string; json?: boolean }) => {
      try {
        const t = blockTask(id, opts.reason);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(`Task ${t.task_id} · blocked: ${opts.reason}`);
      } catch (e) { die(e); }
    });

  taskCmd.command('unblock <id>')
    .description('unblock a task')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = unblockTask(id);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(`Task ${t.task_id} · unblocked`);
      } catch (e) { die(e); }
    });

  taskCmd.command('review <id>')
    .description('move a task to review')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = reviewTask(id);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(`Task ${t.task_id} · review`);
      } catch (e) { die(e); }
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
          console.log(`Task ${t.task_id} · ${t.state} (terminal intent accepted/pending; run task recover ${id})`);
          return;
        }
        console.log(`Task ${t.task_id} · done`);
      } catch (e) { die(e); }
    });

  cOpt(taskCmd.command('cancel <id> <confirm-id>'))
    .description('cancel a task (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action(async (id: string, confirmId: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        if (id !== confirmId)
          die(new Error('confirmation ID must match task ID'));
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
          console.log(`Task ${t.task_id} · ${t.state} (terminal intent accepted/pending; run task recover ${id})`);
          return;
        }
        console.log(`Task ${t.task_id} · cancelled`);
      } catch (e) { die(e); }
    });

  cOpt(taskCmd.command('delete <id> <confirm-id>'))
    .description('delete a done task from the backlog (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action((id: string, confirmId: string, opts: { json?: boolean }) => {
      try {
        if (id !== confirmId) die(new Error('confirmation ID must match task ID'));
        const deleted = deleteTask(id);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task_id: id, deleted }, null, 2));
          return;
        }
        console.log(deleted
          ? `Task ${id} · deleted from backlog`
          : `Task ${id} · already absent`);
      } catch (e) { die(e); }
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
        console.log(`Task ${t.task_id} · ${t.state}`);
        if (room) console.log(`Room ${room.room_id} · ${room.state} · saga: ${room.saga.phase}`);
        if (result.recovery_actions.length) {
          console.log('Recovery actions:');
          for (const a of result.recovery_actions) console.log(`  - ${a}`);
        } else {
          console.log('No automated recovery actions available.');
        }
      } catch (e) { die(e); }
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
        console.log(`Task ${t.task_id} · ${t.state}`);
      } catch (e) {
        await recordTaskTerminalIntentError(
          id, errorText(e), `External settle worker failed. Retry task recover ${id}.`,
        ).catch(() => {});
        die(e);
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
          die(new Error(`task ${id} is in terminal state '${t.state}'`));

        if (t.state === 'active' && t.room_id) {
          // An explicit --template must agree with the room the task already
          // runs in; a conflicting override is an error, not a silent no-op.
          if (opts.template) {
            const override = resolveTemplate(opts.template, allTemplates(cfg));
            if (!override) die(new Error(`template not found: ${opts.template}`));
            const overrideSnap = snapshotTemplate(override);
            const roomSnap = getRoomRecord(t.room_id)?.template_snapshot ?? t.template;
            if (roomSnap && (roomSnap.name !== overrideSnap.name || roomSnap.content_hash !== overrideSnap.content_hash))
              die(new Error(`template ${overrideSnap.name}@${overrideSnap.version} does not match room ${t.room_id}'s provisioned template ${roomSnap.name}@${roomSnap.version}`));
          }
          if (opts.json) {
            console.log(JSON.stringify({ schema_version: 1, task: t, status: 'already_active' }, null, 2));
            return;
          }
          console.log('Task already has an active room');
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
        if (!durableSnapshot && !resolved) die(new Error(`template not found: ${templateName}`));
        if (opts.template && !resolved) die(new Error(`template not found: ${templateName}`));
        if (durableSnapshot && resolved) {
          const requested = snapshotTemplate(resolved);
          if (requested.name !== durableSnapshot.name
              || requested.content_hash !== durableSnapshot.content_hash) {
            die(new Error(`template ${requested.name}@${requested.version} does not match room ${existingRoom!.room_id}'s provisioned template ${durableSnapshot.name}@${durableSnapshot.version}`));
          }
        }
        const snap = durableSnapshot ?? snapshotTemplate(resolved!);
        if (!opts.template && t.template && snap.content_hash !== t.template.content_hash)
          die(new Error(`task template snapshot no longer matches ${t.template.name}@${t.template.version}`));
        // A provisioned room is pinned to its snapshot: never resume or re-pin
        // an existing room under a different template.
        if (t.room_id) {
          const roomSnap = getRoomRecord(t.room_id)?.template_snapshot;
          if (roomSnap && (roomSnap.name !== snap.name || roomSnap.content_hash !== snap.content_hash))
            die(new Error(`template ${snap.name}@${snap.version} does not match room ${t.room_id}'s provisioned template ${roomSnap.name}@${roomSnap.version}`));
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
            die(new Error(`task ${id} has room ${t.room_id} in a non-resumable state — run 'task recover ${id}'`));
          }
        }

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2));
          return;
        }
        console.log(`Task ${t.task_id} · ${t.state}`);
        if (templateRef) console.log(`Template: ${templateRef.name}@${templateRef.version}`);
        if (t.room_id) console.log(`Room: ${t.room_id}`);
        if (t.member_roles.length) {
          console.log('Agents:');
          for (const m of t.member_roles)
            console.log(`  ${m.name} (${m.cowork_role})`);
        }
      } catch (e) { die(e); }
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
          die(new Error(`task ${id} is already in terminal state '${t.state}'`));

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
          console.log(`Task ${t.task_id} · ${t.state} (terminal intent accepted/pending; run task recover ${id})`);
          return;
        }
        console.log(`Task ${t.task_id} · done`);
      } catch (e) { die(e); }
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
          if (!t) die(new Error(`template not found: ${opts.template}`));
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
        console.log(`Room ${record.room_id} created · ${record.state}`);
        if (templateSnapshot) console.log(`Template: ${templateSnapshot.name}@${templateSnapshot.version}`);
      } catch (e) { die(e); }
    });

  cOpt(roomCmd.command('list'))
    .description('list rooms')
    .option('--state <state>', 'filter live rooms by state (active|provisioning|all)')
    .option('--json', 'JSON output')
    .action(async (opts: { configuration?: string; state?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        if (opts.state && !['active', 'provisioning', 'all'].includes(opts.state))
          throw new Error('room state filter must be active, provisioning, or all');
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
        if (!rooms.length) { console.log('No rooms.'); return; }
        for (const r of rooms)
          console.log(`${r.room_id}  ${r.state}  ${r.room_name}${r.orchestration?.task_id ? ` (task: ${r.orchestration.task_id})` : ''}`);
      } catch (e) { die(e); }
    });

  cOpt(roomCmd.command('show <id>'))
    .description('show room details')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        const tracked = getRoomRecord(id);
        if (tracked?.state === 'closing' || tracked?.state === 'closed')
          die(new Error(`room not found: ${id}`));
        const cowork = await coworkFor(cfg).getRoom(id);
        if (!cowork || cowork.state === 'closing' || cowork.state === 'closed')
          die(new Error(`room not found: ${id}`));
        const r = tracked;
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: cowork, orchestration: r ?? null }, null, 2));
          return;
        }
        console.log(`Room: ${cowork.room_id}`);
        console.log(`Name: ${cowork.room_name}`);
        console.log(`State: ${cowork.state}`);
        console.log(`Identity CID: ${cowork.identity_cid}`);
        if (r?.task_id) console.log(`Task: ${r.task_id}`);
        if (r) console.log(`Saga: ${r.saga.phase} (step ${r.saga.step_index})`);
        if (r?.provisioning_detail) console.log(`Detail: ${r.provisioning_detail}`);
        if (r?.saga.error) console.log(`Error: ${r.saga.error}`);
        if (cowork.seats.length) {
          console.log('Members:');
          for (const s of cowork.seats)
            console.log(`  ${s.identity_cid} (${s.role}) ${s.seat_state}`);
        }
        if (r) printRoomStartupEvidence(r);
        if (r) console.log(`Tracked by Fleet since: ${r.created_at}`);
      } catch (e) { die(e); }
    });

  cOpt(roomCmd.command('open <id>'))
    .description('open room in Cowork local console')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        const tracked = getRoomRecord(id);
        if (tracked?.state === 'closing' || tracked?.state === 'closed')
          die(new Error(`room not found: ${id}`));
        const room = await coworkFor(cfg).getRoom(id);
        if (!room || room.state === 'closing' || room.state === 'closed')
          die(new Error(`room not found: ${id}`));
        const url = `http://localhost:4460/room/${id}`;
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room_id: id, url, room_name: room.room_name }, null, 2));
          return;
        }
        console.log(`Room ${id} — ${room.room_name}`);
        console.log(`Local console: ${url}`);
      } catch (e) { die(e); }
    });

  cOpt(roomCmd.command('members <id>'))
    .description('show room members')
    .option('--json', 'JSON output')
    .action(async (id: string, opts: { configuration?: string; json?: boolean }) => {
      try {
        const cfg = loadCfg(opts);
        const r = getRoomRecord(id);
        if (r?.state === 'closing' || r?.state === 'closed')
          die(new Error(`room not found: ${id}`));
        const adapter = coworkFor(cfg);
        const room = await adapter.getRoom(id);
        if (!room || room.state === 'closing' || room.state === 'closed')
          die(new Error(`room not found: ${id}`));
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
        console.log(`Room ${id}${r ? ` — ${r.room_name}` : ''}`);
        if (r?.owner_seat_cid) console.log(`Owner: ${r.owner_seat_cid}`);
        if (!members.length) { console.log('No members.'); return; }
        for (const s of members)
          console.log(`  ${s.identity_cid} (${s.role}) ${s.seat_state}`);
      } catch (e) { die(e); }
    });

  const deleteAction = async (
    id: string, confirmId: string,
    opts: { configuration?: string; json?: boolean },
  ): Promise<void> => {
      try {
        if (id !== confirmId) die(new Error('confirmation ID must match room ID'));
        coworkFor(loadCfg(opts));
        const existing = getRoomRecord(id);
        if (!existing) throw new Error(`room not found in Fleet orchestration: ${id}`);
        await acceptManagedRoomClose(id);
        const settled = await launchRoomDeleteWorker(id, opts.configuration);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room_id: id, deleted: settled.deleted }, null, 2));
          return;
        }
        if (settled.timedOut) {
          console.log(`Room ${id} · deletion accepted/pending; run room delete ${id} ${id}`);
          return;
        }
        console.log(`Room ${id} · deleted`);
      } catch (e) { die(e); }
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
          console.log(settled.timedOut
            ? `Room ${id} · deletion pending`
            : `Room ${id} · deleted`);
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
        if (r?.saga.error) actions.push(`Last error: ${r.saga.error}`);
        if (r?.saga.recovery_hint) actions.push(r.saga.recovery_hint);
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
        console.log(`Room ${cowork.room_id} · ${cowork.state}${r ? ` · saga: ${r.saga.phase}` : ''}`);
        if (actions.length) {
          console.log('Recovery:');
          for (const a of actions) console.log(`  - ${a}`);
        } else {
          console.log('No recovery actions needed.');
        }
      } catch (e) { die(e); }
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
        console.log(`Room ${id} · deleted`);
      } catch (e) {
        await recordManagedRoomCloseError(
          id, errorText(e), `External delete worker failed. Retry room delete ${id} ${id}.`,
        ).catch(() => {});
        die(e);
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
