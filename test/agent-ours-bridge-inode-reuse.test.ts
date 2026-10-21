// A filesystem may hand the inode number of an unlinked orphan straight to the
// socket bound in its place (CI run 38902196973). Model that deterministically:
// lstat reports the orphan's device and inode for the live replacement, which
// keeps its own real timestamps and type. Cleanup must still leave it alone.
import { it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const recycle = vi.hoisted(() => ({ path: '', orphan: undefined as { dev: bigint; ino: bigint } | undefined, active: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (async (path: Parameters<typeof real.lstat>[0], options?: Parameters<typeof real.lstat>[1]) => {
      const actual = await real.lstat(path, options as never);
      if (path !== recycle.path || !options || !(options as { bigint?: boolean }).bigint) return actual;
      const stats = actual as import('node:fs').BigIntStats;
      if (!recycle.active) { recycle.orphan ??= { dev: stats.dev, ino: stats.ino }; return actual; }
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, recycle.orphan);
    }) as typeof real.lstat,
  };
});
const { listenOnBridgeSocket } = await import('../src/agent-ours/mcp-endpoint.js');

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  Object.assign(recycle, { path: '', orphan: undefined, active: false });
});

it('leaves a live replacement alone even when it reuses the orphan device and inode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-bridge-reuse-'));
  roots.push(root);
  const socket = join(root, 'g1.sock');
  recycle.path = socket;
  const child = spawn(process.execPath, ['-e',
    `require('net').createServer().listen(${JSON.stringify(socket)}, () => process.stdout.write('up'))`]);
  await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));

  const server = createServer();
  servers.push(server);
  const replacement = createServer(peer => { peer.on('error', () => {}); peer.end(); });
  servers.push(replacement);
  await expect(listenOnBridgeSocket(server, socket, { afterProbe: async () => {
    unlinkSync(socket);
    await new Promise<void>(resolve => replacement.listen(socket, resolve));
    recycle.active = true;
  } })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(recycle.orphan).toBeDefined();
  expect(server.listening).toBe(false);
  expect(replacement.listening).toBe(true);
});
