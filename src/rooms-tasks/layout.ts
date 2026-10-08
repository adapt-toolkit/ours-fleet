/** Durable local room-layout controller.
 * Uses native Cowork operations and a supervising Fleet's exact-instance port.
 * Unknown mutation outcomes stop for reconciliation; they are never replayed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalJson } from '../canonical-json.js';
import { replaceFileAtomically, withFileLock } from '../atomic-file.js';
import type { CoworkAdapter, CoworkRoomCreateResult } from './cowork-adapter.js';
import { CoworkProtocolError } from './cowork-adapter.js';

export interface LayoutOwner { cid: string; role: string; invite: string }
const ownerReference = (owner: LayoutOwner) => ({ cid: owner.cid, role: owner.role, fingerprint: createHash('sha256').update(owner.invite).digest('hex') });
export interface LayoutInstance {
  supervisor: string; launch: string; cid: string; session: string; agent?: string; temporary?: boolean;
  remote?: { url: string; grant_id: string; credential_file: string; daemon_instance_id: string };
}
export interface LayoutParticipant { agent_template?: string; instance_scope?: 'layout' | 'room' }
export interface LayoutRoom {
  goal: string; members: string[]; contract?: string; quiet_membership?: boolean; anonymous?: boolean; roles?: Record<string, string>;
}
export interface LayoutDefinition {
  participants: Record<string, LayoutParticipant>; rooms: Record<string, LayoutRoom>;
}

export interface LayoutAssignment {
  id: string; room_id: string; room_cid: string; goal: string;
  participant: string; room_role?: string; contract?: string;
}
export interface LayoutSupervisor {
  id: string;
  /** Must verify current launch, CID, live session and standalone ownership. */
  verify(instance: LayoutInstance): Promise<void>;
  spawn(key: string, template: string): Promise<LayoutInstance>;
  join(instance: LayoutInstance, invite: string, roomCid: string, membership?: { roomId: string; role: string }): Promise<void>;
  assign(instance: LayoutInstance, assignment: LayoutAssignment): Promise<void>;
  /** Retire the exact instance, or confirm it is already stopped; never stop a replacement. */
  retire(instance: LayoutInstance): Promise<void>;
}
type ParticipantState = { instance?: LayoutInstance; owned: boolean; retired?: boolean; participant?: string; room?: string };
type RoomState = {
  spec: LayoutRoom; native?: CoworkRoomCreateResult; ready: string[];
  state: 'provisioning' | 'active' | 'closed'; owner_ready?: boolean;
  deleted?: boolean;
};
export interface RoomLayoutState {
  version: 1; owner?: ReturnType<typeof ownerReference>; agent_templates?: Record<string, import('../config.js').AgentTemplateDefinition>; definition: LayoutDefinition; controller: string;
  participants: Record<string, ParticipantState>; rooms: Record<string, RoomState>;
  order: string[]; closed: boolean; closing?: boolean; uncertain?: string;
}
const own = (o: object, key: string) => Object.hasOwn(o, key);
function need(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
/** Room/participant keys cannot contain ':', so scoped instance keys cannot collide. */
function instanceKey(definition: LayoutDefinition, participant: string, room: string): string {
  return definition.participants[participant].instance_scope === 'room' ? `${room}:${participant}` : participant;
}
export function validateLayout(def: LayoutDefinition): void {
  need(Object.keys(def.rooms).length && Object.keys(def.participants).length, 'rooms and participants required');
  for (const [key, participant] of Object.entries(def.participants)) {
    need(participant.instance_scope === undefined || ['layout', 'room'].includes(participant.instance_scope), `invalid instance_scope for ${key}`);
    if (participant.instance_scope === 'room')
      need(typeof participant.agent_template === 'string' && participant.agent_template.trim(), `room-scoped participant ${key} requires agent_template`);
  }
  for (const [key, room] of Object.entries(def.rooms)) {
    need(key.length && room.goal.trim() && room.members.length, 'room goal and members required');
    need(new Set(room.members).size === room.members.length, 'duplicate participant in room');
    for (const member of room.members) need(own(def.participants, member), `unknown participant ${member}`);
  }
  for (const key of [...Object.keys(def.rooms), ...Object.keys(def.participants)])
    need(/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key), 'invalid layout key');
}

