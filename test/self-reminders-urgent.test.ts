import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ReminderManager } from '../src/reminders/manager.js';
import { ReminderStore, removeReminderState, type ReminderOwner } from '../src/reminders/store.js';
import { registerReminderTools } from '../src/reminders/tools.js';
import { AcpSession } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import { CodexAppServerSession } from '../src/session/codex-app-server.js';
import { turnResult, type AgentSession, type PromptOrigin, type QueuedPrompt } from '../src/session/types.js';
import { FakeAppServer } from './fixtures/codex-app-server.js';

/**
 * Urgent (`interrupt: true`) self-reminders over the real session
 * implementations of both managed backends: the ACP client against the ACP
 * fixture adapter, and the native Codex app-server client against its fixture
 * server. These are protocol fixtures, not provider acceptance: they prove the
 * supervisor-side contract (one exact-target cancellation, terminal
 * correlation, guarded release, ordering), and that the interrupted prompt is
 * still part of what the fixture received — not how a real provider repairs
 * its transcript after a cancelled tool call.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const OWNER: ReminderOwner = { role: 'Dev', lifetime: 'temporary', instance: 'inst-1', cid: 'D'.repeat(64), action: 'act-1' };
const T0 = Date.parse('2027-01-20T12:00:00Z');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const until = async (ready: () => boolean, what = 'condition', tries = 500) => {
  for (let i = 0; i < tries && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!ready()) throw new Error(`${what} not reached`);
};

type BusyKind = 'interruptible' | 'stubborn' | 'permission';

interface Harness {
  session: AgentSession;
  /** Prompt texts the model received, one entry per adapter turn. */
  modelTurns(): string[][];
  /** Text of a prompt that keeps the session busy in the given way. */
  busyText(kind: BusyKind): string;
  /** End a held turn on its own (not through a cancellation). */
  releaseHold(): void;
  /** Keep every following reminder-wake turn running until `releaseHold`. */
  holdReminderTurns(): void;
  /** Answer a pending permission so its turn can finish. */
  allowPermission(): void;
}

async function acpHarness(dir: string): Promise<Harness> {
  const hold = join(dir, 'hold');
  const log = join(dir, 'requests.jsonl');
  const session = await AcpSession.start({
    name: 'Dev', argv: [process.execPath, fixture], cwd: dir, stateDir: dir, mode: 'fresh',
    env: { ACP_FIXTURE_PROMPT_HOLD_FILE: hold, ACP_FIXTURE_REQUEST_JSON_LOG: log },
    permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
    log: () => {}, cancelGraceMs: 400, cancelTerminateGraceMs: 300,
  });
  cleanup.push(() => session.close().catch(() => {}));
  return {
    session,
    modelTurns: () => !existsSync(log) ? [] : readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(entry => entry.method === 'session/prompt')
      .map(entry => (entry.prompt as Array<{ type: string; text?: string }>)
        .filter(block => block.type === 'text').map(block => block.text!)),
    // `late` starts a tool call and only a session/cancel ends the turn.
    busyText: kind => {
      if (kind === 'stubborn') writeFileSync(hold, '');
      return kind === 'interruptible' ? 'late mail work' : kind === 'stubborn' ? 'stubborn mail work' : 'permission mail work';
    },
    releaseHold: () => rmSync(hold, { force: true }),
    // The ACP fixture holds every prompt while the file exists.
    holdReminderTurns: () => writeFileSync(hold, ''),
    allowPermission: () => {
      const id = session.snapshot().pendingPermissionId!;
      if (!session.respondPermission(id, 'allow')) session.respondPermission(id, 'allow_once');
    },
  };
}

async function codexHarness(dir: string): Promise<Harness> {
  let server!: FakeAppServer;
  const session = await CodexAppServerSession.start({
    name: 'Dev', argv: ['codex', 'app-server'], cwd: dir, env: {}, stateDir: dir, mode: 'fresh',
    permissions: { approval: 'ask', filesystem: 'workspace', unattended: 'wait' },
    permissionMode: { fleetMode: 'ask', nativeMode: 'untrusted' },
    model: 'gpt-fixture', effort: 'medium', approvalPolicy: 'untrusted', sandbox: 'workspace-write',
    log: () => {}, interruptSettleMs: 300, interruptTerminateGraceMs: 200,
  }, async options => (server = new FakeAppServer(options)));
  cleanup.push(() => session.close().catch(() => {}));
  return {
    session,
    modelTurns: () => server.requests.filter(request => request.method === 'turn/start')
      .map(request => (request.params.input as Array<{ text: string }>).map(item => item.text)),
    busyText: kind => kind === 'interruptible' ? 'hold running mail work'
      : kind === 'stubborn' ? 'ignore interrupt mail work' : 'permission mail work',
    releaseHold: () => server.finishHeld(),
    holdReminderTurns: () => { server.holdMatching = text => text.startsWith('[fleet-reminder]'); },
    allowPermission: () => { session.respondPermission(session.snapshot().pendingPermissionId!, 'allow_once'); },
  };
}

