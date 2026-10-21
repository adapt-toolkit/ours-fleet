import { describe, expect, it } from 'vitest';
import { ConversationObservation } from '../src/session/conversation-observation.js';

describe('passive conversation observation', () => {
  it('captures fresh state and barriers, preserving revisions across reconnects', async () => {
    let barrier = 0;
    let depth = 0;
    const owner = new ConversationObservation(() => ({
      sessionGeneration: 'generation', ledgerBarrier: barrier, readiness: 'idle' as const,
      alive: true, queueDepth: depth, pendingPermissionIds: [], pendingPermissions: [],
      pendingPrompts: [], pendingPromptCount: 0, activePromptIds: [], commands: [],
    }));
    const published: Array<{ queueDepth: number; ledgerBarrier: number; stateRevision: number }> = [];
    const first = owner.observe(state => published.push(state));
    barrier = 1;
    owner.scheduleCapture();
    depth = 1;
    owner.publish();
    expect(published.at(-1)).toMatchObject({ queueDepth: 1, ledgerBarrier: 1 });
    first.unsubscribe();
    const second = owner.observe(() => {});
    expect(second.snapshot.stateRevision).toBeGreaterThanOrEqual(published.at(-1)!.stateRevision);
    barrier = 2;
    owner.scheduleCapture();
    await Promise.resolve();
    const third = owner.observe(() => {});
    expect(third.snapshot.ledgerBarrier).toBe(2);
    expect(third.snapshot.stateRevision).toBeGreaterThan(second.snapshot.stateRevision);
    second.unsubscribe(); third.unsubscribe();
  });
});

describe('observation owner checkpoints', () => {
  it('keeps nested mutation and exception cleanup from publishing partial state', async () => {
    let barrier = 0, depth = 0;
    const owner = new ConversationObservation(() => ({
      sessionGeneration: 'generation', ledgerBarrier: barrier, readiness: 'idle' as const,
      alive: true, queueDepth: depth, pendingPermissionIds: [], pendingPermissions: [],
      pendingPrompts: [], pendingPromptCount: 0, activePromptIds: [], commands: [],
    }));
    const states: Array<{ ledgerBarrier: number; queueDepth: number }> = [];
    const initial = owner.observe(state => states.push(state));
    expect(() => owner.checkpoint(() => {
      barrier = 1;
      owner.publish();
      owner.scheduleCapture();
      const reentrant = owner.observe(() => {});
      expect(reentrant.snapshot).toMatchObject({ ledgerBarrier: 0, queueDepth: 0 });
      reentrant.unsubscribe();
      owner.checkpoint(() => { depth = 1; owner.publish(); });
      expect(states).toEqual([]);
      throw new Error('owner mutation failed');
    })).toThrow('owner mutation failed');
    expect(states).toEqual([expect.objectContaining({ ledgerBarrier: 1, queueDepth: 1 })]);
    await Promise.resolve();
    expect(states).toHaveLength(1);
    barrier = 2; owner.publish();
    expect(states.at(-1)).toMatchObject({ ledgerBarrier: 2, queueDepth: 1 });
    initial.unsubscribe();
  });
});


describe('observation capture failure isolation', () => {
  it('latches explicit failed coverage on the previous coherent barrier without throwing into owners', () => {
    let barrier = 1, fail = false;
    const owner = new ConversationObservation(() => {
      if (fail) throw new Error('capture fault');
      return { sessionGeneration: 'generation', ledgerBarrier: barrier, readiness: 'idle' as const,
        alive: true, queueDepth: 0, pendingPermissionIds: [], pendingPermissions: [],
        pendingPrompts: [], pendingPromptCount: 0, activePromptIds: [], commands: [] };
    });
    const states: Array<{ ledgerBarrier: number; observationFailure?: string }> = [];
    const initial = owner.observe(state => states.push(state));
    let admitted = false;
    expect(() => owner.checkpoint(() => { admitted = true; barrier = 2; fail = true; })).not.toThrow();
    expect(admitted).toBe(true);
    expect(states.at(-1)).toMatchObject({ ledgerBarrier: 1, observationFailure: 'capture_failed' });
    fail = false; barrier = 3; owner.publish();
    const reconnect = owner.observe(() => {});
    expect(reconnect.snapshot).toMatchObject({ ledgerBarrier: 1, observationFailure: 'capture_failed' });
    initial.unsubscribe(); reconnect.unsubscribe();
  });

  it('keeps owners alive if the first capture fails and makes registration unavailable explicitly', () => {
    const owner = new ConversationObservation(() => { throw new Error('initial capture fault'); });
    expect(() => owner.publish()).not.toThrow();
    expect(() => owner.checkpoint(() => 7)).not.toThrow();
    expect(() => owner.observe(() => {})).toThrow('conversation observation unavailable: capture_failed');
  });
});


it('isolates an uncloneable owner capture and preserves its preceding certified barrier', () => {
  let barrier = 1, bad = false;
  const owner = new ConversationObservation(() => ({
    sessionGeneration: 'generation', ledgerBarrier: barrier, readiness: 'idle' as const,
    alive: true, queueDepth: 0, pendingPermissionIds: [], pendingPermissions: [],
    pendingPrompts: [], pendingPromptCount: 0, activePromptIds: [], commands: [],
    runtimeModel: bad ? { value: 'bad-model', providerHook: () => {} } : { value: 'good-model' },
  }));
  const observer = owner.observe(() => {});
  barrier = 2; bad = true;
  expect(() => owner.publish()).not.toThrow();
  const reconnect = owner.observe(() => {});
  expect(reconnect.snapshot).toMatchObject({ ledgerBarrier: 1,
    runtimeModel: { value: 'good-model' }, observationFailure: 'capture_failed' });
  observer.unsubscribe(); reconnect.unsubscribe();
});

it('does not turn generic historical degradation into terminal current observation failure', () => {
  const owner = new ConversationObservation(() => ({
    sessionGeneration: 'generation', ledgerBarrier: 7, readiness: 'idle' as const,
    alive: true, queueDepth: 0, pendingPermissionIds: [], pendingPermissions: [],
    pendingPrompts: [], pendingPromptCount: 0, activePromptIds: [], commands: [], historyDegraded: true,
  }));
  const observer = owner.observe(() => {});
  expect(observer.snapshot.historyDegraded).toBe(true);
  expect(observer.snapshot.observationFailure).toBeUndefined();
  observer.unsubscribe();
});
