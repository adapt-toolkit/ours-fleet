import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import {
  type NodeKind, type TopologyDraft,
  addNode, connect, emptyDraft, isRefusal, moveNode, nextName, nodeId, nodeKind, nodeName,
  planConnection, prunePositions, removeNode, renameNode, setField,
} from './topology-edit-model';
import {
  type Topology, type TopologyNode,
  EDGE_LEGEND, badgeFor, canLaunch, canPromote, describeEdge,
  layoutEdges, layoutInteractive, nodeDestination,
} from './topology-presentation';

/**
 * The graph as the fleet's primary configuration surface.
 *
 * Three actions stay distinct and none of them implies the next: SKETCH is free
 * and local to the draft sidecar, ADD TO FLEET is a reviewed configuration write,
 * and LAUNCH starts a process. Nothing here can start anything — the editor has
 * no launch call at all, and a sketch is not in any file the supervisor reads.
 */

interface DraftRead { draft: TopologyDraft; revision: string; writable: boolean }

/** Fields the inspector can complete on a sketch, by kind. */
const FIELDS: Record<NodeKind, Array<{ key: string; label: string; hint?: string; long?: boolean }>> = {
  agent: [
    { key: 'mission', label: 'Mission', hint: 'One sentence about this agent\'s job.', long: true },
    { key: 'harness', label: 'Harness', hint: 'claude-code (default) or codex' },
    { key: 'session', label: 'Session', hint: 'tmux (default) or acp' },
    { key: 'model', label: 'Model', hint: 'Leave blank to inherit the fleet default.' },
    { key: 'identity', label: 'Identity', hint: 'Defaults to the agent name.' },
    { key: 'cwd', label: 'Working directory' },
  ],
  watchdog: [
    { key: 'coordinator', label: 'Coordinator', hint: 'The agent this watchdog reports to.' },
    { key: 'interval', label: 'Interval', hint: 'Default 10m, minimum 1m.' },
  ],
  loop: [
    { key: 'prompt', label: 'Prompt', hint: 'What this interval delivers.', long: true },
    { key: 'interval', label: 'Interval', hint: 'Default 10m, minimum 1m.' },
  ],
};

const TUTORIAL = [
  'Add an agent. Give it a name and one sentence about its job — that is all it needs to exist.',
  'Keep an eye on it. Press ＋ Watchdog on the agent. A watchdog you create on its own watches every agent, including ones you add later.',
  'Add it to the fleet. Sketching is free; "Add to fleet" writes configuration, and nothing starts until you launch it.',
];

/** How often an overseer checks a ward — mirrors the server\'s default. */
const OVERSEE_INTERVAL = '10m';

/** A reviewed configuration write, held until the owner has read the diff. */
type Review =
  | { kind: 'promote'; ids: string[]; diff: string; summary: string }
  | { kind: 'oversee'; from: string; to: string; diff: string; summary: string };

