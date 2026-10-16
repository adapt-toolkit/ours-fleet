import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ReminderManager } from '../src/reminders/manager.js';
import { ReminderStore, type ReminderOwner } from '../src/reminders/store.js';
import { REMINDER_TOOL_NAMES, registerReminderTools, type ReminderToolBackend } from '../src/reminders/tools.js';
import { AcpSession } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import { CodexAppServerSession } from '../src/session/codex-app-server.js';
import { RELEASE_GUARD_REFUSED } from '../src/session/prompt-batch.js';
import type { AgentSession } from '../src/session/types.js';
import { FakeAppServer } from './fixtures/codex-app-server.js';

/**
 * End-to-end self-reminder flow over the real session implementations of both
 * managed harness backends: an agent tool call schedules, the supervisor's
 * dispatcher admits the wake through the role arbiter, the session's release
 * guard dispatches it to the (fixture) model, and the agent inspects and
 * acknowledges it through its MCP tools. Time is a fake clock; timers are
 * captured, never slept on.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const OWNER: ReminderOwner = { role: 'Dev', lifetime: 'temporary', instance: 'inst-1', cid: 'C'.repeat(64), action: 'act-1' };
const T0 = Date.parse('2027-01-20T12:00:00Z');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const until = async (ready: () => boolean, what = 'condition') => {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  if (!ready()) throw new Error(`${what} not reached`);
};

interface Harness {
  name: string;
  session: AgentSession;
  /** Every prompt text the model actually received, one entry per adapter turn. */
  modelTurns(): string[][];
  /** Occupy the session with a turn that stays running until `release`. */
  occupy(): Promise<{ release(): Promise<void> }>;
}

