import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeBodyBrainSession, FakeBodyBrainSessionRestorer } from '../src/session/fake-body-brain.js';
import type { BodyBrainDeterminism } from '../src/session/body-brain.js';
import {
  AcpBodyBrainAdmissionReducer, AcpBodyBrainOutboxPump,
  createAcpBodyBrainRecoveryEnvelope, replayableAcpBodyBrainOutbox,
  restoreAcpBodyBrainSession,
  startAcpBodyBrainSession, startAcpBodyBrainTransport, type AcpBodyBrainSessionEngineFactory,
  transitionAcpBodyBrainOutbox, validateAcpBodyBrainRecoveryEnvelope, type AcpBodyBrainOutboxEntry,
  uncertainAcpBodyBrainOutbox,
} from '../src/session/acp-body-brain-session.js';
import {
  AcpBodyBrainTransportBoundary, type AcpBodyBrainProvider, type AcpLifecycleResult,
} from '../src/session/acp-body-brain-transport.js';

const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function determinism(): BodyBrainDeterminism {
  let id = 0; let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 7, 26, 0, 0, tick++)).toISOString(), nextId: kind => `${kind}-${++id}` };
}
function restoreDeterminism(): BodyBrainDeterminism {
  let id = 100;
  return { now: () => '2026-08-27T00:00:00.000Z', nextId: kind => `${kind}-${++id}` };
}
function bodyBrain() {
  return new FakeBodyBrainSession('adapter', 'session-1', 'generation-1', determinism()).recoveryRecord();
}
const submit = (phase: AcpBodyBrainOutboxEntry['phase'], result?: AcpBodyBrainOutboxEntry['result']): AcpBodyBrainOutboxEntry => ({
  operation: 'submit', commandId: `submit-${phase}`, generation: 'generation-1', requestHash: digest(`request-${phase}`),
  phase, ...(result === undefined ? {} : { result }), promptId: 'prompt-1',
  origin: { kind: 'owner', requestId: 'request-1' }, body: { digest: digest('body'), bytes: 4 },
});
function envelope(outbox: readonly AcpBodyBrainOutboxEntry[] = []) {
  return createAcpBodyBrainRecoveryEnvelope({
    adapterId: 'adapter', planDigest: digest('plan'), generation: 'generation-1', sessionRef: 'session-1',
    sessionMetadata: { schemaVersion: 1, token: 'opaque-secret-token', digest: digest('metadata') },
    bodyBrain: bodyBrain(), permissionBindings: [], outbox,
  });
}

function provider(
  start: () => Promise<AcpLifecycleResult>, events: string[],
  submit: AcpBodyBrainProvider['submit'] = async () => ({ state: 'accepted' }),
  capture?: (listener: (notification: unknown) => void) => void,
  restore: AcpBodyBrainProvider['restore'] = async () => ({ state: 'failed', code: 'adapter_rejected' }),
  controls: Partial<Pick<AcpBodyBrainProvider, 'respondPermission' | 'cancel' | 'forceTerminate' | 'close' | 'retire'>> = {},
): AcpBodyBrainProvider {
  return {
    subscribe: listener => { events.push('subscribe'); capture?.(listener); return () => { events.push('unsubscribe'); }; },
    start,
    restore,
    submit,
    respondPermission: controls.respondPermission ?? (async () => ({ state: 'accepted' })),
    cancel: controls.cancel ?? (async () => ({ state: 'accepted' })),
    forceTerminate: controls.forceTerminate ?? (async () => ({ state: 'accepted' })),
    close: controls.close ?? (async () => ({ state: 'accepted' })),
    retire: controls.retire ?? (async () => ({ state: 'accepted' })),
    cleanup: async () => { events.push('cleanup'); },
  };
}
function transport(
  start: () => Promise<AcpLifecycleResult>, events: string[], submit?: AcpBodyBrainProvider['submit'],
  capture?: (listener: (notification: unknown) => void) => void,
  restore?: AcpBodyBrainProvider['restore'],
  controls?: Partial<Pick<AcpBodyBrainProvider, 'respondPermission' | 'cancel' | 'forceTerminate' | 'close' | 'retire'>>,
) {
  return new AcpBodyBrainTransportBoundary('adapter', provider(start, events, submit, capture, restore, controls), {
    resolve: async reference => new Uint8Array(reference.bytes),
  });
}
const startRequest = { protocolVersion: 1 as const, generation: 'generation-1', planDigest: digest('plan') };

function engineFactory(hooks: { onStart?: () => void; onBind?: (session: import('../src/session/body-brain.js').BodyBrainSession) => void;
  onComplete?: () => void } = {}): AcpBodyBrainSessionEngineFactory {
  const driver = {
    complete(session: import('../src/session/body-brain.js').BodyBrainSession, promptId: string,
      outcome: import('../src/session/body-brain.js').BodyBrainTurnOutcome,
      output?: Readonly<{ digest: string; bytes: number }>, reasonCode?: string) {
      hooks.onComplete?.();
      return (session as FakeBodyBrainSession).scriptCompletion(session.generation, promptId, outcome,
        output ? { ...output } : undefined, reasonCode);
    },
    requestPermission(session: import('../src/session/body-brain.js').BodyBrainSession,
      promptId: string, optionIds: readonly string[]) {
      return (session as FakeBodyBrainSession).scriptPermission(session.generation, promptId, optionIds);
    },
  };
  return {
    start: input => { hooks.onStart?.(); return {
      session: new FakeBodyBrainSession(input.adapterId, 'session-1', input.generation, determinism()), driver,
    }; },
    bindRestored: session => { hooks.onBind?.(session); return driver; },
  };
}

