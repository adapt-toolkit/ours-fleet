import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnerChannel } from '../src/owner-channel/channel.js';
import type { OursToolClient } from '../src/owner-channel/mcp.js';
import { OWNER_TASK_MAX_PER_OWNER, OWNER_TASK_TTL_MS } from '../src/owner-channel/tasks.js';
import type { SessionHandle } from '../src/session/types.js';

const OWNER = 'A'.repeat(64);
const CONTACT = 'B'.repeat(64);
const AGENT = 'D'.repeat(64);
const INTRUDER = 'E'.repeat(64);
const dirs: string[] = [];

class ManagementClient implements OursToolClient {
  calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  batches: unknown[][] = [];
  contacts: unknown[] = [
    { id: CONTACT, name: 'Phone', status: 'established', bio: 'must not be returned' },
    { id: 'C'.repeat(64), name: 'Pending', status: 'pending' },
  ];
  failSendTo = new Set<string>();
  chooseFailures = 0;
  async start() {}
  async close() {}
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'choose_identity' && this.chooseFailures-- > 0)
      throw new Error('choose_identity declined: identity is currently bound to another live session');
    if (name === 'send_message' && this.failSendTo.has(String(args?.contact)))
      throw new Error('send_message failed');
    if (name === 'list_contacts') return { contacts: this.contacts };
    if (name === 'generate_invite') return { invite: 'mock-invite-secret' };
    if (name === 'add_contact') return { id: CONTACT, name: 'Phone' };
    if (name === 'get_messages') return { messages: this.batches.shift() ?? [] };
    return {};
  }
}

