import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type NodeKind, type TopologyDraft,
  addNode, connect, disconnect, edgeFor, emptyDraft, isRefusal, moveNode, nextName,
  planConnection, prunePositions, removeNode, renameNode, setField,
} from '../../web/src/topology-edit-model.js';

const KINDS: NodeKind[] = ['agent', 'watchdog', 'loop'];

const canvas = (draft: TopologyDraft, configured: Record<string, NodeKind> = {}) => ({
  kinds: new Map<string, NodeKind>([
    ...draft.drafts.nodes.map(node => [node.id, node.kind] as const),
    ...Object.entries(configured),
  ]),
  draftIds: new Set(draft.drafts.nodes.map(node => node.id)),
});

const sketch = (...nodes: Array<[NodeKind, string]>) =>
  nodes.reduce((draft, [kind, name]) => addNode(draft, kind, name), emptyDraft());

describe('every agent node carries its own actions', () => {
  // There is no DOM test environment here, so the contract is pinned at the
  // source, the same way the no-viewBox overlay contract is; the gestures
  // themselves are exercised in the browser suite.
  const editor = readFileSync(resolve('web/src/TopologyEditor.tsx'), 'utf8');

  it('offers add-watchdog, add-interval and oversee on the node itself', () => {
    for (const label of [
      /aria-label=\{`Add a watchdog for \$\{node\.label\}`\}/,
      /aria-label=\{`Add a loop for \$\{node\.label\}`\}/,
      /aria-label=\{`Have \$\{node\.label\} oversee another agent`\}/,
    ]) expect(editor).toMatch(label);
  });

  it('offers a configure affordance on every node, drafted or configured', () => {
    expect(editor).toMatch(/aria-label=\{`Configure \$\{node\.kind\} \$\{node\.label\}`\}/);
    // The stand-in for the withdrawn gesture is gone; oversight is drawn now.
    expect(editor).not.toMatch(/deferred-note/);
    expect(editor).not.toMatch(/is not configured from the/);
  });

  it('keeps the underlying rule intact, so nothing about the model changed', () => {
    expect(edgeFor('agent', 'agent')).toBe('oversees');
  });
});

describe('planning a connection', () => {
  const fleet = { 'agent:Alice': 'agent' as const, 'agent:Bob': 'agent' as const, 'watchdog:health': 'watchdog' as const };

  it('edits the sidecar when the source is a sketch', () => {
    const draft = sketch(['watchdog', 'W']);
    const plan = planConnection(draft, 'watchdog:W', 'agent:Alice', canvas(draft, fleet));
    expect(plan).toMatchObject({ action: 'draft' });
    expect((plan as { draft: TopologyDraft }).draft.drafts.edges)
      .toEqual([{ kind: 'watches', from: 'watchdog:W', to: 'agent:Alice' }]);
  });

  it('writes configuration when both agents are already in the fleet', () => {
    expect(planConnection(emptyDraft(), 'agent:Alice', 'agent:Bob', canvas(emptyDraft(), fleet)))
      .toEqual({ action: 'oversee', from: 'Alice', to: 'Bob' });
  });

  it('refuses self-oversight in the words the owner needs', () => {
    expect(planConnection(emptyDraft(), 'agent:Alice', 'agent:Alice', canvas(emptyDraft(), fleet)))
      .toEqual({ error: 'Alice cannot oversee itself. Choose a different agent.' });
  });

  it('refuses a target that is not an agent, is gone, or is only a sketch', () => {
    const draft = sketch(['agent', 'Sketch']);
    const context = canvas(draft, fleet);

    expect(planConnection(draft, 'agent:Alice', 'watchdog:health', context))
      .toEqual({ error: 'Oversight points at an agent. Choose an agent for Alice to oversee.' });
    expect(planConnection(draft, 'agent:Alice', 'agent:Ghost', context))
      .toEqual({ error: 'That node is no longer on the canvas.' });
    expect(planConnection(draft, 'agent:Alice', 'agent:Sketch', context))
      .toMatchObject({ error: expect.stringContaining('still a sketch') });
  });

  it('still sends a configured watchdog to the configuration editor', () => {
    expect(planConnection(emptyDraft(), 'watchdog:health', 'agent:Alice', canvas(emptyDraft(), fleet)))
      .toEqual({ error: 'health is already part of the fleet. Edit its connections in the configuration editor.' });
  });
});

