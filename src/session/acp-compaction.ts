/** Minimal compatibility surface for the standard unstable ACP compaction update. */
export type CompactionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface CompactionNotification {
  sessionId: string;
  compactionId: string;
  /** Unknown statuses remain generic in presentation; bounded wireStatus is opaque metadata. */
  status: CompactionStatus;
  wireStatus?: string;
}

export interface CompactionLifecycleEvent extends Omit<CompactionNotification, 'status'> {
  status: CompactionStatus | 'unknown_ended';
  replayed: boolean;
}

export type ParsedCompactionNotification =
  | { kind: 'pass' }
  | { kind: 'invalid' }
  | { kind: 'summary' }
  | { kind: 'update'; update: CompactionNotification };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const boundedToken = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value) <= maxBytes && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const isTerminal = (status: CompactionLifecycleEvent['status']): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'unknown_ended';

/**
 * Required ContentBlock fields from ACP 1.3.0's five public discriminators.
 * Optional metadata is discarded, just as the SDK tolerates invalid optional
 * fields. No content or validation error object is returned to the caller.
 */
function validSummaryContent(content: unknown): boolean {
  if (!isRecord(content)) return false;
  switch (content.type) {
    case 'text': return typeof content.text === 'string';
    case 'image':
    case 'audio': return typeof content.data === 'string' && typeof content.mimeType === 'string';
    case 'resource_link': return typeof content.uri === 'string' && typeof content.name === 'string';
    case 'resource': return isRecord(content.resource) && typeof content.resource.uri === 'string'
      && (typeof content.resource.text === 'string' || typeof content.resource.blob === 'string');
    default: return false;
  }
}

/** Inspect only our exact notification variant. Every other RPC remains SDK-owned. */
export function parseCompactionNotification(value: unknown): ParsedCompactionNotification {
  if (!isRecord(value) || Object.hasOwn(value, 'id') || value.method !== 'session/update'
      || !isRecord(value.params) || !isRecord(value.params.update)
      || (value.params.update.sessionUpdate !== 'compaction_update'
        && value.params.update.sessionUpdate !== 'compaction_summary_chunk'))
    return { kind: 'pass' };
  const { sessionId } = value.params;
  if (value.jsonrpc !== '2.0' || !boundedToken(sessionId, 256)) return { kind: 'invalid' };
  if (value.params.update.sessionUpdate === 'compaction_summary_chunk')
    return boundedToken(value.params.update.compactionId, 256) && validSummaryContent(value.params.update.content)
      ? { kind: 'summary' } : { kind: 'invalid' };
  const { compactionId, status } = value.params.update;
  if (!boundedToken(compactionId, 256) || !boundedToken(status, 64)) return { kind: 'invalid' };
  const normalized = status === 'in_progress' || status === 'completed' || status === 'failed' || status === 'cancelled'
    ? status : 'unknown';
  return { kind: 'update', update: {
    sessionId, compactionId, status: normalized,
    ...(normalized === 'unknown' ? { wireStatus: status } : {}),
  } };
}

/**
 * Wrap the parsed ndJsonStream before ACP schema validation. Callbacks execute
 * synchronously before the next RPC can reach the SDK, preserving turn-boundary
 * ordering. Summaries, extension metadata, and malformed bodies never escape.
 */
export function interceptCompactionStream<T>(
  stream: { readable: ReadableStream<T>; writable: WritableStream<T> },
  onUpdate: (event: CompactionNotification) => void,
  onInvalid: () => void,
): { readable: ReadableStream<T>; writable: WritableStream<T> } {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(new TransformStream<T, T>({
      transform(value, controller) {
        const parsed = parseCompactionNotification(value);
        if (parsed.kind === 'pass') controller.enqueue(value);
        else if (parsed.kind === 'invalid') onInvalid();
        else if (parsed.kind === 'update') onUpdate(parsed.update);
      },
    })),
  };
}

export interface CompactionObservation {
  ignored: boolean;
  recoveryRequired: boolean;
  event?: CompactionLifecycleEvent;
}

/**
 * One tracker belongs to one adapter generation. Callers reject retired
 * callbacks and supply the expected session ID, including during session/load.
 * Terminal IDs remain remembered; capacity exhaustion requests recovery rather
 * than evicting an ID and accidentally reopening historical or active work.
 */
export class CompactionTracker {
  private readonly entries = new Map<string, CompactionLifecycleEvent>();
  private readonly maxEntries: number;
  private exhausted = false;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1)
      throw new Error('Compaction state capacity must be a positive safe integer');
  }

  get recoveryRequired(): boolean { return this.exhausted; }

  observe(
    update: CompactionNotification,
    context: { sessionId: string; mode: 'live' | 'replay' },
  ): CompactionObservation {
    const ignored = (): CompactionObservation => ({ ignored: true, recoveryRequired: this.exhausted });
    if (update.sessionId !== context.sessionId || this.exhausted) return ignored();
    const key = `${update.sessionId}\0${update.compactionId}`;
    const previous = this.entries.get(key);
    const replayed = context.mode === 'replay';
    // Replayed history cannot override live evidence. The first terminal wins
    // even when a late/duplicate start arrives after it.
    const refinesUnknown = previous?.status === 'unknown_ended'
      && (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled');
    if (previous && !refinesUnknown && (isTerminal(previous.status) || (!previous.replayed && replayed)
        || (previous.status === update.status && previous.wireStatus === update.wireStatus && previous.replayed === replayed))) return ignored();
    if (!previous && this.entries.size >= this.maxEntries) {
      this.exhausted = true;
      return { ignored: false, recoveryRequired: true };
    }
    const event: CompactionLifecycleEvent = {
      sessionId: update.sessionId, compactionId: update.compactionId, status: update.status, replayed,
      ...(update.wireStatus ? { wireStatus: update.wireStatus } : {}),
    };
    this.entries.set(key, event);
    return { ignored: false, recoveryRequired: false, event: { ...event } };
  }

  activeIds(): string[] {
    return [...this.entries.values()]
      .filter(event => !event.replayed && !isTerminal(event.status))
      .map(event => event.compactionId);
  }

  /** A prompt boundary without lifecycle terminals is uncertainty, never success. */
  endTurn(): CompactionLifecycleEvent[] {
    return this.endMatching(event => !event.replayed);
  }

  /** Replay completion cannot leave historical activity displayed as live work. */
  endReplay(sessionId: string): CompactionLifecycleEvent[] {
    return this.endMatching(event => event.replayed && event.sessionId === sessionId);
  }

  private endMatching(matches: (event: CompactionLifecycleEvent) => boolean): CompactionLifecycleEvent[] {
    const ended: CompactionLifecycleEvent[] = [];
    for (const [key, event] of this.entries) {
      if (!matches(event) || isTerminal(event.status)) continue;
      const terminal: CompactionLifecycleEvent = { ...event, status: 'unknown_ended' };
      this.entries.set(key, terminal);
      ended.push({ ...terminal });
    }
    return ended;
  }
}
