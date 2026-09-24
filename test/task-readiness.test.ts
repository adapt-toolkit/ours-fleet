import { beginFleetAuditCollection, consumeFleetAuditCollection, renderFleetLifecycleEvent } from '../src/fleet-command-audit.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRoomApplicationService, recordTaskProvisioningOutcome } from '../src/application/task-room-service.js';
import { activateTask, createTask, getTask, updateTaskRoom } from '../src/rooms-tasks/task-state.js';
import { activateRoom, advanceSaga, createRoomRecord, updateMemberSeats } from '../src/rooms-tasks/room-state.js';
import { snapshotTemplate } from '../src/rooms-tasks/templates.js';
import { agentDir } from '../src/paths.js';
import { prepareTempSupervisor } from '../src/temp-lifecycle.js';
import type { CoworkAdapter, CoworkRoomInfo } from '../src/rooms-tasks/cowork-adapter.js';
import type { FleetConfig } from '../src/config.js';

const probes = vi.hoisted(() => ({ liveness: vi.fn(), control: vi.fn() }));
vi.mock('../src/temp-lifecycle.js', async original => ({
  ...await original<typeof import('../src/temp-lifecycle.js')>(), tempSupervisorLiveness: probes.liveness,
}));
vi.mock('../src/session/control.js', async original => ({
  ...await original<typeof import('../src/session/control.js')>(), controlRequest: probes.control,
}));

let root: string;
let priorHome: string | undefined;
let taskId: string;
let room: CoworkRoomInfo;
let service: TaskRoomApplicationService;
let getRoom: ReturnType<typeof vi.fn>;
let provision: ReturnType<typeof vi.fn>;
const role = 'member-1';
const roomId = 'room-readiness';

