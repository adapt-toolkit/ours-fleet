/**
 * Pure browser-side reduction of durable conversation events into a
 * renderable transcript. No transport, no React: events in, model out —
 * deduplicated by eventId, grouped into turns by promptId, assistant text
 * grouped by ACP messageId when present and by contiguity otherwise.
 */

export interface ConversationEvent {
  schemaVersion: 1;
  roleId: string;
  eventId: string;
  seq: number;
  at: string;
  sessionGeneration: string;
  kind: string;
  promptId?: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
  permissionId?: string;
  commandId?: string;
  source?: string;
  payload: Record<string, unknown>;
}

export interface ConversationSnapshot {
  sessionGeneration: string;
  readiness: string;
  queueDepth: number;
  pendingPermissionIds: string[];
  historyDegraded?: boolean;
}

export interface AssistantMessage {
  key: string;
  text: string;
}

export interface ToolCard {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: Array<Record<string, unknown>>;
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: { json?: unknown; bytes: number; truncated?: true; digest?: string; redacted?: true };
  rawOutput?: { json?: unknown; bytes: number; truncated?: true; digest?: string; redacted?: true };
}

export interface PlanCard {
  planId?: string;
  entries?: Array<{
    content: { text: string; bytes: number; truncated?: true; digest?: string };
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  file?: { uri: string };
  markdown?: { text: string; bytes: number; truncated?: true; digest?: string };
}

export interface PermissionCard {
  permissionId: string;
  sessionGeneration: string;
  title?: string;
  toolCallId?: string;
  expiresAt?: string;
  status: 'pending' | 'resolved';
  options: Array<{ optionId: string; name: string; kind: string }>;
  decision?: string;
  decisionSource?: string;
  optionId?: string;
}

export type TurnState =
  | 'queued' | 'running' | 'interrupt_requested'
  | 'completed' | 'refused' | 'cancelled' | 'failed' | 'unknown';

export interface TranscriptTurn {
  promptId: string;
  /** Seq of the earliest event in this turn, for stable ordering. */
  firstSeq: number;
  user?: {
    text?: string;
    externalBytes?: number;
    source?: string;
    at: string;
  };
  commandId?: string;
  queuedBehind?: number;
  state: TurnState;
  stopReason?: string;
  cancellationSource?: string;
  messages: AssistantMessage[];
  thoughtText: string;
  thoughtChunks: number;
  tools: ToolCard[];
  plans: PlanCard[];
  permissions: PermissionCard[];
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
}

export interface ConversationModel {
  turns: TranscriptTurn[];
  /** Events with no prompt correlation (replay tails, session updates). */
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  sessionTitle?: string;
  currentModeId?: string;
  snapshot?: ConversationSnapshot;
  lastSeq: number;
  seenEventIds: Record<string, true>;
  historyDegraded: boolean;
}

export const emptyModel = (): ConversationModel => ({
  turns: [], lastSeq: 0, seenEventIds: {}, historyDegraded: false,
});

const turnFor = (model: ConversationModel, event: ConversationEvent): TranscriptTurn => {
  const promptId = event.promptId ?? `unprompted:${event.sessionGeneration}`;
  let turn = model.turns.find(candidate => candidate.promptId === promptId);
  if (!turn) {
    turn = {
      promptId, firstSeq: event.seq, state: 'running',
      messages: [], thoughtText: '', thoughtChunks: 0, tools: [], plans: [], permissions: [],
    };
    model.turns.push(turn);
    model.turns.sort((a, b) => a.firstSeq - b.firstSeq);
  } else if (event.seq < turn.firstSeq) {
    turn.firstSeq = event.seq;
    model.turns.sort((a, b) => a.firstSeq - b.firstSeq);
  }
  return turn;
};

const asText = (content: unknown): string => {
  const block = content as { type?: string; text?: string } | undefined;
  if (!block) return '';
  if (block.type === 'text') return block.text ?? '';
  return `[${block.type ?? 'content'}]`;
};

function applyEvent(model: ConversationModel, event: ConversationEvent): void {
  if (model.seenEventIds[event.eventId]) return;
  model.seenEventIds[event.eventId] = true;
  model.lastSeq = Math.max(model.lastSeq, event.seq);
  const payload = event.payload ?? {};
  switch (event.kind) {
    case 'prompt.admitted': {
      const turn = turnFor(model, event);
      const text = (payload.displayText as { text?: string } | undefined)?.text
        ?? (payload.text as { text?: string } | undefined)?.text;
      const external = payload.external as { bytes?: number } | undefined;
      turn.user = {
        ...(text !== undefined ? { text } : {}),
        ...(external?.bytes !== undefined ? { externalBytes: external.bytes } : {}),
        source: event.source,
        at: event.at,
      };
      turn.commandId = event.commandId;
      turn.queuedBehind = payload.queuedBehind as number | undefined;
      turn.state = 'queued';
      return;
    }
    case 'prompt.started': {
      const turn = turnFor(model, event);
      if (turn.state === 'queued' || turn.state === 'running') turn.state = 'running';
      return;
    }
    case 'prompt.interrupt_requested': {
      const turn = turnFor(model, event);
      if (!isTerminal(turn.state)) turn.state = 'interrupt_requested';
      turn.cancellationSource = payload.cancellationSource as string | undefined;
      return;
    }
    case 'message.chunk': {
      const role = payload.role as string | undefined;
      const turn = turnFor(model, event);
      const text = asText(payload.content);
      if (role === 'user') {
        // Replayed/user-echoed chunks: keep them as the turn's user text when
        // the fleet admission did not carry one.
        if (!turn.user) turn.user = { text, source: event.source, at: event.at };
        else if (turn.user.text === undefined) turn.user.text = text;
        else if (event.source === 'agent_replay' || event.source === 'agent') {
          // The adapter's own echo of a prompt the fleet already persisted.
        }
        return;
      }
      const key = event.messageId ?? `turn:${turn.promptId}`;
      const last = turn.messages.at(-1);
      if (last && last.key === key) last.text += text;
      else turn.messages.push({ key, text });
      return;
    }
    case 'thought.chunk': {
      const turn = turnFor(model, event);
      turn.thoughtChunks += 1;
      turn.thoughtText += asText(payload.content);
      return;
    }
    case 'tool.upsert': {
      const turn = turnFor(model, event);
      const toolCallId = (payload.toolCallId as string | undefined) ?? event.toolCallId ?? '';
      let tool = turn.tools.find(candidate => candidate.toolCallId === toolCallId);
      if (!tool) {
        tool = { toolCallId };
        turn.tools.push(tool);
      }
      if (payload.title !== undefined) tool.title = payload.title as string;
      if (payload.kind !== undefined) tool.kind = payload.kind as string;
      if (payload.status !== undefined) tool.status = payload.status as string;
      if (payload.content !== undefined)
        tool.content = payload.content as Array<Record<string, unknown>>;
      if (payload.locations !== undefined)
        tool.locations = payload.locations as ToolCard['locations'];
      if (payload.rawInput !== undefined) tool.rawInput = payload.rawInput as ToolCard['rawInput'];
      if (payload.rawOutput !== undefined) tool.rawOutput = payload.rawOutput as ToolCard['rawOutput'];
      return;
    }
    case 'plan.replace': {
      const turn = turnFor(model, event);
      const incoming = payload as unknown as PlanCard & { removed?: boolean };
      const index = turn.plans.findIndex(plan => plan.planId === incoming.planId);
      if (incoming.removed) {
        if (index >= 0) turn.plans.splice(index, 1);
      } else if (index >= 0) turn.plans[index] = incoming;
      else turn.plans.push(incoming);
      return;
    }
    case 'permission.requested': {
      const turn = turnFor(model, event);
      turn.permissions.push({
        permissionId: event.permissionId ?? '',
        sessionGeneration: event.sessionGeneration,
        title: payload.title as string | undefined,
        toolCallId: (payload.toolCallId as string | undefined) ?? event.toolCallId,
        expiresAt: payload.expiresAt as string | undefined,
        status: 'pending',
        options: (payload.options as PermissionCard['options'] | undefined) ?? [],
      });
      return;
    }
    case 'permission.resolved': {
      const turn = turnFor(model, event);
      const pending = event.permissionId
        ? turn.permissions.find(card => card.permissionId === event.permissionId)
        : undefined;
      const card = pending ?? {
        permissionId: event.permissionId ?? '', sessionGeneration: event.sessionGeneration,
        status: 'resolved' as const, options: [],
      };
      if (!pending) turn.permissions.push(card);
      card.status = 'resolved';
      card.decision = payload.decision as string | undefined;
      card.decisionSource = payload.decisionSource as string | undefined;
      card.optionId = payload.optionId as string | undefined;
      return;
    }
    case 'turn.completed': {
      const turn = turnFor(model, event);
      const outcome = payload.outcome as string | undefined;
      turn.state = outcome === 'completed' ? 'completed'
        : outcome === 'refused' ? 'refused'
        : outcome === 'cancelled' ? 'cancelled'
        : outcome === 'failed' ? 'failed'
        : 'unknown';
      turn.stopReason = payload.stopReason as string | undefined;
      turn.cancellationSource = payload.cancellationSource as string | undefined
        ?? turn.cancellationSource;
      for (const card of turn.permissions) {
        if (card.status === 'pending') {
          card.status = 'resolved';
          card.decision = 'cancelled';
        }
      }
      return;
    }
    case 'usage.updated': {
      model.usage = payload as ConversationModel['usage'];
      if (event.promptId) turnFor(model, event).usage = payload as TranscriptTurn['usage'];
      return;
    }
    case 'session.info':
      if (payload.title !== undefined)
        model.sessionTitle = (payload.title as string | null) ?? undefined;
      return;
    case 'session.state':
      if (payload.currentModeId !== undefined)
        model.currentModeId = payload.currentModeId as string | undefined;
      return;
    default:
      // capabilities.updated / unsupported / error: nothing to render in the
      // minimal slice; they stay visible in the Activity (raw) view.
  }
}

const isTerminal = (state: TurnState): boolean =>
  ['completed', 'refused', 'cancelled', 'failed', 'unknown'].includes(state);

/** Apply an ordered batch; returns the same (mutated) model for setState use. */
export function applyEvents(
  model: ConversationModel, events: ConversationEvent[],
): ConversationModel {
  for (const event of events) applyEvent(model, event);
  return model;
}

/** Copy the model so React state updates observe a new reference. */
export function cloneModel(model: ConversationModel): ConversationModel {
  return {
    ...model,
    turns: model.turns.map(turn => ({
      ...turn,
      messages: turn.messages.map(message => ({ ...message })),
      tools: turn.tools.map(tool => ({
        ...tool,
        content: tool.content?.map(item => ({ ...item })),
        locations: tool.locations?.map(location => ({ ...location })),
      })),
      plans: turn.plans.map(plan => ({
        ...plan,
        entries: plan.entries?.map(entry => ({ ...entry, content: { ...entry.content } })),
      })),
      permissions: turn.permissions.map(card => ({ ...card, options: [...card.options] })),
    })),
    seenEventIds: { ...model.seenEventIds },
  };
}

export interface ConversationPage {
  events: ConversationEvent[]; nextCursor?: string; hasMore: boolean;
}

/**
 * Page durable history to exhaustion and return it as ONE batch. Absorbing a
 * page at a time makes a long transcript hydrate visibly — the reader watches
 * it replay from the oldest page forward — so the caller commits once and the
 * viewport only ever settles on the tail.
 */
export async function collectHistory(
  fetchPage: (after: string | undefined) => Promise<ConversationPage>,
  after?: string,
): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = [];
  let cursor = after;
  for (;;) {
    const page = await fetchPage(cursor);
    events.push(...page.events);
    // A cursor that does not advance would page forever now that nothing is
    // committed between iterations; treat it as exhausted.
    if (!page.hasMore || !page.nextCursor || page.nextCursor === cursor) return events;
    cursor = page.nextCursor;
  }
}

/** Slack (px) within which the transcript still counts as parked at the tail. */
export const TAIL_TOLERANCE = 40;

/** Whether the reader is at the tail, i.e. new events should keep following. */
export function isAtTail(viewport: {
  scrollTop: number; clientHeight: number; scrollHeight: number;
}): boolean {
  return viewport.scrollTop + viewport.clientHeight
    >= viewport.scrollHeight - TAIL_TOLERANCE;
}

export const describeTurnState = (turn: TranscriptTurn): string => {
  switch (turn.state) {
    case 'queued':
      return turn.queuedBehind ? `queued · ${turn.queuedBehind} ahead` : 'queued';
    case 'running': return 'running';
    case 'interrupt_requested': return 'interrupt requested';
    case 'completed': return 'completed';
    case 'refused': return 'refused';
    case 'cancelled':
      return turn.cancellationSource ? `cancelled · ${turn.cancellationSource}` : 'cancelled';
    case 'failed': return `failed${turn.stopReason ? ` · ${turn.stopReason}` : ''}`;
    default: return 'outcome unknown (runner restarted)';
  }
};
