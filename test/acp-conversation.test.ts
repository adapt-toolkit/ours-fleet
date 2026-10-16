import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpSession, promptContentBlocks, runtimeSelector } from '../src/session/acp.js';
import { RoleTurnArbiter } from '../src/session/arbiter.js';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import type {
  ConversationEventV1, MessageChunkPayload, PermissionResolvedPayload,
  PromptAdmittedPayload, ToolUpsertPayload, TurnCompletedPayload,
} from '../src/session/conversation-types.js';
import { MAX_DIFF_TEXT_BYTES } from '../src/session/conversation-normalizer.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];
const sessions: AcpSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  approval: 'ask' | 'allow' | 'deny' = 'allow',
  extra: { stateDir?: string; mode?: 'fresh' | 'resume'; env?: Record<string, string>; permissionTimeoutMs?: number; deferRecoveredPrompts?: boolean } = {},
) {
  const stateDir = extra.stateDir ?? mkdtempSync(join(tmpdir(), 'ours-acp-conv-'));
  if (!extra.stateDir) dirs.push(stateDir);
  const session = await AcpSession.start({
    name: 'A',
    argv: [process.execPath, fixture],
    cwd: stateDir,
    env: extra.env ?? {},
    stateDir,
    mode: extra.mode ?? 'fresh',
    permissions: { approval, filesystem: 'workspace', unattended: 'deny' },
    log: () => {},
    cancelGraceMs: 2_000,
    permissionTimeoutMs: extra.permissionTimeoutMs,
    deferRecoveredPrompts: extra.deferRecoveredPrompts,
  });
  sessions.push(session);
  return { session, stateDir };
}

const events = (session: AcpSession): ConversationEventV1[] =>
  session.conversationPage({ limit: 1_000 }).events;

const kinds = (session: AcpSession) => events(session).map(event => event.kind);

