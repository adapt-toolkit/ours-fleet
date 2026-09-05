import type {
  BoundedJson, ConversationEventV1, ToolUpsertPayload, TurnCompletedPayload,
} from './session/conversation-types.js';
import type { AgentSession } from './session/types.js';

const TOOL_NAMES = {
  choose: new Set(['choose_identity', 'ours.choose_identity', 'mcp__ours__choose_identity']),
  current: new Set(['current_identity', 'ours.current_identity', 'mcp__ours__current_identity']),
  messages: new Set(['get_messages', 'ours.get_messages', 'mcp__ours__get_messages']),
} as const;

export interface AgentRecoveryEvidence {
  ok: boolean;
  reason:
    | 'RECOVERY_TOOLS_VERIFIED'
    | 'RECOVERY_PROMPT_MISSING'
    | 'RECOVERY_TURN_INCOMPLETE'
    | 'RECOVERY_TURN_FAILED'
    | 'RECOVERY_CHOOSE_MISSING'
    | 'RECOVERY_CURRENT_MISSING'
    | 'RECOVERY_GET_MESSAGES_MISSING'
    | 'RECOVERY_TOOL_ORDER_INVALID';
  chooseIdentity: boolean;
  currentIdentity: boolean;
  getMessages: boolean;
  turnCompleted: boolean;
}

interface ToolRecord {
  title?: string;
  status?: string;
  rawInput?: BoundedJson;
  completedSeq?: number;
}

function recordFor(
  records: Map<string, ToolRecord>, event: ConversationEventV1,
): ToolRecord | undefined {
  if (event.kind !== 'tool.upsert' || !event.toolCallId) return undefined;
  const payload = event.payload as ToolUpsertPayload;
  const previous = records.get(event.toolCallId) ?? {};
  const next = {
    ...previous,
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    ...(payload.rawInput !== undefined ? { rawInput: payload.rawInput } : {}),
    ...(payload.status === 'completed' ? { completedSeq: event.seq } : {}),
  };
  records.set(event.toolCallId, next);
  return next;
}

function objectInput(input: BoundedJson | undefined): Record<string, unknown> | undefined {
  if (!input || input.truncated || input.redacted || !input.json
      || typeof input.json !== 'object' || Array.isArray(input.json)) return undefined;
  return input.json as Record<string, unknown>;
}

function safeChoose(record: ToolRecord, identity: string): boolean {
  if (!record.title || !TOOL_NAMES.choose.has(record.title) || record.status !== 'completed')
    return false;
  const input = objectInput(record.rawInput);
  if (!input) return false;
  const keys = Object.keys(input).sort();
  if (keys.some(key => key !== 'force' && key !== 'name')) return false;
  return input.name === identity && (input.force === undefined || input.force === false);
}

function safeNoOrBoundedInput(
  record: ToolRecord, names: ReadonlySet<string>, allowed: (input: Record<string, unknown>) => boolean,
): boolean {
  if (!record.title || !names.has(record.title) || record.status !== 'completed') return false;
  if (!record.rawInput) return allowed({});
  const input = objectInput(record.rawInput);
  return input !== undefined && allowed(input);
}

function safeCurrent(record: ToolRecord): boolean {
  return safeNoOrBoundedInput(record, TOOL_NAMES.current, input => Object.keys(input).length === 0);
}

function safeMessages(record: ToolRecord): boolean {
  return safeNoOrBoundedInput(record, TOOL_NAMES.messages, input => {
    const keys = Object.keys(input);
    if (keys.some(key => key !== 'limit')) return false;
    return input.limit === undefined
      || (Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= 200);
  });
}

/**
 * Verify one exact recovery turn from its durable conversation ledger. Tool
 * arguments/results are inspected only to derive these booleans and are never
 * returned or persisted by this gate.
 */
export function evaluateAgentRecovery(
  events: readonly ConversationEventV1[], promptId: string, identity: string,
): AgentRecoveryEvidence {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const admitted = ordered.find(event => event.kind === 'prompt.admitted' && event.promptId === promptId);
  const empty = (reason: AgentRecoveryEvidence['reason']): AgentRecoveryEvidence => ({
    ok: false, reason, chooseIdentity: false, currentIdentity: false,
    getMessages: false, turnCompleted: false,
  });
  if (!admitted) return empty('RECOVERY_PROMPT_MISSING');
  const terminal = ordered.find(event => event.seq > admitted.seq
    && event.kind === 'turn.completed'
    && event.promptId === promptId
    && event.sessionGeneration === admitted.sessionGeneration);
  if (!terminal) return empty('RECOVERY_TURN_INCOMPLETE');
  const outcome = (terminal.payload as TurnCompletedPayload).outcome;
  if (outcome !== 'completed') return empty('RECOVERY_TURN_FAILED');

  const records = new Map<string, ToolRecord>();
  for (const event of ordered) {
    if (event.seq <= admitted.seq || event.seq >= terminal.seq
        || event.promptId !== promptId
        || event.sessionGeneration !== admitted.sessionGeneration) continue;
    recordFor(records, event);
  }
  const values = [...records.values()];
  const chooses = values.filter(record => safeChoose(record, identity));
  const currents = values.filter(safeCurrent);
  const messages = values.filter(safeMessages);
  const chooseIdentity = chooses.length > 0;
  const currentIdentity = currents.length > 0;
  const getMessages = messages.length > 0;
  const base = { chooseIdentity, currentIdentity, getMessages, turnCompleted: true };
  if (!chooseIdentity) return { ok: false, reason: 'RECOVERY_CHOOSE_MISSING', ...base };
  if (!currentIdentity) return { ok: false, reason: 'RECOVERY_CURRENT_MISSING', ...base };
  if (!getMessages) return { ok: false, reason: 'RECOVERY_GET_MESSAGES_MISSING', ...base };
  const orderedChain = chooses.some(choose => currents.some(current => messages.some(message =>
    choose.completedSeq !== undefined && current.completedSeq !== undefined
      && message.completedSeq !== undefined
      && choose.completedSeq < current.completedSeq
      && current.completedSeq < message.completedSeq)));
  if (!orderedChain) return { ok: false, reason: 'RECOVERY_TOOL_ORDER_INVALID', ...base };
  return { ok: true, reason: 'RECOVERY_TOOLS_VERIFIED', ...base };
}

export async function recoverAgentIdentity(
  session: AgentSession, identity: string,
): Promise<AgentRecoveryEvidence> {
  if (!session.subscribeConversation)
    return {
      ok: false, reason: 'RECOVERY_PROMPT_MISSING', chooseIdentity: false,
      currentIdentity: false, getMessages: false, turnCompleted: false,
    };
  const events: ConversationEventV1[] = [];
  const unsubscribe = session.subscribeConversation(event => events.push(event));
  try {
    const queued = await session.queuePrompt([
      '[fleet-recovery] The shared ours daemon restarted.',
      `Call ours choose_identity with name ${JSON.stringify(identity)} and force false.`,
      'Then call current_identity, then get_messages. Complete all three in that order.',
      'Do not create/delete identities, force-bind, interrupt, or restart any service/session.',
    ].join('\n'), { origin: { kind: 'fleet-monitor' } });
    await queued.completion;
    // Conversation publication is synchronous with terminal settlement in the
    // in-tree ACP store; filtering by exact promptId/sessionGeneration remains
    // the authority even if unrelated events arrived concurrently.
    return evaluateAgentRecovery(events, queued.promptId, identity);
  } finally {
    unsubscribe();
  }
}
