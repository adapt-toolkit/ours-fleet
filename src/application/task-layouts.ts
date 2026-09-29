/** Task ↔ Room Layout bridge.
 * A layout task owns exactly one Room Layout run, `task-<task_id>`, snapshotted
 * from the named source layout with task context added to every room contract.
 * Room opening and closing reuse the #199 engine in detached workers; each
 * operation's outcome is recorded beside the run so HTTP callers can observe it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../canonical-json.js';
import { replaceFileAtomically } from '../atomic-file.js';
import { stateRoot } from '../paths.js';
import { launchFleetWorker } from '../rooms-tasks/external-worker.js';
import { layoutSupervisorId } from '../rooms-tasks/layout-control.js';
import { layoutRunPath, RoomLayoutService } from '../rooms-tasks/layout-service.js';
import type { RoomLayoutDefinition } from '../rooms-tasks/layout-config.js';
import type { RoomLayoutState } from '../rooms-tasks/layout.js';
import { FleetError } from './errors.js';
import type { TaskLayoutLink, TaskRecord } from '../rooms-tasks/types.js';

export type TaskLayoutOperation = 'open' | 'close-room' | 'close';
export interface TaskLayoutOperationRecord {
  operation: TaskLayoutOperation; room?: string;
  status: 'launching' | 'running' | 'succeeded' | 'failed';
  error?: string; updated_at: string;
}
export interface TaskLayoutRoomView {
  key: string; goal: string; members: string[]; roles?: Record<string, string>;
  state: 'declared' | 'provisioning' | 'active' | 'closed';
  room_id?: string; identity_cid?: string; ready: string[];
}
export interface TaskLayoutView {
  name: string; run_id: string; created: boolean;
  closed: boolean; closing: boolean; uncertain?: string;
  rooms: TaskLayoutRoomView[];
  participants: Array<{ key: string; agent_template?: string; owned: boolean; retired: boolean; agent?: string; cid?: string }>;
  operation?: TaskLayoutOperationRecord;
}

/** Hash of the authorable definition only (never the source file path). */
export function layoutDefinitionHash(definition: RoomLayoutDefinition): string {
  const { version, description, participants, rooms } = definition;
  return createHash('sha256').update(canonicalJson({ version, description: description ?? null, participants, rooms })).digest('hex');
}

/** Private, always-current brief for layout participants; rooms may open long after the run snapshot. */
export function taskBriefPath(task: Pick<TaskRecord, 'workspace'>): string | undefined {
  return task.workspace ? join(task.workspace.path, '.ours-task', 'brief.md') : undefined;
}
export function writeTaskBrief(task: Pick<TaskRecord, 'task_id' | 'title' | 'brief' | 'workspace'>): void {
  const path = taskBriefPath(task);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  replaceFileAtomically(path, `# ${task.title}\n\nTask ${task.task_id}\n\n${task.brief?.trim() ?? ''}\n`, 0o600);
}

/** Task context reaches every participant through the room contract (briefing text).
 * The contract references the brief file instead of copying the brief, so later edits reach later rooms. */
export function taskScopedDefinition(definition: RoomLayoutDefinition, task: Pick<TaskRecord, 'task_id' | 'title' | 'brief' | 'workspace'>): RoomLayoutDefinition {
  const brief = taskBriefPath(task);
  const preamble = [
    `Task ${task.task_id}: ${task.title}`,
    ...(task.workspace ? [`Task workspace: ${task.workspace.path}`] : []),
    ...(brief ? [`Current task brief: ${brief} (kept up to date by Fleet; read it before starting work)`]
      : task.brief?.trim() ? ['', 'Task brief:', task.brief.trim()] : []),
  ].join('\n');
  for (const room of Object.values(definition.rooms))
    room.contract = room.contract ? `${preamble}\n\nRoom contract:\n${room.contract}` : preamble;
  return definition;
}

const ROOM_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

export class TaskLayouts {
  constructor(private configPath?: string, private deps: {
    service?: RoomLayoutService;
    launch?: (args: string[], operation: string) => Promise<void>;
    binPath?: () => string | undefined;
  } = {}) {}

  private service(): RoomLayoutService { return this.deps.service ?? new RoomLayoutService(this.configPath); }

  private operationPath(runId: string): string { return join(stateRoot(), 'layouts', `${runId}.op.json`); }

  /** Resolve a layout for task creation: it must exist, parse and reference known Agent Templates. */
  resolve(name: string): { name: string; definition_hash: string } {
    return { name, definition_hash: layoutDefinitionHash(this.service().definition(name)) };
  }

  runExists(link: TaskLayoutLink): boolean { return existsSync(layoutRunPath(link.run_id)); }

  /** Idempotent: reuse the run, or snapshot it only from the unchanged source definition. */
  async ensureRun(task: TaskRecord): Promise<void> {
    const link = task.layout;
    if (!link) throw Error(`task ${task.task_id} has no layout`);
    writeTaskBrief(task);
    if (this.runExists(link)) return;
    const service = this.service();
    const source = service.definition(link.name);
    if (layoutDefinitionHash(source) !== link.definition_hash)
      throw Error(`room layout ${link.name} changed before this task's layout run was created; create a new task to use the edited layout`);
    try {
      await service.create(link.name, {}, link.run_id, {
        definition: definition => taskScopedDefinition(definition, task),
        cwd: task.workspace?.path,
      });
    } catch (error) {
      // A concurrent creator won the lock; its snapshot came from the same verified source.
      if (!(this.runExists(link) && /already exists/.test(String(error)))) throw error;
    }
  }

