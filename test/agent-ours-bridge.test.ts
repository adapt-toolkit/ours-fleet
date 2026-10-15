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

it('serves self-reminder tools on the fixed-identity bridge, scoped to the bound agent only', async () => {
  const { ReminderStore } = await import('../src/reminders/store.js');
  const root = mkdtempSync(join(tmpdir(), 'fleet-mcp-reminders-'));
  let backend: import('../src/reminders/tools.js').ReminderToolBackend | undefined;
  let admits = 0, released = 0, fenced = false;
  const endpoint = await startMcpEndpoint({
    socket: join(root, 'm.sock'), capability: 'reminder-capability', generation: 1,
    runtime: { admit: async () => {
      if (fenced) throw Error('RUNTIME_NOT_READY');
      admits++;
      return () => { released++; };
    } } as unknown as AgentOursRuntime,
    client: {} as OursClient,
    identities: { list: async () => ['Agent'] } as ApplicationIdentityStore,
    remoteDaemonFiles: true,
    reminders: () => backend,
  });
  const descriptor = join(root, 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ socket: join(root, 'm.sock'), capability: 'reminder-capability', generation: 1 }));
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [resolve('dist/agent-ours/bridge.js')], cwd: root,
      env: { FLEET_OURS_BRIDGE_DESCRIPTOR: descriptor }, stderr: 'pipe',
    }));
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(27 + 6);
    const create = { request_key: 'k', title: 'T', local_time: '2099-01-20T16:00', time_zone: 'UTC' };
    const unbound = await client.callTool({ name: 'fleet_reminder_create', arguments: create }) as any;
    expect(unbound.isError).toBe(true);
    expect(JSON.parse(unbound.content[0].text).error).toBe('reminders_unavailable');
    let changed = 0;
    backend = {
      store: new ReminderStore(root, { role: 'Agent', instance: 'i', cid: 'E'.repeat(64), action: 'a' }, () => Date.parse('2027-01-01T00:00:00Z')),
      changed: () => { changed++; },
    };
    const created = await client.callTool({ name: 'fleet_reminder_create', arguments: { ...create, local_time: '2027-01-20T16:00' } }) as any;
    expect(created.isError).toBe(false);
    expect(created.structuredContent.reminder.due_at).toBe('2027-01-20T16:00:00.000Z');
    expect(changed).toBe(1);
    // An argument naming another agent is not part of the contract and changes nothing.
    const listed = await client.callTool({ name: 'fleet_reminder_list', arguments: { agent: 'Other' } as any }) as any;
    expect(listed.structuredContent.reminders).toHaveLength(1);
    const invalid = await client.callTool({ name: 'fleet_reminder_cancel', arguments: { id: 'rem_x', expected_revision: 1 } }) as any;
    expect(JSON.parse(invalid.content[0].text).error).toBe('not_found');
    expect(admits).toBe(4);
    expect(released).toBe(4);
    // The managed runtime fence refuses: nothing is read or changed.
    fenced = true;
    for (const [name, args] of [
      ['fleet_reminder_create', { ...create, request_key: 'fenced', local_time: '2027-01-21T16:00' }],
      ['fleet_reminder_list', {}],
      ['fleet_reminder_cancel', { id: created.structuredContent.reminder.id, expected_revision: 1 }],
    ] as const) {
      const refused = await client.callTool({ name, arguments: args as any }) as any;
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0].text).error).toBe('runtime_not_ready');
    }
    fenced = false;
    expect(backend.store.list().reminders.map((item: any) => [item.revision, item.state])).toEqual([[1, 'active']]);
    expect(changed).toBe(1);
  } finally {
    await client.close();
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
