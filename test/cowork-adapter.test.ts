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
      if (method === 'room.show') return room({ state: 'active' });
      if (method === 'room.close') return room({ state: 'closed' });
      throw new Error(`unexpected ${method}`);
    });
    const adapter = createCoworkAdapter({ socketPath });
    expect((await adapter.listRooms())[0]?.state).toBe('active');
    expect(await adapter.getSeats('01ABCDEF0123456789ABCDEFGH')).toEqual([
      { identity_cid: 'C'.repeat(64), role: 'Developer', seat_state: 'active' },
    ]);
    expect((await adapter.recoverRoom('01ABCDEF0123456789ABCDEFGH')).state).toBe('active');
    await adapter.closeRoom('01ABCDEF0123456789ABCDEFGH');
    expect(methods).toEqual(['room.list', 'room.participants', 'room.show', 'room.close']);
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