export function TopologyEditor({ topology, onRefresh, onOpenAgent, onOpenWatchdog, onConfigure, onRemoveAgent }: {
  topology: Topology;
  onRefresh(): void;
  onOpenAgent(id: string): void;
  onOpenWatchdog(id: string): void;
  onConfigure(): void;
  onRemoveAgent(id: string): void;
}) {
  const [draft, setDraft] = useState<TopologyDraft>(emptyDraft);
  const [revision, setRevision] = useState('');
  const [writable, setWritable] = useState(true);
  const [selected, setSelected] = useState('');
  const [connecting, setConnecting] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review>();
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * The revision the next write must quote, and the chain that keeps writes in
   * order. The sidecar is revision-guarded, so two edits started before the
   * first response lands would make the second one a stale write and lose it —
   * and pressing ＋ Watchdog twice, or once on each of two agents, is exactly
   * that. React state cannot carry the revision here: a queued write reads it
   * after the previous one returned, not at the render it was scheduled in.
   */
  const revisionRef = useRef('');
  const writes = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);

  useEffect(() => {
    const query = matchMedia('(max-width: 760px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  /**
   * Escape always cancels a pending connection, wherever the focus went.
   * Starting one hides the action buttons — including the one that was just
   * pressed — so a canvas-scoped handler would be unreachable exactly when it
   * is needed. The banner takes focus for the same reason.
   */
  useEffect(() => {
    if (!connecting) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') setConnecting(''); };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [connecting]);

  const load = useCallback(async () => {
    const read = await api.get<DraftRead>('/api/v1/topology/draft');
    setDraft(read.draft);
    revisionRef.current = read.revision;
    setRevision(read.revision);
    setWritable(read.writable);
  }, []);
  useEffect(() => { void load().catch(reason => setNotice((reason as Error).message)); }, [load]);

  const save = useCallback(async (next: TopologyDraft) => {
    setDraft(next);
    queued.current += 1;
    writes.current = writes.current.then(async () => {
      try {
        const saved = await api.request<{ draft: TopologyDraft; revision: string }>('/api/v1/topology/draft', {
          method: 'PUT', body: JSON.stringify({ revision: revisionRef.current, draft: next }),
        });
        revisionRef.current = saved.revision;
        setRevision(saved.revision);
        // A newer edit is already waiting; adopting this echo would flash the
        // canvas back to the state before it.
        if (queued.current === 1) setDraft(saved.draft);
        setNotice('');
        onRefresh();
      } catch (reason) {
        setNotice(`${(reason as Error).message} Reloading the sketch.`);
        await load();
      } finally { queued.current -= 1; }
    });
    return writes.current;
  }, [load, onRefresh]);

  /** Dragging must not cost a round trip per pixel. */
  const saveSoon = useCallback((next: TopologyDraft) => {
    setDraft(next);
    clearTimeout(pending.current);
    pending.current = setTimeout(() => { void save(next); }, 400);
  }, [save]);

  const nodes = topology.nodes;
  const takenIds = useMemo(() => nodes.map(node => node.id), [nodes]);
  const context = useMemo(() => ({
    kinds: new Map(nodes.map(node => [node.id, node.kind])),
    draftIds: new Set(nodes.filter(node => node.origin === 'draft').map(node => node.id)),
  }), [nodes]);
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const drafted = nodes.filter(node => node.origin === 'draft');
  const readyToAdd = drafted.filter(canPromote);

  const create = (kind: NodeKind, link?: { from?: string; to?: string }) => {
    const name = nextName(kind, takenIds);
    const id = nodeId(kind, name);
    let next = addNode(draft, kind, name);
    if (link?.to) {
      const linked = connect(next, id, link.to, {
        kinds: new Map([...context.kinds, [id, kind]]),
        draftIds: new Set([...context.draftIds, id]),
      });
      if (!isRefusal(linked)) next = linked;
    }
    if (link?.from) {
      const linked = connect(next, link.from, id, {
        kinds: new Map([...context.kinds, [id, kind]]),
        draftIds: new Set([...context.draftIds, id]),
      });
      if (!isRefusal(linked)) next = linked;
    }
    setSelected(id);
    void save(next);
  };

  /**
   * Finish a pending connection. A sketch owns its edges, so that stays local;
   * oversight between two agents in the fleet is a configuration write and goes
   * through the same review as adding a sketch. Either way the pending state
   * ends here — a refusal leaves the canvas exactly as it was.
   */
  const attempt = (from: string, to: string) => {
    const plan = planConnection(draft, from, to, context);
    setConnecting('');
    if (isRefusal(plan)) { setNotice(plan.error); return; }
    setNotice('');
    if (plan.action === 'draft') { void save(plan.draft); return; }
    void previewOversee(plan.from, plan.to);
  };

  const promote = async (ids: string[]) => {
    setBusy(true);
    try {
      const preview = await api.post<{ diff: string; impact: { summary: string } }>(
        '/api/v1/topology/promote/preview',
        { ids, configRevision: await configRevision(), draftRevision: revision });
      setReview({ kind: 'promote', ids, diff: preview.diff, summary: preview.impact.summary });
    } catch (reason) { setNotice((reason as Error).message); }
    finally { setBusy(false); }
  };

  const previewOversee = async (from: string, to: string) => {
    setBusy(true);
    try {
      const preview = await api.post<{ diff: string; impact: { summary: string } }>(
        '/api/v1/topology/oversee/preview',
        { from, to, interval: OVERSEE_INTERVAL, configRevision: await configRevision() });
      setReview({ kind: 'oversee', from, to, diff: preview.diff, summary: preview.impact.summary });
    } catch (reason) { setNotice((reason as Error).message); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!review) return;
    setBusy(true);
    try {
      if (review.kind === 'promote')
        await api.post('/api/v1/topology/promote',
          { ids: review.ids, configRevision: await configRevision(), draftRevision: revision });
      else
        await api.post('/api/v1/topology/oversee', {
          from: review.from, to: review.to, interval: OVERSEE_INTERVAL,
          configRevision: await configRevision(),
        });
      setReview(undefined);
      setSelected('');
      await load();
      onRefresh();
    } catch (reason) { setNotice((reason as Error).message); }
    finally { setBusy(false); }
  };

  /** Alt+Arrow nudges the focused card 8px, Alt+Shift+Arrow 1px. */
  const onCanvasKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { setConnecting(''); setSelected(''); return; }
    if (!event.altKey) return;
    const step = event.shiftKey ? 1 : 8;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    const card = (event.target as Element).closest?.('[data-node-id]');
    const id = card?.getAttribute('data-node-id') ?? selected;
    const current = id ? placed.find(node => node.id === id) : undefined;
    if (!id || !current || !context.draftIds.has(id)) return;
    event.preventDefault();
    saveSoon(moveNode(draft, id, { x: current.x + delta[0], y: current.y + delta[1] }));
  };

  const layout = useMemo(() => layoutInteractive(topology), [topology]);
  const placed = layout.nodes;
  const edges = useMemo(() => layoutEdges(topology.edges, placed), [topology.edges, placed]);
  const selectedNode = selected ? byId.get(selected) : undefined;

  // Positions for nodes that vanished are dropped rather than accumulating.
  useEffect(() => {
    if (!writable || !revision) return;
    const pruned = prunePositions(draft, takenIds);
    if (pruned !== draft) void save(pruned);
  }, [draft, revision, save, takenIds, writable]);

  const empty = nodes.length === 0;

  return <section className="topology-editor" aria-label="Fleet topology editor">
    <div className="topology-toolbar" role="toolbar" aria-label="Add to the canvas">
      <button className="secondary" onClick={() => create('agent')} disabled={!writable}>＋ Agent</button>
      <button className="secondary" onClick={() => create('watchdog')} disabled={!writable}>＋ Watchdog</button>
      <button className="secondary" onClick={() => create('loop')} disabled={!writable}>＋ Interval</button>
      <span className="spacer" />
      {drafted.length > 0 && <span className="draft-count">{drafted.length} sketched · not in the fleet</span>}
      {readyToAdd.length > 0 && <button onClick={() => void promote(readyToAdd.map(node => node.id))} disabled={busy}>
        Add {readyToAdd.length === 1 ? readyToAdd[0].label : `${readyToAdd.length} sketches`} to fleet
      </button>}
    </div>

    {!writable && <p className="banner warning">These sketches were written by a newer console, so they are read-only here. Update ours-fleet to edit them.</p>}
    {(topology.problems ?? []).map(problem => <p key={problem.code} className="banner warning">{problem.detail}</p>)}
    {notice && <p className="banner warning" role="alert">{notice}</p>}
    {connecting && <p className="banner pending" role="status">
      {nodeKind(connecting) === 'agent'
        ? <>Choose the agent <b>{nodeName(connecting)}</b> should oversee — every {OVERSEE_INTERVAL}.</>
        : <>Connecting from <b>{nodeName(connecting)}</b>. Choose an agent to connect to.</>}
      {' '}
      <button className="text-button" autoFocus onClick={() => setConnecting('')}
        aria-label={`Cancel connecting from ${nodeName(connecting)}`}>Cancel</button>
      {' '}or press Escape.
    </p>}

    {empty && <EmptyState onAddAgent={() => create('agent')} />}
    {!empty && drafted.length === 0 && !draft.tutorial.dismissed && <Tutorial
      step={draft.tutorial.step}
      onDismiss={() => void save({ ...draft, tutorial: { ...draft.tutorial, dismissed: true } })}
    />}

    {!narrow && !empty && <div className="topology" aria-label="Interactive fleet topology" onKeyDown={onCanvasKey}>
      <div className="topology-canvas" style={{ height: layout.height }}>
        <svg aria-hidden="true">
          {edges.map(edge => {
            const source = topology.edges.find(candidate => candidate.id === edge.id);
            return <g key={edge.id} className={`edge ${edge.kind}${source?.implicit ? ' implicit' : ''}${source?.dangling ? ' dangling' : ''}${source?.origin === 'draft' ? ' drafted' : ''}`}>
              <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
              <title>{edge.label}</title>
            </g>;
          })}
        </svg>
        {placed.map(node => <NodeCard
          key={node.id} node={node} x={node.x} y={node.y}
          selected={selected === node.id} connecting={connecting}
          onSelect={() => { if (connecting) attempt(connecting, node.id); else setSelected(node.id); }}
          onDrag={position => saveSoon(moveNode(draft, node.id, position))}
          writable={writable}
          onAddWatchdog={() => create('watchdog', { to: node.id })}
          onAddLoop={() => create('loop', { to: node.id })}
          onOversee={() => { setConnecting(node.id); setNotice(''); }}
        />)}
      </div>
    </div>}

    {(narrow || empty) && !empty && <NodeList
      nodes={nodes} selected={selected} onSelect={setSelected} topology={topology}
    />}

    {selectedNode && <Inspector
      node={selectedNode} topology={topology} draft={draft} writable={writable} busy={busy}
      onClose={() => setSelected('')}
      onField={(key, value) => void save(setField(draft, selectedNode.id, key, value))}
      onRename={name => {
        const result = renameNode(draft, selectedNode.id, name, takenIds);
        if (isRefusal(result)) { setNotice(result.error); return; }
        setSelected(nodeId(nodeKind(selectedNode.id), name));
        void save(result);
      }}
      connecting={connecting}
      onConnectFrom={() => { setConnecting(selectedNode.id); setNotice(''); }}
      onWatchThis={() => create('watchdog', { to: selectedNode.id })}
      onIntervalFor={() => create('loop', { to: selectedNode.id })}
      onConfigure={onConfigure}
      onRemove={() => {
        if (selectedNode.origin === 'draft') {
          setSelected('');
          void save(removeNode(draft, selectedNode.id));
        } else if (selectedNode.kind === 'agent') onRemoveAgent(selectedNode.label);
      }}
      onPromote={() => void promote([selectedNode.id])}
      onOpen={() => {
        if (selectedNode.kind === 'agent') onOpenAgent(selectedNode.label);
        if (selectedNode.kind === 'watchdog') onOpenWatchdog(selectedNode.label);
      }}
    />}

    {review && <div className="review-panel" role="dialog" aria-label="Review configuration change">
      <h3>Review the change</h3>
      <p className="muted">
        {review.kind === 'oversee'
          ? `${review.from} will check on ${review.to} every ${OVERSEE_INTERVAL}. `
          : ''}
        This writes configuration only. {review.summary}
      </p>
      <pre className="config-diff">{review.diff || 'No changes.'}</pre>
      <div className="row">
        <button onClick={() => void commit()} disabled={busy}>
          {review.kind === 'oversee' ? 'Save oversight' : 'Add to fleet'}
        </button>
        <button className="secondary" onClick={() => setReview(undefined)} disabled={busy}>Cancel</button>
      </div>
      <p className="muted">Nothing starts running. Launch each agent explicitly when you are ready.</p>
    </div>}

    <details className="topology-fallback">
      <summary>Accessible list view</summary>
      <NodeList nodes={nodes} selected={selected} onSelect={setSelected} topology={topology} />
    </details>

    <section className="topology-legend" aria-label="Topology connection legend">
      <strong>Connections</strong>
      <ul>{EDGE_LEGEND.map(item => <li key={item.kind} tabIndex={0} aria-label={`${item.label}. ${item.description}`}>
        <span className={`legend-line ${item.kind}`} aria-hidden="true" /><span><b>{item.label}</b><small>{item.description}</small></span>
      </li>)}</ul>
    </section>
  </section>;
}

async function configRevision(): Promise<string> {
  const config = await api.get<{ revision: string }>('/api/v1/configuration');
  return config.revision;
}

function EmptyState({ onAddAgent }: { onAddAgent(): void }) {
  return <div className="topology-empty">
    <h3>Sketch your fleet</h3>
    <p>Drop agents on the canvas and connect them. Nothing runs until you say so.</p>
    <button onClick={onAddAgent}>＋ Add your first agent</button>
  </div>;
}

function Tutorial({ step, onDismiss }: { step: number; onDismiss(): void }) {
  return <section className="topology-tutorial" aria-label="Getting started">
    <ol>{TUTORIAL.map((text, index) => <li key={text} className={index === step ? 'current' : ''}>{text}</li>)}</ol>
    <button className="text-button" onClick={onDismiss}>Got it</button>
  </section>;
}

/**
 * One card, and everything that can be done to it without leaving the graph.
 *
 * The actions live on the node rather than only in the inspector because that
 * is where the owner is looking: an agent is one press away from a watchdog, an
 * interval, oversight of another agent, and its own configuration. None of them
 * starts anything — the two that write configuration go through review first.
 */
function NodeCard({
  node, x, y, selected, connecting, onSelect, onDrag, writable,
  onAddWatchdog, onAddLoop, onOversee,
}: {
  node: TopologyNode; x: number; y: number; selected: boolean; connecting: string;
  onSelect(): void; onDrag(position: { x: number; y: number }): void; writable: boolean;
  onAddWatchdog(): void; onAddLoop(): void; onOversee(): void;
}) {
  const badge = badgeFor(node);
  const dragging = useRef<{ dx: number; dy: number } | undefined>(undefined);
  const source = connecting === node.id;
  const pending = connecting !== '' && !source;
  return <div
    className={`topology-node ${node.kind} ${node.status} ${node.lifetime ?? ''} ${badge.tone}${selected ? ' selected' : ''}${source ? ' connect-source' : ''}${pending ? ' connect-target' : ''}`}
    data-node-id={node.id}
    style={{ left: x, top: y }}
    onPointerDown={event => {
      if (!writable || node.origin !== 'draft') return;
      dragging.current = { dx: event.clientX - x, dy: event.clientY - y };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={event => {
      if (!dragging.current) return;
      onDrag({ x: event.clientX - dragging.current.dx, y: event.clientY - dragging.current.dy });
    }}
    onPointerUp={() => { dragging.current = undefined; }}
  >
    <button className="topology-open" onClick={onSelect}
      aria-label={`${node.kind} ${node.label}. ${badge.text}. ${badge.detail}${
        source ? ` Choosing what ${node.label} oversees. Press Escape to cancel.`
          : pending ? ` Press to connect ${nodeName(connecting)} to ${node.label}.` : ''}`}>
      <small>{node.kind}{node.lifetime ? ` · ${node.lifetime}` : ''}</small>
      <strong>{node.label}</strong>
      <span className={`node-badge ${badge.tone}`}>{badge.tone === 'draft-incomplete' ? '⚠ ' : ''}{badge.text}</span>
      {node.detail && <span className="node-detail">{node.detail}</span>}
    </button>
    {/*
      Hidden while a connection is pending: every card is a target then, and a
      stray press on an action would silently abandon the gesture.
    */}
    {!connecting && <div className="node-actions" role="group" aria-label={`${node.label} actions`}>
      <button className="node-action" onClick={onSelect}
        aria-label={`Configure ${node.kind} ${node.label}`}>Configure</button>
      {node.kind === 'agent' && writable && <>
        <button className="node-action" onClick={onAddWatchdog}
          aria-label={`Add a watchdog for ${node.label}`}>+ Watchdog</button>
        <button className="node-action" onClick={onAddLoop}
          aria-label={`Add an interval for ${node.label}`}>+ Interval</button>
        <button className="node-action" onClick={onOversee}
          aria-label={`Have ${node.label} oversee another agent`}>Oversee</button>
      </>}
    </div>}
  </div>;
}

function NodeList({ nodes, selected, onSelect, topology }: {
  nodes: TopologyNode[]; selected: string; onSelect(id: string): void; topology: Topology;
}) {
  return <table className="topology-list">
    <thead><tr><th>Type</th><th>Name</th><th>State</th><th>Connections</th></tr></thead>
    <tbody>{nodes.map(node => {
      const badge = badgeFor(node);
      return <tr key={node.id} className={selected === node.id ? 'selected' : ''}>
        <td>{node.kind}</td>
        <td><button className="text-button" onClick={() => onSelect(node.id)}>{node.label}</button></td>
        <td><span className={`node-badge ${badge.tone}`}>{badge.text}</span></td>
        <td>{topology.edges.filter(edge => edge.from === node.id || edge.to === node.id)
          .map(edge => describeEdge(edge, node.id)).join(' ') || '—'}</td>
      </tr>;
    })}</tbody>
  </table>;
}

function Inspector({
  node, topology, draft, writable, busy, connecting,
  onClose, onField, onRename, onConnectFrom, onWatchThis, onIntervalFor, onConfigure,
  onRemove, onPromote, onOpen,
}: {
  node: TopologyNode; topology: Topology; draft: TopologyDraft; writable: boolean; busy: boolean;
  connecting: string;
  onClose(): void; onField(key: string, value: string): void; onRename(name: string): void;
  onConnectFrom(): void; onWatchThis(): void; onIntervalFor(): void; onConfigure(): void;
  onRemove(): void; onPromote(): void; onOpen(): void;
}) {
  const isDraft = node.origin === 'draft';
  const fields = draft.drafts.nodes.find(candidate => candidate.id === node.id)?.fields ?? {};
  const connections = topology.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  return <section className="node-inspector" aria-label={`${node.label} details`}>
    <header>
      <h3>{node.label}</h3>
      <button className="text-button" onClick={onClose} aria-label="Close details">×</button>
    </header>

    {(node.missing ?? []).length > 0 && <ul className="missing-list">
      {(node.missing ?? []).map(item => <li key={item.field}><b>{item.field}</b> — {item.fix}</li>)}
    </ul>}

    {isDraft && <label>Name
      <input defaultValue={node.label} disabled={!writable}
        onBlur={event => { if (event.target.value !== node.label) onRename(event.target.value); }} />
    </label>}

    {isDraft && FIELDS[node.kind].map(field => <label key={field.key}>{field.label}
      {field.long
        ? <textarea defaultValue={String(fields[field.key] ?? '')} disabled={!writable}
          onBlur={event => onField(field.key, event.target.value)} />
        : <input defaultValue={String(fields[field.key] ?? '')} disabled={!writable}
          onBlur={event => onField(field.key, event.target.value)} />}
      {field.hint && <small>{field.hint}</small>}
    </label>)}

    {!isDraft && <p className="muted">
      This is live configuration. <b>Configure</b> opens the fleet editor, where its
      details are edited; the graph draws the connections between them.
    </p>}

    <div className="inspector-actions">
      {node.kind === 'agent' && writable && <>
        <button className="secondary" onClick={onWatchThis}>＋ Watchdog for this agent</button>
        <button className="secondary" onClick={onIntervalFor}>＋ Interval for this agent</button>
        <button className="secondary" onClick={onConnectFrom} aria-pressed={connecting === node.id}
          aria-label={`Have ${node.label} oversee another agent`}>◎ Oversee an agent…</button>
      </>}
      {isDraft && node.kind !== 'agent' && writable
        && <button className="secondary" onClick={onConnectFrom}>Connect to an agent…</button>}
      {canPromote(node) && <button onClick={onPromote} disabled={busy}>Add to fleet</button>}
      {isDraft && !canPromote(node) && <button disabled title="Complete the fields above first">Add to fleet</button>}
      {!isDraft && <button className="secondary" onClick={onConfigure}
        aria-label={`Configure ${node.kind} ${node.label} in the fleet editor`}>⚙ Configure</button>}
      {/* A loop has no page of its own; offering "Open" for it would be a dead control. */}
      {!isDraft && nodeDestination(node) && <button className="secondary" onClick={onOpen}>Open</button>}
      {/*
        There is no Launch control here. Launching is a separate, explicit action
        and an incomplete node is non-launchable by construction — a sketch is in
        no file the supervisor or `ours-fleet up` reads.
      */}
      {!canLaunch(node) && !isDraft && <span className="muted">Not launchable until it is complete.</span>}
      {writable && (isDraft || node.kind === 'agent')
        && <button className="text-button danger" onClick={onRemove}
          aria-label={isDraft ? `Delete sketch ${node.label}` : `Remove ${node.label}`}>
          {isDraft ? 'Delete sketch' : 'Remove'}
        </button>}
    </div>

    <h4>Connections</h4>
    <ul className="connection-list">
      {connections.length === 0 && <li className="muted">None yet.</li>}
      {connections.map(edge => <li key={edge.id}>
        {describeEdge(edge, node.id)}
        {edge.implicit && <em> Default coverage — no edit needed when agents are added.</em>}
        {edge.dangling && <em> This endpoint no longer exists.</em>}
      </li>)}
    </ul>
  </section>;
}
