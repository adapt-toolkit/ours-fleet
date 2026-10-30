import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  beginTaskDeletionIntent, createTask, getTask, migrateMissionKeysLocked, resolveTaskRef,
  allocateTaskMemberNames,
} from '../src/rooms-tasks/task-state.js';
import {
  ensureMissionKeyRegistry, normalizeMissionPrefix, readCreationReceipt, readKeyLedger,
  readMissionKeyRegistry, suggestMissionPrefix, MissionKeyError,
} from '../src/rooms-tasks/mission-keys.js';
import { allocateName, chooseStem, freezeLegacyMemberNaming } from '../src/rooms-tasks/member-naming.js';
import { createTaskListLocked, deleteTaskListRecordLocked, readTaskLists, resolveTaskList, setTaskListPrefixLocked } from '../src/rooms-tasks/task-lists.js';
import { layoutOwnedMemberName, legacyLayoutMemberName, allocateLayoutMemberName } from '../src/rooms-tasks/layout-member-retirement.js';
import { appendTaskProgress } from '../src/rooms-tasks/task-review.js';
import { createRoomRecord } from '../src/rooms-tasks/room-state.js';
import { writeV2Fixture } from './v2-fixture.js';

let root: string;
let previousHome: string | undefined;
const origin = { type: 'cli' as const };
const fleet = () => join(root, '.ours-fleet');
const taskFile = (id: string) => join(fleet(), 'tasks', `${id}.json`);
const readRow = (id: string) => JSON.parse(readFileSync(taskFile(id), 'utf8'));
const writeRow = (id: string, row: unknown) => writeFileSync(taskFile(id), JSON.stringify(row));
const receiptsDir = () => join(fleet(), 'mission-keys', 'receipts');
const onlyReceipt = () => JSON.parse(readFileSync(join(receiptsDir(), readdirSync(receiptsDir())[0]), 'utf8'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mission-keys-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  writeV2Fixture(join(root, 'fleet.yaml'), {});
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('prefix rules', () => {
  it('normalizes case and whitespace and rejects everything else with an explicit error', () => {
    expect(normalizeMissionPrefix(' ops ')).toBe('OPS');
    expect(normalizeMissionPrefix('m')).toBe('M');
    expect(normalizeMissionPrefix('abc123')).toBe('ABC123');
    for (const bad of ['', '1AB', 'TOOLONG', 'A-B', 'ÄBC', 'A B', 'МСН'])
      expect(() => normalizeMissionPrefix(bad)).toThrow(/1-6 Latin letters or digits starting with a letter/);
  });

  it('suggests deterministic, usable prefixes for Latin, non-Latin, empty and colliding names', () => {
    const none = new Set<string>();
    expect(suggestMissionPrefix('Ops Board', none)).toBe('OB');
    expect(suggestMissionPrefix('Marketing', none)).toBe('MARK');
    expect(suggestMissionPrefix('Café Été', none)).toBe('CE');
    expect(suggestMissionPrefix('Разработка', none)).toBe('L1');
    expect(suggestMissionPrefix('', none)).toBe('L1');
    expect(suggestMissionPrefix('Marketing', new Set(['MARK']))).toBe('MARK2');
    // Reserved and default-like names never come back as suggestions.
    expect(suggestMissionPrefix('Mission', none)).toBe('MISS');
    expect(suggestMissionPrefix('Task', none)).toBe('TASK2');
    expect(suggestMissionPrefix('Room', none)).toBe('ROOM2');
  });

  it('keeps edited and deleted prefixes reserved with their high-water marks', () => {
    const ops = createTaskListLocked('Operations', 'OPS');
    expect(ops.prefix).toBe('OPS');
    expect(() => createTaskListLocked('Other', 'ops')).toThrow(/already used by another list/);
    expect(() => createTaskListLocked('Reserved', 'MSN')).toThrow(/reserved/);
    expect(() => createTaskListLocked('Reserved', 'ROOM')).toThrow(/reserved/);
    const first = createTask({ title: 'A', origin, list: 'Operations', start: false });
    expect(first.key).toBe('OPS-1');
    setTaskListPrefixLocked('Operations', 'OP');
    const second = createTask({ title: 'B', origin, list: 'Operations', start: false });
    expect(second.key).toBe('OP-1');
    expect(getTask(first.task_id).key).toBe('OPS-1');
    // The retired prefix stays bound to its list: another list cannot take it, the same list can return.
    expect(() => createTaskListLocked('Thief', 'OPS')).toThrow(/reserved/);
    setTaskListPrefixLocked('Operations', 'OPS');
    expect(createTask({ title: 'C', origin, list: 'Operations', start: false }).key).toBe('OPS-2');
    // Deleting the list tombstones its prefixes; a suggestion never reuses one, an explicit reclaim continues.
    deleteTaskListRecordLocked(resolveTaskList('Operations').list_id);
    expect(suggestMissionPrefix('Ops', new Set(Object.keys(readMissionKeyRegistry()!.prefixes)))).not.toBe('OPS');
    const recreated = createTaskListLocked('Operations', 'OPS');
    expect(createTask({ title: 'D', origin, list: recreated.name, start: false }).key).toBe('OPS-3');
  });

  it('lets tasks.default_prefix change only before the first key', () => {
    ensureMissionKeyRegistry('WORK');
    expect(readTaskLists()[0]).toMatchObject({ list_id: 'default', prefix: 'WORK' });
    ensureMissionKeyRegistry('JOB');
    expect(createTask({ title: 'A', origin, start: false }).key).toBe('JOB-1');
    expect(() => ensureMissionKeyRegistry('WORK')).toThrow(MissionKeyError);
    expect(() => ensureMissionKeyRegistry('WORK')).toThrow(/default_prefix=WORK can only change before the first mission key/);
  });
});

describe('mission number allocation', () => {
  it('allocates N+1 from the high-water mark, never from current rows', () => {
    const a = createTask({ title: 'A', origin, start: false });
    const b = createTask({ title: 'B', origin, start: false });
    expect([a.key, b.key]).toEqual(['MSN-1', 'MSN-2']);
    rmSync(taskFile(b.task_id));
    expect(createTask({ title: 'C', origin, start: false }).key).toBe('MSN-3');
  });

  it('issues unique contiguous keys to concurrent separate-process CLI creators', async () => {
    const env = { ...process.env, OURS_FLEET_HOME: root };
    const run = promisify(execFile);
    const outputs = await Promise.all(Array.from({ length: 6 }, (_, i) => run(process.execPath,
      [resolve('dist/cli.js'), 'task', 'create', '--title', `Parallel ${i}`, '--backlog', '--no-room', '--json'], { env })));
    const keys = outputs.map(output => JSON.parse(output.stdout).task.key as string);
    expect(new Set(keys).size).toBe(6);
    expect([...keys].sort((x, y) => Number(x.split('-')[1]) - Number(y.split('-')[1])))
      .toEqual(['MSN-1', 'MSN-2', 'MSN-3', 'MSN-4', 'MSN-5', 'MSN-6']);
    expect(readMissionKeyRegistry()!.prefixes.MSN.last_issued).toBe(6);
  }, 60_000);

  it('replays the original request: first write wins, a different plan conflicts', () => {
    const first = createTask({ title: 'Original', origin, idempotency_key: 'idem-1', start: false });
    const replay = createTask({ title: 'Changed title', origin, idempotency_key: 'idem-1', start: false });
    expect(replay).toMatchObject({ task_id: first.task_id, key: 'MSN-1', title: 'Original' });
    expect(() => createTask({ title: 'Original', origin, idempotency_key: 'idem-1', start: false, no_room: true,
      execution_plan: { plan_hash: 'other' } as never })).toThrow(/different execution plan/);
    expect(readMissionKeyRegistry()!.prefixes.MSN.last_issued).toBe(1);
  });

  it('replays before resolving the list: a renamed source list neither fails nor reallocates', () => {
    createTaskListLocked('Short lived', 'SL');
    const first = createTask({ title: 'A', origin, idempotency_key: 'idem-list', list: 'Short lived', start: false });
    expect(first.key).toBe('SL-1');
    // renameTaskListLocked is the list-lock primitive behind every rename surface.
    const lists = JSON.parse(readFileSync(join(fleet(), 'task-lists.json'), 'utf8'));
    lists.lists[0].name = 'Renamed'; writeFileSync(join(fleet(), 'task-lists.json'), JSON.stringify(lists));
    const replay = createTask({ title: 'A', origin, idempotency_key: 'idem-list', list: 'Short lived', start: false });
    expect(replay).toMatchObject({ task_id: first.task_id, key: 'SL-1', list_name: 'Renamed' });
    expect(readMissionKeyRegistry()!.prefixes.SL.last_issued).toBe(1);
  });

  describe('crash cuts (high-water → reserved receipt → ledger → row → created)', () => {
    it('after the high-water write only: a harmless gap', () => {
      createTask({ title: 'A', origin, start: false });
      const registryPath = join(fleet(), 'mission-keys', 'registry.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      registry.prefixes.MSN.last_issued += 1;
      writeFileSync(registryPath, JSON.stringify(registry));
      expect(createTask({ title: 'B', origin, start: false }).key).toBe('MSN-3');
    });

    it('after the reserved receipt, before the ledger and row: retry resumes the same ID and key', () => {
      const created = createTask({ title: 'Original', origin, idempotency_key: 'cut-receipt', start: false });
      rmSync(taskFile(created.task_id));
      rmSync(join(fleet(), 'mission-keys', 'keys', 'MSN-1.json'));
      const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
      writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'reserved' }));
      const resumed = createTask({ title: 'Retry title is ignored', brief: 'changed', origin, idempotency_key: 'cut-receipt',
        start: true, list: 'default' });
      expect(resumed).toMatchObject({ task_id: created.task_id, key: 'MSN-1', title: 'Original', created_at: created.created_at,
        state: 'backlog' });
      expect(resumed.brief).toBeUndefined();
      expect(readKeyLedger('MSN-1')).toMatchObject({ task_id: created.task_id, state: 'live' });
      expect(readCreationReceipt('cut-receipt')?.state).toBe('created');
      expect(readMissionKeyRegistry()!.prefixes.MSN.last_issued).toBe(1);
    });

    it('reserved resume restores the original title, brief, list, start mode and no-room flag only', () => {
      createTaskListLocked('Ops', 'OPS');
      const created = createTask({ title: 'Original', brief: 'Original brief', origin, idempotency_key: 'cut-full',
        list: 'Ops', start: false, no_room: true });
      rmSync(taskFile(created.task_id));
      const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
      writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'reserved' }));
      const resumed = createTask({ title: 'Other', brief: 'Other brief', origin, idempotency_key: 'cut-full',
        list: 'default', start: false, no_room: true });
      expect(resumed).toMatchObject({ task_id: created.task_id, key: 'OPS-1', title: 'Original', brief: 'Original brief',
        list_name: 'Ops', state: 'backlog', no_room: true });
    });

    it('reserved resume after its source list was deleted keeps the key and lands in default', () => {
      createTaskListLocked('Gone', 'GONE');
      const created = createTask({ title: 'A', origin, idempotency_key: 'cut-list', list: 'Gone', start: false });
      rmSync(taskFile(created.task_id));
      const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
      writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'reserved' }));
      deleteTaskListRecordLocked(resolveTaskList('Gone').list_id);
      const resumed = createTask({ title: 'A', origin, idempotency_key: 'cut-list', list: 'Gone', start: false });
      expect(resumed).toMatchObject({ task_id: created.task_id, key: 'GONE-1', list_name: 'default' });
      expect(readMissionKeyRegistry()!.prefixes.GONE).toMatchObject({ last_issued: 1, state: 'tombstoned' });
    });

    it('a different room plan on a reserved receipt is still a conflict', () => {
      const created = createTask({ title: 'A', origin, idempotency_key: 'cut-plan', start: false });
      rmSync(taskFile(created.task_id));
      const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
      writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'reserved' }));
      expect(() => createTask({ title: 'A', origin, idempotency_key: 'cut-plan', start: false,
        layout: { name: 'other', definition_hash: 'h' } })).toThrow(/different execution plan/);
      expect(existsSync(taskFile(created.task_id))).toBe(false);
    });

    it('after the row, before receipt created: retry returns the task and repairs the ledger', () => {
      const created = createTask({ title: 'A', origin, idempotency_key: 'cut-row', start: false });
      rmSync(join(fleet(), 'mission-keys', 'keys', 'MSN-1.json'));
      const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
      writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'reserved' }));
      expect(createTask({ title: 'A', origin, idempotency_key: 'cut-row', start: false }).task_id).toBe(created.task_id);
      expect(readCreationReceipt('cut-row')?.state).toBe('created');
      expect(readKeyLedger('MSN-1')?.task_id).toBe(created.task_id);
    });

    it('a created receipt whose row is gone is never resurrected', () => {
      const created = createTask({ title: 'A', origin, idempotency_key: 'cut-gone', start: false });
      rmSync(taskFile(created.task_id));
      expect(() => createTask({ title: 'A', origin, idempotency_key: 'cut-gone', start: false })).toThrow(/was deleted/);
      expect(existsSync(taskFile(created.task_id))).toBe(false);
    });
  });

  it('deletion tombstones the receipt and key before the intent; retries and lookups stay stable', () => {
    const created = createTask({ title: 'A', origin, idempotency_key: 'deleted-one', start: false });
    const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
    // Even a receipt left reserved by a crash is tombstoned by deletion acceptance.
    writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'reserved' }));
    expect(beginTaskDeletionIntent(created.task_id, { kind: 'local_control', surface: 'cli' }).status).toBe('accepted');
    expect(readCreationReceipt('deleted-one')?.state).toBe('deleted');
    expect(readKeyLedger('MSN-1')?.state).toBe('deleted');
    rmSync(taskFile(created.task_id)); // settlement unlinks the row
    expect(() => createTask({ title: 'A', origin, idempotency_key: 'deleted-one', start: false })).toThrow(/was deleted/);
    expect(() => resolveTaskRef('msn-1')).toThrow(/MSN-1 was deleted/);
    expect(resolveTaskRef('MSN-1', { allowDeleted: true })).toBe(created.task_id);
    expect(createTask({ title: 'B', origin, start: false }).key).toBe('MSN-2');
  });

  it('a crash between the tombstone and the deletion intent keeps the live task returnable', () => {
    const created = createTask({ title: 'A', origin, idempotency_key: 'half-deleted', start: false });
    const receiptFile = join(receiptsDir(), readdirSync(receiptsDir())[0]);
    writeFileSync(receiptFile, JSON.stringify({ ...onlyReceipt(), state: 'deleted' }));
    expect(createTask({ title: 'A', origin, idempotency_key: 'half-deleted', start: false }).task_id).toBe(created.task_id);
    expect(readCreationReceipt('half-deleted')?.state).toBe('deleted');
  });

  it('resolves keys case-insensitively and passes canonical and unknown non-key refs through unchanged', () => {
    const created = createTask({ title: 'A', origin, start: false });
    expect(resolveTaskRef('MSN-1')).toBe(created.task_id);
    expect(resolveTaskRef('msn-1')).toBe(created.task_id);
    expect(resolveTaskRef(created.task_id)).toBe(created.task_id);
    expect(resolveTaskRef('definitely-missing')).toBe('definitely-missing');
    expect(() => resolveTaskRef('MSN-99')).toThrow(/task not found: MSN-99/);
  });
});

