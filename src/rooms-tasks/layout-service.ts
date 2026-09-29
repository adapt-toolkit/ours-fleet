import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadRoomsConfig, splitRootFor, type AgentTemplateDefinition } from '../config.js';
import { agentDir, stateRoot, defaultConfigPath } from '../paths.js';
import { controlRequest } from '../session/control.js';
import { spawnTemp } from '../spawn.js';
import { tempSupervisorLiveness } from '../temp-lifecycle.js';
import { layoutSupervisorId, type LayoutControlRequest } from './layout-control.js';
import { RoomLayout, type LayoutInstance, type LayoutSupervisor, type RoomLayoutState } from './layout.js';
import { assertLayoutFile, validLayoutKey, readRoomLayouts, type RoomLayoutDefinition } from './layout-config.js';
import { createCoworkAdapter } from './cowork-adapter.js';

export class NativeLayoutSupervisor implements LayoutSupervisor {
  readonly id: string;
  constructor(private configPath: string | undefined,
    private runId: string, private templates: Record<string, AgentTemplateDefinition>) {
    mkdirSync(stateRoot(), { recursive: true, mode: 0o700 }); this.id = layoutSupervisorId();
  }
  private async request(agent: string, temporary: boolean, request: LayoutControlRequest): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]+$/.test(agent)) throw Error('invalid agent name');
    const response = await controlRequest(agentDir(agent, temporary), { command: 'layout_control', layout: request }, 60_000);
    if (!response.ok) throw Error(response.error ?? 'layout control rejected'); return response.result;
  }
  async inspect(agent: string, temporary: boolean): Promise<LayoutInstance> {
    return await this.request(agent, temporary, { action: 'inspect' }) as LayoutInstance;
  }
  private call(i: LayoutInstance, request: Omit<LayoutControlRequest, 'instance'>): Promise<unknown> {
    if (i.supervisor !== this.id || !i.agent || typeof i.temporary !== 'boolean') throw Error('invalid local layout binding');
    return this.request(i.agent, i.temporary, { ...request, instance: i });
  }
  async verify(i: LayoutInstance): Promise<void> { await this.call(i, { action: 'verify' }); }
  async spawn(key: string, template: string): Promise<LayoutInstance> {
    const definition = this.templates[template];
    if (!definition) throw Error(`agent template not found in run snapshot: ${template}`);
    const name = `layout-${createHash('sha256').update(this.runId + ':' + key).digest('hex').slice(0, 16)}`;
    await spawnTemp({ name, temp: true, configPath: this.configPath, agentDefinition: definition,
      creationActionId: `${this.runId}:${key}`, surface: 'cli' }, fileURLToPath(new URL('../cli.js', import.meta.url)));
    const deadline = Date.now() + 120_000; let last: unknown;
    while (Date.now() < deadline) {
      try { return await this.inspect(name, true); } catch (e) { last = e; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error(`layout agent startup not confirmed: ${name}: ${String(last)}`);
  }
  async join(i: LayoutInstance, invite: string, roomCid: string): Promise<void> {
    await this.call(i, { action: 'join', invite, roomCid });
    const cowork = createCoworkAdapter();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const rooms = await cowork.listRooms();
      if (rooms.some(r => r.identity_cid === roomCid && r.seats.some(s => s.identity_cid === i.cid && s.seat_state !== 'removed'))) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('room admission not observed');
  }
  async assign(i: LayoutInstance, assignment: import('./layout.js').LayoutAssignment): Promise<void> {
    await this.call(i, { action: 'assign', assignment });
  }
  async retire(i: LayoutInstance): Promise<void> {
    if (i.supervisor !== this.id || !i.agent || !/^[A-Za-z0-9_-]+$/.test(i.agent) || i.temporary !== true)
      throw Error('invalid local temporary layout instance');
    const dir = agentDir(i.agent, true);
    const stopped = async () => !existsSync(dir) || await tempSupervisorLiveness(dir) === 'stopped';
    if (await stopped()) return;
    try { await this.call(i, { action: 'retire' }); }
    catch (error) { if (!await stopped()) throw error; }
  }
}
export const layoutRunPath = (id: string): string => {
  if (!validLayoutKey(id)) throw Error('invalid layout run ID');
  const root = join(stateRoot(), 'layouts'); mkdirSync(root, { recursive: true, mode: 0o700 });
  assertLayoutFile(root, true); return join(root, id + '.json');
};
export class RoomLayoutService {
  constructor(private configPath?: string) {}
  list(): Record<string, RoomLayoutDefinition> {
    const layouts = readRoomLayouts(join(splitRootFor(this.configPath ?? defaultConfigPath()), 'room_layouts'), []);
    const cfg = loadConfig(this.configPath);
    for (const [name, layout] of Object.entries(layouts)) for (const participant of Object.values(layout.participants))
      if (participant.agent_template && !cfg.agentTemplates?.[participant.agent_template])
        throw Error(`room layout ${name}: agent template not found: ${participant.agent_template}`);
    return layouts;
  }
  definition(name: string): RoomLayoutDefinition {
    const def = this.list()[name]; if (!def) throw Error(`room layout not found: ${name}`); return def;
  }
  supervisor(id = 'inspect', templates: Record<string, AgentTemplateDefinition> = {}): NativeLayoutSupervisor {
    return new NativeLayoutSupervisor(this.configPath, id, templates);
  }
  private owner(): import('./layout.js').LayoutOwner | undefined {
    const rooms = loadRoomsConfig(this.configPath);
    if (rooms.defaults?.attach_owner === false) return undefined;
    if (!rooms._invite) throw Error('room owner invite required; configure rooms.owner or explicitly set rooms.defaults.attach_owner: false');
    return { cid: rooms.owner.expected_cid, role: rooms.owner.role ?? 'Owner', invite: rooms._invite.value };
  }
  private engine(id: string, cleanup = false): RoomLayout {
    const path = layoutRunPath(id); if (existsSync(path)) assertLayoutFile(path);
    return new RoomLayout(path, () => createCoworkAdapter(), this.supervisor(id), cleanup ? undefined : this.owner());
  }
  open(id: string, cleanup = false): RoomLayout {
    const initial = this.engine(id, cleanup), snapshot = initial.snapshot();
    return new RoomLayout(layoutRunPath(id), () => createCoworkAdapter(),
      this.supervisor(id, snapshot.agent_templates ?? {}), cleanup ? undefined : this.owner());
  }
  async create(name: string, bindings: Record<string, LayoutInstance> = {}, id = `run-${randomUUID()}`): Promise<{ id: string; state: RoomLayoutState }> {
    const cfg = loadConfig(this.configPath);
    const definition = this.definition(name), templates: Record<string, AgentTemplateDefinition> = {};
    for (const [key, participant] of Object.entries(definition.participants)) {
      if (bindings[key] || !participant.agent_template) continue;
      const template = cfg.agentTemplates?.[participant.agent_template];
      if (!template) throw Error(`agent template not found: ${participant.agent_template}`);
      templates[participant.agent_template] = structuredClone(template);
    }
    const engine = this.engine(id);
    await engine.create(definition, layoutSupervisorId(), bindings, templates);
    return { id, state: engine.snapshot() };
  }
}
