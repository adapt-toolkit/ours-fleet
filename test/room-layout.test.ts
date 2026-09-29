import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomLayout, validateLayout, type LayoutDefinition, type LayoutInstance } from '../src/rooms-tasks/layout.js';
import type { CoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'layout-unit-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const instance = (key: string): LayoutInstance => ({ supervisor: 'local', launch: key, cid: `cid-${key}`, session: `thread-${key}` });
function definition(shared = true): LayoutDefinition {
  return { participants: { architect: { agent_template: 'architect' },
    developer: { agent_template: 'developer' }, doctor: { agent_template: 'doctor' },
    ...(shared ? {} : { architect2: { agent_template: 'architect' }, developer2: { agent_template: 'developer' }, doctor2: { agent_template: 'doctor' }, doctor3: { agent_template: 'doctor' } }),
    specialist: { agent_template: 'tester' } },
  rooms: {
    product: { goal: 'Scope', members: ['architect', 'doctor'] },
    design: { goal: 'Design', members: shared ? ['architect', 'developer', 'doctor'] : ['architect2', 'developer', 'doctor2'] },
    delivery: { goal: 'Delivery', members: shared ? ['developer', 'doctor'] : ['developer2', 'doctor3'] },
  } };
}
function fixture() {
  const rooms = new Map<string, any>(); let sequence = 0;
  const running = new Map<string, LayoutInstance>();
  const supervisor = { id: 'local',
    verify: vi.fn(async (i: LayoutInstance) => { if (JSON.stringify(running.get(i.launch)) !== JSON.stringify(i)) throw Error('stale instance'); }),
    spawn: vi.fn(async (key: string) => { const i = instance(key); running.set(i.launch, i); return i; }),
    join: vi.fn(async (i: LayoutInstance, invite: string) => { const [id, role] = invite.split(':'); rooms.get(id).seats.push({ identity_cid: i.cid, role, seat_state: 'active' }); }),
    assign: vi.fn(async () => {}),
    retire: vi.fn(async (i: LayoutInstance) => {
      const current = running.get(i.launch);
      if (current && JSON.stringify(current) !== JSON.stringify(i)) throw Error('stale instance');
      running.delete(i.launch);
    }),
  };
  const cowork = { createRoom: vi.fn(async () => { const id = `room-${++sequence}`; rooms.set(id, { seats: [] }); return { room_id: id, identity_cid: id, identity_name: id }; }),
    issueInvite: vi.fn(async (id: string, o: any) => ({ invite: `${id}:${o.role}` })),
    getSeats: vi.fn(async (id: string) => rooms.get(id).seats),
    getRoom: vi.fn(async (id: string) => rooms.has(id) ? { identity_cid: id, state: rooms.get(id).closed ? 'closed' : 'active', seats: rooms.get(id).seats } : undefined),
    closeRoom: vi.fn(async (id: string) => { rooms.get(id).closed = true; }),
  } as unknown as CoworkAdapter;
  const file = join(root, 'run.json');
  const layout = new RoomLayout(file, cowork, supervisor);
  return { file, layout, supervisor, cowork, running, rooms, reload: () => new RoomLayout(file, cowork, supervisor) };
}
it('uses distinct bounded native room names across layout instances and room keys', async () => {
  const a = fixture(), b = fixture();
  const other = new RoomLayout(join(root, 'other.json'), b.cowork, b.supervisor);
  const def = definition();
  const prefix = 'r'.repeat(100);
  def.rooms[prefix + 'A'] = def.rooms.product;
  def.rooms[prefix + 'B'] = def.rooms.product;
  await a.layout.create(def, 'operator'); await other.create(def, 'operator');
  await a.layout.activate('operator', 'design'); await other.activate('operator', 'design');
  await a.layout.activate('operator', prefix + 'A'); await a.layout.activate('operator', prefix + 'B');
  const names = [...vi.mocked(a.cowork.createRoom).mock.calls, ...vi.mocked(b.cowork.createRoom).mock.calls].map(([input]) => input.room_name);
  expect(new Set(names).size).toBe(4);
  expect(names.every(name => name.length <= 64)).toBe(true);
});
it.each([false, true])('rejects an owner role collision before creating resources (explicit=%s)', async explicit => {
  const f = fixture();
  const owner = { cid: 'owner', role: 'Owner', invite: 'owner-invite' };
  const layout = new RoomLayout(f.file, f.cowork, f.supervisor, owner);
  const def = { participants: { Owner: { agent_template: 'Agent' } }, rooms: {
    design: { goal: 'Design', members: ['Owner'], ...(explicit ? { roles: { Owner: 'Owner' } } : {}) },
  } };
  await expect(layout.create(def, 'operator')).rejects.toThrow('owner role');
  expect(f.supervisor.spawn).not.toHaveBeenCalled(); expect(f.cowork.createRoom).not.toHaveBeenCalled();
});
describe('experimental local layout', () => {
  it.each([true, false])('lazy shared=%s reuses exact participants across independently opened rooms', async shared => {
    const f = fixture(); await f.layout.create(definition(shared), 'operator');
    expect(f.supervisor.spawn).not.toHaveBeenCalled();
    await Promise.all([f.layout.activate('operator', 'product'), f.layout.activate('operator', 'product')]);
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(2); expect(f.cowork.createRoom).toHaveBeenCalledTimes(1);
    await f.reload().activate('operator', 'design');
    await f.layout.activate('operator', 'delivery');
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(shared ? 3 : 7);
    expect(f.layout.snapshot().rooms.product.state).toBe('active');
    expect(f.supervisor.assign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ goal: 'Delivery' }));
    await f.layout.close('operator'); await f.layout.close('operator');
    expect(f.supervisor.retire).toHaveBeenCalledTimes(shared ? 3 : 7);
    expect(f.cowork.closeRoom).toHaveBeenNthCalledWith(1, 'room-3');
    expect([...f.rooms.values()].every(r => r.closed && r.seats.length)).toBe(true);
    expect(f.layout.snapshot().participants.specialist.instance).toBeUndefined();
  });
  it('borrows exact binding, preserves it after consultation and run closure', async () => {
    const f = fixture(), borrowed = instance('existing'); f.running.set(borrowed.launch, borrowed);
    const d = definition(); d.rooms.amigos = { goal: 'Resolve one question', members: ['architect', 'doctor', 'specialist'] };
    await f.layout.create(d, 'operator', { architect: borrowed });
    await f.layout.activate('operator', 'product');
    await f.layout.activate('operator', 'amigos');
    await f.layout.closeRoom('operator', 'amigos');
    expect(f.running.has('doctor')).toBe(true); expect(f.running.has('existing')).toBe(true);
    expect(f.running.has('specialist')).toBe(true); expect(f.layout.snapshot().rooms.product.state).toBe('active');
    await f.layout.close('operator'); expect(f.running.has('existing')).toBe(true);
    expect(f.supervisor.retire).not.toHaveBeenCalledWith(borrowed);
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(2);
  });
  it('rejects remote, stale and unknown bindings without spawning replacements', async () => {
    const f = fixture();
    await expect(f.layout.create(definition(), 'operator', { architect: { ...instance('x'), supervisor: 'remote' } })).rejects.toThrow('remote binding unsupported');
    await expect(f.layout.create(definition(), 'operator', { architect: instance('gone') })).rejects.toThrow('stale instance');
    await expect(f.layout.create(definition(), 'operator', { missing: instance('x') })).rejects.toThrow('unknown binding');
    expect(f.supervisor.spawn).not.toHaveBeenCalled(); expect(f.cowork.createRoom).not.toHaveBeenCalled();
  });
  it('rejects session replacement, even with the original CID', async () => {
    const f = fixture(); await f.layout.create(definition(), 'operator'); await f.layout.activate('operator', 'product');
    f.running.set('architect', { ...instance('architect'), session: 'replacement' });
    await expect(f.layout.activate('operator', 'design')).rejects.toThrow('stale instance');
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(2);
  });
  it('requires controller authority but allows any declared room to open first', async () => {
    const f = fixture(); await f.layout.create(definition(), 'operator');
    await expect(f.layout.activate('architect', 'design')).rejects.toThrow('controller authorization');
    await f.layout.activate('operator', 'delivery');
    expect(f.layout.snapshot().rooms.product).toBeUndefined();
    expect(f.layout.snapshot().rooms.delivery.state).toBe('active');
  });
  it('persists uncertain side effects and refuses blind retry after response loss', async () => {
    const f = fixture(); await f.layout.create(definition(), 'operator');
    vi.mocked(f.cowork.createRoom).mockImplementationOnce(async () => { throw Error('response lost'); });
    await expect(f.layout.activate('operator', 'product')).rejects.toThrow('response lost');
    await expect(f.reload().activate('operator', 'product')).rejects.toThrow('reconciliation required');
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(1); expect(f.supervisor.spawn).toHaveBeenCalledTimes(2);
  });
  it('validates unknown references and duplicate seats', () => {
    const d = definition(); d.rooms.delivery.members.push('absent'); expect(() => validateLayout(d)).toThrow('unknown participant');
    const e = definition(); e.rooms.delivery.members.push('doctor'); expect(() => validateLayout(e)).toThrow('duplicate participant');
  });
});

