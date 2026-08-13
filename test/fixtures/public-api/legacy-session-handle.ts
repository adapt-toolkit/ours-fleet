/**
 * The supported public `SessionHandle` contract, compiled as an out-of-tree
 * consumer would compile it. Two things have to hold at once:
 *
 *  - an implementation written against the pre-0.17.1 `interrupt(): Promise<void>`
 *    still satisfies `SessionHandle` (this failed with TS2322 in the candidate);
 *  - the richer outcome is nameable from the package root, so a consumer that
 *    wants to read `settled`/`forced` can type it without reaching into `dist`.
 *
 * `test/public-api-contract.test.ts` type-checks this file; nothing runs it.
 */
import { interruptOutcome } from '../../../src/index.js';
import type {
  ExitRecord, InterruptOutcome, InterruptResult, QueuedPrompt, SessionEvent, SessionHandle,
  SessionSnapshot, TurnCancellationSource, TurnResult,
} from '../../../src/index.js';

const completed: TurnResult = { accepted: true, outcome: 'completed', succeeded: true };

/** Written against the 0.17.0 contract: resolving at all meant "cancelled". */
class LegacySession implements SessionHandle {
  readonly backend = 'acp' as const;
  readonly pid = 1;
  isAlive(): boolean { return true; }
  snapshot(): SessionSnapshot { return { backend: 'acp', alive: true, readiness: 'idle' }; }
  async queuePrompt(): Promise<QueuedPrompt> {
    return { promptId: 'p1', queuedBehind: 0, completion: Promise.resolve(completed) };
  }
  async submitPrompt(): Promise<TurnResult> { return completed; }
  async interrupt(): Promise<void> {}
  respondPermission(): boolean { return false; }
  eventsSince(): SessionEvent[] { return []; }
  subscribe(): () => void { return () => undefined; }
  setControllerAttached(): void {}
  exitResult(): ExitRecord | null { return null; }
  async close(): Promise<void> {}
}

/** Written against the current contract. */
class CurrentSession implements SessionHandle {
  readonly backend = 'acp' as const;
  readonly pid = 2;
  isAlive(): boolean { return true; }
  snapshot(): SessionSnapshot { return { backend: 'acp', alive: true, readiness: 'idle' }; }
  async queuePrompt(): Promise<QueuedPrompt> {
    return { promptId: 'p2', queuedBehind: 0, completion: Promise.resolve(completed) };
  }
  async submitPrompt(): Promise<TurnResult> { return completed; }
  async interrupt(source?: TurnCancellationSource): Promise<InterruptOutcome> {
    return { state: source === 'owner' ? 'forced' : 'settled', reasonCode: 'X' };
  }
  respondPermission(): boolean { return false; }
  eventsSince(): SessionEvent[] { return []; }
  subscribe(): () => void { return () => undefined; }
  setControllerAttached(): void {}
  exitResult(): ExitRecord | null { return null; }
  async close(): Promise<void> {}
}

const handles: SessionHandle[] = [new LegacySession(), new CurrentSession()];

export async function readOutcome(handle: SessionHandle): Promise<InterruptOutcome['state']> {
  const result: InterruptResult = await handle.interrupt('local-console');
  return interruptOutcome(result).state;
}

export const contract = Promise.all(handles.map(readOutcome));
