import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentRecords, resolveSources, type ChannelSources } from '../src/channels/sources.js';
import { ChannelsStore, ENDED_RETENTION_MS } from '../src/channels/store.js';
import { ChannelsIndexer, edgesFrom, type ResourceFrame } from '../src/channels/indexer.js';
import { IdentityReadError, type ContactsActivity, type IdentityReader } from '../src/channels/identity-reads.js';
import { ChannelsService } from '../src/channels/service.js';

const cid = (n: number) => n.toString(16).toUpperCase().padStart(64, '0');
const OWNER = cid(1), ROOT = cid(2), SALES = cid(3), SUPPORT = cid(4), ROOM = cid(5);
const ACME_A = cid(10), ACME_B = cid(11), SOLO = cid(12), ACME_ROOT = cid(13), OTHER_ROOT = cid(14);

const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

describe('channel sources', () => {
  it('keeps the Owner perspective CID distinct from the actual root and excludes only local identities', () => {
    const found = resolveSources({
      ownerCid: OWNER.toLowerCase(),
      identities: [
        { name: 'Owner', cid: OWNER, kind: 'role' }, { name: 'Human', cid: ROOT, kind: 'root' },
        { name: 'sales', cid: SALES, kind: 'role' },
      ],
      agents: [{ name: 'sales', cid: SALES, phase: 'SERVING' }, { name: 'support', cid: SUPPORT, phase: 'SERVING' },
        { name: 'foreign-import', cid: cid(20), phase: 'SERVING' }],
      roleByIdentity: new Map([['sales', 'Sales'], ['support', 'Support']]),
      roomCids: [ROOM],
    });
    expect(found.ownerCid).toBe(OWNER);
    expect(found.rootCid).toBe(ROOT);
    expect([...found.internal].sort()).toEqual([OWNER, ROOT, SALES, SUPPORT, ROOM, cid(20)].sort());
    expect(found.sources).toEqual([
      { kind: 'owner', name: 'Owner', cid: OWNER, ended: false },
      { kind: 'agent', name: 'sales', cid: SALES, roleId: 'Sales', ended: false },
      // A stopped agent keeps its retained record; it is ended only when its identity is gone.
      { kind: 'agent', name: 'support', cid: SUPPORT, roleId: 'Support', ended: true },
    ]);
  });

  it('reads retained journals, including stopped and retired generations', () => {
    const root = tempDir('channels-journals-');
    const write = (path: string, value: object) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
    write(join(root, 'a', 'state.json'), { name: 'sales', cid: SALES.toLowerCase(), phase: 'OWNED' });
    write(join(root, 'b', 'retired-x', 'state.json'), { name: 'old', cid: SUPPORT, phase: 'SERVING' });
    write(join(root, 'c', 'state.json'), { name: 'broken' });
    expect(readAgentRecords(root)).toEqual(expect.arrayContaining([
      { name: 'sales', cid: SALES, phase: 'OWNED' }, { name: 'old', cid: SUPPORT, phase: 'RELEASED' },
    ]));
    expect(readAgentRecords(join(root, 'missing'))).toEqual([]);
  });
});

