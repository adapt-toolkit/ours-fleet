import { afterAll, expect, it } from 'vitest';
import {
  FakeBodyBrainSession, FakeBodyBrainSessionRestorer,
} from '../src/session/fake-body-brain.js';
import type {
  BodyBrainDeterminism, BodyBrainRecoveryRecord, BodyBrainRestoreResult, BodyBrainSession,
} from '../src/session/body-brain.js';
import {
  defineBodyBrainConformance, type BodyBrainConformanceFactory,
  type BodyBrainConformanceFixture, type BodyBrainCorruptionScenario,
  withBodyBrainConformanceFixture,
} from './support/body-brain-conformance.js';

function deterministic(): BodyBrainDeterminism {
  let tick = 0; let id = 0;
  return {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    nextId: kind => `${kind}-${++id}`,
  };
}

interface HookState {
  inner: FakeBodyBrainSession;
  snapshotEvents: number;
  pageEvents: number;
  command: number;
}

let cleanupCount = 0;
const factory: BodyBrainConformanceFactory = {
  async start(): Promise<BodyBrainConformanceFixture> {
    const source = deterministic();
    const adapterId = 'fake-conformance';
    const inner = new FakeBodyBrainSession(adapterId, 'session-conformance', 'generation-A', source);
    const state: HookState = { inner, snapshotEvents: 0, pageEvents: 0, command: 0 };
    const inject = (count: number): void => {
      for (let index = 0; index < count; index++) inner.requestCancel({
        generation: inner.generation, commandId: `observation-event-${++state.command}`,
      });
    };
    const session = new Proxy(inner, {
      get(target, property) {
        if (property === 'snapshot') return () => {
          const count = state.snapshotEvents; state.snapshotEvents = 0; inject(count); return target.snapshot();
        };
        if (property === 'page') return (request?: Parameters<BodyBrainSession['page']>[0]) => {
          const count = state.pageEvents; state.pageEvents = 0; inject(count); return target.page(request);
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BodyBrainSession;

    const corrupt = (
      scenario: BodyBrainCorruptionScenario, compatible: unknown,
    ): unknown => {
      const record = compatible as BodyBrainRecoveryRecord;
      if (scenario === 'reference_missing') return undefined;
      if (scenario === 'adapter_incompatible') return { ...record, adapterId: 'other-adapter' };
      if (scenario === 'protocol_mismatch') return { ...record, protocolVersion: 2 };
      if (scenario === 'corrupt_recovery') return { ...record, committedSeq: record.committedSeq + 1 };
      const terminal = new FakeBodyBrainSession(
        adapterId, `session-${scenario}`, inner.generation, source,
      );
      if (scenario === 'agent_exited') terminal.forceTerminate({
        generation: terminal.generation, commandId: 'terminal-force',
      });
      else terminal.retire({ generation: terminal.generation, commandId: 'terminal-retire' });
      return terminal.recoveryRecord();
    };

    return {
      session,
      driver: {
        async complete(target, promptId, outcome) {
          const fake = target === session ? inner : target as FakeBodyBrainSession;
          const result = fake.scriptCompletion(target.generation, promptId, outcome);
          if (result.state !== 'terminal') throw new Error(`fake completion failed: ${result.state}`);
        },
        async requestPermission(target, promptId, optionIds) {
          const fake = target === session ? inner : target as FakeBodyBrainSession;
          if (!fake.scriptPermission(target.generation, promptId, optionIds))
            throw new Error('fake permission request failed');
        },
        async armObservationEvents(target, boundary, count) {
          if (target !== session) throw new Error('unknown conformance session');
          if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid observation event count');
          if (boundary === 'snapshot') state.snapshotEvents = count;
          else state.pageEvents = count;
        },
        async waitFor(observation, ready) {
          for (let attempt = 0; attempt < 32; attempt++) {
            const value = await observation();
            if (ready(value)) return value;
            await Promise.resolve();
          }
          throw new Error('bounded conformance wait exhausted');
        },
      },
      async observe<T>(operation: () => T): Promise<T> { return operation(); },
      async recovery(target): Promise<unknown> {
        return target === session ? inner.recoveryRecord() : target.recoveryRecord();
      },
      async restore(record): Promise<BodyBrainRestoreResult> {
        return new FakeBodyBrainSessionRestorer(adapterId, source).restore(record);
      },
      async corrupt(scenario, record): Promise<unknown> { return corrupt(scenario, record); },
      async cleanup(): Promise<void> { cleanupCount++; },
    };
  },
};

defineBodyBrainConformance('deterministic fake', factory);

it('cleans a started fixture when mandatory hook validation fails', async () => {
  let malformedCleanup = 0;
  const malformedFactory = {
    async start() {
      return {
        session: {} as BodyBrainSession,
        driver: {},
        cleanup: async () => { malformedCleanup++; },
      } as unknown as BodyBrainConformanceFixture;
    },
  };
  await expect(withBodyBrainConformanceFixture(malformedFactory, async () => {}))
    .rejects.toThrow(/required conformance fixture hook missing/u);
  expect(malformedCleanup).toBe(1);
});

afterAll(() => {
  // The normative matrix currently registers sixteen isolated cases. This is
  // deliberately exact so adding a case without fresh cleanup fails this wrapper.
  expect(cleanupCount).toBe(16);
});