beforeEach(() => {
  priorHome = process.env.OURS_FLEET_HOME;
  root = mkdtempSync(join(tmpdir(), 'fleet-readiness-'));
  process.env.OURS_FLEET_HOME = root;
  const template = snapshotTemplate({ name: 'solo', version: 1, description: '',
    members: [{ slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' }] });
  const task = createTask({ title: 'Readiness fixture', origin: { type: 'cli' }, start: true });
  taskId = task.task_id;
  createRoomRecord({ room_id: roomId, room_name: 'Fixture', room_identity_cid: 'room-cid',
    task_id: taskId, template_snapshot: template });
  updateTaskRoom(taskId, roomId, 'room-cid');
  mkdirSync(agentDir(role, true), { recursive: true });
  const supervisor = prepareTempSupervisor(agentDir(role, true), role);
  writeFileSync(join(agentDir(role, true), '.temp-supervisor.json'), JSON.stringify({ ...supervisor, phase: 'active' }));
  updateMemberSeats(roomId, [{ role_name: role, slot: 'dev', cowork_role: 'Developer', identity_cid: 'member-cid',
    seat_state: 'active', launch: { state: 'launched', attempt: 1, launch_id: supervisor.launchId, updated_at: new Date().toISOString() } }]);
  activateRoom(roomId); advanceSaga(roomId, 'completed', 8); activateTask(taskId);
  room = { room_id: roomId, room_name: 'Fixture', identity_name: 'Fixture', identity_cid: 'room-cid',
    state: 'active', anonymous: false, role_briefings: {}, seats: [{ identity_cid: 'member-cid',
      display_name: role, role: 'Developer', invite_id: 'fixture', seat_state: 'active' }] };
  getRoom = vi.fn(async () => structuredClone(room));
  provision = vi.fn();
  service = new TaskRoomApplicationService(undefined, {
    loadConfiguration: () => ({ rooms: { owner: {}, defaults: {} } }) as FleetConfig,
    cowork: () => ({ getRoom }) as unknown as CoworkAdapter, provisionMembers: provision,
  });
  probes.liveness.mockReset().mockResolvedValue('running');
  probes.control.mockReset().mockResolvedValue({ ok: true, result: { alive: true, readiness: 'idle' } });
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
});

const outcome = () => service.taskProvisioningOutcome(taskId);

describe('current task readiness', () => {
  it.each(['idle', 'running', 'awaiting_permission'])('corroborates a healthy %s session', async readiness => {
    probes.control.mockResolvedValue({ ok: true, result: { alive: true, readiness } });
    expect(await outcome()).toMatchObject({ kind: 'ready', members: { expected: 1, active: 1, launched: 1 } });
    expect(getRoom).toHaveBeenCalledWith(roomId);
    expect(probes.control).toHaveBeenCalled();
  });
  it('rejects a removed original seat even when an active replacement exists', async () => {
    room.seats[0].seat_state = 'removed';
    room.seats.push({ ...room.seats[0], identity_cid: 'replacement-cid', seat_state: 'active' });
    expect(await outcome()).toMatchObject({ kind: 'degraded', members: { active: 0 } });
  });
  it.each(['missing', 'cid', 'closed', 'role'])('rejects inconsistent %s room evidence', async kind => {
    if (kind === 'missing') getRoom.mockResolvedValue(undefined);
    if (kind === 'cid') room.identity_cid = 'other-room';
    if (kind === 'closed') room.state = 'closed';
    if (kind === 'role') room.seats[0].role = 'Other';
    expect(await outcome()).toMatchObject({ kind: 'degraded' });
  });
  it.each(['stopped', 'unknown'])('does not claim ready with %s supervisor', async state => {
    probes.liveness.mockResolvedValue(state);
    expect(await outcome()).toMatchObject({ kind: 'degraded', members: { launched: 0 } });
  });
  it('rejects disappeared launch state', async () => {
    rmSync(agentDir(role, true), { recursive: true });
    expect(await outcome()).toMatchObject({ kind: 'degraded', members: { launched: 0 } });
  });
  it.each(['starting', 'failed', 'malformed', 'dead', 'rejected', 'unavailable'])('rejects %s control evidence', async kind => {
    if (kind === 'unavailable') probes.control.mockRejectedValue(new Error('secret-control-token /private/path'));
    else probes.control.mockResolvedValue({ ok: kind !== 'rejected', result: kind === 'malformed' ? null
      : { alive: kind !== 'dead', readiness: kind === 'starting' || kind === 'failed' ? kind : 'idle' } });
    const result = await outcome();
    expect(result).toMatchObject({ kind: 'degraded', members: { launched: 0 } });
    expect(JSON.stringify(result)).not.toContain('secret-control-token');
  });
  it('does not trust a changed launch generation during the probe', async () => {
    probes.control.mockImplementation(async () => {
      prepareTempSupervisor(agentDir(role, true), role);
      return { ok: true, result: { alive: true, readiness: 'idle' } };
    });
    expect(await outcome()).toMatchObject({ kind: 'degraded' });
  });
  it('does not probe a path-traversing member name', async () => {
    updateMemberSeats(roomId, [{ role_name: '../outside', slot: 'dev', cowork_role: 'Developer',
      identity_cid: 'member-cid', seat_state: 'active', launch: { state: 'launched', attempt: 1,
        launch_id: 'fixture', updated_at: new Date().toISOString() } }]);
    expect(await outcome()).toMatchObject({ kind: 'degraded' });
    expect(probes.control).not.toHaveBeenCalled();
    expect(probes.liveness).not.toHaveBeenCalled();
  });
  it('does not present missing active orchestration as ongoing provisioning', async () => {
    rmSync(join(root, '.ours-fleet/rooms', `${roomId}.json`));
    expect(await outcome()).toMatchObject({ kind: 'degraded' });
  });
  it('keeps initial unready provisioning in progress and awaits its continuation', async () => {
    const path = join(root, '.ours-fleet/tasks', `${taskId}.json`);
    const task = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...task, state: 'provisioning' }));
    advanceSaga(roomId, 'wait_seats', 5);
    probes.control.mockResolvedValue({ ok: true, result: { alive: true, readiness: 'starting' } });
    expect(await service.awaitTaskProvisioning({ actor: { kind: 'local_control', surface: 'cli' }, taskId, waitMs: 0 }))
      .toMatchObject({ kind: 'in_progress' });
    expect(getRoom).not.toHaveBeenCalled();
    expect(probes.control).not.toHaveBeenCalled();
  });
  it('publishes a degraded audit notice with safe recovery advice instead of ready', async () => {
    room.seats[0].seat_state = 'removed';
    beginFleetAuditCollection();
    recordTaskProvisioningOutcome(await outcome());
    const notices = consumeFleetAuditCollection().presentations ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'lifecycle_failure', resource: 'Task', category: 'readiness_degraded' });
    expect(renderFleetLifecycleEvent(notices[0])).toMatch(/coordinator/i);
    expect(renderFleetLifecycleEvent(notices[0])).not.toMatch(/create it again/i);
  });
  it('sanitizes Cowork errors and provides recovery guidance', async () => {
    getRoom.mockRejectedValue(new Error('secret-invite /private/path'));
    const result = await outcome();
    expect(result.kind).toBe('degraded');
    expect(result.next_action).toMatch(/coordinator/i);
    expect(JSON.stringify(result)).not.toMatch(/secret-invite|private\/path/);
  });
  it('preserves task, room and retained context during concurrent repeated active starts', async () => {
    room.seats[0].seat_state = 'removed';
    room.seats.push({ ...room.seats[0], identity_cid: 'replacement-cid', seat_state: 'active' });
    const archive = join(root, '.ours-fleet/recovery/temporary/retained');
    mkdirSync(archive, { recursive: true }); writeFileSync(join(archive, 'WORKLOG.md'), 'retained context');
    const files = [join(root, '.ours-fleet/tasks', `${taskId}.json`),
      join(root, '.ours-fleet/rooms', `${roomId}.json`), join(archive, 'WORKLOG.md')];
    const before = files.map(file => readFileSync(file, 'utf8'));
    const results = await Promise.all(Array.from({ length: 3 }, async () => {
      await service.startTask({ actor: { kind: 'local_control', surface: 'cli' }, taskId });
      return outcome();
    }));
    expect(results.every(result => result.kind === 'degraded')).toBe(true);
    expect(provision).not.toHaveBeenCalled();
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
    expect(getTask(taskId).state).toBe('active');
  });
});