  readOperation(runId: string): TaskLayoutOperationRecord | undefined {
    const path = this.operationPath(runId);
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined; } catch { return undefined; }
  }

  private writeOperation(runId: string, record: Omit<TaskLayoutOperationRecord, 'updated_at'>): void {
    layoutRunPath(runId); // validates the ID and creates the private layouts directory
    replaceFileAtomically(this.operationPath(runId), JSON.stringify({ ...record, updated_at: new Date().toISOString() }), 0o600);
  }

  /** Sanitized read model: no Agent Template snapshots, owner fingerprints or session internals. */
  view(task: TaskRecord): TaskLayoutView | undefined {
    const link = task.layout;
    if (!link) return undefined;
    const base = { name: link.name, run_id: link.run_id, operation: this.readOperation(link.run_id) };
    if (!this.runExists(link)) return { ...base, created: false, closed: false, closing: false, rooms: [], participants: [] };
    const state: RoomLayoutState = this.service().open(link.run_id, true).snapshot();
    return {
      ...base, created: true, closed: state.closed, closing: Boolean(state.closing),
      ...(state.uncertain ? { uncertain: state.uncertain } : {}),
      rooms: Object.entries(state.definition.rooms).map(([key, spec]) => {
        const room = state.rooms[key];
        return {
          key, goal: spec.goal, members: [...spec.members], ...(spec.roles ? { roles: { ...spec.roles } } : {}),
          state: room?.state ?? 'declared', ready: [...(room?.ready ?? [])],
          ...(room?.native ? { room_id: room.native.room_id, identity_cid: room.native.identity_cid } : {}),
        };
      }),
      participants: Object.entries(state.participants).map(([key, p]) => ({
        key, agent_template: state.definition.participants[key]?.agent_template, owned: p.owned, retired: Boolean(p.retired),
        ...(p.instance?.agent ? { agent: p.instance.agent } : {}), ...(p.instance?.cid ? { cid: p.instance.cid } : {}),
      })),
    };
  }

  /** Accept an operation and run it in a detached worker; the outcome is recorded for polling. */
  async launch(task: TaskRecord, operation: TaskLayoutOperation, room?: string): Promise<TaskLayoutOperationRecord> {
    const link = task.layout;
    if (!link) throw Error(`task ${task.task_id} has no layout`);
    if (operation !== 'close' && (!room || !ROOM_KEY.test(room))) throw new FleetError('invalid_request', 'a valid room key is required');
    if (room) {
      const definition = this.runExists(link) ? this.service().open(link.run_id, true).snapshot().definition : undefined;
      if (definition && !Object.hasOwn(definition.rooms, room)) throw new FleetError('resource_not_found', `unknown layout room: ${room}`);
    }
    const current = this.readOperation(link.run_id);
    // Full close always proceeds: terminal cleanup must not wait behind an open; the engine lock serializes them.
    if (operation !== 'close' && current && ['launching', 'running'].includes(current.status) && Date.now() - Date.parse(current.updated_at) < 10 * 60_000)
      throw new FleetError('conflict', `layout operation already in progress: ${current.operation}${current.room ? ' ' + current.room : ''}`);
    const record = { operation, ...(room ? { room } : {}), status: 'launching' as const };
    this.writeOperation(link.run_id, record);
    const args = ['task', '_layout', task.task_id, operation, ...(room ? [room] : [])];
    const launch = this.deps.launch
      ?? ((cli: string[], name: string) => launchFleetWorker(cli, name, this.configPath, this.deps.binPath?.()));
    try { await launch(args, `task-layout-${task.task_id}`); }
    catch (error) {
      this.writeOperation(link.run_id, { ...record, status: 'failed', error: `worker failed to start: ${String((error as Error).message ?? error)}` });
      throw error;
    }
    return this.readOperation(link.run_id)!;
  }

  /** Worker body. Errors are recorded and rethrown; unknown engine outcomes stay in run state for inspection. */
  async run(task: TaskRecord, operation: TaskLayoutOperation, room?: string): Promise<void> {
    const link = task.layout;
    if (!link) throw Error(`task ${task.task_id} has no layout`);
    const record = { operation, ...(room ? { room } : {}) };
    this.writeOperation(link.run_id, { ...record, status: 'running' });
    try {
      await this.perform(task, operation, room);
      this.writeOperation(link.run_id, { ...record, status: 'succeeded' });
    } catch (error) {
      this.writeOperation(link.run_id, { ...record, status: 'failed', error: (error as Error).message ?? String(error) });
      throw error;
    }
  }

  private async perform(task: TaskRecord, operation: TaskLayoutOperation, room?: string): Promise<void> {
    const link = task.layout!;
    if (operation === 'open') {
      await this.ensureRun(task);
      await this.service().open(link.run_id).activate(layoutSupervisorId(), room!);
      return;
    }
    if (!this.runExists(link)) return; // nothing was created, nothing to close
    const engine = this.service().open(link.run_id, true);
    if (operation === 'close-room') {
      if (!engine.snapshot().rooms[room!]?.native) return; // declared but never opened
      await engine.closeRoom(layoutSupervisorId(), room!);
    } else await engine.close(layoutSupervisorId());
  }

  /** Deletion: close every layout resource, then remove the run and its operation record. */
  async closeAndForget(task: Pick<TaskRecord, 'task_id' | 'layout'>): Promise<void> {
    const link = task.layout;
    if (!link) return;
    if (this.runExists(link)) {
      await this.service().open(link.run_id, true).close(layoutSupervisorId());
      rmSync(layoutRunPath(link.run_id), { force: true });
      rmSync(layoutRunPath(link.run_id) + '.lock', { force: true });
    }
    rmSync(this.operationPath(link.run_id), { force: true });
  }
}
