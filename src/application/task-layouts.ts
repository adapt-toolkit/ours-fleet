/** Task ↔ Room Layout bridge.
 * A layout task owns exactly one Room Layout run, `task-<task_id>`, snapshotted
 * from the named source layout with task context added to every room contract.
 * Room opening and closing reuse the #199 engine in detached workers; each
 * operation's outcome is recorded beside the run so HTTP callers can observe it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../canonical-json.js';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import { assertLayoutFile, type RoomLayoutDefinition } from '../rooms-tasks/layout-config.js';
import { getTask as readTask } from '../rooms-tasks/task-state.js';
import { stateRoot } from '../paths.js';
import { launchFleetWorker } from '../rooms-tasks/external-worker.js';
import { layoutSupervisorId } from '../rooms-tasks/layout-control.js';
import { layoutRunPath, RoomLayoutService } from '../rooms-tasks/layout-service.js';
import type { RoomLayoutState } from '../rooms-tasks/layout.js';
import { FleetError } from './errors.js';
import type { TaskLayoutLink, TaskRecord } from '../rooms-tasks/types.js';

export type TaskLayoutOperation = 'open' | 'close-room' | 'close';
export interface TaskLayoutOperationRecord {
  /** Only the worker holding the current ID may update the record. */
  id: string; operation: TaskLayoutOperation; room?: string;
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

/** Always-current brief for layout participants; rooms may open long after the run snapshot.
 * It lives in Fleet's private layout state, never in the agent-writable task workspace. */
export function taskBriefPath(task: Pick<TaskRecord, 'task_id'>): string {
  return layoutRunPath(`task-${task.task_id}`).replace(/\.json$/, '.brief.md');
}
export function writeTaskBrief(task: Pick<TaskRecord, 'task_id' | 'title' | 'brief'>): void {
  const path = taskBriefPath(task); // layoutRunPath verified the private directory
  if (existsSync(path)) assertLayoutFile(path);
  replaceFileAtomically(path, `# ${task.title}\n\nTask ${task.task_id}\n\n${task.brief?.trim() ?? ''}\n`, 0o600);
}

/** Task context reaches every participant through the room contract (briefing text).
 * The contract references the brief file instead of copying the brief, so later edits reach later rooms. */
export function taskScopedDefinition(definition: RoomLayoutDefinition, task: Pick<TaskRecord, 'task_id' | 'title' | 'brief' | 'workspace'>): RoomLayoutDefinition {
  const preamble = [
    `Task ${task.task_id}: ${task.title}`,
    ...(task.workspace ? [`Task workspace: ${task.workspace.path}`] : []),
    `Current task brief: ${taskBriefPath(task)} (kept up to date by Fleet; read it before starting work)`,
  ].join('\n');
  for (const room of Object.values(definition.rooms))
    room.contract = room.contract ? `${preamble}\n\nRoom contract:\n${room.contract}` : preamble;
  return definition;
}

const ROOM_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
interface RunProvenance { task_id: string; source_hash: string; scoped_hash: string }

/** Opening rooms requires a started, live task; checked again by the worker before any side effect. */
export function assertLayoutOpenable(task: TaskRecord): void {
  if (task.deletion?.status === 'pending') throw new FleetError('conflict', 'task is being deleted; its layout rooms cannot be opened');
  if (task.terminal_intent || ['done', 'cancelled', 'failed'].includes(task.state))
    throw new FleetError('conflict', 'task is closing or closed; its layout rooms cannot be opened');
  if (task.state !== 'active' && task.state !== 'review')
    throw new FleetError('conflict', `start the task before opening rooms (state '${task.state}')`);
}

export class TaskLayouts {
  constructor(private configPath?: string, private deps: {
    service?: RoomLayoutService;
    launch?: (args: string[], operation: string) => Promise<void>;
    binPath?: () => string | undefined;
  } = {}) {}

  private service(): RoomLayoutService { return this.deps.service ?? new RoomLayoutService(this.configPath); }