export class RoomLayout {
  private coworkAdapter?: CoworkAdapter;
  private readonly coworkFactory: () => CoworkAdapter;
  constructor(private file: string, cowork: CoworkAdapter | (() => CoworkAdapter), private supervisor: LayoutSupervisor, private owner?: LayoutOwner) {
    this.coworkFactory = typeof cowork === 'function' ? cowork : () => cowork;
  }
  private get cowork(): CoworkAdapter { return this.coworkAdapter ??= this.coworkFactory(); }
  snapshot(): RoomLayoutState { return JSON.parse(readFileSync(this.file, 'utf8')); }
  private save(s: RoomLayoutState): void { replaceFileAtomically(this.file, JSON.stringify(s, null, 2)); }
  private async verify(i: LayoutInstance): Promise<void> {
    need(i.supervisor === this.supervisor.id || i.remote, 'remote binding unsupported');
    need(i.launch && i.cid && i.session, 'incomplete instance reference');
    await this.supervisor.verify(i);
  }
  async create(definition: LayoutDefinition, controller: string, bindings: Record<string, LayoutInstance> = {}, agentTemplates?: RoomLayoutState['agent_templates']): Promise<void> {
    validateLayout(definition); need(controller, 'controller required');
    this.checkOwnerRoles(definition);
    await withFileLock(this.file + '.lock', async () => {
      need(!existsSync(this.file), 'layout instance already exists');
      for (const key of Object.keys(bindings)) {
        need(own(definition.participants, key), 'unknown binding');
        need(definition.participants[key].instance_scope !== 'room', `binding unsupported for room-scoped participant ${key}`);
      }
      // Validate every supplied binding before any external mutation.
      for (const [key, p] of Object.entries(definition.participants)) {
        need(bindings[key] || p.agent_template, `binding required for ${key}`);
        if (bindings[key]) await this.verify(bindings[key]);
      }
      for (const room of Object.values(definition.rooms)) {
        const cids = room.members.flatMap(key => bindings[key] ? [bindings[key].cid] : []);
        need(new Set(cids).size === cids.length, 'same instance cannot occupy two seats in one room');
      }
      const participants: RoomLayoutState['participants'] = {};
      for (const [key, participant] of Object.entries(definition.participants)) {
        if (participant.instance_scope === 'room') {
          for (const [room, spec] of Object.entries(definition.rooms)) if (spec.members.includes(key))
            participants[instanceKey(definition, key, room)] = { owned: true, participant: key, room };
        } else participants[key] = { owned: !bindings[key], ...(bindings[key] ? { instance: bindings[key] } : {}) };
      }
      this.save({ version: 1, definition, controller, ...(this.owner ? { owner: ownerReference(this.owner) } : {}),
        agent_templates: agentTemplates, participants, rooms: {}, order: [], closed: false });
    });
  }
  private checkOwnerRoles(definition: LayoutDefinition): void {
    if (!this.owner) return;
    for (const room of Object.values(definition.rooms))
      need(room.members.every(member => (room.roles?.[member] ?? member) !== this.owner!.role), 'participant cannot use the owner role');
  }
  private async operation<T>(actor: string, work: (s: RoomLayoutState) => Promise<T>, cleanup = false): Promise<T> {
    return withFileLock(this.file + '.lock', async () => {
      const s = this.snapshot(); need(actor === s.controller, 'controller authorization required');
      if (!cleanup) {
        need(!s.closed && !s.closing, 'layout instance closing or closed');
        need(!s.uncertain, `reconciliation required: ${s.uncertain}`);
      }
      return work(s);
    });
  }
  private async mutation<T>(s: RoomLayoutState, id: string, work: () => Promise<T>, commit: (result: T) => void): Promise<void> {
    s.uncertain = id; this.save(s);
    // On any error keep the cursor, even if the operation may have succeeded.
    const result = await work(); commit(result); delete s.uncertain; this.save(s);
  }
  private async activateRoom(s: RoomLayoutState, key: string, spec: LayoutRoom): Promise<void> {
    if (s.owner) need(this.owner && canonicalJson(s.owner) === canonicalJson(ownerReference(this.owner)), 'room owner configuration changed');
    this.checkOwnerRoles(s.definition);
    need(s.rooms[key]?.state !== 'closed', 'room closed');
    for (const member of spec.members) {
      const p = s.participants[instanceKey(s.definition, member, key)];
      const i = p?.instance; if (i) await this.verify(i);
      need(!p?.retired, 'participant retired');
    }
    if (s.rooms[key]?.state === 'active') { await this.assertRoomActive(s, key); return; }
    const room = s.rooms[key] ??= { spec, state: 'provisioning', ready: [] };
    this.save(s);
    for (const member of spec.members) {
      const resolvedKey = instanceKey(s.definition, member, key), p = s.participants[resolvedKey];
      if (!p.instance) {
        const template = s.definition.participants[member]?.agent_template;
        need(template, `no factory for ${member}`);
        await this.mutation(s, `spawn:${resolvedKey}`, () => this.supervisor.spawn(resolvedKey, template), i => { p.instance = i; });
        await this.verify(p.instance!);
      }
    }
    const roleFor = (member: string) => spec.roles?.[member] ?? member;
    if (!room.native) await this.mutation(s, `create:${key}`, () => this.cowork.createRoom({
      room_name: `${key.slice(0, 24)}-${createHash('sha256').update(this.file + '\0' + key).digest('hex').slice(0, 24)}`,
      goal: spec.goal, briefing: JSON.stringify({ goal: spec.goal, contract: spec.contract }),
      quiet_membership: spec.quiet_membership ?? true, anonymous: spec.anonymous ?? false,
      activation_requirements: [...new Set(spec.members.map(roleFor))].map(role => ({ role, count: spec.members.filter(m => roleFor(m) === role).length })),
    }), native => { room.native = native; s.order.push(key); });
    if (s.owner && !room.owner_ready) await this.mutation(s, `owner:${key}`, async () => {
      await this.cowork.acceptInvite(room.native!.room_id, this.owner!.invite, { role: s.owner!.role, expected_cid: s.owner!.cid });
      await this.cowork.setRoleCommands(room.native!.room_id, { role: s.owner!.role, commands: ['*'] });
    }, () => { room.owner_ready = true; });
    for (const member of spec.members) {
      if (room.ready.includes(member)) continue;
      const i = s.participants[instanceKey(s.definition, member, key)].instance!;
      await this.verify(i);
      const seats = await this.cowork.getSeats(room.native!.room_id);
      if (!seats.some(seat => seat.identity_cid === i.cid && seat.role === roleFor(member) && seat.seat_state !== 'removed')) {
        await this.mutation(s, `admit:${key}:${member}`, async () => {
          const invite = i.remote ? '' : (await this.cowork.issueInvite(room.native!.room_id, { mode: 'one_time', role: roleFor(member), min_accepts: 1 })).invite;
          await this.supervisor.join(i, invite, room.native!.identity_cid, { roomId: room.native!.room_id, role: roleFor(member) });
        }, () => {});
      }
    }
    await this.assertRoomActive(s, key);
    // Admission of all required seats precedes any participant work.
    for (const member of spec.members) {
      if (room.ready.includes(member)) continue;
      const i = s.participants[instanceKey(s.definition, member, key)].instance!;
      await this.verify(i);
      await this.mutation(s, `assignment:${key}:${member}`, () => this.supervisor.assign(i, {
        id: `${key}:${member}`, room_id: room.native!.room_id, room_cid: room.native!.identity_cid,
        participant: member, room_role: roleFor(member), goal: spec.goal, contract: spec.contract,
      }), () => { room.ready.push(member); });
    }
    room.state = 'active'; this.save(s);
  }
  activate(actor: string, key: string): Promise<void> {
    return this.operation(actor, async s => {
      need(own(s.definition.rooms, key), 'unknown room');
      await this.activateRoom(s, key, s.definition.rooms[key]);
    });
  }
  private async assertRoomActive(s: RoomLayoutState, key: string): Promise<void> {
    const room = s.rooms[key], native = await this.cowork.getRoom(room.native!.room_id);
    need(native?.identity_cid === room.native!.identity_cid && native.state === 'active', 'native room missing, changed or inactive');
    if (s.owner) need(native.seats.some(seat => seat.identity_cid.toLowerCase() === s.owner!.cid.toLowerCase()
      && seat.role === s.owner!.role && seat.seat_state === 'active'), 'owner membership not active');
    need(room.spec.members.every(member => native.seats.some(seat => seat.identity_cid === s.participants[instanceKey(s.definition, member, key)].instance!.cid
      && seat.role === (room.spec.roles?.[member] ?? member) && seat.seat_state === 'active')), 'membership not active');
  }
  private async archiveRoom(s: RoomLayoutState, key: string): Promise<void> {
    const room = s.rooms[key]; need(room?.native, 'room not created');
    if (room.state === 'closed') return;
    const native = await this.cowork.getRoom(room.native.room_id);
    if (native) {
      need(native.identity_cid === room.native.identity_cid, 'native room identity changed');
      if (native.state !== 'closed') await this.cowork.closeRoom(room.native.room_id);
    }
    room.state = 'closed'; this.save(s);
  }
  closeRoom(actor: string, key: string): Promise<void> {
    return this.operation(actor, s => this.archiveRoom(s, key), true);
  }
  close(actor: string): Promise<void> {
    return this.operation(actor, async s => {
      if (s.closed) return;
      s.closing = true; this.save(s);
      const errors: string[] = [];
      for (const key of [...s.order].reverse()) {
        try { await this.archiveRoom(s, key); }
        catch (error) { errors.push(`room ${key}: ${String(error)}`); }
      }
      for (const [key, p] of Object.entries(s.participants)) if (p.owned && p.instance && !p.retired) {
        try {
          need(p.instance.supervisor === this.supervisor.id, 'remote binding unsupported');
          await this.supervisor.retire(p.instance);
          p.retired = true; this.save(s);
        } catch (error) { errors.push(`participant ${key}: ${String(error)}`); }
      }
      // Clean known resources without erasing evidence of an unknown creation outcome.
      if (s.uncertain) errors.push(`known resources cleaned where possible; inspection still required: ${s.uncertain}`);
      if (errors.length) throw Error(`layout cleanup incomplete: ${errors.join('; ')}`);
      s.closed = true; delete s.closing; this.save(s);
    }, true);
  }

  /** Explicit deletion retains a per-room checkpoint until the run is erased.
   * Finish/cancel continue to use close(), preserving archived rooms.
   */
  async delete(actor: string): Promise<void> {
    await this.close(actor);
    await this.operation(actor, async state => {
      for (const room of Object.values(state.rooms)) {
        if (!room.native || room.deleted) continue;
        let remote;
        try { remote = await this.cowork.getRoom(room.native.room_id); }
        catch (error) { if (!(error instanceof CoworkProtocolError && error.code === 'not_found')) throw error; }
        if (remote) {
          need(remote.identity_cid === room.native.identity_cid, 'native room identity changed during deletion');
          try { await this.cowork.deleteRoom(room.native.room_id); }
          catch (error) { if (!(error instanceof CoworkProtocolError && error.code === 'not_found')) throw error; }
        }
        room.deleted = true; this.save(state);
      }
    }, true);
  }
}