async function acpHarness(dir: string): Promise<Harness> {
  const hold = join(dir, 'hold');
  const log = join(dir, 'requests.jsonl');
  const session = await AcpSession.start({
    name: 'Dev', argv: [process.execPath, fixture], cwd: dir, stateDir: dir, mode: 'fresh',
    env: { ACP_FIXTURE_PROMPT_HOLD_FILE: hold, ACP_FIXTURE_REQUEST_JSON_LOG: log },
    permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' },
    log: () => {}, cancelGraceMs: 2_000,
  });
  cleanup.push(() => session.close().catch(() => {}));
  const modelTurns = () => !existsSync(log) ? [] : readFileSync(log, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(entry => entry.method === 'session/prompt')
    .map(entry => (entry.prompt as Array<{ type: string; text?: string }>)
      .filter(block => block.type === 'text').map(block => block.text!));
  return {
    name: 'acp', session, modelTurns,
    occupy: async () => {
      writeFileSync(hold, '');
      const queued = await session.queuePrompt('long owner work', { origin: { kind: 'local-console' } });
      await until(() => session.snapshot().readiness !== 'idle', 'busy session');
      return { release: async () => { rmSync(hold, { force: true }); await queued.completion; } };
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
    log: () => {},
  }, async options => (server = new FakeAppServer(options)));
  cleanup.push(() => session.close().catch(() => {}));
  const modelTurns = () => server.requests.filter(request => request.method === 'turn/start')
    .map(request => (request.params.input as Array<{ text: string }>).map(item => item.text));
  return {
    name: 'codex-app-server', session, modelTurns,
    occupy: async () => {
      const queued = await session.queuePrompt('long owner work needing permission', { origin: { kind: 'local-console' } });
      await until(() => session.snapshot().readiness === 'awaiting_permission', 'busy session');
      return {
        release: async () => {
          session.respondPermission(session.snapshot().pendingPermissionId!, 'allow_once');
          await queued.completion;
        },
      };
    },
  };
}

const harnesses: Array<[string, (dir: string) => Promise<Harness>]> = [
  ['ACP (Claude/ACP adapters)', acpHarness],
  ['native Codex app-server', codexHarness],
];

async function supervisor(start: (dir: string) => Promise<Harness>) {
  const dir = mkdtempSync(join(tmpdir(), 'rem-flow-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const harness = await start(dir);
  const clock = { now: T0 };
  const timers: Array<{ ms: number }> = [];
  const logs: string[] = [];
  const arbiter = new RoleTurnArbiter(harness.session);
  const open = (owner = OWNER) => {
    const store = new ReminderStore(dir, owner, () => clock.now, line => logs.push(line));
    const manager = new ReminderManager('Dev', store, arbiter, {
      now: () => clock.now, log: line => logs.push(line),
      setTimer: (_callback, ms) => { const timer = { ms }; timers.push(timer); return timer; },
      clearTimer: () => {},
    });
    return { store, manager };
  };
  let current = open();
  let backend: ReminderToolBackend | undefined = { store: current.store, changed: () => current.manager.changed() };
  const server = new McpServer({ name: 'ours', version: 'test' });
  registerReminderTools(server, () => backend, async () => () => {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agent', version: 'test' });
  await client.connect(clientSide);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as {
      isError?: boolean; content: Array<{ text: string }>;
    };
    return { isError: Boolean(result.isError), value: JSON.parse(result.content[0]!.text) };
  };
  const reminderTurns = () => harness.modelTurns().filter(turn => turn.some(text => text.startsWith('[fleet-reminder]')));
  return {
    dir, harness, clock, timers, logs, arbiter, call, client, reminderTurns,
    get store() { return current.store; },
    get manager() { return current.manager; },
    /** Simulate a supervisor restart against the same session and state directory. */
    restart(owner = OWNER) {
      current.manager.stop();
      current = open(owner);
      backend = { store: current.store, changed: () => current.manager.changed() };
      return current;
    },
    unbind() { backend = undefined; },
  };
}

describe.each(harnesses)('self-reminders over %s', (_label, start) => {
  it('delivers due -> supervisor prompt -> agent inspect/ack, exactly once, with zero idle cost', async () => {
    const s = await supervisor(start);
    const tools = await s.client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...REMINDER_TOOL_NAMES]));
    for (const tool of tools.tools.filter(item => item.name.startsWith('fleet_reminder_')))
      expect(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}))
        .not.toEqual(expect.arrayContaining(['agent', 'role', 'cid', 'recipient', 'contact']));

    // Idle: nothing scheduled, the dispatcher arms no timer and makes no turn.
    s.manager.start();
    await s.manager.poll();
    const idleTimers = s.timers.length;
    expect(s.harness.modelTurns()).toEqual([]);

    const created = await s.call('fleet_reminder_create', {
      request_key: 'ci-check', title: 'Check CI', note: 'look at PR 412; do not merge',
      local_time: '2027-01-20T16:00', time_zone: 'Europe/London',
    });
    expect(created.isError).toBe(false);
    const reminder = created.value.reminder;
    expect(reminder).toMatchObject({ revision: 1, due_at: '2027-01-20T16:00:00.000Z' });
    // A far-future reminder costs one capped timer, never a model turn.
    expect(s.timers.length).toBe(idleTimers + 1);
    expect(s.timers.at(-1)!.ms).toBe(60_000);
    for (let i = 0; i < 5; i++) { s.clock.now += 60_000; await s.manager.poll(); }
    expect(s.harness.modelTurns()).toEqual([]);

    s.clock.now = Date.parse('2027-01-20T16:00:05Z');
    await s.manager.poll();
    await until(() => s.reminderTurns().length === 1, 'reminder turn');
    const [turn] = s.reminderTurns();
    expect(turn).toHaveLength(1);                      // alone in its turn
    const wake = turn![0]!;
    expect(wake).toContain(`reminder_id: ${reminder.id}`);
    expect(wake).toContain('title: "Check CI"');
    expect(wake).not.toContain('look at PR 412');      // the note is only behind inspect
    expect(wake).toContain('not an owner message');
    const eventId = /event_id: (\S+)/.exec(wake)![1]!;

    const inspected = await s.call('fleet_reminder_inspect', { event_id: eventId });
    expect(inspected.value).toMatchObject({
      eligible: true, current: true, event: { state: 'dispatched' },
      reminder: { note: 'look at PR 412; do not merge', state: 'delivered' },
    });
    expect((await s.call('fleet_reminder_ack', { event_id: eventId, expected_revision: 2 })).value.error).toBe('stale_revision');
    expect((await s.call('fleet_reminder_ack', { event_id: eventId, expected_revision: 1 })).value)
      .toMatchObject({ acknowledged: true, duplicate: false });
    expect((await s.call('fleet_reminder_ack', { event_id: eventId, expected_revision: 1 })).value.duplicate).toBe(true);

    // Nothing further, ever: later polls create no turns and arm no timer.
    const settledTimers = s.timers.length;
    for (let i = 0; i < 3; i++) { s.clock.now += 3_600_000; await s.manager.poll(); }
    expect(s.reminderTurns()).toHaveLength(1);
    expect(s.timers.length).toBe(settledTimers);
    expect((await s.call('fleet_reminder_list', {})).value.reminders).toEqual([]);
    // Logs never carry reminder text.
    expect(s.logs.join('\n')).not.toMatch(/Check CI|PR 412/);
  });

  it('never interrupts a busy agent and delivers at the next idle boundary', async () => {
    const s = await supervisor(start);
    s.manager.start();
    const { value } = await s.call('fleet_reminder_create', {
      request_key: 'k', title: 'later', local_time: '2027-01-20T13:00', time_zone: 'UTC',
    });
    const busy = await s.harness.occupy();
    s.clock.now = Date.parse(value.reminder.due_at);
    await s.manager.poll();
    await s.manager.poll();
    expect(s.reminderTurns()).toEqual([]);
    expect(s.store.list().reminders[0]!.event).toMatchObject({ state: 'pending' });
    expect(s.harness.session.snapshot().readiness).not.toBe('idle');
    await busy.release();
    await until(() => s.harness.session.snapshot().readiness === 'idle', 'idle');
    await s.manager.poll();
    await until(() => s.reminderTurns().length === 1, 'reminder after busy work');
    // The owner's work and the wake were separate turns; nothing was cancelled.
    expect(s.harness.modelTurns().filter(turn => turn.some(text => text.includes('long owner work')))).toHaveLength(1);
  });

  it('drops a wake that went stale while it waited, at the moment of release', async () => {
    const s = await supervisor(start);
    const { value } = await s.call('fleet_reminder_create', {
      request_key: 'k', title: 'stale', local_time: '2027-01-20T13:00', time_zone: 'UTC',
    });
    s.clock.now = Date.parse(value.reminder.due_at);
    const [event] = s.store.sweep();
    // Force the race the arbiter normally avoids: the wake waits behind work,
    // beside an ordinary monitor message.
    const busy = await s.harness.occupy();
    expect(s.store.markAdmitting(event!.id)).toBe(true);
    const queued = await s.harness.session.queuePrompt('[fleet-reminder] stale wake', {
      origin: { kind: 'self-reminder', eventId: event!.id, reminderId: value.reminder.id, revision: 1 },
      releaseGuard: () => s.store.claimDispatch(event!.id, false).dispatch,
      steer: true, interrupt: true,
    });
    const mail = await s.harness.session.queuePrompt('mail wake', { origin: { kind: 'fleet-monitor' } });
    expect((await s.call('fleet_reminder_cancel', { id: value.reminder.id, expected_revision: 1 })).isError).toBe(false);
    await busy.release();
    expect(await queued.completion).toMatchObject({ outcome: 'cancelled', detail: RELEASE_GUARD_REFUSED });
    await mail.completion;
    expect(s.harness.modelTurns().flat()).not.toContain('[fleet-reminder] stale wake');
    expect(s.harness.modelTurns().filter(turn => turn.includes('mail wake'))).toEqual([['mail wake']]);
    const closed = s.harness.session.conversationPage!({ limit: 500 }).events
      .filter(item => item.kind === 'turn.completed' && item.promptId === queued.promptId);
    expect(closed).toHaveLength(1);
    expect(s.store.inspect(event!.id).event.state).toBe('invalidated');
  });

  it('keeps a guarded wake out of shared turns even when it is current', async () => {
    const s = await supervisor(start);
    const { value } = await s.call('fleet_reminder_create', {
      request_key: 'k', title: 'alone', local_time: '2027-01-20T13:00', time_zone: 'UTC',
    });
    s.clock.now = Date.parse(value.reminder.due_at);
    const [event] = s.store.sweep();
    const busy = await s.harness.occupy();
    const before = await s.harness.session.queuePrompt('mail before', { origin: { kind: 'fleet-monitor' } });
    s.store.markAdmitting(event!.id);
    const wake = await s.harness.session.queuePrompt('[fleet-reminder] current wake', {
      origin: { kind: 'self-reminder', eventId: event!.id, reminderId: value.reminder.id, revision: 1 },
      releaseGuard: () => s.store.claimDispatch(event!.id, false).dispatch,
    });
    const after = await s.harness.session.queuePrompt('mail after', { origin: { kind: 'fleet-monitor' } });
    await busy.release();
    await Promise.all([before.completion, wake.completion, after.completion]);
    const turns = s.harness.modelTurns().filter(turn => !turn.some(text => text.includes('long owner work')));
    expect(turns).toContainEqual(['[fleet-reminder] current wake']);
    expect(turns.find(turn => turn.includes('[fleet-reminder] current wake'))).toHaveLength(1);
    expect(s.store.inspect(event!.id).event.state).toBe('dispatched');
  });

  it('recovers across supervisor restarts without blind redelivery', async () => {
    const s = await supervisor(start);
    const a = (await s.call('fleet_reminder_create', { request_key: 'a', title: 'A', local_time: '2027-01-20T13:00', time_zone: 'UTC' })).value.reminder;
    s.clock.now = Date.parse(a.due_at);
    // Seam 1: claim persisted, process dies before the release guard ever runs.
    const [event] = s.store.sweep();
    s.store.markAdmitting(event!.id);
    let restarted = s.restart();
    restarted.manager.start();
    await restarted.manager.poll();
    await until(() => s.reminderTurns().length === 1, 'retried never-released wake');
    expect(s.reminderTurns()[0]![0]).toContain(`event_id: ${event!.id}`);
    expect(s.reminderTurns()[0]![0]).toContain('same event');

    // Seam 2: the model received it, the ack was lost with the process.
    restarted = s.restart();
    restarted.manager.start();
    for (let i = 0; i < 3; i++) { s.clock.now += 60_000; await restarted.manager.poll(); }
    expect(s.reminderTurns()).toHaveLength(1);         // held, not re-sent
    const listed = (await s.call('fleet_reminder_list', {})).value;
    expect(listed.uncertain_events).toBe(1);
    expect((await s.call('fleet_reminder_inspect', { event_id: event!.id })).value)
      .toMatchObject({ event: { state: 'uncertain' }, eligible: true });
    expect((await s.call('fleet_reminder_ack', { event_id: event!.id, expected_revision: 1 })).value.acknowledged).toBe(true);
  });

  it('stops admission on shutdown and never wakes a not-started role', async () => {
    const s = await supervisor(start);
    const { value } = await s.call('fleet_reminder_create', { request_key: 'k', title: 't', local_time: '2027-01-20T13:00', time_zone: 'UTC' });
    s.clock.now = Date.parse(value.reminder.due_at);
    // Not started (startup turn not yet successful): due work waits.
    await s.manager.poll();
    expect(s.reminderTurns()).toEqual([]);
    s.manager.stop();
    s.manager.start();
    await s.manager.poll();
    expect(s.reminderTurns()).toEqual([]);
    expect(s.store.list().reminders[0]).toMatchObject({ state: 'active' });
    // A guard consulted after stop refuses, and the event stays retryable.
    const [event] = s.store.sweep();
    s.store.markAdmitting(event!.id);
    expect(s.store.claimDispatch(event!.id, s.manager.isStopping)).toEqual({ dispatch: false, reason: 'stopping' });
  });

  it('isolates agents: a successor or replaced identity sees and wakes nothing', async () => {
    const s = await supervisor(start);
    const { value } = await s.call('fleet_reminder_create', { request_key: 'k', title: 'mine', local_time: '2027-01-20T13:00', time_zone: 'UTC' });
    const successor = s.restart({ ...OWNER, instance: 'inst-2' });
    expect((await s.call('fleet_reminder_list', { state: 'all' })).value.reminders).toEqual([]);
    expect((await s.call('fleet_reminder_cancel', { id: value.reminder.id, expected_revision: 1 })).value.error).toBe('not_found');
    s.clock.now = Date.parse(value.reminder.due_at);
    successor.manager.start();
    await successor.manager.poll();
    expect(s.reminderTurns()).toEqual([]);
    s.unbind();
    expect((await s.call('fleet_reminder_list', {})).value.error).toBe('reminders_unavailable');
  });
});
