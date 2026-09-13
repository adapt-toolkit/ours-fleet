import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpSession } from '../src/session/acp.js';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import type { CompactionUpdatedPayload, ConversationEventV1 } from '../src/session/conversation-types.js';
import { emptyModel, applyEvents } from '../web/src/conversation-model.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-agent.mjs');
const dirs: string[] = [];
const sessions: AcpSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-history-'));
  dirs.push(dir);
  return dir;
}
function append(store: ConversationEventStore, status: CompactionUpdatedPayload['status'],
  id = 'c1', sessionId = 'fixture-session', replayed = false) {
  return store.append({ kind: 'compaction.updated', sessionGeneration: 'old-generation',
    acpSessionId: sessionId, source: replayed ? 'agent_replay' : 'agent',
    payload: { sessionId, compactionId: id, status, replayed } });
}
async function resume(dir: string, replay?: string) {
  writeFileSync(join(dir, '.acp-session-id'), 'fixture-session\n');
  const session = await AcpSession.start({ name: 'A', argv: [process.execPath, fixture],
    cwd: dir, stateDir: dir, mode: 'resume', env: {
      ACP_FIXTURE_LOAD_SESSION: '1', ...(replay ? { ACP_FIXTURE_REPLAY_COMPACTION: replay } : {}),
    }, permissions: { approval: 'allow', filesystem: 'workspace', unattended: 'deny' }, log: () => {},
  });
  sessions.push(session);
  return session;
}
function pageAll(session: AcpSession) {
  const events: ConversationEventV1[] = [];
  let after: string | undefined;
  for (;;) {
    const page = session.conversationPage({ after, limit: 2 });
    events.push(...page.events);
    if (!page.hasMore || !page.nextCursor) return events;
    after = page.nextCursor;
  }
}

describe('durable compaction recovery', () => {
  it('indexes latest unsettled lifecycles across disk segments and keeps terminals closed', () => {
    const dir = directory();
    let store = new ConversationEventStore(dir, { roleId: 'A', segmentBytes: 1 });
    append(store, 'in_progress');
    append(store, 'in_progress', 'c2');
    append(store, 'completed', 'c2');
    append(store, 'in_progress', 'c2', 'fixture-session', true);
    append(store, 'unknown', 'c3');
    append(store, 'cancelled', 'c3');
    store.close();
    expect(readdirSync(dir).filter(file => file.endsWith('.jsonl')).length).toBeGreaterThan(1);
    store = new ConversationEventStore(dir, { roleId: 'A' });
    expect(store.openCompactions().map(event => (event.payload as CompactionUpdatedPayload).compactionId)).toEqual(['c1']);
    expect(store.compactionStates().map(event => (event.payload as CompactionUpdatedPayload).status))
      .toEqual(['in_progress', 'completed', 'cancelled']);
    store.close();
  });

  it('refines local unknown_ended with authoritative terminal evidence without reopening starts', () => {
    const store = new ConversationEventStore(directory(), { roleId: 'A' });
    append(store, 'in_progress');
    append(store, 'unknown_ended');
    append(store, 'in_progress', 'c1', 'fixture-session', true);
    expect(store.openCompactions()).toEqual([]);
    append(store, 'completed', 'c1', 'fixture-session', true);
    expect((store.compactionStates()[0].payload as CompactionUpdatedPayload).status).toBe('completed');
    store.close();
  });

  it('closes crash-left live activity historically and exposes only current logical-session compaction history', async () => {
    const dir = directory();
    const store = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'A', segmentBytes: 1 });
    append(store, 'in_progress');
    append(store, 'completed', 'other', 'other-session');
    store.append({ kind: 'message.chunk', sessionGeneration: 'old-generation', source: 'agent',
      payload: { content: { type: 'text', text: 'OLD-ASSISTANT-BODY', bytes: 18 } } });
    store.close();
    const session = await resume(dir);
    expect(session.snapshot().activeCompactionIds).toEqual([]);
    expect(session.eventsSince(0).filter(event => event.kind === 'compaction')).toEqual([]);
    const events = pageAll(session);
    const compactions = events.filter(event => event.kind === 'compaction.updated');
    expect(compactions.map(event => (event.payload as CompactionUpdatedPayload).status)).toEqual(['in_progress', 'unknown_ended']);
    expect(JSON.stringify(events)).not.toContain('OLD-ASSISTANT-BODY');
    expect(JSON.stringify(compactions)).not.toContain('other-session');
    expect(await session.submitPrompt('hello')).toMatchObject({ outcome: 'completed' });
  });

  it('projects actual load replay as one completed row without occupancy or live notifications', async () => {
    const dir = directory();
    const store = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'A' });
    append(store, 'in_progress', 'history-c');
    store.close();
    const session = await resume(dir, '1');
    const events = pageAll(session);
    const model = applyEvents(emptyModel(), events);
    expect(model.compactions).toHaveLength(1);
    expect(model.compactions[0].status).toBe('completed');
    expect(session.snapshot().activeCompactionIds).toEqual([]);
    expect(session.eventsSince(0).filter(event => event.kind === 'compaction')).toEqual([]);
  });

  it('follows same-session compaction history while rejecting other-session and ordinary replay events', async () => {
    const session = await resume(directory());
    const seen: ConversationEventV1[] = [];
    const unsubscribe = session.subscribeConversation(event => seen.push(event));
    const store = (session as unknown as { conversation: ConversationEventStore }).conversation;
    append(store, 'completed', 'same', 'fixture-session', true);
    append(store, 'completed', 'other', 'other-session', true);
    store.append({ kind: 'message.chunk', sessionGeneration: session.conversationSnapshot().sessionGeneration,
      source: 'agent_replay', payload: { content: { type: 'text', text: 'HIDDEN-REPLAY-TEXT', bytes: 18 } } });
    unsubscribe();
    expect(seen).toHaveLength(1);
    expect((seen[0].payload as CompactionUpdatedPayload).compactionId).toBe('same');
    expect(JSON.stringify(pageAll(session))).not.toContain('HIDDEN-REPLAY-TEXT');
  });

  it('closes an unresolved replay start as historical unknown at the end of load', async () => {
    const session = await resume(directory(), 'missing');
    const events = pageAll(session).filter(event => event.kind === 'compaction.updated');
    expect(events.map(event => (event.payload as CompactionUpdatedPayload).status))
      .toEqual(['in_progress', 'unknown_ended']);
    expect(events.every(event => event.source === 'agent_replay')).toBe(true);
    expect(session.snapshot().activeCompactionIds).toEqual([]);
    expect(session.snapshot().readiness).toBe('idle');
  });
});
