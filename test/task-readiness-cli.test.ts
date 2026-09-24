import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realExec } from '../src/exec.js';
import { activateTask, createTask, updateTaskRoom } from '../src/rooms-tasks/task-state.js';
import { activateRoom, advanceSaga, createRoomRecord, updateMemberSeats } from '../src/rooms-tasks/room-state.js';
import { snapshotTemplate } from '../src/rooms-tasks/templates.js';
import { writeV2Fixture } from './v2-fixture.js';

let root: string;
let oldHome: string | undefined;
let taskId: string;
let server: Server;
let methods: string[];
let files: string[];
let before: string[];
const roomId = 'fixture-room';
beforeEach(async () => {
  oldHome = process.env.OURS_FLEET_HOME;
  root = mkdtempSync(join(tmpdir(), 'fleet-readiness-cli-'));
  process.env.OURS_FLEET_HOME = root;
  writeV2Fixture(join(root, 'fleet.yaml'), { roles: {}, rooms: { owner: {}, defaults: { attach_owner: false } } });
  taskId = createTask({ title: 'Stale readiness', origin: { type: 'cli' }, start: true }).task_id;
  createRoomRecord({ room_id: roomId, room_name: 'Fixture', room_identity_cid: 'room-cid', task_id: taskId,
    template_snapshot: snapshotTemplate({ name: 'solo', version: 1, description: '',
      members: [{ slot: 'dev', role: 'Developer', count: 1, agent_template: 'Dev' }] }) });
  updateTaskRoom(taskId, roomId, 'room-cid');
  updateMemberSeats(roomId, [{ role_name: 'original-member', slot: 'dev', cowork_role: 'Developer',
    identity_cid: 'original-cid', seat_state: 'active', launch: { state: 'launched', attempt: 1,
      launch_id: 'original-launch', updated_at: new Date().toISOString() } }]);
  activateRoom(roomId); advanceSaga(roomId, 'completed', 8); activateTask(taskId);
  const archive = join(root, '.ours-fleet/recovery/temporary/retained');
  mkdirSync(archive, { recursive: true }); writeFileSync(join(archive, 'WORKLOG.md'), 'private retained context');
  files = [join(root, '.ours-fleet/tasks', `${taskId}.json`), join(root, '.ours-fleet/rooms', `${roomId}.json`), join(archive, 'WORKLOG.md')];
  before = files.map(file => readFileSync(file, 'utf8'));
  methods = [];
  server = createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]); methods.push(request.method);
      socket.end(JSON.stringify({ version: 1, id: request.id, result: {
        room_id: roomId, identity_name: 'fixture', identity_cid: 'room-cid', room_name: 'Fixture', state: 'active',
        seats: [
          { identity: 'original-cid', display_name: 'original-member', invite_id: 'old', role: 'Developer', state: 'removed' },
          { identity: 'replacement-cid', display_name: 'replacement', invite_id: 'new', role: 'Developer', state: 'active' },
        ],
      } }) + '\n');
    });
  });
  await new Promise<void>(resolveListen => server.listen(join(root, 'management.sock'), resolveListen));
});
afterEach(async () => {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  if (oldHome === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});
function cli(...args: string[]) {
  return realExec(process.execPath, [resolve('dist/cli.js'), 'task', ...args], {
    env: { ...process.env, OURS_FLEET_HOME: root, OURS_COWORK_STATE_DIR: root,
      OURS_FLEET_PROXY_STATE_DIR: '', OURS_FLEET_PROXY_CALLER: '' }, timeout: 10_000,
  });
}
describe('task readiness CLI with real Cowork socket and isolated state', () => {
  it.each(['start', 'show', 'work'])('%s JSON separates degraded readiness from active lifecycle', async command => {
    const result = await cli(command, taskId, '--json');
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.task.state).toBe('active');
    expect(parsed.provisioning).toMatchObject({ kind: 'degraded', members: { expected: 1, active: 0, launched: 0 } });
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every(method => method === 'room.show')).toBe(true);
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
  });
  it('shows actionable human output without claiming ready and never mutates during concurrent starts', async () => {
    const results = await Promise.all([cli('start', taskId), cli('start', taskId), cli('show', taskId)]);
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/degraded/i);
      expect(result.stdout).toMatch(/coordinator/i);
      expect(result.stdout).not.toContain('Room provisioning complete');
      expect(result.stdout).not.toContain('private retained context');
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every(method => method === 'room.show')).toBe(true);
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
  });
});
