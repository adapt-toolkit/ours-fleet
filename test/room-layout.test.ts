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
function scopedDefinition(): LayoutDefinition {
  return { participants: {
    doctor: { agent_template: 'Doctor', instance_scope: 'layout' },
    critic: { agent_template: 'Critic', instance_scope: 'room' },
  }, rooms: {
    discovery: { goal: 'Scope', members: ['doctor', 'critic'], roles: { critic: 'Critic' } },
    design: { goal: 'Design', members: ['doctor', 'critic'], roles: { critic: 'Critic' } },
    unused: { goal: 'Later', members: ['critic'] },
  } };
}
describe('participant instance scope', () => {
  it('keeps one shared session and distinct room sessions across reloads and repeated opens', async () => {
    const f = fixture(), def = scopedDefinition();
    await f.layout.create(def, 'operator');
    expect(f.supervisor.spawn).not.toHaveBeenCalled();
    await Promise.all([f.layout.activate('operator', 'design'), f.reload().activate('operator', 'discovery')]);
    await f.reload().activate('operator', 'design');
    const state = f.layout.snapshot();
    expect(state.definition).toEqual(def);
    expect(f.supervisor.spawn.mock.calls.map(([key]) => key).sort()).toEqual(['design:critic', 'discovery:critic', 'doctor']);
    expect(state.participants['design:critic'].instance!.cid).not.toBe(state.participants['discovery:critic'].instance!.cid);
    expect(state.participants['design:critic'].instance!.session).not.toBe(state.participants['discovery:critic'].instance!.session);
    expect(state.participants['unused:critic'].instance).toBeUndefined();
    for (const room of ['discovery', 'design']) {
      const seats = f.rooms.get(state.rooms[room].native!.room_id).seats;
      expect(seats.map((seat: any) => seat.identity_cid).sort()).toEqual([`cid-${room}:critic`, 'cid-doctor']);
      expect(state.rooms[room].ready).toEqual(['doctor', 'critic']);
      expect(f.supervisor.assign).toHaveBeenCalledWith(instance(`${room}:critic`), expect.objectContaining({
        id: `${room}:critic`, participant: 'critic', room_role: 'Critic',
        room_id: state.rooms[room].native!.room_id,
      }));
    }
    expect(f.supervisor.assign).toHaveBeenCalledTimes(4);
    expect(f.cowork.createRoom).toHaveBeenCalledTimes(2);
  });
  it('keeps scoped agents until run closure, cleans them once and never spawns unopened rooms', async () => {
    const f = fixture(); await f.layout.create(scopedDefinition(), 'operator');
    await f.layout.activate('operator', 'discovery'); await f.layout.activate('operator', 'design');
    await f.layout.closeRoom('operator', 'discovery');
    expect(f.running.has('discovery:critic')).toBe(true);
    await expect(f.reload().activate('operator', 'discovery')).rejects.toThrow('room closed');
    await f.reload().activate('operator', 'design');
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(3);
    await f.layout.close('operator'); await f.reload().close('operator');
    expect(f.supervisor.retire).toHaveBeenCalledTimes(3); expect(f.running.size).toBe(0);
    expect(f.layout.snapshot().participants['unused:critic'].instance).toBeUndefined();
  });
  it('retains borrowed shared instances alongside room-scoped agents', async () => {
    const f = fixture(), borrowed = instance('existing'); f.running.set(borrowed.launch, borrowed);
    await f.layout.create(scopedDefinition(), 'operator', { doctor: borrowed });
    await f.layout.activate('operator', 'design'); await f.layout.activate('operator', 'discovery');
    await f.layout.close('operator');
    expect([...f.running.values()]).toEqual([borrowed]); expect(f.supervisor.retire).toHaveBeenCalledTimes(2);
  });
  it('rejects a binding for a room-scoped participant before verifying or creating anything', async () => {
    const f = fixture();
    await expect(f.layout.create(scopedDefinition(), 'operator', { critic: instance('existing') }))
      .rejects.toThrow('binding unsupported for room-scoped participant critic');
    expect(f.supervisor.verify).not.toHaveBeenCalled(); expect(f.supervisor.spawn).not.toHaveBeenCalled();
    expect(f.cowork.createRoom).not.toHaveBeenCalled();
  });
  it('does not reuse another room instance when a scoped spawn outcome is unknown', async () => {
    const f = fixture(); await f.layout.create(scopedDefinition(), 'operator');
    await f.layout.activate('operator', 'discovery');
    f.supervisor.spawn.mockRejectedValueOnce(Error('response lost'));
    await expect(f.layout.activate('operator', 'design')).rejects.toThrow('response lost');
    await expect(f.reload().activate('operator', 'design')).rejects.toThrow('reconciliation required');
    expect(f.layout.snapshot().uncertain).toBe('spawn:design:critic');
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(3);
    await expect(f.layout.close('operator')).rejects.toThrow('inspection still required');
    expect(f.supervisor.retire).toHaveBeenCalledTimes(2);
  });
  it('rejects replacement of one room session without retiring or replacing the new session', async () => {
    const f = fixture(); await f.layout.create(scopedDefinition(), 'operator');
    await f.layout.activate('operator', 'design');
    const replacement = { ...instance('design:critic'), session: 'replacement' };
    f.running.set('design:critic', replacement);
    await expect(f.reload().activate('operator', 'design')).rejects.toThrow('stale instance');
    await expect(f.layout.close('operator')).rejects.toThrow('participant design:critic');
    expect(f.running.get('design:critic')).toEqual(replacement);
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(2);
  });
  it('keeps legacy instance keys and snapshots when scope is omitted', async () => {
    const f = fixture(); await f.layout.create(definition(), 'operator');
    const before = f.layout.snapshot();
    expect(Object.keys(before.participants)).toEqual(Object.keys(before.definition.participants));
    expect(Object.values(before.participants).every(p => p.participant === undefined && p.room === undefined)).toBe(true);
    await f.reload().activate('operator', 'product'); await f.reload().activate('operator', 'design');
    expect(f.supervisor.spawn).toHaveBeenCalledTimes(3);
  });
});
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

