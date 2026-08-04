import { useCallback, useEffect, useRef, useState } from 'react';
import { api, idempotencyKey } from './api';
import {
  addOptimisticPrompt, applyEvents, cloneModel, describeTurnState, emptyModel,
} from './conversation-model';
import type {
  ConversationEvent, ConversationModel, PermissionCard, TranscriptTurn,
} from './conversation-model';

type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/**
 * Structured live transcript for an ACP role: durable replay over the
 * conversation WebSocket, HTTP backfill on gaps, idempotent Send/Interrupt.
 * Rendering is plain text throughout — React escaping is the sanitizer.
 */
export function ConversationView({ roleId }: { roleId: string }) {
  const [model, setModel] = useState<ConversationModel>(emptyModel);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [notice, setNotice] = useState('');
  const [text, setText] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const modelRef = useRef(model);
  modelRef.current = model;
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const disposedRef = useRef(false);
  const attemptRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const absorb = useCallback((events: ConversationEvent[]) => {
    setModel(current => cloneModel(applyEvents(current, events)));
  }, []);

  /** Page the durable history over HTTP until exhausted (gap recovery). */
  const backfill = useCallback(async () => {
    let after: string | undefined = modelRef.current.lastSeq
      ? String(modelRef.current.lastSeq) : undefined;
    for (;;) {
      const suffix = after ? `&after=${encodeURIComponent(after)}` : '';
      const page: {
        events: ConversationEvent[]; nextCursor?: string; hasMore: boolean;
      } = await api.get(`/api/v1/roles/${encodeURIComponent(roleId)}/conversation?limit=500${suffix}`);
      if (page.events.length) absorb(page.events);
      if (!page.hasMore || !page.nextCursor) break;
      after = page.nextCursor;
    }
  }, [absorb, roleId]);

  const connect = useCallback(async () => {
    if (disposedRef.current) return;
    setStream(attemptRef.current ? 'reconnecting' : 'connecting');
    try {
      const { ticket } = await api.post<{ ticket: string }>(
        '/api/v1/ws-tickets', { purpose: 'conversation', roleId });
      if (disposedRef.current) return;
      const socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` +
        `/api/v1/roles/${encodeURIComponent(roleId)}/conversation-stream`,
        'ours-fleet-conversation.v1');
      socketRef.current = socket;
      socket.onopen = () => {
        const after = modelRef.current.lastSeq ? String(modelRef.current.lastSeq) : undefined;
        socket.send(JSON.stringify({ type: 'hello', ticket, ...(after ? { after } : {}) }));
      };
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data)) as {
          type: string; events?: ConversationEvent[]; snapshot?: ConversationModel['snapshot'];
        };
        if (message.type === 'ready') {
          attemptRef.current = 0;
          setStream('live');
          if (message.snapshot) setModel(current => {
            const next = cloneModel(current);
            next.snapshot = message.snapshot;
            next.historyDegraded = Boolean(message.snapshot?.historyDegraded);
            return next;
          });
        }
        if (message.type === 'events' && message.events) absorb(message.events);
        if (message.type === 'resync.required') void backfill();
      };
      socket.onclose = () => {
        if (disposedRef.current) return;
        setStream('reconnecting');
        const attempt = Math.min(attemptRef.current++, 5);
        const delay = Math.min(30_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        setTimeout(() => void connect(), delay);
      };
    } catch (reason) {
      if (disposedRef.current) return;
      setStream('offline');
      setNotice((reason as Error).message);
      const attempt = Math.min(attemptRef.current++, 5);
      setTimeout(() => void connect(), Math.min(30_000, 2_000 * 2 ** attempt));
    }
  }, [absorb, backfill, roleId]);

  useEffect(() => {
    disposedRef.current = false;
    void connect();
    return () => {
      disposedRef.current = true;
      socketRef.current?.close();
    };
  }, [connect]);

  // Follow the stream only while the reader is at the bottom (spec §7.1).
  useEffect(() => {
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [model, atBottom]);

  const send = async () => {
    const body = text;
    if (!body.trim()) return;
    const commandId = idempotencyKey();
    setModel(current => cloneModel(addOptimisticPrompt(current, commandId, body)));
    setText('');
    try {
      await api.post(`/api/v1/roles/${encodeURIComponent(roleId)}/input`,
        { text: body, commandId });
    } catch (reason) {
      setNotice(`Send failed: ${(reason as Error).message}`);
    }
  };

  const interrupt = async () => {
    if (!confirm('Interrupt the active ACP turn? Queued prompts are preserved.')) return;
    try {
      await api.post(`/api/v1/roles/${encodeURIComponent(roleId)}/interrupt`,
        { commandId: idempotencyKey() });
      setNotice('Interrupt requested — the turn ends when the agent confirms.');
    } catch (reason) {
      setNotice(`Interrupt failed: ${(reason as Error).message}`);
    }
  };

  const decide = async (card: PermissionCard, optionId: string) => {
    try {
      await api.post(`/api/v1/roles/${encodeURIComponent(roleId)}` +
        `/permissions/${encodeURIComponent(card.permissionId)}`, { optionId });
    } catch (reason) {
      setNotice(`Permission response failed: ${(reason as Error).message}`);
    }
  };

  const snapshot = model.snapshot;
  const busy = snapshot?.readiness === 'running' || snapshot?.readiness === 'awaiting_permission';
  return <div className="conversation-layout">
    <div className="conversation panel">
      <div className="conversation-header">
        <span className={`stream-state ${stream}`}>{stream}</span>
        {model.sessionTitle && <span className="muted">{model.sessionTitle}</span>}
        {model.currentModeId && <span className="muted">mode {model.currentModeId}</span>}
        {model.usage && <span className="muted">
          context {Math.round(100 * model.usage.used / Math.max(1, model.usage.size))}%
          {model.usage.cost ? ` · ${model.usage.cost.amount.toFixed(2)} ${model.usage.cost.currency}` : ''}
          {' '}(agent-reported)</span>}
        {model.historyDegraded &&
          <span className="warning">history degraded — transcript may be incomplete</span>}
      </div>
      {notice && <div className="banner info">{notice}</div>}
      <div className="transcript" ref={scrollRef}
        onScroll={event => {
          const target = event.currentTarget;
          setAtBottom(target.scrollTop + target.clientHeight >= target.scrollHeight - 40);
        }}>
        {model.turns.length === 0 &&
          <p className="muted">No conversation yet. Prompt the live ACP session below.</p>}
        {model.turns.map(turn => <TurnBlock key={turn.promptId} turn={turn} onDecide={decide} />)}
      </div>
      {!atBottom && <button className="secondary jump-latest"
        onClick={() => { setAtBottom(true); }}>Jump to latest</button>}
    </div>
    <div className="composer panel">
      <textarea value={text} placeholder="Prompt the live ACP session…"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
        }} />
      <div className="composer-actions">
        <button className="primary" disabled={!text.trim()} onClick={() => void send()}>
          Send{snapshot && snapshot.queueDepth > 0 ? ` · queued ${snapshot.queueDepth}` : ''}
        </button>
        <button className="danger" disabled={!busy} onClick={() => void interrupt()}>
          Interrupt active turn
        </button>
      </div>
      <small>Enter sends · Shift+Enter newline · acceptance is not completion.</small>
    </div>
  </div>;
}

function TurnBlock({ turn, onDecide }: {
  turn: TranscriptTurn;
  onDecide(card: PermissionCard, optionId: string): Promise<void>;
}) {
  const [showThoughts, setShowThoughts] = useState(false);
  const state = describeTurnState(turn);
  return <article className={`turn ${turn.state}`}>
    {turn.user && <div className={`bubble user${turn.optimistic ? ' optimistic' : ''}`}>
      <small>
        {turn.user.source === 'browser' || turn.user.source === 'local_console' ? 'You'
          : turn.user.source === 'startup' ? 'Startup briefing'
          : turn.user.source === 'agent_replay' ? 'Replayed prompt'
          : `External · ${turn.user.source ?? 'unknown'}`}
        {' · '}{new Date(turn.user.at).toLocaleTimeString()} · {state}
      </small>
      {turn.user.text !== undefined
        ? <pre className="prompt-text">{turn.user.text}</pre>
        : <p className="muted">External end-to-end message · body not stored
          ({turn.user.externalBytes ?? '?'} bytes)</p>}
    </div>}
    {(turn.messages.length > 0 || turn.thoughtChunks > 0 || turn.tools.length > 0
      || turn.permissions.length > 0) &&
      <div className="bubble assistant">
        {!turn.user && <small>{state}</small>}
        {turn.thoughtChunks > 0 && <div className="thoughts">
          <button className="secondary" aria-expanded={showThoughts}
            onClick={() => setShowThoughts(value => !value)}>
            {showThoughts ? 'Hide' : 'Show'} reasoning activity ({turn.thoughtChunks} update{turn.thoughtChunks === 1 ? '' : 's'})
          </button>
          {showThoughts && <pre className="thought-text">{turn.thoughtText}</pre>}
        </div>}
        {turn.tools.map(tool => <div className="tool-card" key={tool.toolCallId}>
          <span className={`tool-status ${tool.status ?? 'pending'}`}>{tool.status ?? 'pending'}</span>
          <span>{tool.title ?? tool.toolCallId}</span>
          {tool.kind && <small className="muted">{tool.kind}</small>}
        </div>)}
        {turn.permissions.map(card => <PermissionBlock key={card.permissionId}
          card={card} onDecide={onDecide} />)}
        {turn.messages.map(message =>
          <pre className="assistant-text" key={message.key}>{message.text}</pre>)}
        {turn.state === 'running' && turn.messages.length === 0 &&
          <p className="muted streaming-hint">Working…</p>}
      </div>}
  </article>;
}

function PermissionBlock({ card, onDecide }: {
  card: PermissionCard;
  onDecide(card: PermissionCard, optionId: string): Promise<void>;
}) {
  if (card.status === 'resolved') {
    return <div className="permission-card resolved">
      <span>{card.title ?? 'Permission'}</span>
      <small>{card.decision ?? 'settled'}{card.decisionSource ? ` · ${card.decisionSource}` : ''}</small>
    </div>;
  }
  // One-shot decisions only: standing grants are policy, not a console click.
  const oneShot = card.options.filter(option =>
    ['allow_once', 'reject_once'].includes(option.kind));
  return <div className="permission-card pending" role="group" aria-label="Permission required">
    <span>{card.title ?? 'Permission requested'}</span>
    <div className="permission-actions">
      {oneShot.map(option =>
        <button key={option.optionId}
          className={option.kind === 'allow_once' ? 'primary' : 'danger'}
          onClick={() => void onDecide(card, option.optionId)}>{option.name}</button>)}
      {oneShot.length === 0 &&
        <small className="muted">This agent offered no one-shot option; use role policy.</small>}
    </div>
  </div>;
}