describe('ACP BodyBrain async start factory', () => {
  it('transfers a successful launch into one idempotent cleanup owner', async () => {
    const events: string[] = [];
    const result = await startAcpBodyBrainTransport(transport(async () => {
      events.push('start');
      return { state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest: digest('metadata') } };
    }, events), startRequest);
    expect(result.state).toBe('accepted');
    if (result.state !== 'accepted') return;
    expect(events).toEqual(['subscribe', 'start']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.started)).toBe(true);
    expect(Object.isFrozen(result.started.sessionMetadata)).toBe(true);
    await Promise.all([result.started.cleanup(), result.started.cleanup()]);
    expect(events).toEqual(['subscribe', 'start', 'unsubscribe', 'cleanup']);
  });

  it('unwinds subscription and provider after a typed start rejection', async () => {
    const events: string[] = [];
    const result = await startAcpBodyBrainTransport(transport(async () => {
      events.push('start'); return { state: 'failed', code: 'adapter_rejected' };
    }, events), startRequest);
    expect(result).toEqual({ state: 'failed', code: 'adapter_rejected' });
    expect(events).toEqual(['subscribe', 'start', 'unsubscribe', 'cleanup']);
  });

  it('redacts a throwing start and still performs full cleanup', async () => {
    const events: string[] = [];
    const result = await startAcpBodyBrainTransport(transport(async () => {
      events.push('start'); throw new Error('provider secret');
    }, events), startRequest);
    expect(result).toEqual({ state: 'failed', code: 'adapter_unavailable' });
    expect(events).toEqual(['subscribe', 'start', 'unsubscribe', 'cleanup']);
  });

  it('builds and delegates admission to the injected shared engine', async () => {
    const events: string[] = []; let starts = 0;
    const result = await startAcpBodyBrainSession(transport(async () => ({
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest: digest('metadata') },
    }), events), startRequest, engineFactory({ onStart: () => { starts++; } }));
    expect(result.state).toBe('started');
    if (result.state !== 'started') return;
    const admitted = result.reducer.admitPrompt(promptRequest('engine-command'));
    expect(starts).toBe(1);
    expect(admitted.state).toBe('accepted');
    expect(result.reducer.adapterSnapshot().bodyBrain.admissions).toHaveLength(1);
    await result.reducer.cleanup();
  });
});

async function admissionReducer(
  events: string[], submit?: AcpBodyBrainProvider['submit'],
  capture?: (listener: (notification: unknown) => void) => void,
  controls?: Partial<Pick<AcpBodyBrainProvider, 'respondPermission' | 'cancel' | 'forceTerminate' | 'close' | 'retire'>>,
) {
  const launched = await startAcpBodyBrainSession(transport(async () => ({
    state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest: digest('metadata') },
  }), events, submit, capture, undefined, controls), startRequest, engineFactory());
  if (launched.state !== 'started') throw new Error('test launch failed');
  return launched.reducer;
}
const promptRequest = (commandId: string) => ({
  generation: 'generation-1', commandId, body: { digest: digest(''), bytes: 0 },
  origin: { kind: 'owner' as const, requestId: `request-${commandId}` },
});

