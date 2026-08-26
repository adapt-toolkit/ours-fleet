import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  FakeBodyBrainSession, FakeBodyBrainSessionRestorer,
} from '../src/session/fake-body-brain.js';
import type {
  BodyBrainDeterminism, BodyBrainPromptRequest, BodyBrainRecoveryRecord,
} from '../src/session/body-brain.js';
import {
  BODY_BRAIN_MAX_ACTIVE_IDS, BODY_BRAIN_MAX_ADMISSIONS, BODY_BRAIN_MAX_COMMANDS, BODY_BRAIN_MAX_EVENTS,
} from '../src/session/body-brain.js';

const digest = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function resign<T extends { integrityDigest: string }>(value: T): T {
  const { integrityDigest: _old, ...unsigned } = value;
  return { ...value, integrityDigest: digest(canonical(unsigned)) };
}

function deterministic(): BodyBrainDeterminism {
  let tick = 0; let id = 0;
  return {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    nextId: kind => `${kind}-${++id}`,
  };
}
const prompt = (patch: Partial<BodyBrainPromptRequest> = {}): BodyBrainPromptRequest => ({
  generation: 'generation-A', commandId: 'command-1',
  body: { digest: digest('body'), bytes: 4 },
  origin: { kind: 'owner', requestId: 'owner-request-1' }, ...patch,
});

