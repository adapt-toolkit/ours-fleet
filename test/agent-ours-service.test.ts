import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedRole } from '../src/config.js';
import { binderKey } from '../src/agent-ours/state.js';
import {
  prepareManagedAgent,
  releaseManagedAgent,
  storeTemporaryLaunch,
  storeRoomSecret,
  privateRuntimeRoot,
} from '../src/agent-ours/service.js';
const daemon = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  owners: new Map<string, string>(),
  created: 0,
  releases: 0,
  closed: 0,
  failCreate: false,
  failRelease: false,
  redeems: 0,
  invites: [] as string[],
  member: false,
  profileWrites: [] as string[],
  failPersona: false,
}));
vi.mock('@ours.network/sdk/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ours.network/sdk/client')>(),
  attachOursClient: async (opts: any) => {
    let local: string | undefined;
    const current = () => daemon.rows.get(daemon.owners.get(opts.leaseToken) ?? local);
    return {
      listIdentities: async () =>
        [...daemon.rows.values()].map((x) => ({
          name: x.name,
          cid: x.cid,
          kind: 'role',
          temp: x.temporary,
        })),
      createIdentity: async (args: any) => create(args, false),
      createTemporaryIdentity: async (args: any) => create(args, true),
      chooseIdentity: async ({ name }: any) => {
        local = name;
        if (opts.leaseToken) daemon.owners.set(opts.leaseToken, name);
      },
      currentIdentity: async () => {
        const row = current();
        if (!row) throw Error('NOT_BOUND');
        return row;
      },
      setBio: async ({ bio }: any) => { daemon.profileWrites.push('bio'); current().bio = bio; },
      setPersona: async ({ persona }: any) => {
        daemon.profileWrites.push('persona');
        if (daemon.failPersona) throw Error('persona failed');
        current().persona = persona;
      },
      listContacts: async () => ({ contacts: daemon.member ? [{ container_id: 'ROOM' }] : [] }),
      addContact: async ({ invite }: { invite: string }) => {
        daemon.redeems++;
        daemon.invites.push(invite);
        daemon.member = true;
        return { cid: 'ROOM' };
      },
      releaseLease: async () => {
        daemon.releases++;
        if (daemon.failRelease) throw Error('release failed');
        const row = current();
        daemon.owners.delete(opts.leaseToken);
        if (row?.temporary) daemon.rows.delete(row.name);
        return {
          released: row ? [row.name] : [],
          closed: row?.temporary ? [row.name] : [],
          attempted: 0,
          notified: 0,
          failed: 0,
        };
      },
      close: async () => {
        daemon.closed++;
      },
    };
    function create(args: any, temporary: boolean) {
      daemon.created++;
      if (daemon.failCreate) throw Error('create response lost');
      const row = { name: args.name, cid: 'CID-' + daemon.created, temporary, isRoot: false, bio: args.bio, persona: '' };
      daemon.rows.set(args.name, row);
      daemon.owners.set(opts.leaseToken, args.name);
      return { hierarchy: 'role', info: { cid: row.cid } };
    }
  },
}));
vi.mock('../src/rooms-tasks/cowork-adapter.js', () => ({
  createCoworkAdapter: () => ({
    getRoom: async () => ({
      identity_cid: 'ROOM',
      seats: daemon.member
        ? [
            {
              invite_id: 'seat',
              identity_cid: daemon.rows.get('Agent')?.cid,
              role: 'Developer',
              seat_state: 'active',
            },
          ]
        : [],
    }),
  }),
}));
let root: string, role: ResolvedRole, stateDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-service-'));
  stateDir = join(root, 'agent');
  mkdirSync(stateDir);
  const profile = join(root, 'profile.json');
  writeFileSync(
    profile,
    JSON.stringify({
      serverUrl: 'http://127.0.0.1:1', endpoint: 'http://127.0.0.1:1/daemon',
      expectedInstanceId: '11111111-1111-1111-1111-111111111111',
      credentialPath: join(root, 'token'),
    }),
    { mode: 0o600 },
  );
  process.env.OURS_FLEET_HOME = root;
  role = {
    name: 'Agent',
    identity: 'Agent',
    harness: 'codex',
    sourceFile: 'test',
    env: { OURS_CONFIG: profile },
  } as ResolvedRole;
  daemon.rows.clear();
  daemon.owners.clear();
  daemon.created = daemon.releases = daemon.closed = daemon.redeems = 0;
  daemon.invites = [];
  daemon.profileWrites = [];
  daemon.failPersona = false;
  daemon.failCreate = daemon.failRelease = daemon.member = false;
});
afterEach(() => {
  delete process.env.OURS_FLEET_HOME;
  rmSync(root, { recursive: true, force: true });
});
it('temporary harness reconnect retains identity; logical termination releases it once', async () => {
  storeTemporaryLaunch(role, 'launch-1');
  const first = await prepareManagedAgent(role, stateDir, true);
  const cid = first.runtime.snapshot.cid;
  await first.runtime.startHarness(async () => {});
  await first.close(false);
  expect(daemon.releases).toBe(0);
  const second = await prepareManagedAgent(role, stateDir, true);
  expect(second.runtime.snapshot.cid).toBe(cid);
  expect(daemon.created).toBe(1);
  await second.close(false);
  await releaseManagedAgent(role);
  await releaseManagedAgent(role);
  expect(daemon.releases).toBe(1);
  expect(daemon.rows.size).toBe(0);
  await expect(prepareManagedAgent(role, stateDir, true)).rejects.toThrow(
    'TERMINAL_TEMP_REQUIRES_NEW_LAUNCH',
  );
  storeTemporaryLaunch(role, 'launch-2');
  const next = await prepareManagedAgent(role, stateDir, true);
  expect(next.runtime.snapshot.cid).not.toBe(cid);
  await next.close(true);
});
it('permanent room member clean stop/start preserves CID and established seat without redeem', async () => {
  role = {
    ...role,
    roomMemberStartup: {
      room_id: 'room',
      room_identity_cid: 'ROOM',
      identity_name: 'Agent',
      invite_id: 'seat',
      invite: 'test-only-invite',
      role: 'Developer',
      task: 'test',
    },
  } as ResolvedRole;
  storeRoomSecret(role);
  const first = await prepareManagedAgent(role, stateDir, false),
    cid = first.runtime.snapshot.cid;
  await first.close(true);
  expect(daemon.redeems).toBe(1);
  const second = await prepareManagedAgent(role, stateDir, false);
  expect(second.runtime.snapshot.cid).toBe(cid);
  expect(daemon.redeems).toBe(1);
  expect(daemon.created).toBe(1);
  await second.close(true);
});
it('uncertain provisioning releases the local connection and binder without repeating creation', async () => {
  daemon.failCreate = true;
  await expect(prepareManagedAgent(role, stateDir, false)).rejects.toThrow('create response lost');
  expect(daemon.closed).toBe(1);
  await expect(prepareManagedAgent(role, stateDir, false)).rejects.toThrow(
    'UNCERTAIN_PROVISIONING',
  );
  expect(daemon.created).toBe(1);
});