describe('one-time migration', () => {
  /** Strip everything mission keys added, leaving rows as an earlier release wrote them. */
  const downgrade = (ids: string[]) => {
    rmSync(join(fleet(), 'mission-keys'), { recursive: true, force: true });
    for (const id of ids) {
      const row = readRow(id);
      delete row.key; delete row.member_naming; delete row.key_from_migration;
      writeRow(id, row);
    }
    const listsPath = join(fleet(), 'task-lists.json');
    if (existsSync(listsPath)) {
      const lists = JSON.parse(readFileSync(listsPath, 'utf8'));
      for (const list of lists.lists) delete list.prefix;
      writeFileSync(listsPath, JSON.stringify(lists));
    }
  };

  it('assigns prefixes and keys by list and creation order, seeds receipts and ledger, and is re-runnable', () => {
    createTaskListLocked('Ops Board', 'TMP');
    const a = createTask({ title: 'A', origin, idempotency_key: 'm-a', start: false });
    const b = createTask({ title: 'B', origin, idempotency_key: 'm-b', list: 'Ops Board', start: false });
    const c = createTask({ title: 'C', origin, idempotency_key: 'm-c', start: false });
    downgrade([a.task_id, b.task_id, c.task_id]);
    migrateMissionKeysLocked();
    expect([readRow(a.task_id).key, readRow(c.task_id).key, readRow(b.task_id).key]).toEqual(['MSN-1', 'MSN-2', 'OB-1']);
    expect(readRow(a.task_id).key_from_migration).toBe(true);
    expect(readTaskLists().find(list => list.name === 'Ops Board')?.prefix).toBe('OB');
    for (const [key, id] of [['MSN-1', a.task_id], ['MSN-2', c.task_id], ['OB-1', b.task_id]])
      expect(readKeyLedger(key)).toMatchObject({ task_id: id, state: 'live' });
    expect(readCreationReceipt('m-b')).toMatchObject({ task_id: b.task_id, mission_key: 'OB-1', state: 'created' });
    expect(readMissionKeyRegistry()!.keys_migrated).toBe(true);
    const before = readFileSync(taskFile(a.task_id), 'utf8');
    migrateMissionKeysLocked();
    expect(readFileSync(taskFile(a.task_id), 'utf8')).toBe(before);
    expect(createTask({ title: 'D', origin, start: false }).key).toBe('MSN-3');
  });

  it('resumes after a crash between receipt+ledger and the keyed row without a new number', () => {
    const a = createTask({ title: 'A', origin, idempotency_key: 'r-a', start: false });
    const b = createTask({ title: 'B', origin, idempotency_key: 'r-b', start: false });
    downgrade([a.task_id, b.task_id]);
    migrateMissionKeysLocked();
    // Simulate the cut: B's receipt and ledger hold its key, its row and the completion flag do not.
    const row = readRow(b.task_id); delete row.key; writeRow(b.task_id, row);
    rmSync(join(fleet(), 'mission-keys', 'keys', 'MSN-2.json'));
    const registryPath = join(fleet(), 'mission-keys', 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')); delete registry.keys_migrated;
    writeFileSync(registryPath, JSON.stringify(registry));
    migrateMissionKeysLocked();
    expect(readRow(b.task_id).key).toBe('MSN-2');
    expect(readKeyLedger('MSN-2')?.task_id).toBe(b.task_id);
    expect(readMissionKeyRegistry()!.prefixes.MSN.last_issued).toBe(2);
  });

  it('marks pending-deletion rows deleted and never revives a deleted receipt', () => {
    const a = createTask({ title: 'A', origin, idempotency_key: 'del-a', start: false });
    downgrade([a.task_id]);
    const row = readRow(a.task_id);
    row.deletion = { status: 'pending', accepted_at: new Date().toISOString(), actor: { kind: 'local_control', surface: 'cli' }, members: [] };
    writeRow(a.task_id, row);
    migrateMissionKeysLocked();
    expect(readCreationReceipt('del-a')?.state).toBe('deleted');
    expect(readKeyLedger('MSN-1')?.state).toBe('deleted');
  });

  it('preserves progress appended by another process while the migration runs', async () => {
    const tasks = Array.from({ length: 8 }, (_, i) => createTask({ title: `T${i}`, origin, start: false }));
    downgrade(tasks.map(task => task.task_id));
    const env = { ...process.env, OURS_FLEET_HOME: root };
    const child = promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(resolve('dist/rooms-tasks/task-state.js'))}); m.migrateMissionKeysLocked();`], { env });
    const author = { kind: 'local_control' as const, surface: 'cli' as const };
    for (const task of tasks) appendTaskProgress(task.task_id, { text: `progress ${task.title}`, author });
    await child;
    for (const task of tasks) {
      const stored = readRow(task.task_id);
      expect(stored.key).toMatch(/^MSN-[1-8]$/);
      expect(stored.progress.map((entry: { text: string }) => entry.text)).toEqual([`progress ${task.title}`]);
    }
    expect(new Set(tasks.map(task => readRow(task.task_id).key)).size).toBe(8);
  }, 60_000);
});

describe('agent names', () => {
  it('omits -1, numbers later members, and shares one counter per case-folded stem', () => {
    let naming;
    const take = (key: string, label: string) => {
      const result = allocateName(naming, 'MSN-1', key, [{ label, source: 'role_override' }]);
      naming = result.naming; return result.allocation.name;
    };
    expect(take('initial:developer:1', 'Developer')).toBe('MSN-1-Developer');
    expect(take('add:r1', 'developer')).toBe('MSN-1-Developer-2');
    expect(take('add:r2', 'Developer')).toBe('MSN-1-Developer-3');
    expect(take('initial:developer:1', 'Developer')).toBe('MSN-1-Developer');
    expect(take('initial:lc:1', 'Local coordinator')).toBe('MSN-1-LocalCoordinator');
    expect(take('add:r3', 'LocalCoordinator')).toBe('MSN-1-LocalCoordinator-2');
  });

  it('truncates with ordinal headroom and buckets the truncated stem', () => {
    const long = 'Principal Distributed Systems Reliability Engineering Reviewer Alpha';
    const other = 'Principal Distributed Systems Reliability Engineering Reviewer Beta';
    const { stem } = chooseStem('ABCDEF-123456789', [{ label: long, source: 'room_role' }]);
    expect(`ABCDEF-123456789-${stem}-999`.length).toBeLessThanOrEqual(64);
    let naming;
    const first = allocateName(naming, 'ABCDEF-123456789', 'a', [{ label: long, source: 'room_role' }]); naming = first.naming;
    const second = allocateName(naming, 'ABCDEF-123456789', 'b', [{ label: other, source: 'room_role' }]);
    expect(second.allocation.name).toBe(`${first.allocation.name}-2`);
    expect(chooseStem('MSN-1', [{ label: 'Разработчик', source: 'room_role' }, { label: 'dev', source: 'slot' }]))
      .toEqual({ stem: 'Dev', source: 'slot' });
    expect(chooseStem('MSN-1', [{ label: '日本', source: 'room_role' }])).toEqual({ stem: 'Agent', source: 'fallback' });
  });

  it('persists allocations: recovery reuses a name, replacement takes the next ordinal, removal never frees one', () => {
    const task = createTask({ title: 'Team', origin, start: false });
    const candidates = [{ label: 'Critic', source: 'role_override' as const }, { label: 'Developer', source: 'room_role' as const }];
    expect(allocateTaskMemberNames(task.task_id, [{ allocationKey: 'initial:developer:1', candidates }])).toEqual(['MSN-1-Critic']);
    expect(allocateTaskMemberNames(task.task_id, [{ allocationKey: 'initial:developer:1', candidates }])).toEqual(['MSN-1-Critic']);
    expect(allocateTaskMemberNames(task.task_id, [{ allocationKey: 'add:replacement', candidates }])).toEqual(['MSN-1-Critic-2']);
    const row = readRow(task.task_id);
    delete row.member_naming.allocations['add:replacement']; writeRow(task.task_id, row);
    expect(allocateTaskMemberNames(task.task_id, [{ allocationKey: 'add:another', candidates }])).toEqual(['MSN-1-Critic-3']);
    expect(() => allocateTaskMemberNames(task.task_id, [{ allocationKey: 'add:taken', candidates }],
      name => { throw new Error(`agent name ${name} is already used`); })).toThrow(/MSN-1-Critic-4 is already used/);
    // A failed availability check persists nothing.
    expect(readRow(task.task_id).member_naming.counters.critic).toBe(3);
  });

  it('freezes historical names from every source, deduplicated, seeding counters by selected Role', () => {
    const task = createTask({ title: 'Legacy', origin, start: false });
    const id8 = task.task_id.slice(0, 8);
    const snapshot = { name: 'pair', version: 1, content_hash: 'h', members: [
      { slot: 'developer', role: 'Developer', count: 1, agent_template: 'Developer', role_preset: { id: 'Critic', hash: 'x' } },
      { slot: 'critic', role: 'Critic', count: 1, agent_template: 'Critic' }] };
    createRoomRecord({ room_id: 'room-legacy', room_name: 'Legacy', task_id: task.task_id, template_snapshot: snapshot as never });
    const roomPath = join(fleet(), 'rooms', 'room-legacy.json');
    const room = JSON.parse(readFileSync(roomPath, 'utf8'));
    room.member_seats = [{ role_name: `${id8}-developer-1`, slot: 'developer', cowork_role: 'Developer' },
      { role_name: `${id8}-critic-1`, slot: 'critic', cowork_role: 'Critic' }];
    writeFileSync(roomPath, JSON.stringify(room));
    mkdirSync(join(fleet(), 'member-additions', task.task_id), { recursive: true });
    writeFileSync(join(fleet(), 'member-additions', task.task_id, 'request-0001.json'),
      JSON.stringify({ requestId: 'request-0001', roleId: `${id8}-review-1` }));
    const naming = freezeLegacyMemberNaming({ ...task, key: 'MSN-1', room_id: 'room-legacy',
      execution_plan: { snapshot } as never });
    expect(Object.values(naming!.allocations).map(a => a.name).sort())
      .toEqual([`${id8}-critic-1`, `${id8}-developer-1`, `${id8}-review-1`].sort());
    expect(naming!.allocations['initial:developer:1']).toMatchObject({ name: `${id8}-developer-1`, frozen: true, bucket: 'critic' });
    // The Critic override on the developer slot and the critic slot both count toward Critic.
    expect(naming!.counters.critic).toBe(2);
    const again = freezeLegacyMemberNaming({ ...task, key: 'MSN-1', room_id: 'room-legacy',
      execution_plan: { snapshot } as never, member_naming: naming });
    expect(again).toBe(naming);
    const next = allocateName(naming, 'MSN-1', 'add:new', [{ label: 'Critic', source: 'role_override' }]);
    expect(next.allocation.name).toBe('MSN-1-Critic-3');
  });

  it('uses recorded layout allocations as the ownership name and keeps the legacy hash otherwise', () => {
    const task = createTask({ title: 'Layout', origin, start: false });
    const runId = `task-${task.task_id}`;
    expect(layoutOwnedMemberName(runId, 'arch')).toBe(legacyLayoutMemberName(runId, 'arch'));
    expect(allocateLayoutMemberName(runId, 'arch', [{ label: 'Architect', source: 'template_ref' }])).toBe('MSN-1-Architect');
    expect(layoutOwnedMemberName(runId, 'arch')).toBe('MSN-1-Architect');
    expect(allocateLayoutMemberName(runId, 'arch', [{ label: 'Other', source: 'template_ref' }])).toBe('MSN-1-Architect');
    // Runs that are not task-owned keep their hash names.
    expect(layoutOwnedMemberName('standalone-run', 'arch')).toBe(legacyLayoutMemberName('standalone-run', 'arch'));
  });
});