describe('ACP BodyBrain synchronous local admission reducer', () => {
  it('returns an immutable durable receipt before provider acceptance', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let invoked!: () => void;
    const providerInvoked = new Promise<void>(resolve => { invoked = resolve; });
    let reducer!: AcpBodyBrainAdmissionReducer;
    reducer = await admissionReducer(events, async request => {
      expect(reducer.adapterSnapshot().outbox.find(entry => entry.commandId === request.commandId)?.phase).toBe('in_flight');
      events.push('submit'); invoked(); await gate; return { state: 'accepted' };
    });
    const admitted = reducer.admitPrompt(promptRequest('command-1'));
    expect(admitted.state).toBe('accepted');
    if (admitted.state !== 'accepted') return;
    expect(Object.isFrozen(admitted.receipt)).toBe(true);
    expect(reducer.adapterSnapshot()).toMatchObject({
      activePromptId: admitted.receipt.promptId,
      outbox: [{ commandId: 'command-1', phase: 'pending' }],
    });
    await providerInvoked;
    expect(events).toContain('submit');
    expect(reducer.awaitCompletion('generation-1', admitted.receipt.promptId)).toEqual({ state: 'not_terminal' });
    release(); await reducer.settled();
    expect(reducer.adapterSnapshot().outbox[0]).toMatchObject({ phase: 'accepted', result: 'accepted' });
    expect(reducer.admitPrompt(promptRequest('command-1'))).toEqual(admitted);
    await reducer.cleanup();
  });

  it('fails a rejected active prompt and promotes the queue without changing receipts', async () => {
    const events: string[] = [];
    const reducer = await admissionReducer(events, async request => request.commandId === 'command-1'
      ? { state: 'failed', code: 'adapter_rejected' }
      : { state: 'accepted' });
    const first = reducer.admitPrompt(promptRequest('command-1'));
    const second = reducer.admitPrompt(promptRequest('command-2'));
    expect(first.state === 'accepted' && first.receipt.state).toBe('started');
    expect(second.state === 'accepted' && second.receipt).toMatchObject({ state: 'queued', queuedBehind: 1 });
    await reducer.settled();
    if (first.state !== 'accepted' || second.state !== 'accepted') return;
    expect(reducer.awaitCompletion('generation-1', first.receipt.promptId)).toMatchObject({
      state: 'terminal', completion: { outcome: 'failed', reasonCode: 'adapter_rejected' },
    });
    expect(reducer.snapshot()).toMatchObject({ activePromptId: second.receipt.promptId });
    expect(reducer.admitPrompt(promptRequest('command-2'))).toEqual(second);
    await reducer.cleanup();
  });

  it('redacts an active provider throw, fails it once, and promotes queued work', async () => {
    const events: string[] = [];
    const reducer = await admissionReducer(events, async request => {
      if (request.commandId === 'command-1') throw new Error('provider secret');
      return { state: 'accepted' };
    });
    const first = reducer.admitPrompt(promptRequest('command-1'));
    const second = reducer.admitPrompt(promptRequest('command-2'));
    await reducer.settled();
    if (first.state !== 'accepted' || second.state !== 'accepted') return;
    expect(reducer.awaitCompletion('generation-1', first.receipt.promptId)).toMatchObject({
      state: 'terminal', completion: { outcome: 'failed', reasonCode: 'adapter_unavailable' },
    });
    expect(reducer.snapshot()).toMatchObject({ activePromptId: second.receipt.promptId });
    expect(JSON.stringify(reducer.snapshot())).not.toContain('provider secret');
    await reducer.cleanup();
  });

  it('fences a late throwing continuation after cleanup', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reducer = await admissionReducer(events, async () => { await gate; throw new Error('provider secret'); });
    const admitted = reducer.admitPrompt(promptRequest('command-1'));
    await Promise.resolve();
    const cleanup = reducer.cleanup();
    release(); await cleanup;
    if (admitted.state !== 'accepted') return;
    expect(reducer.awaitCompletion('generation-1', admitted.receipt.promptId)).toEqual({ state: 'not_terminal' });
    expect(reducer.snapshot()).toHaveProperty('activePromptId', admitted.receipt.promptId);
    expect(reducer.admitPrompt(promptRequest('command-2'))).toEqual({ state: 'closed' });
  });

  it('reconciles accepted completion evidence and promotes queued work exactly once', async () => {
    const events: string[] = [];
    let emit!: (notification: unknown) => void;
    const reducer = await admissionReducer(events, undefined, listener => { emit = listener; });
    const first = reducer.admitPrompt(promptRequest('command-1'));
    const second = reducer.admitPrompt(promptRequest('command-2'));
    await reducer.settled();
    if (first.state !== 'accepted' || second.state !== 'accepted') return;
    const notification = {
      protocolVersion: 1, generation: 'generation-1', transportSeq: 1, notificationId: 'completion-1',
      kind: 'completed', promptId: first.receipt.promptId, outcome: 'completed',
    };
    emit(notification); await reducer.settled();
    expect(reducer.awaitCompletion('generation-1', first.receipt.promptId)).toMatchObject({
      state: 'terminal', completion: { outcome: 'completed' },
    });
    expect(reducer.snapshot()).toMatchObject({ activePromptId: second.receipt.promptId });
    emit(notification); await reducer.settled();
    expect(reducer.adapterSnapshot()).toMatchObject({ activePromptId: second.receipt.promptId, queuedPromptIds: [] });
    expect(reducer.admitPrompt(promptRequest('command-2'))).toEqual(second);
    await reducer.cleanup();
  });

  it('ignores wrong generation and wrong prompt completion evidence', async () => {
    const events: string[] = [];
    let emit!: (notification: unknown) => void;
    const reducer = await admissionReducer(events, undefined, listener => { emit = listener; });
    const admitted = reducer.admitPrompt(promptRequest('command-1'));
    await reducer.settled();
    if (admitted.state !== 'accepted') return;
    emit({ protocolVersion: 1, generation: 'other-generation', transportSeq: 1,
      notificationId: 'wrong-generation', kind: 'completed', promptId: admitted.receipt.promptId, outcome: 'completed' });
    emit({ protocolVersion: 1, generation: 'generation-1', transportSeq: 1,
      notificationId: 'wrong-prompt', kind: 'completed', promptId: 'other-prompt', outcome: 'completed' });
    await reducer.settled();
    expect(reducer.awaitCompletion('generation-1', admitted.receipt.promptId)).toEqual({ state: 'not_terminal' });
    expect(reducer.snapshot()).toMatchObject({ activePromptId: admitted.receipt.promptId });
    await reducer.cleanup();
  });

  it('ignores provider delivery after cleanup', async () => {
    const events: string[] = [];
    let emit!: (notification: unknown) => void;
    const reducer = await admissionReducer(events, undefined, listener => { emit = listener; });
    const admitted = reducer.admitPrompt(promptRequest('command-1'));
    await reducer.settled();
    await reducer.cleanup();
    if (admitted.state !== 'accepted') return;
    emit({ protocolVersion: 1, generation: 'generation-1', transportSeq: 1,
      notificationId: 'late', kind: 'completed', promptId: admitted.receipt.promptId, outcome: 'completed' });
    await reducer.settled();
    expect(reducer.awaitCompletion('generation-1', admitted.receipt.promptId)).toEqual({ state: 'not_terminal' });
    expect(reducer.snapshot()).toHaveProperty('activePromptId', admitted.receipt.promptId);
  });

  it('delegates permission/cancel/force/retire synchronously and serializes provider controls', async () => {
    const events: string[] = []; let emit!: (notification: unknown) => void;
    const invoked: string[] = []; let reducer!: AcpBodyBrainAdmissionReducer;
    const controls = Object.fromEntries(([
      ['respondPermission', 'permission'], ['cancel', 'cancel'], ['forceTerminate', 'force'], ['retire', 'retire'],
    ] as const).map(([method, operation]) => [method, async (request: { commandId: string }) => {
      expect(reducer.adapterSnapshot().outbox.find(entry => entry.commandId === request.commandId)?.phase).toBe('in_flight');
      if (operation === 'permission') expect((request as { permissionId?: string }).permissionId).toBe('provider-permission');
      invoked.push(operation); return { state: 'accepted' as const };
    }])) as Partial<Pick<AcpBodyBrainProvider, 'respondPermission' | 'cancel' | 'forceTerminate' | 'retire'>>;
    reducer = await admissionReducer(events, undefined, listener => { emit = listener; }, controls);
    const admitted = reducer.admitPrompt(promptRequest('command-1'));
    await reducer.settled();
    if (admitted.state !== 'accepted') return;
    emit({ protocolVersion: 1, generation: 'generation-1', transportSeq: 1, notificationId: 'permission-1',
      kind: 'permission_requested', promptId: admitted.receipt.promptId, permissionId: 'provider-permission',
      optionIds: ['allow', 'deny'] });
    await reducer.settled();
    const permissionId = reducer.snapshot().activePermissionIds[0]!;
    const permission = { generation: 'generation-1', commandId: 'permission-command', permissionId, optionId: 'allow' };
    expect(reducer.respondPermission(permission)).toEqual({ state: 'accepted', optionId: 'allow' });
    expect(reducer.respondPermission(permission)).toEqual({ state: 'accepted', optionId: 'allow' });
    expect(reducer.respondPermission({ ...permission, optionId: 'deny' })).toEqual({ state: 'idempotency_conflict' });
    const cancel = { generation: 'generation-1', commandId: 'cancel-command' };
    expect(reducer.requestCancel(cancel).state).toBe('accepted');
    expect(reducer.requestCancel(cancel).state).toBe('accepted');
    expect(reducer.awaitCompletion('generation-1', admitted.receipt.promptId)).toEqual({ state: 'not_terminal' });
    const force = { generation: 'generation-1', commandId: 'force-command' };
    expect(reducer.forceTerminate(force).state).toBe('accepted');
    expect(reducer.close({ generation: 'generation-1', commandId: 'blocked-close' })).toEqual({ state: 'terminated' });
    const retire = { generation: 'generation-1', commandId: 'retire-command' };
    expect(reducer.retire(retire).state).toBe('accepted');
    await reducer.settled();
    expect(invoked).toEqual(['permission', 'cancel', 'force', 'retire']);
    expect(reducer.adapterSnapshot().outbox.filter(entry => entry.operation !== 'submit')).toHaveLength(4);
    expect(reducer.recoveryEnvelope().outbox.map(entry => entry.operation))
      .toEqual(['submit', 'permission', 'cancel', 'force', 'retire']);
    await reducer.cleanup();
  });

  it('delegates close/subscription/recovery and fences conflicts without duplicate outbox entries', async () => {
    const events: string[] = []; const canonicalEvents: string[] = [];
    const reducer = await admissionReducer(events);
    const unsubscribe = reducer.subscribe(event => { canonicalEvents.push(event.kind); });
    const close = { generation: 'generation-1', commandId: 'close-command' };
    expect(reducer.close(close).state).toBe('accepted');
    expect(reducer.close(close).state).toBe('accepted');
    expect(reducer.close({ ...close, generation: 'other-generation' }).state).toBe('idempotency_conflict');
    expect(reducer.admitPrompt(promptRequest('after-close'))).toEqual({ state: 'closed' });
    await reducer.settled();
    expect(canonicalEvents).toEqual(['closed']);
    expect(reducer.page().state).toBe('ok');
    expect(reducer.recoveryRecord().state).toBe('closed');
    expect(reducer.adapterSnapshot().outbox.filter(entry => entry.operation === 'close')).toHaveLength(1);
    unsubscribe(); await reducer.cleanup();
  });

  it('retains immediate canonical control semantics across provider reject and throw', async () => {
    for (const operation of ['permission', 'cancel', 'force', 'close', 'retire'] as const) {
      for (const mode of ['reject', 'throw'] as const) {
        const events: string[] = []; let emit!: (notification: unknown) => void;
        const invoke = async () => {
          if (mode === 'throw') throw new Error('provider secret');
          return { state: 'failed' as const, code: 'adapter_rejected' as const };
        };
        const controls: Partial<Pick<AcpBodyBrainProvider,
          'respondPermission' | 'cancel' | 'forceTerminate' | 'close' | 'retire'>> = operation === 'permission'
          ? { respondPermission: invoke } : operation === 'cancel' ? { cancel: invoke }
          : operation === 'force' ? { forceTerminate: invoke } : operation === 'close' ? { close: invoke }
          : { retire: invoke };
        const reducer = await admissionReducer(events, undefined, listener => { emit = listener; }, controls);
        const admitted = reducer.admitPrompt(promptRequest(`prompt-${operation}-${mode}`));
        await reducer.settled();
        if (admitted.state !== 'accepted') continue;
        let commandId = `${operation}-${mode}`;
        if (operation === 'permission') {
          emit({ protocolVersion: 1, generation: 'generation-1', transportSeq: 1, notificationId: `notice-${mode}`,
            kind: 'permission_requested', promptId: admitted.receipt.promptId,
            permissionId: `provider-permission-${mode}`, optionIds: ['allow'] });
          await reducer.settled();
          const permissionId = reducer.snapshot().activePermissionIds[0]!;
          expect(reducer.respondPermission({ generation: 'generation-1', commandId, permissionId, optionId: 'allow' }).state)
            .toBe('accepted');
        } else {
          const request = { generation: 'generation-1', commandId };
          const result = operation === 'cancel' ? reducer.requestCancel(request)
            : operation === 'force' ? reducer.forceTerminate(request)
            : operation === 'close' ? reducer.close(request) : reducer.retire(request);
          expect(result.state).toBe('accepted');
        }
        const immediate = reducer.recoveryRecord();
        await reducer.settled();
        expect(reducer.recoveryRecord()).toEqual(immediate);
        expect(reducer.adapterSnapshot().outbox.find(entry => entry.commandId === commandId)).toMatchObject({
          phase: 'rejected', result: mode === 'throw' ? 'adapter_unavailable' : 'adapter_rejected',
        });
        expect(JSON.stringify(reducer.recoveryEnvelope())).not.toContain('provider secret');
        await reducer.cleanup();
      }
    }
  });

  it('fences every provider control continuation when cleanup begins during its await', async () => {
    for (const operation of ['permission', 'cancel', 'force', 'close', 'retire'] as const) {
      const events: string[] = []; let emit!: (notification: unknown) => void;
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      let invoked!: () => void; const began = new Promise<void>(resolve => { invoked = resolve; });
      const wait = async () => { invoked(); await gate; return { state: 'accepted' as const }; };
      const controls: Partial<Pick<AcpBodyBrainProvider,
        'respondPermission' | 'cancel' | 'forceTerminate' | 'close' | 'retire'>> = operation === 'permission'
          ? { respondPermission: wait } : operation === 'cancel' ? { cancel: wait }
          : operation === 'force' ? { forceTerminate: wait } : operation === 'close' ? { close: wait }
          : { retire: wait };
      const reducer = await admissionReducer(events, undefined, listener => { emit = listener; }, controls);
      const admitted = reducer.admitPrompt(promptRequest(`cleanup-${operation}`));
      await reducer.settled();
      if (admitted.state !== 'accepted') continue;
      const commandId = `cleanup-control-${operation}`;
      if (operation === 'permission') {
        emit({ protocolVersion: 1, generation: 'generation-1', transportSeq: 1, notificationId: 'permission-cleanup',
          kind: 'permission_requested', promptId: admitted.receipt.promptId,
          permissionId: 'provider-permission-cleanup', optionIds: ['allow'] });
        await reducer.settled();
        reducer.respondPermission({ generation: 'generation-1', commandId,
          permissionId: reducer.snapshot().activePermissionIds[0]!, optionId: 'allow' });
      } else {
        const request = { generation: 'generation-1', commandId };
        if (operation === 'cancel') reducer.requestCancel(request);
        else if (operation === 'force') reducer.forceTerminate(request);
        else if (operation === 'close') reducer.close(request);
        else reducer.retire(request);
      }
      await began;
      expect(reducer.adapterSnapshot().outbox.find(entry => entry.commandId === commandId)?.phase).toBe('in_flight');
      const cleanup = reducer.cleanup();
      release(); await cleanup;
      expect(reducer.adapterSnapshot().outbox.find(entry => entry.commandId === commandId)?.phase).toBe('in_flight');
    }
  });
});