it('pins room owner attachment and preserves the invite only in memory', async () => {
  const f = fixture();
  f.cowork.acceptInvite = vi.fn(async (id, _invite, opts) => { f.rooms.get(id).seats.push({ identity_cid: opts.expected_cid, role: opts.role, seat_state: 'active' }); return {} as any; });
  f.cowork.setRoleCommands = vi.fn(async () => {});
  const owner = { cid: 'owner-cid', role: 'Owner', invite: 'private-owner-invite' };
  const engine = new RoomLayout(f.file, f.cowork, f.supervisor, owner);
  await engine.create(definition(), 'operator'); await engine.activate('operator', 'product');
  expect(f.cowork.acceptInvite).toHaveBeenCalledWith('room-1', owner.invite, { role: 'Owner', expected_cid: owner.cid });
  expect(JSON.stringify(engine.snapshot())).not.toContain(owner.invite);
  const changed = new RoomLayout(f.file, f.cowork, f.supervisor, { ...owner, cid: 'other-owner' });
  await expect(changed.activate('operator', 'design')).rejects.toThrow('owner configuration changed');
  expect(f.cowork.createRoom).toHaveBeenCalledTimes(1);
});

it('keeps participants alive when one or all of their rooms close', async () => {
  const f = fixture(), d = definition();
  d.rooms.first = { goal: 'Advice', members: ['doctor', 'specialist'] };
  d.rooms.second = structuredClone(d.rooms.first);
  await f.layout.create(d, 'operator');
  await f.layout.activate('operator', 'first'); await f.layout.activate('operator', 'second');
  await f.layout.closeRoom('operator', 'first');
  expect(f.layout.snapshot().rooms.second.state).toBe('active');
  await f.layout.closeRoom('operator', 'second');
  expect(f.running.has('specialist')).toBe(true); expect(f.running.has('doctor')).toBe(true);
  expect(f.supervisor.retire).not.toHaveBeenCalled();
  await f.layout.close('operator'); expect(f.supervisor.retire).toHaveBeenCalledTimes(2);
});

