import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LayoutBindingGrants } from '../src/rooms-tasks/layout-binding-grants.js';
import { callRemoteLayoutBinding, localLayoutReference, layoutBindingOrigin } from '../src/rooms-tasks/layout-binding-client.js';
import { readLayoutBindings } from '../src/rooms-tasks/layout-cli.js';
import { RoomLayout, type LayoutInstance, type LayoutSupervisor } from '../src/rooms-tasks/layout.js';
import type { CoworkAdapter } from '../src/rooms-tasks/cowork-adapter.js';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cross-fleet-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const live = new Map<string, LayoutInstance>();
  const localLive = new Map<string, LayoutInstance>();
  const rooms = new Map<string, any>(); let sequence = 0;
  const owner: LayoutSupervisor = {
    id: 'Fleet-B-private-root',
    verify: vi.fn(async i => { if (JSON.stringify(live.get(i.agent!)) !== JSON.stringify(i)) throw Error('stale or room-owned'); }),
    spawn: vi.fn(async () => { throw Error('no spawning'); }),
    join: vi.fn(async (i, invite, cid) => {
      const [id, role] = invite.split(':'); if (cid !== id) throw Error('wrong room');
      rooms.get(id).seats.push({ identity_cid: i.cid, role, seat_state: 'active' });
    }),
    assign: vi.fn(async () => {}), retire: vi.fn(async i => { live.delete(i.agent!); }),
  };
  const cowork = {
    createRoom: vi.fn(async () => { const id = `room-${++sequence}`; rooms.set(id, { identity_cid: id, state: 'active', seats: [], history: ['retained-message'] }); return { room_id: id, identity_cid: id, identity_name: id }; }),
    issueInvite: vi.fn(async (id, o) => ({ invite: `${id}:${o.role}` })),
    getSeats: vi.fn(async id => rooms.get(id).seats), getRoom: vi.fn(async id => rooms.get(id)),
    closeRoom: vi.fn(async id => { rooms.get(id).state = 'closed'; }),
  } as unknown as CoworkAdapter;
  const grants = new LayoutBindingGrants(owner, { root: join(root, 'owner-grants'), daemonInstanceId: () => 'shared-daemon', cowork: () => cowork });
  const transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    try {
      const id = String(url).split('/').at(-2)!;
      const result = await grants.control(id, (options!.headers as Record<string, string>).authorization, JSON.parse(options!.body as string));
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (error) { return new Response(JSON.stringify({ error: String(error) }), { status: 403 }); }
  }) as unknown as typeof fetch;
  const borrower: LayoutSupervisor = {
    id: 'Fleet-A-private-root',
    verify: vi.fn(async i => {
      if (!i.remote) { if (JSON.stringify(localLive.get(i.launch)) !== JSON.stringify(i)) throw Error('stale local instance'); return; }
      await callRemoteLayoutBinding(i, { action: 'verify' }, 'shared-daemon', transport);
    }),
    spawn: vi.fn(async () => { throw Error('no spawning'); }),
    join: vi.fn(async (i, _invite, roomCid, membership) => {
      if (!i.remote) { rooms.get(membership!.roomId).seats.push({ identity_cid: i.cid, role: membership!.role, seat_state: 'active' }); return; }
      await callRemoteLayoutBinding(i, { action: 'join', roomCid, roomId: membership!.roomId, roomRole: membership!.role }, 'shared-daemon', transport);
    }),
    assign: vi.fn(async (i, assignment) => { if (i.remote) await callRemoteLayoutBinding(i, { action: 'assign', assignment }, 'shared-daemon', transport); }),
    retire: vi.fn(async i => { if (i.remote) throw Error('borrower cannot retire'); localLive.delete(i.launch); }),
  };
  const share = async (agent = 'architect', temporary = true) => {
    const instance = { supervisor: owner.id, agent, temporary, launch: `launch-${agent}`, cid: `cid-${agent}`, session: `session-${agent}` };
    live.set(agent, instance);
    const output = join(root, `${agent}.yaml`);
    const receipt = await grants.share(instance, 'http://127.0.0.1:49271', output, agent);
    return { receipt, instance, binding: readLayoutBindings(output)[agent], token: readFileSync(`${output}.token`, 'utf8').trim() };
  };
  return { owner, borrower, cowork, grants, share, live, localLive, rooms, transport };
}
it('reuses Fleet B exact sessions through all three rooms and closes without foreign retirement', async () => {
  const f = fixture(); const bindings: Record<string, LayoutInstance> = {};
  for (const key of ['architect', 'developer', 'doctor']) bindings[key] = (await f.share(key)).binding;
  const file = join(root, 'layout.json');
  const engine = () => new RoomLayout(file, f.cowork, f.borrower);
  await engine().create({ participants: { architect: {}, developer: {}, doctor: {} }, rooms: {
    product: { goal: 'Scope', members: ['architect', 'doctor'] },
    design: { goal: 'Design', members: ['architect', 'developer', 'doctor'] },
    delivery: { goal: 'Delivery', members: ['developer', 'doctor'] },
  } }, 'creator', bindings);
  for (const room of ['product', 'design', 'delivery']) { await engine().activate('creator', room); await engine().activate('creator', room); }
  expect(f.cowork.createRoom).toHaveBeenCalledTimes(3); expect(f.owner.join).toHaveBeenCalledTimes(7);
  expect(f.owner.assign).toHaveBeenCalledTimes(7); expect(f.borrower.spawn).not.toHaveBeenCalled();
  expect(f.owner.spawn).not.toHaveBeenCalled();
  expect(Object.values(engine().snapshot().participants).every(p => !p.owned)).toBe(true);
  await engine().closeRoom('creator', 'product');
  expect(f.rooms.get('room-2').state).toBe('active'); expect(f.live.size).toBe(3);
  await engine().close('creator'); await engine().close('creator');
  expect([...f.rooms.values()].every(r => r.state === 'closed' && r.history.length === 1)).toBe(true);
  expect(f.borrower.retire).not.toHaveBeenCalled(); expect(f.owner.retire).not.toHaveBeenCalled();
  expect(f.live.size).toBe(3);
  for (const i of f.live.values()) await f.owner.retire(i);
  expect(f.owner.retire).toHaveBeenCalledTimes(3);
});
it.each([true, false])('exports exact temporary=%s binding with private separate credential and only digest persisted', async temporary => {
  const f = fixture(), s = await f.share('architect', temporary);
  expect(parse(readFileSync(s.receipt.file, 'utf8')).architect.remote.credential_file).toBe('architect.yaml.token');
  expect(readFileSync(join(root, 'owner-grants', `${s.receipt.grant_id}.json`), 'utf8')).not.toContain(s.token);
  await callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', f.transport);
});
it.each(['launch', 'cid', 'session', 'supervisor', 'agent'] as const)('rejects changed %s without mutation or replacement', async field => {
  const f = fixture(), s = await f.share(); const bad = { ...s.binding, [field]: 'replacement' };
  await expect(callRemoteLayoutBinding(bad, { action: 'join', roomId: 'r', roomRole: 'Architect', roomCid: 'r' }, 'shared-daemon', f.transport)).rejects.toThrow('rejected');
  expect(f.owner.join).not.toHaveBeenCalled(); expect(f.owner.spawn).not.toHaveBeenCalled();
});
it('rejects a stopped/replaced runtime, then revoked grant, while preserving agent ownership', async () => {
  const f = fixture(), s = await f.share(); f.live.set('architect', { ...s.instance, session: 'replacement' });
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', f.transport)).rejects.toThrow('rejected');
  f.live.set('architect', s.instance); await f.grants.revoke(s.receipt.grant_id);
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', f.transport)).rejects.toThrow('rejected');
  expect(f.live.size).toBe(1); expect(f.owner.retire).not.toHaveBeenCalled();
});
it('requires owner authorization and the same daemon before any action', async () => {
  const f = fixture(), s = await f.share();
  await expect(f.grants.control(s.receipt.grant_id, undefined, { action: 'verify' })).rejects.toMatchObject({ code: 'unauthorized' });
  await expect(f.grants.control(s.receipt.grant_id, `Bearer ${'x'.repeat(43)}`, { action: 'verify' })).rejects.toMatchObject({ code: 'unauthorized' });
  vi.mocked(f.transport).mockClear();
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'other-daemon', f.transport)).rejects.toThrow('same daemon');
  expect(f.transport).not.toHaveBeenCalled();
});
it.each(['retire', 'inspect', 'spawn'])('capability cannot authorize %s at either client or server', async action => {
  const f = fixture(), s = await f.share(); const request = { action, instance: s.instance, daemonInstanceId: 'shared-daemon' };
  await expect(f.grants.control(s.receipt.grant_id, `Bearer ${s.token}`, request)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(callRemoteLayoutBinding(s.binding, request as any, 'shared-daemon', f.transport)).rejects.toThrow('only verify');
  expect(f.owner.retire).not.toHaveBeenCalled();
});
it('requires actual active Cowork membership and role before context delivery', async () => {
  const f = fixture(), s = await f.share(); f.rooms.set('r', { identity_cid: 'r', state: 'active', seats: [] });
  const assignment = { id: 'layout', room_id: 'r', room_cid: 'r', room_role: 'Architect', participant: 'architect', goal: 'goal' };
  const call = () => callRemoteLayoutBinding(s.binding, { action: 'assign', assignment }, 'shared-daemon', f.transport);
  await expect(call()).rejects.toThrow('rejected'); expect(f.owner.assign).not.toHaveBeenCalled();
  f.rooms.get('r').seats.push({ identity_cid: s.instance.cid, role: 'Architect', seat_state: 'active' });
  await call(); expect(f.owner.assign).toHaveBeenCalledTimes(1);
  f.rooms.get('r').state = 'closed'; await expect(call()).rejects.toThrow('rejected');
});
it('does not leak credentials in snapshots, request body, or remote failures', async () => {
  const f = fixture(), s = await f.share();
  const fetcher = vi.fn(async (_url, options) => {
    expect(options.body).not.toContain(s.token); expect(options.body).not.toContain('credential_file');
    expect(options.redirect).toBe('error'); return new Response(s.token, { status: 500 });
  });
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', fetcher)).rejects.toThrow('rejected (500)');
  expect(JSON.stringify(s.binding)).not.toContain(s.token);
});
it('rejects malformed proof and hides response parse content', async () => {
  const f = fixture(), s = await f.share();
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', async () => new Response(JSON.stringify({ instance: { ...s.instance, session: 'other' } })))).rejects.toThrow('proof changed');
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', async () => new Response(s.token))).rejects.toThrow('invalid cross-Fleet control response');
});
it('rejects untrusted credential permissions and symlinks before sending', async () => {
  const f = fixture(), s = await f.share(); const file = s.binding.remote!.credential_file;
  chmodSync(file, 0o644);
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', f.transport)).rejects.toThrow('untrusted');
  chmodSync(file, 0o600); symlinkSync(file, join(root, 'link')); s.binding.remote!.credential_file = join(root, 'link');
  await expect(callRemoteLayoutBinding(s.binding, { action: 'verify' }, 'shared-daemon', f.transport)).rejects.toThrow('untrusted');
  expect(f.transport).not.toHaveBeenCalled();
});
it('refuses overwrite, unsupported runtime and invalid grant paths', async () => {
  const f = fixture(), s = await f.share();
  await expect(f.grants.share(s.instance, s.binding.remote!.url, s.receipt.file, 'architect')).rejects.toThrow('already exists');
  f.live.delete('architect'); await expect(f.grants.share(s.instance, s.binding.remote!.url, join(root, 'new.yaml'), 'architect')).rejects.toThrow('stale');
  await expect(f.grants.revoke('../outside')).rejects.toThrow('invalid');
});
it.each(['http://[::1]:49271', 'https://127.0.0.1', 'http://localhost:123', 'http://example.com', 'http://127.0.0.1/path', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/?token=x'])('rejects unsupported control origin %s', origin => {
  expect(() => layoutBindingOrigin(origin)).toThrow();
});
it('persists uncertain admission after a lost response and never blindly repeats the join', async () => {
  const f = fixture(), s = await f.share();
  const original = vi.mocked(f.transport).getMockImplementation()!;
  vi.mocked(f.transport).mockImplementation(async (url, options) => {
    const body = JSON.parse(options!.body as string);
    const response = await original(url, options);
    if (body.action === 'join') throw Error('response lost after admission');
    return response;
  });
  const layout = new RoomLayout(join(root, 'uncertain.json'), f.cowork, f.borrower);
  await layout.create({ participants: { architect: {} }, rooms: { design: { goal: 'Design', members: ['architect'] } } }, 'creator', { architect: s.binding });
  await expect(layout.activate('creator', 'design')).rejects.toThrow('outcome may be unknown');
  expect(layout.snapshot().uncertain).toBe('admit:design:architect');
  expect(f.owner.join).toHaveBeenCalledTimes(1);
  await expect(layout.activate('creator', 'design')).rejects.toThrow('reconciliation required');
  expect(f.owner.join).toHaveBeenCalledTimes(1); expect(f.borrower.spawn).not.toHaveBeenCalled();
});

it('rejects ordinary contact invitations and mismatched or closed Cowork targets before redemption', async () => {
  const f = fixture(), s = await f.share();
  const authorize = (body: unknown) => f.grants.control(s.receipt.grant_id, `Bearer ${s.token}`, { instance: s.instance, daemonInstanceId: 'shared-daemon', ...body as object });
  await expect(authorize({ action: 'join', invite: 'ordinary-contact', roomCid: 'outsider' })).rejects.toMatchObject({ code: 'invalid_request' });
  for (const room of [undefined, { state: 'closed', identity_cid: 'r' }, { state: 'closing', identity_cid: 'r' }, { state: 'active', identity_cid: 'different' }]) {
    if (room) f.rooms.set('r', room); else f.rooms.delete('r');
    await expect(authorize({ action: 'join', roomId: 'r', roomCid: 'r', roomRole: 'Architect' })).rejects.toThrow('rejected');
  }
  expect(f.cowork.issueInvite).not.toHaveBeenCalled(); expect(f.owner.join).not.toHaveBeenCalled();
});

it('combines a shared remote doctor with distinct room-scoped local critics and preserves borrowed ownership', async () => {
  const f = fixture(), doctor = await f.share('doctor');
  vi.mocked(f.borrower.spawn).mockImplementation(async key => {
    const i = { supervisor: f.borrower.id, agent: key.replace(':', '-'), temporary: true, launch: key, cid: `local-cid-${key}`, session: `local-session-${key}` };
    f.localLive.set(i.launch, i); return i;
  });
  const ownerCid = 'abcdef01'.repeat(8);
  f.cowork.acceptInvite = vi.fn(async id => {
    f.rooms.get(id).seats.push({ identity_cid: ownerCid.toUpperCase(), role: 'Owner', seat_state: 'active' });
    return {} as any;
  });
  f.cowork.setRoleCommands = vi.fn(async () => {});
  const file = join(root, 'mixed-scopes.json');
  const roomOwner = { cid: ownerCid, role: 'Owner', invite: 'fixture-owner-invite' };
  const layout = new RoomLayout(file, f.cowork, f.borrower, roomOwner);
  await layout.create({ participants: { doctor: { instance_scope: 'layout' }, critic: { agent_template: 'Critic', instance_scope: 'room' } }, rooms: {
    product: { goal: 'Scope', members: ['doctor', 'critic'] }, design: { goal: 'Design', members: ['doctor', 'critic'] },
  } }, 'creator', { doctor: doctor.binding });
  await layout.activate('creator', 'product'); await layout.activate('creator', 'design'); await layout.activate('creator', 'design');
  await new RoomLayout(file, f.cowork, f.borrower, roomOwner).activate('creator', 'design');
  expect(f.cowork.acceptInvite).toHaveBeenCalledTimes(2);
  expect(f.borrower.spawn).toHaveBeenCalledTimes(2); expect(f.localLive.size).toBe(2);
  expect(new Set([...f.localLive.values()].map(i => i.session)).size).toBe(2);
  expect(f.owner.join).toHaveBeenCalledTimes(2); expect(f.owner.assign).toHaveBeenCalledTimes(2);
  expect(layout.snapshot().participants.doctor.instance).toEqual(doctor.binding);
  await layout.close('creator'); await layout.close('creator');
  expect(f.borrower.retire).toHaveBeenCalledTimes(2); expect(f.localLive.size).toBe(0);
  expect(f.live.get('doctor')).toEqual(doctor.instance); expect(f.owner.retire).not.toHaveBeenCalled();
});