function restoreFixture(phase: AcpBodyBrainOutboxEntry['phase'] = 'pending') {
  const core = new FakeBodyBrainSession('adapter', 'session-1', 'generation-1', determinism());
  const admitted = core.admitPrompt(promptRequest('command-restore'));
  if (admitted.state !== 'accepted') throw new Error('fixture admission failed');
  const entry: AcpBodyBrainOutboxEntry = {
    operation: 'submit', commandId: 'command-restore', generation: 'generation-1',
    requestHash: core.recoveryRecord().admissions[0].requestHash, phase, ...(phase === 'accepted' ? { result: 'accepted' as const } : {}),
    promptId: admitted.receipt.promptId, origin: promptRequest('command-restore').origin,
    body: promptRequest('command-restore').body,
  };
  const restoredCore = core.recoveryRecord();
  return createAcpBodyBrainRecoveryEnvelope({
    adapterId: 'adapter', planDigest: digest('plan'), generation: 'generation-1', sessionRef: 'session-1',
    sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest: digest('metadata') },
    bodyBrain: restoredCore, permissionBindings: [], outbox: [entry],
  });
}

function controlRestoreFixture(
  operation: 'permission' | 'cancel' | 'force' | 'close' | 'retire',
  phase: 'pending' | 'in_flight',
) {
  const core = new FakeBodyBrainSession('adapter', 'session-1', 'generation-1', determinism());
  const request = promptRequest(`prompt-for-${operation}`);
  const admitted = core.admitPrompt(request);
  if (admitted.state !== 'accepted') throw new Error('fixture admission failed');
  const outbox: AcpBodyBrainOutboxEntry[] = [{
    operation: 'submit', commandId: request.commandId, generation: 'generation-1',
    requestHash: core.recoveryRecord().admissions[0].requestHash, phase: 'accepted', result: 'accepted',
    promptId: admitted.receipt.promptId, origin: request.origin, body: request.body,
  }];
  const permissionBindings: Array<{ permissionId: string; providerPermissionId: string; promptId: string }> = [];
  if (operation === 'permission') {
    const permissionId = core.scriptPermission('generation-1', admitted.receipt.promptId, ['allow']);
    if (!permissionId) throw new Error('fixture permission failed');
    const response = { generation: 'generation-1', commandId: 'control-permission', permissionId, optionId: 'allow' };
    if (core.respondPermission(response).state !== 'accepted') throw new Error('fixture permission response failed');
    permissionBindings.push({ permissionId, providerPermissionId: 'provider-permission', promptId: admitted.receipt.promptId });
    outbox.push({ operation, commandId: response.commandId, generation: 'generation-1', requestHash: digest('control'),
      phase, permissionId, providerPermissionId: 'provider-permission', optionId: 'allow' });
  } else {
    const mutation = { generation: 'generation-1', commandId: `control-${operation}` };
    const result = operation === 'cancel' ? core.requestCancel(mutation)
      : operation === 'force' ? core.forceTerminate(mutation)
      : operation === 'close' ? core.close(mutation) : core.retire(mutation);
    if (result.state !== 'accepted') throw new Error(`fixture ${operation} failed`);
    outbox.push({ operation, ...mutation, requestHash: digest('control'), phase });
  }
  return createAcpBodyBrainRecoveryEnvelope({
    adapterId: 'adapter', planDigest: digest('plan'), generation: 'generation-1', sessionRef: 'session-1',
    sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest: digest('metadata') },
    bodyBrain: core.recoveryRecord(), permissionBindings, outbox,
  });
}

