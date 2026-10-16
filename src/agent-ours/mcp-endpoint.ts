import * as managedMcp from '@ours.network/mcp/server';
import type { FileDeliveryInput, DeliveredFile } from '../file-delivery/types.js';
import type { ToolRequestExtra } from '@ours.network/mcp/dist/types/mcp/tool.js';
import { connect, createServer, type Server } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createManagedOursMcpServer } from '@ours.network/mcp/server';
import type { ApplicationIdentityStore } from '@ours.network/mcp/application-identities';
import type { OursClient } from '@ours.network/sdk/client';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { FileCallbacks } from './file-rpc.js';
import { Wire } from './wire.js';
import type { AgentOursRuntime } from './runtime.js';
import { registerReminderTools, type ReminderToolBackend } from '../reminders/tools.js';

export interface EndpointOptions {
  socket: string;
  capability: string;
  generation: number;
  runtime: AgentOursRuntime;
  client: OursClient;
  identities: ApplicationIdentityStore;
  remoteDaemonFiles: boolean;
  currentChatFile?: (input: FileDeliveryInput, extra: ToolRequestExtra, files: FileCallbacks) => Promise<DeliveredFile>;
  /** Fleet self-reminders, bound later by the runner; tools refuse until then. */
  reminders?: () => ReminderToolBackend | undefined;
}
const ORPHAN_PROBE_TIMEOUT_MS = 1_000;

function listenOnce(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/**
 * Identity of one file: device, inode and nanosecond change and birth times.
 * An inode number alone is reused at once after an unlink, so a socket bound
 * in its place can carry the same device and inode.
 */
type SocketIdentity = { dev: bigint; ino: bigint; ctimeNs: bigint; birthtimeNs: bigint };
const sameFile = (a: SocketIdentity, b: SocketIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;

/**
 * The identity of a socket file, never a symlink or other file, that refuses
 * connections; undefined when it is not provably dead.
 */
async function orphanSocket(path: string): Promise<SocketIdentity | undefined> {
  let found;
  try { found = await lstat(path, { bigint: true }); } catch { return undefined; }
  if (!found.isSocket()) return undefined;
  const dead = await new Promise<boolean>(resolve => {
    const probe = connect(path);
    const done = (orphan: boolean) => { clearTimeout(timer); probe.destroy(); resolve(orphan); };
    const timer = setTimeout(() => done(false), ORPHAN_PROBE_TIMEOUT_MS);
    probe.once('connect', () => done(false));
    probe.once('error', error => done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
  return dead ? { dev: found.dev, ino: found.ino, ctimeNs: found.ctimeNs, birthtimeNs: found.birthtimeNs } : undefined;
}

/**
 * Listen on the bridge socket. A close unlinks it, but a predecessor that ended
 * abruptly leaves the file behind, and every later start of the same generation
 * then fails with EADDRINUSE until the role is held down. Only a provably dead
 * socket is removed, once, and only if the path still names that same file;
 * a live listener, a symlink, any other file, an inconclusive probe or a path
 * replaced since the probe still fails as before. `afterProbe` is a test seam.
 */
export async function listenOnBridgeSocket(
  server: Server, path: string, hooks: { afterProbe?: () => Promise<void> } = {},
): Promise<void> {
  let original: unknown;
  try { return await listenOnce(server, path); }
  catch (error) {
    original = error;
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }
  const orphan = await orphanSocket(path);
  if (!orphan) throw original;
  await hooks.afterProbe?.();
  let now;
  try { now = await lstat(path, { bigint: true }); } catch { throw original; }
  if (!now.isSocket() || !sameFile(now, orphan)) throw original;
  await unlink(path);
  await listenOnce(server, path);
}

export async function startMcpEndpoint(
  options: EndpointOptions,
): Promise<{ close(): Promise<void> }> {
  // Every managed Agent offers current-chat delivery, so a package without the contract is a broken install, not a quiet downgrade.
  if (options.currentChatFile && (managedMcp as typeof managedMcp & { MANAGED_FILE_DELIVERY_VERSION?: number }).MANAGED_FILE_DELIVERY_VERSION !== 1)
    throw Error('INCOMPATIBLE_MANAGED_FILE_DELIVERY: installed @ours.network/mcp lacks MANAGED_FILE_DELIVERY_VERSION 1; reinstall Fleet with its pinned @ours.network/mcp');
  const sockets = new Set<Wire>();
  const server: Server = createServer((socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    const wire = new Wire(socket);
    sockets.add(wire);
    const files = new FileCallbacks(wire);
    let authenticated = false;
    let inFlight = 0;
    const ids = new Set<string | number>();
    const deadline = setTimeout(() => wire.close(), 5000);
    deadline.unref();
    const transport: Transport = {
      start: async () => {},
      send: async (message: JSONRPCMessage) => {
        if (
          'id' in message &&
          message.id !== undefined &&
          ('result' in message || 'error' in message)
        )
          ids.delete(message.id);
        await wire.send({ kind: 'mcp', value: message });
      },
      close: async () => wire.close(),
    };
    // One admission path for every tool on this connection: the same
    // authentication, in-flight bound and managed-runtime fence.
    const admit = async () => {
      if (!authenticated || inFlight >= 32) throw Error('MCP_ADMISSION_LIMIT');
      inFlight++;
      try {
        const release = await options.runtime.admit();
        return () => {
          inFlight--;
          release();
        };
      } catch (error) {
        inFlight--;
        throw error;
      }
    };
    const mcp = createManagedOursMcpServer(options.client, 'managed-v1', options.identities, {
      remoteDaemonFiles: options.remoteDaemonFiles,
      ...(options.currentChatFile ? { currentChatFile: (input: FileDeliveryInput, extra: ToolRequestExtra) => options.currentChatFile!(input, extra, files) } : {}),
      fileContext: files,
      admit,
    });
    if (options.reminders) registerReminderTools(mcp, options.reminders, admit);
    wire.onClose = () => {
      clearTimeout(deadline);
      sockets.delete(wire);
      files.close();
      transport.onclose?.();
    };
    wire.onFrame = (frame: any) => {
      if (!authenticated) {
        const actual =
          typeof frame?.capability === 'string' ? Buffer.from(frame.capability) : Buffer.alloc(0);
        const expected = Buffer.from(options.capability);
        if (
          frame?.kind !== 'hello' ||
          frame.generation !== options.generation ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        )
          throw Error('UNAUTHORIZED_BRIDGE');
        authenticated = true;
        clearTimeout(deadline);
        void mcp
          .connect(transport)
          .then(() => wire.send({ kind: 'ready' }))
          .catch(() => wire.close());
        return;
      }
      if (frame?.kind === 'fs-result') {
        files.receive(frame);
        return;
      }
      if (frame?.kind !== 'mcp') throw Error('UNKNOWN_BRIDGE_OPERATION');
      const message = JSONRPCMessageSchema.parse(frame.value);
      if ('method' in message && 'id' in message) {
        if (ids.has(message.id) || ids.size >= 64) throw Error('MCP_REQUEST_LIMIT');
        ids.add(message.id);
      }
      transport.onmessage?.(message);
    };
  });
  await listenOnBridgeSocket(server, options.socket);
  await chmod(options.socket, 0o600);
  return {
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await unlink(options.socket).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}
