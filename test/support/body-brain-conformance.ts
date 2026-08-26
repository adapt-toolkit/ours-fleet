import { describe, expect, it } from 'vitest';
import { followBodyBrain } from '../../src/session/body-brain-control.js';
import type {
  BodyBrainEvent, BodyBrainPageRequest, BodyBrainPageResult, BodyBrainPromptRequest,
  BodyBrainRecoveryFailureCode, BodyBrainRestoreResult, BodyBrainSession, BodyBrainTurnOutcome,
} from '../../src/session/body-brain.js';

export type Awaitable<T> = T | Promise<T>;
export type BodyBrainCorruptionScenario =
  | 'reference_missing' | 'adapter_incompatible' | 'protocol_mismatch'
  | 'agent_exited' | 'corrupt_recovery' | 'resume_rejected';

export interface BodyBrainConformanceDriver {
  complete(session: BodyBrainSession, promptId: string, outcome: BodyBrainTurnOutcome): Awaitable<void>;
  requestPermission(session: BodyBrainSession, promptId: string, optionIds: readonly string[]): Awaitable<void>;
  armObservationEvents(
    session: BodyBrainSession, boundary: 'snapshot' | 'page', count: number,
  ): Awaitable<void>;
  waitFor<T>(observation: () => Awaitable<T>, ready: (value: T) => boolean): Promise<T>;
}

export interface BodyBrainConformanceFixture {
  session: BodyBrainSession;
  driver: BodyBrainConformanceDriver;
  observe<T>(operation: () => T): Awaitable<T>;
  recovery(session: BodyBrainSession): Awaitable<unknown>;
  restore(record: unknown): Awaitable<BodyBrainRestoreResult>;
  corrupt(scenario: BodyBrainCorruptionScenario, compatibleRecord: unknown): Awaitable<unknown>;
  /** Owns and releases every resource/session created by start, restore, corruption, or driver hooks. */
  cleanup(): Awaitable<void>;
}

export interface BodyBrainConformanceFactory {
  start(): Awaitable<BodyBrainConformanceFixture>;
}

const BODY_DIGEST = `sha256:${'a'.repeat(64)}`;
const prompt = (generation: string, commandId: string): BodyBrainPromptRequest => ({
  generation, commandId, body: { digest: BODY_DIGEST, bytes: 1 },
  origin: { kind: 'owner', requestId: `origin-${commandId}` },
});
const events = (page: BodyBrainPageResult): readonly BodyBrainEvent[] => {
  expect(page.state).toBe('ok');
  return page.state === 'ok' ? page.events : [];
};

function requireFixture(value: BodyBrainConformanceFixture): void {
  if (!value.session || !value.driver) throw new Error('required conformance fixture session/driver missing');
  for (const key of ['observe', 'recovery', 'restore', 'corrupt', 'cleanup'] as const)
    if (typeof value[key] !== 'function') throw new Error(`required conformance fixture hook missing: ${key}`);
  for (const key of ['complete', 'requestPermission', 'armObservationEvents', 'waitFor'] as const)
    if (typeof value.driver[key] !== 'function') throw new Error(`required conformance driver hook missing: ${key}`);
}

export async function withBodyBrainConformanceFixture(
  factory: BodyBrainConformanceFactory,
  body: (fixture: BodyBrainConformanceFixture) => Awaitable<void>,
): Promise<void> {
  const fixture = await factory.start();
  const cleanup = fixture && typeof fixture.cleanup === 'function'
    ? fixture.cleanup.bind(fixture) : undefined;
  try {
    requireFixture(fixture);
    await body(fixture);
  } finally {
    if (cleanup) await cleanup();
  }
}

