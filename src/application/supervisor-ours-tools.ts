import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentDir } from '../paths.js';
import { ROLE_NAME_RE } from '../config.js';
import { legacySupervisorIdentity } from './legacy-supervisor-identity.js';
import { FleetError } from './errors.js';

export interface SupervisorToolRequest {
  tool: string;
  arguments?: Record<string, unknown>;
}

/** CLI and REST use the same fixed-identity MCP server as the agent harness. */
export class SupervisorOursTools {
  private async withClient<T>(role: string, work: (client: Client, identity: {
    name: string; cid: string; generation: number;
  }, verify: () => Promise<void>) => Promise<T>): Promise<T> {
    if (!ROLE_NAME_RE.test(role)) throw new FleetError('invalid_request', 'invalid agent name');
    const findCandidates = () => [false, true].map(temporary => ({ temporary, dir: agentDir(role, temporary) }))
      .map(row => ({ ...row, path: join(row.dir, '.ours-bridge', 'descriptor.json') }))
      .filter(row => existsSync(row.path));
    const candidates = findCandidates();
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
    const legacy = ['role', 'identity', 'cid'].every(key => descriptor[key] === undefined);
    const identity = legacy
      ? legacySupervisorIdentity(role, identityName, selected.temporary, descriptor.generation)
      : { name: identityName, cid: descriptor.cid as string, generation: descriptor.generation as number };
    if (legacy && descriptor.socket !== join(selected.dir, '.ours-bridge', `g${descriptor.generation}.sock`))
      throw new FleetError('capability_unavailable', 'legacy supervisor socket does not match the selected agent');
    if ((!legacy && (descriptor.role !== role || descriptor.identity !== identityName))
        || !/^[a-f0-9]{64}$/i.test(identity.cid ?? '') || !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1)
      throw new FleetError('capability_unavailable', 'supervisor identity metadata is unavailable or mismatched');
    const verifySelection = () => {
      try {
        const current = findCandidates();
        const freshDescriptor = JSON.parse(readFileSync(selected.path, 'utf8'));
        if (current.length !== 1 || current[0].path !== selected.path
            || readFileSync(join(selected.dir, '.identity'), 'utf8').trim() !== identityName
            || ['role', 'identity', 'cid', 'socket', 'capability', 'generation']
              .some(key => freshDescriptor[key] !== descriptor[key])) throw new Error();
      } catch {
        throw new FleetError('capability_unavailable', 'selected supervisor assignment changed');
      }
    };
    const client = new Client({ name: 'ours-fleet-supervisor-tools', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../agent-ours/bridge.js', import.meta.url))],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        FLEET_OURS_BRIDGE_DESCRIPTOR: selected.path,
        FLEET_OURS_BRIDGE_EXPECTED: JSON.stringify({ role: descriptor.role, identity: descriptor.identity, cid: descriptor.cid, generation: descriptor.generation,
          transportDigest: createHash('sha256').update(JSON.stringify([descriptor.socket, descriptor.capability, descriptor.generation])).digest('hex') }) },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const verify = async () => {
        if (!legacy) { verifySelection(); return; }
        // The supervisor owns the binding. The authenticated bridge and pinned local
        // assignment are authoritative; current_identity is display text, not a protocol.
        const fresh = legacySupervisorIdentity(role, identityName, selected.temporary, descriptor.generation);
        if (!('proof' in identity) || fresh.proof !== identity.proof) throw new FleetError('capability_unavailable', 'legacy supervisor identity changed');
        verifySelection();
      };
      await verify();
      return await work(client, { name: identity.name, cid: identity.cid, generation: identity.generation }, verify);
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
    return this.withClient(role, async (client, identity, verify) => {
      const { tools } = await client.listTools();
      if (!tools.some(tool => tool.name === request.tool))
        throw new FleetError('forbidden', 'tool is not exposed by the fixed-identity supervisor');
      await verify();
      const result = await client.callTool({ name: request.tool, arguments: request.arguments ?? {} });
      return { agent: role, identity, result };
    });
  }
}
