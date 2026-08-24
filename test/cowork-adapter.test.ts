import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import {
  CoworkProtocolError,
  createCoworkAdapter,
  resolveCoworkSocketPath,
} from '../src/rooms-tasks/cowork-adapter.js';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
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
    mission: { goal: 'Ship', briefing: 'Cross-check everything', briefing_version: 1 },
    seats: [],
    ...overrides,
  };
}

async function rpcServer(
  handler: (request: Record<string, unknown>) => unknown,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'fleet-cowork-adapter-'));
  roots.push(root);
  const socketPath = join(root, 'management.sock');
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      try {
        socket.end(`${JSON.stringify({ version: 1, id: request.id, result: handler(request) })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({
          version: 1,
          id: request.id,
          error: { code: 'invalid_state', message: error instanceof Error ? error.message : String(error) },
        })}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return socketPath;
}

describe('Cowork management-socket adapter', () => {
  it('resolves Cowork v1 config and state-dir override', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-cowork-config-'));
    roots.push(root);
    const configPath = join(root, 'cowork.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      stateDir: join(root, 'from-config'),
      rest: { enabled: false, port: 3052 },
    }));
    expect(resolveCoworkSocketPath({ configPath })).toBe(join(root, 'from-config', 'management.sock'));
    expect(resolveCoworkSocketPath({
      configPath,
      env: { OURS_COWORK_STATE_DIR: join(root, 'from-env') },
    })).toBe(join(root, 'from-env', 'management.sock'));
  });

  it('creates a real Cowork room with the exact v1 RPC envelope', async () => {
    const socketPath = await rpcServer(request => {
      expect(request).toMatchObject({
        version: 1,
        method: 'room.create',
        params: {
          name: 'Release room',
          goal: 'Ship',
          briefing: 'Cross-check everything',
          quiet_membership: true,
        },
      });
      return room();
    });
    const adapter = createCoworkAdapter({ socketPath });
    await expect(adapter.createRoom({
      room_name: 'Release room',
      goal: 'Ship',
      briefing: 'Cross-check everything',
      quiet_membership: true,
    })).resolves.toEqual({
      room_id: '01ABCDEF0123456789ABCDEFGH',
      identity_name: 'ours-cowork-01ABCDEF0123456789ABCDEFGH',
      identity_cid: 'A'.repeat(64),
    });
  });

  it('accepts the Messenger owner invite through the Unix-only room.accept route', async () => {
    const socketPath = await rpcServer(request => {
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
    await expect(createCoworkAdapter({ socketPath }).acceptInvite(
      '01ABCDEF0123456789ABCDEFGH',
      'secret-public-invite',
      { role: 'Owner', expected_cid: 'B'.repeat(64) },
    )).resolves.toEqual({ seat_cid: 'B'.repeat(64), seat_state: 'pending' });
  });

  it('uses Cowork as source of truth for list, participants, recovery, and close', async () => {
    const methods: string[] = [];
    const socketPath = await rpcServer(request => {
      const method = String(request.method);
      methods.push(method);
      if (method === 'room.list') return [room({ state: 'active' })];
      if (method === 'room.participants') return [{ identity: 'C'.repeat(64), role: 'Developer', state: 'active' }];
      if (method === 'room.show') return room({
        state: 'active',
        role_briefings: {
          Reviewer: { text: 'Exact current charter', version: 4, updated_at: '2026-08-24T00:00:00Z' },
        },
      });
      if (method === 'room.close') return room({ state: 'closed' });
      throw new Error(`unexpected ${method}`);
    });
    const adapter = createCoworkAdapter({ socketPath });
    expect((await adapter.listRooms())[0]?.state).toBe('active');
    expect(await adapter.getSeats('01ABCDEF0123456789ABCDEFGH')).toEqual([
      { identity_cid: 'C'.repeat(64), role: 'Developer', seat_state: 'active' },
    ]);
    expect(await adapter.recoverRoom('01ABCDEF0123456789ABCDEFGH')).toMatchObject({
      state: 'active',
      role_briefings: {
        Reviewer: { text: 'Exact current charter', version: 4 },
      },
    });
    await adapter.closeRoom('01ABCDEF0123456789ABCDEFGH');
    expect(methods).toEqual(['room.list', 'room.participants', 'room.show', 'room.close']);
  });

  it('authors an exact role briefing and returns its durable version', async () => {
    const socketPath = await rpcServer(request => {
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
    await expect(createCoworkAdapter({ socketPath }).setRoleBriefing(
      '01ABCDEF0123456789ABCDEFGH',
      { role: 'Reviewer', text: 'Review the exact diff.' },
    )).resolves.toEqual({
      role: 'Reviewer', text: 'Review the exact diff.', version: 3,
      updated_at: '2026-08-24T00:00:00.000Z',
    });
  });

  it('projects only normalized room briefing, chat, and relay history evidence', async () => {
    const socketPath = await rpcServer(request => {
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
    await expect(createCoworkAdapter({ socketPath }).getHistory(
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
    const socketPath = await rpcServer(() => [
      {
        kind: 'membership_intent', seq: 40, record_id: 'room:40',
        at: '2026-08-24T00:00:00Z', action: 'remove',
      },
      {
        kind: 'file', seq: 41, record_id: 'room:41',
        at: '2026-08-24T00:00:01Z', file_id: 'file-1',
      },
    ]);
    await expect(createCoworkAdapter({ socketPath }).getHistory(
      '01ABCDEF0123456789ABCDEFGH', { after: 39, limit: 2 },
    )).resolves.toEqual({ records: [], raw_count: 2, next_after: 41 });
  });

  it('fails closed on malformed room history author provenance', async () => {
    const socketPath = await rpcServer(() => [{
      kind: 'message', seq: 1, record_id: 'room:1', at: 'now', message_id: 'm',
      category: 'chat', author: { display_name: 'forged', role: 'Owner' },
      text: '{}', recipient_identities: [],
    }]);
    await expect(createCoworkAdapter({ socketPath }).getHistory(
      '01ABCDEF0123456789ABCDEFGH',
    )).rejects.toThrow(/author.identity/);
  });

  it('fails closed on Cowork RPC errors', async () => {
    const socketPath = await rpcServer(() => { throw new Error('owner CID mismatch'); });
    await expect(createCoworkAdapter({ socketPath }).acceptInvite(
      '01ABCDEF0123456789ABCDEFGH',
      'invite',
      { role: 'Owner', expected_cid: 'D'.repeat(64) },
    )).rejects.toMatchObject<CoworkProtocolError>({ code: 'invalid_state' });
  });
});
