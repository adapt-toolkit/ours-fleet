import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errBoundElsewhere } from '@ours.network/sdk/client';

import { OwnerChannel } from '../src/owner-channel/channel.js';
import type {
  OursContactsView, OursInboundMessage, OursOps, OursRegisteredCommand,
} from '../src/owner-channel/ours-client.js';
import { OWNER_TASK_MAX_PER_OWNER, OWNER_TASK_TTL_MS } from '../src/owner-channel/tasks.js';
import type { SessionHandle } from '../src/session/types.js';
import { historyMessage, incomingMessage } from './owner-history-fixtures.js';

const OWNER = 'A'.repeat(64);
const CONTACT = 'B'.repeat(64);
const AGENT = 'D'.repeat(64);
const INTRUDER = 'E'.repeat(64);
const dirs: string[] = [];

class ManagementClient implements OursOps {
  calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  batches: unknown[][] = [];
  history = new Map<string, OursInboundMessage>();
  commands: OursRegisteredCommand[] = [];
  /**
   * Established contacts and pending introductions are separate daemon
   * collections, and neither carries a bio or any other free text.
   */
  view: OursContactsView = {
    contacts: [{ name: 'Phone', container_id: CONTACT }],
    pending: [{ name: 'Pending', container_id: 'C'.repeat(64), queued: 1 }],
    roots: {}, degraded: [], renames: {},
  };
  failSendTo = new Set<string>();
  /** Optional deterministic delivery gate for exercising in-flight send ordering. */
  sendGate?: (args: { contact: string; text: string; replyToWireId?: string }) => Promise<void>;
  /** How many binds must fail, and with which error. */
  bindFailures = 0;
  bindError: () => Error = () => errBoundElsewhere('Coordinator-owner');
  watchAttempts: Array<(
    options?: { since?: number | 'tip'; signal?: AbortSignal },
  ) => AsyncGenerator<Record<string, unknown>, void, undefined>> = [];
  watchCalls: Array<{ identity: string; since?: number | 'tip' }> = [];
  async start() {}
  async close() {}
  async bindIdentity(name: string) {
    this.calls.push({ name: 'bindIdentity', args: { name } });
    if (this.bindFailures-- > 0) throw this.bindError();
  }
  async registerCommands(commands: OursRegisteredCommand[]) {
    this.commands = commands;
    this.calls.push({ name: 'registerCommands', args: { count: commands.length } });
  }
  async listContacts() {
    this.calls.push({ name: 'listContacts', args: undefined });
    return this.view;
  }
  async generateInvite(name?: string) {
    this.calls.push({ name: 'generateInvite', args: { name } });
    return { blob: 'mock-invite-blob', inviteId: 'invite-1', mode: 'one_time' as const };
  }
  async addContact(a: { invite: string; name?: string }) {
    this.calls.push({ name: 'addContact', args: { ...a } });
    return { display: a.name ?? 'Phone', cid: CONTACT };
  }
  async listIncomingMessages() {
    this.calls.push({ name: 'listIncomingMessages', args: undefined });
    const batch = this.batches[0] ?? [];
    if (!batch.length) this.batches.shift();
    return batch.map((item, index) => {
      const persistent = historyMessage(item, index + 1);
      this.history.set(persistent.wire_id, persistent);
      return incomingMessage(item, index + 1);
    });
  }
  async getMessages(limit: number) {
    this.calls.push({ name: 'getMessages', args: { limit } });
    const batch = this.batches.shift() ?? [];
    const messages = batch.slice(0, limit).map((item, index) => historyMessage(item, index + 1));
    for (const message of messages) this.history.set(message.wire_id, message);
    if (batch.length > limit) this.batches.unshift(batch.slice(limit));
    return { messages, command_results: [], commands_handled: 0,
      remaining: Math.max(0, batch.length - limit) };
  }
  async getHistoryItem(wireId: string) {
    this.calls.push({ name: 'getHistoryItem', args: { wireId } });
    return this.history.get(wireId) ?? null;
  }
  watchNotifications(
    identity: string, options?: { since?: number | 'tip'; signal?: AbortSignal },
  ) {
    this.watchCalls.push({ identity, since: options?.since });
    const attempt = this.watchAttempts.shift();
    if (attempt) return attempt(options);
    return (async function* () {
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
  }
  async listIncomingFiles() {
    this.calls.push({ name: 'listIncomingFiles', args: undefined });
    return [];
  }
  async getFileInfo(wireId: string) {
    this.calls.push({ name: 'getFileInfo', args: { wireId } });
    return null;
  }
  async getFiles(wireIds: string[]) {
    this.calls.push({ name: 'getFiles', args: { wireIds } });
    return { files: [], text: '', mode: 'selected' as const, requested: wireIds };
  }
  async fetchFile(wireId: string) {
    this.calls.push({ name: 'fetchFile', args: { wireId } });
    return new Uint8Array();
  }
  async sendMessage(a: { contact: string; text: string; replyToWireId?: string }) {
    this.calls.push({ name: 'sendMessage', args: { ...a } });
    if (this.failSendTo.has(a.contact)) throw new Error('sendMessage failed');
    await this.sendGate?.(a);
  }
  async sendFile(a: { contact: string; path: string; filename: string; replyToWireId?: string }) {
    this.calls.push({ name: 'sendFile', args: { ...a } });
  }
}

function setup(options: {
  agent?: string; owners?: string[]; dir?: string; client?: ManagementClient;
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'ours-owner-management-'));
  dirs.push(dir);
  const client = options.client ?? new ManagementClient();
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
  });
  return { channel, client, queuePrompt, logs, dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OwnerChannel live management', () => {
  it('durably accepts ready while unavailable and flushes once after Owner-channel restart', async () => {
    const first = setup({ agent: AGENT });
    const ready = { kind: 'room' as const, operation: 'activate' as const,
      eventId: 'room-ready:2026-09-03T09:00:00.000Z', id: 'room-restart', name: 'Restart ready',
      previousState: 'provisioning', newState: 'active', participants: [] };

    // The control server can durably accept this while its Owner sink is not
    // ready. No await/recover command or live send is involved.
    await first.channel.notifyFleetLifecycle!([ready]);
    expect(first.client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(first.dir, '.owner-channel-lifecycle-outbox.json'), 'utf8')))
      .toMatchObject({ entries: [{ delivery: 'pending', presentation: { eventId: ready.eventId } }] });

    const second = setup({ agent: AGENT, dir: first.dir });
    await second.channel.start();
    await second.channel.notifyFleetLifecycle!([ready]);
    const notices = second.client.calls.filter(call => call.name === 'sendMessage'
      && String(call.args?.text).includes('🏠 Room ready: Restart ready'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.args?.contact).toBe(OWNER);
    expect(JSON.parse(readFileSync(join(first.dir, '.owner-channel-lifecycle-outbox.json'), 'utf8')))
      .toMatchObject({ entries: [{ delivery: 'delivered' }] });
    await second.channel.close();
  });

  it('never retries a ready notice whose send boundary became uncertain', async () => {
    const first = setup({ agent: AGENT });
    await first.channel.start();
    first.client.failSendTo.add(OWNER);
    const ready = { kind: 'room' as const, operation: 'activate' as const,
      eventId: 'room-ready:uncertain', id: 'room-uncertain', name: 'Uncertain ready',
      previousState: 'provisioning', newState: 'active', participants: [] };
    await first.channel.notifyFleetLifecycle!([ready]);
    expect(first.client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(1);
    await first.channel.close();

    const second = setup({ agent: AGENT, dir: first.dir });
    await second.channel.start();
    expect(second.client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(first.dir, '.owner-channel-lifecycle-outbox.json'), 'utf8')))
      .toMatchObject({ entries: [{ delivery: 'uncertain' }] });
    await second.channel.close();
  });

  it('delivers a replayed detached-ready presentation exactly once to the authenticated Owner', async () => {
    const { channel, client } = setup({ agent: AGENT });
    await channel.start();
    const ready = { kind: 'room' as const, operation: 'activate' as const,
      eventId: 'room-ready:2026-09-03T09:00:00.000Z', id: 'room-detached', name: 'Detached ready',
      previousState: 'provisioning', newState: 'active', participants: [] };
    await channel.notifyFleetLifecycle!([ready]);
    await channel.notifyFleetLifecycle!([ready]);
    const notices = client.calls.filter(call => call.name === 'sendMessage'
      && String(call.args?.text).includes('🏠 Room ready: Detached ready'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.args?.contact).toBe(OWNER);
    await channel.close();
  });

  /** One SDK-watch harness with deterministic retry sleeps. */
  function watchSetup(options: {
    watchState?: string;
    batches?: unknown[][];
    attempts?: Array<(
      options?: { since?: number | 'tip'; signal?: AbortSignal },
    ) => AsyncGenerator<Record<string, unknown>, void, undefined>>;
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ours-owner-watch-'));
    dirs.push(dir);
    if (options.watchState !== undefined)
      writeFileSync(join(dir, '.owner-channel-watch.json'), options.watchState);
    const client = new ManagementClient();
    for (const batch of options.batches ?? []) client.batches.push(batch);
    client.watchAttempts.push(...options.attempts ?? []);
    const queuePrompt = vi.fn(async () => ({
      promptId: 'watch-prompt', queuedBehind: 0,
      completion: Promise.resolve({
        accepted: true, outcome: 'completed' as const, succeeded: true, output: 'done',
      }),
    }));
    const session = {
      backend: 'acp', pid: 1, isAlive: () => true,
      snapshot: () => ({ backend: 'acp', alive: true, readiness: 'idle' }),
      queuePrompt, interrupt: vi.fn(), eventsSince: () => [],
    } as unknown as SessionHandle;
    const delays: number[] = [];
    const logs: string[] = [];
    const channel = new OwnerChannel({
      role: 'Role', harness: 'claude-code',
      config: { identity: 'Role-owner', owners: [OWNER], interrupt: false, progress_interval_ms: 0 },
      session, stateDir: dir, client,
      log: line => logs.push(line),
      binderDeps: { now: () => 1_000, sleep: async ms => { delays.push(ms); } },
    });
    const readState = () => JSON.parse(
      readFileSync(join(dir, '.owner-channel-watch.json'), 'utf8')) as Record<string, unknown>;
    return { channel, client, queuePrompt, logs, delays, dir, readState };
  }

  it('drains mail that arrives while disconnected before re-establishing the SDK watch', async () => {
    const secretBody = 'OWNER_BODY_MUST_NOT_ENTER_WATCH_STATE';
    const pending = {
      msg_id: 90, wire_id: 'watch-continuity-wire', from: { id: OWNER }, text: secretBody,
    };
    const fail = async function* () { throw new Error('socket disconnected'); };
    const connected = async function* (options?: { signal?: AbortSignal }) {
      yield { event: 'message_received', msg_id: '90' };
      await new Promise<void>(resolve =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    };
    const watch = watchSetup({
      // Initial establishment drains empty. The message appears while the first
      // watch is disconnected, so only the reconnect drain can recover it.
      // Replaying the same inbox wire on the notification drain models an
      // at-least-once recovery; durable wire dedupe must still dispatch once.
      batches: [[], [pending], [pending], []],
      attempts: [fail, connected],
    });

    await watch.channel.start();
    await vi.waitFor(() => expect(watch.queuePrompt).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(watch.client.watchCalls).toHaveLength(2));
    await watch.channel.close();

    expect(watch.client.watchCalls).toEqual([
      { identity: 'Role-owner', since: 0 }, { identity: 'Role-owner', since: 0 },
    ]);
    expect(watch.delays[0]).toBe(1_000);
    expect(watch.logs.some(line => line.includes('reason=OWNER_WATCH_STREAM_ERROR'))).toBe(true);
    expect(watch.readState()).toMatchObject({ version: 2, reconnects: 1, consecutiveFailures: 0 });
    expect(JSON.stringify(watch.readState())).not.toContain(secretBody);
    expect(watch.queuePrompt.mock.calls[0][0]).toContain(secretBody);
  });

  it('migrates legacy cursor state but never persists or reuses the cursor', async () => {
    const connected = async function* (options?: { signal?: AbortSignal }) {
      yield { event: 'message_received' };
      await new Promise<void>(resolve =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    };
    const watch = watchSetup({
      watchState: JSON.stringify({
        version: 1, cursor: 41, reconnects: 4, consecutiveFailures: 2,
        reason: 'OWNER_WATCH_CONNECTED', updatedAt: new Date(0).toISOString(),
      }) + '\n',
      batches: [[], []], attempts: [connected],
    });
    await watch.channel.start();
    await vi.waitFor(() => expect(watch.client.watchCalls).toHaveLength(1));
    await vi.waitFor(() => expect(watch.readState().reason).toBe('OWNER_WATCH_CONNECTED'));
    await watch.channel.close();
    expect(watch.client.watchCalls[0]).toEqual({ identity: 'Role-owner', since: 0 });
    expect(watch.readState()).toMatchObject({ version: 2, reconnects: 4, consecutiveFailures: 0 });
    expect(watch.readState()).not.toHaveProperty('cursor');
  });

  it('retries every SDK error cause forever with capped exponential backoff', async () => {
    const failures = Array.from({ length: 8 }, (_, index) => async function* () {
      throw new Error(index % 2 ? 'HTTP 401 in opaque SDK prose' : 'transport reset');
    });
    const watch = watchSetup({ batches: Array.from({ length: 10 }, () => []), attempts: failures });
    await watch.channel.start();
    await vi.waitFor(() => expect(watch.client.watchCalls.length).toBeGreaterThanOrEqual(9));
    const state = watch.readState();
    await watch.channel.close();

    expect(watch.delays.slice(0, 8)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(state).toMatchObject({ version: 2, reconnects: 8, consecutiveFailures: 8 });
    expect(watch.logs.some(line => /AUTH_FAILED|AUTH_FATAL/.test(line))).toBe(false);
  });

  it('recovers invalid diagnostic state without weakening the drain-before-watch rule', async () => {
    const watch = watchSetup({
      watchState: '{"version":2,"reconnects":"broken"}\n', batches: [[], []],
      attempts: [async function* (options?: { signal?: AbortSignal }) {
        yield { event: 'message_received' };
        await new Promise<void>(resolve =>
          options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      }],
    });
    await watch.channel.start();
    await vi.waitFor(() => expect(watch.readState().reason).toBe('OWNER_WATCH_CONNECTED'));
    await watch.channel.close();
    expect(watch.logs.some(line => line.includes('OWNER_WATCH_STATE_RECOVERED'))).toBe(true);
    const calls = watch.client.calls.map(call => call.name);
    expect(calls.indexOf('listIncomingMessages')).toBeGreaterThan(calls.indexOf('registerCommands'));
    expect(watch.client.watchCalls[0]?.since).toBe(0);
  });

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
      // Persistent history supplies the stable wire and sequence idempotency key.
      msg_id: 3, wire_id: 'agent-sibling-wire', from: { id: AGENT },
      text: 'I found a useful unassigned Trello item.',
    }], []);
    await channel.drain();

    expect(queuePrompt).not.toHaveBeenCalled();
    expect(client.calls.filter(call => call.name === 'sendMessage').map(call => call.args))
      .toEqual(expect.arrayContaining([
        { contact: OWNER, text: 'The verification run is halfway complete.' },
        { contact: OWNER, text: 'I found a useful unassigned Trello item.' },
      ]));
    expect(client.calls.filter(call => call.name === 'sendMessage'
      && ['The verification run is halfway complete.', 'I found a useful unassigned Trello item.']
        .includes(String(call.args?.text)))
      .every(call => call.args?.replyToWireId === undefined)).toBe(true);
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
    const warning = client.calls.filter(call => call.name === 'sendMessage').at(-1)?.args;
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
    const sends = () => client.calls.filter(call => call.name === 'sendMessage').map(call => call.args);
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
    client.view = { ...client.view, contacts: [{ name: 'Phone', container_id: OWNER }], pending: [] };
    await channel.start();
    client.batches.push([{
      msg_id: 71, wire_id: 'agent-sole', from: { id: AGENT }, text: 'Sole owner note.',
    }], []);
    await channel.drain();
    const sends = client.calls.filter(call => call.name === 'sendMessage').map(call => call.args);
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
    const sends = () => client.calls.filter(call => call.name === 'sendMessage').map(call => call.args);
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
      replyToWireId: 'agent-unroutable',
    }]);
    // The body-free claim stays journaled and history-recoverable for replay.
    expect(readFileSync(join(dir, '.owner-channel-message-recovery.json'), 'utf8'))
      .toContain('agent-unroutable');
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
    const sends = () => client.calls.filter(call => call.name === 'sendMessage').map(call => call.args);
    expect(sends()).toEqual([{
      contact: AGENT, text: expect.stringContaining('was not relayed to an owner'),
      replyToWireId: 'agent-bad',
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
    const sends = () => client.calls.filter(call => call.name === 'sendMessage').map(call => call.args);
    expect(sends().filter(args => args?.contact === AGENT)).toEqual([{
      contact: AGENT, text: expect.stringContaining('uncertain'),
      replyToWireId: 'agent-uncertain',
    }]);
    expect(sends().filter(args => args?.contact === OWNER)).toHaveLength(1);
    // The uncertain outcome is terminal: a replayed copy never re-sends.
    client.batches.push([report], []);
    await channel.drain();
    expect(sends().filter(args => args?.contact === OWNER)).toHaveLength(1);
    await channel.close();
  });

  it('keeps command invocation silent and delivers only semantic lifecycle events', async () => {
    const { channel, client } = setup({ agent: AGENT });
    await channel.start();
    client.batches.push([{
      msg_id: 60, wire_id: 'owner-route-for-audit', from: { id: OWNER }, text: '/status',
    }], []);
    await channel.drain();
    const begun = await channel.beginFleetCommandAudit!('request-audit-1', [
      'task', 'create', '--title', 'Unicode Δ', '--brief', 'private',
    ]);
    const duplicate = await channel.beginFleetCommandAudit!('request-audit-1', [
      'task', 'create', '--title', 'Unicode Δ', '--brief', 'private',
    ]);
    expect(duplicate.correlationId).toBe(begun.correlationId);
    await channel.finishFleetCommandAudit!({ correlationId: begun.correlationId,
      class: 'success', effect: 'completed', exitCode: 0, resourceIds: { task: 'task-1' },
      presentations: [{ kind: 'task', operation: 'create', id: 'task-1', title: 'Unicode Δ',
        previousState: 'none', newState: 'active', revision: 'created-1', agents: [] }] });
    const retried = await channel.beginFleetCommandAudit!('request-audit-2', ['task', 'create']);
    await channel.finishFleetCommandAudit!({ correlationId: retried.correlationId,
      class: 'success', effect: 'completed', exitCode: 0, resourceIds: { task: 'task-1' },
      presentations: [
        { kind: 'task', operation: 'create', id: 'task-1', title: 'Unicode Δ',
          previousState: 'none', newState: 'active', revision: 'created-1', agents: [] },
        { kind: 'room', operation: 'create', id: 'room-1', name: 'Room Δ',
          previousState: 'none', newState: 'provisioning', revision: 'room-created-1', participants: [] },
      ] });
    const texts = client.calls.filter(call => call.name === 'sendMessage')
      .map(call => String(call.args?.text ?? ''));
    expect(texts.filter(text => text.includes('Fleet command'))).toEqual([]);
    expect(texts.filter(text => text.includes('🚀 Task started:'))).toEqual([
      expect.stringContaining('Unicode Δ'),
    ]);
    expect(texts.filter(text => text.startsWith('⏳ Room “'))).toEqual([
      expect.stringContaining('Room Δ'),
    ]);
    expect(texts.join('\n')).not.toContain('private');
    expect(texts.join('\n')).not.toContain('argv');
    await channel.close();
  });

  it('does not depend on Owner delivery for command invocation', async () => {
    const { channel, client, dir } = setup({ agent: AGENT });
    await channel.start();
    client.failSendTo.add(OWNER);
    await expect(channel.beginFleetCommandAudit!('request-uncertain', ['task', 'list']))
      .resolves.toMatchObject({ invocation: 'delivered' });
    client.failSendTo.clear();
    await expect(channel.beginFleetCommandAudit!('request-uncertain', ['task', 'list']))
      .resolves.toMatchObject({ invocation: 'delivered' });
    const ledger = JSON.parse(readFileSync(join(dir, '.owner-channel-command-audit.json'), 'utf8'));
    expect(ledger.attempts[0]).toMatchObject({ invocation: 'delivered' });
    expect(ledger.attempts[0]).not.toHaveProperty('outcome');
    expect(client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(0);
    await channel.close();
  });

  it('retains the same ledger before Owner startup and flushes only never-attempted lifecycle delivery', async () => {
    const { channel, client, dir } = setup({ agent: AGENT });
    const begun = await channel.beginFleetCommandAudit!('request-before-owner-start', ['task', 'list']);
    await expect(channel.finishFleetCommandAudit!({ correlationId: begun.correlationId,
      class: 'success', effect: 'completed', exitCode: 0,
      presentations: [{ kind: 'task', operation: 'create', eventId: 'startup-task-created',
        id: 'task-startup', previousState: 'none', newState: 'active', agents: [] }] }))
      .resolves.toMatchObject({ outcome: { delivery: 'sending' } });
    expect(client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(0);

    await channel.start();
    expect(client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(dir, '.owner-channel-command-audit.json'), 'utf8'));
    expect(ledger.attempts).toHaveLength(1);
    expect(ledger.attempts[0]).toMatchObject({ correlationId: begun.correlationId,
      outcome: { delivery: 'delivered' } });

    await channel.finishFleetCommandAudit!({ correlationId: begun.correlationId,
      class: 'success', effect: 'completed', exitCode: 0,
      presentations: [{ kind: 'task', operation: 'create', eventId: 'startup-task-created',
        id: 'task-startup', previousState: 'none', newState: 'active', agents: [] }] });
    expect(client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(1);
    await channel.close();
  });

  it('records outcome delivery uncertainty after a known completed effect without retry', async () => {
    const { channel, client, dir } = setup({ agent: AGENT });
    await channel.start();
    const begun = await channel.beginFleetCommandAudit!('request-finish-uncertain', ['task', 'list']);
    client.failSendTo.add(OWNER);
    await expect(channel.finishFleetCommandAudit!({ correlationId: begun.correlationId,
      class: 'success', effect: 'completed', exitCode: 0,
      presentations: [{ kind: 'task', operation: 'started', id: 'task-1',
        previousState: 'backlog', newState: 'active', agents: [] }] }))
      .resolves.toMatchObject({ outcome: { delivery: 'uncertain' } });
    client.failSendTo.clear();
    await expect(channel.finishFleetCommandAudit!({ correlationId: begun.correlationId,
      class: 'success', effect: 'completed', exitCode: 0,
      presentations: [{ kind: 'task', operation: 'started', id: 'task-1',
        previousState: 'backlog', newState: 'active', agents: [] }] }))
      .resolves.toMatchObject({ outcome: { delivery: 'uncertain' } });
    const ledger = JSON.parse(readFileSync(join(dir, '.owner-channel-command-audit.json'), 'utf8'));
    expect(ledger.attempts[0].outcome).toMatchObject({ effect: 'completed', delivery: 'uncertain' });
    expect(client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(1);
    await channel.close();
  });

  it('continues later lifecycle events after an uncertain duplicate while preserving aggregate uncertainty', async () => {
    const { channel, client } = setup({ agent: AGENT });
    await channel.start();
    const taskEvent = { kind: 'task' as const, operation: 'create' as const, eventId: 'task-created-1',
      id: 'task-1', title: 'Task', previousState: 'none', newState: 'provisioning', agents: [] };
    const first = await channel.beginFleetCommandAudit!('request-uncertain-event-1', ['task', 'create']);
    client.failSendTo.add(OWNER);
    await expect(channel.finishFleetCommandAudit!({ correlationId: first.correlationId,
      class: 'success', effect: 'completed', exitCode: 0, presentations: [taskEvent] }))
      .resolves.toMatchObject({ outcome: { delivery: 'uncertain' } });

    client.failSendTo.clear();
    const second = await channel.beginFleetCommandAudit!('request-uncertain-event-2', ['task', 'work']);
    await expect(channel.finishFleetCommandAudit!({ correlationId: second.correlationId,
      class: 'success', effect: 'completed', exitCode: 0, presentations: [taskEvent,
        { kind: 'room', operation: 'create', eventId: 'room-created-1', id: 'room-1',
          name: 'Room', previousState: 'none', newState: 'provisioning', participants: [] }] }))
      .resolves.toMatchObject({ outcome: { delivery: 'uncertain' } });
    const texts = client.calls.filter(call => call.name === 'sendMessage')
      .map(call => String(call.args?.text ?? ''));
    expect(texts.filter(text => text.includes('🚀 Task started:'))).toHaveLength(1);
    expect(texts.filter(text => text.startsWith('⏳ Room “'))).toHaveLength(1);
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
    expect(client.calls.filter(call => call.name === 'sendMessage')).toEqual([]);
    await channel.close();
  });

  // The legacy connector answered generate_invite with "One-time invite for X created
  // (invite_id …). Share this blob out-of-band …:\n<blob>" and no
  // structuredContent, so the transport returned that sentence and the whole
  // sentence was handed out as the invite. Rewording the daemon's prose changed
  // the payload; the blob field cannot.
  it('hands out the invite blob alone, never a sentence containing it', async () => {
    const { channel, client } = setup();
    await channel.start();
    client.generateInvite = async name => {
      client.calls.push({ name: 'generateInvite', args: { name } });
      return {
        blob: 'BLOB-ONLY-PAYLOAD',
        inviteId: 'invite-9',
        mode: 'one_time' as const,
      };
    };
    const invite = await channel.manage({ action: 'contact_invite', name: 'Mobile' });
    if (invite.action !== 'contact_invite') throw new Error('bad test response');
    expect(invite.invite).toBe('BLOB-ONLY-PAYLOAD');
    expect(invite.invite).not.toMatch(/invite_id|Share this blob|out-of-band/);
    await channel.close();
  });

  // list_contacts was prose too, so the JSON parse failed and the channel saw
  // an empty list: contact_list was always empty and owner_authorize could
  // never accept any CID. Both are structural now.
  it('lists and authorizes an established contact from the typed daemon view', async () => {
    const { channel, client } = setup();
    await channel.start();
    client.view = {
      contacts: [{ name: 'Phone', container_id: CONTACT }],
      pending: [{ name: 'Laptop', container_id: 'C'.repeat(64), queued: 2 }],
      roots: { [CONTACT]: { root_cid: 'D'.repeat(64), root_name: 'Human', role_id: 'r1' } },
      degraded: [], renames: {},
    };
    const listed = await channel.manage({ action: 'contact_list' });
    if (listed.action !== 'contact_list') throw new Error('bad test response');
    expect(listed.contacts).toEqual([
      {
        cid: CONTACT, name: 'Phone', status: 'established',
        human: { cid: 'D'.repeat(64), name: 'Human' },
      },
      { cid: 'C'.repeat(64), name: 'Laptop', status: 'pending' },
    ]);

    const authorized = await channel.manage({ action: 'owner_authorize', cid: CONTACT });
    if (authorized.action !== 'owner_authorize') throw new Error('bad test response');
    expect(authorized.owner.cid).toBe(CONTACT);
    // A pending introduction is still not an owner.
    await expect(channel.manage({ action: 'owner_authorize', cid: 'C'.repeat(64) }))
      .rejects.toThrow(/unknown or pending contact/);
    await channel.close();
  });

  // The handoff window used to open for any error whose text matched
  // /currently bound to another live session/i, so a relayed or wrapped message
  // carrying that wording could hold startup for the whole timeout.
  it('extends the bind handoff only for the daemon\'s own typed conflict code', async () => {
    const { channel, client, dir } = setup();
    writeFileSync(join(dir, '.owner-channel-binder.json'), JSON.stringify({
      version: 1, role: 'Role', identity: 'Role-owner', releasedAt: Date.now(),
    }));
    client.bindFailures = 1;
    client.bindError = () =>
      new Error('relayed: identity is currently bound to another live session');
    await expect(channel.start())
      .rejects.toThrow(/relayed: identity is currently bound to another live session/);
    expect(client.calls.filter(call => call.name === 'bindIdentity')).toHaveLength(1);
  });

  it('uses the already-bound client and never chooses or force-binds again', async () => {
    const { channel, client } = setup();
    await channel.start();
    const listed = await channel.manage({ action: 'contact_list' });
    expect(listed.action).toBe('contact_list');
    if (listed.action !== 'contact_list') throw new Error('bad test response');
    expect(listed.contacts[0]).toMatchObject({ cid: CONTACT, name: 'Phone', status: 'established' });
    expect(listed.contacts[0]).not.toHaveProperty('bio');
    expect(listed.contacts.map(contact => contact.status)).toEqual(['established', 'pending']);
    const invite = await channel.manage({ action: 'contact_invite', name: 'Mobile' });
    expect(invite).toEqual({ action: 'contact_invite', invite: 'mock-invite-blob' });
    expect(client.calls.filter(call => call.name === 'bindIdentity')).toEqual([
      { name: 'bindIdentity', args: { name: 'Role-owner' } },
    ]);
    expect(client.calls.some(call => call.args?.force !== undefined)).toBe(false);
    await channel.close();
  });

  it('retries a daemon lease only after evidence of its own released predecessor', async () => {
    const { channel, client, dir } = setup();
    writeFileSync(join(dir, '.owner-channel-binder.json'), JSON.stringify({
      version: 1, role: 'Role', identity: 'Role-owner', releasedAt: Date.now(),
    }));
    client.bindFailures = 2;
    await channel.start();
    expect(client.calls.filter(call => call.name === 'bindIdentity')).toEqual([
      { name: 'bindIdentity', args: { name: 'Role-owner' } },
      { name: 'bindIdentity', args: { name: 'Role-owner' } },
      { name: 'bindIdentity', args: { name: 'Role-owner' } },
    ]);
    expect(client.calls.some(call => call.args?.force !== undefined)).toBe(false);
    await channel.close();
  });

  it('does not retry or force-bind a live daemon holder without owned-handoff evidence', async () => {
    const { channel, client, dir } = setup();
    client.bindFailures = 100;
    await expect(channel.start()).rejects.toThrow(/currently bound to another live session/);
    expect(client.calls.filter(call => call.name === 'bindIdentity')).toHaveLength(1);
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
    const notices = client.calls.filter(call => call.name === 'sendMessage'
      && String(call.args?.text).includes('could not take over'));
    expect(notices).toEqual([{ name: 'sendMessage', args: {
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
    expect(client.calls.filter(call => call.name === 'sendMessage')).toEqual([]);
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
    expect(client.calls.filter(call => call.name === 'sendMessage'
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
    expect(client.calls.find(call => call.name === 'addContact')?.args)
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

  it('does not reflect invite material when the daemon rejects acceptance', async () => {
    const { channel, client } = setup();
    await channel.start();
    client.addContact = async () => { throw new Error('daemon echoed TOP_SECRET_INVITE'); };
    await expect(channel.manage({ action: 'contact_add', invite: 'TOP_SECRET_INVITE' }))
      .rejects.toThrow('the ours daemon could not accept the contact invite');
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

    // The prompt contained this hash only incidentally, as the last segment of the
    // outbox path it named. Agents are told not to send a request ID back, so the
    // prompt never owed them one. This test is about receipt/update/final ORDER;
    // manage() below still keys on the requestId, derived here rather than scraped.
    expect(queuePrompt.mock.calls[0][0]).toContain(wireId);
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
    await vi.waitFor(() => expect(client.calls.filter(call => call.name === 'sendMessage')
      .map(call => call.args?.text)).toEqual([
      'ℹ️ Message received. The agent has started working on this request now. '
        + 'The response will arrive in this channel when ready.',
      '🔄 Update: The implementation is complete and focused verification is running.',
      '🔐 Approval needed: Approval is needed before the dependency download can continue.',
      'Final answer',
    ]));
    expect(client.calls.filter(call => call.name === 'sendMessage')
      .every(call => call.args?.contact === OWNER && call.args?.replyToWireId === wireId)).toBe(true);
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
    expect(client.calls.filter(call => call.name === 'sendMessage')).toHaveLength(2);
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
    const updates = client.calls.filter(call => call.name === 'sendMessage'
      && String(call.args?.text).match(/^(?:🔄|🚧)/));
    expect(updates.map(call => [call.args?.contact, call.args?.replyToWireId])).toEqual([
      [OWNER, wires[0]], [CONTACT, wires[1]],
    ]);
    await channel.close();
  });

  it('opens only during the exact active request and routes a later report to that origin', async () => {
    const { channel, client, queuePrompt } = setup();
    let releaseFinalSends!: () => void;
    const finalSendsReleased = new Promise<void>(resolve => { releaseFinalSends = resolve; });
    client.sendGate = async args => {
      if (args.text.startsWith('Original final')) await finalSendsReleased;
    };
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
    await vi.waitFor(() => expect(client.calls.filter(call => call.name === 'sendMessage'
      && String(call.args?.text).startsWith('Original final'))).toHaveLength(2));
    // Recording the send call is not finalization: the transport promise and
    // complete(...).finally() are still pending, so the production guard must hold.
    await expect(channel.manage({ action: 'task_report', taskId: openedB.taskId,
      phase: 'done', message: 'The second specialist finished.' }))
      .rejects.toThrow(/only after.*finalized/);
    releaseFinalSends();
    await vi.waitFor(async () => {
      await expect(channel.manage({ action: 'task_report', taskId: openedB.taskId,
        phase: 'done', message: 'The second specialist finished.' })).resolves.toMatchObject({
        action: 'task_report', phase: 'done', state: 'closed',
      });
    });
    await vi.waitFor(async () => {
      await expect(channel.manage({ action: 'task_report', taskId: openedA.taskId,
        phase: 'blocked', message: 'The first specialist needs an external dependency.' }))
        .resolves.toMatchObject({ action: 'task_report', phase: 'blocked', state: 'closed' });
    });
    const reports = client.calls.filter(call => call.name === 'sendMessage'
      && String(call.args?.text).includes('Follow-up'));
    expect(reports.map(call => call.args)).toEqual([
      { contact: CONTACT, replyToWireId: wireB,
        text: '✅ Follow-up complete: The second specialist finished.' },
      { contact: OWNER, replyToWireId: wireA,
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
    });
    await restarted.start();
    await restarted.manage({ action: 'task_report', taskId: opened.taskId,
      phase: 'done', message: 'Restarted supervisor delivered the verified result.' });
    expect(restartedClient.calls).toContainEqual({ name: 'sendMessage', args: {
      contact: OWNER, replyToWireId: wire,
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

    const originalSend = client.sendMessage.bind(client);
    let attempted = 0;
    client.sendMessage = async a => {
      if (a.text.includes('Follow-up complete')) {
        attempted++;
        throw new Error('ambiguous transport failure with secret details');
      }
      return originalSend(a);
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
