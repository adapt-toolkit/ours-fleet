import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnerChannel } from '../src/owner-channel/channel.js';
import type { OursToolClient } from '../src/owner-channel/mcp.js';
import type { SessionHandle } from '../src/session/types.js';

const OWNER = 'A'.repeat(64);
const CONTACT = 'B'.repeat(64);
const dirs: string[] = [];

class ManagementClient implements OursToolClient {
  calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  batches: unknown[][] = [];
  async start() {}
  async close() {}
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'list_contacts') return { contacts: [
      { id: CONTACT, name: 'Phone', status: 'established', bio: 'must not be returned' },
      { id: 'C'.repeat(64), name: 'Pending', status: 'pending' },
    ] };
    if (name === 'generate_invite') return { invite: 'mock-invite-secret' };
    if (name === 'add_contact') return { id: CONTACT, name: 'Phone' };
    if (name === 'get_messages') return { messages: this.batches.shift() ?? [] };
    return {};
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ours-owner-management-'));
  dirs.push(dir);
  const client = new ManagementClient();
  const queuePrompt = vi.fn(async () => ({
    promptId: 'managed-prompt', queuedBehind: 0,
    completion: Promise.resolve({
      accepted: true, outcome: 'completed' as const, succeeded: true, output: 'done',
    }),
  }));
  const session = {
    backend: 'acp', pid: 1, isAlive: () => true,
    snapshot: () => ({ backend: 'acp', alive: true, readiness: 'running' }),
    queuePrompt, interrupt: vi.fn(), eventsSince: () => [],
  } as unknown as SessionHandle;
  const channel = new OwnerChannel({
    role: 'Role', config: {
      identity: 'Role-owner', owners: [OWNER], interrupt: false, progress_interval_ms: 0,
    }, session, stateDir: dir, client, log: () => undefined,
    watch: () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        pid: 1, exitCode: null, stdout, stderr,
        once: (_event: string, callback: () => void) => { callback(); },
        kill: () => { stdout.end(); stderr.end(); return true; },
      } as never;
    },
  });
  return { channel, client, queuePrompt };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OwnerChannel live management', () => {
  it('uses the already-bound client and never chooses or force-binds again', async () => {
    const { channel, client } = setup();
    await channel.start();
    const listed = await channel.manage({ action: 'contact_list' });
    expect(listed.action).toBe('contact_list');
    if (listed.action !== 'contact_list') throw new Error('bad test response');
    expect(listed.contacts[0]).toMatchObject({ cid: CONTACT, name: 'Phone', status: 'established' });
    expect(listed.contacts[0]).not.toHaveProperty('bio');
    const invite = await channel.manage({ action: 'contact_invite', name: 'Mobile' });
    expect(invite).toEqual({ action: 'contact_invite', invite: 'mock-invite-secret' });
    expect(client.calls.filter(call => call.name === 'choose_identity')).toEqual([
      { name: 'choose_identity', args: { name: 'Role-owner' } },
    ]);
    expect(client.calls.some(call => call.args?.force !== undefined)).toBe(false);
    await channel.close();
  });

  it('keeps contact establishment separate from authorization and checks exact established CID', async () => {
    const { channel, client } = setup();
    await channel.start();
    expect(await channel.manage({ action: 'contact_add', invite: 'fixture', name: 'Phone' }))
      .toMatchObject({ action: 'contact_add', status: 'pending' });
    expect((await channel.manage({ action: 'owner_list' })).action).toBe('owner_list');
    await expect(channel.manage({ action: 'owner_authorize', cid: CONTACT.toLowerCase() }))
      .rejects.toThrow(/unknown or pending/);
    await expect(channel.manage({ action: 'owner_authorize', cid: 'C'.repeat(64) }))
      .rejects.toThrow(/unknown or pending/);
    expect(await channel.manage({ action: 'owner_authorize', cid: CONTACT }))
      .toMatchObject({ owner: { cid: CONTACT, source: 'dynamic', effective: true } });
    await expect(channel.manage({ action: 'owner_authorize', cid: CONTACT }))
      .rejects.toThrow(/already authorized/);
    expect(client.calls.find(call => call.name === 'add_contact')?.args)
      .toEqual({ invite: 'fixture', name: 'Phone' });
    await channel.close();
  });

  it('rejects management deterministically before start and during shutdown', async () => {
    const { channel } = setup();
    await expect(channel.manage({ action: 'owner_list' })).rejects.toThrow(/unavailable/);
    await channel.start();
    await channel.close();
    await expect(channel.manage({ action: 'contact_list' })).rejects.toThrow(/unavailable/);
  });

  it('does not reflect invite material when ours-mcp rejects acceptance', async () => {
    const { channel, client } = setup();
    await channel.start();
    client.callTool = async (name: string) => {
      if (name === 'add_contact') throw new Error('daemon echoed TOP_SECRET_INVITE');
      if (name === 'get_messages') return { messages: [] };
      return {};
    };
    await expect(channel.manage({ action: 'contact_add', invite: 'TOP_SECRET_INVITE' }))
      .rejects.toThrow('ours-mcp could not accept the contact invite');
    await expect(channel.manage({ action: 'contact_add', invite: 'TOP_SECRET_INVITE' }))
      .rejects.not.toThrow(/TOP_SECRET_INVITE/);
    await channel.close();
  });

  it('serializes concurrent mutations and applies the resulting owner set immediately to routing', async () => {
    const { channel, client, queuePrompt } = setup();
    await channel.start();
    await Promise.all([
      channel.manage({ action: 'owner_authorize', cid: CONTACT }),
      channel.manage({ action: 'owner_revoke', cid: OWNER }),
    ]);
    const owners = await channel.manage({ action: 'owner_list' });
    expect(owners).toMatchObject({ owners: [
      { cid: OWNER, effective: false }, { cid: CONTACT, effective: true },
    ] });
    client.batches.push([{
      msg_id: 4, wire_id: 'dynamic-owner-wire', from: { id: CONTACT, name: 'Mobile' }, text: 'go',
    }], []);
    await channel.drain();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(queuePrompt).toHaveBeenCalledOnce();
    await channel.close();
  });
});