describe('BodyBrainSession deterministic conformance fake', () => {
  it('separates idempotent admission from terminal completion and orders the ledger', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', deterministic());
    const admitted = session.admitPrompt(prompt());
    expect(admitted.state).toBe('accepted');
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    expect(admitted.receipt).toMatchObject({ state: 'started', queuedBehind: 0, cursor: 'bb:1' });
    expect(session.admitPrompt(prompt())).toEqual(admitted);
    expect(session.admitPrompt(prompt({ body: { digest: digest('other'), bytes: 5 } }))).toEqual({
      state: 'idempotency_conflict',
    });
    expect(session.awaitCompletion('generation-A', admitted.receipt.promptId)).toEqual({ state: 'not_terminal' });
    expect(session.scriptCompletion('generation-A', admitted.receipt.promptId, 'completed', {
      digest: digest('answer'), bytes: 6,
    })).toMatchObject({ state: 'terminal', completion: { outcome: 'completed' } });
    expect(session.awaitCompletion('generation-A', admitted.receipt.promptId)).toMatchObject({
      state: 'terminal', completion: { outcome: 'completed' },
    });
    const page = session.page();
    expect(page.state).toBe('ok');
    if (page.state !== 'ok') throw new Error('expected page');
    expect(page.events.map(event => [event.seq, event.kind])).toEqual([
      [1, 'prompt_admitted'], [2, 'prompt_completed'],
    ]);
    expect(new Set(page.events.map(event => event.eventId)).size).toBe(2);
    const firstPage = session.page({ after: 'bb:0', limit: 1 });
    expect(firstPage).toMatchObject({ state: 'ok', nextCursor: 'bb:1', hasMore: true });
    const secondPage = session.page({ after: 'bb:1', limit: 1 });
    expect(secondPage).toMatchObject({ state: 'ok', nextCursor: 'bb:2', hasMore: false });
  });

  it('fences every mutation without events and fails closed on malformed/future cursors', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'Generation-A', deterministic());
    expect(session.admitPrompt(prompt({ generation: 'generation-a' }))).toEqual({ state: 'stale_generation' });
    expect(session.requestCancel({ generation: 'generation-a', commandId: 'cancel-1' })).toEqual({
      state: 'stale_generation',
    });
    expect(session.respondPermission({ generation: 'generation-a', commandId: 'p-1',
      permissionId: 'missing', optionId: 'yes' })).toEqual({ state: 'stale_generation' });
    expect(session.page()).toMatchObject({ state: 'ok', events: [] });
    expect(session.page({ after: 'bad' })).toEqual({ state: 'invalid_cursor', generation: 'Generation-A' });
    expect(session.page({ after: 'bb:99' })).toEqual({ state: 'invalid_cursor', generation: 'Generation-A' });
    expect(session.page({ limit: 0 })).toEqual({ state: 'invalid_cursor', generation: 'Generation-A' });
    expect(session.awaitCompletion('Generation-A', 'x'.repeat(300))).toEqual({ state: 'invalid_request' });
    expect(session.requestCancel({ generation: 'Generation-A', commandId: 'x'.repeat(300) })).toEqual({
      state: 'invalid_request',
    });
    const accessor = prompt({ generation: 'Generation-A' });
    Object.defineProperty(accessor, 'commandId', { enumerable: true, get: () => 'getter-command' });
    expect(session.admitPrompt(accessor)).toEqual({ state: 'invalid_request' });
    const inherited = Object.assign(Object.create({ generation: 'Generation-A' }), {
      commandId: 'inherited', body: { digest: digest('x'), bytes: 1 },
      origin: { kind: 'startup' },
    }) as BodyBrainPromptRequest;
    expect(session.admitPrompt(inherited)).toEqual({ state: 'invalid_request' });
    const symbol = prompt({ generation: 'Generation-A', commandId: 'symbol' }) as BodyBrainPromptRequest & Record<symbol, string>;
    symbol[Symbol('extra')] = 'forbidden';
    expect(session.admitPrompt(symbol)).toEqual({ state: 'invalid_request' });
    const hidden = prompt({ generation: 'Generation-A', commandId: 'hidden' });
    Object.defineProperty(hidden, 'extra', { value: true, enumerable: false });
    expect(session.admitPrompt(hidden)).toEqual({ state: 'invalid_request' });
  });

  it('correlates and idempotently settles permissions without duplicate events', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', deterministic());
    const admitted = session.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    const permissionId = session.scriptPermission(
      'generation-A', admitted.receipt.promptId, ['allow-once', 'deny'],
    )!;
    expect(session.scriptCompletion('generation-A', admitted.receipt.promptId, 'completed')).toEqual({
      state: 'dependency_violation',
    });
    const request = { generation: 'generation-A', commandId: 'permission-command-1',
      permissionId, optionId: 'allow-once' };
    expect(session.respondPermission({ ...request, commandId: 'invalid-option', optionId: 'later' })).toEqual({
      state: 'invalid_option',
    });
    expect(session.respondPermission({ ...request, commandId: 'unknown-permission', permissionId: 'missing' }))
      .toEqual({ state: 'unknown_permission' });
    expect(session.respondPermission(request)).toEqual({ state: 'accepted', optionId: 'allow-once' });
    expect(session.respondPermission(request)).toEqual({ state: 'accepted', optionId: 'allow-once' });
    expect(session.respondPermission({ ...request, optionId: 'deny' })).toEqual({ state: 'idempotency_conflict' });
    expect(session.respondPermission({ ...request, commandId: 'permission-command-2' })).toEqual({
      state: 'already_settled', optionId: 'allow-once',
    });
    const page = session.page();
    if (page.state !== 'ok') throw new Error('expected page');
    expect(page.events.filter(event => event.kind === 'permission_resolved')).toHaveLength(1);
  });

  it('isolates listener exceptions and defines live subscription at the next event boundary', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', deterministic());
    const observed: number[] = [];
    session.admitPrompt(prompt());
    const bad = session.subscribe(() => { throw new Error('listener failure'); });
    const unsubscribe = session.subscribe(event => observed.push(event.seq));
    session.requestCancel({ generation: 'generation-A', commandId: 'cancel-1' });
    unsubscribe(); unsubscribe(); bad(); bad();
    session.forceTerminate({ generation: 'generation-A', commandId: 'force-1' });
    expect(observed).toEqual([2]);
    expect(session.snapshot().state).toBe('terminated');
  });

  it('keeps cooperative cancel, force termination, close, and retire separate and idempotent', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', deterministic());
    const cancel = { generation: 'generation-A', commandId: 'cancel-1' };
    expect(session.requestCancel(cancel)).toMatchObject({ state: 'accepted', cursor: 'bb:1' });
    expect(session.requestCancel(cancel)).toMatchObject({ state: 'accepted', cursor: 'bb:1' });
    const force = { generation: 'generation-A', commandId: 'force-1' };
    expect(session.forceTerminate(force)).toMatchObject({ state: 'accepted', cursor: 'bb:2' });
    expect(session.forceTerminate(force)).toMatchObject({ state: 'accepted', cursor: 'bb:2' });
    const close = { generation: 'generation-A', commandId: 'close-1' };
    expect(session.close(close)).toEqual({ state: 'terminated' });
    expect(session.close(close)).toEqual({ state: 'terminated' });
    const retire = { generation: 'generation-A', commandId: 'retire-1' };
    expect(session.retire(retire)).toMatchObject({ state: 'accepted', cursor: 'bb:3' });
    expect(session.retire(retire)).toMatchObject({ state: 'accepted', cursor: 'bb:3' });
    const page = session.page();
    if (page.state !== 'ok') throw new Error('expected page');
    expect(page.events.map(event => event.kind)).toEqual([
      'cancel_requested', 'force_terminated', 'retired',
    ]);
  });

  it.each(['cancel', 'close'] as const)('recovers %s mutation command idempotency and conflicts', operation => {
    const source = deterministic();
    const first = new FakeBodyBrainSession('fake-adapter', `session-${operation}`, 'generation-A', source);
    const request = { generation: 'generation-A', commandId: `${operation}-command` };
    const original = operation === 'cancel' ? first.requestCancel(request) : first.close(request);
    const queuedRecord = first.recoveryRecord();
    const restored = new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(queuedRecord);
    if (restored.state !== 'restored') throw new Error('expected restore');
    expect(operation === 'cancel' ? restored.session.requestCancel(request) : restored.session.close(request))
      .toEqual(original);
    const conflict = { generation: 'generation-A', commandId: `${operation}-command` };
    expect(operation === 'cancel'
      ? restored.session.close(conflict) : restored.session.requestCancel(conflict)).toEqual({
      state: 'idempotency_conflict',
    });
    const page = restored.session.page();
    if (page.state !== 'ok') throw new Error('expected page');
    expect(page.events).toHaveLength(1);
  });

  it('restores safe idempotency state and rejects corrupt/incompatible recovery without fresh start', () => {
    const source = deterministic();
    const first = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', source);
    const admitted = first.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    const permissionId = first.scriptPermission('generation-A', admitted.receipt.promptId, ['yes', 'no'])!;
    const permissionRequest = { generation: 'generation-A', commandId: 'permission-command-1',
      permissionId, optionId: 'yes' };
    first.respondPermission(permissionRequest);
    const record = first.recoveryRecord();
    expect(JSON.stringify(record)).not.toContain('body plaintext');
    expect(JSON.stringify(record)).not.toContain('credentials');
    const restored = new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(record);
    expect(restored.state).toBe('restored');
    if (restored.state !== 'restored') throw new Error('expected restore');
    expect(restored.session.admitPrompt(prompt())).toEqual(admitted);
    expect(restored.session.respondPermission(permissionRequest)).toEqual({ state: 'accepted', optionId: 'yes' });
    expect(restored.session.snapshot()).toMatchObject({
      sessionRef: 'session-1', generation: 'generation-A', cursor: record.committedSeq === 3 ? 'bb:3' : `bb:${record.committedSeq}`,
    });
    const replay = restored.session.page({ after: 'bb:0' });
    expect(replay.state).toBe('ok');
    if (replay.state !== 'ok') throw new Error('expected replay');
    expect(replay.events).toHaveLength(record.committedSeq);
    expect(restored.session.requestCancel({ generation: 'generation-A', commandId: 'cancel-after-restore' }))
      .toMatchObject({ state: 'accepted', cursor: `bb:${record.committedSeq + 1}` });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(record)).toEqual({
      state: 'failed', code: 'corrupt_recovery',
    });
    const corrupt = { ...record, committedSeq: record.committedSeq + 1 } as BodyBrainRecoveryRecord;
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(corrupt)).toEqual({
      state: 'failed', code: 'corrupt_recovery',
    });
    expect(new FakeBodyBrainSessionRestorer('other-adapter', deterministic()).restore(record)).toEqual({
      state: 'failed', code: 'adapter_incompatible',
    });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(undefined)).toEqual({
      state: 'failed', code: 'reference_missing',
    });
  });

  it('recovers ordered 3-prompt queues and promotes only the active prompt', () => {
    const source = deterministic();
    const first = new FakeBodyBrainSession('fake-adapter', 'session-q', 'generation-A', source);
    const one = first.admitPrompt(prompt({ commandId: 'command-1' }));
    const two = first.admitPrompt(prompt({ commandId: 'command-2' }));
    const three = first.admitPrompt(prompt({ commandId: 'command-3' }));
    if (one.state !== 'accepted' || two.state !== 'accepted' || three.state !== 'accepted')
      throw new Error('expected admissions');
    expect([one.receipt.queuedBehind, two.receipt.queuedBehind, three.receipt.queuedBehind]).toEqual([0, 1, 2]);
    expect(first.scriptCompletion('generation-A', two.receipt.promptId, 'completed')).toEqual({
      state: 'dependency_violation',
    });
    const queuedRecord = first.recoveryRecord();
    const restored = new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(queuedRecord);
    if (restored.state !== 'restored') throw new Error('expected restore');
    expect(restored.session.snapshot().activePromptId).toBe(one.receipt.promptId);
    const fake = restored.session as FakeBodyBrainSession;
    fake.scriptCompletion('generation-A', one.receipt.promptId, 'completed');
    expect(fake.snapshot().activePromptId).toBe(two.receipt.promptId);
    fake.scriptCompletion('generation-A', two.receipt.promptId, 'completed');
    expect(fake.snapshot().activePromptId).toBe(three.receipt.promptId);
    const page = fake.page();
    if (page.state !== 'ok') throw new Error('expected page');
    expect(page.events.filter(event => event.kind === 'prompt_started').map(event => event.promptId))
      .toEqual([two.receipt.promptId, three.receipt.promptId]);
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(resign({
      ...queuedRecord, promptQueue: [...queuedRecord.promptQueue].reverse(),
    }))).toEqual({ state: 'failed', code: 'corrupt_recovery' });
  });

  it('fails closed when deterministic IDs repeat or clock time is non-monotonic', () => {
    const issued = ['prompt-1', 'event-1', 'event-1'];
    const repeatedIds: BodyBrainDeterminism = {
      now: (() => { let n = 0; return () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString(); })(),
      nextId: () => issued.shift() ?? 'event-1',
    };
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', repeatedIds);
    expect(session.admitPrompt(prompt()).state).toBe('accepted');
    expect(() => session.requestCancel({ generation: 'generation-A', commandId: 'cancel-1' }))
      .toThrow(/uniqueness/u);
    const frozenClock: BodyBrainDeterminism = { now: () => '2026-01-01T00:00:00.000Z',
      nextId: (() => { let id = 0; return kind => `${kind}-${++id}`; })() };
    const clockSession = new FakeBodyBrainSession('fake-adapter', 'session-2', 'generation-A', frozenClock);
    clockSession.admitPrompt(prompt());
    expect(() => clockSession.requestCancel({ generation: 'generation-A', commandId: 'cancel-2' }))
      .toThrow(/monotonicity/u);
  });

  it('rejects unknown recovery keys and closed recovery codes without creating a session', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-1', 'generation-A', deterministic());
    const record = session.recoveryRecord();
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore({
      ...record, credentials: 'forbidden',
    })).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore({
      ...record, protocolVersion: 2,
    })).toEqual({ state: 'failed', code: 'protocol_mismatch' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore({
      ...record, state: 'terminated', integrityDigest: 'sha256:' + '0'.repeat(64),
    })).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(resign({
      ...record, retired: true,
    }))).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(resign({
      ...record, activePromptId: 'missing-prompt', state: 'running' as const,
    }))).toEqual({ state: 'failed', code: 'corrupt_recovery' });
    const exited = new FakeBodyBrainSession('fake-adapter', 'session-2', 'generation-A', deterministic());
    exited.forceTerminate({ generation: 'generation-A', commandId: 'force' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(exited.recoveryRecord()))
      .toEqual({ state: 'failed', code: 'agent_exited' });
    const retired = new FakeBodyBrainSession('fake-adapter', 'session-3', 'generation-A', deterministic());
    retired.retire({ generation: 'generation-A', commandId: 'retire' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(retired.recoveryRecord()))
      .toEqual({ state: 'failed', code: 'resume_rejected' });
  });

  it('deep-freezes live, paged, recovered, and exported nested contract values', () => {
    const source = deterministic();
    const session = new FakeBodyBrainSession('fake-adapter', 'session-frozen', 'generation-A', source);
    let observed: unknown;
    session.subscribe(event => { observed = event; });
    session.admitPrompt(prompt());
    const page = session.page();
    if (page.state !== 'ok') throw new Error('expected page');
    expect(Object.isFrozen(page.events[0]?.payload)).toBe(true);
    expect(Object.isFrozen((observed as { payload: object }).payload)).toBe(true);
    expect(() => { (page.events[0]!.payload as Record<string, unknown>).queuedBehind = 99; }).toThrow();
    expect(() => { ((observed as { payload: Record<string, unknown> }).payload).bodyBytes = 99; }).toThrow();
    const record = session.recoveryRecord();
    expect(Object.isFrozen(record.admissions[0]!.request.body)).toBe(true);
    expect(() => { (record.admissions[0]!.request.body as { bytes: number }).bytes = 99; }).toThrow();
    const restored = new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(record);
    if (restored.state !== 'restored') throw new Error('expected restore');
    const replay = restored.session.page();
    if (replay.state !== 'ok') throw new Error('expected replay');
    expect(() => { (replay.events[0]!.payload as Record<string, unknown>).bodyBytes = 99; }).toThrow();
    expect((restored.session.page() as { events: readonly { payload?: Record<string, unknown> }[] })
      .events[0]!.payload?.bodyBytes).toBe(4);
  });

  it.each(['force', 'retire'] as const)('%s durably settles every queued prompt and permission before lifecycle', operation => {
    const session = new FakeBodyBrainSession('fake-adapter', `session-${operation}-settle`, 'generation-A', deterministic());
    const admissions = ['one', 'two', 'three'].map((name, index) =>
      session.admitPrompt(prompt({ commandId: `command-${name}`, body: { digest: digest(name), bytes: index + 1 } })));
    if (admissions.some(item => item.state !== 'accepted')) throw new Error('expected admissions');
    const receipts = admissions.map(item => {
      if (item.state !== 'accepted') throw new Error('expected admission');
      return item.receipt;
    });
    const permissionId = session.scriptPermission('generation-A', receipts[0]!.promptId, ['yes', 'no'])!;
    const result = operation === 'force'
      ? session.forceTerminate({ generation: 'generation-A', commandId: 'terminal-command' })
      : session.retire({ generation: 'generation-A', commandId: 'terminal-command' });
    const page = session.page();
    if (page.state !== 'ok') throw new Error('expected page');
    expect(page.events.at(-1)?.kind).toBe(operation === 'force' ? 'force_terminated' : 'retired');
    expect(page.events.filter(event => event.kind === 'prompt_completed').map(event => event.promptId))
      .toEqual(receipts.map(receipt => receipt.promptId));
    expect(page.events.find(event => event.permissionId === permissionId && event.kind === 'permission_resolved')?.payload)
      .toEqual({ decision: 'cancelled' });
    for (const receipt of receipts) expect(session.awaitCompletion('generation-A', receipt.promptId)).toMatchObject({
      state: 'terminal', completion: { outcome: 'inconclusive', reasonCode: operation === 'force'
        ? 'force_terminated' : 'retired' },
    });
    expect(result).toMatchObject({ state: 'accepted', cursor: `bb:${page.events.length}` });
    expect(session.recoveryRecord().activePermissionIds).toEqual([]);
  });

  it('persists every current-generation permission command result across recovery', () => {
    const source = deterministic();
    const session = new FakeBodyBrainSession('fake-adapter', 'session-permission-ledger', 'generation-A', source);
    const admitted = session.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    const permissionId = session.scriptPermission('generation-A', admitted.receipt.promptId, ['yes', 'no'])!;
    const commands = [
      { request: { generation: 'generation-A', commandId: 'unknown', permissionId: 'missing', optionId: 'yes' },
        result: { state: 'unknown_permission' } },
      { request: { generation: 'generation-A', commandId: 'invalid', permissionId, optionId: 'later' },
        result: { state: 'invalid_option' } },
      { request: { generation: 'generation-A', commandId: 'accepted', permissionId, optionId: 'yes' },
        result: { state: 'accepted', optionId: 'yes' } },
      { request: { generation: 'generation-A', commandId: 'settled', permissionId, optionId: 'no' },
        result: { state: 'already_settled', optionId: 'yes' } },
    ] as const;
    for (const command of commands) expect(session.respondPermission(command.request)).toEqual(command.result);
    const record = session.recoveryRecord();
    expect(record.permissionCommands).toHaveLength(commands.length);
    const restored = new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(record);
    if (restored.state !== 'restored') throw new Error('expected restore');
    for (const command of commands) expect(restored.session.respondPermission(command.request)).toEqual(command.result);
    expect(restored.session.respondPermission({ ...commands[0].request, optionId: 'no' })).toEqual({
      state: 'idempotency_conflict',
    });
  });

  it('rejects re-signed recovery when closed event payload schemas or correlations are changed', () => {
    const source = deterministic();
    const session = new FakeBodyBrainSession('fake-adapter', 'session-correlations', 'generation-A', source);
    const admitted = session.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    session.scriptCompletion('generation-A', admitted.receipt.promptId, 'completed', { digest: digest('answer'), bytes: 6 });
    const record = session.recoveryRecord();
    const variants = [
      { ...record, events: record.events.map((event, index) => index === 0
        ? { ...event, payload: { ...event.payload, queuedBehind: 1 } } : event) },
      { ...record, events: record.events.map((event, index) => index === 1
        ? { ...event, payload: { ...event.payload, outputBytes: 7 } } : event) },
      { ...record, events: record.events.map((event, index) => index === 1
        ? { ...event, payload: { ...event.payload, extra: true } } : event) },
    ];
    for (const variant of variants) expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic())
      .restore(resign(variant))).toEqual({ state: 'failed', code: 'corrupt_recovery' });
  });

  it('keeps every persisted table within coherent live/recovery capacity bounds', () => {
    expect(BODY_BRAIN_MAX_EVENTS).toBe(
      BODY_BRAIN_MAX_ADMISSIONS * 3 - 1 + BODY_BRAIN_MAX_ACTIVE_IDS * 2 + BODY_BRAIN_MAX_COMMANDS,
    );
    const source = deterministic();
    const session = new FakeBodyBrainSession('fake-adapter', 'session-capacity', 'generation-A', source);
    const receipts = [];
    for (let index = 0; index < BODY_BRAIN_MAX_ADMISSIONS; index++) {
      const result = session.admitPrompt(prompt({ commandId: `admit-${index}` }));
      if (result.state !== 'accepted') throw new Error('expected bounded admission');
      receipts.push(result.receipt);
    }
    expect(session.admitPrompt(prompt({ commandId: 'admit-over' }))).toEqual({ state: 'invalid_request' });
    for (let index = 0; index < BODY_BRAIN_MAX_ACTIVE_IDS; index++)
      expect(session.scriptPermission('generation-A', receipts[0]!.promptId, ['yes', 'no'])).toBeTruthy();
    expect(session.scriptPermission('generation-A', receipts[0]!.promptId, ['yes', 'no'])).toBeUndefined();
    const permissionIds = session.recoveryRecord().permissions.map(item => item.permissionId);
    for (const [index, permissionId] of permissionIds.entries()) expect(session.respondPermission({
      generation: 'generation-A', commandId: `permission-${index}`, permissionId, optionId: 'yes',
    })).toMatchObject({ state: 'accepted' });
    for (let index = 0; index < BODY_BRAIN_MAX_COMMANDS; index++) expect(session.requestCancel({
      generation: 'generation-A', commandId: `cancel-${index}`,
    })).toMatchObject({ state: 'accepted' });
    expect(session.requestCancel({ generation: 'generation-A', commandId: 'cancel-over' }))
      .toEqual({ state: 'invalid_request' });
    for (const receipt of receipts) session.scriptCompletion('generation-A', receipt.promptId, 'completed');
    const record = session.recoveryRecord();
    expect(record).toMatchObject({ events: { length: BODY_BRAIN_MAX_EVENTS },
      admissions: { length: BODY_BRAIN_MAX_ADMISSIONS }, permissions: { length: BODY_BRAIN_MAX_ACTIVE_IDS },
      mutations: { length: BODY_BRAIN_MAX_COMMANDS } });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(record).state).toBe('restored');

    const permissionOnlySource = deterministic();
    const permissionOnly = new FakeBodyBrainSession(
      'fake-adapter', 'session-command-capacity', 'generation-A', permissionOnlySource,
    );
    for (let index = 0; index < BODY_BRAIN_MAX_COMMANDS; index++) expect(permissionOnly.respondPermission({
      generation: 'generation-A', commandId: `unknown-${index}`, permissionId: 'missing', optionId: 'yes',
    })).toEqual({ state: 'unknown_permission' });
    expect(permissionOnly.respondPermission({ generation: 'generation-A', commandId: 'unknown-over',
      permissionId: 'missing', optionId: 'yes' })).toEqual({ state: 'invalid_request' });
    const permissionRecord = permissionOnly.recoveryRecord();
    expect(permissionRecord.permissionCommands).toHaveLength(BODY_BRAIN_MAX_COMMANDS);
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', permissionOnlySource).restore(permissionRecord).state)
      .toBe('restored');
  });

  it('binds permission outcomes to decision-time state rather than final state', () => {
    const source = deterministic();
    const session = new FakeBodyBrainSession('fake-adapter', 'session-causal', 'generation-A', source);
    const futurePermissionId = 'permission-3';
    const unknown = { generation: 'generation-A', commandId: 'unknown-before',
      permissionId: futurePermissionId, optionId: 'yes' };
    expect(session.respondPermission(unknown)).toEqual({ state: 'unknown_permission' });
    const admitted = session.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    expect(session.scriptPermission('generation-A', admitted.receipt.promptId, ['yes', 'no']))
      .toBe(futurePermissionId);
    const record = session.recoveryRecord();
    const restored = new FakeBodyBrainSessionRestorer('fake-adapter', source).restore(record);
    if (restored.state !== 'restored') throw new Error('expected causal restore');
    expect(restored.session.respondPermission(unknown)).toEqual({ state: 'unknown_permission' });

    const terminalSource = deterministic();
    const terminal = new FakeBodyBrainSession('fake-adapter', 'session-closed-retired', 'generation-A', terminalSource);
    terminal.close({ generation: 'generation-A', commandId: 'close' });
    const closedRequest = { generation: 'generation-A', commandId: 'closed-permission',
      permissionId: 'missing', optionId: 'yes' };
    expect(terminal.respondPermission(closedRequest)).toEqual({ state: 'closed' });
    terminal.retire({ generation: 'generation-A', commandId: 'retire' });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', terminalSource).restore(terminal.recoveryRecord()))
      .toEqual({ state: 'failed', code: 'resume_rejected' });
  });

  it('replays permission lifecycle exactly and rejects resolution after prompt completion', () => {
    const source = deterministic();
    const session = new FakeBodyBrainSession('fake-adapter', 'session-permission-order', 'generation-A', source);
    const admitted = session.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    const permissionId = session.scriptPermission('generation-A', admitted.receipt.promptId, ['yes'])!;
    session.respondPermission({ generation: 'generation-A', commandId: 'resolve', permissionId, optionId: 'yes' });
    session.scriptCompletion('generation-A', admitted.receipt.promptId, 'completed');
    const record = session.recoveryRecord();
    const reordered = JSON.parse(JSON.stringify(record)) as BodyBrainRecoveryRecord;
    const resolved = reordered.events[2]!; const completed = reordered.events[3]!;
    (reordered as { events: unknown[] }).events = [reordered.events[0], reordered.events[1], completed, resolved]
      .map((event, index) => ({ ...event, seq: index + 1, at: record.events[index]!.at }));
    reordered.admissions[0]!.completion!.completedAt = reordered.events[2]!.at;
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(resign(reordered)))
      .toEqual({ state: 'failed', code: 'corrupt_recovery' });
  });

  it('preflights terminal event batches so dependency failure cannot partially settle state', () => {
    const base = deterministic(); let armed = false; let eventIds = 0;
    const faulting: BodyBrainDeterminism = {
      now: () => base.now(),
      nextId: kind => {
        if (armed && kind === 'event' && ++eventIds === 3) throw new Error('injected event ID failure');
        return base.nextId(kind);
      },
    };
    const session = new FakeBodyBrainSession('fake-adapter', 'session-atomic', 'generation-A', faulting);
    const one = session.admitPrompt(prompt({ commandId: 'one' }));
    const two = session.admitPrompt(prompt({ commandId: 'two' }));
    if (one.state !== 'accepted' || two.state !== 'accepted') throw new Error('expected admissions');
    session.scriptPermission('generation-A', one.receipt.promptId, ['yes']);
    const before = session.recoveryRecord(); armed = true;
    expect(() => session.forceTerminate({ generation: 'generation-A', commandId: 'force' }))
      .toThrow('injected event ID failure');
    expect(session.recoveryRecord()).toEqual(before);
    expect(session.awaitCompletion('generation-A', one.receipt.promptId)).toEqual({ state: 'not_terminal' });
    expect(session.awaitCompletion('generation-A', two.receipt.promptId)).toEqual({ state: 'not_terminal' });
  });

  it('makes forced termination monotonic while preserving replay and explicit retirement', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-terminal-fence', 'generation-A', deterministic());
    const admitted = session.admitPrompt(prompt());
    if (admitted.state !== 'accepted') throw new Error('expected admission');
    const force = { generation: 'generation-A', commandId: 'force-original' };
    const original = session.forceTerminate(force);
    const terminalRecord = session.recoveryRecord();
    const eventCount = terminalRecord.events.length;
    expect(session.forceTerminate(force)).toEqual(original);
    expect(session.admitPrompt(prompt({ commandId: 'after-force' }))).toEqual({ state: 'terminated' });
    expect(session.respondPermission({ generation: 'generation-A', commandId: 'permission-after-force',
      permissionId: 'missing', optionId: 'yes' })).toEqual({ state: 'terminated' });
    expect(session.requestCancel({ generation: 'generation-A', commandId: 'cancel-after-force' }))
      .toEqual({ state: 'terminated' });
    expect(session.close({ generation: 'generation-A', commandId: 'close-after-force' }))
      .toEqual({ state: 'terminated' });
    expect(session.forceTerminate({ generation: 'generation-A', commandId: 'force-after-force' }))
      .toEqual({ state: 'terminated' });
    const fencedRecord = session.recoveryRecord();
    expect(fencedRecord.events).toHaveLength(eventCount);
    expect(fencedRecord.state).toBe('terminated');
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(fencedRecord))
      .toEqual({ state: 'failed', code: 'agent_exited' });
    expect(session.retire({ generation: 'generation-A', commandId: 'retire-after-force' }))
      .toMatchObject({ state: 'accepted' });
    expect(session.recoveryRecord()).toMatchObject({ state: 'retired', retired: true });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(session.recoveryRecord()))
      .toEqual({ state: 'failed', code: 'resume_rejected' });
  });

  it('rejects re-signed event history after force termination', () => {
    const session = new FakeBodyBrainSession('fake-adapter', 'session-post-terminal', 'generation-A', deterministic());
    session.forceTerminate({ generation: 'generation-A', commandId: 'force' });
    const record = session.recoveryRecord();
    const extra = { schemaVersion: 1 as const, eventId: 'event-impossible', seq: record.committedSeq + 1,
      at: new Date(Date.parse(record.committedAt!) + 1000).toISOString(), generation: 'generation-A' as const,
      kind: 'cancel_requested' as const, commandId: 'cancel-impossible' };
    const impossible = resign({ ...record, committedSeq: record.committedSeq + 1, committedAt: extra.at,
      events: [...record.events, extra], mutations: [...record.mutations, {
        operation: 'cancel' as const, commandId: 'cancel-impossible',
        requestHash: digest(canonical({ operation: 'cancel', request: {
          generation: 'generation-A', commandId: 'cancel-impossible',
        } })), result: { state: 'accepted' as const, cursor: `bb:${extra.seq}` },
      }] });
    expect(new FakeBodyBrainSessionRestorer('fake-adapter', deterministic()).restore(impossible))
      .toEqual({ state: 'failed', code: 'corrupt_recovery' });
  });
});
