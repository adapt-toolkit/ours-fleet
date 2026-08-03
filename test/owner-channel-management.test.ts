import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const logs: string[] = [];
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
    }, session, stateDir: dir, client, log: line => logs.push(line),
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
  return { channel, client, queuePrompt, logs, dir };
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

  it('routes multiple authored updates to the originating sender in receipt/update/final order', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { channel, client, queuePrompt, logs, dir } = setup();
    let finish!: (result: { accepted: true; outcome: 'completed'; succeeded: true; output: string }) => void;
    queuePrompt.mockResolvedValueOnce({
      promptId: 'long-turn', queuedBehind: 0,
      completion: new Promise(resolve => { finish = resolve; }),
    });
    await channel.start();
    const wireId = 'wire-authored-progress';
    const requestId = createHash('sha256').update(wireId).digest('hex');
    client.batches.push([{
      msg_id: 10, wire_id: wireId, from: { id: OWNER, name: 'Owner' }, text: 'Long task',
    }], []);
    await channel.drain();

    expect(queuePrompt.mock.calls[0][0]).toContain(requestId);
    expect(await channel.manage({
      action: 'request_update', requestId, phase: 'working',
      message: 'The implementation is complete and focused verification is running.',
    })).toMatchObject({ action: 'request_update', requestId, sequence: 1 });
    vi.mocked(Date.now).mockReturnValue(7_000);
    expect(await channel.manage({
      action: 'request_update', requestId, phase: 'approval',
      message: 'Approval is needed before the dependency download can continue.',
    })).toMatchObject({ sequence: 2 });

    finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Final answer' });
    await vi.waitFor(() => expect(client.calls.filter(call => call.name === 'send_message')
      .map(call => call.args?.text)).toEqual([
      'ℹ️ Message received. The agent has started working on this request now. '
        + 'The response will arrive in this channel when ready.',
      '🔄 Update: The implementation is complete and focused verification is running.',
      '🔐 Approval needed: Approval is needed before the dependency download can continue.',
      'Final answer',
    ]));
    expect(client.calls.filter(call => call.name === 'send_message')
      .every(call => call.args?.contact === OWNER && call.args?.reply_to_wire_id === wireId)).toBe(true);
    expect(logs.join('\n')).not.toMatch(/implementation is complete|dependency download/);
    const state = readFileSync(join(dir, '.owner-channel-state.json'), 'utf8');
    expect(state).toContain(wireId);
    expect(state).not.toMatch(/implementation is complete|dependency download|Final answer/);
    await expect(channel.manage({
      action: 'request_update', requestId, phase: 'working', message: 'This update is too late.',
    })).rejects.toThrow(/not active|finalizing/);
    await channel.close();
  });

  it('dedupes, rate-limits, bounds, and rejects unsafe authored updates without sending them', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const { channel, client, queuePrompt } = setup();
    queuePrompt.mockResolvedValueOnce({
      promptId: 'pending', queuedBehind: 0, completion: new Promise(() => {}),
    });
    await channel.start();
    const wireId = 'wire-update-validation';
    const requestId = createHash('sha256').update(wireId).digest('hex');
    client.batches.push([{
      msg_id: 11, wire_id: wireId, from: { id: OWNER }, text: 'Keep me posted',
    }], []);
    await channel.drain();
    const first = {
      action: 'request_update' as const, requestId, phase: 'working' as const,
      message: 'Focused tests are running.',
    };
    await channel.manage(first);
    await expect(channel.manage(first)).rejects.toThrow(/duplicate/);
    await expect(channel.manage({ ...first, message: 'The build is running.' }))
      .rejects.toThrow(/rate-limited/);
    vi.mocked(Date.now).mockReturnValue(16_000);
    for (const message of ['', 'x'.repeat(281), 'password=TOP_SECRET',
      'private reasoning: I think this will work', 'stdout: raw tool response', 'line one\nline two']) {
      await expect(channel.manage({ ...first, message })).rejects.toThrow();
    }
    await expect(channel.manage({ ...first, requestId: 'bad' })).rejects.toThrow(/64 lowercase/);
    expect(client.calls.filter(call => call.name === 'send_message')).toHaveLength(2);
    await channel.close();
  });

  it('isolates authored updates between concurrent authenticated senders', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    const { channel, client, queuePrompt } = setup();
    await channel.start();
    await channel.manage({ action: 'owner_authorize', cid: CONTACT });
    queuePrompt.mockImplementation(async () => ({
      promptId: `pending-${queuePrompt.mock.calls.length}`, queuedBehind: 0,
      completion: new Promise(() => {}),
    }));
    const wires = ['wire-owner-a', 'wire-owner-b'];
    client.batches.push([
      { msg_id: 12, wire_id: wires[0], from: { id: OWNER }, text: 'A' },
      { msg_id: 13, wire_id: wires[1], from: { id: CONTACT }, text: 'B' },
    ], []);
    await channel.drain();
    const requestIds = wires.map(wire => createHash('sha256').update(wire).digest('hex'));
    await channel.manage({ action: 'request_update', requestId: requestIds[0],
      phase: 'working', message: 'First request remains in progress.' });
    await channel.manage({ action: 'request_update', requestId: requestIds[1],
      phase: 'blocked', message: 'Second request is waiting for an external dependency.' });
    const updates = client.calls.filter(call => call.name === 'send_message'
      && String(call.args?.text).match(/^(?:🔄|🚧)/));
    expect(updates.map(call => [call.args?.contact, call.args?.reply_to_wire_id])).toEqual([
      [OWNER, wires[0]], [CONTACT, wires[1]],
    ]);
    await channel.close();
  });
});