function setup(options: { agent?: string; owners?: string[] } = {}) {
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
    role: 'Role', harness: 'claude-code', config: {
      identity: 'Role-owner', owners: options.owners ?? [OWNER],
      interrupt: false, progress_interval_ms: 0,
      ...(options.agent ? { agent: options.agent } : {}),
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
  it('relays every managed-agent message as a new message to the latest owner', async () => {
    const { channel, client, queuePrompt } = setup({ agent: AGENT });
    await channel.start();
    client.batches.push([{
      msg_id: 1, wire_id: 'owner-selects-route', from: { id: OWNER }, text: '/status',
    }], []);
    await channel.drain();

    client.batches.push([{
      msg_id: 2, wire_id: 'agent-progress', from: { id: AGENT },
      text: 'The verification run is halfway complete.',
      reply_to: { wire_id: 'owner-selects-route' },
    }, {
      // Intra-root sibling delivery can have no ADAPT wire ID. The daemon's
      // per-identity message ID remains a stable idempotency key.
      msg_id: 3, wire_id: '', from: { id: AGENT },
      text: 'I found a useful unassigned Trello item.',
    }], []);
    await channel.drain();

    expect(queuePrompt).not.toHaveBeenCalled();
    expect(client.calls.filter(call => call.name === 'send_message').map(call => call.args))
      .toEqual(expect.arrayContaining([
        { contact: OWNER, text: 'The verification run is halfway complete.' },
        { contact: OWNER, text: 'I found a useful unassigned Trello item.' },
      ]));
    expect(client.calls.filter(call => call.name === 'send_message'
      && ['The verification run is halfway complete.', 'I found a useful unassigned Trello item.']
        .includes(String(call.args?.text)))
      .every(call => call.args?.reply_to_wire_id === undefined)).toBe(true);
    await channel.close();
  });

  it('warns the owner without reflecting the body when another agent tries the relay', async () => {
    const { channel, client, queuePrompt } = setup({ agent: AGENT });
    await channel.start();
    client.batches.push([{
      msg_id: 4, wire_id: 'owner-route-for-warning', from: { id: OWNER }, text: '/status',
    }], []);
    await channel.drain();
    client.batches.push([{
      msg_id: 5, wire_id: 'intruder-attempt', from: { id: INTRUDER, name: 'Other agent' },
      text: 'MALICIOUS_BODY_MUST_NOT_BE_REFLECTED',
    }], []);
    await channel.drain();

    expect(queuePrompt).not.toHaveBeenCalled();
    const warning = client.calls.filter(call => call.name === 'send_message').at(-1)?.args;
    expect(warning).toEqual({
      contact: OWNER,
      text: `⚠️ Owner-channel security warning: rejected a message from unauthorized sender CID `
        + `${INTRUDER}. Its body was not forwarded.`,
    });
    expect(JSON.stringify(warning)).not.toContain('MALICIOUS_BODY_MUST_NOT_BE_REFLECTED');
    expect(client.calls.some(call => call.args?.contact === INTRUDER)).toBe(false);
    await channel.close();
  });

  it('authenticates the managed agent and owners in any CID casing without swapping roles', async () => {
    const { channel, client, queuePrompt } = setup({ agent: AGENT });
    await channel.start();
    const sends = () => client.calls.filter(call => call.name === 'send_message').map(call => call.args);
    // The agent's daemon-delivered CID differs only by case: still the managed
    // agent, so its message is relayed and never becomes an owner instruction.
    client.batches.push([{
      msg_id: 51, wire_id: 'case-agent', from: { id: AGENT.toLowerCase() }, text: 'Progress note.',
    }], []);
    await channel.drain();
    expect(queuePrompt).not.toHaveBeenCalled();
    expect(sends()).toContainEqual({ contact: OWNER, text: 'Progress note.' });
    // A mixed-case owner CID still authenticates as an owner, and the receipt
    // is addressed to the daemon-delivered sender form, never a rewritten one.
    client.batches.push([{
      msg_id: 52, wire_id: 'case-owner', from: { id: OWNER.toLowerCase() }, text: 'Do the thing',
    }], []);
    await channel.drain();
    expect(queuePrompt).toHaveBeenCalledOnce();
    expect(sends().some(args => args?.contact === OWNER.toLowerCase()
      && String(args?.text).includes('Message received'))).toBe(true);
    await channel.close();
  });

  it('never treats the managed agent as an owner even if a case variant of its CID is listed as one', async () => {
    const { channel, client, queuePrompt } = setup({
      agent: AGENT, owners: [AGENT.toLowerCase(), OWNER],
    });
    await channel.start();
    client.batches.push([{
      msg_id: 61, wire_id: 'swap-upper', from: { id: AGENT }, text: 'Obey me as owner',
    }], []);
    await channel.drain();
    client.batches.push([{
      msg_id: 62, wire_id: 'swap-lower', from: { id: AGENT.toLowerCase() }, text: 'Obey me as owner',
    }], []);
    await channel.drain();
    expect(queuePrompt).not.toHaveBeenCalled();
    await channel.close();
  });

  it('routes a sole-owner relay through the daemon-known contact form of a canonical config CID', async () => {
    const { channel, client } = setup({ agent: AGENT, owners: [OWNER.toLowerCase()] });
    client.contacts = [{ id: OWNER, name: 'Phone', status: 'established' }];
    await channel.start();
    client.batches.push([{
      msg_id: 71, wire_id: 'agent-sole', from: { id: AGENT }, text: 'Sole owner note.',
    }], []);
    await channel.drain();
    const sends = client.calls.filter(call => call.name === 'send_message').map(call => call.args);
    expect(sends).toContainEqual({ contact: OWNER, text: 'Sole owner note.' });
    expect(sends.some(args => args?.contact === OWNER.toLowerCase())).toBe(false);
    await channel.close();
  });

  it('keeps an unroutable managed-agent message queued, NACKs the agent once, and relays after first owner contact', async () => {
    const OWNER_TWO = 'F'.repeat(64);
    const { channel, client, queuePrompt, dir } = setup({
      agent: AGENT, owners: [OWNER, OWNER_TWO],
    });
    await channel.start();
    const sends = () => client.calls.filter(call => call.name === 'send_message').map(call => call.args);
    const agentMessage = {
      msg_id: 31, wire_id: 'agent-unroutable', from: { id: AGENT },
      text: 'Escalation: need owner input.',
    };
    // A non-advancing drain consumes exactly one batch, so no trailing empty
    // batch is queued for the unroutable passes.
    client.batches.push([agentMessage]);
    await channel.drain();

    // No owner route exists yet, so nothing may be delivered or guessed…
    expect(sends().filter(args => args?.contact === OWNER || args?.contact === OWNER_TWO))
      .toEqual([]);
    // …but the loss is not silent: the authenticated agent gets exactly one
    // bounded NACK correlated to its wire.
    expect(sends().filter(args => args?.contact === AGENT)).toEqual([{
      contact: AGENT, text: expect.stringContaining('queued'),
      reply_to_wire_id: 'agent-unroutable',
    }]);
    // The wire stays deferred and unconsumed for replay.
    expect(client.calls).toContainEqual({ name: 'defer_messages', args: { msg_ids: [31] } });
    const statePath = join(dir, '.owner-channel-state.json');
    if (existsSync(statePath))
      expect(readFileSync(statePath, 'utf8')).not.toContain('agent-unroutable');

    // A replayed copy neither NACKs again nor delivers anywhere.
    client.batches.push([agentMessage]);
    await channel.drain();
    expect(sends().filter(args => args?.contact === AGENT)).toHaveLength(1);
    expect(sends().filter(args => args?.contact === OWNER || args?.contact === OWNER_TWO))
      .toEqual([]);

    // The first authenticated owner contact establishes the route; the replay
    // then relays exactly once.
    client.batches.push([
      { msg_id: 32, wire_id: 'owner-first-contact', from: { id: OWNER_TWO }, text: '/status' },
      agentMessage,
    ], []);
    await channel.drain();
    expect(sends().filter(args => args?.contact === OWNER_TWO
      && args?.text === 'Escalation: need owner input.')).toHaveLength(1);

    // Now consumed: another replay cannot double-deliver.
    client.batches.push([agentMessage]);
    await channel.drain();
    expect(sends().filter(args => args?.text === 'Escalation: need owner input.')).toHaveLength(1);
    expect(queuePrompt).not.toHaveBeenCalled();
    await channel.close();
  });

  it('NACKs and consumes a managed-agent message the relay policy refuses', async () => {
    const { channel, client } = setup({ agent: AGENT });
    await channel.start();
    const bad = { msg_id: 41, wire_id: 'agent-bad', from: { id: AGENT }, text: 'bad\u0000byte' };
    client.batches.push([bad], []);
    await channel.drain();
    const sends = () => client.calls.filter(call => call.name === 'send_message').map(call => call.args);
    expect(sends()).toEqual([{
      contact: AGENT, text: expect.stringContaining('was not relayed to an owner'),
      reply_to_wire_id: 'agent-bad',
    }]);
    // Permanently consumed: a replay is inert.
    client.batches.push([bad], []);
    await channel.drain();
    expect(sends()).toHaveLength(1);
    await channel.close();
  });

  it('NACKs the agent when relay delivery is uncertain and never blind-retries', async () => {
    const { channel, client } = setup({ agent: AGENT });
    await channel.start();
    client.failSendTo.add(OWNER);
    const report = { msg_id: 42, wire_id: 'agent-uncertain', from: { id: AGENT }, text: 'Report.' };
    client.batches.push([report], []);
    await channel.drain();
    const sends = () => client.calls.filter(call => call.name === 'send_message').map(call => call.args);
    expect(sends().filter(args => args?.contact === AGENT)).toEqual([{
      contact: AGENT, text: expect.stringContaining('uncertain'),
      reply_to_wire_id: 'agent-uncertain',
    }]);
    expect(sends().filter(args => args?.contact === OWNER)).toHaveLength(1);
    // The uncertain outcome is terminal: a replayed copy never re-sends.
    client.batches.push([report], []);
    await channel.drain();
    expect(sends().filter(args => args?.contact === OWNER)).toHaveLength(1);
    await channel.close();
  });

  it('disables control-socket message and authority bypasses in managed-agent mode', async () => {
    const { channel, client } = setup({ agent: AGENT });
    await channel.start();
    await expect(channel.manage({
      action: 'request_update', requestId: 'a'.repeat(64), phase: 'working', message: 'bypass',
    })).rejects.toThrow(/managed agent must message its owner-channel identity/);
    await expect(channel.manage({ action: 'owner_authorize', cid: CONTACT }))
      .rejects.toThrow(/edit fleet configuration instead/);
    expect(client.calls.filter(call => call.name === 'send_message')).toEqual([]);
    await channel.close();
  });

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

  it('retries a daemon lease only after evidence of its own released predecessor', async () => {
    const { channel, client, dir } = setup();
    writeFileSync(join(dir, '.owner-channel-binder.json'), JSON.stringify({
      version: 1, role: 'Role', identity: 'Role-owner', releasedAt: Date.now(),
    }));
    client.chooseFailures = 2;
    await channel.start();
    expect(client.calls.filter(call => call.name === 'choose_identity')).toEqual([
      { name: 'choose_identity', args: { name: 'Role-owner' } },
      { name: 'choose_identity', args: { name: 'Role-owner' } },
      { name: 'choose_identity', args: { name: 'Role-owner' } },
    ]);
    expect(client.calls.some(call => call.args?.force !== undefined)).toBe(false);
    await channel.close();
  });

  it('does not retry or force-bind a live daemon holder without owned-handoff evidence', async () => {
    const { channel, client, dir } = setup();
    client.chooseFailures = 100;
    await expect(channel.start()).rejects.toThrow(/another live session/);
    expect(client.calls.filter(call => call.name === 'choose_identity')).toHaveLength(1);
    expect(client.calls.some(call => call.args?.force !== undefined)).toBe(false);
    expect(existsSync(join(dir, '.owner-channel-binder.lock'))).toBe(false);
  });

  it('delivers one fixed startup recovery notice over a safe owner route without persisting plaintext', async () => {
    const { channel, client, dir } = setup();
    await channel.start();
    expect(await channel.manage({ action: 'startup_failure' }))
      .toEqual({ action: 'startup_failure', status: 'delivered' });
    expect(await channel.manage({ action: 'startup_failure' }))
      .toEqual({ action: 'startup_failure', status: 'duplicate' });
    const notices = client.calls.filter(call => call.name === 'send_message'
      && String(call.args?.text).includes('could not take over'));
    expect(notices).toEqual([{ name: 'send_message', args: {
      contact: OWNER,
      text: `⚠️ Role owner channel could not take over 'Role-owner' from its previous supervisor. `
        + `Recovery: send /restart to retry the supervised handoff; if this repeats, inspect the web `
        + `console or run ours-fleet logs Role.`,
    } }]);
    const state = readFileSync(join(dir, '.owner-channel-conversations.json'), 'utf8');
    expect(state).not.toContain('could not take over');
    expect(state).not.toContain('Recovery:');
    await channel.close();
  });

  it('keeps startup recovery local when no deterministic owner route exists', async () => {
    const { channel, client } = setup({ owners: [OWNER, 'F'.repeat(64)] });
    await channel.start();
    await expect(channel.manage({ action: 'startup_failure' }))
      .rejects.toThrow(/no authenticated owner conversation route/);
    expect(client.calls.filter(call => call.name === 'send_message')).toEqual([]);
    await channel.close();
  });

  it('never blind-retries an uncertain startup recovery delivery', async () => {
    const { channel, client, dir } = setup();
    await channel.start();
    client.failSendTo.add(OWNER);
    await expect(channel.manage({ action: 'startup_failure' }))
      .rejects.toThrow(/delivery outcome is uncertain/);
    expect(await channel.manage({ action: 'startup_failure' }))
      .toEqual({ action: 'startup_failure', status: 'duplicate' });
    expect(client.calls.filter(call => call.name === 'send_message'
      && String(call.args?.text).includes('could not take over'))).toHaveLength(1);
    expect(readFileSync(join(dir, '.owner-channel-conversations.json'), 'utf8'))
      .not.toContain('could not take over');
    await channel.close();
  });

  it('keeps contact establishment separate from authorization and checks the established CID canonically', async () => {
    const { channel, client } = setup();
    await channel.start();
    expect(await channel.manage({ action: 'contact_add', invite: 'fixture', name: 'Phone' }))
      .toMatchObject({ action: 'contact_add', status: 'pending' });
    expect((await channel.manage({ action: 'owner_list' })).action).toBe('owner_list');
    await expect(channel.manage({ action: 'owner_authorize', cid: 'C'.repeat(64) }))
      .rejects.toThrow(/unknown or pending/);
    // Hex case is not identity: a case variant authorizes the SAME established
    // contact, and a repeat in any casing is the same owner, not a second slot.
    expect(await channel.manage({ action: 'owner_authorize', cid: CONTACT.toLowerCase() }))
      .toMatchObject({ owner: { cid: CONTACT.toLowerCase(), source: 'dynamic', effective: true } });
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

  it('opens only during the exact active request and routes a later report to that origin', async () => {
    const { channel, client, queuePrompt } = setup();
    const completed = (output: string) => ({
      accepted: true as const, outcome: 'completed' as const, succeeded: true, output,
    });
    let finishA!: (result: ReturnType<typeof completed>) => void;
    let finishB!: (result: ReturnType<typeof completed>) => void;
    queuePrompt
      .mockResolvedValueOnce({ promptId: 'owner-a', queuedBehind: 0,
        completion: new Promise(resolve => { finishA = resolve; }) })
      .mockResolvedValueOnce({ promptId: 'owner-b', queuedBehind: 1,
        completion: new Promise(resolve => { finishB = resolve; }) });
    await channel.start();
    await channel.manage({ action: 'owner_authorize', cid: CONTACT });
    const wireA = 'task-wire-owner-a';
    const wireB = 'task-wire-owner-b';
    client.batches.push([
      { msg_id: 30, wire_id: wireA, from: { id: OWNER }, text: 'Delegate A' },
      { msg_id: 31, wire_id: wireB, from: { id: CONTACT }, text: 'Delegate B' },
    ], []);
    await channel.drain();
    const requestA = createHash('sha256').update(wireA).digest('hex');
    const requestB = createHash('sha256').update(wireB).digest('hex');
    const openedA = await channel.manage({ action: 'task_open', requestId: requestA });
    const openedB = await channel.manage({ action: 'task_open', requestId: requestB });
    if (openedA.action !== 'task_open' || openedB.action !== 'task_open') throw new Error('bad task result');
    await expect(channel.manage({ action: 'task_report', taskId: openedA.taskId,
      phase: 'progress', message: 'This is too early.' })).rejects.toThrow(/only after.*finalized/);

    finishA(completed('Original final A'));
    finishB(completed('Original final B'));
    await vi.waitFor(() => expect(client.calls.filter(call => call.name === 'send_message'
      && String(call.args?.text).startsWith('Original final'))).toHaveLength(2));
    await channel.manage({ action: 'task_report', taskId: openedB.taskId,
      phase: 'done', message: 'The second specialist finished.' });
    await channel.manage({ action: 'task_report', taskId: openedA.taskId,
      phase: 'blocked', message: 'The first specialist needs an external dependency.' });
    const reports = client.calls.filter(call => call.name === 'send_message'
      && String(call.args?.text).includes('Follow-up'));
    expect(reports.map(call => call.args)).toEqual([
      { contact: CONTACT, reply_to_wire_id: wireB,
        text: '✅ Follow-up complete: The second specialist finished.' },
      { contact: OWNER, reply_to_wire_id: wireA,
        text: '🚧 Follow-up blocked: The first specialist needs an external dependency.' },
    ]);
    await channel.close();
  });

  it('persists the route across restart without persisting bodies and closes terminal tasks', async () => {
    const { channel, client, queuePrompt, dir } = setup();
    let finish!: (result: { accepted: true; outcome: 'completed'; succeeded: true; output: string }) => void;
    queuePrompt.mockResolvedValueOnce({ promptId: 'restart-task', queuedBehind: 0,
      completion: new Promise(resolve => { finish = resolve; }) });
    await channel.start();
    const wire = 'restart-task-wire';
    const requestId = createHash('sha256').update(wire).digest('hex');
    client.batches.push([{ msg_id: 32, wire_id: wire, from: { id: OWNER }, text: 'Delegate' }], []);
    await channel.drain();
    const opened = await channel.manage({ action: 'task_open', requestId });
    if (opened.action !== 'task_open') throw new Error('bad task result');
    finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Original final' });
    await vi.waitFor(() => expect(client.calls.some(call => call.args?.text === 'Original final')).toBe(true));
    await channel.close();

    const restartedClient = new ManagementClient();
    const restarted = new OwnerChannel({
      role: 'Role', harness: 'claude-code', config: { identity: 'Role-owner', owners: [OWNER], interrupt: false,
        progress_interval_ms: 0 },
      session: { backend: 'acp', pid: 2, isAlive: () => true,
        snapshot: () => ({ backend: 'acp', alive: true, readiness: 'idle' }),
        queuePrompt: vi.fn(), interrupt: vi.fn(), eventsSince: () => [] } as unknown as SessionHandle,
      stateDir: dir, client: restartedClient, log: () => undefined,
      watch: () => ({ pid: 2, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
        once: (_event: string, callback: () => void) => { callback(); }, kill: () => true }) as never,
    });
    await restarted.start();
    await restarted.manage({ action: 'task_report', taskId: opened.taskId,
      phase: 'done', message: 'Restarted supervisor delivered the verified result.' });
    expect(restartedClient.calls).toContainEqual({ name: 'send_message', args: {
      contact: OWNER, reply_to_wire_id: wire,
      text: '✅ Follow-up complete: Restarted supervisor delivered the verified result.',
    } });
    const state = readFileSync(join(dir, '.owner-channel-tasks.json'), 'utf8');
    expect(state).not.toContain('Restarted supervisor delivered');
    expect(state).not.toContain('Original final');
    await expect(restarted.manage({ action: 'task_report', taskId: opened.taskId,
      phase: 'done', message: 'Do not deliver twice.' })).rejects.toThrow(/closed/);
    await restarted.close();
  });

  it('revocation and expiry invalidate persisted task routes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const { channel, client, queuePrompt } = setup();
    let finish!: (result: { accepted: true; outcome: 'completed'; succeeded: true; output: string }) => void;
    queuePrompt.mockResolvedValue({ promptId: 'task-policy', queuedBehind: 0,
      completion: new Promise(resolve => { finish = resolve; }) });
    await channel.start();
    await channel.manage({ action: 'owner_authorize', cid: CONTACT });
    const wire = 'revoked-task-wire';
    const requestId = createHash('sha256').update(wire).digest('hex');
    client.batches.push([{ msg_id: 33, wire_id: wire, from: { id: OWNER }, text: 'Delegate' }], []);
    await channel.drain();
    const revoked = await channel.manage({ action: 'task_open', requestId });
    if (revoked.action !== 'task_open') throw new Error('bad task result');
    finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Final' });
    await vi.waitFor(() => expect(client.calls.some(call => call.args?.text === 'Final')).toBe(true));
    await channel.manage({ action: 'owner_revoke', cid: OWNER });
    await expect(channel.manage({ action: 'task_report', taskId: revoked.taskId,
      phase: 'done', message: 'Must not route after revoke.' })).rejects.toThrow(/revoked/);

    // A different authorized owner can open a task which then expires.
    let finish2!: (result: { accepted: true; outcome: 'completed'; succeeded: true; output: string }) => void;
    queuePrompt.mockResolvedValueOnce({ promptId: 'task-expiry', queuedBehind: 0,
      completion: new Promise(resolve => { finish2 = resolve; }) });
    const expiryWire = 'expired-task-wire';
    const expiryRequest = createHash('sha256').update(expiryWire).digest('hex');
    client.batches.push([{ msg_id: 34, wire_id: expiryWire,
      from: { id: CONTACT }, text: 'Delegate later' }], []);
    await channel.drain();
    const expired = await channel.manage({ action: 'task_open', requestId: expiryRequest });
    if (expired.action !== 'task_open') throw new Error('bad task result');
    finish2({ accepted: true, outcome: 'completed', succeeded: true, output: 'Final 2' });
    await vi.waitFor(() => expect(client.calls.some(call => call.args?.text === 'Final 2')).toBe(true));
    vi.mocked(Date.now).mockReturnValue(100_000 + OWNER_TASK_TTL_MS + 1);
    await expect(channel.manage({ action: 'task_report', taskId: expired.taskId,
      phase: 'done', message: 'Must not route after expiry.' })).rejects.toThrow(/expired/);
    await channel.close();
  });

  it('fails closed on duplicate, unsafe, over-cap, and uncertain reports', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200_000);
    const { channel, client, queuePrompt } = setup();
    let finish!: (result: { accepted: true; outcome: 'completed'; succeeded: true; output: string }) => void;
    queuePrompt.mockResolvedValue({ promptId: 'task-limits', queuedBehind: 0,
      completion: new Promise(resolve => { finish = resolve; }) });
    await channel.start();
    const wire = 'task-limits-wire';
    const requestId = createHash('sha256').update(wire).digest('hex');
    client.batches.push([{ msg_id: 35, wire_id: wire, from: { id: OWNER }, text: 'Delegate' }], []);
    await channel.drain();
    const opened = [];
    for (let i = 0; i < OWNER_TASK_MAX_PER_OWNER; i++) {
      const result = await channel.manage({ action: 'task_open', requestId });
      if (result.action === 'task_open') opened.push(result.taskId);
    }
    await expect(channel.manage({ action: 'task_open', requestId })).rejects.toThrow(/open tasks per role/);
    finish({ accepted: true, outcome: 'completed', succeeded: true, output: 'Original final' });
    await vi.waitFor(() => expect(client.calls.some(call => call.args?.text === 'Original final')).toBe(true));
    await expect(channel.manage({ action: 'task_report', taskId: opened[0], phase: 'progress',
      message: 'password=TOP_SECRET' })).rejects.toThrow(/unsafe/);
    await expect(channel.manage({ action: 'task_report', taskId: opened[0], phase: 'progress',
      message: 'First sentence. Second sentence.' })).rejects.toThrow(/one plain-text sentence/);
    await channel.manage({ action: 'task_report', taskId: opened[0], phase: 'progress',
      message: 'Specialist tests are running.' });
    vi.mocked(Date.now).mockReturnValue(206_000);
    await expect(channel.manage({ action: 'task_report', taskId: opened[0], phase: 'progress',
      message: 'Specialist tests are running.' })).rejects.toThrow(/duplicate/);

    const raced = await Promise.allSettled([
      channel.manage({ action: 'task_report', taskId: opened[2], phase: 'progress',
        message: 'The first concurrent report won.' }),
      channel.manage({ action: 'task_report', taskId: opened[2], phase: 'progress',
        message: 'The second concurrent report lost.' }),
    ]);
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1);

    const originalCall = client.callTool.bind(client);
    let attempted = 0;
    client.callTool = async (name, args) => {
      if (name === 'send_message' && String(args?.text).includes('Follow-up complete')) {
        attempted++;
        throw new Error('ambiguous transport failure with secret details');
      }
      return originalCall(name, args);
    };
    await expect(channel.manage({ action: 'task_report', taskId: opened[1], phase: 'done',
      message: 'Specialist completed the assigned review.' })).rejects.toThrow(/outcome is uncertain/);
    vi.mocked(Date.now).mockReturnValue(212_000);
    await expect(channel.manage({ action: 'task_report', taskId: opened[1], phase: 'done',
      message: 'Specialist completed the assigned review.' })).rejects.toThrow(/outcome is uncertain/);
    expect(attempted).toBe(1);
    await expect(channel.manage({ action: 'task_report', taskId: 'f'.repeat(64), phase: 'done',
      message: 'Unknown tasks fail closed.' })).rejects.toThrow(/unknown/);
    await channel.close();
  });
});