describe('connection legality', () => {
  it('allows exactly the three connections that point at an agent', () => {
    const allowed = KINDS.flatMap(from => KINDS.map(to => [from, to, edgeFor(from, to)] as const))
      .filter(([, , kind]) => kind !== undefined)
      .map(([from, to, kind]) => `${from}->${to}=${kind}`);

    expect(allowed).toEqual([
      'agent->agent=oversees',
      'watchdog->agent=watches',
      'loop->agent=targets',
    ]);
  });

  it('refuses a self-connection, an unknown node and a non-agent target', () => {
    const draft = sketch(['watchdog', 'health'], ['agent', 'Alice'], ['loop', 'nightly']);
    const context = canvas(draft);

    expect(connect(draft, 'agent:Alice', 'agent:Alice', context))
      .toEqual({ error: 'A node cannot connect to itself.' });
    expect(connect(draft, 'agent:Alice', 'agent:Ghost', context))
      .toEqual({ error: 'That node is no longer on the canvas.' });
    expect(connect(draft, 'watchdog:health', 'loop:nightly', context))
      .toEqual({ error: 'A watchdog cannot connect to a loop. Connections always point at an agent.' });
  });

  it('refuses to draw from configured state, pointing at the reviewed editor', () => {
    const draft = sketch(['agent', 'Sketch']);
    const context = canvas(draft, { 'watchdog:live': 'watchdog' });

    const result = connect(draft, 'watchdog:live', 'agent:Sketch', context);

    expect(isRefusal(result)).toBe(true);
    expect((result as { error: string }).error)
      .toBe('live is already part of the fleet. Edit its connections in the configuration editor.');
  });

  it('connects a draft watchdog to a configured agent and is idempotent', () => {
    const draft = sketch(['watchdog', 'health']);
    const context = canvas(draft, { 'agent:Alice': 'agent' });

    const once = connect(draft, 'watchdog:health', 'agent:Alice', context) as TopologyDraft;
    const twice = connect(once, 'watchdog:health', 'agent:Alice', canvas(once, { 'agent:Alice': 'agent' }));

    expect(once.drafts.edges).toEqual([{ kind: 'watches', from: 'watchdog:health', to: 'agent:Alice' }]);
    expect(twice).toBe(once);
  });

  it('removes a connection without touching the nodes', () => {
    const draft = sketch(['loop', 'nightly'], ['agent', 'Alice']);
    const linked = connect(draft, 'loop:nightly', 'agent:Alice', canvas(draft)) as TopologyDraft;

    const unlinked = disconnect(linked, { kind: 'targets', from: 'loop:nightly', to: 'agent:Alice' });

    expect(unlinked.drafts.edges).toEqual([]);
    expect(unlinked.drafts.nodes).toHaveLength(2);
  });
});