/** One mandatory, non-selectable matrix shared by fake and production adapters. */
export function defineBodyBrainConformance(
  adapterName: string, factory: BodyBrainConformanceFactory,
): void {
  const matrixCase = (name: string, body: (fixture: BodyBrainConformanceFixture) => Awaitable<void>): void => {
    it(name, async () => {
      await withBodyBrainConformanceFixture(factory, body);
    });
  };

  describe(`${adapterName} required BodyBrain conformance`, () => {
    matrixCase('starts with immutable, generation-consistent public state', async fixture => {
      const snapshot = await fixture.observe(() => fixture.session.snapshot());
      expect(snapshot).toMatchObject({ protocolVersion: 1, sessionRef: fixture.session.sessionRef,
        generation: fixture.session.generation, cursor: 'bb:0' });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.activePermissionIds)).toBe(true);
      expect(() => (snapshot.activePermissionIds as string[]).push('mutate')).toThrow();
    });

    matrixCase('restores an exact compatible ledger and idempotency bindings', async fixture => {
      const request = prompt(fixture.session.generation, 'restore-admission');
      const admitted = await fixture.observe(() => fixture.session.admitPrompt(request));
      expect(admitted.state).toBe('accepted');
      const before = await fixture.observe(() => fixture.session.page());
      const beforeSnapshot = await fixture.observe(() => fixture.session.snapshot());
      const record = await fixture.recovery(fixture.session);
      const restored = await fixture.restore(record);
      expect(restored.state).toBe('restored');
      if (restored.state !== 'restored') return;
      expect(restored.session.sessionRef).toBe(fixture.session.sessionRef);
      expect(restored.session.generation).toBe(fixture.session.generation);
      const restoredSnapshot = await fixture.observe(() => restored.session.snapshot());
      expect(restoredSnapshot).toEqual(beforeSnapshot);
      expect(restoredSnapshot).toMatchObject({ sessionRef: beforeSnapshot.sessionRef,
        generation: beforeSnapshot.generation, cursor: beforeSnapshot.cursor, state: beforeSnapshot.state,
        activePromptId: beforeSnapshot.activePromptId,
        activePermissionIds: beforeSnapshot.activePermissionIds });
      expect(await fixture.observe(() => restored.session.page())).toEqual(before);
      expect(await fixture.observe(() => restored.session.admitPrompt(request))).toEqual(admitted);
    });

    for (const code of ['reference_missing', 'adapter_incompatible', 'protocol_mismatch', 'agent_exited',
      'corrupt_recovery', 'resume_rejected'] as const) {
      matrixCase(`normalizes ${code} restore failure`, async fixture => {
        const record = await fixture.recovery(fixture.session);
        const corrupt = await fixture.corrupt(code, record);
        const result = await fixture.restore(corrupt);
        expect(result).toEqual({ state: 'failed', code: code as BodyBrainRecoveryFailureCode });
      });
    }

    matrixCase('separates admission/completion and promotes the queue in ledger order', async fixture => {
      const first = await fixture.observe(() => fixture.session.admitPrompt(
        prompt(fixture.session.generation, 'queue-first')));
      const second = await fixture.observe(() => fixture.session.admitPrompt(
        prompt(fixture.session.generation, 'queue-second')));
      expect(first.state).toBe('accepted'); expect(second.state).toBe('accepted');
      if (first.state !== 'accepted' || second.state !== 'accepted') return;
      expect(first.receipt.promptId).not.toBe(second.receipt.promptId);
      expect(first.receipt.queuedBehind).toBe(0); expect(second.receipt.queuedBehind).toBe(1);
      expect(await fixture.observe(() => fixture.session.awaitCompletion(
        fixture.session.generation, first.receipt.promptId))).toEqual({ state: 'not_terminal' });
      await fixture.driver.complete(fixture.session, first.receipt.promptId, 'completed');
      const terminal = await fixture.driver.waitFor(
        () => fixture.observe(() => fixture.session.awaitCompletion(
          fixture.session.generation, first.receipt.promptId)), value => value.state === 'terminal');
      expect(terminal).toMatchObject({ state: 'terminal', completion: { promptId: first.receipt.promptId } });
      const ledger = events(await fixture.observe(() => fixture.session.page()));
      const completed = ledger.findIndex(event => event.kind === 'prompt_completed'
        && event.promptId === first.receipt.promptId);
      const started = ledger.findIndex(event => event.kind === 'prompt_started'
        && event.promptId === second.receipt.promptId);
      expect(completed).toBeGreaterThanOrEqual(0); expect(started).toBe(completed + 1);
    });

    matrixCase('normalizes permission decisions and command idempotency', async fixture => {
      const admitted = await fixture.observe(() => fixture.session.admitPrompt(
        prompt(fixture.session.generation, 'permission-prompt')));
      if (admitted.state !== 'accepted') throw new Error('admission required');
      await fixture.driver.requestPermission(fixture.session, admitted.receipt.promptId, ['allow', 'deny']);
      const ledger = events(await fixture.observe(() => fixture.session.page()));
      const requestEvent = ledger.find(event => event.kind === 'permission_requested');
      expect(requestEvent?.promptId).toBe(admitted.receipt.promptId);
      const permissionId = requestEvent?.permissionId;
      if (!permissionId) throw new Error('permission correlation required');
      const invalid = { generation: fixture.session.generation, commandId: 'permission-invalid',
        permissionId, optionId: 'later' };
      expect(await fixture.observe(() => fixture.session.respondPermission(invalid)))
        .toEqual({ state: 'invalid_option' });
      expect(await fixture.observe(() => fixture.session.respondPermission({ ...invalid,
        commandId: 'permission-unknown', permissionId: 'unknown-permission', optionId: 'allow' })))
        .toEqual({ state: 'unknown_permission' });
      const accepted = { generation: fixture.session.generation, commandId: 'permission-accepted',
        permissionId, optionId: 'allow' };
      const acceptedResult = await fixture.observe(() => fixture.session.respondPermission(accepted));
      expect(acceptedResult).toEqual({ state: 'accepted', optionId: 'allow' });
      expect(await fixture.observe(() => fixture.session.respondPermission(accepted))).toEqual(acceptedResult);
      expect(await fixture.observe(() => fixture.session.respondPermission({ ...accepted, optionId: 'deny' })))
        .toEqual({ state: 'idempotency_conflict' });
      expect(await fixture.observe(() => fixture.session.respondPermission({ ...accepted,
        commandId: 'permission-settled', optionId: 'deny' })))
        .toEqual({ state: 'already_settled', optionId: 'allow' });
    });

    matrixCase('fences stale generation with no new ledger events', async fixture => {
      const before = events(await fixture.observe(() => fixture.session.page())).length;
      expect(await fixture.observe(() => fixture.session.admitPrompt(
        prompt(`${fixture.session.generation}-stale`, 'stale-admission')))).toEqual({ state: 'stale_generation' });
      expect(await fixture.observe(() => fixture.session.requestCancel({
        generation: `${fixture.session.generation}-stale`, commandId: 'stale-cancel',
      }))).toEqual({ state: 'stale_generation' });
      expect(events(await fixture.observe(() => fixture.session.page()))).toHaveLength(before);
    });

    matrixCase('bridges replay/live follow without gaps or duplicate delivery', async fixture => {
      await fixture.observe(() => fixture.session.admitPrompt(prompt(fixture.session.generation, 'follow-before')));
      await fixture.observe(() => fixture.session.admitPrompt(prompt(fixture.session.generation, 'follow-queued')));
      await fixture.driver.armObservationEvents(fixture.session, 'snapshot', 1);
      await fixture.driver.armObservationEvents(fixture.session, 'page', 1);
      const seen: number[] = []; const terminals: string[] = [];
      const follow = followBodyBrain(fixture.session, { pageSize: 1, onEvent: event => seen.push(event.seq),
        onClose: terminal => terminals.push(terminal.reason) });
      await fixture.observe(() => fixture.session.requestCancel({
        generation: fixture.session.generation, commandId: 'follow-live',
      }));
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.every((seq, index) => seq === index + 1)).toBe(true);
      follow.close(); expect(terminals).toEqual(['caller_closed']);
    });

    matrixCase('keeps cancel distinct from force and fences post-terminal commands', async fixture => {
      const admitted = await fixture.observe(() => fixture.session.admitPrompt(
        prompt(fixture.session.generation, 'force-prompt')));
      if (admitted.state !== 'accepted') throw new Error('admission required');
      expect(await fixture.observe(() => fixture.session.requestCancel({
        generation: fixture.session.generation, commandId: 'cancel-command',
      }))).toMatchObject({ state: 'accepted' });
      expect(await fixture.observe(() => fixture.session.awaitCompletion(
        fixture.session.generation, admitted.receipt.promptId))).toEqual({ state: 'not_terminal' });
      const forceRequest = { generation: fixture.session.generation, commandId: 'force-command' };
      const force = await fixture.observe(() => fixture.session.forceTerminate(forceRequest));
      expect(force).toMatchObject({ state: 'accepted' });
      expect(await fixture.observe(() => fixture.session.forceTerminate(forceRequest))).toEqual(force);
      expect(await fixture.observe(() => fixture.session.admitPrompt(
        prompt(fixture.session.generation, 'after-force')))).toEqual({ state: 'terminated' });
      expect(await fixture.observe(() => fixture.session.close({
        generation: fixture.session.generation, commandId: 'close-after-force',
      }))).toEqual({ state: 'terminated' });
    });

    matrixCase('keeps close distinct from retire and retire idempotent', async fixture => {
      const closeRequest = { generation: fixture.session.generation, commandId: 'close-command' };
      const closed = await fixture.observe(() => fixture.session.close(closeRequest));
      expect(closed).toMatchObject({ state: 'accepted' });
      expect(await fixture.observe(() => fixture.session.close(closeRequest))).toEqual(closed);
      expect((await fixture.observe(() => fixture.session.snapshot())).state).toBe('closed');
      const retireRequest = { generation: fixture.session.generation, commandId: 'retire-command' };
      const retired = await fixture.observe(() => fixture.session.retire(retireRequest));
      expect(retired).toMatchObject({ state: 'accepted' });
      expect(await fixture.observe(() => fixture.session.retire(retireRequest))).toEqual(retired);
      expect((await fixture.observe(() => fixture.session.snapshot())).state).toBe('retired');
    });

    matrixCase('enforces bounded pages and bounded follow buffering', async fixture => {
      expect(await fixture.observe(() => fixture.session.page({ limit: 0 }))).toMatchObject({ state: 'invalid_cursor' });
      expect(await fixture.observe(() => fixture.session.page({ limit: 257 }))).toMatchObject({ state: 'invalid_cursor' });
      await fixture.driver.armObservationEvents(fixture.session, 'snapshot', 2);
      const terminals: string[] = [];
      const follow = followBodyBrain(fixture.session, { bufferLimit: 1, onEvent: () => {},
        onClose: terminal => terminals.push(terminal.reason) });
      expect(follow.closed).toBe(true); expect(terminals).toEqual(['buffer_overflow']);
    });

    matrixCase('keeps page events immutable and monotonically correlated', async fixture => {
      await fixture.observe(() => fixture.session.admitPrompt(prompt(fixture.session.generation, 'immutable')));
      await fixture.observe(() => fixture.session.admitPrompt(prompt(fixture.session.generation, 'immutable-two')));
      const page = await fixture.observe(() => fixture.session.page({ after: 'bb:0' }));
      const ledger = events(page);
      expect(Object.isFrozen(page)).toBe(true); expect(Object.isFrozen(ledger)).toBe(true);
      expect(Object.isFrozen(ledger[0])).toBe(true); expect(Object.isFrozen(ledger[0]?.payload)).toBe(true);
      expect(ledger.every((event, index) => event.seq === index + 1 && event.generation === fixture.session.generation))
        .toBe(true);
      expect(new Set(ledger.map(event => event.eventId)).size).toBe(ledger.length);
      for (let index = 1; index < ledger.length; index++)
        expect(Date.parse(ledger[index]!.at)).toBeGreaterThan(Date.parse(ledger[index - 1]!.at));
    });
  });
}