async function supervisor(start: (dir: string) => Promise<Harness>) {
  const dir = mkdtempSync(join(tmpdir(), 'rem-urgent-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const harness = await start(dir);
  const clock = { now: T0 };
  const logs: string[] = [];
  const arbiter = new RoleTurnArbiter(harness.session);
  const open = () => {
    const store = new ReminderStore(dir, OWNER, () => clock.now, line => logs.push(line));
    const manager = new ReminderManager('Dev', store, arbiter, {
      now: () => clock.now, log: line => logs.push(line),
      setTimer: () => ({}), clearTimer: () => {},
    });
    return { store, manager };
  };
  let current = open();
  const server = new McpServer({ name: 'ours', version: 'test' });
  registerReminderTools(server, () => ({ store: current.store, changed: () => current.manager.changed() }), async () => () => {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agent', version: 'test' });
  await client.connect(clientSide);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: Boolean(result.isError), value: JSON.parse(result.content[0]!.text) };
  };
  const reminderTurns = () => harness.modelTurns().filter(turn => turn.some(text => text.startsWith('[fleet-reminder]')));
  const create = async (key: string, extra: Record<string, unknown> = {}) => {
    const created = await call('fleet_reminder_create', {
      request_key: key, title: key, local_time: '2027-01-20T13:00', time_zone: 'UTC', ...extra,
    });
    expect(created.isError).toBe(false);
    return created.value.reminder as { id: string; due_at: string; interrupt: boolean };
  };
  /** Start busy work through the arbiter, as the runner's producers do. */
  const busy = async (kind: BusyKind, origin: PromptOrigin = { kind: 'fleet-monitor' }) => {
    const queued = await arbiter.queuePrompt(harness.busyText(kind), { origin });
    await until(() => kind === 'permission'
      ? harness.session.snapshot().readiness === 'awaiting_permission'
      : harness.session.snapshot().readiness === 'running', 'busy session');
    return queued;
  };
  const eventOf = (id: string) => current.store.list({ state: 'all' }).reminders.find(item => item.id === id)!.event;
  return {
    dir, harness, clock, logs, arbiter, call, create, busy, reminderTurns, eventOf,
    get store() { return current.store; },
    get manager() { return current.manager; },
    restart() { current.manager.stop(); current = open(); return current; },
  };
}

const harnesses: Array<[string, (dir: string) => Promise<Harness>]> = [
  ['ACP (Claude/ACP adapters)', acpHarness],
  ['native Codex app-server', codexHarness],
];

describe.each(harnesses)('urgent self-reminders over %s', (_label, start) => {
  it('interrupts the exact busy mail-work turn once, correlates its terminal and wakes in the same session', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const reminder = await s.create('urgent', { interrupt: true });
    expect(reminder.interrupt).toBe(true);
    const work = await s.busy('interruptible');
    s.clock.now = Date.parse(reminder.due_at);
    await s.manager.poll();

    // The interrupted turn's own terminal result names this request.
    const interrupted = await work.completion;
    expect(interrupted).toMatchObject({ outcome: 'cancelled', cancellationSource: 'self-reminder' });
    await until(() => s.reminderTurns().length === 1, 'urgent wake');
    const [turn] = s.reminderTurns();
    expect(turn).toHaveLength(1);
    expect(turn![0]).toContain('urgent: true');
    expect(turn![0]).toContain('previous fleet-monitor turn was cancelled for this wake');
    // The earlier prompt reached the same session before the wake (fixture
    // request log; not evidence of provider-side transcript repair).
    const turns = s.harness.modelTurns();
    expect(turns.findIndex(item => item.some(text => text.includes('mail work'))))
      .toBeLessThan(turns.findIndex(item => item.some(text => text.startsWith('[fleet-reminder]'))));

    const eventId = /event_id: (\S+)/.exec(turn![0]!)![1]!;
    // The persisted target is the exact interrupted prompt of this session generation.
    const persisted = JSON.parse(readFileSync(s.store.path, 'utf8')).events[eventId].interrupt.target;
    expect(persisted).toMatchObject({
      source: 'fleet-monitor', promptId: work.promptId,
      generation: s.harness.session.conversationSnapshot!().sessionGeneration,
    });
    const inspected = (await s.call('fleet_reminder_inspect', { event_id: eventId })).value;
    expect(inspected).toMatchObject({
      eligible: true, reminder: { interrupt: true },
      event: { state: 'dispatched', interrupt: { state: 'cancelled', target_source: 'fleet-monitor' } },
    });
    expect((await s.call('fleet_reminder_ack', { event_id: eventId, expected_revision: 1 })).value.acknowledged).toBe(true);
    // Exactly one wake, and no further cancellation on later polls.
    for (let i = 0; i < 3; i++) { s.clock.now += 60_000; await s.manager.poll(); }
    expect(s.reminderTurns()).toHaveLength(1);
  });

  it('defers instead of cancelling owner work or a pending permission, and says why', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const reminder = await s.create('urgent', { interrupt: true });
    const owner = await s.busy('permission', { kind: 'owner', requestId: 'req-1' });
    s.clock.now = Date.parse(reminder.due_at);
    await s.manager.poll();
    await s.manager.poll();
    expect(s.reminderTurns()).toEqual([]);
    expect(s.eventOf(reminder.id)).toMatchObject({ state: 'pending' });
    const eventId = s.eventOf(reminder.id)!.id;
    expect((await s.call('fleet_reminder_inspect', { event_id: eventId })).value.event)
      .toMatchObject({ interrupt_deferred: 'permission_pending' });
    expect((await s.call('fleet_reminder_inspect', { event_id: eventId })).value.event.interrupt).toBeUndefined();
    s.harness.allowPermission();
    expect((await owner.completion).outcome).toBe('completed');
    await until(() => s.harness.session.snapshot().readiness === 'idle', 'idle');
    await s.manager.poll();
    await until(() => s.reminderTurns().length === 1, 'idle-boundary wake');
    expect(s.reminderTurns()[0]![0]).not.toContain('interrupt:');
  });

  it('never queues the wake after a forced or failed cancellation and never asks twice', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const reminder = await s.create('urgent', { interrupt: true, late_window_seconds: 7200 });
    const work = await s.busy('stubborn');
    s.clock.now = Date.parse(reminder.due_at);
    await s.manager.poll();
    await work.completion;
    const event = s.eventOf(reminder.id)!;
    const inspected = (await s.call('fleet_reminder_inspect', { event_id: event.id })).value.event;
    expect(inspected.interrupt.state).toMatch(/^(forced|failed)$/);
    expect(inspected.state).toBe('pending');
    expect(s.reminderTurns()).toEqual([]);
    expect(s.store.mayInterrupt(event.id)).toBe(false);
    s.harness.releaseHold();
  });

  it('lets owner input that arrives during the cancellation run first, then wakes at the idle boundary', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const reminder = await s.create('urgent', { interrupt: true });
    await s.busy('interruptible');
    s.clock.now = Date.parse(reminder.due_at);
    let ownerPrompt: Promise<QueuedPrompt> | undefined;
    const mark = s.store.markInterruptRequested.bind(s.store);
    s.store.markInterruptRequested = (id, target) => {
      const marked = mark(id, target);
      // Arrives while the session is being asked to stop.
      ownerPrompt = s.arbiter.queuePrompt('owner follow-up', { origin: { kind: 'owner', requestId: 'req-2' } });
      return marked;
    };
    await s.manager.poll();
    const owner = await ownerPrompt!;
    expect((await owner.completion).outcome).toBe('completed');
    expect(s.eventOf(reminder.id)).toMatchObject({ interrupt_state: 'cancelled' });
    // Owner won the boundary. Whether the wake was queued right after the
    // owner turn (it finished first) or found the role busy and waits for the
    // next idle boundary, it never ran before the owner prompt.
    await until(() => s.harness.session.snapshot().readiness === 'idle', 'idle');
    await s.manager.poll();
    await until(() => s.reminderTurns().length === 1, 'wake after owner turn');
    const order = s.harness.modelTurns();
    expect(order.findIndex(item => item.includes('owner follow-up')))
      .toBeLessThan(order.findIndex(item => item.some(text => text.startsWith('[fleet-reminder]'))));
  });

  it('fences the release when the reminder is cancelled while the cancellation is in flight', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const reminder = await s.create('urgent', { interrupt: true });
    await s.busy('interruptible');
    s.clock.now = Date.parse(reminder.due_at);
    const mark = s.store.markInterruptRequested.bind(s.store);
    s.store.markInterruptRequested = (id, target) => {
      const marked = mark(id, target);
      s.store.cancel(reminder.id, 1);
      return marked;
    };
    await s.manager.poll();
    await until(() => s.harness.session.snapshot().readiness === 'idle', 'idle');
    for (let i = 0; i < 2; i++) await s.manager.poll();
    expect(s.reminderTurns()).toEqual([]);
    expect(s.store.list({ state: 'all' }).reminders[0]).toMatchObject({ state: 'cancelled' });
  });

  it('a spent urgent event left undispatched by a restart never hides a fresh urgent one', async () => {
    const s = await supervisor(start);
    const spent = await s.create('spent', { interrupt: true });
    const fresh = await s.create('fresh', { interrupt: true, local_time: '2027-01-20T13:00:30' });
    // The older urgent event asked to interrupt, then the supervisor restarted
    // before the outcome: it is pending, idle-only, with outcome unknown.
    s.clock.now = Date.parse(spent.due_at);
    const [old] = s.store.sweep();
    s.store.markAdmitting(old!.id);
    s.store.markInterruptRequested(old!.id, { source: 'fleet-monitor', promptId: 'gone', generation: 'old' });
    const restarted = s.restart();
    expect(restarted.store.inspect(old!.id).event).toMatchObject({ state: 'pending', interrupt: { state: 'unknown' } });
    restarted.manager.start();
    const work = await s.busy('interruptible');
    s.clock.now = Date.parse(fresh.due_at) + 1_000;
    await restarted.manager.poll();
    // The fresh one interrupts the busy mail work and is delivered first.
    expect(await work.completion).toMatchObject({ outcome: 'cancelled', cancellationSource: 'self-reminder' });
    await until(() => s.reminderTurns().length >= 1, 'fresh urgent wake');
    expect(s.reminderTurns()[0]![0]).toContain('title: "fresh"');
    expect(s.eventOf(fresh.id)).toMatchObject({ interrupt_state: 'cancelled' });
    // The spent one never asked again; it follows idle-only.
    await until(() => s.harness.session.snapshot().readiness === 'idle', 'idle');
    await restarted.manager.poll();
    await until(() => s.reminderTurns().length === 2, 'spent wake, idle-only');
    expect(s.reminderTurns()[1]![0]).toContain('title: "spent"');
    expect(s.reminderTurns()[1]![0]).toContain('outcome is unknown (unknown)');
    expect(s.harness.session.conversationPage!({ limit: 500 }).events
      .filter(item => item.kind === 'prompt.interrupt_requested')).toHaveLength(1);
  });

  it('keeps a RUNNING reminder turn intact against a second urgent reminder and an interrupting mail-wake retry', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const first = await s.create('first', { interrupt: true });
    await s.create('second', { interrupt: true, local_time: '2027-01-20T13:00:01' });
    await s.busy('interruptible');
    s.harness.holdReminderTurns();
    s.clock.now = Date.parse(first.due_at) + 2_000;
    await s.manager.poll();
    await until(() => s.reminderTurns().length === 1, 'first wake');
    await until(() => s.harness.session.snapshot().activePromptSource === 'self-reminder', 'running reminder turn');

    // The monitor retries its cancelled wake with its interrupt policy, and the
    // second urgent reminder comes due, while the first reminder turn runs.
    const retry = s.arbiter.submitPrompt('[fleet-monitor] retried wake', {
      origin: { kind: 'fleet-monitor' }, interrupt: true, interruptSource: 'fleet-monitor', steer: true,
    });
    await s.manager.poll();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.harness.session.snapshot().activePromptSource).toBe('self-reminder');
    expect(s.harness.modelTurns().flat()).not.toContain('[fleet-monitor] retried wake');

    // The agent handles its wake inside the still-running turn.
    const eventId = /event_id: (\S+)/.exec(s.reminderTurns()[0]![0]!)![1]!;
    expect((await s.call('fleet_reminder_inspect', { event_id: eventId })).value).toMatchObject({ eligible: true });
    expect((await s.call('fleet_reminder_ack', { event_id: eventId, expected_revision: 1 })).value.acknowledged).toBe(true);
    expect(s.harness.modelTurns().flat()).not.toContain('[fleet-monitor] retried wake');

    // Only now does the reminder turn end, on its own; the retry runs after it.
    s.harness.releaseHold();
    await until(() => s.harness.modelTurns().flat().includes('[fleet-monitor] retried wake'), 'retried wake');
    s.harness.releaseHold();
    expect((await retry).outcome).toBe('completed');
    await until(() => s.harness.session.snapshot().readiness === 'idle', 'idle');
    await s.manager.poll();
    await until(() => s.reminderTurns().length === 2, 'second wake');
    s.harness.releaseHold();

    // Exactly one interruption was ever requested: the first urgent reminder's,
    // of the mail-work turn. Nothing asked a reminder turn to stop.
    const requested = s.harness.session.conversationPage!({ limit: 500 }).events
      .filter(item => item.kind === 'prompt.interrupt_requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]!.payload).toMatchObject({ cancellationSource: 'self-reminder' });
    const order = s.harness.modelTurns();
    const firstWake = order.findIndex(item => item.some(text => text.includes(`event_id: ${eventId}`)));
    expect(firstWake).toBeLessThan(order.findIndex(item => item.includes('[fleet-monitor] retried wake')));
  });
});