it('keeps each invite attempt private and rejects changed secrets for the same attempt', () => {
  const startup = { room_id: 'room', room_identity_cid: 'ROOM', identity_name: 'Agent', invite_id: 'first', invite: 'first-secret', role: 'Developer', task: 'test' };
  role.roomMemberStartup = startup;
  storeRoomSecret(role);
  const dir = join(privateRuntimeRoot(), 'room-inputs');
  const firstPath = join(dir, readdirSync(dir)[0]);
  const original = readFileSync(firstPath, 'utf8');
  storeRoomSecret(role);
  role.roomMemberStartup = { ...startup, invite: 'changed-secret' };
  expect(() => storeRoomSecret(role)).toThrow('ROOM_SECRET_COLLISION');
  role.roomMemberStartup = { ...startup, invite_id: 'second', invite: 'second-secret' };
  storeRoomSecret(role);
  expect(readFileSync(firstPath, 'utf8')).toBe(original);
  expect(readdirSync(dir)).toHaveLength(2);
  role.roomMemberStartup = { ...startup, identity_name: 'Other' };
  expect(() => storeRoomSecret(role)).toThrow('ROOM_SECRET_MISMATCH');
});

it('a new launch redeems only its new invite and preserves the failed attempt descriptor', async () => {
  const startup = { room_id: 'room', room_identity_cid: 'ROOM', identity_name: 'Agent', invite_id: 'failed', invite: 'old-secret', role: 'Developer', task: 'test' };
  role.roomMemberStartup = startup;
  storeRoomSecret(role);
  const dir = join(privateRuntimeRoot(), 'room-inputs');
  const firstPath = join(dir, readdirSync(dir)[0]);
  const old = readFileSync(firstPath, 'utf8');
  role.roomMemberStartup = { ...startup, invite_id: 'seat', invite: 'new-secret' };
  storeRoomSecret(role);
  storeTemporaryLaunch(role, 'new-launch');
  const managed = await prepareManagedAgent(role, stateDir, true);
  expect(daemon.invites).toEqual(['new-secret']);
  expect(readFileSync(firstPath, 'utf8')).toBe(old);
  await managed.close(true);
});