describe('ACP BodyBrain async restore factory', () => {
  it('rejects tampering before any transport action', async () => {
    const events: string[] = [];
    const value = restoreFixture();
    const result = await restoreAcpBodyBrainSession(
      transport(async () => ({ state: 'failed', code: 'adapter_rejected' }), events),
      { ...value, planDigest: digest('tampered') }, new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory(),
    );
    expect(result).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(events).toEqual([]);
  });

  it('rejects valid-integrity outbox/body-brain binding tampering before transport', async () => {
    const events: string[] = [];
    const value = restoreFixture();
    const rebound = createAcpBodyBrainRecoveryEnvelope({
      adapterId: value.adapterId, planDigest: value.planDigest, generation: value.generation,
      sessionRef: value.sessionRef, sessionMetadata: value.sessionMetadata, bodyBrain: value.bodyBrain,
      permissionBindings: value.permissionBindings,
      outbox: [{ ...value.outbox[0], promptId: 'different-prompt' } as AcpBodyBrainOutboxEntry],
    });
    const result = await restoreAcpBodyBrainSession(
      transport(async () => ({ state: 'failed', code: 'adapter_rejected' }), events), rebound,
      new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory(),
    );
    expect(result).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(events).toEqual([]);
  });

  it('rejects valid-integrity impossible permission and control bindings before transport', async () => {
    for (const operation of ['permission', 'cancel', 'force', 'close', 'retire'] as const) {
      const events: string[] = [];
      const value = controlRestoreFixture(operation, 'pending');
      const control = value.outbox.find(entry => entry.operation === operation)!;
      const malformed = createAcpBodyBrainRecoveryEnvelope({
        adapterId: value.adapterId, planDigest: value.planDigest, generation: value.generation,
        sessionRef: value.sessionRef, sessionMetadata: value.sessionMetadata, bodyBrain: value.bodyBrain,
        permissionBindings: value.permissionBindings,
        outbox: value.outbox.map(entry => entry === control ? { ...entry,
          ...(operation === 'permission' ? { optionId: 'unrecorded-option' } : { commandId: `unrecorded-${operation}` }),
        } as AcpBodyBrainOutboxEntry : entry),
      });
      const result = await restoreAcpBodyBrainSession(
        transport(async () => ({ state: 'failed', code: 'adapter_rejected' }), events), malformed,
        new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory(),
      );
      expect(result).toEqual({ state: 'failed', code: 'corrupt_recovery' });
      expect(events).toEqual([]);
    }
  });

  it('requires exact no-rotation metadata and cleans a mismatch', async () => {
    const events: string[] = [];
    const result = await restoreAcpBodyBrainSession(transport(async () => ({ state: 'failed', code: 'adapter_rejected' }),
      events, undefined, undefined, async () => ({
        state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'rotated', digest: digest('rotated') },
      })), restoreFixture(), new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory());
    expect(result).toEqual({ state: 'failed', code: 'resume_rejected' });
    expect(events).toEqual(['subscribe', 'unsubscribe', 'cleanup']);
  });

  it('closes typed failures from throwing validators, presentation, and restored-engine binding', async () => {
    const events: string[] = [];
    const throwingRestorer = { restore(): never { throw new Error('validator secret'); } };
    expect(await restoreAcpBodyBrainSession(
      transport(async () => ({ state: 'failed', code: 'adapter_rejected' }), events), restoreFixture(),
      throwingRestorer, engineFactory(),
    )).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(events).toEqual([]);

    const presentationEvents: string[] = [];
    const throwingPresentation = transport(async () => ({ state: 'failed', code: 'adapter_rejected' }), presentationEvents);
    throwingPresentation.presentation = () => { throw new Error('presentation secret'); };
    expect(await restoreAcpBodyBrainSession(throwingPresentation, restoreFixture(),
      new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory()))
      .toEqual({ state: 'failed', code: 'adapter_incompatible' });
    expect(presentationEvents).toEqual([]);

    const bindEvents: string[] = [];
    expect(await restoreAcpBodyBrainSession(transport(async () => ({ state: 'failed', code: 'adapter_rejected' }),
      bindEvents, undefined, undefined, async request => ({ state: 'accepted', sessionMetadata: request.sessionMetadata })),
    restoreFixture(), new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), {
      ...engineFactory(), bindRestored(): never { throw new Error('bind secret'); },
    })).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(bindEvents).toEqual(['subscribe', 'unsubscribe', 'cleanup']);
  });

  it('replays pending work after installation but never uncertain or accepted work', async () => {
    for (const [phase, expected] of [['pending', 1], ['in_flight', 0], ['accepted', 0]] as const) {
      const events: string[] = []; let submits = 0;
      const result = await restoreAcpBodyBrainSession(transport(async () => ({ state: 'failed', code: 'adapter_rejected' }),
        events, async () => { submits++; return { state: 'accepted' }; }, undefined, async request => ({
          state: 'accepted', sessionMetadata: request.sessionMetadata,
        })), restoreFixture(phase), new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory());
      expect(result.state).toBe('restored');
      if (result.state !== 'restored') continue;
      await result.reducer.settled();
      expect(submits).toBe(expected);
      await result.reducer.cleanup();
    }
  });

  it('replays every resumable pending control but never an in-flight ambiguous control', async () => {
    for (const operation of ['permission', 'cancel', 'close'] as const) {
      for (const [phase, expected] of [['pending', 1], ['in_flight', 0]] as const) {
        const events: string[] = []; let calls = 0;
        const controls = {
          respondPermission: async () => { calls++; return { state: 'accepted' as const }; },
          cancel: async () => { calls++; return { state: 'accepted' as const }; },
          forceTerminate: async () => { calls++; return { state: 'accepted' as const }; },
          close: async () => { calls++; return { state: 'accepted' as const }; },
          retire: async () => { calls++; return { state: 'accepted' as const }; },
        };
        const result = await restoreAcpBodyBrainSession(transport(
          async () => ({ state: 'failed', code: 'adapter_rejected' }), events, undefined, undefined,
          async request => ({ state: 'accepted', sessionMetadata: request.sessionMetadata }), controls,
        ), controlRestoreFixture(operation, phase), new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()),
        engineFactory());
        expect(result.state, `${operation}/${phase}`).toBe('restored');
        if (result.state !== 'restored') continue;
        await result.reducer.settled();
        expect(calls, `${operation}/${phase}`).toBe(expected);
        await result.reducer.cleanup();
      }
    }
  });

  it('makes recovery deterministic after launch without consulting live presentation', async () => {
    const events: string[] = [];
    const boundary = transport(async () => ({
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque-token', digest: digest('metadata') },
    }), events);
    const result = await startAcpBodyBrainSession(boundary, startRequest, engineFactory());
    expect(result.state).toBe('started');
    if (result.state !== 'started') return;
    boundary.presentation = () => { throw new Error('late provider dependency'); };
    expect(result.reducer.recoveryEnvelope()).toMatchObject({ adapterId: 'adapter', planDigest: digest('plan') });
    await result.reducer.cleanup();
  });

  it('installs state before reducing a synchronous restore notification exactly once', async () => {
    const events: string[] = []; let emit!: (notification: unknown) => void;
    const envelope = restoreFixture('accepted');
    const promptId = envelope.bodyBrain.activePromptId!;
    let boundSession: import('../src/session/body-brain.js').BodyBrainSession | undefined; let completions = 0;
    const result = await restoreAcpBodyBrainSession(transport(async () => ({ state: 'failed', code: 'adapter_rejected' }),
      events, undefined, listener => { emit = listener; }, async request => {
        emit({ protocolVersion: 1, generation: 'generation-1', transportSeq: 1, notificationId: 'sync-completion',
          kind: 'completed', promptId, outcome: 'completed' });
        return { state: 'accepted', sessionMetadata: request.sessionMetadata };
      }), envelope, new FakeBodyBrainSessionRestorer('adapter', restoreDeterminism()), engineFactory({
        onBind: session => { boundSession = session; }, onComplete: () => { completions++; },
      }));
    expect(result.state).toBe('restored');
    if (result.state !== 'restored') return;
    await Promise.resolve();
    await result.reducer.settled();
    expect(result.reducer.awaitCompletion('generation-1', promptId)).toMatchObject({
      state: 'terminal', completion: { outcome: 'completed' },
    });
    expect(boundSession).toBeDefined();
    expect(result.reducer.adapterSnapshot().bodyBrain.integrityDigest).toBe(boundSession!.recoveryRecord().integrityDigest);
    expect(completions).toBe(1);
    await result.reducer.cleanup();
  });
});