describe('urgent self-reminder state', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'rem-urgent-store-')); dirs.push(dir); return dir; };

  it('keeps old stores and retried pre-urgency calls compatible and validates the flag', () => {
    const dir = fresh();
    const clock = { now: T0 };
    const store = new ReminderStore(dir, OWNER, () => clock.now);
    const input = { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC' };
    const plain = store.create('k', input).reminder;
    expect(plain.interrupt).toBe(false);
    // A retry with interrupt omitted or false is the same request…
    expect(store.create('k', { ...input, interrupt: false }).created).toBe(false);
    // …an urgent one is a different request under the same key.
    expect(() => store.create('k', { ...input, interrupt: true })).toThrow(/request_key/);
    expect(() => store.create('x', { ...input, interrupt: 'yes' })).toThrow(/interrupt must be/);
    // Nothing urgent is written for an ordinary reminder.
    expect(readFileSync(store.path, 'utf8')).not.toContain('"interrupt"');
    const updated = store.update(plain.id, 1, { interrupt: true });
    expect(updated).toMatchObject({ revision: 2, interrupt: true });
    expect(store.update(plain.id, 2, { title: 'renamed' }).interrupt).toBe(true);   // kept unless changed
    expect(store.update(plain.id, 3, { interrupt: false }).interrupt).toBe(false);
    // A store with no urgency anywhere (written before it existed) loads unchanged.
    const reopened = new ReminderStore(dir, OWNER, () => clock.now);
    expect(reopened.list().reminders[0]).toMatchObject({ interrupt: false, revision: 4 });
  });

  it('records the request before cancelling, reports an unknown outcome after restart and never asks again', () => {
    const dir = fresh();
    const clock = { now: T0 };
    const store = new ReminderStore(dir, OWNER, () => clock.now);
    const { reminder } = store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC', interrupt: true });
    clock.now = Date.parse(reminder.due_at);
    const [event] = store.sweep();
    expect(store.markInterruptRequested(event!.id, { source: 'fleet-monitor', promptId: 'p-1', generation: 'g-1' })).toBe(false);   // not claimed yet
    expect(store.markAdmitting(event!.id)).toBe(true);
    // A target that does not name the exact turn is refused.
    expect(store.markInterruptRequested(event!.id, { source: 'fleet-monitor', promptId: '', generation: 'g-1' })).toBe(false);
    expect(store.markInterruptRequested(event!.id,
      { source: 'fleet-monitor', promptId: 'p-active', generation: 'gen-7', sessionId: 's1' })).toBe(true);
    expect(store.markInterruptRequested(event!.id, { source: 'fleet-monitor', promptId: 'p-1', generation: 'g-1' })).toBe(false);
    // Supervisor dies before the outcome is known.
    const restarted = new ReminderStore(dir, OWNER, () => clock.now);
    const view = restarted.inspect(event!.id).event;
    expect(view).toMatchObject({ state: 'pending', interrupt: {
      state: 'unknown', reason: 'restarted_before_outcome',
      target: { source: 'fleet-monitor', prompt_id: 'p-active', generation: 'gen-7', session_id: 's1' },
    } });
    // The exact target is on disk, not only in memory.
    const onDisk = JSON.parse(readFileSync(restarted.path, 'utf8')).events[event!.id].interrupt.target;
    expect(onDisk).toEqual({ source: 'fleet-monitor', promptId: 'p-active', generation: 'gen-7', sessionId: 's1' });
    restarted.markAdmitting(event!.id);
    expect(restarted.mayInterrupt(event!.id)).toBe(false);
  });

  it('refuses to cancel when the request cannot be recorded, and refuses dispatch when it cannot be recorded', () => {
    const dir = fresh();
    const clock = { now: T0 };
    const io = { fail: false };
    const store = new ReminderStore(dir, OWNER, () => clock.now, () => {}, (path, contents) => {
      if (io.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      writeFileSync(path, contents, { mode: 0o600 });
    });
    const { reminder } = store.create('k', { title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC', interrupt: true });
    clock.now = Date.parse(reminder.due_at);
    const [event] = store.sweep();
    store.markAdmitting(event!.id);
    io.fail = true;
    expect(store.markInterruptRequested(event!.id, { source: 'fleet-monitor', promptId: 'p-1', generation: 'g-1' })).toBe(false);
    expect(store.mayInterrupt(event!.id)).toBe(true);           // a failed mark does not consume it
    expect(store.claimDispatch(event!.id, false)).toEqual({ dispatch: false, reason: 'dispatch_commit_failed' });
    io.fail = false;
    expect(store.inspect(event!.id).event.state).toBe('admitting');
  });

  it('considers a fresh urgent reminder before an older urgent one whose interruption is spent', async () => {
    const dir = fresh();
    const clock = { now: T0 };
    const store = new ReminderStore(dir, OWNER, () => clock.now);
    store.create('spent', { title: 'spent', local_time: '2027-01-20T12:30', time_zone: 'UTC', interrupt: true });
    clock.now = Date.parse('2027-01-20T12:31:00Z');
    const [old] = store.sweep();
    store.markAdmitting(old!.id);
    store.markInterruptRequested(old!.id, { source: 'fleet-monitor', promptId: 'p', generation: 'g' });
    store.recordInterruptOutcome(old!.id, 'failed', 'control_error');
    store.releaseUndispatched(old!.id, clock.now);
    store.create('fresh', { title: 'fresh', local_time: '2027-01-20T12:45', time_zone: 'UTC', interrupt: true });
    clock.now = Date.parse('2027-01-20T13:00:00Z');
    const seen: string[] = [];
    const manager = new ReminderManager('Dev', store, {
      async tryReminder() { throw new Error('urgent reminders use the urgent path'); },
      async tryUrgentReminder(_origin, hooks) { seen.push(/title: "(\w+)"/.exec(hooks.text())![1]!); return { state: 'busy' }; },
    }, { now: () => clock.now, log: () => {}, setTimer: () => ({}), clearTimer: () => {} });
    manager.start();
    await manager.poll();
    expect(seen).toEqual(['fresh']);
  });

  it('considers a due urgent reminder before an older ordinary one held by a busy role', async () => {
    const dir = fresh();
    const clock = { now: T0 };
    const store = new ReminderStore(dir, OWNER, () => clock.now);
    store.create('plain', { title: 'plain', local_time: '2027-01-20T12:30', time_zone: 'UTC' });
    store.create('urgent', { title: 'urgent', local_time: '2027-01-20T12:45', time_zone: 'UTC', interrupt: true });
    clock.now = Date.parse('2027-01-20T13:00:00Z');
    const seen: string[] = [];
    const manager = new ReminderManager('Dev', store, {
      async tryReminder(text) { seen.push(`idle:${/title: "(\w+)"/.exec(text)![1]}`); return { state: 'busy' }; },
      async tryUrgentReminder(_origin, hooks) { seen.push(`urgent:${/title: "(\w+)"/.exec(hooks.text())![1]}`); return { state: 'busy' }; },
    }, { now: () => clock.now, log: () => {}, setTimer: () => ({}), clearTimer: () => {} });
    manager.start();
    await manager.poll();
    expect(seen).toEqual(['urgent:urgent']);
  });
});

describe('RoleTurnArbiter urgent admission rules', () => {
  /** A minimal session whose turn state the test sets directly. */
  function fakeSession(state: {
    readiness: 'idle' | 'running' | 'awaiting_permission';
    source?: PromptOrigin['kind']; pendingPrompts?: number; interrupts?: number;
  }) {
    const queued: Array<{ text: string; interrupt?: boolean; steer?: boolean }> = [];
    const session = {
      backend: 'acp', pid: 1, capabilities: { interrupt: true },
      snapshot: () => ({ backend: 'acp', alive: true, readiness: state.readiness,
        ...(state.source ? { activePromptSource: state.source } : {}) }),
      observeConversation: () => ({
        snapshot: { sessionGeneration: 'g1', activePromptIds: state.source ? ['p-active'] : [],
          pendingPromptCount: state.pendingPrompts ?? 0, queueDepth: state.source ? 1 : 0,
          pendingPermissions: [], pendingPermissionIds: [] },
        unsubscribe: () => {},
      }),
      interrupt: async () => { state.interrupts = (state.interrupts ?? 0) + 1; return { state: 'settled' as const }; },
      queuePrompt: async (text: string, options: { interrupt?: boolean; steer?: boolean } = {}) => {
        queued.push({ text, interrupt: options.interrupt, steer: options.steer });
        return { promptId: `q${queued.length}`, queuedBehind: 0, completion: new Promise<never>(() => {}) };
      },
    } as unknown as AgentSession;
    return { session, queued, state };
  }
  const hooks = (deferrals: string[]) => ({
    beforeQueue: () => true, releaseGuard: () => true, mayInterrupt: () => true,
    markRequested: () => true, recordOutcome: () => {}, deferred: (reason: string) => { deferrals.push(reason); },
    stillAdmitting: () => true, text: () => '[fleet-reminder] x',
  });
  const origin = { kind: 'self-reminder' as const, eventId: 'e', reminderId: 'r', revision: 1 };

  it('downgrades an interrupting mail wake to a queued one while a reminder turn runs', async () => {
    const { session, queued } = fakeSession({ readiness: 'running', source: 'self-reminder' });
    await new RoleTurnArbiter(session).queuePrompt('[fleet-monitor] wake', {
      origin: { kind: 'fleet-monitor' }, interrupt: true, steer: true,
    });
    expect(queued).toEqual([{ text: '[fleet-monitor] wake', interrupt: false, steer: false }]);
  });

  it.each([
    [{ readiness: 'running' as const, source: 'owner' as const }, 'protected_turn'],
    [{ readiness: 'running' as const, source: 'owner-admin-console' as const }, 'protected_turn'],
    [{ readiness: 'running' as const, source: 'startup' as const }, 'protected_turn'],
    [{ readiness: 'running' as const, source: 'self-reminder' as const }, 'protected_turn'],
    [{ readiness: 'running' as const }, 'untracked_turn'],
    [{ readiness: 'awaiting_permission' as const, source: 'fleet-monitor' as const }, 'permission_pending'],
    [{ readiness: 'running' as const, source: 'fleet-monitor' as const, pendingPrompts: 1 }, 'queued_work'],
  ])('defers without cancelling for %j', async (state, reason) => {
    const fake = fakeSession(state);
    const deferrals: string[] = [];
    const attempt = await new RoleTurnArbiter(fake.session).tryUrgentReminder(origin, hooks(deferrals));
    expect(attempt.state).toBe('busy');
    expect(deferrals).toEqual([reason]);
    expect(fake.state.interrupts ?? 0).toBe(0);
    expect(fake.queued).toEqual([]);
  });

  it('defers once its single interruption was used', async () => {
    const fake = fakeSession({ readiness: 'running', source: 'fleet-monitor' });
    const deferrals: string[] = [];
    const attempt = await new RoleTurnArbiter(fake.session)
      .tryUrgentReminder(origin, { ...hooks(deferrals), mayInterrupt: () => false });
    expect(attempt.state).toBe('busy');
    expect(deferrals).toEqual(['interrupt_already_used']);
    expect(fake.state.interrupts ?? 0).toBe(0);
  });

  it('does not cancel when the request cannot be recorded first', async () => {
    const fake = fakeSession({ readiness: 'running', source: 'fleet-monitor' });
    const attempt = await new RoleTurnArbiter(fake.session)
      .tryUrgentReminder(origin, { ...hooks([]), markRequested: () => false });
    expect(attempt).toMatchObject({ state: 'unavailable' });
    expect(fake.state.interrupts ?? 0).toBe(0);
  });

  it('is exactly tryReminder when the role is idle', async () => {
    const fake = fakeSession({ readiness: 'idle' });
    const attempt = await new RoleTurnArbiter(fake.session).tryUrgentReminder(origin, hooks([]));
    expect(attempt.state).toBe('admitted');
    expect(fake.queued).toEqual([{ text: '[fleet-reminder] x', interrupt: false, steer: false }]);
    expect(fake.state.interrupts ?? 0).toBe(0);
  });
});

describe('peer-wait reminder lifecycle (Developer/Critic guidance)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** An idle agent whose every admitted wake is released to the model through the guard. */
  function agent() {
    const dir = mkdtempSync(join(tmpdir(), 'rem-peer-wait-')); dirs.push(dir);
    const clock = { now: T0 };
    const wakes: string[] = [];
    const timers: number[] = [];
    let store = new ReminderStore(dir, OWNER, () => clock.now);
    const managerFor = (target: ReminderStore) => new ReminderManager('Dev', target, {
      async tryReminder(text, _origin, beforeQueue, releaseGuard) {
        if (!beforeQueue()) return { state: 'unavailable', error: 'declined', admitted: false };
        const released = releaseGuard();
        if (released) wakes.push(text);
        return { state: 'admitted', queued: { promptId: `p${wakes.length}`, queuedBehind: 0,
          completion: Promise.resolve(turnResult(true, released ? 'completed' : 'cancelled')) } };
      },
    }, { now: () => clock.now, log: () => {}, setTimer: (_cb, ms) => { timers.push(ms); return ms; }, clearTimer: () => {} });
    let manager = managerFor(store);
    manager.start();
    /** Arm the one reminder the guidance asks for: ~20 minutes, idle-only. */
    const arm = (key: string, minutes = 20) => store.create(key, {
      title: `PR 412: waiting on ${key}`, note: 'PR 412 room: Critic FINAL on head 1a2b3c',
      local_time: new Date(clock.now + minutes * 60_000).toISOString().slice(0, 16), time_zone: 'UTC',
    }).reminder;
    const advance = async (minutes: number) => {
      clock.now += minutes * 60_000;
      await manager.poll();
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    return {
      dir, clock, wakes, timers, arm, advance,
      get store() { return store; }, get manager() { return manager; },
      retire() { manager.stop(); removeReminderState(dir); store = new ReminderStore(dir, OWNER, () => clock.now); manager = managerFor(store); manager.start(); },
    };
  }

  it('arm -> answer arrives -> cancel with its revision: no wake ever', async () => {
    const a = agent();
    const wait = a.arm('critic-final');
    expect(wait.interrupt).toBe(false);
    await a.advance(5);
    a.store.cancel(wait.id, wait.revision);                  // the FINAL arrived
    await a.advance(30);
    await a.advance(60);
    expect(a.wakes).toEqual([]);
  });

  it('still waiting at the wake: one follow-up, at most one more reminder, then nothing', async () => {
    const a = agent();
    const first = a.arm('critic-final');
    await a.advance(21);
    expect(a.wakes).toHaveLength(1);
    const event = /event_id: (\S+)/.exec(a.wakes[0]!)![1]!;
    expect(a.store.inspect(event)).toMatchObject({ eligible: true, reminder: { note: 'PR 412 room: Critic FINAL on head 1a2b3c' } });
    // Unresolved: (one follow-up posted in the room,) ack, and one more reminder.
    a.store.ack(event, first.revision);
    a.arm('critic-final-followup');
    await a.advance(21);
    expect(a.wakes).toHaveLength(2);
    const second = /event_id: (\S+)/.exec(a.wakes[1]!)![1]!;
    a.store.ack(second, 1);
    // Nonresponse is reported once through the configured route; no new reminder.
    const armed = a.timers.length;
    for (let i = 0; i < 5; i++) await a.advance(60);
    expect(a.wakes).toHaveLength(2);
    expect(a.store.list().reminders).toEqual([]);
    expect(a.timers.length).toBe(armed);                     // nothing open: no timer
  });

  it('a wake whose wait was already answered is acknowledged without anything further', async () => {
    const a = agent();
    const wait = a.arm('critic-final');
    await a.advance(21);
    const event = /event_id: (\S+)/.exec(a.wakes[0]!)![1]!;
    expect(a.store.ack(event, wait.revision)).toMatchObject({ acknowledged: true });
    expect(a.store.ack(event, wait.revision)).toMatchObject({ duplicate: true });   // a repeat is harmless
    await a.advance(120);
    expect(a.wakes).toHaveLength(1);
  });

  it('a closed or deleted task wakes nobody', async () => {
    const a = agent();
    a.arm('critic-final');
    a.retire();                                               // task finished: state removed
    await a.advance(30);
    await a.advance(120);
    expect(a.wakes).toEqual([]);
    expect(a.store.list({ state: 'all' }).reminders).toEqual([]);
  });
});