describe('channels store', () => {
  const sources = [
    { kind: 'owner' as const, name: 'Owner', cid: OWNER, ended: false },
    { kind: 'agent' as const, name: 'sales', cid: SALES, roleId: 'Sales', ended: false },
    { kind: 'agent' as const, name: 'support', cid: SUPPORT, roleId: 'Support', ended: false },
  ];
  const store = (now = () => Date.parse('2026-11-02T12:00:00Z')) => { const s = new ChannelsStore(tempDir('channels-store-'), now); clean.push(() => s.close()); s.setSources(sources); return s; };

  it('deduplicates one contact across perspectives and keeps sibling contacts separate', () => {
    const s = store();
    s.replaceEdges(OWNER, [{ contactCid: ACME_A, contactName: 'Acme Support', lastActivity: '2026-11-02T10:00:00.000Z', rootCid: ACME_ROOT, rootName: 'Acme', roleId: 'support' }]);
    s.replaceEdges(SALES, [
      { contactCid: ACME_A, contactName: 'Acme Support', lastActivity: '2026-11-02T11:00:00.000Z', rootCid: ACME_ROOT, rootName: 'Acme', roleId: 'support' },
      { contactCid: ACME_B, contactName: 'Acme Billing', lastActivity: '2026-11-02T09:00:00.000Z', rootCid: ACME_ROOT, rootName: 'Acme', roleId: 'billing' },
    ]);
    const page = s.list();
    expect(page.channels.map(c => [c.cid, c.perspectives, c.ownerConnected])).toEqual([[ACME_A, 2, true], [ACME_B, 1, false]]);
    expect(page.channels[0].lastActivity).toBe('2026-11-02T11:00:00.000Z');
    expect(s.list({ root: ACME_ROOT }).channels).toHaveLength(2);
    const detail = s.get(ACME_A)!;
    expect(detail.perspectives.map(p => [p.sourceName, p.kind, p.lastActivity])).toEqual([
      ['sales', 'agent', '2026-11-02T11:00:00.000Z'], ['Owner', 'owner', '2026-11-02T10:00:00.000Z'],
    ]);
    expect(s.hasPerspective(ACME_A, SUPPORT)).toBeNull();
    // Replacing a source's edges removes its stale perspectives and empty channels.
    s.replaceEdges(SALES, []);
    expect(s.get(ACME_B)).toBeNull();
    expect(s.get(ACME_A)!.channel.perspectives).toBe(1);
  });

  it('keeps conflicting root claims visible instead of choosing one', () => {
    const s = store();
    s.replaceEdges(OWNER, [{ contactCid: SOLO, contactName: 'X', lastActivity: '2026-11-02T10:00:00.000Z', rootCid: ACME_ROOT, rootName: 'Acme' }]);
    s.replaceEdges(SALES, [{ contactCid: SOLO, contactName: 'X', lastActivity: '2026-11-02T10:00:00.000Z', rootCid: OTHER_ROOT, rootName: 'Other' }]);
    const row = s.get(SOLO)!;
    expect(row.channel.conflictingRootClaims).toBe(true);
    expect(row.channel.claimedRoot).toBeUndefined();
    expect(row.perspectives.map(p => p.claimedRoot?.rootCid).sort()).toEqual([ACME_ROOT, OTHER_ROOT].sort());
  });

  it('paginates by last activity with a stable keyset cursor and searches name, root and CID prefix', () => {
    const s = store();
    s.replaceEdges(OWNER, [1, 2, 3, 4, 5].map(n => ({ contactCid: cid(100 + n), contactName: `Contact ${n}`, lastActivity: `2026-11-02T0${n}:00:00.000Z`, ...(n === 2 ? { rootCid: ACME_ROOT, rootName: 'Acme' } : {}) })));
    const first = s.list({ limit: 2 });
    expect(first.channels.map(c => c.name)).toEqual(['Contact 5', 'Contact 4']);
    const second = s.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.channels.map(c => c.name)).toEqual(['Contact 3', 'Contact 2']);
    expect(s.list({ limit: 2, cursor: second.nextCursor! }).channels.map(c => c.name)).toEqual(['Contact 1']);
    expect(s.list({ q: 'acme' }).channels.map(c => c.name)).toEqual(['Contact 2']);
    expect(s.list({ q: cid(103).toLowerCase() }).channels.map(c => c.name)).toEqual(['Contact 3']);
    expect(() => s.list({ cursor: 'garbage' })).toThrow('invalid channels cursor');
  });

  it('hides rows whose perspectives all ended after the retention window, keeping ended metadata', () => {
    let now = Date.parse('2026-11-02T12:00:00Z');
    const s = store(() => now);
    s.replaceEdges(SUPPORT, [{ contactCid: SOLO, contactName: 'Old', lastActivity: '2026-11-01T12:00:00.000Z' }]);
    s.setSources(sources.map(x => (x.cid === SUPPORT ? { ...x, ended: true } : x)));
    expect(s.list().channels.map(c => c.cid)).toEqual([SOLO]);
    expect(s.get(SOLO)!.perspectives[0].ended).toBe(true);
    now += ENDED_RETENTION_MS;
    expect(s.list().channels).toEqual([]);
    expect(s.get(SOLO)).not.toBeNull();
    // A source that leaves the workspace entirely takes its edges with it.
    s.setSources(sources.filter(x => x.cid !== SUPPORT));
    expect(s.get(SOLO)).toBeNull();
  });
});

