import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskRoomApplicationService } from '../src/application/task-room-service.js';
import { createTask, getTask, moveTaskToList } from '../src/rooms-tasks/task-state.js';
import { TaskListError } from '../src/rooms-tasks/task-lists.js';
import type { FleetConfig } from '../src/config.js';
import { buildWebServer } from '../src/web/server.js';
import { WebAuth } from '../src/web/auth.js';
import { TrustedDeviceStore } from '../src/web/device-store.js';
import { dispatchOwnerCommand } from '../src/owner-channel/commands.js';
import { writeV2Fixture } from './v2-fixture.js';

let root: string;
let previousHome: string | undefined;
const actor = { kind: 'local_control' as const, surface: 'cli' as const };
const config = (): FleetConfig => ({
  roles: [], vars: {}, defaults: {}, files: [], startStaggerMs: 0, diagnostics: [],
  watchdogs: [], loops: [], roomTemplates: {},
} as FleetConfig);
const app = (move = moveTaskToList) => new TaskRoomApplicationService(undefined, {
  loadConfiguration: config, moveTaskToList: move,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-task-lists-'));
  previousHome = process.env.OURS_FLEET_HOME;
  process.env.OURS_FLEET_HOME = root;
  writeV2Fixture(join(root, 'fleet.yaml'), {});
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OURS_FLEET_HOME;
  else process.env.OURS_FLEET_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('named task lists', () => {
  it('always exposes default and defaults legacy records across service restarts', () => {
    expect(app().listTaskLists()).toEqual([expect.objectContaining({ list_id: 'default', name: 'default', built_in: true })]);
    const task = createTask({ title: 'Legacy', origin: { type: 'cli' }, start: false });
    const path = join(root, '.ours-fleet', 'tasks', `${task.task_id}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    delete stored.list_id;
    writeFileSync(path, JSON.stringify(stored));
    expect(app().getTask(task.task_id).task).toMatchObject({ list_id: 'default', list_name: 'default' });
    expect(new TaskRoomApplicationService(undefined, { loadConfiguration: config })
      .listTasks()).toEqual([expect.objectContaining({ task_id: task.task_id, list_name: 'default' })]);
  });

  it('normalizes NFC, rejects normalized duplicates, and allows case-distinct names', async () => {
    const service = app();
    const composed = await service.createTaskList({ actor, name: 'Café' });
    expect(composed.name).toBe('Café');
    await expect(service.createTaskList({ actor, name: 'Cafe\u0301' }))
      .rejects.toMatchObject({ code: 'duplicate_name' });
    await expect(service.createTaskList({ actor, name: 'default' }))
      .rejects.toMatchObject({ code: 'reserved_name' });
    await service.createTaskList({ actor, name: 'Personal' });
    await service.createTaskList({ actor, name: 'personal' });
    expect(service.listTaskLists().map(list => list.name)).toEqual(['default', 'Café', 'Personal', 'personal']);
  });

  it('serializes concurrent normalized duplicate creation', async () => {
    const results = await Promise.allSettled([
      app().createTaskList({ actor, name: 'Résumé' }),
      app().createTaskList({ actor, name: 'Re\u0301sume\u0301' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(app().listTaskLists().filter(list => list.name === 'Résumé')).toHaveLength(1);
  });

  it('creates and moves tasks without changing lifecycle or durable history fields', async () => {
    const service = app();
    await service.createTaskList({ actor, name: 'Work' });
    const task = await service.createTask({ actor, title: 'Item', backlog: true, noRoom: true,
      list: 'Work', origin: { type: 'cli' } });
    const before = { task_id: task.task_id, title: task.title, state: task.state,
      idempotency_key: task.idempotency_key, created_at: task.created_at, origin: task.origin };
    const renamed = await service.renameTaskList({ actor, name: 'Work', newName: 'Projects' });
    expect(renamed.list_id).toBe(task.list_id);
    expect(service.getTask(task.task_id).task.list_name).toBe('Projects');
    const moved = await service.moveTask({ actor, taskId: task.task_id, list: 'default' });
    expect(moved).toMatchObject({ ...before, list_id: 'default', list_name: 'default' });
  });

  it('requires a destination and resumes safely after an injected partial move failure', async () => {
    const service = app();
    await service.createTaskList({ actor, name: 'Source' });
    for (const title of ['A', 'B']) await service.createTask({ actor, title, backlog: true,
      noRoom: true, list: 'Source', origin: { type: 'cli' } });
    await expect(service.deleteTaskList({ actor, name: 'Source' }))
      .rejects.toMatchObject({ code: 'destination_required' });
    let calls = 0;
    const failing = app((id, destination) => {
      if (++calls === 2) throw new Error('injected move failure');
      return moveTaskToList(id, destination);
    });
    await expect(failing.deleteTaskList({ actor, name: 'Source', destination: 'default' }))
      .rejects.toThrow('injected move failure');
    expect(app().listTaskLists().map(list => list.name)).toContain('Source');
    expect((await app().deleteTaskList({ actor, name: 'Source', destination: 'default' })).moved).toBe(1);
    expect(app().listTasks().every(task => task.list_name === 'default')).toBe(true);
  });

  it('orders equal-time tasks by task ID and grouping is a service transform', async () => {
    const tasks = join(root, '.ours-fleet', 'tasks'); mkdirSync(tasks, { recursive: true });
    const base = { title: 'x', state: 'backlog', member_roles: [], origin: { type: 'cli' },
      idempotency_key: 'x', created_at: '2026-01-01T00:00:00.000Z' };
    for (const id of ['000000000bbbbbbbb', '000000000aaaaaaaa'])
      writeFileSync(join(tasks, `${id}.json`), JSON.stringify({ ...base, task_id: id, idempotency_key: id }));
    expect(app().listTasks().map(task => task.task_id)).toEqual(['000000000aaaaaaaa', '000000000bbbbbbbb']);
    expect(app().groupedTasks()[0].tasks.map(task => task.task_id)).toEqual(['000000000aaaaaaaa', '000000000bbbbbbbb']);
  });

  it('serializes cross-process lifecycle and assignment RMW on the same task', async () => {
    const service = app();
    const list = await service.createTaskList({ actor, name: 'Work' });
    const task = createTask({ title: 'Race', origin: { type: 'cli' }, start: false });
    const module = new URL(`file://${resolve('dist/rooms-tasks/task-state.js')}`).href;
    const run = promisify(execFile);
    const env = { ...process.env, OURS_FLEET_HOME: root };
    const mover = `import {moveTaskToList} from '${module}'; for(let i=0;i<100;i++){moveTaskToList('${task.task_id}',i===99?'${list.list_id}':'default')}`;
    const blocker = `import {blockTask,unblockTask} from '${module}'; for(let i=0;i<100;i++){try{unblockTask('${task.task_id}')}catch{} blockTask('${task.task_id}','final')}`;
    await Promise.all([run(process.execPath, ['--input-type=module', '-e', mover], { env }),
      run(process.execPath, ['--input-type=module', '-e', blocker], { env })]);
    expect(getTask(task.task_id)).toMatchObject({ list_id: list.list_id, blocked: { reason: 'final' } });
  });

  it('persists identical CLI and authenticated REST operations and typed errors', async () => {
    const env = { ...process.env, OURS_FLEET_HOME: root };
    const run = promisify(execFile);
    const cli = async (args: string[]) => run(process.execPath, [resolve('dist/cli.js'), ...args], { env });
    await cli(['task', 'list-create', 'CLI Work', '--json']);
    await cli(['task', 'list-rename', 'CLI Work', 'CLI Renamed', '--json']);
    const created = JSON.parse((await cli(['task', 'create', '--title', 'From CLI', '--backlog',
      '--no-room', '--list', 'CLI Renamed', '--json'])).stdout).task;
    expect(created).toMatchObject({ list_name: 'CLI Renamed', state: 'backlog' });
    await expect(cli(['task', 'list-create', 'CLI Renamed', '--json'])).rejects.toMatchObject({ code: 1 });

    const boundary = { origin: 'http://127.0.0.1:49271', host: '127.0.0.1:49271' };
    const authDir = join(root, 'web-auth');
    const auth = new WebAuth(boundary.origin, boundary.host, Date.now, new TrustedDeviceStore(authDir));
    const server = await buildWebServer({ taskRooms: app() } as any, boundary, { auth });
    const exchange = await server.app.inject({ method: 'POST', url: '/api/v1/auth/exchange',
      headers: { host: boundary.host, origin: boundary.origin,
        authorization: `Bootstrap ${server.auth.bootstrapSecret}` } });
    const cookie = ([] as string[]).concat(exchange.headers['set-cookie'] ?? [])
      .map(value => value.split(';')[0]).join('; ');
    const headers = { host: boundary.host, origin: boundary.origin, cookie,
      'x-csrf-token': exchange.json().csrfToken as string };
    expect((await server.app.inject({ method: 'POST', url: '/api/v1/task-lists', headers,
      payload: { name: 'REST Work' } })).statusCode).toBe(201);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/v1/task-lists/REST%20Work', headers,
      payload: { name: 'REST Renamed' } })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'PATCH', url: `/api/v1/tasks/${created.task_id}/list`,
      headers, payload: { list: 'REST Renamed' } })).statusCode).toBe(200);
    expect(getTask(created.task_id).list_name).toBe('REST Renamed');
    const unsafe = await server.app.inject({ method: 'DELETE', url: '/api/v1/task-lists/REST%20Renamed', headers });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json().error.code).toBe('conflict');
    const missing = await server.app.inject({ method: 'GET', url: '/api/v1/tasks?list=Missing',
      headers: { host: boundary.host, cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('resource_not_found');
    const deleted = await server.app.inject({ method: 'DELETE',
      url: '/api/v1/task-lists/REST%20Renamed?destination=default', headers });
    expect(deleted.statusCode).toBe(200);
    expect(getTask(created.task_id).list_name).toBe('default');

    const ownerReplies: string[] = [];
    const ownerService = app();
    const ownerCtx = {
      createTaskList: (name: string) => ownerService.createTaskList({ actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, name }),
      renameTaskList: (name: string, newName: string) => ownerService.renameTaskList({ actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, name, newName }),
      deleteTaskList: (name: string, destination?: string) => ownerService.deleteTaskList({ actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, name, destination }),
      moveTask: (taskId: string, list: string) => ownerService.moveTask({ actor: { kind: 'authenticated_owner', surface: 'messenger', cid: 'owner' }, taskId, list }),
      listTaskLists: () => ownerService.listTaskLists(), listTasks: (filter: any) => ownerService.listTasks(filter),
      groupedTasks: (filter: any) => ownerService.groupedTasks(filter), getTask: (id: string) => ownerService.getTask(id),
      reply: async (text: string) => { ownerReplies.push(text); },
    } as any;
    await dispatchOwnerCommand('/task list-create\nOwner Work', ownerCtx);
    await dispatchOwnerCommand('/task list-rename\nOwner Work\nOwner Renamed', ownerCtx);
    await dispatchOwnerCommand(`/task move ${created.task_id}\nOwner Renamed`, ownerCtx);
    expect(getTask(created.task_id).list_name).toBe('Owner Renamed');
    await dispatchOwnerCommand('/task list-create\nOwner Renamed', ownerCtx);
    expect(ownerReplies.at(-1)).toContain('task list already exists');
    await dispatchOwnerCommand('/task list-delete\nOwner Renamed', ownerCtx);
    expect(ownerReplies.at(-1)).toContain('destination is required');
    await dispatchOwnerCommand('/task list-delete\nOwner Renamed\nOwner Renamed', ownerCtx);
    expect(ownerReplies.at(-1)).toContain('destination must differ');
    await dispatchOwnerCommand('/task list-create\ndefault', ownerCtx);
    expect(ownerReplies.at(-1)).toContain('reserved built-in');
    await dispatchOwnerCommand('/task list-create\nbad/name', ownerCtx);
    expect(ownerReplies.at(-1)).toContain('forbidden');
    await dispatchOwnerCommand(`/task move ${created.task_id}\nMissing`, ownerCtx);
    expect(ownerReplies.at(-1)).toContain('task list not found');

    const cliFailures = await Promise.all([
      cli(['task', 'list-create', 'CLI Renamed', '--json']).catch(error => error),
      cli(['task', 'list-create', 'default', '--json']).catch(error => error),
      cli(['task', 'list-create', 'bad/name', '--json']).catch(error => error),
      cli(['task', 'move', created.task_id, '--list', 'Missing', '--json']).catch(error => error),
      cli(['task', 'list-delete', 'Owner Renamed', '--json']).catch(error => error),
      cli(['task', 'list-delete', 'Owner Renamed', '--move-to', 'Owner Renamed', '--json']).catch(error => error),
    ]);
    for (const [failure, phrase] of cliFailures.map((failure, index) => [failure,
      ['already exists', 'reserved built-in', 'forbidden', 'not found', 'destination is required', 'destination must differ'][index]] as const))
      expect(String(failure.stderr)).toContain(phrase);

    for (const [method, url, payload, status, code] of [
      ['POST', '/api/v1/task-lists', { name: 'CLI Renamed' }, 409, 'conflict'],
      ['POST', '/api/v1/task-lists', { name: 'default' }, 400, 'invalid_request'],
      ['POST', '/api/v1/task-lists', { name: 'bad/name' }, 400, 'invalid_request'],
      ['PATCH', `/api/v1/tasks/${created.task_id}/list`, { list: 'Missing' }, 404, 'resource_not_found'],
      ['DELETE', '/api/v1/task-lists/Owner%20Renamed', undefined, 409, 'conflict'],
      ['DELETE', '/api/v1/task-lists/Owner%20Renamed?destination=Owner%20Renamed', undefined, 409, 'conflict'],
    ] as const) {
      const response = await server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect(response.statusCode).toBe(status); expect(response.json().error.code).toBe(code);
    }
    await dispatchOwnerCommand('/task list-delete\nOwner Renamed\ndefault', ownerCtx);
    expect(getTask(created.task_id).list_name).toBe('default');
    expect(ownerService.listTaskLists().some(list => list.name === 'Owner Renamed')).toBe(false);
    await server.close();
  });
});
