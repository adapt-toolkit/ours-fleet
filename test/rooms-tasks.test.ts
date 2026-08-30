import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveTemplate, listTemplates, hashTemplate, snapshotTemplate,
  BUILTIN_TEMPLATES,
} from '../src/rooms-tasks/templates.js';
import {
  createTask, getTask, listTasks, findByIdempotencyKey,
  startTask, activateTask, blockTask, unblockTask,
  reviewTask, completeTask, cancelTask, failTask,
  deleteTask, updateTaskRoom, updateTaskMembers,
  TaskStateError,
} from '../src/rooms-tasks/task-state.js';
import {
  createRoomRecord, getRoomRecord, listRoomRecords,
  advanceSaga, setSagaError, setRoomIdentity, setOwnerSeat,
  updateMemberSeats, updateRoomRoleBriefing, updateMemberStartup,
  activateRoom, closeRoom,
  RoomStateError,
} from '../src/rooms-tasks/room-state.js';
import {
  validateRoomsConfig, validateTasksConfig, validateRoomTemplatesConfig,
  fingerprint, RoomsTasksConfigError,
} from '../src/rooms-tasks/config.js';
import type { TaskState, TemplateDefinition } from '../src/rooms-tasks/types.js';

let dir: string;
let origHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ours-fleet-rt-'));
  origHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = dir;
});
afterEach(() => {
  if (origHome !== undefined) process.env.OURS_FLEET_HOME = origHome;
  else delete process.env.OURS_FLEET_HOME;
  rmSync(dir, { recursive: true, force: true });
});

// ── Templates ──────────────────────────────────────────────────────────────

