import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConversationEventStore } from '../src/session/conversation-store.js';
import type { ConversationEventV1 } from '../src/session/conversation-types.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ours-conv-store-'));
  dirs.push(dir);
  return dir;
}

function open(dir = makeDir(), options: { segmentBytes?: number } = {}) {
  return {
    dir,
    store: new ConversationEventStore(join(dir, '.conversation'), {
      roleId: 'role-a', ...options,
    }),
  };
}

const admit = (store: ConversationEventStore, commandId: string, text = 'hello') =>
  store.append({
    kind: 'prompt.admitted',
    sessionGeneration: 'gen-1',
    promptId: `prompt-${commandId}`,
    turnId: `prompt-${commandId}`,
    commandId,
    source: 'browser',
    payload: { text: { type: 'text', text, bytes: Buffer.byteLength(text) }, queuedBehind: 0 },
  });

describe('ConversationEventStore', () => {
  it('assigns durable monotonic sequence numbers and unique event IDs', () => {
    const { store } = open();
    const first = admit(store, 'c1');
    const second = store.append({
      kind: 'prompt.started', sessionGeneration: 'gen-1',
      promptId: first.promptId, turnId: first.turnId, payload: {},
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.schemaVersion).toBe(1);
    expect(first.roleId).toBe('role-a');
    expect(Date.parse(first.at)).not.toBeNaN();
  });

  it('persists events across a reopen, continuing the sequence', () => {
    const { dir, store } = open();
    admit(store, 'c1');
    store.close();
    const reopened = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'role-a' });
    const next = reopened.append({
      kind: 'session.state', sessionGeneration: 'gen-2',
      payload: { status: 'starting' },
    });
    expect(next.seq).toBe(2);
    const page = reopened.page({ limit: 10 });
    expect(page.events.map(event => event.seq)).toEqual([1, 2]);
    expect(page.events[0].payload).toMatchObject({ text: { text: 'hello' } });
  });

  it('creates every file mode 0600', () => {
    const { dir, store } = open();
    admit(store, 'c1');
    const root = join(dir, '.conversation');
    for (const file of readdirSync(root))
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
  });

  it('pages forward with cursors and hasMore', () => {
    const { store } = open();
    for (let i = 0; i < 10; i++) admit(store, `c${i}`);
    const first = store.page({ limit: 4 });
    expect(first.events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
    expect(first.hasMore).toBe(true);
    const second = store.page({ after: first.nextCursor, limit: 4 });
    expect(second.events.map(e => e.seq)).toEqual([5, 6, 7, 8]);
    const last = store.page({ after: second.nextCursor, limit: 4 });
    expect(last.events.map(e => e.seq)).toEqual([9, 10]);
    expect(last.hasMore).toBe(false);
  });

  it('keeps tail and replay-skip paging in memory after more than 1000 events, including recovery', () => {
    const { dir, store } = open();
    for (let i = 0; i < 1100; i++) store.append({ kind: 'session.state', sessionGeneration: 'generation', payload: {} });
    const check = (reader: ConversationEventStore) => {
      const disk = vi.spyOn(reader as any, 'readSegment');
      // A session may skip hundreds of replay events one page at a time.
      for (let after = 101; after < 550; after++) {
        const page = reader.page({ after: String(after), limit: 1 });
        expect(page.events[0].seq).toBe(after + 1);
        expect(page.firstAvailableCursor).toBe('1');
        expect(page.hasMore).toBe(true);
      }
      const empty = reader.page({ after: '1100', limit: 1 });
      expect(empty.events).toEqual([]);
      expect(empty.firstAvailableCursor).toBe('1');
      expect(disk).not.toHaveBeenCalled();
      disk.mockRestore();
    };
    check(store); store.close();
    const reopened = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'role-a' });
    check(reopened); reopened.close();
  });

  it('reports the first readable sequence after an empty/corrupt leading segment and on first append', () => {
    const { dir, store } = open();
    expect(store.page().firstAvailableCursor).toBeUndefined();
    admit(store, 'one'); expect(store.page().firstAvailableCursor).toBe('1'); store.close();
    const root = join(dir, '.conversation');
    writeFileSync(join(root, 'events-000001.jsonl'), 'corrupt\n');
    writeFileSync(join(root, 'events-000002.jsonl'), JSON.stringify({ schemaVersion: 1, seq: 7, kind: 'session.state', payload: {}, sessionGeneration: 'g' }) + '\n');
    writeFileSync(join(root, 'manifest.json'), 'corrupt');
    const recovered = new ConversationEventStore(root, { roleId: 'role-a' });
    expect(recovered.page().firstAvailableCursor).toBe('7');
    expect(recovered.page().events.map(e => e.seq)).toEqual([7]);
    expect(recovered.degraded).toBe(true); recovered.close();
  });

  it('notifies subscribers of each appended event in order', () => {
    const { store } = open();
    const seen: number[] = [];
    const stop = store.subscribe(event => seen.push(event.seq));
    admit(store, 'c1');
    admit(store, 'c2');
    stop();
    admit(store, 'c3');
    expect(seen).toEqual([1, 2]);
  });

  it('returns the stored receipt for a repeated command id', () => {
    const { store } = open();
    const event = admit(store, 'cmd-1', 'the prompt');
    store.recordReceipt('cmd-1', {
      commandId: 'cmd-1', promptId: event.promptId!, state: 'queued',
      queuedBehind: 0, acceptedAt: event.at, eventCursor: String(event.seq),
    }, 'digest-1');
    expect(store.receiptFor('cmd-1', 'digest-1')).toMatchObject({ promptId: event.promptId });
  });

  it('rejects a reused command id with a different body digest', () => {
    const { store } = open();
    const event = admit(store, 'cmd-1');
    store.recordReceipt('cmd-1', {
      commandId: 'cmd-1', promptId: event.promptId!, state: 'queued',
      queuedBehind: 0, acceptedAt: event.at, eventCursor: String(event.seq),
    }, 'digest-1');
    expect(() => store.receiptFor('cmd-1', 'digest-other'))
      .toThrowError(/idempotency/i);
  });

  it('rebuilds the command index from segments on recovery', () => {
    const { dir, store } = open();
    const event = admit(store, 'cmd-1', 'persisted prompt');
    store.recordReceipt('cmd-1', {
      commandId: 'cmd-1', promptId: event.promptId!, state: 'queued',
      queuedBehind: 0, acceptedAt: event.at, eventCursor: String(event.seq),
    }, ConversationEventStore.bodyDigest('persisted prompt'));
    store.close();
    const reopened = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'role-a' });
    const receipt = reopened.receiptFor(
      'cmd-1', ConversationEventStore.bodyDigest('persisted prompt'));
    expect(receipt).toMatchObject({ commandId: 'cmd-1', promptId: event.promptId });
  });

  it('classifies open prompts on recovery: admitted-only vs started', () => {
    const { dir, store } = open();
    const admitted = admit(store, 'c1', 'never started');
    const started = admit(store, 'c2', 'in flight');
    store.append({
      kind: 'prompt.started', sessionGeneration: 'gen-1',
      promptId: started.promptId, turnId: started.turnId, payload: {},
    });
    const finished = admit(store, 'c3', 'done');
    store.append({
      kind: 'prompt.started', sessionGeneration: 'gen-1',
      promptId: finished.promptId, turnId: finished.turnId, payload: {},
    });
    store.append({
      kind: 'turn.completed', sessionGeneration: 'gen-1',
      promptId: finished.promptId, turnId: finished.turnId,
      payload: { outcome: 'completed', stopReason: 'end_turn' },
    });
    store.close();

    const reopened = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'role-a' });
    const openPrompts = reopened.openPrompts();
    expect(openPrompts).toEqual([
      expect.objectContaining({ promptId: admitted.promptId, state: 'admitted' }),
      expect.objectContaining({ promptId: started.promptId, state: 'started' }),
    ]);
    const admittedOpen = openPrompts.find(p => p.promptId === admitted.promptId);
    expect(admittedOpen?.text).toBe('never started');
  });

  it('rotates segments without losing readable history', () => {
    const { dir, store } = open(makeDir(), { segmentBytes: 2_000 });
    for (let i = 0; i < 30; i++) admit(store, `c${i}`, `prompt number ${i}`);
    const root = join(dir, '.conversation');
    const segments = readdirSync(root).filter(name => name.endsWith('.jsonl'));
    expect(segments.length).toBeGreaterThan(1);
    const page = store.page({ limit: 100 });
    expect(page.events).toHaveLength(30);
    expect(page.events.map(e => e.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1));
    store.close();
    const reopened = new ConversationEventStore(root, { roleId: 'role-a' });
    expect(reopened.page({ limit: 100 }).events).toHaveLength(30);
  });

  it('survives a torn final line, marking history degraded but readable', () => {
    const { dir, store } = open();
    admit(store, 'c1');
    admit(store, 'c2');
    store.close();
    const root = join(dir, '.conversation');
    const segment = readdirSync(root).find(name => name.endsWith('.jsonl'))!;
    appendFileSync(join(root, segment), '{"schemaVersion":1,"seq":3,"kind":"trunc');
    const reopened = new ConversationEventStore(root, { roleId: 'role-a' });
    expect(reopened.degraded).toBe(true);
    expect(reopened.page({ limit: 10 }).events.map(e => e.seq)).toEqual([1, 2]);
    // The store must keep working after the torn tail.
    const next = reopened.append({
      kind: 'session.state', sessionGeneration: 'gen-2', payload: { status: 'starting' },
    });
    expect(next.seq).toBe(3);
  });

  it('throws on append when the store directory is unwritable', () => {
    const { dir, store } = open();
    admit(store, 'c1');
    store.close();
    const root = join(dir, '.conversation');
    chmodSync(root, 0o400);
    try {
      const readonly = new ConversationEventStore(root, { roleId: 'role-a' });
      expect(() => admit(readonly, 'c2')).toThrow();
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('appendSafe swallows failures and flags degradation instead of throwing', () => {
    const { dir, store } = open();
    admit(store, 'c1');
    store.close();
    const root = join(dir, '.conversation');
    chmodSync(root, 0o400);
    try {
      const readonly = new ConversationEventStore(root, { roleId: 'role-a' });
      const result = readonly.appendSafe({
        kind: 'message.chunk', sessionGeneration: 'gen-1',
        payload: { role: 'assistant', content: { type: 'text', text: 'x', bytes: 1 } },
      });
      expect(result).toBeUndefined();
      expect(readonly.degraded).toBe(true);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('starts fresh with a boundary manifest when none exists', () => {
    const { store } = open();
    const page = store.page({ limit: 10 });
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(store.degraded).toBe(false);
  });

  it('ignores a corrupt manifest and recovers from segments', () => {
    const { dir, store } = open();
    admit(store, 'c1');
    store.close();
    const root = join(dir, '.conversation');
    writeFileSync(join(root, 'manifest.json'), 'not json', { mode: 0o600 });
    const reopened = new ConversationEventStore(root, { roleId: 'role-a' });
    expect(reopened.page({ limit: 10 }).events.map(e => e.seq)).toEqual([1]);
    expect(reopened.append({
      kind: 'session.state', sessionGeneration: 'gen-2', payload: { status: 'starting' },
    }).seq).toBe(2);
  });
});