it('cleans known agents after an uncertain create without replaying or concealing it', async () => {
  const f = fixture(); await f.layout.create(definition(), 'operator');
  vi.mocked(f.cowork.createRoom).mockRejectedValueOnce(Error('response lost'));
  await expect(f.layout.activate('operator', 'product')).rejects.toThrow('response lost');
  await expect(f.layout.close('intruder')).rejects.toThrow('controller authorization');
  expect(f.supervisor.retire).not.toHaveBeenCalled();
  await expect(f.reload().close('operator')).rejects.toThrow('inspection still required: create:product');
  expect(f.running.size).toBe(0);
  expect(f.layout.snapshot()).toMatchObject({ uncertain: 'create:product', closed: false, closing: true });
  await expect(f.layout.close('operator')).rejects.toThrow('inspection still required');
  expect(f.supervisor.retire).toHaveBeenCalledTimes(2);
  expect(f.cowork.createRoom).toHaveBeenCalledTimes(1);
});
it('closes known rooms and remaining participants when one is already stopped', async () => {
  const f = fixture(); await f.layout.create(definition(), 'operator'); await f.layout.activate('operator', 'product');
  f.running.delete('architect');
  await f.layout.close('operator');
  expect(f.running.size).toBe(0); expect(f.layout.snapshot().closed).toBe(true);
});
it('preserves a replacement but still cleans the other owned participants', async () => {
  const f = fixture(); await f.layout.create(definition(), 'operator'); await f.layout.activate('operator', 'product');
  const replacement = { ...instance('architect'), session: 'replacement' }; f.running.set('architect', replacement);
  await expect(f.layout.close('operator')).rejects.toThrow('participant architect: Error: stale instance');
  expect(f.running.get('architect')).toEqual(replacement); expect(f.running.has('doctor')).toBe(false);
  await expect(f.layout.activate('operator', 'delivery')).rejects.toThrow('closing');
  f.running.delete('architect'); await f.reload().close('operator'); expect(f.layout.snapshot().closed).toBe(true);
});
it('continues cleanup after a room error and retries only unfinished known resources', async () => {
  const f = fixture(); await f.layout.create(definition(), 'operator');
  await f.layout.activate('operator', 'product'); await f.layout.activate('operator', 'design');
  vi.mocked(f.cowork.closeRoom).mockRejectedValueOnce(Error('unreachable'));
  await expect(f.layout.close('operator')).rejects.toThrow('room design');
  expect(f.layout.snapshot().rooms.product.state).toBe('closed'); expect(f.running.size).toBe(0);
  await f.reload().close('operator');
  expect(f.layout.snapshot().closed).toBe(true); expect(f.supervisor.retire).toHaveBeenCalledTimes(3);
});
it('cleans rooms despite an uncertain assignment while preserving the original failure', async () => {
  const f = fixture(); await f.layout.create(definition(), 'operator');
  f.supervisor.assign.mockRejectedValueOnce(Error('assignment response lost'));
  await expect(f.layout.activate('operator', 'product')).rejects.toThrow('assignment response lost');
  await f.layout.closeRoom('operator', 'product');
  await expect(f.layout.close('operator')).rejects.toThrow('assignment:product:architect');
  expect(f.running.size).toBe(0); expect(f.layout.snapshot().rooms.product.state).toBe('closed');
  expect(f.layout.snapshot().uncertain).toBe('assignment:product:architect');
});
it.each(['missing', 'closed', 'member', 'role', 'identity'])('rejects native %s drift on repeated open without changing resources', async drift => {
  const f = fixture(); await f.layout.create(definition(), 'operator'); await f.layout.activate('operator', 'product');
  const id = f.layout.snapshot().rooms.product.native!.room_id;
  if (drift === 'missing') f.rooms.delete(id);
  if (drift === 'closed') f.rooms.get(id).closed = true;
  if (drift === 'member') f.rooms.get(id).seats[0].seat_state = 'removed';
  if (drift === 'role') f.rooms.get(id).seats[0].role = 'other';
  if (drift === 'identity') vi.mocked(f.cowork.getRoom).mockResolvedValueOnce({ identity_cid: 'replacement', state: 'active', seats: f.rooms.get(id).seats } as any);
  await expect(f.reload().activate('operator', 'product')).rejects.toThrow();
  expect(f.supervisor.assign).toHaveBeenCalledTimes(2); expect(f.supervisor.spawn).toHaveBeenCalledTimes(2);
  expect(f.cowork.createRoom).toHaveBeenCalledTimes(1); expect(f.supervisor.join).toHaveBeenCalledTimes(2);
});