describe('templates', () => {
  describe('resolveTemplate', () => {
    it('resolves built-in by name', () => {
      const t = resolveTemplate('team', {});
      expect(t).toBeDefined();
      expect(t!.name).toBe('team');
      expect(t!.builtin).toBe(true);
    });

    it('resolves built-in by name@version', () => {
      const t = resolveTemplate('team@1', {});
      expect(t).toBeDefined();
      expect(t!.version).toBe(1);
    });

    it('returns undefined for wrong version', () => {
      expect(resolveTemplate('team@99', {})).toBeUndefined();
    });

    it('resolves the single builtin as a solo-agent template', () => {
      const t = resolveTemplate('single', {});
      expect(t).toBeDefined();
      expect(t!.builtin).toBe(true);
      expect(t!.members).toHaveLength(1);
      expect(t!.members[0].count).toBe(1);
      expect(resolveTemplate('single@1', {})).toBeDefined();
    });

    it('returns undefined for unknown name', () => {
      expect(resolveTemplate('nonexistent', {})).toBeUndefined();
    });

    it('custom overrides built-in', () => {
      const custom: Record<string, TemplateDefinition> = {
        'team': {
          name: 'team', version: 2, description: 'custom dev',
          members: [{ slot: 'dev', role: 'Dev', count: 2, role_ref: 'Dev' }],
        },
      };
      const t = resolveTemplate('team', custom);
      expect(t!.version).toBe(2);
      expect(t!.description).toBe('custom dev');
    });

    it('custom with version filter', () => {
      const custom: Record<string, TemplateDefinition> = {
        'my-template': {
          name: 'my-template', version: 3, description: 'mine',
          members: [{ slot: 'a', role: 'A', count: 1, role_ref: 'A' }],
        },
      };
      expect(resolveTemplate('my-template@3', custom)).toBeDefined();
      expect(resolveTemplate('my-template@2', custom)).toBeUndefined();
    });
  });

  describe('listTemplates', () => {
    it('returns built-ins when no custom templates', () => {
      const list = listTemplates({});
      expect(list.length).toBe(BUILTIN_TEMPLATES.length);
      expect(list.map(t => t.name)).toContain('team');
      expect(list.map(t => t.name)).toContain('pair');
      expect(list.map(t => t.name)).toContain('single');
    });

    it('merges custom with built-ins, sorted', () => {
      const custom: Record<string, TemplateDefinition> = {
        'aaa-first': {
          name: 'aaa-first', version: 1, description: 'first alphabetically',
          members: [{ slot: 'x', role: 'X', count: 1, role_ref: 'X' }],
        },
      };
      const list = listTemplates(custom);
      expect(list[0].name).toBe('aaa-first');
      expect(list.length).toBe(BUILTIN_TEMPLATES.length + 1);
    });

    it('custom with same name as builtin replaces it', () => {
      const custom: Record<string, TemplateDefinition> = {
        'team': {
          name: 'team', version: 2, description: 'override',
          members: [{ slot: 'a', role: 'A', count: 1, role_ref: 'A' }],
        },
      };
      const list = listTemplates(custom);
      const dt = list.find(t => t.name === 'team')!;
      expect(dt.version).toBe(2);
      expect(list.length).toBe(BUILTIN_TEMPLATES.length);
    });
  });

  describe('hashTemplate', () => {
    it('is deterministic', () => {
      const t = BUILTIN_TEMPLATES[0];
      expect(hashTemplate(t)).toBe(hashTemplate(t));
    });

    it('changes when content changes', () => {
      const t = BUILTIN_TEMPLATES[0];
      const modified = { ...t, description: 'changed' };
      expect(hashTemplate(t)).not.toBe(hashTemplate(modified));
    });

    it('is a 64-char hex string', () => {
      expect(hashTemplate(BUILTIN_TEMPLATES[0])).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('snapshotTemplate', () => {
    it('adds content_hash field', () => {
      const snap = snapshotTemplate(BUILTIN_TEMPLATES[0]);
      expect(snap.content_hash).toBe(hashTemplate(BUILTIN_TEMPLATES[0]));
      expect(snap.name).toBe(BUILTIN_TEMPLATES[0].name);
    });
  });
});

// ── Task state ─────────────────────────────────────────────────────────────

describe('task-state', () => {
  const origin = { type: 'cli' as const };

  describe('createTask', () => {
    it('creates a task in provisioning by default', () => {
      const t = createTask({ title: 'Test task', origin });
      expect(t.state).toBe('provisioning');
      expect(t.title).toBe('Test task');
      expect(t.task_id).toBeTruthy();
      expect(t.created_at).toBeTruthy();
      expect(t.started_at).toBeTruthy();
    });

    it('creates a task in backlog when start=false', () => {
      const t = createTask({ title: 'Backlog task', origin, start: false });
      expect(t.state).toBe('backlog');
      expect(t.started_at).toBeUndefined();
    });

    it('persists to disk', () => {
      const t = createTask({ title: 'Persist test', origin });
      const read = getTask(t.task_id);
      expect(read.title).toBe('Persist test');
    });
  });

  describe('idempotency', () => {
    it('same key returns existing task', () => {
      const t1 = createTask({ title: 'Idem', origin, idempotency_key: 'key-1' });
      const t2 = createTask({ title: 'Different', origin, idempotency_key: 'key-1' });
      expect(t1.task_id).toBe(t2.task_id);
      expect(t2.title).toBe('Idem');
    });

    it('different keys create different tasks', () => {
      const t1 = createTask({ title: 'A', origin, idempotency_key: 'k1' });
      const t2 = createTask({ title: 'B', origin, idempotency_key: 'k2' });
      expect(t1.task_id).not.toBe(t2.task_id);
    });

    it('findByIdempotencyKey returns the right task', () => {
      const t = createTask({ title: 'Find me', origin, idempotency_key: 'findable' });
      const found = findByIdempotencyKey('findable');
      expect(found).toBeDefined();
      expect(found!.task_id).toBe(t.task_id);
    });

    it('findByIdempotencyKey returns undefined for unknown key', () => {
      expect(findByIdempotencyKey('unknown-key')).toBeUndefined();
    });
  });

  describe('state transitions', () => {
    it('backlog → provisioning via startTask', () => {
      const t = createTask({ title: 'Start', origin, start: false });
      const started = startTask(t.task_id);
      expect(started.state).toBe('provisioning');
      expect(started.started_at).toBeTruthy();
    });

    it('provisioning → active via activateTask', () => {
      const t = createTask({ title: 'Activate', origin });
      const activated = activateTask(t.task_id);
      expect(activated.state).toBe('active');
    });

    it('active → review via reviewTask', () => {
      const t = createTask({ title: 'Review', origin });
      activateTask(t.task_id);
      const reviewed = reviewTask(t.task_id);
      expect(reviewed.state).toBe('review');
    });

    it('review → done via completeTask', () => {
      const t = createTask({ title: 'Done', origin });
      activateTask(t.task_id);
      reviewTask(t.task_id);
      const done = completeTask(t.task_id, { summary: 'All good' });
      expect(done.state).toBe('done');
      expect(done.ended_at).toBeTruthy();
      expect(done.outcome!.summary).toBe('All good');
    });

    it('full lifecycle: backlog → provisioning → active → review → done', () => {
      const t = createTask({ title: 'Full', origin, start: false });
      expect(t.state).toBe('backlog');
      startTask(t.task_id);
      activateTask(t.task_id);
      reviewTask(t.task_id);
      const done = completeTask(t.task_id);
      expect(done.state).toBe('done');
    });

    it('cancelTask works from cancellable states', () => {
      for (const startState of ['backlog', 'provisioning', 'active', 'review'] as const) {
        const t = createTask({ title: `Cancel from ${startState}`, origin, start: false });
        if (startState !== 'backlog') {
          startTask(t.task_id);
          if (startState !== 'provisioning') {
            activateTask(t.task_id);
            if (startState === 'review') reviewTask(t.task_id);
          }
        }
        const cancelled = cancelTask(t.task_id);
        expect(cancelled.state).toBe('cancelled');
        expect(cancelled.ended_at).toBeTruthy();
      }
    });

    it('failTask works from non-terminal states', () => {
      const t = createTask({ title: 'Fail', origin });
      const failed = failTask(t.task_id, 'Something broke');
      expect(failed.state).toBe('failed');
      expect(failed.outcome!.summary).toBe('Something broke');
    });

    it('throws on invalid transition: done → active', () => {
      const t = createTask({ title: 'Inv', origin });
      activateTask(t.task_id);
      reviewTask(t.task_id);
      completeTask(t.task_id);
      expect(() => activateTask(t.task_id)).toThrow(TaskStateError);
    });

    it('throws on invalid transition: backlog → active (must go through provisioning)', () => {
      const t = createTask({ title: 'Skip', origin, start: false });
      expect(() => activateTask(t.task_id)).toThrow(/cannot transition/);
    });

    it('cannot cancel a done task', () => {
      const t = createTask({ title: 'Done', origin });
      activateTask(t.task_id);
      reviewTask(t.task_id);
      completeTask(t.task_id);
      expect(() => cancelTask(t.task_id)).toThrow(/cannot cancel/);
    });

    it('cannot cancel a failed task', () => {
      const t = createTask({ title: 'Failed', origin });
      failTask(t.task_id, 'err');
      expect(() => cancelTask(t.task_id)).toThrow(/cannot cancel/);
    });
  });

  describe('block/unblock', () => {
    it('blockTask adds blocked overlay', () => {
      const t = createTask({ title: 'Block', origin });
      const blocked = blockTask(t.task_id, 'Waiting on cowork');
      expect(blocked.blocked).toBeDefined();
      expect(blocked.blocked!.reason).toBe('Waiting on cowork');
      expect(blocked.blocked!.at).toBeTruthy();
      expect(blocked.state).toBe('provisioning');
    });

    it('unblockTask removes blocked overlay', () => {
      const t = createTask({ title: 'Unblock', origin });
      blockTask(t.task_id, 'reason');
      const unblocked = unblockTask(t.task_id);
      expect(unblocked.blocked).toBeUndefined();
    });

    it('cannot block a terminal task', () => {
      const t = createTask({ title: 'Terminal', origin });
      activateTask(t.task_id);
      reviewTask(t.task_id);
      completeTask(t.task_id);
      expect(() => blockTask(t.task_id, 'nope')).toThrow(/cannot block/);
    });

    it('unblockTask throws when not blocked', () => {
      const t = createTask({ title: 'Not blocked', origin });
      expect(() => unblockTask(t.task_id)).toThrow(/not blocked/);
    });
  });

  describe('listTasks', () => {
    it('returns empty when no tasks dir', () => {
      expect(listTasks()).toEqual([]);
    });

    it('filters by state', () => {
      createTask({ title: 'A', origin, start: false });
      createTask({ title: 'B', origin });
      const backlog = listTasks({ state: 'backlog' });
      expect(backlog.length).toBe(1);
      expect(backlog[0].title).toBe('A');
      const prov = listTasks({ state: 'provisioning' });
      expect(prov.length).toBe(1);
      expect(prov[0].title).toBe('B');
    });

    it('returns all when no filter', () => {
      createTask({ title: 'X', origin, start: false });
      createTask({ title: 'Y', origin });
      expect(listTasks().length).toBe(2);
    });
  });

  describe('updateTaskRoom / updateTaskMembers', () => {
    it('updates room association', () => {
      const t = createTask({ title: 'Room', origin });
      const updated = updateTaskRoom(t.task_id, 'room-abc', 'cid-123');
      expect(updated.room_id).toBe('room-abc');
      expect(updated.room_identity_cid).toBe('cid-123');
    });

    it('updates member roles', () => {
      const t = createTask({ title: 'Members', origin });
      const members = [{ name: 'Dev-1', identity_cid: 'abc', slot: 'developer', cowork_role: 'Developer' }];
      const updated = updateTaskMembers(t.task_id, members);
      expect(updated.member_roles).toHaveLength(1);
      expect(updated.member_roles[0].name).toBe('Dev-1');
    });
  });

  describe('deleteTask', () => {
    function taskInState(state: TaskState) {
      const t = createTask({ title: `${state} task`, origin, start: state === 'backlog' ? false : undefined });
      if (state === 'backlog' || state === 'provisioning') return t;
      if (state === 'cancelled') return cancelTask(t.task_id);
      if (state === 'failed') return failTask(t.task_id, 'failed for test');
      activateTask(t.task_id);
      if (state === 'active') return getTask(t.task_id);
      reviewTask(t.task_id);
      if (state === 'review') return getTask(t.task_id);
      return completeTask(t.task_id);
    }

    it.each([
      'backlog', 'provisioning', 'active', 'review', 'cancelled', 'failed',
    ] as const)('rejects a %s task', state => {
      const t = taskInState(state);
      expect(() => deleteTask(t.task_id)).toThrow(
        `cannot delete a '${state}' task; only 'done' tasks can be deleted`,
      );
      expect(getTask(t.task_id).state).toBe(state);
    });

    it('removes only a done task and is idempotent when repeated', () => {
      const t = taskInState('done');
      expect(deleteTask(t.task_id)).toBe(true);
      expect(() => getTask(t.task_id)).toThrow(/not found/);
      expect(deleteTask(t.task_id)).toBe(false);
    });

    it('preserves the associated room orchestration record', () => {
      const t = taskInState('done');
      updateTaskRoom(t.task_id, 'room-delete-preserve', 'c'.repeat(64));
      const room = createRoomRecord({
        room_id: 'room-delete-preserve', room_name: 'Archived room', task_id: t.task_id,
      });

      expect(deleteTask(t.task_id)).toBe(true);
      expect(getRoomRecord(room.room_id)).toEqual(room);
    });

    it('rejects a traversal-shaped ID without touching an outside file', () => {
      const outside = join(dir, 'outside.json');
      writeFileSync(outside, JSON.stringify({ state: 'done' }));

      expect(() => deleteTask('../outside')).toThrow(/invalid task ID/);
      expect(readFileSync(outside, 'utf8')).toBe(JSON.stringify({ state: 'done' }));
    });
  });

  it('getTask throws for nonexistent', () => {
    expect(() => getTask('nonexistent-id')).toThrow(TaskStateError);
  });
});

// ── Room state ─────────────────────────────────────────────────────────────

describe('room-state', () => {
  describe('createRoomRecord', () => {
    it('creates a room in provisioning state', () => {
      const r = createRoomRecord({ room_id: 'room-1', room_name: 'Test Room' });
      expect(r.state).toBe('provisioning');
      expect(r.room_id).toBe('room-1');
      expect(r.room_name).toBe('Test Room');
      expect(r.saga.phase).toBe('persist_intent');
      expect(r.saga.step_index).toBe(0);
      expect(r.member_seats).toEqual([]);
      expect(r.created_at).toBeTruthy();
    });

    it('idempotent: same room_id returns existing', () => {
      const r1 = createRoomRecord({ room_id: 'room-dup', room_name: 'First' });
      const r2 = createRoomRecord({ room_id: 'room-dup', room_name: 'Second' });
      expect(r1.room_name).toBe('First');
      expect(r2.room_name).toBe('First');
    });

    it('persists to disk', () => {
      createRoomRecord({ room_id: 'room-disk', room_name: 'Disk' });
      const read = getRoomRecord('room-disk');
      expect(read).toBeDefined();
      expect(read!.room_name).toBe('Disk');
    });

    it('accepts task_id and template_snapshot', () => {
      const snap = snapshotTemplate(BUILTIN_TEMPLATES[0]);
      const r = createRoomRecord({
        room_id: 'room-full', room_name: 'Full',
        task_id: 'task-1', template_snapshot: snap,
      });
      expect(r.task_id).toBe('task-1');
      expect(r.template_snapshot!.content_hash).toBe(snap.content_hash);
    });
  });

  describe('getRoomRecord', () => {
    it('returns undefined for nonexistent', () => {
      expect(getRoomRecord('nope')).toBeUndefined();
    });
  });

  describe('listRoomRecords', () => {
    it('returns empty when no rooms dir', () => {
      expect(listRoomRecords()).toEqual([]);
    });

    it('filters by state', () => {
      createRoomRecord({ room_id: 'r1', room_name: 'R1' });
      createRoomRecord({ room_id: 'r2', room_name: 'R2' });
      activateRoom('r1');
      const active = listRoomRecords({ state: 'active' });
      expect(active.length).toBe(1);
      expect(active[0].room_id).toBe('r1');
      const prov = listRoomRecords({ state: 'provisioning' });
      expect(prov.length).toBe(1);
      expect(prov[0].room_id).toBe('r2');
    });
  });

  describe('advanceSaga', () => {
    it('updates saga phase and step', () => {
      createRoomRecord({ room_id: 'saga-1', room_name: 'Saga' });
      const r = advanceSaga('saga-1', 'create_room', 1);
      expect(r.saga.phase).toBe('create_room');
      expect(r.saga.step_index).toBe(1);
    });

    it('sets provisioning_detail', () => {
      createRoomRecord({ room_id: 'saga-2', room_name: 'Detail' });
      const r = advanceSaga('saga-2', 'attach_owner', 0, 'waiting_cowork');
      expect(r.provisioning_detail).toBe('waiting_cowork');
    });

    it('clears provisioning_detail when not provided', () => {
      createRoomRecord({ room_id: 'saga-3', room_name: 'Clear' });
      advanceSaga('saga-3', 'attach_owner', 0, 'waiting_cowork');
      const r = advanceSaga('saga-3', 'create_members');
      expect(r.provisioning_detail).toBeUndefined();
    });
  });

  describe('setSagaError', () => {
    it('records error and hint on saga', () => {
      createRoomRecord({ room_id: 'err-1', room_name: 'Err' });
      const r = setSagaError('err-1', 'cowork unreachable', 'check service', 'waiting_cowork');
      expect(r.saga.error).toBe('cowork unreachable');
      expect(r.saga.recovery_hint).toBe('check service');
      expect(r.provisioning_detail).toBe('waiting_cowork');
    });
  });

  describe('setRoomIdentity / setOwnerSeat / updateMemberSeats', () => {
    it('setRoomIdentity sets room_identity_cid', () => {
      createRoomRecord({ room_id: 'id-1', room_name: 'Id' });
      const r = setRoomIdentity('id-1', 'abc123');
      expect(r.room_identity_cid).toBe('abc123');
    });

    it('setOwnerSeat sets owner seat and fingerprint', () => {
      createRoomRecord({ room_id: 'own-1', room_name: 'Own' });
      const r = setOwnerSeat('own-1', 'owner-cid', 'fp-hash');
      expect(r.owner_seat_cid).toBe('owner-cid');
      expect(r.owner_invite_fingerprint).toBe('fp-hash');
    });

    it('updateMemberSeats replaces members', () => {
      createRoomRecord({ room_id: 'mem-1', room_name: 'Mem' });
      const seats = [
        { role_name: 'Dev-1', identity_cid: 'c1', slot: 'developer', cowork_role: 'Developer', seat_state: 'active' as const },
      ];
      const r = updateMemberSeats('mem-1', seats);
      expect(r.member_seats).toHaveLength(1);
      expect(r.member_seats[0].role_name).toBe('Dev-1');
    });
  });

  describe('durable member startup state', () => {
    it('persists one exact role definition at room scope', () => {
      createRoomRecord({ room_id: 'brief-1', room_name: 'Brief' });
      const r = updateRoomRoleBriefing('brief-1', 'Reviewer', {
        role: 'Reviewer', text: 'Review exactly.', sha256: 'a'.repeat(64),
        version: 2, state: 'configured', attempts: 1,
        updated_at: '2026-08-24T00:00:00.000Z',
      });
      expect(r.role_briefings?.Reviewer).toMatchObject({ version: 2, attempts: 1 });
      expect(getRoomRecord('brief-1')?.role_briefings?.Reviewer.text).toBe('Review exactly.');
    });

    it('persists forward-only launch progress per seat', () => {
      createRoomRecord({ room_id: 'brief-2', room_name: 'Brief' });
      updateMemberSeats('brief-2', [{
        role_name: 'Reviewer-1', identity_cid: 'cid-1', slot: 'reviewer',
        cowork_role: 'Reviewer', seat_state: 'active',
      }]);
      updateMemberStartup('brief-2', 'Reviewer-1', {
        launch: {
          state: 'intent', attempt: 1, action_id: 'action-1',
          mission_sha256: 'b'.repeat(64), updated_at: '2026-08-24T00:00:00.000Z',
        },
      });
      const r = updateMemberStartup('brief-2', 'Reviewer-1', {
        launch: {
          state: 'launched', attempt: 1, action_id: 'action-1',
          mission_sha256: 'b'.repeat(64), launch_id: 'launch-1',
          updated_at: '2026-08-24T00:00:01.000Z',
        },
      });
      expect(r.member_seats[0].launch?.launch_id).toBe('launch-1');
      expect(() => updateMemberStartup('brief-2', 'Reviewer-1', {
        launch: {
          state: 'intent', attempt: 1, action_id: 'action-1',
          mission_sha256: 'b'.repeat(64), updated_at: 'older',
        },
      })).toThrow(/cannot move backward/);
    });

    it('permits a stopped launch to begin a new durable attempt', () => {
      createRoomRecord({ room_id: 'brief-3', room_name: 'Brief' });
      updateMemberSeats('brief-3', [{
        role_name: 'Reviewer-1', identity_cid: 'cid-1', slot: 'reviewer',
        cowork_role: 'Reviewer', seat_state: 'active',
        launch: { state: 'stopped', attempt: 1, updated_at: 'old' },
      }]);
      const r = updateMemberStartup('brief-3', 'Reviewer-1', {
        launch: {
          state: 'intent', attempt: 2, action_id: 'action-2',
          mission_sha256: 'c'.repeat(64), updated_at: 'new',
        },
      });
      expect(r.member_seats[0].launch).toMatchObject({ state: 'intent', attempt: 2 });
    });
  });

  describe('activateRoom', () => {
    it('sets state=active, saga=completed, activated_at', () => {
      createRoomRecord({ room_id: 'act-1', room_name: 'Act' });
      advanceSaga('act-1', 'activate');
      const r = activateRoom('act-1');
      expect(r.state).toBe('active');
      expect(r.saga.phase).toBe('completed');
      expect(r.activated_at).toBeTruthy();
      expect(r.provisioning_detail).toBeUndefined();
    });
  });

  describe('closeRoom', () => {
    it('closes a room', () => {
      createRoomRecord({ room_id: 'cls-1', room_name: 'Close' });
      const r = closeRoom('cls-1');
      expect(r.state).toBe('closed');
      expect(r.closed_at).toBeTruthy();
    });

    it('is idempotent on already-closed room', () => {
      createRoomRecord({ room_id: 'cls-2', room_name: 'Close2' });
      const r1 = closeRoom('cls-2');
      const r2 = closeRoom('cls-2');
      expect(r1.closed_at).toBe(r2.closed_at);
    });
  });
});

// ── Config validation ──────────────────────────────────────────────────────

describe('config validation', () => {
  const CID_64 = 'a'.repeat(64);
  const vars: Record<string, string> = {};

  describe('validateRoomsConfig', () => {
    it('accepts valid minimal config', () => {
      const cfg = validateRoomsConfig({
        owner: { expected_cid: CID_64 },
      }, vars, 'test');
      expect(cfg).not.toHaveProperty('provider');
      expect(cfg.owner.expected_cid).toBe(CID_64);
      expect(cfg.owner.role).toBe('Owner');
    });

    it('rejects non-object', () => {
      expect(() => validateRoomsConfig('string', vars, 'test'))
        .toThrow(RoomsTasksConfigError);
    });

    it('rejects missing owner', () => {
      expect(() => validateRoomsConfig({}, vars, 'test'))
        .toThrow(/rooms.owner: required/);
    });

    it('rejects invalid expected_cid format', () => {
      expect(() => validateRoomsConfig({
        owner: { expected_cid: 'short' },
      }, vars, 'test')).toThrow(/must be exactly 64 hexadecimal/);
    });

    it('rejects missing expected_cid', () => {
      expect(() => validateRoomsConfig({
        owner: {},
      }, vars, 'test')).toThrow(/expected_cid: required/);
    });

    it('lowercases CID', () => {
      const upperCid = 'A'.repeat(64);
      const cfg = validateRoomsConfig({
        owner: { expected_cid: upperCid },
      }, vars, 'test');
      expect(cfg.owner.expected_cid).toBe('a'.repeat(64));
    });

    it('redacts inline invite', () => {
      const cfg = validateRoomsConfig({
        owner: { expected_cid: CID_64, public_invite: 'secret-invite-material' },
      }, vars, 'test');
      expect(cfg.owner.public_invite).toBe('[REDACTED]');
      expect(cfg._invite).toBeDefined();
      expect(cfg._invite!.value).toBe('secret-invite-material');
      expect(cfg._invite!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects both inline and file invite', () => {
      expect(() => validateRoomsConfig({
        owner: {
          expected_cid: CID_64,
          public_invite: 'inline',
          public_invite_file: '/some/file',
        },
      }, vars, 'test')).toThrow(/exactly one of/);
    });

    it('resolves invite from file', () => {
      const inviteFile = join(dir, 'invite.txt');
      writeFileSync(inviteFile, 'file-invite-content\n');
      const cfg = validateRoomsConfig({
        owner: { expected_cid: CID_64, public_invite_file: inviteFile },
      }, vars, 'test');
      expect(cfg._invite!.value).toBe('file-invite-content');
    });

    it('rejects nonexistent invite file', () => {
      expect(() => validateRoomsConfig({
        owner: { expected_cid: CID_64, public_invite_file: '/no/such/file' },
      }, vars, 'test')).toThrow(/not found/);
    });

    it('rejects unknown keys', () => {
      expect(() => validateRoomsConfig({
        owner: { expected_cid: CID_64 },
        bogus: true,
      }, vars, 'test')).toThrow(/unknown key.*bogus/);
    });

    it('accepts and drops the exact legacy cowork provider', () => {
      const cfg = validateRoomsConfig({
        provider: 'cowork',
        owner: { expected_cid: CID_64 },
      }, vars, 'test');
      expect(cfg).not.toHaveProperty('provider');
    });

    it.each(['something-else', null, undefined, 1, true, {}])(
      'rejects a non-migratable legacy provider value: %j',
      provider => {
        expect(() => validateRoomsConfig({
          provider,
          owner: { expected_cid: CID_64 },
        }, vars, 'test')).toThrow(/rooms\.provider:.*remove this field/);
      },
    );

    it('preserves the distinct owner provider setting', () => {
      const cfg = validateRoomsConfig({
        owner: { provider: 'messenger-server', expected_cid: CID_64 },
      }, vars, 'test');
      expect(cfg.owner.provider).toBe('messenger-server');
    });

    it('accepts valid defaults section', () => {
      const cfg = validateRoomsConfig({
        owner: { expected_cid: CID_64 },
        defaults: { template: 'team', attach_owner: true },
      }, vars, 'test');
      expect(cfg.defaults!.template).toBe('team');
      expect(cfg.defaults!.attach_owner).toBe(true);
    });

    it('rejects unknown defaults keys', () => {
      expect(() => validateRoomsConfig({
        owner: { expected_cid: CID_64 },
        defaults: { unknown_option: true },
      }, vars, 'test')).toThrow(/unknown key/);
    });
  });

  describe('validateTasksConfig', () => {
    it('accepts valid config', () => {
      const cfg = validateTasksConfig({
        default_room_template: 'dev-team',
        create_mode: 'backlog',
        close_room_on_done: true,
      }, 'test');
      expect(cfg.create_mode).toBe('backlog');
      expect(cfg.close_room_on_done).toBe(true);
    });

    it('accepts empty config', () => {
      const cfg = validateTasksConfig({}, 'test');
      expect(cfg.create_mode).toBeUndefined();
    });

    it('rejects non-object', () => {
      expect(() => validateTasksConfig('string', 'test'))
        .toThrow(RoomsTasksConfigError);
    });

    it('rejects invalid create_mode', () => {
      expect(() => validateTasksConfig({ create_mode: 'invalid' }, 'test'))
        .toThrow(/create_mode/);
    });

    it('rejects non-boolean close_room_on_done', () => {
      expect(() => validateTasksConfig({ close_room_on_done: 'yes' }, 'test'))
        .toThrow(/boolean/);
    });

    it('rejects unknown keys', () => {
      expect(() => validateTasksConfig({ unknown: true }, 'test'))
        .toThrow(/unknown key/);
    });
  });

  describe('validateRoomTemplatesConfig', () => {
    const validTemplate = {
      version: 1,
      description: 'Test template',
      members: [{ slot: 'dev', role: 'Developer', count: 2, agent: { ref: 'Dev' } }],
    };

    it('accepts valid template', () => {
      const cfg = validateRoomTemplatesConfig({ 'my-template': validTemplate }, 'test');
      expect(cfg['my-template']).toBeDefined();
      expect(cfg['my-template'].name).toBe('my-template');
      expect(cfg['my-template'].version).toBe(1);
      expect(cfg['my-template'].members).toHaveLength(1);
    });

    it('rejects non-object', () => {
      expect(() => validateRoomTemplatesConfig('nope', 'test'))
        .toThrow(RoomsTasksConfigError);
    });

    it('rejects invalid template name', () => {
      expect(() => validateRoomTemplatesConfig({ 'UPPER CASE': validTemplate }, 'test'))
        .toThrow(/invalid template name/);
    });

    it('rejects missing version', () => {
      expect(() => validateRoomTemplatesConfig({
        't': { description: 'x', members: [{ slot: 'a', role: 'A', count: 1, agent: { ref: 'A' } }] },
      }, 'test')).toThrow(/version.*required positive integer/);
    });

    it('rejects missing description', () => {
      expect(() => validateRoomTemplatesConfig({
        't': { version: 1, members: [{ slot: 'a', role: 'A', count: 1, agent: { ref: 'A' } }] },
      }, 'test')).toThrow(/description.*required string/);
    });

    it('rejects empty members array', () => {
      expect(() => validateRoomTemplatesConfig({
        't': { version: 1, description: 'x', members: [] },
      }, 'test')).toThrow(/members.*required non-empty/);
    });

    it('rejects missing member fields', () => {
      expect(() => validateRoomTemplatesConfig({
        't': { version: 1, description: 'x', members: [{ slot: 'a' }] },
      }, 'test')).toThrow(/role.*required string/);
    });

    it('requires override_builtin for builtin name', () => {
      expect(() => validateRoomTemplatesConfig({
        'team': { version: 2, description: 'override', members: validTemplate.members },
      }, 'test')).toThrow(/override_builtin/);
    });

    it('accepts builtin override with override_builtin: true', () => {
      const cfg = validateRoomTemplatesConfig({
        'team': {
          ...validTemplate, version: 2, override_builtin: true,
        },
      }, 'test');
      expect(cfg['team'].version).toBe(2);
    });

    it('rejects unknown keys in template', () => {
      expect(() => validateRoomTemplatesConfig({
        't': { ...validTemplate, bad_key: true },
      }, 'test')).toThrow(/unknown key.*bad_key/);
    });

    it('rejects the removed task-only override schema', () => {
      expect(() => validateRoomTemplatesConfig({
        't': {
          version: 1, description: 'x',
          members: [{ slot: 'a', role: 'A', count: 1, agent: { ref: 'A' }, overrides: { bad: true } }],
        },
      }, 'test')).toThrow(/unknown key.*overrides/);
    });

    it('accepts a canonical inline Agent', () => {
      const cfg = validateRoomTemplatesConfig({
        't': {
          version: 1, description: 'x',
          members: [{
            slot: 'a', role: 'A', count: 1,
            agent: { brain: { inline: { harness: 'claude-code', model: 'claude-opus-4-6' } },
              role: { inline: { persona: 'test' } } },
          }],
        },
      }, 'test');
      expect(cfg.t.members[0].agent).toBeDefined();
    });
  });

  describe('fingerprint', () => {
    it('produces consistent SHA-256 hex', () => {
      const fp = fingerprint('test-invite');
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
      expect(fp).toBe(fingerprint('test-invite'));
    });

    it('trims whitespace', () => {
      expect(fingerprint('  test  ')).toBe(fingerprint('test'));
    });
  });
});
