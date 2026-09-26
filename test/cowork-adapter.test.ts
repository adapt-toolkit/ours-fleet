import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import {
  CoworkProtocolError,
  createCoworkAdapter,
} from '../src/rooms-tasks/cowork-adapter.js';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function room(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    room_id: '01ABCDEF0123456789ABCDEFGH',
    room_name: 'Release room',
    identity_name: 'ours-cowork-01ABCDEF0123456789ABCDEFGH',
    identity_cid: 'A'.repeat(64),
    state: 'provisioning',
    anonymous: false,
    mission: { goal: 'Ship', briefing: 'Cross-check everything', briefing_version: 1 },
    seats: [],
    ...overrides,
  };
}

async function rpcServer(handler: (request: Record<string, unknown>) => unknown): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'fleet-cowork-adapter-'));
  roots.push(root);
  const instanceId = '11111111-2222-3333-4444-555555555555';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/prefix/daemon/selection') {
      res.end(JSON.stringify({ schema: 1, instanceId, capabilities: ['external-sessions-v1'] })); return;
    }
    expect(req.url).toBe('/prefix/cowork/management/rpc');
    expect(req.headers['x-ours-api-token']).toBe('fixture-token');
    let input = '';
    req.on('data', chunk => { input += chunk; });
    req.on('end', () => {
      const request = JSON.parse(input);
      try { res.end(JSON.stringify({ version: 1, id: request.id, result: handler(request) })); }
      catch (error) { res.end(JSON.stringify({ version: 1, id: request.id, error: { code: 'invalid_state', message: String(error) } })); }
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/prefix/`;
  const configPath = join(root, 'profile.json'), credentialPath = join(root, 'credential');
  writeFileSync(credentialPath, 'fixture-token', { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ serverUrl, expectedInstanceId: instanceId, credentialPath }), { mode: 0o600 });
  return configPath;
}

describe('Cowork gateway adapter', () => {
  it('creates a real Cowork room with the exact v1 RPC envelope', async () => {
    const profilePath = await rpcServer(request => {
      expect(request).toMatchObject({
        version: 1,
        method: 'room.create',
        params: {
          name: 'Release room',
          goal: 'Ship',
          briefing: 'Cross-check everything',
          quiet_membership: true,
          activation_requirements: [{ role: 'Developer', count: 2 }],
        },
      });
      return room();
    });
    const adapter = createCoworkAdapter({ env: { OURS_CONFIG: profilePath } });
    await expect(adapter.createRoom({
      room_name: 'Release room',
      goal: 'Ship',
      briefing: 'Cross-check everything',
      quiet_membership: true,
          activation_requirements: [{ role: 'Developer', count: 2 }],
    })).resolves.toEqual({
      room_id: '01ABCDEF0123456789ABCDEFGH',
      identity_name: 'ours-cowork-01ABCDEF0123456789ABCDEFGH',
      identity_cid: 'A'.repeat(64),
    });
  });

  it('accepts the Messenger owner invite through the gateway room.accept route', async () => {
    const profilePath = await rpcServer(request => {
      expect(request).toMatchObject({
        method: 'room.accept',
        params: {
          room_id: '01ABCDEF0123456789ABCDEFGH',
          role: 'Owner',
          invite: 'secret-public-invite',
          expected_cid: 'B'.repeat(64),
        },
      });
      return { identity: 'B'.repeat(64), state: 'pending' };
    });
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).acceptInvite(
      '01ABCDEF0123456789ABCDEFGH',
      'secret-public-invite',
      { role: 'Owner', expected_cid: 'B'.repeat(64) },
    )).resolves.toEqual({ seat_cid: 'B'.repeat(64), seat_state: 'pending' });
  });

  it.each([['Owner', ['*']], ['Reviewer', ['list-members', 'remove-member']]] as const)(
    'sets the exact durable %s command policy through Cowork', async (role, commands) => {
    const profilePath = await rpcServer(request => {
      expect(request).toMatchObject({
        method: 'room.command.role.set',
        params: {
          room_id: '01ABCDEF0123456789ABCDEFGH', role,
          commands: [...commands],
        },
      });
      return [{ role, commands: [...commands] }];
    });
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).setRoleCommands(
      '01ABCDEF0123456789ABCDEFGH',
      { role, commands: [...commands] },
    )).resolves.toBeUndefined();
  });

  it('returns Cowork invite IDs and revokes through the existing room.revoke route', async () => {
    const methods: string[] = [];
    const profilePath = await rpcServer(request => {
      methods.push(String(request.method));
      if (request.method === 'room.invite') {
        expect(request.params).toEqual({
          room_id: '01ABCDEF0123456789ABCDEFGH', mode: 'one_time',
          role: 'Developer', min_accepts: 1,
        });
        return {
          blob: 'secret-role-invite',
          invite: { invite_id: 'invite-existing-contract', min_accepts: 1 },
        };
      }
      if (request.method === 'room.revoke') {
        expect(request.params).toEqual({
          room_id: '01ABCDEF0123456789ABCDEFGH',
          invite_id: 'invite-existing-contract',
        });
        return { invite_id: 'invite-existing-contract', state: 'revoked' };
      }
      throw new Error(`unexpected ${String(request.method)}`);
    });
    const adapter = createCoworkAdapter({ env: { OURS_CONFIG: profilePath } });

    await expect(adapter.issueInvite('01ABCDEF0123456789ABCDEFGH', {
      mode: 'one_time', role: 'Developer', min_accepts: 1,
    })).resolves.toEqual({
      invite: 'secret-role-invite', invite_id: 'invite-existing-contract', min_accepts: 1,
    });
    await expect(adapter.revokeInvite(
      '01ABCDEF0123456789ABCDEFGH', 'invite-existing-contract',
    )).resolves.toBeUndefined();
    expect(methods).toEqual(['room.invite', 'room.revoke']);
  });

  it('uses Cowork as source of truth for list, participants, recovery, close, and delete', async () => {
    const methods: string[] = [];
    const profilePath = await rpcServer(request => {
      const method = String(request.method);
      methods.push(method);
      if (method === 'room.list') return [room({ state: 'active' })];
      if (method === 'room.participants') return [{
        identity: 'C'.repeat(64), display_name: 'developer-1',
        invite_id: 'invite-1', role: 'Developer', state: 'active',
      }];
      if (method === 'room.show') return room({
        state: 'active',
        role_briefings: {
          Reviewer: { text: 'Exact current charter', version: 4, updated_at: '2026-08-24T00:00:00Z' },
        },
      });
      if (method === 'room.close') return room({ state: 'closed' });
      if (method === 'room.delete') {
        expect(request.params).toEqual({
          room_id: '01ABCDEF0123456789ABCDEFGH', confirm: true,
        });
        return { version: 1, room_id: '01ABCDEF0123456789ABCDEFGH', deleted: true };
      }
      throw new Error(`unexpected ${method}`);
    });
    const adapter = createCoworkAdapter({ env: { OURS_CONFIG: profilePath } });
    expect((await adapter.listRooms())[0]?.state).toBe('active');
    expect(await adapter.getSeats('01ABCDEF0123456789ABCDEFGH')).toEqual([
      {
        identity_cid: 'C'.repeat(64), display_name: 'developer-1',
        invite_id: 'invite-1', role: 'Developer', seat_state: 'active',
      },
    ]);
    expect(await adapter.recoverRoom('01ABCDEF0123456789ABCDEFGH')).toMatchObject({
      state: 'active',
      role_briefings: {
        Reviewer: { text: 'Exact current charter', version: 4 },
      },
    });
    await adapter.closeRoom('01ABCDEF0123456789ABCDEFGH');
    await adapter.deleteRoom('01ABCDEF0123456789ABCDEFGH');
    expect(methods).toEqual([
      'room.list', 'room.participants', 'room.show', 'room.close', 'room.delete',
    ]);
  });

  it('authors an exact role briefing and returns its durable version', async () => {
    const profilePath = await rpcServer(request => {
      expect(request).toMatchObject({
        method: 'room.briefing.role.set',
        params: {
          room_id: '01ABCDEF0123456789ABCDEFGH',
          role: 'Reviewer',
          text: 'Review the exact diff.',
        },
      });
      return room({
        role_briefings: {
          Reviewer: {
            text: 'Review the exact diff.', version: 3,
            updated_at: '2026-08-24T00:00:00.000Z',
          },
        },
      });
    });
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).setRoleBriefing(
      '01ABCDEF0123456789ABCDEFGH',
      { role: 'Reviewer', text: 'Review the exact diff.' },
    )).resolves.toEqual({
      role: 'Reviewer', text: 'Review the exact diff.', version: 3,
      updated_at: '2026-08-24T00:00:00.000Z',
    });
  });

  it('projects only normalized room briefing, chat, and relay history evidence', async () => {
    const profilePath = await rpcServer(request => {
      expect(request).toMatchObject({
        method: 'room.history',
        params: {
          room_id: '01ABCDEF0123456789ABCDEFGH', after: 12, limit: 50, view: 'operator',
        },
      });
      return [{
        kind: 'message', seq: 13, record_id: 'room:13', at: '2026-08-24T00:00:00Z',
        message_id: 'message-1', category: 'role_briefing',
        author: { identity: 'A'.repeat(64), display_name: 'Room', role: 'room' },
        text: 'Role charter', recipient_identities: ['B'.repeat(64)],
        briefing_role: 'Reviewer', briefing_version: 2,
      }, {
        kind: 'relay_intent', seq: 14, record_id: 'room:14', at: '2026-08-24T00:00:01Z',
        message_id: 'message-1', recipient_identity: 'B'.repeat(64),
      }, {
        kind: 'relay_result', seq: 15, record_id: 'room:15', at: '2026-08-24T00:00:02Z',
        intent_record_id: 'room:14', message_id: 'message-1',
        recipient_identity: 'B'.repeat(64), status: 'queued', wire_id: 'wire-1',
      }, {
        kind: 'file', seq: 16, record_id: 'room:16', at: '2026-08-24T00:00:03Z',
      }];
    });
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).getHistory(
      '01ABCDEF0123456789ABCDEFGH', { after: 12, limit: 50 },
    )).resolves.toEqual({
      raw_count: 4,
      next_after: 16,
      records: [
        expect.objectContaining({ kind: 'message', message_id: 'message-1', briefing_version: 2 }),
        expect.objectContaining({ kind: 'relay_intent', record_id: 'room:14' }),
        expect.objectContaining({ kind: 'relay_result', status: 'queued', wire_id: 'wire-1' }),
      ],
    });
  });

  it('preserves raw pagination progress when every record is filtered out', async () => {
    const profilePath = await rpcServer(() => [
      {
        kind: 'membership_intent', seq: 40, record_id: 'room:40',
        at: '2026-08-24T00:00:00Z', action: 'remove',
      },
      {
        kind: 'file', seq: 41, record_id: 'room:41',
        at: '2026-08-24T00:00:01Z', file_id: 'file-1',
      },
    ]);
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).getHistory(
      '01ABCDEF0123456789ABCDEFGH', { after: 39, limit: 2 },
    )).resolves.toEqual({ records: [], raw_count: 2, next_after: 41 });
  });

  it('fails closed on malformed room history author provenance', async () => {
    const profilePath = await rpcServer(() => [{
      kind: 'message', seq: 1, record_id: 'room:1', at: 'now', message_id: 'm',
      category: 'chat', author: { display_name: 'forged', role: 'Owner' },
      text: '{}', recipient_identities: [],
    }]);
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).getHistory(
      '01ABCDEF0123456789ABCDEFGH',
    )).rejects.toThrow(/author.identity/);
  });

  it('fails closed on Cowork RPC errors', async () => {
    const profilePath = await rpcServer(() => { throw new Error('owner CID mismatch'); });
    await expect(createCoworkAdapter({ env: { OURS_CONFIG: profilePath } }).acceptInvite(
      '01ABCDEF0123456789ABCDEFGH',
      'invite',
      { role: 'Owner', expected_cid: 'D'.repeat(64) },
    )).rejects.toMatchObject<CoworkProtocolError>({ code: 'invalid_state' });
  });
});