  private operationPath(runId: string): string { return join(stateRoot(), 'layouts', `${runId}.op.json`); }
  private provenancePath(runId: string): string { return layoutRunPath(runId).replace(/\.json$/, '.provenance.json'); }
  /** Serializes run creation, worker preconditions and deletion's removal of the run. */
  private withTaskLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(layoutRunPath(runId).replace(/\.json$/, '.task.lock'), fn);
  }

  /** Resolve a layout for task creation: it must exist, parse and reference known Agent Templates. */
  resolve(name: string): { name: string; definition_hash: string } {
    return { name, definition_hash: layoutDefinitionHash(this.service().definition(name)) };
  }

  runExists(link: TaskLayoutLink): boolean { return existsSync(layoutRunPath(link.run_id)); }

  /** Idempotent: reuse a run whose provenance matches this task, or snapshot one from the pinned source. */
  async ensureRun(task: TaskRecord, precondition?: (current: TaskRecord) => void): Promise<void> {
    const link = task.layout;
    if (!link) throw Error(`task ${task.task_id} has no layout`);
    await this.withTaskLock(link.run_id, async () => {
      const current = readTask(task.task_id);
      precondition?.(current);
      writeTaskBrief(current);
      if (this.runExists(link)) { this.verifyProvenance(current); return; }
      const service = this.service();
      const source = service.definition(link.name);
      if (layoutDefinitionHash(source) !== link.definition_hash)
        throw Error(`room layout ${link.name} changed before this task's layout run was created; create a new task to use the edited layout`);
      const scoped = taskScopedDefinition(structuredClone(source), current);
      const provenance: RunProvenance = { task_id: current.task_id, source_hash: link.definition_hash, scoped_hash: layoutDefinitionHash(scoped) };
      // Provenance precedes the run: a crash in between is re-derived from the same pinned source.
      replaceFileAtomically(this.provenancePath(link.run_id), JSON.stringify(provenance), 0o600);
      await service.create(link.name, {}, link.run_id, { source: scoped, cwd: current.workspace?.path });
    });
  }

  private verifyProvenance(task: TaskRecord): void {
    const link = task.layout!, path = this.provenancePath(link.run_id);
    let provenance: RunProvenance | undefined;
    try { assertLayoutFile(path); provenance = JSON.parse(readFileSync(path, 'utf8')); } catch { /* missing or untrusted */ }
    const snapshot = this.service().open(link.run_id, true).snapshot();
    if (!provenance || provenance.task_id !== task.task_id || provenance.source_hash !== link.definition_hash
        || provenance.scoped_hash !== layoutDefinitionHash({ version: 1, ...snapshot.definition } as RoomLayoutDefinition))
      throw Error(`layout run ${link.run_id} does not match this task's pinned layout; inspect it before continuing`);
  }

  readOperation(runId: string): TaskLayoutOperationRecord | undefined {
    const path = this.operationPath(runId);
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined; } catch { return undefined; }
  }

  /** Update only the still-current operation; a superseded or forgotten one is never resurrected. */
  private updateOperation(runId: string, record: Omit<TaskLayoutOperationRecord, 'updated_at'>): Promise<boolean> {
    return withFileLock(this.operationPath(runId) + '.lock', () => {
      if (this.readOperation(runId)?.id !== record.id) return false;
      this.writeOperation(runId, record); return true;
    });
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
    const record = { id: randomUUID(), operation, ...(room ? { room } : {}), status: 'launching' as const };
    await withFileLock(this.operationPath(link.run_id) + '.lock', () => {
      const current = this.readOperation(link.run_id);
      // Full close always proceeds: terminal cleanup must not wait behind an open; the engine lock serializes them.
      if (operation !== 'close' && current && ['launching', 'running'].includes(current.status) && Date.now() - Date.parse(current.updated_at) < 10 * 60_000)
        throw new FleetError('conflict', `layout operation already in progress: ${current.operation}${current.room ? ' ' + current.room : ''}`);
      this.writeOperation(link.run_id, record);
    });
    const args = ['task', '_layout', task.task_id, operation, ...(room ? [room] : []), '--operation-id', record.id];
    const launch = this.deps.launch
      ?? ((cli: string[], name: string) => launchFleetWorker(cli, name, this.configPath, this.deps.binPath?.()));
    try { await launch(args, `task-layout-${task.task_id}`); }
    catch (error) {
      await this.updateOperation(link.run_id, { ...record, status: 'failed', error: `worker failed to start: ${String((error as Error).message ?? error)}` });
      throw error;
    }
    return this.readOperation(link.run_id)!;
  }

  /** Worker body. Errors are recorded and rethrown; unknown engine outcomes stay in run state for inspection. */
  /** Without an ID (direct CLI use) the worker claims a new current operation. */
  async run(task: TaskRecord, operation: TaskLayoutOperation, room?: string, operationId?: string): Promise<void> {
    const link = task.layout;
    if (!link) throw Error(`task ${task.task_id} has no layout`);
    const record = { id: operationId ?? randomUUID(), operation, ...(room ? { room } : {}) };
    if (!operationId) await withFileLock(this.operationPath(link.run_id) + '.lock', () => this.writeOperation(link.run_id, { ...record, status: 'running' }));
    else await this.updateOperation(link.run_id, { ...record, status: 'running' });
    try {
      await this.perform(task, operation, room);
      await this.updateOperation(link.run_id, { ...record, status: 'succeeded' });
    } catch (error) {
      await this.updateOperation(link.run_id, { ...record, status: 'failed', error: (error as Error).message ?? String(error) });
      throw error;
    }
  }

  private async perform(task: TaskRecord, operation: TaskLayoutOperation, room?: string): Promise<void> {
    const link = task.layout!;
    if (operation === 'open') {
      // Re-read under the task-layout lock: a deletion or terminal action accepted after HTTP admission wins.
      await this.ensureRun(task, assertLayoutOpenable);
      // If deletion removed the run since, fail rather than recreate it.
      if (!this.runExists(link)) throw new FleetError('conflict', 'task layout run was removed');
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
    if (this.runExists(link)) await this.service().open(link.run_id, true).close(layoutSupervisorId());
    await this.withTaskLock(link.run_id, async () => {
      for (const path of [layoutRunPath(link.run_id), this.provenancePath(link.run_id), taskBriefPath(task)])
        rmSync(path, { force: true });
      await withFileLock(this.operationPath(link.run_id) + '.lock', () => rmSync(this.operationPath(link.run_id), { force: true }));
    });
  }
}