function observation(source: string, contacts: Array<[string, string, string?]>, position = 1, roots: Record<string, any> = {}): ContactsActivity {
  return {
    identity: { name: source, cid: OWNER }, source: { protocolVersion: 1, producerGeneration: 'g1', position },
    contacts: contacts.map(([c, name]) => ({ name, container_id: c })),
    roots, activity: Object.fromEntries(contacts.map(([c, , at]) => [c, { at: at ?? '' }])),
  };
}

describe('channels indexer', () => {
  it('excludes internal identities and maps claimed roots per edge', () => {
    const edges = edgesFrom(observation('Owner', [[SALES, 'sales'], [ACME_A, 'Acme', '2026-11-02T10:00:00.000Z']], 1,
      { [ACME_A]: { root_cid: ACME_ROOT.toLowerCase(), root_name: 'Acme', role_id: 'support' } }), new Set([SALES]));
    expect(edges).toEqual([{ contactCid: ACME_A, contactName: 'Acme', lastActivity: '2026-11-02T10:00:00.000Z', rootCid: ACME_ROOT, rootName: 'Acme', roleId: 'support' }]);
  });

  it('reads only changed sources, ignores coverage and unchanged positions, coalesces bursts and pins the source', async () => {
    vi.useFakeTimers();
    clean.push(() => vi.useRealTimers());
    const store = new ChannelsStore(tempDir('channels-indexer-')); clean.push(() => store.close());
    const streams = new Map<string, { push(frame: ResourceFrame): void; end(): void }>();
    const events = {
      resourceEvents(identity: string, options: { signal: AbortSignal; expectedGeneration?: string }) {
        const queue: ResourceFrame[] = []; let wake: (() => void) | undefined; let done = false;
        streams.set(identity, { push(frame) { queue.push(frame); wake?.(); }, end() { done = true; wake?.(); } });
        options.signal.addEventListener('abort', () => { done = true; wake?.(); });
        return (async function* () {
          for (;;) {
            while (queue.length) yield queue.shift()!;
            if (done) return;
            await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
          }
        })();
      },
    };
    let position = 1;
    const calls: Array<{ identity: string; expectedProducerGeneration?: string }> = [];
    const reader: IdentityReader = {
      contactsActivity: vi.fn(async ref => { calls.push(ref); return observation(ref.identity, [[ACME_A, 'Acme', '2026-11-02T10:00:00.000Z']], position); }),
      history: vi.fn(),
    };
    const discovered: ChannelSources = {
      ownerCid: OWNER, rootCid: ROOT, internal: new Set([OWNER, ROOT, SALES]),
      sources: [{ kind: 'owner', name: 'Owner', cid: OWNER, ended: false }, { kind: 'agent', name: 'sales', cid: SALES, roleId: 'Sales', ended: false }],
    };
    const onChange = vi.fn();
    const indexer = new ChannelsIndexer({ store, reader, events, discover: async () => discovered, onChange, log: () => {} });
    clean.push(() => indexer.stop());
    await indexer.sync();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.map(c => c.identity).sort()).toEqual(['Owner', 'sales']); // bounded bootstrap: one read per source
    expect(store.get(ACME_A)!.channel.perspectives).toBe(2);

    calls.length = 0;
    streams.get('Owner')!.push({ kind: 'ready', producerGeneration: 'g1', position: 1 });
    streams.get('Owner')!.push({ kind: 'coverage', producerGeneration: 'g1', position: 1 });
    streams.get('Owner')!.push({ kind: 'committed', producerGeneration: 'g1', position: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([]); // ready at the observed position, coverage and an unchanged commit do no work

    position = 4;
    for (const p of [2, 3, 4]) streams.get('sales')!.push({ kind: 'committed', producerGeneration: 'g1', position: p });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([{ identity: 'sales', expectedCid: SALES, expectedProducerGeneration: 'g1' }]); // burst coalesced, only that source
  });

  it('drops a stale generation pin and marks unavailable sources stale', async () => {
    const store = new ChannelsStore(tempDir('channels-indexer-')); clean.push(() => store.close());
    const sequence: Array<() => Promise<ContactsActivity>> = [
      async () => { throw new IdentityReadError(409, 'source_generation_changed', 'gen'); },
      async () => observation('Owner', [[SOLO, 'Solo']], 7),
    ];
    const reader: IdentityReader = { contactsActivity: vi.fn(() => sequence.shift()!()), history: vi.fn() };
    const events = { resourceEvents: () => (async function* () { await new Promise(() => {}); })() };
    const indexer = new ChannelsIndexer({ store, reader, events, debounceMs: 1, log: () => {}, onChange: () => {},
      discover: async () => ({ ownerCid: OWNER, internal: new Set([OWNER]), sources: [{ kind: 'owner', name: 'Owner', cid: OWNER, ended: false }] }) });
    clean.push(() => indexer.stop());
    await indexer.sync();
    await vi.waitFor(() => expect(store.get(SOLO)).not.toBeNull());
    expect(reader.contactsActivity).toHaveBeenCalledTimes(2);
  });
});

describe('channels service', () => {
  it('serves one perspective history through the lease-free read and refuses non-perspectives', async () => {
    const store = new ChannelsStore(tempDir('channels-service-')); clean.push(() => store.close());
    store.setSources([{ kind: 'owner', name: 'Owner', cid: OWNER, ended: false }, { kind: 'agent', name: 'sales', cid: SALES, roleId: 'Sales', ended: false }]);
    store.replaceEdges(SALES, [{ contactCid: ACME_A, contactName: 'Acme', lastActivity: '2026-11-02T10:00:00.000Z', rootCid: ROOT, rootName: 'Mine' }]);
    const history = vi.fn(async () => ({ identity: { name: 'sales', cid: SALES }, source: { protocolVersion: 1 as const, producerGeneration: 'g', position: 1 }, items: [], next_cursor: null }));
    const service = new ChannelsService({ store, reader: { contactsActivity: vi.fn(), history }, indexer: { sync: vi.fn() } as any,
      ownerRoot: () => ROOT, ready: () => true });
    expect(service.list({}).channels[0].claimsOwnerRoot).toBe(true); // claimed, still external
    const page = await service.history(ACME_A.toLowerCase(), SALES, { limit: 20 });
    expect(history).toHaveBeenCalledWith({ identity: 'sales', expectedCid: SALES, peer_cid: ACME_A, limit: 20 });
    expect(page.perspective).toEqual({ sourceCid: SALES, kind: 'agent', roleId: 'Sales' });
    await expect(service.history(ACME_A, OWNER, {})).rejects.toMatchObject({ code: 'resource_not_found' });
    expect(() => service.get(SOLO)).toThrow('no such channel');
  });
});

describe('channels resource view', () => {
  it('wakes only the channels view for its private database and ignores unrelated commits', async () => {
    const { EventEmitter } = await import('node:events');
    const { FleetResourceViews } = await import('../src/web/resource-views.js');
    const { publishFleetResourceCommit } = await import('../src/application/resource-observer.js');
    const { agentsRoot, stateRoot } = await import('../src/paths.js');
    const root = tempDir('channels-views-');
    const response = new EventEmitter() as any; response.write = vi.fn(() => true); response.end = vi.fn();
    const projected: string[] = [];
    // The production scope: default coverage, which must include the Channels database.
    const views = new FleetResourceViews({ configPath: join(root, 'fleet.yaml'), watch: () => { const h = new EventEmitter() as any; h.close = vi.fn(); return h; } },
      async (descriptor: any) => { projected.push(descriptor.resource); return { rows: projected.length }; }, () => [], 20);
    clean.push(() => views.close());
    const connection = views.open(response, 'owner', () => true);
    for (const [viewId, resource] of [['c', 'channels'], ['d', 'directory']] as const) {
      const binding = views.register('owner', connection.connectionId, viewId, 1, { viewId, resource });
      await views.bound('owner', connection.connectionId, viewId, 1, binding.baselineId);
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 400));
    await settle(); projected.length = 0;
    publishFleetResourceCommit(join(stateRoot(), 'private-channels', 'channels.db'));
    await settle();
    expect(projected).toEqual(['channels']);
    projected.length = 0;
    publishFleetResourceCommit(join(agentsRoot(), 'role', 'state.json'));
    await settle();
    expect(projected).toEqual(['directory']);
  });
});

