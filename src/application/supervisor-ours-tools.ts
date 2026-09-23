import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentDir } from '../paths.js';
import { ROLE_NAME_RE } from '../config.js';
import { FleetError } from './errors.js';

export interface SupervisorToolRequest {
  tool: string;
  arguments?: Record<string, unknown>;
}

/** CLI and REST use the same fixed-identity MCP server as the agent harness. */
export class SupervisorOursTools {
  private async withClient<T>(role: string, work: (client: Client, identity: {
    name: string; cid: string; generation: number;
  }) => Promise<T>): Promise<T> {
    if (!ROLE_NAME_RE.test(role)) throw new FleetError('invalid_request', 'invalid agent name');
    const candidates = [agentDir(role), agentDir(role, true)]
      .map(dir => ({ dir, path: join(dir, '.ours-bridge', 'descriptor.json') }))
      .filter(row => existsSync(row.path));
    if (candidates.length !== 1)
      throw new FleetError('capability_unavailable', 'agent supervisor endpoint is missing or ambiguous');
    const selected = candidates[0];
    let descriptor: Record<string, any>;
    let identityName: string;
    try {
      descriptor = JSON.parse(readFileSync(selected.path, 'utf8'));
      identityName = readFileSync(join(selected.dir, '.identity'), 'utf8').trim();
      if (!descriptor || typeof descriptor !== 'object') throw new Error();
    } catch {
      throw new FleetError('capability_unavailable', 'supervisor identity metadata cannot be read');
    }
    if (descriptor.role !== role || descriptor.identity !== identityName
        || !/^[a-f0-9]{64}$/i.test(descriptor.cid ?? '') || !Number.isInteger(descriptor.generation))
      throw new FleetError('capability_unavailable', 'supervisor identity metadata is unavailable or mismatched');
    const client = new Client({ name: 'ours-fleet-supervisor-tools', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../agent-ours/bridge.js', import.meta.url))],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        FLEET_OURS_BRIDGE_DESCRIPTOR: selected.path,
        FLEET_OURS_BRIDGE_EXPECTED: JSON.stringify({ role, identity: identityName, cid: descriptor.cid, generation: descriptor.generation }) },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      return await work(client, { name: identityName, cid: descriptor.cid, generation: descriptor.generation });
    } catch (error) {
      if (error instanceof FleetError) throw error;
      // Do not leak arguments, invites, capabilities, or raw transport errors.
      throw new FleetError('control_unavailable',
        'supervisor tool request failed; its outcome may be unknown, do not retry a mutation automatically', { retryable: false });
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  list(role: string) {
    return this.withClient(role, async (client, identity) => ({
      agent: role, identity, ...(await client.listTools()),
    }));
  }

  call(role: string, request: SupervisorToolRequest) {
    if (!request || typeof request.tool !== 'string'
        || (request.arguments !== undefined && (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments))))
      throw new FleetError('invalid_request', 'tool and object arguments are required');
    return this.withClient(role, async (client, identity) => {
      const { tools } = await client.listTools();
      if (!tools.some(tool => tool.name === request.tool))
        throw new FleetError('forbidden', 'tool is not exposed by the fixed-identity supervisor');
      const result = await client.callTool({ name: request.tool, arguments: request.arguments ?? {} });
      return { agent: role, identity, result };
    });
  }
}