describe('Owner hexadecimal CID equality', () => {
  const cid = 'abcdef01'.repeat(8);
  function ownerFixture(configured: string, native: string, role = 'Owner', seatState = 'active') {
    const f = fixture();
    f.cowork.acceptInvite = vi.fn(async (id) => {
      f.rooms.get(id).seats.push({ identity_cid: native, role, seat_state: seatState });
      return {} as any;
    });
    f.cowork.setRoleCommands = vi.fn(async () => {});
    const owner = { cid: configured, role: 'Owner', invite: 'fixture-owner-invite' };
    const engine = () => new RoomLayout(f.file, f.cowork, f.supervisor, owner);
    return { ...f, engine };
  }
  it.each([[cid, cid.toUpperCase()], [cid.toUpperCase(), cid], [cid, 'AbCdEf01'.repeat(8)]])
    ('admits equivalent CID casing and reopens without admission or assignment replay', async (configured, native) => {
      const f = ownerFixture(configured, native);
      await f.engine().create(scopedDefinition(), 'operator');
      await f.engine().activate('operator', 'discovery');
      expect(f.supervisor.assign).toHaveBeenCalledTimes(2);
      await f.engine().activate('operator', 'discovery');
      expect(f.cowork.acceptInvite).toHaveBeenCalledTimes(1);
      expect(f.supervisor.assign).toHaveBeenCalledTimes(2);
    });
  it.each([
    ['different identity', '12345678'.repeat(8), 'Owner', 'active'],
    ['different role', cid.toUpperCase(), 'owner', 'active'],
    ['removed seat', cid.toUpperCase(), 'Owner', 'removed'],
  ])('rejects %s before assignment', async (_label, native, role, state) => {
    const f = ownerFixture(cid, native, role, state);
    await f.engine().create(scopedDefinition(), 'operator');
    await expect(f.engine().activate('operator', 'discovery')).rejects.toThrow('owner membership not active');
    expect(f.supervisor.assign).not.toHaveBeenCalled();
  });
  it.each(['identity', 'role', 'removed'])('rechecks Owner %s on reopen', async change => {
    const f = ownerFixture(cid, cid);
    await f.engine().create(scopedDefinition(), 'operator');
    await f.engine().activate('operator', 'discovery');
    const seat = f.rooms.get('room-1').seats.find((s: any) => s.role === 'Owner');
    if (change === 'identity') seat.identity_cid = '12345678'.repeat(8);
    if (change === 'role') seat.role = 'owner';
    if (change === 'removed') seat.seat_state = 'removed';
    await expect(f.engine().activate('operator', 'discovery')).rejects.toThrow('owner membership not active');
    expect(f.cowork.acceptInvite).toHaveBeenCalledTimes(1);
    expect(f.supervisor.assign).toHaveBeenCalledTimes(2);
  });
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
