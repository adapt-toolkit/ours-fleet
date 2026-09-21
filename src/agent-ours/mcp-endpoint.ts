import { createServer, type Server } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createManagedOursMcpServer } from '@ours.network/mcp/server';
import type { ApplicationIdentityStore } from '@ours.network/mcp/application-identities';
import type { OursClient } from '@ours.network/sdk/client';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { FileCallbacks } from './file-rpc.js';
import { Wire } from './wire.js';
import type { AgentOursRuntime } from './runtime.js';

export interface EndpointOptions {
  socket: string;
  capability: string;
  generation: number;
  runtime: AgentOursRuntime;
  client: OursClient;
  identities: ApplicationIdentityStore;
  remoteDaemonFiles: boolean;
}
export async function startMcpEndpoint(
  options: EndpointOptions,
): Promise<{ close(): Promise<void> }> {
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
    const mcp = createManagedOursMcpServer(options.client, 'managed-v1', options.identities, {
      remoteDaemonFiles: options.remoteDaemonFiles,
      fileContext: files,
      admit: async () => {
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
      },
    });
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
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
