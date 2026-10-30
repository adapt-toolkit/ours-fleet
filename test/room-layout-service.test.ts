import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../src/client-profile.js', () => ({ readClientProfile: () => ({ expectedInstanceId: 'shared-daemon' }) }));
vi.mock('../src/session/control.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/session/control.js')>(), controlRequest: vi.fn() }));
vi.mock('../src/temp-lifecycle.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/temp-lifecycle.js')>(), tempSupervisorLiveness: vi.fn() }));
vi.mock('../src/spawn.js', () => ({ spawnTemp: vi.fn() }));
import { controlRequest } from '../src/session/control.js';
import { tempSupervisorLiveness } from '../src/temp-lifecycle.js';
import { spawnTemp } from '../src/spawn.js';
import { NativeLayoutSupervisor, RoomLayoutService } from '../src/rooms-tasks/layout-service.js';
import { writeV2Fixture } from './v2-fixture.js';
import { stringify } from 'yaml';
import { agentDir, stateRoot } from '../src/paths.js';
let root: string, previous: string | undefined;
beforeEach(() => {
  vi.resetAllMocks(); previous = process.env.OURS_FLEET_HOME;
  root = mkdtempSync(join(tmpdir(), 'layout-retire-')); process.env.OURS_FLEET_HOME = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OURS_FLEET_HOME; else process.env.OURS_FLEET_HOME = previous;
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const supervisor = new NativeLayoutSupervisor(undefined, 'review', {});
  const instance = { supervisor: supervisor.id, agent: 'worker', temporary: true, launch: 'launch', cid: 'cid', session: 'session' };
  mkdirSync(agentDir('worker', true), { recursive: true });
  return { supervisor, instance };
}
it('gives scoped keys safe distinct native agent names across rooms and runs', async () => {
  const config = join(root, 'fleet.yaml');
  writeV2Fixture(config, { roles: {} });
  const { loadConfig } = await import('../src/config.js');
  const templates = loadConfig(config).agentTemplates!;
  const first = new NativeLayoutSupervisor(config, 'first', templates);
  const second = new NativeLayoutSupervisor(config, 'second', templates);
  vi.mocked(controlRequest).mockImplementation(async (_dir, request: any) => ({
    ok: true, result: { supervisor: first.id, agent: request.layout.agent, launch: 'launch', cid: 'cid', session: 'session' },
  } as any));
  await first.spawn('discovery:critic', 'Agent'); await first.spawn('design:critic', 'Agent');
  await second.spawn('discovery:critic', 'Agent');
  const calls = vi.mocked(spawnTemp).mock.calls;
  const names = calls.map(([options]) => options.name);
  expect(new Set(names).size).toBe(3);
  expect(names.every(name => /^layout-[a-f0-9]{16}$/.test(name))).toBe(true);
  expect(calls.map(([options]) => options.creationActionId)).toEqual([
    'first:discovery:critic', 'first:design:critic', 'second:discovery:critic',
  ]);
});
it('keeps retained snapshots and cleanup independent of source layout/template edits', async () => {
  const config = join(root, 'fleet.yaml');
  writeV2Fixture(config, { roles: {}, rooms: { owner: { expected_cid: '0'.repeat(64) }, defaults: { attach_owner: false } } });
  const layouts = join(root, 'fleet', 'room_layouts'); mkdirSync(layouts, { mode: 0o700 });
  const source = join(layouts, 'work.yaml');
  writeFileSync(source, stringify({ version: 1, participants: { worker: { agent_template: 'Agent' } },
    rooms: { design: { goal: 'Original goal', members: ['worker'] } } }), { mode: 0o600 });
  const created = await new RoomLayoutService(config).create('work', {}, 'example');
  rmSync(join(root, 'fleet', 'agent_templates', 'Agent.yaml'));
  writeFileSync(source, 'invalid: [');
  const reopened = new RoomLayoutService(config).open('example');
  expect(reopened.snapshot()).toEqual(created.state);
  expect(reopened.snapshot().agent_templates?.Agent).toBeDefined();
  // Even a broken manifest must not prevent inspection and cleanup of known resources.
  writeFileSync(config, 'invalid: [');
  const cleanup = new RoomLayoutService(config).open('example', true);
  await cleanup.close(cleanup.snapshot().controller);
  expect(cleanup.snapshot().closed).toBe(true);
});
it('accepts a confirmed stopped supervisor without requiring its live control socket', async () => {
  const f = fixture(); vi.mocked(tempSupervisorLiveness).mockResolvedValue('stopped');
  await f.supervisor.retire(f.instance); expect(controlRequest).not.toHaveBeenCalled();
});
it('accepts an already removed temporary directory without creating it', async () => {
  const f = fixture(); rmSync(agentDir('worker', true), { recursive: true });
  await f.supervisor.retire(f.instance); expect(controlRequest).not.toHaveBeenCalled();
});
it('does not turn unknown liveness and a control failure into successful retirement', async () => {
  const f = fixture(); vi.mocked(tempSupervisorLiveness).mockResolvedValue('unknown');
  vi.mocked(controlRequest).mockRejectedValue(Error('socket unavailable'));
  await expect(f.supervisor.retire(f.instance)).rejects.toThrow('socket unavailable');
});
it('preserves a running replacement rejected by exact-instance control', async () => {
  const f = fixture(); vi.mocked(tempSupervisorLiveness).mockResolvedValue('running');
  vi.mocked(controlRequest).mockResolvedValue({ ok: false, error: 'layout instance changed or stopped' } as any);
  await expect(f.supervisor.retire(f.instance)).rejects.toThrow('instance changed');
  expect(controlRequest).toHaveBeenCalledTimes(1);
  expect(controlRequest).toHaveBeenCalledWith(expect.any(String), { command: 'layout_control', layout: { action: 'retire', instance: f.instance } }, 60_000);
});
it('settles a lost retirement response only after a confirmed stop', async () => {
  const f = fixture(); vi.mocked(tempSupervisorLiveness).mockResolvedValueOnce('running').mockResolvedValueOnce('stopped');
  vi.mocked(controlRequest).mockRejectedValue(Error('response lost'));
  await f.supervisor.retire(f.instance); expect(controlRequest).toHaveBeenCalledTimes(1);
});
it('rejects non-local, persistent and invalid-name references before observing or stopping them', async () => {
  const f = fixture();
  for (const change of [{ supervisor: 'remote' }, { temporary: false }, { agent: '../other' }])
    await expect(f.supervisor.retire({ ...f.instance, ...change })).rejects.toThrow('invalid local temporary');
  expect(tempSupervisorLiveness).not.toHaveBeenCalled(); expect(controlRequest).not.toHaveBeenCalled();
});

it('routes a borrowed instance through the owner HTTP port without opening foreign control sockets', async () => {
  const f = fixture();
  const credential = join(root, 'grant.token'); writeFileSync(credential, 'x'.repeat(43), { mode: 0o600 });
  const local = { ...f.instance, supervisor: '/different-owner-root' };
  const instance = { ...local, remote: { url: 'http://127.0.0.1:49271', grant_id: '11111111-1111-4111-8111-111111111111', credential_file: credential, daemon_instance_id: 'shared-daemon' } };
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ instance: local })));
  vi.stubGlobal('fetch', fetcher);
  await f.supervisor.verify(instance);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(controlRequest).not.toHaveBeenCalled();
  await f.supervisor.join(instance, '', 'room-cid', { roomId: 'room-id', role: 'Architect' });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ action: 'join', roomCid: 'room-cid', roomId: 'room-id', roomRole: 'Architect', instance: local });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).not.toHaveProperty('invite');
  await expect(f.supervisor.retire(instance)).rejects.toThrow('cannot retire a borrowed');
  expect(fetcher).toHaveBeenCalledTimes(2); expect(tempSupervisorLiveness).not.toHaveBeenCalled();
});
it('seals template Role labels at run creation; a later first launch ignores edited or removed config', async () => {
  const config = join(root, 'fleet.yaml');
  writeV2Fixture(config, { roles: {}, rooms: { owner: { expected_cid: '0'.repeat(64) }, defaults: { attach_owner: false } } });
  const fleetDir = join(root, 'fleet');
  mkdirSync(join(fleetDir, 'roles'), { mode: 0o700 });
  writeFileSync(join(fleetDir, 'roles', 'Architect.yaml'), 'mission: Shape the design\n', { mode: 0o600 });
  const templatePath = join(fleetDir, 'agent_templates', 'Agent.yaml');
  writeFileSync(templatePath, stringify({ role: { ref: 'Architect' }, brain: { inline: { harness: 'claude-code' } },
    permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' } }), { mode: 0o600 });
  const layouts = join(fleetDir, 'room_layouts'); mkdirSync(layouts, { mode: 0o700 });
  writeFileSync(join(layouts, 'work.yaml'), stringify({ version: 1, participants: { worker: { agent_template: 'Agent' } },
    rooms: { design: { goal: 'Design', members: ['worker'] } } }), { mode: 0o600 });
  const { createTask } = await import('../src/rooms-tasks/task-state.js');
  const task = createTask({ title: 'Layout names', origin: { type: 'cli' }, start: false });
  const runId = `task-${task.task_id}`;
  const taskPath = join(stateRoot(), 'tasks', `${task.task_id}.json`);
  const row = JSON.parse(readFileSync(taskPath, 'utf8'));
  row.layout = { name: 'work', run_id: runId, definition_hash: 'h' }; writeFileSync(taskPath, JSON.stringify(row));
  const created = await new RoomLayoutService(config).create('work', {}, runId);
  expect(created.state.role_labels).toEqual({ Agent: 'Architect' });
  vi.mocked(controlRequest).mockImplementation(async (_dir, request: any) => ({
    ok: true, result: { supervisor: 'local', agent: request.layout.agent, launch: 'launch', cid: 'cid', session: 'session' },
  } as any));
  const launch = async (key: string) => {
    const snapshot = new RoomLayoutService(config).open(runId, true).snapshot();
    const supervisor = new NativeLayoutSupervisor(config, runId, snapshot.agent_templates ?? {});
    // The engine passes the sealed label first; the supervisor must not consult config for it.
    await supervisor.spawn(key, 'Agent', undefined, [{ label: snapshot.role_labels?.Agent, source: 'template_ref' },
      { label: key, source: 'participant_key' }]);
    return vi.mocked(spawnTemp).mock.calls.at(-1)![0].name;
  };
  // Edited: the template now names another Role.
  writeFileSync(join(fleetDir, 'roles', 'Reviewer.yaml'), 'mission: Review\n', { mode: 0o600 });
  writeFileSync(templatePath, stringify({ role: { ref: 'Reviewer' }, brain: { inline: { harness: 'claude-code' } },
    permissions: { approval: 'allow', filesystem: 'unrestricted', unattended: 'wait' } }), { mode: 0o600 });
  expect(await launch('worker')).toBe(`${task.key}-Architect`);
  // Removed: the Role and even a readable manifest are gone before another participant's first launch.
  rmSync(join(fleetDir, 'roles'), { recursive: true });
  writeFileSync(config, 'invalid: [');
  expect(await launch('second')).toBe(`${task.key}-Architect-2`);
  expect(new RoomLayoutService(config).open(runId, true).snapshot().role_labels).toEqual({ Agent: 'Architect' });
});
