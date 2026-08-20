import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpSession, promptContentBlocks, runtimeSelector } from '../src/session/acp.js';
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
  extra: { stateDir?: string; mode?: 'fresh' | 'resume'; env?: Record<string, string> } = {},
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

  it('marks replayed session/load history with agent_replay provenance', async () => {
    const { session, stateDir } = await start('allow', {
      env: { ACP_FIXTURE_LOAD_SESSION: '1', ACP_FIXTURE_REPLAY: '1' },
    });
    await session.close();
    sessions.pop();
    const { session: resumed } = await start('allow', {
      stateDir, mode: 'resume',
      env: { ACP_FIXTURE_LOAD_SESSION: '1', ACP_FIXTURE_REPLAY: '1' },
    });
    const replayed = events(resumed).filter(event => event.source === 'agent_replay');
    expect(replayed.length).toBe(2);
    expect((replayed[0].payload as MessageChunkPayload).role).toBe('user');
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
    // Wait for the restored prompt's turn to finish.
    for (let i = 0; i < 200 && !events(session).some(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-queued'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));

    const all = events(session);
    const unknown = all.find(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-started')!;
    expect((unknown.payload as TurnCompletedPayload).outcome).toBe('unknown_after_restart');
    // The never-started prompt ran for real — no new admission, one start, one end.
    expect(all.filter(e => e.kind === 'prompt.admitted' && e.promptId === 'p-queued'))
      .toHaveLength(1);
    const completed = all.find(e =>
      e.kind === 'turn.completed' && e.promptId === 'p-queued')!;
    expect((completed.payload as TurnCompletedPayload).outcome).toBe('completed');
    const echo = all.find(e => e.kind === 'message.chunk' && e.promptId === 'p-queued');
    expect((echo?.payload as MessageChunkPayload).content)
      .toMatchObject({ text: 'echo:never started' });
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
