import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TOPOLOGY_DRAFT_VERSION, TopologyDraftStore, emptyDraft,
} from '../../src/web/topology-draft-store.js';

describe('topology draft sidecar', () => {
  let dir: string;
  let store: TopologyDraftStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ours-fleet-topology-draft-'));
    store = new TopologyDraftStore({ dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const populated = () => ({
    version: TOPOLOGY_DRAFT_VERSION,
    positions: { 'agent:Alice': { x: 410, y: 62 }, 'watchdog:health': { x: 80, y: 10.5 } },
    drafts: {
      nodes: [
        { id: 'agent:Reviewer', kind: 'agent', fields: { mission: '' } },
        { id: 'watchdog:health', kind: 'watchdog', fields: { coordinator: 'Alice', enabled: true } },
        { id: 'loop:nightly', kind: 'loop', fields: { prompt: 'check in', interval: '1h' } },
      ],
      edges: [
        { kind: 'watches', from: 'watchdog:health', to: 'agent:Reviewer' },
        { kind: 'targets', from: 'loop:nightly', to: 'agent:Alice' },
      ],
    },
    tutorial: { step: 2, dismissed: false },
  });

  it('serves an empty writable draft when no sidecar exists yet', () => {
    const read = store.read();
    expect(read.draft).toEqual(emptyDraft());
    expect(read.writable).toBe(true);
    expect(read.problem).toBeUndefined();
    expect(existsSync(store.path)).toBe(false);
  });

  it('round-trips a populated draft through an atomic 0600 write', async () => {
    const opened = store.read();
    const written = await store.write(opened.revision, populated());

    expect(written.draft).toEqual(populated());
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const reopened = store.read();
    expect(reopened.draft).toEqual(populated());
    expect(reopened.revision).toBe(written.revision);
    expect(reopened.problem).toBeUndefined();
  });

  it('refuses a stale write and leaves the stored draft untouched', async () => {
    const opened = store.read();
    await store.write(opened.revision, populated());

    await expect(store.write(opened.revision, emptyDraft()))
      .rejects.toThrow(/changed since they were opened/);
    expect(store.read().draft.drafts.nodes).toHaveLength(3);
    await expect(store.write('', populated())).rejects.toThrow(/changed since they were opened/);
    expect(existsSync(`${store.path}.lock`)).toBe(false);
  });

  it('accepts a fresh revision after a concurrent write', async () => {
    const first = await store.write(store.read().revision, populated());
    const second = await store.write(first.revision, emptyDraft());
    expect(second.draft.drafts.nodes).toHaveLength(0);
  });

  it('degrades to an empty draft when the sidecar is corrupt, and can overwrite it', async () => {
    writeFileSync(store.path, '{ not json', { mode: 0o600 });
    const read = store.read();

    expect(read.draft).toEqual(emptyDraft());
    expect(read.writable).toBe(true);
    expect(read.problem).toMatchObject({ code: 'draft_corrupt', severity: 'warning', source: 'topology.json' });

    await store.write(read.revision, populated());
    expect(store.read().problem).toBeUndefined();
  });

  it('refuses to clobber a sidecar written by a newer console', async () => {
    writeFileSync(store.path, JSON.stringify({ version: TOPOLOGY_DRAFT_VERSION + 1, positions: {} }), { mode: 0o600 });
    const read = store.read();

    expect(read.writable).toBe(false);
    expect(read.problem).toMatchObject({ code: 'draft_version_unsupported' });
    expect(read.problem?.detail).toContain('newer console');
    await expect(store.write(read.revision, populated())).rejects.toThrow(/newer console/);
    expect(JSON.parse(readFileSync(store.path, 'utf8')).version).toBe(TOPOLOGY_DRAFT_VERSION + 1);
  });

  it('ignores an oversized, non-regular or foreign-owned sidecar without throwing', () => {
    writeFileSync(store.path, `{"version":1,"pad":"${'x'.repeat(300 * 1024)}"}`, { mode: 0o600 });
    expect(store.read()).toMatchObject({ draft: emptyDraft(), problem: { code: 'draft_unreadable' } });

    rmSync(store.path);
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, '{"version":1}', { mode: 0o600 });
    symlinkSync(target, store.path);
    expect(store.read()).toMatchObject({ problem: { code: 'draft_unreadable' } });
  });

  it('drops unknown fields and malformed entries on read instead of failing', () => {
    writeFileSync(store.path, JSON.stringify({
      version: 1,
      surprise: 'ignored',
      positions: {
        'agent:Alice': { x: 1, y: 2, z: 3 },
        'agent:Bad Name': { x: 1, y: 2 },
        'agent:Huge': { x: 1e9, y: 0 },
        'agent:NaN': { x: 'left', y: 2 },
      },
      drafts: {
        nodes: [
          { id: 'agent:Ok', kind: 'agent', fields: { mission: 'm', env: { SECRET: 's' }, nope: 1 } },
          { id: 'agent:Ok', kind: 'agent', fields: {} },
          { id: 'agent:Mismatch', kind: 'watchdog', fields: {} },
          { id: 'not-an-id', kind: 'agent', fields: {} },
          'nonsense',
        ],
        edges: [
          { kind: 'watches', from: 'watchdog:h', to: 'agent:Ok' },
          { kind: 'watches', from: 'watchdog:h', to: 'agent:Ok' },
          { kind: 'spawned', from: 'agent:Ok', to: 'agent:Two' },
          { kind: 'watches', from: 'agent:Ok', to: 'agent:Ok' },
        ],
      },
      tutorial: { step: 99, dismissed: 'yes' },
    }), { mode: 0o600 });

    const { draft, problem } = store.read();

    expect(problem).toBeUndefined();
    expect(draft.positions).toEqual({ 'agent:Alice': { x: 1, y: 2 } });
    expect(draft.drafts.nodes).toEqual([{ id: 'agent:Ok', kind: 'agent', fields: { mission: 'm' } }]);
    expect(draft.drafts.edges).toEqual([{ kind: 'watches', from: 'watchdog:h', to: 'agent:Ok' }]);
    expect(draft.tutorial).toEqual({ step: 0, dismissed: false });
    expect(JSON.stringify(draft)).not.toContain('SECRET');
  });

  it('never stores secret-bearing fields', async () => {
    const revision = store.read().revision;
    await expect(store.write(revision, {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:A', kind: 'agent', fields: { env: 'API_TOKEN=abc' } }], edges: [] },
    })).rejects.toThrow(/may not store field "env"/);

    await expect(store.write(revision, {
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:A', kind: 'agent', fields: { harness_options: 'x' } }], edges: [] },
    })).rejects.toThrow(/may not store field "harness_options"/);
    expect(existsSync(store.path)).toBe(false);
  });

  it('rejects out-of-bounds coordinates and sizes on write', async () => {
    const revision = store.read().revision;
    const write = (draft: unknown) => store.write(revision, draft);

    await expect(write({ ...emptyDraft(), positions: { 'agent:A': { x: 100_001, y: 0 } } }))
      .rejects.toThrow(/finite x\/y within/);
    await expect(write({ ...emptyDraft(), positions: { 'agent:A': { x: Number.NaN, y: 0 } } }))
      .rejects.toThrow(/finite x\/y within/);
    await expect(write({ ...emptyDraft(), positions: { 'agent:A': { x: 0 } } }))
      .rejects.toThrow(/finite x\/y within/);
    await expect(write({ ...emptyDraft(), positions: { 'oops:A': { x: 0, y: 0 } } }))
      .rejects.toThrow(/invalid node id in positions/);

    const many = (count: number, make: (index: number) => unknown) =>
      Array.from({ length: count }, (_, index) => make(index));
    await expect(write({
      ...emptyDraft(),
      drafts: { nodes: many(501, i => ({ id: `agent:A${i}`, kind: 'agent', fields: {} })), edges: [] },
    })).rejects.toThrow(/at most 500 draft nodes/);
    await expect(write({
      ...emptyDraft(),
      drafts: { nodes: [], edges: many(2001, i => ({ kind: 'watches', from: 'watchdog:h', to: `agent:A${i}` })) },
    })).rejects.toThrow(/at most 2000 draft edges/);
    await expect(write({
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:A', kind: 'agent', fields: { mission: 'x'.repeat(16 * 1024 + 1) } }], edges: [] },
    })).rejects.toThrow(/must be a string under/);
  });

  it('rejects structurally invalid drafts on write with a specific reason', async () => {
    const revision = store.read().revision;
    const write = (draft: unknown) => store.write(revision, draft);

    await expect(write(null)).rejects.toThrow(/must be a JSON object/);
    await expect(write([])).rejects.toThrow(/must be a JSON object/);
    await expect(write({ ...emptyDraft(), version: 99 })).rejects.toThrow(/unsupported topology draft version 99/);
    await expect(write({ ...emptyDraft(), drafts: { nodes: {}, edges: [] } })).rejects.toThrow(/nodes must be an array/);
    await expect(write({
      ...emptyDraft(), drafts: { nodes: [{ id: 'agent:A', kind: 'loop', fields: {} }], edges: [] },
    })).rejects.toThrow(/does not match kind loop/);
    await expect(write({
      ...emptyDraft(),
      drafts: { nodes: [{ id: 'agent:A', kind: 'agent', fields: {} }, { id: 'agent:A', kind: 'agent', fields: {} }], edges: [] },
    })).rejects.toThrow(/duplicate draft node agent:A/);
    await expect(write({
      ...emptyDraft(), drafts: { nodes: [], edges: [{ kind: 'spawned', from: 'agent:A', to: 'agent:B' }] },
    })).rejects.toThrow(/unknown kind "spawned"/);
    await expect(write({
      ...emptyDraft(), drafts: { nodes: [], edges: [{ kind: 'watches', from: 'agent:A', to: 'agent:A' }] },
    })).rejects.toThrow(/cannot point at itself/);
    await expect(write({ ...emptyDraft(), tutorial: { step: -1 } })).rejects.toThrow(/tutorial.step must be an integer/);
    expect(existsSync(store.path)).toBe(false);
  });

  it('collapses duplicate edges and normalises omitted sections on write', async () => {
    const written = await store.write(store.read().revision, {
      drafts: {
        nodes: [{ id: 'agent:A', kind: 'agent' }],
        edges: [
          { kind: 'watches', from: 'watchdog:h', to: 'agent:A' },
          { kind: 'watches', from: 'watchdog:h', to: 'agent:A' },
        ],
      },
    });
    expect(written.draft).toEqual({
      version: TOPOLOGY_DRAFT_VERSION,
      positions: {},
      drafts: {
        nodes: [{ id: 'agent:A', kind: 'agent', fields: {} }],
        edges: [{ kind: 'watches', from: 'watchdog:h', to: 'agent:A' }],
      },
      tutorial: { step: 0, dismissed: false },
    });
  });

  it('refuses a draft whose serialized form exceeds the file cap', async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      id: `agent:A${index}`, kind: 'agent', fields: { mission: 'x'.repeat(16 * 1024) },
    }));
    await expect(store.write(store.read().revision, { ...emptyDraft(), drafts: { nodes, edges: [] } }))
      .rejects.toThrow(/exceed 262144 bytes/);
    expect(existsSync(store.path)).toBe(false);
  });

  it('defaults to the fleet web state directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'ours-fleet-home-'));
    const previous = process.env.OURS_FLEET_HOME;
    process.env.OURS_FLEET_HOME = home;
    try {
      mkdirSync(join(home, '.ours-fleet', 'web'), { recursive: true });
      expect(new TopologyDraftStore().path).toBe(join(home, '.ours-fleet', 'web', 'topology.json'));
    } finally {
      if (previous === undefined) delete process.env.OURS_FLEET_HOME;
      else process.env.OURS_FLEET_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