it.each([false, true])('legacy descriptors are accepted only for their exact assignment (mismatch=%s)', async mismatch => {
  const startup = { room_id: 'room', room_identity_cid: 'ROOM', identity_name: 'Agent', invite_id: 'seat', invite: '', role: 'Developer', task: 'test' };
  role.roomMemberStartup = startup;
  const dir = join(privateRuntimeRoot(), 'room-inputs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, binderKey('ROOM', 'Agent') + '.json');
  writeFileSync(path, JSON.stringify({ ...startup, invite: 'legacy-secret', room_id: mismatch ? 'other-room' : 'room' }), { mode: 0o600 });
  if (mismatch) {
    await expect(prepareManagedAgent(role, stateDir, false)).rejects.toThrow('ROOM_SECRET_MISMATCH');
    expect(daemon.invites).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('other-room');
  } else {
    const managed = await prepareManagedAgent(role, stateDir, false);
    expect(daemon.invites).toEqual(['legacy-secret']);
    await managed.close(true);
  }
});
it('release failure closes the connection and unlocks for explicit cleanup retry', async () => {
  const managed = await prepareManagedAgent(role, stateDir, false);
  daemon.failRelease = true;
  await expect(managed.close(true)).rejects.toThrow('release failed');
  expect(daemon.closed).toBe(1);
  daemon.failRelease = false;
  await releaseManagedAgent(role);
  expect(daemon.releases).toBe(2);
});

it.each([false, true])('provisions custom Role profile before harness, preserves it on reconnect (temporary=%s)', async temporary => {
  role.bio = 'Public custom role';
  role.persona = 'Private custom operating contract';
  if (temporary) storeTemporaryLaunch(role, 'profile-launch');
  let managed = await prepareManagedAgent(role, stateDir, temporary);
  const cid = managed.runtime.snapshot.cid;
  await managed.runtime.startHarness(async () => {
    expect(daemon.rows.get('Agent')).toMatchObject({ bio: role.bio, persona: role.persona });
  });
  expect(daemon.profileWrites).toEqual(['persona']);
  await managed.close(false);
  managed = await prepareManagedAgent(role, stateDir, temporary);
  expect(managed.runtime.snapshot.cid).toBe(cid);
  expect(daemon.profileWrites).toEqual(['persona']);
  await managed.close(true);
});
it('omitted profile preserves existing custom values, explicit empty values clear them', async () => {
  role.bio = 'Custom bio'; role.persona = 'Custom persona';
  let managed = await prepareManagedAgent(role, stateDir, false);
  await managed.close(false);
  delete role.bio; delete role.persona;
  managed = await prepareManagedAgent(role, stateDir, false);
  expect(daemon.rows.get('Agent')).toMatchObject({ bio: 'Custom bio', persona: 'Custom persona' });
  expect(daemon.profileWrites).toEqual(['persona']);
  await managed.close(false);
  role.bio = ''; role.persona = '';
  managed = await prepareManagedAgent(role, stateDir, false);
  expect(daemon.rows.get('Agent')).toMatchObject({ bio: '', persona: '' });
  expect(daemon.profileWrites).toEqual(['persona', 'bio', 'persona']);
  await managed.close(true);
});
it('profile failure does not publish room readiness or redeem invite; retry preserves identity', async () => {
  role.persona = 'Required contract';
  role.roomMemberStartup = { room_id: 'room', room_identity_cid: 'ROOM', identity_name: 'Agent', invite_id: 'seat', invite: 'test-only-invite', role: 'Developer', task: 'test' };
  storeRoomSecret(role); storeTemporaryLaunch(role, 'profile-launch');
  daemon.failPersona = true;
  await expect(prepareManagedAgent(role, stateDir, true)).rejects.toThrow('persona failed');
  const cid = daemon.rows.get('Agent').cid;
  expect(daemon.redeems).toBe(0);
  expect(readdirSync(join(privateRuntimeRoot(), 'room-inputs')).some(x => x.endsWith('.ready.json'))).toBe(false);
  daemon.failPersona = false;
  const managed = await prepareManagedAgent(role, stateDir, true);
  expect(managed.runtime.snapshot.cid).toBe(cid);
  expect(daemon.created).toBe(1);
  expect(daemon.redeems).toBe(1);
  await managed.close(true);
});

it.each(['cid', 'action', 'instance', 'owner', 'unsafe-owner'])('fences suspended task retirement before releasing the durable owner: %s', async mismatch => {
  storeTemporaryLaunch(role, 'owned-task-action');
  const service = await prepareManagedAgent(role, stateDir, true), cid = service.runtime.snapshot.cid!;
  await service.close(false);
  const dir = join(privateRuntimeRoot(), binderKey('11111111-1111-1111-1111-111111111111', role.identity));
  const expected = { cid, action: 'owned-task-action' };
  if (mismatch === 'cid') expected.cid = 'foreign-cid';
  if (mismatch === 'action') expected.action = 'foreign-action';
  if (mismatch === 'instance') {
    const value = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
    writeFileSync(join(dir, 'instance.json'), JSON.stringify({ ...value, instance: 'replacement' }));
  }
  if (mismatch === 'owner') rmSync(join(dir, 'owner.json'));
  if (mismatch === 'unsafe-owner') {
    const value = readFileSync(join(dir, 'owner.json'));
    writeFileSync(join(root, 'foreign-owner'), value); rmSync(join(dir, 'owner.json'));
    symlinkSync(join(root, 'foreign-owner'), join(dir, 'owner.json'));
  }
  await expect(releaseManagedAgent(role, expected)).rejects.toThrow();
  expect(daemon.releases).toBe(0); expect(daemon.rows.get(role.identity)?.cid).toBe(cid);
});
it('retries exact retirement after owner release before saga erasure without touching a sibling', async () => {
  storeTemporaryLaunch(role, 'owned-task-action');
  const service = await prepareManagedAgent(role, stateDir, true), cid = service.runtime.snapshot.cid!;
  await service.close(false);
  daemon.rows.set('PersonalAssistant', { name: 'PersonalAssistant', cid: 'permanent-cid', temporary: false });
  const sibling = structuredClone(daemon.rows.get('PersonalAssistant'));
  const expected = { cid, action: 'owned-task-action' };
  await releaseManagedAgent(role, expected); await releaseManagedAgent(role, expected);
  expect(daemon.releases).toBe(1); expect(daemon.rows.has(role.identity)).toBe(false);
  expect(daemon.rows.get('PersonalAssistant')).toEqual(sibling);
});
