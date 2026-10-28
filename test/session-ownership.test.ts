import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ConversationEventStore } from '../src/session/conversation-store.js';
import { readSessionOwnership, recordSessionOwnership, SESSION_OWNERSHIP_FILE } from '../src/session/session-ownership.js';
import { TEMP_SUPERVISOR_FILE } from '../src/temp-lifecycle.js';

const TASK = '0mvrpv4kt1f567911';
const stores: ConversationEventStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function role(metadata?: unknown) {
  mkdirSync('.test-artifacts', { recursive: true });
  const dir = mkdtempSync(join('.test-artifacts', 'session-ownership-'));
  if (metadata !== undefined) writeFileSync(join(dir, TEMP_SUPERVISOR_FILE), typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  const store = new ConversationEventStore(join(dir, '.conversation'), { roleId: 'member' }); stores.push(store);
  return { dir, store, events: () => store.page({ limit: 1000 }).events.filter(event => event.kind === 'session.ownership') };
}

it('a task member generation is bound in the ledger and the durable sidecar before anything else', () => {
  const r = role({ version: 1, role: 'member', launchId: 'launch-1', taskOwner: { taskId: TASK, creationActionId: 'a' } });
  recordSessionOwnership(r.store, 'g1', r.dir);
  expect(r.events().map(e => [e.sessionGeneration, e.payload])).toEqual([['g1', { launchId: 'launch-1', taskId: TASK }]]);
  expect(readSessionOwnership(r.dir)).toEqual({ g1: { launchId: 'launch-1', taskId: TASK } });
});

it('a role without temp metadata is explicitly standalone; the sidecar keeps only recent generations', () => {
  const r = role();
  for (let n = 0; n < 20; n++) recordSessionOwnership(r.store, `g${n}`, r.dir);
  expect(r.events().at(-1)?.payload).toEqual({ launchId: null, taskId: null });
  const kept = readSessionOwnership(r.dir);
  expect(Object.keys(kept)).toHaveLength(16);
  expect(kept.g19).toEqual({ launchId: null, taskId: null });
  expect(kept.g0).toBeUndefined();
});

it('existing but unreadable or invalid metadata is unavailable evidence: the session refuses to start', () => {
  for (const metadata of ['{', { version: 1, role: 'member' }, { version: 1, role: 'member', launchId: 'l', taskOwner: { taskId: 'not-a-task' } }]) {
    const r = role(metadata);
    expect(() => recordSessionOwnership(r.store, 'g', r.dir)).toThrow(/session ownership unavailable/);
    expect(r.events()).toEqual([]);
  }
});

it('a failed binding write fails a task member start and leaves the generation unbound in the ledger', () => {
  const r = role({ version: 1, role: 'member', launchId: 'launch-1', taskOwner: { taskId: TASK, creationActionId: 'a' } });
  const failing = { append: () => { throw new Error('disk full'); }, appendSafe: () => undefined } as unknown as ConversationEventStore;
  expect(() => recordSessionOwnership(failing, 'g1', r.dir)).toThrow('disk full');
  expect(r.events()).toEqual([]);
});

it('a corrupt sidecar is refused by its reader rather than read as standalone', () => {
  const r = role();
  for (const contents of ['{', JSON.stringify({ schema: 1, generations: { g: { launchId: null, taskId: TASK } } }),
    JSON.stringify({ schema: 1, generations: { g: { launchId: 'l', taskId: 'bad/id' } } }), JSON.stringify({ schema: 2, generations: {} })]) {
    writeFileSync(join(r.dir, SESSION_OWNERSHIP_FILE), contents);
    expect(() => readSessionOwnership(r.dir)).toThrow();
  }
  expect(readFileSync(join(r.dir, SESSION_OWNERSHIP_FILE), 'utf8')).toContain('"schema":2');
});
