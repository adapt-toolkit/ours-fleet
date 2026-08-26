import { describe, expect, it, vi } from 'vitest';

import { retainedEventPage } from '../src/session/control.js';
import type { SessionEvent, SessionHandle } from '../src/session/types.js';

describe('session query parity', () => {
  it('projects the identical retained-range page for events_since and follow admission', () => {
    const retained: SessionEvent[] = [10, 11, 12].map(seq => ({
      version: 1, seq, at: 't', kind: seq === 11 ? 'thought' : 'state',
    }));
    const session = {
      eventsSince: vi.fn((since: number) => retained.filter(event => event.seq > since)),
      snapshot: vi.fn(() => ({ backend: 'acp', alive: true, readiness: 'idle' })),
    } as unknown as SessionHandle;

    const eventsSinceInitial = retainedEventPage(session, 3);
    const followInitial = retainedEventPage(session, 3);

    expect(followInitial).toEqual(eventsSinceInitial);
    expect(eventsSinceInitial).toMatchObject({
      firstSeq: 10, lastSeq: 12, truncated: true,
      events: [{ seq: 10 }, { seq: 11, kind: 'thought' }, { seq: 12 }],
    });
    expect(retainedEventPage(session, 9).truncated).toBe(false);
    expect(retainedEventPage(session, 0).truncated).toBe(false);
  });
});
