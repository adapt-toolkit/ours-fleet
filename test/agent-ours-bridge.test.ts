import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMcpEndpoint } from '../src/agent-ours/mcp-endpoint.js';
import type { OursClient } from '@ours.network/sdk/client';
import type { ApplicationIdentityStore } from '@ours.network/mcp/application-identities';
import type { AgentOursRuntime } from '../src/agent-ours/runtime.js';

it('real stdio bridge preserves MCP discovery and streams files in bridge cwd; EOF retains owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-mcp-bridge-'));
  let releases = 0;
  const calls: any[] = [];
  const payload = Buffer.alloc(200_000, 65);
  writeFileSync(join(root, 'input.bin'), payload);
  const sdk = {
    uploadFile: async (body: ReadableStream<Uint8Array>, meta: any) => {
      expect(Buffer.from(await new Response(body).arrayBuffer())).toEqual(payload);
      calls.push(meta);
      return { upload_id: 'scoped' };
    },
    sendFile: async (args: any) => {
      expect(args.path).toBeUndefined();
      expect(args.upload_id).toBe('scoped');
      return { kind: 'e2e', filename: 'input.bin', bytes: payload.length, wireId: 'ABC' };
    },
    openFile: async () => new Blob([payload]).stream(),
    releaseLease: async () => {
      releases++;
    },
  } as unknown as OursClient;
  const endpoint = await startMcpEndpoint({
    socket: join(root, 'm.sock'),
    capability: 'test-capability',
    generation: 1,
    runtime: { admit: async () => () => {} } as unknown as AgentOursRuntime,
    client: sdk,
    identities: { list: async () => ['Agent'] } as ApplicationIdentityStore,
    remoteDaemonFiles: true,
  });
  const descriptor = join(root, 'descriptor.json');
  writeFileSync(
    descriptor,
    JSON.stringify({ socket: join(root, 'm.sock'), capability: 'test-capability', generation: 1 }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/agent-ours/bridge.js')],
    cwd: root,
    env: { FLEET_OURS_BRIDGE_DESCRIPTOR: descriptor },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(27);
    const sent = await client.callTool({
      name: 'send_file',
      arguments: { contact: 'Peer', path: 'input.bin' },
    });
    expect(sent.isError).toBe(false);
    expect(calls[0].filename).toBe('input.bin');
    const saved = await client.callTool({
      name: 'save_file',
      arguments: { wire_id: 'ABC', dest_path: 'out/result.bin' },
    });
    expect(saved.isError).toBe(false);
    expect(readFileSync(join(root, 'out/result.bin'))).toEqual(payload);
    await client.close();
    expect(releases).toBe(0);
  } finally {
    await client.close();
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it.each(['socket', 'capability'])('refuses descriptor %s replacement at the same generation before connecting', async field => {
  const { createHash } = await import('node:crypto');
  const root = mkdtempSync(join(tmpdir(), 'fleet-bridge-selection-'));
  const original = { socket: join(root, 'old.sock'), capability: 'PRIVATE_CAPABILITY_A', generation: 1 };
  const descriptor = join(root, 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ ...original,
    [field]: field === 'socket' ? join(root, 'other.sock') : 'PRIVATE_CAPABILITY_B' }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/agent-ours/bridge.js')], stderr: 'pipe',
    env: { FLEET_OURS_BRIDGE_DESCRIPTOR: descriptor, FLEET_OURS_BRIDGE_EXPECTED: JSON.stringify({
      generation: 1,
      transportDigest: createHash('sha256').update(JSON.stringify([original.socket, original.capability, 1])).digest('hex'),
    }) },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'selection-test', version: '1' });
  try {
    await expect(client.connect(transport)).rejects.toThrow();
    expect(stderr).not.toContain('PRIVATE_CAPABILITY');
    expect(stderr).not.toContain(root);
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});