describe('sketching nodes', () => {
  it('names a new sketch around whatever is already on the canvas', () => {
    expect(nextName('agent', [])).toBe('Agent1');
    expect(nextName('agent', ['agent:Agent1', 'agent:Agent2'])).toBe('Agent3');
    // A configured agent occupies the name too.
    expect(nextName('watchdog', ['watchdog:Watchdog1'])).toBe('Watchdog2');
    expect(nextName('loop', [])).toBe('Loop1');
  });

  it('adds a node at a position, and ignores a duplicate id', () => {
    const first = addNode(emptyDraft(), 'agent', 'Alice', { x: 40, y: 12 });
    const again = addNode(first, 'agent', 'Alice');

    expect(first.drafts.nodes).toEqual([{ id: 'agent:Alice', kind: 'agent', fields: {} }]);
    expect(first.positions).toEqual({ 'agent:Alice': { x: 40, y: 12 } });
    expect(again).toBe(first);
  });

  it('removes a sketch with every connection and position it owned', () => {
    let draft = sketch(['watchdog', 'health'], ['agent', 'Alice']);
    draft = moveNode(draft, 'watchdog:health', { x: 5, y: 5 });
    draft = connect(draft, 'watchdog:health', 'agent:Alice', canvas(draft)) as TopologyDraft;

    const pruned = removeNode(draft, 'watchdog:health');

    expect(pruned.drafts.nodes.map(node => node.id)).toEqual(['agent:Alice']);
    expect(pruned.drafts.edges).toEqual([]);
    expect(pruned.positions).toEqual({});
  });

  it('sets and clears a field', () => {
    const draft = sketch(['agent', 'Alice']);

    const filled = setField(draft, 'agent:Alice', 'mission', 'Ship safely');
    expect(filled.drafts.nodes[0].fields).toEqual({ mission: 'Ship safely' });

    expect(setField(filled, 'agent:Alice', 'mission', '').drafts.nodes[0].fields).toEqual({});
    expect(setField(filled, 'agent:Alice', 'mission', undefined).drafts.nodes[0].fields).toEqual({});
  });

  it('clamps a dragged position to the sidecar bounds and rounds it', () => {
    const draft = moveNode(sketch(['agent', 'Alice']), 'agent:Alice', { x: 1e9, y: -1e9 });
    expect(draft.positions['agent:Alice']).toEqual({ x: 100_000, y: -100_000 });

    expect(moveNode(draft, 'agent:Alice', { x: 12.4, y: Number.NaN }).positions['agent:Alice'])
      .toEqual({ x: 12, y: 0 });
  });

  it('drops positions for nodes that no longer exist', () => {
    let draft = moveNode(sketch(['agent', 'Alice']), 'agent:Alice', { x: 1, y: 2 });
    draft = moveNode(draft, 'agent:Gone', { x: 3, y: 4 });

    const pruned = prunePositions(draft, ['agent:Alice']);

    expect(pruned.positions).toEqual({ 'agent:Alice': { x: 1, y: 2 } });
    expect(prunePositions(pruned, ['agent:Alice'])).toBe(pruned);
  });
});

describe('renaming a sketch', () => {
  it('carries edges and position across the rename', () => {
    let draft = sketch(['watchdog', 'health'], ['agent', 'Alice']);
    draft = moveNode(draft, 'watchdog:health', { x: 7, y: 8 });
    draft = connect(draft, 'watchdog:health', 'agent:Alice', canvas(draft)) as TopologyDraft;

    const renamed = renameNode(draft, 'watchdog:health', 'uptime', []) as TopologyDraft;

    expect(renamed.drafts.nodes.map(node => node.id)).toEqual(['watchdog:uptime', 'agent:Alice']);
    expect(renamed.drafts.edges).toEqual([{ kind: 'watches', from: 'watchdog:uptime', to: 'agent:Alice' }]);
    expect(renamed.positions).toEqual({ 'watchdog:uptime': { x: 7, y: 8 } });
  });

  it('refuses a name the fleet cannot accept or already uses', () => {
    const draft = sketch(['agent', 'Alice']);

    expect(renameNode(draft, 'agent:Alice', 'has space', []))
      .toEqual({ error: 'Use letters, numbers, hyphens and underscores only.' });
    expect(renameNode(draft, 'agent:Alice', '', []))
      .toEqual({ error: 'Use letters, numbers, hyphens and underscores only.' });
    expect(renameNode(draft, 'agent:Alice', 'Bob', ['agent:Bob']))
      .toEqual({ error: 'Bob is already taken.' });
  });

  it('is a no-op when the name does not change', () => {
    const draft = sketch(['agent', 'Alice']);
    expect(renameNode(draft, 'agent:Alice', 'Alice', ['agent:Alice'])).toBe(draft);
  });
});