describe('ACP BodyBrain durable outbox recovery kernel', () => {
  it('creates an owned deeply frozen body-free integrity envelope', () => {
    const input = [submit('pending')];
    const value = envelope(input);
    (input[0] as { commandId: string }).commandId = 'mutated';
    expect(value.outbox[0].commandId).toBe('submit-pending');
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outbox)).toBe(true);
    expect(Object.isFrozen(value.outbox[0])).toBe(true);
    expect(JSON.stringify(value)).not.toContain('body":"');
    expect(value.integrityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('replays only work proven never invoked', () => {
    const value = envelope([
      submit('pending'), submit('in_flight'), submit('accepted', 'accepted'),
      { ...submit('rejected', 'adapter_rejected'), commandId: 'submit-rejected' },
    ]);
    expect(replayableAcpBodyBrainOutbox(value).map(entry => entry.commandId)).toEqual(['submit-pending']);
    expect(uncertainAcpBodyBrainOutbox(value).map(entry => entry.commandId)).toEqual(['submit-in_flight']);
  });

  it('classifies pending versus in-flight ambiguity for every control operation', () => {
    for (const operation of ['permission', 'cancel', 'force', 'close', 'retire'] as const) {
      const pending = controlRestoreFixture(operation, 'pending');
      const uncertain = controlRestoreFixture(operation, 'in_flight');
      expect(replayableAcpBodyBrainOutbox(pending).map(entry => entry.operation)).toContain(operation);
      expect(uncertainAcpBodyBrainOutbox(pending)).not.toContainEqual(expect.objectContaining({ operation }));
      expect(replayableAcpBodyBrainOutbox(uncertain)).not.toContainEqual(expect.objectContaining({ operation }));
      expect(uncertainAcpBodyBrainOutbox(uncertain).map(entry => entry.operation)).toContain(operation);
    }
  });

  it('rejects digest tampering and duplicate command identities', () => {
    const value = envelope([submit('pending')]);
    expect(validateAcpBodyBrainRecoveryEnvelope({ ...value, planDigest: digest('other') }))
      .toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(() => envelope([submit('pending'), submit('pending')])).toThrow('invalid ACP BodyBrain recovery envelope');
  });

  it('rejects impossible phase/result combinations', () => {
    for (const entry of [submit('pending', 'accepted'), submit('in_flight', 'adapter_rejected'),
      submit('accepted'), submit('rejected', 'accepted')])
      expect(() => envelope([entry])).toThrow('invalid ACP BodyBrain recovery envelope');
  });

  it('rejects generation/session mismatches and non-token correlations', () => {
    const value = envelope();
    expect(validateAcpBodyBrainRecoveryEnvelope({ ...value, generation: 'other' }))
      .toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(() => envelope([{ ...submit('pending'), commandId: 'bad/id' }])).toThrow();
  });

  it('supports every closed outbound operation without plaintext payloads', () => {
    const common = { generation: 'generation-1', phase: 'pending' as const };
    const entries: AcpBodyBrainOutboxEntry[] = [
      { ...common, operation: 'permission', commandId: 'permission-1', requestHash: digest('permission'),
        permissionId: 'p1', providerPermissionId: 'provider-p1', optionId: 'allow' },
      ...(['cancel', 'force', 'close', 'retire'] as const).map(operation => ({
        ...common, operation, commandId: `${operation}-1`, requestHash: digest(operation),
      })),
    ];
    expect(envelope(entries).outbox.map(entry => entry.operation)).toEqual(['permission', 'cancel', 'force', 'close', 'retire']);
  });
});

describe('ACP BodyBrain single outbox pump', () => {
  it('drains serialized work and returns to idle', async () => {
    const work = ['a', 'b', 'c']; const seen: string[] = [];
    const pump = new AcpBodyBrainOutboxPump(async () => {
      const next = work.shift(); if (!next) return false;
      seen.push(next); return work.length > 0;
    });
    pump.schedule(); await pump.settled();
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(pump.state).toBe('idle');
  });

  it('does not lose a wakeup admitted while the reducer is running', async () => {
    const work = ['first']; const seen: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const pump = new AcpBodyBrainOutboxPump(async () => {
      const next = work.shift(); if (!next) return false;
      if (next === 'first') await gate;
      seen.push(next); return work.length > 0;
    });
    pump.schedule(); await Promise.resolve();
    expect(pump.state).toBe('running');
    work.push('boundary-admission'); pump.schedule(); release();
    await pump.settled();
    expect(seen).toEqual(['first', 'boundary-admission']);
  });

  it('stops synchronously and suppresses late continuation mutation', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let mutations = 0;
    const pump = new AcpBodyBrainOutboxPump(async () => { await gate; mutations++; return true; });
    pump.schedule(); await Promise.resolve();
    const stopped = pump.stop();
    expect(pump.state).toBe('stopped');
    pump.schedule(); release(); await stopped;
    expect(pump.state).toBe('stopped');
    expect(mutations).toBe(1);
  });

  it('does not implicitly retry a dependency exception', async () => {
    let attempts = 0;
    const pump = new AcpBodyBrainOutboxPump(async () => { attempts++; throw new Error('secret dependency'); });
    pump.schedule(); await pump.settled();
    expect(attempts).toBe(1);
    expect(pump.state).toBe('idle');
  });
});

