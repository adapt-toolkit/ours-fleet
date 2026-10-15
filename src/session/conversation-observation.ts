import type {
  ConversationObservation as Observation, ConversationObservationState,
} from './conversation-types.js';

type Capture = () => Omit<ConversationObservationState, 'stateRevision'>;

/** Revision/publication only: the backend remains the sole owner of snapshot construction. */
export class ConversationObservation {
  private revision = 0;
  private fingerprint?: string;
  private current?: ConversationObservationState;
  private scheduled = false;
  private checkpointDepth = 0;
  private failed = false;
  private readonly listeners = new Set<(state: ConversationObservationState) => void>();

  constructor(private readonly capture: Capture) {}

  observe(listener: (state: ConversationObservationState) => void): Observation {
    // Registration and synchronous stable capture have no await gap. Inside an
    // owner checkpoint, publish retains the preceding snapshot and its barrier.
    // A reconnect never resets this generation's revision or implies control.
    this.publish();
    if (!this.current) throw new Error('conversation observation unavailable: capture_failed');
    this.listeners.add(listener);
    return {
      snapshot: structuredClone(this.current!),
      unsubscribe: () => { this.listeners.delete(listener); },
    };
  }

  /** Keep reentrant registration on the preceding coherent snapshot until the
   * owner's synchronous durable append and inventory mutation finish together.
   */
  checkpoint<T>(mutation: () => T): T {
    if (this.checkpointDepth === 0) this.publish();
    this.checkpointDepth++;
    try {
      return mutation();
    } finally {
      this.checkpointDepth--;
      if (this.checkpointDepth === 0) this.publish();
    }
  }

  publish(): void {
    if (this.checkpointDepth > 0 || this.failed) return;
    try {
      const captured = this.capture();
      const fingerprint = JSON.stringify(captured);
      if (fingerprint === this.fingerprint) return;
      const current = structuredClone({ ...captured, stateRevision: this.revision + 1 });
      this.fingerprint = fingerprint;
      this.current = current;
      this.revision++;
    } catch {
      this.failCapture();
      return;
    }
    this.deliver();
  }

  private failCapture(): void {
    if (this.failed) return;
    this.failed = true;
    // Retain the entire preceding coherent state and its barrier. Consumers
    // must stop healthy coverage; owner admission/receipt processing continues.
    if (this.current) {
      this.current = { ...this.current, stateRevision: ++this.revision, observationFailure: 'capture_failed' };
      this.deliver();
    }
  }

  private deliver(): void {
    for (const listener of this.listeners) {
      let state: ConversationObservationState;
      try { state = structuredClone(this.current!); }
      catch { this.failCapture(); return; }
      // An observer callback cannot break the owning backend's transition.
      try { listener(state); } catch { /* passive observer */ }
    }
  }

  /** Fresh capture after a durable append's synchronous owner mutation completes. */
  scheduleCapture(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.publish();
    });
  }
}
