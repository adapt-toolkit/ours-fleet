import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { loadConfig, type FleetConfig, ConfigError } from '../config.js';
import {
  resolveTemplate, listTemplates, snapshotTemplate, hashTemplate,
  BUILTIN_TEMPLATES,
} from './templates.js';
import {
  createTask, getTask, listTasks, startTask, activateTask,
  blockTask, unblockTask, reviewTask, completeTask, cancelTask,
  TaskStateError,
} from './task-state.js';
import {
  createRoomRecord, getRoomRecord, listRoomRecords,
  closeRoom as closeRoomRecord, RoomStateError,
} from './room-state.js';
import type { TaskOrigin, TemplateDefinition } from './types.js';

function die(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function loadCfg(opts: { configuration?: string }): FleetConfig {
  return loadConfig(opts.configuration);
}

function allTemplates(cfg: FleetConfig): Record<string, TemplateDefinition> {
  return cfg.roomTemplates ?? {};
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
    .action((opts: {
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
          const defaultTpl = cfg.tasks?.default_room_template ?? cfg.rooms?.defaults?.template ?? 'development-team';
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
        const record = createTask({
          title: opts.title,
          brief,
          brief_file: opts.briefFile,
          template: templateRef,
          origin,
          idempotency_key: opts.idempotencyKey,
          start: !opts.backlog,
        });

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
        let stateFilter;
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
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2));
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
        console.log(`Origin: ${t.origin.type}`);
        console.log(`Created: ${t.created_at}`);
        if (t.started_at) console.log(`Started: ${t.started_at}`);
        if (t.ended_at) console.log(`Ended: ${t.ended_at}`);
        if (t.outcome) console.log(`Outcome: ${t.outcome.summary}`);
      } catch (e) { die(e); }
    });

  taskCmd.command('start <id>')
    .description('start a backlog task')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = startTask(id);
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

  taskCmd.command('done <id>')
    .description('complete a task')
    .option('--summary <text>', 'completion summary')
    .option('--summary-file <path>', 'completion summary from file')
    .option('--json', 'JSON output')
    .action((id: string, opts: { summary?: string; summaryFile?: string; json?: boolean }) => {
      try {
        let summary = opts.summary;
        if (opts.summaryFile) summary = readFileSync(opts.summaryFile, 'utf8');
        const outcome = summary ? { summary } : undefined;
        const t = completeTask(id, outcome);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(`Task ${t.task_id} · done`);
      } catch (e) { die(e); }
    });

  taskCmd.command('cancel <id> <confirm-id>')
    .description('cancel a task (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action((id: string, confirmId: string, opts: { json?: boolean }) => {
      try {
        if (id !== confirmId)
          die(new Error('confirmation ID must match task ID'));
        const t = cancelTask(id);
        if (opts.json) { console.log(JSON.stringify({ schema_version: 1, task: t }, null, 2)); return; }
        console.log(`Task ${t.task_id} · cancelled`);
      } catch (e) { die(e); }
    });

  taskCmd.command('recover <id>')
    .description('attempt to recover a stuck task')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const t = getTask(id);
        const room = t.room_id ? getRoomRecord(t.room_id) : undefined;
        const result = {
          task: t,
          room: room ?? null,
          recovery_actions: [] as string[],
        };
        if (t.state === 'provisioning' && room) {
          if (room.provisioning_detail === 'waiting_cowork')
            result.recovery_actions.push('Cowork management socket unreachable — check ours-cowork service');
          if (room.provisioning_detail === 'waiting_owner_invite')
            result.recovery_actions.push('Owner invite invalid or expired — rotate rooms.owner.public_invite in config');
          if (room.provisioning_detail === 'owner_cid_mismatch')
            result.recovery_actions.push('Owner CID mismatch — verify rooms.owner.expected_cid matches Messenger identity');
          if (room.provisioning_detail === 'member_failed')
            result.recovery_actions.push(`Member creation failed at saga step ${room.saga.step_index} — inspect and retry`);
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
    .action((opts: {
      configuration?: string; name: string; template?: string;
      goal?: string; brief?: string; briefFile?: string; json?: boolean;
    }) => {
      try {
        const cfg = loadCfg(opts);
        let brief = opts.brief;
        if (opts.briefFile) brief = readFileSync(opts.briefFile, 'utf8');

        const roomId = `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        let templateSnapshot;
        if (opts.template) {
          const t = resolveTemplate(opts.template, allTemplates(cfg));
          if (!t) die(new Error(`template not found: ${opts.template}`));
          templateSnapshot = snapshotTemplate(t);
        }

        const record = createRoomRecord({
          room_id: roomId,
          room_name: opts.name,
          template_snapshot: templateSnapshot,
        });

        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: record }, null, 2));
          return;
        }
        console.log(`Room ${record.room_id} created · ${record.state}`);
        if (templateSnapshot) console.log(`Template: ${templateSnapshot.name}@${templateSnapshot.version}`);
      } catch (e) { die(e); }
    });

  roomCmd.command('list')
    .description('list rooms')
    .option('--state <state>', 'filter by state (active|provisioning|closing|closed|all)')
    .option('--json', 'JSON output')
    .action((opts: { state?: string; json?: boolean }) => {
      try {
        let stateFilter;
        if (opts.state && opts.state !== 'all') {
          stateFilter = opts.state as import('./types.js').RoomOrchestrationState;
        }
        const rooms = listRoomRecords(stateFilter ? { state: stateFilter } : undefined);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, rooms }, null, 2));
          return;
        }
        if (!rooms.length) { console.log('No rooms.'); return; }
        for (const r of rooms)
          console.log(`${r.room_id}  ${r.state}  ${r.room_name}${r.task_id ? ` (task: ${r.task_id})` : ''}`);
      } catch (e) { die(e); }
    });

  roomCmd.command('show <id>')
    .description('show room details')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const r = getRoomRecord(id);
        if (!r) die(new Error(`room not found: ${id}`));
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: r }, null, 2));
          return;
        }
        console.log(`Room: ${r.room_id}`);
        console.log(`Name: ${r.room_name}`);
        console.log(`State: ${r.state}`);
        if (r.task_id) console.log(`Task: ${r.task_id}`);
        if (r.room_identity_cid) console.log(`Identity CID: ${r.room_identity_cid}`);
        console.log(`Saga: ${r.saga.phase} (step ${r.saga.step_index})`);
        if (r.provisioning_detail) console.log(`Detail: ${r.provisioning_detail}`);
        if (r.saga.error) console.log(`Error: ${r.saga.error}`);
        if (r.member_seats.length) {
          console.log('Members:');
          for (const s of r.member_seats)
            console.log(`  ${s.role_name} (${s.cowork_role}) ${s.seat_state}`);
        }
        console.log(`Created: ${r.created_at}`);
        if (r.activated_at) console.log(`Activated: ${r.activated_at}`);
        if (r.closed_at) console.log(`Closed: ${r.closed_at}`);
      } catch (e) { die(e); }
    });

  roomCmd.command('members <id>')
    .description('show room members')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const r = getRoomRecord(id);
        if (!r) die(new Error(`room not found: ${id}`));
        if (opts.json) {
          console.log(JSON.stringify({
            schema_version: 1,
            room_id: r.room_id,
            members: r.member_seats,
            owner_seat_cid: r.owner_seat_cid ?? null,
          }, null, 2));
          return;
        }
        console.log(`Room ${r.room_id} — ${r.room_name}`);
        if (r.owner_seat_cid) console.log(`Owner: ${r.owner_seat_cid}`);
        if (!r.member_seats.length) { console.log('No members.'); return; }
        for (const s of r.member_seats)
          console.log(`  ${s.role_name} (${s.cowork_role}) ${s.seat_state} ${s.identity_cid}`);
      } catch (e) { die(e); }
    });

  roomCmd.command('close <id> <confirm-id>')
    .description('close a room (requires ID twice for confirmation)')
    .option('--json', 'JSON output')
    .action((id: string, confirmId: string, opts: { json?: boolean }) => {
      try {
        if (id !== confirmId) die(new Error('confirmation ID must match room ID'));
        const r = closeRoomRecord(id);
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: r }, null, 2));
          return;
        }
        console.log(`Room ${r.room_id} · closed`);
      } catch (e) { die(e); }
    });

  roomCmd.command('recover <id>')
    .description('attempt to recover a stuck room')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      try {
        const r = getRoomRecord(id);
        if (!r) die(new Error(`room not found: ${id}`));
        const actions: string[] = [];
        if (r.saga.error) actions.push(`Last error: ${r.saga.error}`);
        if (r.saga.recovery_hint) actions.push(r.saga.recovery_hint);
        if (r.provisioning_detail === 'waiting_cowork')
          actions.push('Check ours-cowork service status');
        if (r.provisioning_detail === 'waiting_owner_invite')
          actions.push('Rotate rooms.owner.public_invite in config, then re-run recover');
        if (opts.json) {
          console.log(JSON.stringify({ schema_version: 1, room: r, recovery_actions: actions }, null, 2));
          return;
        }
        console.log(`Room ${r.room_id} · ${r.state} · saga: ${r.saga.phase}`);
        if (actions.length) {
          console.log('Recovery:');
          for (const a of actions) console.log(`  - ${a}`);
        } else {
          console.log('No recovery actions needed.');
        }
      } catch (e) { die(e); }
    });
}