describe('ACP BodyBrain outbox phase reducer', () => {
  it('moves pending through in-flight to one terminal result immutably', () => {
    const initial = envelope([submit('pending')]).outbox;
    const invoked = transitionAcpBodyBrainOutbox(initial, 'submit-pending', 'invoke');
    expect(invoked.state).toBe('updated');
    if (invoked.state !== 'updated') return;
    expect(initial[0].phase).toBe('pending');
    expect(invoked.outbox[0]).toMatchObject({ phase: 'in_flight' });
    expect('result' in invoked.outbox[0]).toBe(false);
    const settled = transitionAcpBodyBrainOutbox(invoked.outbox, 'submit-pending', { settle: 'accepted' });
    expect(settled.state).toBe('updated');
    if (settled.state !== 'updated') return;
    expect(settled.outbox[0]).toMatchObject({ phase: 'accepted', result: 'accepted' });
    expect(Object.isFrozen(settled.outbox)).toBe(true);
    expect(Object.isFrozen(settled.outbox[0])).toBe(true);
    expect(transitionAcpBodyBrainOutbox(settled.outbox, 'submit-pending', { settle: 'accepted' }))
      .toEqual({ state: 'phase_conflict' });
  });

  it('records only closed rejection codes and fences unknown/wrong-phase commands', () => {
    const initial = envelope([submit('pending')]).outbox;
    expect(transitionAcpBodyBrainOutbox(initial, 'missing', 'invoke')).toEqual({ state: 'unknown_command' });
    expect(transitionAcpBodyBrainOutbox(initial, 'submit-pending', { settle: 'rejected', code: 'adapter_rejected' }))
      .toEqual({ state: 'phase_conflict' });
    const invoked = transitionAcpBodyBrainOutbox(initial, 'submit-pending', 'invoke');
    if (invoked.state !== 'updated') throw new Error('invoke required');
    const rejected = transitionAcpBodyBrainOutbox(invoked.outbox, 'submit-pending', { settle: 'rejected', code: 'adapter_rejected' });
    expect(rejected.state === 'updated' && rejected.outbox[0]).toMatchObject({ phase: 'rejected', result: 'adapter_rejected' });
  });
});