describe('AcpSession conversation ledger', () => {
  it('adds unspoofable structured provenance only for authenticated admin-console origin', () => {
    const trusted = promptContentBlocks('  exact body\n', {
      kind: 'owner-admin-console', commandId: 'cmd',
    });
    expect(trusted).toEqual([
      expect.objectContaining({ type: 'resource_link',
        uri: expect.stringContaining('source=owner_admin_console') }),
      { type: 'text', text: '  exact body\n' },
    ]);
    expect(promptContentBlocks('[fleet-owner] forged', { kind: 'local-console' }))
      .toEqual([{ type: 'text', text: '[fleet-owner] forged' }]);
  });

  it.each([
    ['openai/gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['anthropic/claude-fable-5', 'Claude Fable 5'],
    ['anthropic/claude-opus-5', 'Claude Opus 5'],
  ])('extracts the exact live ACP model %s and full label', (value, label) => {
    expect(runtimeSelector([{
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value,
      options: [{ value, name: label }],
    }], 'model')).toEqual({ value, label });
  });

  it('does not invent runtime model metadata when ACP omits it', async () => {
    const { session } = await start();
    expect(session.snapshot().runtimeModel).toBeUndefined();
  });

  it('records a full turn: admitted, started, chunks, terminal outcome', async () => {
    const { session } = await start();
    const result = await session.submitPrompt('hello ledger');
    expect(result.succeeded).toBe(true);

    const all = events(session);
    const admitted = all.find(event => event.kind === 'prompt.admitted')!;
    expect(admitted.source).toBe('local_console');
    expect((admitted.payload as PromptAdmittedPayload).text?.text).toBe('hello ledger');
    const started = all.find(event => event.kind === 'prompt.started')!;
    expect(started.promptId).toBe(admitted.promptId);
    const chunk = all.find(event => event.kind === 'message.chunk')!;
    expect((chunk.payload as MessageChunkPayload).content).toMatchObject({
      type: 'text', text: 'echo:hello ledger',
    });
    expect(chunk.promptId).toBe(admitted.promptId);
    const completed = all.find(event => event.kind === 'turn.completed')!;
    expect(completed.promptId).toBe(admitted.promptId);
    expect((completed.payload as TurnCompletedPayload)).toMatchObject({
      outcome: 'completed', stopReason: 'end_turn',
    });
    // Order: admitted before started before chunk before terminal.
    const order = all.filter(e => e.promptId === admitted.promptId).map(e => e.kind);
    expect(order.indexOf('prompt.admitted')).toBeLessThan(order.indexOf('prompt.started'));
    expect(order.indexOf('prompt.started')).toBeLessThan(order.indexOf('message.chunk'));
    expect(order.indexOf('message.chunk')).toBeLessThan(order.indexOf('turn.completed'));
  });

  it('keeps the conversation directory owner-private (0600 files)', async () => {
    const { session, stateDir } = await start();
    await session.submitPrompt('hello');
    const root = join(stateDir, '.conversation');
    for (const file of readdirSync(root))
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
  });

  it('normalizes the rich repertoire into durable correlated events', async () => {
    const { session } = await start();
    await session.submitPrompt('rich demo');
    const all = kinds(session);
    for (const kind of ['message.chunk', 'thought.chunk', 'plan.replace', 'tool.upsert',
      'usage.updated', 'session.info', 'capabilities.updated'])
      expect(all).toContain(kind);
    const userChunk = events(session).find(event =>
      event.kind === 'message.chunk'
      && (event.payload as MessageChunkPayload).role === 'user'
      && event.messageId === 'user-1');
    expect(userChunk?.source).toBe('agent');
  });

  it('persists only the bounded current delta from a multi-megabyte WORKLOG append', async () => {
    const { session } = await start();
    await session.submitPrompt('large worklog append');
    const event = events(session).find(candidate =>
      candidate.kind === 'tool.upsert' && candidate.toolCallId === 'large-worklog-edit');
    expect(event).toBeDefined();
    const payload = event!.payload as ToolUpsertPayload;
    const diff = payload.content?.[0];
    expect(diff).toMatchObject({
      type: 'diff', operation: 'append', bounded: true,
      newText: { text: expect.stringContaining('CURRENT_SESSION_APPEND') },
    });
    const serialized = JSON.stringify(event);
    expect(Buffer.byteLength(serialized)).toBeLessThan(MAX_DIFF_TEXT_BYTES + 4_096);
    expect(serialized).not.toContain('ours-mcp start');
    expect(serialized).not.toContain('historical-line');
  });

  it('accepts browser prompts idempotently and durably before acknowledging', async () => {
    const { session } = await start();
    const receipt = await session.submitPromptBrowser({
      commandId: 'cmd-1', text: 'from the browser',
      source: 'owner_admin_console', actorBrowserSession: 'session-digest-1',
    });
    expect(receipt).toMatchObject({ commandId: 'cmd-1', state: 'starting', queuedBehind: 0 });
    const admitted = events(session).find(event => event.kind === 'prompt.admitted')!;
    expect(admitted.commandId).toBe('cmd-1');
    expect(receipt.sessionGeneration).toBe(admitted.sessionGeneration);
    expect(admitted.source).toBe('owner_admin_console');
    expect(admitted.actor?.browserSession).toBe('session-digest-1');
    expect((admitted.payload as PromptAdmittedPayload).text?.text).toBe('from the browser');

    // Retry with the same command: the SAME receipt, no duplicate admission.
    const replay = await session.submitPromptBrowser({
      commandId: 'cmd-1', text: 'from the browser',
      source: 'owner_admin_console', actorBrowserSession: 'session-digest-1',
    });
    expect(replay.promptId).toBe(receipt.promptId);
    expect(events(session).filter(event => event.kind === 'prompt.admitted')).toHaveLength(1);

    // Same command id, different body: a conflict, never a silent second turn.
    await expect(session.submitPromptBrowser({
      commandId: 'cmd-1', text: 'DIFFERENT body',
      source: 'owner_admin_console', actorBrowserSession: 'session-digest-1',
    })).rejects.toThrowError(/idempotency/i);
  });

  it('records interrupt requests and the cancelled terminal state', async () => {
    const { session } = await start();
    const queued = await session.queuePrompt('block 600');
    await new Promise(resolve => setTimeout(resolve, 100));
    await session.interrupt('owner');
    const result = await queued.completion;
    expect(result.outcome).toBe('cancelled');
    const all = events(session);
    const interrupt = all.find(event => event.kind === 'prompt.interrupt_requested')!;
    expect(interrupt.payload).toMatchObject({ cancellationSource: 'owner' });
    const completed = all.find(event => event.kind === 'turn.completed')!;
    expect((completed.payload as TurnCompletedPayload).outcome).toBe('cancelled');
  });

  it('interrupt cancels only the active turn; the queued prompt still runs', async () => {
    const { session } = await start();
    const active = await session.queuePrompt('block 60000');
    await session.submitPromptBrowser({
      commandId: 'cmd-q', text: 'queued survivor',
      source: 'owner_admin_console', actorBrowserSession: 'digest',
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await session.interrupt('owner');
    expect((await active.completion).outcome).toBe('cancelled');
    // The queued prompt starts only after cancellation confirmation, and runs.
    for (let i = 0; i < 300 && !events(session).some(e =>
      e.kind === 'turn.completed'
      && (e.payload as TurnCompletedPayload).outcome === 'completed'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const all = events(session);
    const survivor = all.find(e => e.kind === 'prompt.admitted' && e.commandId === 'cmd-q')!;
    const completed = all.find(e =>
      e.kind === 'turn.completed' && e.promptId === survivor.promptId)!;
    expect((completed.payload as TurnCompletedPayload).outcome).toBe('completed');
    const cancelled = all.find(e =>
      e.kind === 'turn.completed'
      && (e.payload as TurnCompletedPayload).outcome === 'cancelled')!;
    expect(cancelled.seq).toBeLessThan(completed.seq);
  });

  it('records automatic permission decisions with their policy', async () => {
    const { session } = await start('allow');
    await session.submitPrompt('permission please');
    const resolved = events(session).find(event => event.kind === 'permission.resolved')!;
    const payload = resolved.payload as PermissionResolvedPayload;
    expect(payload.decisionSource).toBe('automatic');
    expect(payload.decision).toBe('allowed');
    expect(payload.policy).toBe('permissions.approval=allow');
  });

  it('records manual permission lifecycle: requested, then resolved', async () => {
    const { session } = await start('ask');
    session.setControllerAttached(true);
    const queued = await session.queuePrompt('permission please');
    for (let i = 0; i < 100 && !events(session).some(e => e.kind === 'permission.requested'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const requested = events(session).find(event => event.kind === 'permission.requested')!;
    expect(requested.permissionId).toBeDefined();
    const accepted = session.respondPermission(requested.permissionId!, 'allow');
    expect(accepted).toBe(true);
    await queued.completion;
    const resolved = events(session).find(event => event.kind === 'permission.resolved')!;
    expect(resolved.permissionId).toBe(requested.permissionId);
    expect(resolved.payload as PermissionResolvedPayload).toMatchObject({
      decision: 'allowed', decisionSource: 'manual', optionId: 'allow',
    });
  });

  it('redacts scheduled-loop content in the durable ledger', async () => {
    const { session } = await start();
    await session.submitPrompt('loop wake', {
      origin: { kind: 'scheduled-loop', loop: 'l1', runId: 'r1' },
    });
    const all = events(session);
    const admitted = all.find(event => event.kind === 'prompt.admitted')!;
    expect(admitted.source).toBe('scheduled_loop');
    expect((admitted.payload as PromptAdmittedPayload).text).toBeUndefined();
    expect((admitted.payload as PromptAdmittedPayload).external?.digest).toBeDefined();
    const chunk = all.find(event => event.kind === 'message.chunk')!;
    const content = (chunk.payload as MessageChunkPayload).content;
    expect(content).toMatchObject({ type: 'text', redacted: true });
    expect(JSON.stringify(all)).not.toContain('loop wake');
  });

  it('keeps the agent commentary between its tools in the conversation the owner reads', async () => {
    const { session } = await start();
    await session.submitPrompt('phased response', { origin: { kind: 'owner', requestId: 'request-1' } });
    const text = events(session).filter(event => event.kind === 'message.chunk')
      .map(event => (event.payload as MessageChunkPayload).content);
    expect(text).toEqual([
      expect.objectContaining({ type: 'text', text: 'Checking the implementation.\n' }),
      expect.objectContaining({ type: 'text', text: 'Implementation is ready.' }),
    ]);
    expect(text.some(content => (content as { redacted?: boolean }).redacted)).toBe(false);
    expect(JSON.stringify(events(session))).not.toContain('commentary redacted');
    // A scheduled wake stays private even when the agent comments on it.
    await session.submitPrompt('phased wake', { origin: { kind: 'scheduled-loop', loop: 'l1', runId: 'r1' } });
    expect(JSON.stringify(events(session)).match(/Checking the implementation/g)).toHaveLength(1);
  });

  it('retains the exact owner message body for display without making it restartable', async () => {
    const { session } = await start();
    await session.submitPrompt('[fleet-owner]\nwrapped', {
      origin: { kind: 'owner', requestId: 'r', displayText: '  human text\nline two  ' },
    });
    const admitted = events(session).find(event => event.kind === 'prompt.admitted')!;
    const payload = admitted.payload as PromptAdmittedPayload;
    expect(admitted.source).toBe('owner_channel');
    expect(payload.displayText?.text).toBe('  human text\nline two  ');
    expect(payload.text).toBeUndefined();
    expect(payload.external?.digest).toBeDefined();
  });

  it('keeps session/load replay durable with provenance but out of the current console page', async () => {
    const { session, stateDir } = await start('allow', {
      env: { ACP_FIXTURE_LOAD_SESSION: '1', ACP_FIXTURE_REPLAY: '1' },
    });
    await session.close();
    sessions.pop();
    const { session: resumed } = await start('allow', {
      stateDir, mode: 'resume',
      env: { ACP_FIXTURE_LOAD_SESSION: '1', ACP_FIXTURE_REPLAY: '1' },
    });
    expect(events(resumed).filter(event => event.source === 'agent_replay')).toEqual([]);
    const replayed = readdirSync(join(stateDir, '.conversation'))
      .filter(name => /^events-.*\.jsonl$/.test(name))
      .flatMap(name => readFileSync(join(stateDir, '.conversation', name), 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ConversationEventV1))
      .filter(event => event.source === 'agent_replay');
    expect(replayed.length).toBe(2);
    expect((replayed[0].payload as MessageChunkPayload).role).toBe('user');
  });

  it('pages only this runner generation while preserving older durable records', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-acp-conv-'));
    dirs.push(stateDir);
    const store = new ConversationEventStore(join(stateDir, '.conversation'), { roleId: 'A' });
    for (let i = 0; i < 1_050; i++) store.append({
      kind: 'message.chunk', sessionGeneration: 'old-generation', source: 'agent',
      payload: { role: 'assistant', content: { type: 'text', text: `old-${i}`, bytes: 5 } },
    });
    store.close();

    const { session } = await start('allow', { stateDir });
    await session.submitPrompt('current');
    const page = session.conversationPage({ limit: 1_000 });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every(event => event.sessionGeneration === page.snapshot.sessionGeneration))
      .toBe(true);
    expect(JSON.stringify(page.events)).toContain('echo:current');
    expect(JSON.stringify(page.events)).not.toContain('old-');
  });

  it('recovers never-started prompts and marks in-flight turns unknown after restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-acp-conv-'));
    dirs.push(stateDir);
    // Simulate the pre-crash ledger directly: one started turn without a
    // terminal event, one admitted-but-never-started browser prompt.
    const store = new ConversationEventStore(join(stateDir, '.conversation'), { roleId: 'A' });
    store.append({
      kind: 'prompt.admitted', sessionGeneration: 'gen-old', promptId: 'p-started',
      turnId: 'p-started', commandId: 'cmd-a', source: 'browser',
      payload: { text: { type: 'text', text: 'was running', bytes: 11 }, queuedBehind: 0 },
    });
    store.append({
      kind: 'prompt.started', sessionGeneration: 'gen-old',
      promptId: 'p-started', turnId: 'p-started', payload: {},
    });
    store.append({
      kind: 'prompt.admitted', sessionGeneration: 'gen-old', promptId: 'p-queued',
      turnId: 'p-queued', commandId: 'cmd-b', source: 'browser',
      payload: { text: { type: 'text', text: 'never started', bytes: 13 }, queuedBehind: 1 },
    });
    store.close();

    const { session } = await start('allow', { stateDir });
    const restoredStates: import('../src/session/conversation-types.js').ConversationObservationState[] = [];
    const restoredObserver = session.observeConversation(state => restoredStates.push(state));
    // Wait for the restored prompt's turn to finish.
    for (let i = 0; i < 200 && !events(session).some(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-queued'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    expect(restoredStates.at(-1)).toMatchObject({ queueDepth: 0, activePromptIds: [], pendingPrompts: [] });
    restoredObserver.unsubscribe();
    const all = events(session);
    const unknown = all.find(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-started')!;
    expect((unknown.payload as TurnCompletedPayload).outcome).toBe('unknown_after_restart');
    // The never-started prompt ran for real — its prior-generation admission
    // stays durable but outside the current console page; one new start and end
    // describe the recovery work in this generation.
    expect(all.filter(e => e.kind === 'prompt.admitted' && e.promptId === 'p-queued'))
      .toHaveLength(0);
    expect(all.filter(e => e.kind === 'prompt.started' && e.promptId === 'p-queued'))
      .toHaveLength(1);
    const completed = all.find(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-queued')!;
    expect((completed.payload as TurnCompletedPayload).outcome).toBe('completed');
    const echo = all.find(e => e.kind === 'message.chunk' && e.promptId === 'p-queued');
    expect((echo?.payload as MessageChunkPayload).content)
      .toMatchObject({ text: 'echo:never started' });
  });

  it('holds recovered never-started prompts until the caller activates them', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ours-acp-conv-'));
    dirs.push(stateDir);
    const seed = () => {
      const store = new ConversationEventStore(join(stateDir, '.conversation'), { roleId: 'A' });
      store.append({
        kind: 'prompt.admitted', sessionGeneration: 'gen-old', promptId: 'p-started',
        turnId: 'p-started', commandId: 'cmd-a', source: 'browser',
        payload: { text: { type: 'text', text: 'was running', bytes: 11 }, queuedBehind: 0 },
      });
      store.append({
        kind: 'prompt.started', sessionGeneration: 'gen-old',
        promptId: 'p-started', turnId: 'p-started', payload: {},
      });
      store.append({
        kind: 'prompt.admitted', sessionGeneration: 'gen-old', promptId: 'p-queued',
        turnId: 'p-queued', commandId: 'cmd-b', source: 'browser',
        payload: { text: { type: 'text', text: 'run managed cli', bytes: 15 }, queuedBehind: 1 },
      });
      store.close();
    };
    seed();
    const started = (session: AcpSession) =>
      events(session).filter(e => e.kind === 'prompt.started' && e.promptId === 'p-queued');

    // A supervisor that dies before its control plane listens must not lose
    // the recovered prompt: it is never dispatched, so it stays recoverable.
    const first = await start('allow', { stateDir, deferRecoveredPrompts: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(started(first.session)).toHaveLength(0);
    expect(events(first.session).find(e => e.kind === 'turn.completed' && e.promptId === 'p-started')
      ?.payload).toMatchObject({ outcome: 'unknown_after_restart' });
    await first.session.close();

    const { session } = await start('allow', { stateDir, deferRecoveredPrompts: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(started(session)).toHaveLength(0);
    expect(session.conversationSnapshot().queueDepth).toBe(0);

    session.activateRecoveredPrompts();
    session.activateRecoveredPrompts();
    for (let i = 0; i < 200 && !events(session).some(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-queued'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(started(session)).toHaveLength(1);
    expect(events(session).find(e => e.kind === 'turn.completed' && e.promptId === 'p-queued')
      ?.payload).toMatchObject({ outcome: 'completed' });
    // The started turn is never replayed, by either generation.
    expect(events(session).filter(e => e.kind === 'prompt.started' && e.promptId === 'p-started'))
      .toHaveLength(0);
  });

  it('exposes a conversation snapshot with generation and queue state', async () => {
    const { session } = await start();
    const snapshot = session.conversationSnapshot();
    expect(snapshot.sessionGeneration).toBeTruthy();
    expect(snapshot.readiness).toBe('idle');
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.pendingPermissionIds).toEqual([]);
  });
});

describe('ACP passive observation', () => {
  it('publishes admitted inventory, full batch membership and final asynchronous depth', async () => {
    const { session } = await start();
    const states: import('../src/session/conversation-types.js').ConversationObservationState[] = [];
    const observation = new RoleTurnArbiter(session).observeConversation(state => states.push(state));
    expect(observation.snapshot.alive).toBe(true);
    expect(observation.snapshot.runtimeModel).toEqual(session.snapshot().runtimeModel);
    const firstPromise = session.queuePrompt('block 80');
    const secondPromise = session.queuePrompt('second');
    const first = await firstPromise, second = await secondPromise;
    expect(states[0]).toMatchObject({ queueDepth: 1, activePromptIds: [],
      pendingPrompts: [expect.objectContaining({ promptId: first.promptId })] });
    expect(states.find(state => state.pendingPrompts.length === 0)?.activePromptIds).toEqual([first.promptId, second.promptId]);
    expect(states.some(state => state.activePromptIds.join() === [first.promptId, second.promptId].join()
      && state.pendingPrompts?.length === 0)).toBe(true);
    await Promise.all([first.completion, second.completion]);
    expect(states.at(-1)).toMatchObject({ queueDepth: 0, activePromptIds: [], pendingPrompts: [] });
    const reconnect = session.observeConversation(() => {});
    expect(reconnect.snapshot.stateRevision).toBeGreaterThanOrEqual(states.at(-1)!.stateRevision);
    observation.unsubscribe(); reconnect.unsubscribe();
  });

  it('retains the presented permission payload across history reads without attaching a controller', async () => {
    const { session } = await start('ask');
    const observation = session.observeConversation(() => {});
    // unattended=deny proves an observer does not count as a controller.
    await session.submitPrompt('permission');
    expect(events(session).filter(event => event.kind === 'permission.requested')).toHaveLength(0);
    session.setControllerAttached(true);
    let raced: import('../src/session/conversation-types.js').ConversationObservationState | undefined;
    const stopRace = session.subscribeConversation(event => {
      if (event.kind !== 'permission.requested') return;
      session.conversationPage({ limit: 1 });
      const raceObserver = session.observeConversation(() => {});
      raced = raceObserver.snapshot;
      raceObserver.unsubscribe();
    });
    const queued = await session.queuePrompt('permission');
    for (let i = 0; i < 100 && !session.conversationSnapshot().pendingPermissionIds.length; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const requested = events(session).findLast(event => event.kind === 'permission.requested')!;
    const reconnect = session.observeConversation(() => {});
    expect(reconnect.snapshot.pendingPermissions).toEqual([{ permissionId: requested.permissionId, ...requested.payload }]);
    expect(raced?.pendingPermissions).toEqual(reconnect.snapshot.pendingPermissions);
    stopRace();
    const pending = reconnect.snapshot.pendingPermissions[0]!;
    await session.respondPermission(pending.permissionId, pending.options[0]!.optionId);
    await queued.completion;
    expect(session.observeConversation(() => {}).snapshot.pendingPermissions).toEqual([]);
    observation.unsubscribe(); reconnect.unsubscribe();
  });

  it('publishes ACP scheduled masking, exact expiry, runtime/commands and offline state', async () => {
    const { session } = await start('ask', { permissionTimeoutMs: 200, env: {
      ACP_FIXTURE_CONFIG_OPTIONS: JSON.stringify([{
        id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'fixture-start', options: [],
      }]),
    } });
    session.setControllerAttached(true);
    const states: import('../src/session/conversation-types.js').ConversationObservationState[] = [];
    const observer = session.observeConversation(state => states.push(state));
    expect(observer.snapshot.runtimeModel?.value).toBe('fixture-start');
    const queued = await session.queuePrompt('permission', {
      origin: { kind: 'scheduled-loop', loop: 'observe', runId: 'scheduled-observe' },
    });
    for (let i = 0; i < 100 && !session.conversationSnapshot().pendingPermissionIds.length; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const requested = events(session).findLast(event => event.kind === 'permission.requested')!;
    const current = states.at(-1)!;
    expect(current.pendingPermissions).toEqual([{ permissionId: requested.permissionId, ...requested.payload }]);
    expect(current.pendingPermissions[0]).toMatchObject({
      toolCallId: 'scheduled-loop-tool', title: 'Scheduled-loop permission requested',
      expiresAt: expect.any(String),
    });
    expect(current.pendingPermissions[0]!.options.every(option => option.name === option.kind)).toBe(true);
    for (let i = 0; i < 100 && session.conversationSnapshot().pendingPermissionIds.length; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(states.at(-1)!.pendingPermissions).toEqual([]);
    // The fixture intentionally leaves a cancelled permission turn open.
    await session.interrupt();
    await queued.completion;
    await session.submitPrompt('rich');
    expect(states.at(-1)!.runtimeModel).toBeUndefined();
    expect(states.some(state => state.runtimeModel?.value === 'fixture-start')).toBe(true);
    expect(states.at(-1)!.commands).toEqual([{
      name: 'fixture_command', description: expect.objectContaining({ text: 'A fixture command' }), inputHint: 'topic',
    }]);
    await session.close();
    for (let i = 0; i < 100 && session.isAlive(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(states.at(-1)).toMatchObject({ alive: false, readiness: 'offline' });
    observer.unsubscribe();
  });

  it('publishes final depth on the ACP dead-adapter return before release', async () => {
    const { session } = await start();
    const states: import('../src/session/conversation-types.js').ConversationObservationState[] = [];
    const observer = session.observeConversation(state => states.push(state));
    const admission = session.queuePrompt('not delivered');
    // The real backend's release guard sees the peer vanish after synchronous
    // admission, before its promise-chain release checkpoint can run.
    const liveness = vi.spyOn(session, 'isAlive').mockReturnValue(false);
    try {
      const queued = await admission;
      await expect(queued.completion).resolves.toMatchObject({ accepted: false, outcome: 'failed' });
      expect(states.at(-1)).toMatchObject({ queueDepth: 0, pendingPrompts: [], activePromptIds: [], alive: false });
    } finally { liveness.mockRestore(); observer.unsubscribe(); }
  });

  it('keeps reentrant admission registration and existing notifications at coherent checkpoints', async () => {
    const { session } = await start();
    {
      type State = import('../src/session/conversation-types.js').ConversationObservationState;
      const existingStates: State[] = [], reentrantStates: State[] = [];
      const existing = session.observeConversation(state => existingStates.push(state));
      let reentrant: ReturnType<typeof session.observeConversation> | undefined;
      let admissionSeq = 0, admittedId = '';
      const stopLedger = session.subscribeConversation(event => {
        if (event.kind !== 'prompt.admitted') return;
        admissionSeq = event.seq;
        admittedId = event.promptId!;
        session.conversationPage({ limit: 1 });
        reentrant = session.observeConversation(state => reentrantStates.push(state));
      });
      const queued = await session.queuePrompt('checkpoint admission');
      expect(reentrant).toBeDefined();
      const coherent = (state: State) => state.ledgerBarrier < admissionSeq
        || state.pendingPrompts.some(prompt => prompt.promptId === admittedId)
        || state.activePromptIds.includes(admittedId);
      // At registration the durable append exists, but queue insertion has not
      // happened. The only truthful initial snapshot is the prior checkpoint.
      expect(coherent(reentrant!.snapshot)).toBe(true);
      expect(reentrant!.snapshot.ledgerBarrier).toBe(existing.snapshot.ledgerBarrier);
      expect(existingStates.every(coherent)).toBe(true);
      expect(reentrantStates.every(coherent)).toBe(true);
      expect(reentrantStates.some(state => state.ledgerBarrier >= admissionSeq
        && (state.pendingPrompts.some(prompt => prompt.promptId === queued.promptId)
          || state.activePromptIds.includes(queued.promptId)))).toBe(true);
      stopLedger(); existing.unsubscribe(); reentrant!.unsubscribe();
      await queued.completion;
    }
  });

  it.each(['config_option_update', 'available_commands_update', 'current_mode_update'] as const)(
    'keeps %s callback registration consistent with its durable barrier', async kind => {
      const initialOptions = [{ id: 'model', category: 'model', name: 'Model', type: 'select',
        currentValue: 'model-before', options: [{ value: 'model-before', name: 'Before model' }] }];
      const { session } = await start('allow', { env: {
        ACP_FIXTURE_CONFIG_OPTIONS: JSON.stringify(initialOptions),
      } });
      type State = import('../src/session/conversation-types.js').ConversationObservationState;
      const states: State[] = [], newStates: State[] = [];
      const existing = session.observeConversation(state => states.push(state));
      let registered: ReturnType<typeof session.observeConversation> | undefined;
      let updateSeq = 0;
      const stop = session.subscribeConversation(event => {
        if (event.seq <= existing.snapshot.ledgerBarrier) return;
        updateSeq = event.seq;
        session.conversationPage({ limit: 1 });
        registered = session.observeConversation(state => newStates.push(state));
      });
      const expectedModel = kind === 'config_option_update'
        ? { value: 'model-after', label: 'After model' } : existing.snapshot.runtimeModel;
      const update = kind === 'config_option_update' ? {
        sessionUpdate: kind, configOptions: [
          { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'model-after',
            options: [{ value: 'model-before', name: 'Before model' }, { value: 'model-after', name: 'After model' }] },
          { id: 'effort', category: 'thought_level', name: 'Reasoning', type: 'select', currentValue: 'high',
            options: [{ value: 'high', name: 'High reasoning' }] },
        ],
      } : kind === 'available_commands_update' ? {
        sessionUpdate: kind, availableCommands: [{ name: 'fresh_command', description: 'Fresh command', input: { hint: 'topic' } }],
      } : { sessionUpdate: kind, currentModeId: 'fixture-mode-after' };
      // Exercise the actual ACP update owner and its synchronous durable callback.
      (session as unknown as { recordUpdate(update: unknown): void }).recordUpdate(update);
      expect(registered).toBeDefined();
      const expectedCommands = kind === 'available_commands_update'
        ? [{ name: 'fresh_command', description: { text: 'Fresh command', bytes: 13 }, inputHint: 'topic' }]
        : existing.snapshot.commands;
      const coherent = (state: State) => state.ledgerBarrier < updateSeq
        || (JSON.stringify(state.runtimeModel) === JSON.stringify(expectedModel)
          && JSON.stringify(state.commands) === JSON.stringify(expectedCommands)
          && (kind !== 'config_option_update' || state.reasoningEffort?.value === 'high'));
      expect(coherent(registered!.snapshot)).toBe(true);
      expect(states.every(coherent)).toBe(true);
      expect(newStates.every(coherent)).toBe(true);
      expect(states.at(-1)).toMatchObject({ ledgerBarrier: updateSeq,
        runtimeModel: expectedModel, commands: expectedCommands });
      const final = session.observeConversation(() => {});
      expect(final.snapshot).toMatchObject({ ledgerBarrier: updateSeq, runtimeModel: expectedModel,
        commands: expectedCommands });
      if (kind === 'config_option_update')
        expect(final.snapshot.reasoningEffort).toEqual({ value: 'high', label: 'High reasoning' });
      stop(); existing.unsubscribe(); registered!.unsubscribe(); final.unsubscribe();
    },
  );

  it('preserves browser receipt and idempotency after a post-admission capture fault', async () => {
    const { session } = await start();
    type State = import('../src/session/conversation-types.js').ConversationObservationState;
    const states: State[] = [];
    const observer = session.observeConversation(state => states.push(state));
    const owner = session as unknown as { captureObservation(): Omit<State, 'stateRevision'> };
    const originalCapture = owner.captureObservation.bind(session);
    let faulted = false;
    const stop = session.subscribeConversation(event => {
      if (event.kind === 'prompt.admitted' && !faulted) {
        faulted = true;
        owner.captureObservation = () => { owner.captureObservation = originalCapture; throw new Error('injected capture fault'); };
      }
    });
    try {
      const command = { commandId: 'capture-fault-command', text: 'capture fault work' };
      const receipt = await session.submitPromptBrowser(command);
      expect(await session.submitPromptBrowser(command)).toEqual(receipt);
      for (let i = 0; i < 100 && session.conversationSnapshot().queueDepth > 0; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      const events = session.conversationPage({ limit: 1000 }).events;
      expect(events.filter(event => event.kind === 'prompt.admitted' && event.commandId === command.commandId)).toHaveLength(1);
      expect(events.filter(event => event.kind === 'turn.completed' && event.promptId === receipt.promptId)).toHaveLength(1);
      const failure = states.find(state => state.observationFailure);
      expect(failure).toMatchObject({ observationFailure: 'capture_failed', ledgerBarrier: observer.snapshot.ledgerBarrier });
      expect(states.every(state => state.ledgerBarrier <= observer.snapshot.ledgerBarrier)).toBe(true);
      const reconnect = session.observeConversation(() => {});
      expect(reconnect.snapshot.observationFailure).toBe('capture_failed');
      reconnect.unsubscribe();
    } finally { owner.captureObservation = originalCapture; stop(); observer.unsubscribe();  }
  });

  it.each(['manual', 'expiry'] as const)('keeps %s permission resolution and terminal membership coherent', async answer => {
    const { session } = await start('ask', { permissionTimeoutMs: 120 });
    session.setControllerAttached(true);
    type State = import('../src/session/conversation-types.js').ConversationObservationState;
    const states: State[] = [], registrations: Array<{ kind: string; seq: number; promptId?: string; snapshot: State }> = [];
    const follows: Array<ReturnType<typeof session.observeConversation>> = [];
    const existing = session.observeConversation(state => states.push(state));
    const stop = session.subscribeConversation(event => {
      if (event.kind !== 'permission.resolved' && event.kind !== 'turn.completed') return;
      session.conversationPage({ limit: 1 });
      const registration = session.observeConversation(state => states.push(state));
      registrations.push({ kind: event.kind, seq: event.seq, promptId: event.promptId, snapshot: registration.snapshot });
      follows.push(registration);
    });
    try {
      const queued = await session.queuePrompt('permission');
      for (let i = 0; i < 100 && !session.conversationSnapshot().pendingPermissionIds.length; i++)
        await new Promise(resolve => setTimeout(resolve, 5));
      const pending = session.observeConversation(() => {});
      if (answer === 'manual') session.respondPermission(pending.snapshot.pendingPermissions[0]!.permissionId,
        pending.snapshot.pendingPermissions[0]!.options[0]!.optionId);
      pending.unsubscribe();
      if (answer === 'expiry') {
        for (let i = 0; i < 100 && session.conversationSnapshot().pendingPermissionIds.length; i++)
          await new Promise(resolve => setTimeout(resolve, 5));
        await session.interrupt();
      }

      await queued.completion;
      expect(registrations.some(item => item.kind === 'permission.resolved')).toBe(true);
      expect(registrations.some(item => item.kind === 'turn.completed')).toBe(true);
      for (const item of registrations) {
        const coherent = (state: State) => state.ledgerBarrier < item.seq || (item.kind === 'permission.resolved'
          ? state.readiness !== 'awaiting_permission' || state.pendingPermissions.length > 0
          : !state.activePromptIds.includes(item.promptId!));
        expect(coherent(item.snapshot)).toBe(true);
        expect(states.every(coherent)).toBe(true);
      }
      expect(states.at(-1)).toMatchObject({ queueDepth: 0, pendingPermissions: [], activePromptIds: [] });
    } finally { stop(); existing.unsubscribe(); follows.forEach(follow => follow.unsubscribe());  }
  });

  it('observes current owner commands from load replay even though replay records are excluded from history', async () => {
    const { session } = await start();
    const owner = session as unknown as { replaying: boolean; recordUpdate(update: unknown): void; advertisedCommands: Set<string> };
    owner.replaying = true;
    try {
      owner.recordUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [
        { name: 'resumed_command', description: 'Current resumed command', input: { hint: 'topic' } },
      ] });
    } finally { owner.replaying = false; }
    const observation = session.observeConversation(() => {});
    expect(owner.advertisedCommands.has('resumed_command')).toBe(true);
    expect(observation.snapshot.commands).toEqual([{
      name: 'resumed_command', description: { text: 'Current resumed command', bytes: 23 }, inputHint: 'topic',
    }]);
    expect(events(session).some(event => event.source === 'agent_replay')).toBe(false);
    observation.unsubscribe();
  });
});