describe('channels lifecycle', () => {
  const owner = { kind: 'owner' as const, name: 'Owner', cid: OWNER, ended: false };
  const sales = { kind: 'agent' as const, name: 'sales', cid: SALES, roleId: 'Sales', ended: false };
  const idle = { resourceEvents: () => (async function* () { await new Promise(() => {}); })() };

  it('never touches a closed store or publishes after stop, even when an in-flight read settles later', async () => {
    const store = new ChannelsStore(tempDir('channels-shutdown-'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    clean.push(() => { process.off('unhandledRejection', onUnhandled); });
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const reader: IdentityReader = {
      contactsActivity: (_ref, signal) => new Promise((_resolve, reject) => {
        started();
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
      history: vi.fn(),
    };
    const onChange = vi.fn();
    const indexer = new ChannelsIndexer({ store, reader, events: idle, debounceMs: 1, log: () => {}, onChange,
      discover: async () => ({ ownerCid: OWNER, internal: new Set([OWNER]), sources: [owner] }) });
    await indexer.sync();
    await reading;
    const published = onChange.mock.calls.length;
    indexer.stop();
    store.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(published);
  });

  it('removes newly internal identities from every cached edge, ended sources included, without daemon reads', async () => {
    const store = new ChannelsStore(tempDir('channels-exclusion-')); clean.push(() => store.close());
    const ended = { ...sales, ended: true };
    let found: ChannelSources = { ownerCid: OWNER, internal: new Set([OWNER, SALES]), sources: [ended] };
    const reader: IdentityReader = { contactsActivity: vi.fn(), history: vi.fn() };
    const indexer = new ChannelsIndexer({ store, reader, events: idle, log: () => {}, onChange: () => {}, discover: async () => found });
    clean.push(() => indexer.stop());
    await indexer.sync();
    store.replaceEdges(SALES, [{ contactCid: SOLO, contactName: 'Now an agent', lastActivity: '2026-11-02T10:00:00.000Z' },
      { contactCid: ACME_A, contactName: 'Acme', lastActivity: '2026-11-02T09:00:00.000Z' }]);
    found = { ...found, internal: new Set([OWNER, SALES, SOLO]) };
    await indexer.sync();
    expect(store.get(SOLO)).toBeNull();
    expect(store.list().channels.map(c => c.cid)).toEqual([ACME_A]);
    expect(reader.contactsActivity).not.toHaveBeenCalled();
  });

  function serviceFixture(history: IdentityReader['history']) {
    const store = new ChannelsStore(tempDir('channels-history-')); clean.push(() => store.close());
    store.setSources([owner, sales]);
    store.replaceEdges(SALES, [{ contactCid: ACME_A, contactName: 'Acme', lastActivity: '2026-11-02T10:00:00.000Z' }], { producerGeneration: 'g1', position: 4 });
    const indexer = { sync: vi.fn(), invalidate: vi.fn() };
    const service = new ChannelsService({ store, reader: { contactsActivity: vi.fn(), history }, indexer: indexer as any, ownerRoot: () => undefined, ready: () => true });
    return { store, indexer, service };
  }
  const page = { identity: { name: 'sales', cid: SALES }, source: { protocolVersion: 1 as const, producerGeneration: 'g1', position: 4 }, items: [{ seq: 1, wire_id: 'W' }], next_cursor: null };

  it('pins history to the observed source generation and invalidates the source when it changed', async () => {
    const history = vi.fn(async () => { throw new IdentityReadError(409, 'source_generation_changed', 'gen'); });
    const { service, indexer } = serviceFixture(history);
    await expect(service.history(ACME_A, SALES, {})).rejects.toMatchObject({ code: 'conflict' });
    expect(history).toHaveBeenCalledWith({ identity: 'sales', expectedCid: SALES, peer_cid: ACME_A, expectedProducerGeneration: 'g1' });
    expect(indexer.invalidate).toHaveBeenCalledWith(SALES);
  });

  it('discards a history response whose perspective left, ended or was re-observed during the read', async () => {
    for (const change of ['removed', 'ended', 'replaced'] as const) {
      let release!: () => void;
      const { store, service } = serviceFixture(() => new Promise(resolve => { release = () => resolve(page); }));
      const pending = service.history(ACME_A, SALES, {});
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      if (change === 'removed') store.setSources([owner]);
      if (change === 'ended') store.setSources([owner, { ...sales, ended: true }]);
      if (change === 'replaced') store.replaceEdges(SALES, [{ contactCid: ACME_A, contactName: 'Acme', lastActivity: '2026-11-02T11:00:00.000Z' }], { producerGeneration: 'g2', position: 1 });
      release();
      await expect(pending, change).rejects.toMatchObject({ code: { removed: 'resource_not_found', ended: 'capability_unavailable', replaced: 'conflict' }[change] });
    }
  });
});

describe('channels source inputs', () => {
  it('re-derive sources for manifest, role definition, journal and room commits, never for the index or conversation ledgers', async () => {
    const { channelSourceInputs, channelsPrivateDir } = await import('../src/channels/runtime.js');
    const { agentsRoot, stateRoot, tmpRoot } = await import('../src/paths.js');
    const config = join(tempDir('channels-inputs-'), 'fleet.yaml');
    const { affects } = channelSourceInputs(config);
    for (const path of [config, join(config.slice(0, -5), 'roles', 'sales.yaml'), join(stateRoot(), 'private-ours', 'b', 'state.json'),
      join(stateRoot(), 'private-ours', 'b', 'retired-1', 'state.json'), join(stateRoot(), 'rooms', 'r.json'),
      join(tmpRoot(), 'temp-agent'), join(tmpRoot(), 'temp-agent', 'role.yaml'), join(agentsRoot(), 'sales'), stateRoot()])
      expect(affects(path), path).toBe(true);
    for (const path of [join(channelsPrivateDir(), 'channels.db'), join(channelsPrivateDir(), 'channels.db-wal'),
      join(agentsRoot(), 'sales', 'conversation.jsonl'), join(tmpRoot(), 'temp-agent', 'logs', 'x.log'), join(stateRoot(), 'web', 'audit', 'audit.jsonl')])
      expect(affects(path), path).toBe(false);
  });
});
