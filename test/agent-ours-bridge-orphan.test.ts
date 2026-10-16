// Incident 2026-10-16: an installer-driven supervisor restart started every
// permanent role at once; roles whose bridge generation matched a socket file
// left by an abrupt exit days earlier failed `listen EADDRINUSE` on every
// attempt until held down. Only a provably dead socket may be reclaimed.
import { it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpEndpoint, listenOnBridgeSocket } from '../src/agent-ours/mcp-endpoint.js';
import type { OursClient } from '@ours.network/sdk/client';
import type { ApplicationIdentityStore } from '@ours.network/mcp/application-identities';
import type { AgentOursRuntime } from '../src/agent-ours/runtime.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'fleet-bridge-orphan-'));
  roots.push(root);
  return root;
}
const endpoint = (socket: string) => startMcpEndpoint({
  socket, capability: 'orphan-capability', generation: 1,
  runtime: { admit: async () => () => {} } as unknown as AgentOursRuntime,
  client: {} as OursClient,
  identities: { list: async () => ['Agent'] } as ApplicationIdentityStore,
  remoteDaemonFiles: true,
});
/** A real socket inode left by a listener killed without cleanup. */
async function orphan(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e',
    `require('net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('up'))`]);
  await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  expect(lstatSync(path).isSocket()).toBe(true);
}
async function live(path: string): Promise<Server> {
  const server = createServer(socket => { socket.on('error', () => {}); socket.end(); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(path, resolve));
  return server;
}
const reaches = (path: string) => new Promise<boolean>(resolve => {
  const socket = connect(path);
  socket.on('error', () => resolve(false));
  socket.once('connect', () => { socket.destroy(); resolve(true); });
});

it('reclaims a socket left by an abruptly ended predecessor and serves on it', async () => {
  const socket = join(dir(), 'g1.sock');
  await orphan(socket);
  const started = await endpoint(socket);
  try {
    expect(await reaches(socket)).toBe(true);
    expect(lstatSync(socket).mode & 0o777).toBe(0o600);
  } finally { await started.close(); }
  expect(existsSync(socket)).toBe(false);
});

it('never takes over a live listener', async () => {
  const socket = join(dir(), 'g1.sock');
  await live(socket);
  await expect(endpoint(socket)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(await reaches(socket)).toBe(true);
});

it('leaves a regular file and a symlink to a dead socket untouched', async () => {
  const root = dir();
  const file = join(root, 'g1.sock');
  writeFileSync(file, 'not a socket');
  await expect(endpoint(file)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(readFileSync(file, 'utf8')).toBe('not a socket');

  const target = join(root, 'elsewhere.sock');
  await orphan(target);
  const link = join(root, 'g2.sock');
  symlinkSync(target, link);
  await expect(endpoint(link)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(lstatSync(target).isSocket()).toBe(true);
});

// The replacement often reuses the orphan's inode number at once (seen on CI's
// ext4), so identity must not rest on device and inode alone. Repeat to meet it.
it('keeps a path replaced by a live listener between the probe and the cleanup', async () => {
  for (let round = 0; round < 20; round++) {
    const socket = join(dir(), 'g1.sock');
    await orphan(socket);
    const server = createServer();
    let replacement: Server | undefined;
    await expect(listenOnBridgeSocket(server, socket, { afterProbe: async () => {
      unlinkSync(socket);
      replacement = await live(socket);
    } })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(server.listening).toBe(false);
    expect(replacement?.listening).toBe(true);
    expect(await reaches(socket)).toBe(true);
  }
});
