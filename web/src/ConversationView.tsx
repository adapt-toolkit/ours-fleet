import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, idempotencyKey } from './api';
import {
  applyEvents, cloneModel, collectHistory, describeTurnState, emptyModel, isAtTail,
} from './conversation-model';
import type {
  ConversationEvent, ConversationModel, ConversationPage, PermissionCard, TranscriptTurn,
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

  /**
   * Page the durable history over HTTP until exhausted (gap recovery), then
   * commit it in a single render — a per-page commit is what made a long
   * transcript hydrate visibly from its oldest page.
   */
  const backfill = useCallback(async () => {
    const events = await collectHistory(after => {
      const suffix = after ? `&after=${encodeURIComponent(after)}` : '';
      return api.get<ConversationPage>(
        `/api/v1/roles/${encodeURIComponent(roleId)}/conversation?limit=500${suffix}`);
    }, modelRef.current.lastSeq ? String(modelRef.current.lastSeq) : undefined);
    if (events.length) absorb(events);
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
  // This has to land BEFORE paint: a post-paint scroll shows every commit at
  // its previous offset first, which on a fresh hydration is the top of the
  // history — the transcript then visibly scrolls down to the newest message.
  useLayoutEffect(() => {
    if (atBottom) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [model, atBottom]);

  const send = async () => {
    const body = text;
    if (!body.trim()) return;
    const commandId = idempotencyKey();
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
        `/permissions/${encodeURIComponent(card.permissionId)}`, {
          commandId: idempotencyKey(), optionId,
          sessionGeneration: card.sessionGeneration,
        });
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
        onScroll={event => setAtBottom(isAtTail(event.currentTarget))}>
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
    {turn.user && <div className="bubble user">
      <small>
        {turn.user.source === 'owner_admin_console' ? 'Direct owner admin console'
          : turn.user.source === 'local_console' ? 'Local console'
          : turn.user.source === 'owner_channel' ? 'Owner channel · end-to-end'
          : turn.user.source === 'startup' ? 'Startup briefing'
          : turn.user.source === 'agent_replay' ? 'Replayed prompt'
          : `External · ${turn.user.source ?? 'unknown'}`}
        {' · '}{new Date(turn.user.at).toLocaleTimeString()} · {state}
      </small>
      {turn.user.text !== undefined
        ? <pre className="prompt-text">{turn.user.text}</pre>
        : <p className="muted">Message content unavailable
          ({turn.user.externalBytes ?? '?'} bytes)</p>}
    </div>}
    {(turn.messages.length > 0 || turn.thoughtChunks > 0 || turn.tools.length > 0
      || turn.plans.length > 0
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
        {turn.plans.map((plan, index) => <div className="plan-card" key={plan.planId ?? index}>
          <strong>Plan</strong>
          {plan.entries && <ol>
            {plan.entries.map((entry, entryIndex) => <li
              className={`plan-entry ${entry.status}`} key={entryIndex}>
              <span aria-hidden="true">{entry.status === 'completed' ? '✓'
                : entry.status === 'in_progress' ? '◐' : '○'}</span>
              <span>{entry.content.text}</span>
              <small>{entry.priority}</small>
            </li>)}
          </ol>}
          {plan.markdown && <pre>{plan.markdown.text}</pre>}
          {plan.file && <code>{plan.file.uri}</code>}
        </div>)}
        {turn.tools.map(tool => <details className="tool-card" key={tool.toolCallId}>
          <summary>
            <span className={`tool-status ${tool.status ?? 'pending'}`}>{tool.status ?? 'pending'}</span>
            <span>{tool.title ?? tool.toolCallId}</span>
            {tool.kind && <small className="muted">{tool.kind}</small>}
          </summary>
          <div className="tool-detail">
            {tool.locations?.length ? <div><strong>Locations</strong>
              {tool.locations.map((location, index) =>
                <ToolLocation key={index} location={location} />)}</div> : null}
            {tool.content?.map((content, index) => <ToolContent key={index} content={content} />)}
            {tool.rawInput && <JsonDisclosure label="Input" value={tool.rawInput} />}
            {tool.rawOutput && <JsonDisclosure label="Output" value={tool.rawOutput} />}
          </div>
        </details>)}
        {turn.permissions.map(card => <PermissionBlock key={card.permissionId}
          card={card} onDecide={onDecide} />)}
        {turn.messages.map(message =>
          <pre className="assistant-text" key={message.key}>{message.text}</pre>)}
        {turn.usage && <small className="usage-badge">
          context {Math.round(100 * turn.usage.used / Math.max(1, turn.usage.size))}%
          {turn.usage.cost
            ? ` · ${turn.usage.cost.amount.toFixed(2)} ${turn.usage.cost.currency}` : ''}
          {' · agent-reported'}
        </small>}
        {turn.state === 'running' && turn.messages.length === 0 &&
          <p className="muted streaming-hint">Working…</p>}
      </div>}
  </article>;
}

export function ToolLocation({ location }: {
  location: {
    path: string; line?: number; pathBytes?: number; pathTruncated?: true;
    pathDigest?: string; pathOmittedPrefixBytes?: number;
  };
}) {
  return <div className="tool-content"><code>
    {location.path}{location.line ? `:${location.line}` : ''}
  </code>{location.pathTruncated && <small className="muted">
    Path tail only · {location.pathBytes ?? '?'} bytes total
    {typeof location.pathOmittedPrefixBytes === 'number'
      ? ` · ${location.pathOmittedPrefixBytes} leading bytes omitted` : ''}
    {location.pathDigest ? ` · digest ${location.pathDigest}` : ''}
  </small>}</div>;
}

type DiffTextView = {
  text?: string; bytes?: number; truncated?: true; digest?: string;
  omittedPrefixBytes?: number; startsMidLine?: true;
};

function DiffTextProvenance({ label, value }: { label: string; value?: DiffTextView }) {
  if (!value) return null;
  return <small className="muted">{label}
    {typeof value.bytes === 'number' ? ` · ${value.bytes} bytes` : ''}
    {value.truncated ? ' · retained bounded tail' : ''}
    {typeof value.omittedPrefixBytes === 'number'
      ? ` · ${value.omittedPrefixBytes} leading bytes omitted` : ''}
    {value.startsMidLine ? ' · retained tail starts mid-line' : ''}
    {value.digest ? ` · digest ${value.digest}` : ''}
  </small>;
}

export function ToolContent({ content }: { content: Record<string, unknown> }) {
  if (content.type === 'diff') {
    const oldText = content.oldText as DiffTextView | undefined;
    const newText = content.newText as DiffTextView | undefined;
    const operation = typeof content.operation === 'string' ? content.operation : 'diff';
    const bounded = content.bounded === true;
    return <div className="tool-content"><strong>{operation === 'diff' ? 'Diff' : operation} · {String(content.path ?? '')}</strong>
      {content.pathTruncated === true && <small className="muted">
        Path tail only · {String(content.pathBytes ?? '?')} bytes total
        {content.pathOmittedPrefixBytes ? ` · ${content.pathOmittedPrefixBytes} leading bytes omitted` : ''}
        {content.pathDigest ? ` · digest ${String(content.pathDigest)}` : ''}
      </small>}
      {bounded && <small className="muted">Current change only
        {typeof content.beforeBytes === 'number' && typeof content.afterBytes === 'number'
          ? ` · file ${content.beforeBytes} → ${content.afterBytes} bytes` : ''}
        {typeof content.commonPrefixBytes === 'number'
          ? ` · ${content.commonPrefixBytes} unchanged prefix bytes omitted` : ''}
        {typeof content.commonSuffixBytes === 'number'
          ? ` · ${content.commonSuffixBytes} unchanged suffix bytes omitted` : ''}
      </small>}
      {oldText && <pre className="diff-old">{oldText.text}</pre>}
      <pre className="diff-new">{newText?.text}</pre>
      {(bounded || oldText?.truncated || oldText?.digest) &&
        <DiffTextProvenance label="Prior side" value={oldText} />}
      {(bounded || newText?.truncated || newText?.digest) &&
        <DiffTextProvenance label="Current side" value={newText} />}
    </div>;
  }
  if (content.type === 'terminal')
    return <div className="tool-content"><strong>Display terminal</strong>
      <code>{String(content.terminalId ?? '')}</code></div>;
  const block = content.content as { type?: string; text?: string; uri?: string } | undefined;
  return <div className="tool-content"><strong>{block?.type ?? 'Content'}</strong>
    <pre>{block?.text ?? block?.uri ?? `[${block?.type ?? 'content'}]`}</pre></div>;
}

function JsonDisclosure({ label, value }: {
  label: string; value: {
    json?: unknown; bytes: number; truncated?: true; digest?: string; redacted?: true;
  };
}) {
  return <div className="tool-content"><strong>{label}</strong>
    {value.redacted && <small className="muted">Sensitive fields redacted</small>}
    {value.json !== undefined
      ? <pre>{JSON.stringify(value.json, null, 2)}</pre>
      : <p className="muted">Not retained · {value.bytes} bytes
        {value.digest ? ` · digest ${value.digest}` : ''}</p>}
  </div>;
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
