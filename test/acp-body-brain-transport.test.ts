import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ACP_BODY_BRAIN_MAX_PERMISSION_OPTIONS,
  ACP_BODY_BRAIN_MAX_UPDATE_BYTES,
  ACP_BODY_BRAIN_MAX_BODY_BYTES,
  AcpBodyBrainTransportBoundary,
  sanitizeAcpBodyBrainSessionUpdate,
  type AcpBodyBrainProvider,
  type AcpBodyBrainNotification,
  type AcpBodySource,
} from '../src/session/acp-body-brain-transport.js';

const sha = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const planDigest = `sha256:${'a'.repeat(64)}`;
const generation = 'generation-1';

function fixture(source?: AcpBodySource) {
  let notify: (notification: unknown) => void = () => {};
  let retainedBody: Uint8Array | undefined;
  const provider: AcpBodyBrainProvider = {
    subscribe: vi.fn(listener => { notify = listener; return vi.fn(); }),
    start: vi.fn(async () => ({ state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` } })),
    restore: vi.fn(async () => ({ state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` } })),
    submit: vi.fn(async (_request, body) => { retainedBody = body; return { state: 'accepted' }; }),
    respondPermission: vi.fn(async () => ({ state: 'accepted' })),
    cancel: vi.fn(async () => ({ state: 'accepted' })),
    forceTerminate: vi.fn(async () => ({ state: 'accepted' })),
    close: vi.fn(async () => ({ state: 'accepted' })),
    retire: vi.fn(async () => ({ state: 'accepted' })),
    cleanup: vi.fn(async () => {}),
  };
  const bytes = new TextEncoder().encode('body');
  const bodies = source ?? { resolve: vi.fn(async () => bytes) };
  const transport = new AcpBodyBrainTransportBoundary('codex-acp', provider, bodies);
  return { transport, provider, bodies, bytes, notify: (value: unknown) => notify(value), retained: () => retainedBody };
}

async function active(source?: AcpBodySource) {
  const value = fixture(source);
  const deliveries: unknown[] = [];
  value.transport.subscribe(delivery => deliveries.push(delivery));
  await value.transport.start({ protocolVersion: 1, generation, planDigest });
  return { ...value, deliveries };
}

function notification(overrides: Partial<AcpBodyBrainNotification> = {}): unknown {
  return { protocolVersion: 1, generation, transportSeq: 1, notificationId: 'n1', kind: 'started', ...overrides };
}

describe('AcpBodyBrainTransportBoundary lifecycle', () => {
  it('requires subscribe before start and permits only one active listener', async () => {
    const { transport, provider } = fixture();
    expect(await transport.start({ protocolVersion: 1, generation, planDigest })).toEqual({ state: 'failed', code: 'listener_required' });
    expect(transport.subscribe(() => {})).toBeTypeOf('function');
    expect(transport.subscribe(() => {})).toBeUndefined();
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('unwinds a thrown provider subscription and permits a deterministic retry', () => {
    const { transport, provider } = fixture();
    vi.mocked(provider.subscribe).mockImplementationOnce(() => { throw new Error('dependency'); });
    expect(() => transport.subscribe(() => {})).toThrow('dependency');
    expect(transport.subscribe(() => {})).toBeTypeOf('function');
    expect(provider.subscribe).toHaveBeenCalledTimes(2);
    expect(() => transport.subscribe(null as never)).toThrow(TypeError);
  });

  it('passes exact start and restore requests to the bound provider', async () => {
    const started = fixture(); started.transport.subscribe(() => {});
    const start = { protocolVersion: 1 as const, generation, planDigest };
    await started.transport.start(start);
    expect(started.provider.start).toHaveBeenCalledWith(start);
    const restored = fixture(); restored.transport.subscribe(() => {});
    const restore = { ...start, sessionMetadata: { schemaVersion: 1 as const, token: 'opaque', digest: `sha256:${'c'.repeat(64)}` } };
    await restored.transport.restore(restore);
    expect(restored.provider.restore).toHaveBeenCalledWith(restore);
    const extra = fixture(); extra.transport.subscribe(() => {});
    expect(await extra.transport.start({ ...start, secret: 'must-not-pass' } as typeof start))
      .toEqual({ state: 'failed', code: 'invalid_request' });
    expect(extra.provider.start).not.toHaveBeenCalled();
  });

  it('passes owned frozen launch snapshots and returns owned frozen provider results', async () => {
    const value = fixture(); value.transport.subscribe(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed: unknown;
    const providerResult = { state: 'accepted' as const, sessionMetadata: { schemaVersion: 1 as const, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` } };
    vi.mocked(value.provider.start).mockImplementation(async request => { await gate; observed = request; return providerResult; });
    const request = { protocolVersion: 1 as const, generation, planDigest };
    const pending = value.transport.start(request);
    (request as { generation: string }).generation = 'mutated'; release();
    const result = await pending;
    providerResult.sessionMetadata.token = 'mutated';
    expect(observed).toEqual({ protocolVersion: 1, generation, planDigest });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(result).toEqual({ state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.state === 'accepted' && Object.isFrozen(result.sessionMetadata)).toBe(true);
  });

  it('snapshots nested restore metadata before provider observation', async () => {
    const value = fixture(); value.transport.subscribe(() => {});
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let observed: unknown;
    vi.mocked(value.provider.restore).mockImplementation(async request => { await gate; observed = request; return {
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'returned', digest: `sha256:${'d'.repeat(64)}` },
    }; });
    const metadata = { schemaVersion: 1 as const, token: 'original', digest: `sha256:${'c'.repeat(64)}` };
    const pending = value.transport.restore({ protocolVersion: 1, generation, planDigest, sessionMetadata: metadata });
    metadata.token = 'mutated'; release(); await pending;
    expect(observed).toEqual({ protocolVersion: 1, generation, planDigest,
      sessionMetadata: { schemaVersion: 1, token: 'original', digest: `sha256:${'c'.repeat(64)}` } });
    expect(Object.isFrozen((observed as { sessionMetadata: unknown }).sessionMetadata)).toBe(true);
  });

  it('supports synchronous notifications emitted during start', async () => {
    const value = fixture();
    vi.mocked(value.provider.start).mockImplementation(async () => {
      value.notify(notification());
      return { state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` } };
    });
    const deliveries: unknown[] = [];
    value.transport.subscribe(delivery => deliveries.push(delivery));
    await value.transport.start({ protocolVersion: 1, generation, planDigest });
    expect(deliveries).toEqual([{ state: 'notification', notification: notification() }]);
  });

  it('cleans partial start failure and thrown dependency failure', async () => {
    const rejected = fixture(); rejected.transport.subscribe(() => {});
    vi.mocked(rejected.provider.start).mockResolvedValue({ state: 'failed', code: 'adapter_rejected' });
    await rejected.transport.start({ protocolVersion: 1, generation, planDigest });
    expect(rejected.provider.cleanup).toHaveBeenCalledOnce();
    const thrown = fixture(); thrown.transport.subscribe(() => {});
    vi.mocked(thrown.provider.start).mockRejectedValue(new Error('secret exception'));
    await expect(thrown.transport.start({ protocolVersion: 1, generation, planDigest })).rejects.toThrow('secret exception');
    expect(thrown.provider.cleanup).toHaveBeenCalledOnce();
  });

  it('makes concurrent cleanup idempotent and rejects later commands closed', async () => {
    const { transport, provider } = await active();
    await Promise.all([transport.cleanup(), transport.cleanup()]);
    expect(provider.cleanup).toHaveBeenCalledOnce();
    expect(await transport.cancel({ generation, commandId: 'c1' })).toEqual({ state: 'failed', code: 'closed' });
  });

  it.each([
    ['start+start', 'start', 'start'], ['start+restore', 'start', 'restore'], ['restore+restore', 'restore', 'restore'],
  ] as const)('reserves launch synchronously for %s', async (_label, first, second) => {
    const value = fixture(); value.transport.subscribe(() => {});
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(value.provider[first]).mockImplementation(async () => { await gate; return {
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` },
    }; });
    const base = { protocolVersion: 1 as const, generation, planDigest };
    const restore = { ...base, sessionMetadata: { schemaVersion: 1 as const, token: 'opaque', digest: `sha256:${'c'.repeat(64)}` } };
    const pending = first === 'start' ? value.transport.start(base) : value.transport.restore(restore);
    expect(value.transport.presentation().state).toBe('launching');
    const rejected = second === 'start' ? await value.transport.start(base) : await value.transport.restore(restore);
    expect(rejected).toEqual({ state: 'failed', code: 'already_started' });
    release(); await pending;
    expect(vi.mocked(value.provider.start).mock.calls.length + vi.mocked(value.provider.restore).mock.calls.length).toBe(1);
  });

  it('serializes cleanup after an accepted in-flight launch without resurrection', async () => {
    const value = fixture(); value.transport.subscribe(() => {});
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(value.provider.start).mockImplementation(async () => { await gate; return {
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` },
    }; });
    const launch = value.transport.start({ protocolVersion: 1, generation, planDigest });
    const cleanup = value.transport.cleanup();
    expect(value.transport.presentation().state).toBe('closed');
    expect(value.provider.cleanup).not.toHaveBeenCalled();
    release();
    expect(await launch).toEqual({ state: 'failed', code: 'closed' });
    await cleanup;
    expect(value.provider.cleanup).toHaveBeenCalledOnce();
    expect(value.transport.presentation().state).toBe('closed');
    expect(await value.transport.cancel({ generation, commandId: 'c1' })).toEqual({ state: 'failed', code: 'closed' });
  });

  it('serializes cleanup with rejected and thrown launches and preserves failure semantics', async () => {
    for (const thrown of [false, true]) {
      const value = fixture(); value.transport.subscribe(() => {});
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      vi.mocked(value.provider.start).mockImplementation(async () => {
        await gate;
        if (thrown) throw new Error('dependency');
        return { state: 'failed', code: 'adapter_rejected' };
      });
      const launch = value.transport.start({ protocolVersion: 1, generation, planDigest });
      const cleanup = value.transport.cleanup(); release();
      if (thrown) await expect(launch).rejects.toThrow('dependency');
      else expect(await launch).toEqual({ state: 'failed', code: 'closed' });
      await cleanup;
      expect(value.provider.cleanup).toHaveBeenCalledOnce();
    }
  });

  it('cannot accept an orphan when its subscription disappears during launch', async () => {
    const value = fixture();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(value.provider.start).mockImplementation(async () => { await gate; return {
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` },
    }; });
    const unsubscribe = value.transport.subscribe(() => {})!;
    const launch = value.transport.start({ protocolVersion: 1, generation, planDigest });
    unsubscribe(); release();
    expect(await launch).toEqual({ state: 'failed', code: 'listener_required' });
    expect(value.provider.cleanup).toHaveBeenCalledOnce();
    expect(value.transport.presentation().state).toBe('closed');
  });

  it('cannot accept after unsubscribe and resubscribe with the same callback', async () => {
    const value = fixture();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(value.provider.start).mockImplementation(async () => { await gate; return {
      state: 'accepted', sessionMetadata: { schemaVersion: 1, token: 'opaque', digest: `sha256:${'b'.repeat(64)}` },
    }; });
    const callback = vi.fn();
    const unsubscribe = value.transport.subscribe(callback)!;
    const launch = value.transport.start({ protocolVersion: 1, generation, planDigest });
    unsubscribe();
    expect(value.transport.subscribe(callback)).toBeTypeOf('function');
    release();
    expect(await launch).toEqual({ state: 'failed', code: 'listener_required' });
    expect(value.provider.cleanup).toHaveBeenCalledOnce();
    expect(value.transport.presentation().state).toBe('closed');
  });

  it('stops delivery after unsubscribe and cleanup', async () => {
    const value = fixture(); const deliveries: unknown[] = [];
    const unsubscribe = value.transport.subscribe(item => deliveries.push(item))!;
    await value.transport.start({ protocolVersion: 1, generation, planDigest });
    unsubscribe(); value.notify(notification());
    expect(deliveries).toEqual([]);
    await value.transport.cleanup(); value.notify(notification());
    expect(deliveries).toEqual([]);
  });
});

describe('notification validation', () => {
  const validUpdates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'u' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'n', uri: 'file:///x' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'resource', resource: { uri: 'file:///x', text: 't' } } },
    { sessionUpdate: 'tool_call', toolCallId: 't', title: 'tool', kind: 'read', status: 'pending',
      content: [{ type: 'diff', path: '/x', newText: 'n' }], locations: [{ path: '/x', line: 1 }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
    { sessionUpdate: 'plan', entries: [{ content: 'x', priority: 'high', status: 'pending' }] },
    { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p', content: '# plan' } },
    { sessionUpdate: 'plan_removed', planId: 'p' },
    { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x', description: 'd', input: { hint: 'h' } }] },
    { sessionUpdate: 'current_mode_update', currentModeId: 'mode' },
    { sessionUpdate: 'config_option_update', configOptions: [{ type: 'select', id: 'model', name: 'Model',
      currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
    { type: 'boolean', id: 'thinking', name: 'Thinking', currentValue: true }] },
    { sessionUpdate: 'session_info_update', title: 'title', updatedAt: null },
    { sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.1, currency: 'USD' } },
  ] as const;

  it('accepts every exact update variant as an owned no-throw protocol DTO', () => {
    for (const update of validUpdates) {
      const accepted = sanitizeAcpBodyBrainSessionUpdate(update);
      expect(accepted, update.sessionUpdate).toBeDefined();
      expect(() => JSON.stringify(accepted)).not.toThrow();
      expect(Object.isFrozen(accepted)).toBe(true);
    }
  });

  it('rejects wrong types, nested extras, and accessor-bearing objects for every update variant', () => {
    for (const update of validUpdates) {
      const wrong = { ...update } as Record<string, unknown>;
      const required = Object.keys(wrong).find(key => key !== 'sessionUpdate')!;
      wrong[required] = Symbol('wrong');
      expect(sanitizeAcpBodyBrainSessionUpdate(wrong), `${update.sessionUpdate} wrong type`).toBeUndefined();
      expect(sanitizeAcpBodyBrainSessionUpdate({ ...update, unexpected: true }),
        `${update.sessionUpdate} top extra`).toBeUndefined();
    }
    expect(sanitizeAcpBodyBrainSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', title: 't',
      locations: [{ path: '/x', unexpected: true }] })).toBeUndefined();
    expect(sanitizeAcpBodyBrainSessionUpdate({ sessionUpdate: 'config_option_update', configOptions: [
      { type: 'boolean', id: 'x', name: 'X', currentValue: true, unexpected: true },
    ] })).toBeUndefined();
    const accessor = { sessionUpdate: 'usage_update', used: 1, size: 2 };
    Object.defineProperty(accessor, 'cost', { enumerable: true, get: () => ({ amount: 1, currency: 'USD' }) });
    expect(sanitizeAcpBodyBrainSessionUpdate(accessor)).toBeUndefined();
  });

  it('rejects gaps, duplicate sequence numbers, generation changes, and ID conflicts', async () => {
    const value = await active();
    value.notify(notification({ transportSeq: 2 }));
    value.notify(notification());
    value.notify(notification());
    value.notify(notification({ transportSeq: 2, notificationId: 'n1', kind: 'failed', code: 'adapter_error' }));
    value.notify(notification({ transportSeq: 2, notificationId: 'n2', generation: 'other' }));
    expect(value.deliveries).toEqual([
      { state: 'failed', code: 'sequence_gap' },
      { state: 'notification', notification: notification() },
      { state: 'failed', code: 'sequence_duplicate' },
      { state: 'failed', code: 'notification_id_conflict' },
      { state: 'failed', code: 'generation_changed' },
    ]);
  });

  it('rejects malformed correlations and duplicate or unbounded permission options', async () => {
    const value = await active();
    value.notify(notification({ kind: 'permission_requested', promptId: 'p1', permissionId: 'perm', optionIds: ['yes', 'yes'] }));
    value.notify(notification({ kind: 'completed', promptId: '', outcome: 'completed' }));
    expect(value.deliveries).toEqual([
      { state: 'failed', code: 'invalid_notification' },
      { state: 'failed', code: 'invalid_notification' },
    ]);
    expect(ACP_BODY_BRAIN_MAX_PERMISSION_OPTIONS).toBe(16);
    value.notify(notification({ kind: 'permission_requested', promptId: 'p1', permissionId: 'perm', optionIds: Array.from({ length: 17 }, (_, i) => `o${i}`) }));
    expect(value.deliveries.at(-1)).toEqual({ state: 'failed', code: 'invalid_notification' });
  });

  it('makes the first exit/failure terminal and rejects later notification precedence', async () => {
    const value = await active();
    value.notify(notification({ kind: 'failed', code: 'session_lost' }));
    value.notify(notification({ transportSeq: 2, notificationId: 'n2', kind: 'exited', code: 'clean_exit' }));
    expect(value.deliveries).toEqual([
      { state: 'notification', notification: notification({ kind: 'failed', code: 'session_lost' }) },
      { state: 'failed', code: 'terminal_conflict' },
    ]);
  });

  it('owns and deeply freezes notifications and canonicalizes reordered keys', async () => {
    const value = await active();
    const raw = {
      protocolVersion: 1, generation, transportSeq: 1, notificationId: 'n1',
      kind: 'permission_requested', promptId: 'p1', permissionId: 'perm', optionIds: ['yes', 'no'],
    };
    value.notify(raw);
    raw.optionIds[0] = 'MUTATED';
    raw.promptId = 'MUTATED';
    const delivered = (value.deliveries[0] as { notification: AcpBodyBrainNotification }).notification;
    expect(delivered.promptId).toBe('p1');
    expect(delivered.kind === 'permission_requested' && delivered.optionIds).toEqual(['yes', 'no']);
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(delivered.kind === 'permission_requested' && Object.isFrozen(delivered.optionIds)).toBe(true);
    value.notify({
      optionIds: ['yes', 'no'], permissionId: 'perm', promptId: 'p1', kind: 'permission_requested',
      notificationId: 'n1', transportSeq: 1, generation, protocolVersion: 1,
    });
    expect(value.deliveries[1]).toEqual({ state: 'failed', code: 'sequence_duplicate' });
  });

  it('accepts only exact bounded session updates and deeply owns their DTO', async () => {
    const value = await active();
    const raw = { sessionUpdate: 'agent_message_chunk', messageId: 'm1',
      content: { type: 'text', text: 'hello' } };
    value.notify(notification({ kind: 'session_update', update: raw }));
    raw.content.text = 'mutated';
    const delivered = (value.deliveries[0] as { notification: AcpBodyBrainNotification }).notification;
    expect(delivered.kind === 'session_update' && delivered.update).toEqual({
      sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hello' },
    });
    expect(delivered.kind === 'session_update' && Object.isFrozen(delivered.update)).toBe(true);
    expect(delivered.kind === 'session_update' && Object.isFrozen(delivered.update.content)).toBe(true);

    const malformed = await active();
    malformed.notify(notification({ kind: 'session_update', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' }, secretEscape: true,
    } }));
    expect(malformed.deliveries).toEqual([{ state: 'failed', code: 'invalid_notification' }]);
    const oversized = await active();
    oversized.notify(notification({ kind: 'session_update', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(ACP_BODY_BRAIN_MAX_UPDATE_BYTES + 1) },
    } }));
    expect(oversized.deliveries).toEqual([{ state: 'failed', code: 'invalid_notification' }]);
  });
});

describe('verified ephemeral body submission', () => {
  it('submits metadata separately, copies once, and zeroes the owned bytes', async () => {
    const value = await active();
    const result = await value.transport.submit({
      generation, commandId: 'c1', promptId: 'p1', origin: { kind: 'owner', requestId: 'r1' },
      body: { digest: sha(value.bytes), bytes: value.bytes.byteLength },
    });
    expect(result).toEqual({ state: 'accepted' });
    expect(value.provider.submit).toHaveBeenCalledWith(
      { generation, commandId: 'c1', promptId: 'p1', origin: { kind: 'owner', requestId: 'r1' } }, expect.any(Uint8Array),
    );
    expect(value.retained()).not.toBe(value.bytes);
    expect([...value.retained()!]).toEqual([0, 0, 0, 0]);
    expect([...value.bytes]).toEqual([...new TextEncoder().encode('body')]);
  });

  it('maps source throw, digest mismatch, length mismatch, and oversize to closed codes', async () => {
    const throwing = await active({ resolve: async () => { throw new Error('credential'); } });
    const base = { generation, commandId: 'c1', promptId: 'p1', origin: { kind: 'startup' } as const };
    expect(await throwing.transport.submit({ ...base, body: { digest: sha(new Uint8Array()), bytes: 0 } }))
      .toEqual({ state: 'failed', code: 'body_unavailable' });
    const mismatch = await active();
    expect(await mismatch.transport.submit({ ...base, body: { digest: `sha256:${'0'.repeat(64)}`, bytes: 4 } }))
      .toEqual({ state: 'failed', code: 'body_digest_mismatch' });
    expect(await mismatch.transport.submit({ ...base, body: { digest: sha(mismatch.bytes), bytes: 3 } }))
      .toEqual({ state: 'failed', code: 'body_length_mismatch' });
    const oversize = await active({ resolve: async () => new Uint8Array(ACP_BODY_BRAIN_MAX_BODY_BYTES + 1) });
    expect(await oversize.transport.submit({ ...base, body: { digest: sha(new Uint8Array()), bytes: 0 } }))
      .toEqual({ state: 'failed', code: 'body_oversize' });
  });

  it('rejects SharedArrayBuffer views before provider submission', async () => {
    if (typeof SharedArrayBuffer === 'undefined') return;
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    const value = await active({ resolve: async () => shared });
    expect(await value.transport.submit({
      generation, commandId: 'c1', promptId: 'p1', origin: { kind: 'startup' },
      body: { digest: sha(new Uint8Array(4)), bytes: 4 },
    })).toEqual({ state: 'failed', code: 'body_unavailable' });
    expect(value.provider.submit).not.toHaveBeenCalled();
  });

  it('fences every stale command before body resolution or provider invocation', async () => {
    const value = await active();
    const stale = 'stale-generation';
    expect(await value.transport.submit({
      generation: stale, commandId: 'c1', promptId: 'p1', origin: { kind: 'startup' },
      body: { digest: sha(value.bytes), bytes: 4 },
    })).toEqual({ state: 'failed', code: 'generation_changed' });
    expect(await value.transport.respondPermission({ generation: stale, commandId: 'c2', permissionId: 'p', optionId: 'yes' }))
      .toEqual({ state: 'failed', code: 'generation_changed' });
    for (const invoke of [value.transport.cancel.bind(value.transport), value.transport.forceTerminate.bind(value.transport),
      value.transport.close.bind(value.transport), value.transport.retire.bind(value.transport)])
      expect(await invoke({ generation: stale, commandId: 'c3' })).toEqual({ state: 'failed', code: 'generation_changed' });
    expect(value.bodies.resolve).not.toHaveBeenCalled();
    expect(value.provider.submit).not.toHaveBeenCalled();
    expect(value.provider.respondPermission).not.toHaveBeenCalled();
    expect(value.provider.cancel).not.toHaveBeenCalled();
    expect(value.provider.forceTerminate).not.toHaveBeenCalled();
    expect(value.provider.close).not.toHaveBeenCalled();
    expect(value.provider.retire).not.toHaveBeenCalled();
  });

  it('rejects non-token semantic identifiers before provider calls', async () => {
    for (const bad of [' white', 'slash/value', 'é', 'line\nbreak']) {
      const value = await active();
      expect(await value.transport.cancel({ generation, commandId: bad })).toEqual({ state: 'failed', code: 'invalid_request' });
      expect(await value.transport.submit({
        generation, commandId: bad, promptId: 'p1', origin: { kind: 'startup' },
        body: { digest: sha(value.bytes), bytes: 4 },
      })).toEqual({ state: 'failed', code: 'invalid_request' });
      expect(value.provider.cancel).not.toHaveBeenCalled();
      expect(value.provider.submit).not.toHaveBeenCalled();
    }
  });

  it('snapshots nested submit origins before asynchronous body resolution', async () => {
    const bytes = new TextEncoder().encode('body');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const value = await active({ resolve: async () => { await gate; return bytes; } });
    const origin = { kind: 'owner' as const, requestId: 'original' };
    const pending = value.transport.submit({ generation, commandId: 'c1', promptId: 'p1', origin,
      body: { digest: sha(bytes), bytes: 4 } });
    origin.requestId = 'mutated'; release(); await pending;
    const metadata = vi.mocked(value.provider.submit).mock.calls[0][0];
    expect(metadata.origin).toEqual({ kind: 'owner', requestId: 'original' });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.origin)).toBe(true);
  });

  it('resolves on every call without caching and isolates later source mutation', async () => {
    const bytes = new TextEncoder().encode('body');
    const resolve = vi.fn(async () => bytes);
    const value = await active({ resolve });
    vi.mocked(value.provider.submit).mockImplementation(async (_metadata, owned) => {
      bytes.fill(9);
      expect([...owned]).toEqual([...new TextEncoder().encode('body')]);
      return { state: 'accepted' };
    });
    const body = { digest: sha(bytes), bytes: 4 };
    const request = { generation, commandId: 'c1', promptId: 'p1', origin: { kind: 'startup' } as const, body };
    await value.transport.submit(request);
    bytes.set(new TextEncoder().encode('body'));
    await value.transport.submit({ ...request, commandId: 'c2' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('normalizes malformed provider failures without exposing provider data', async () => {
    const value = await active();
    vi.mocked(value.provider.cancel).mockResolvedValue({ state: 'failed', code: 'SECRET' } as never);
    expect(await value.transport.cancel({ generation, commandId: 'c1' }))
      .toEqual({ state: 'failed', code: 'adapter_unavailable' });
  });

  it('snapshots command objects and owns normalized command results', async () => {
    const value = await active();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let observed: unknown;
    const providerResult: { state: 'failed'; code: 'adapter_rejected' | 'adapter_unavailable' } = { state: 'failed', code: 'adapter_rejected' };
    vi.mocked(value.provider.cancel).mockImplementation(async request => { await gate; observed = request; return providerResult; });
    const request = { generation, commandId: 'original' };
    const pending = value.transport.cancel(request); request.commandId = 'mutated'; release();
    const result = await pending; providerResult.code = 'adapter_unavailable';
    expect(observed).toEqual({ generation, commandId: 'original' });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(result).toEqual({ state: 'failed', code: 'adapter_rejected' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('propagates command dependency exceptions without serializing them', async () => {
    const value = await active();
    vi.mocked(value.provider.cancel).mockRejectedValue(new Error('dependency exception'));
    await expect(value.transport.cancel({ generation, commandId: 'c1' })).rejects.toThrow('dependency exception');
    expect(JSON.stringify(value.transport.presentation())).not.toContain('dependency exception');
  });
});

it('projects a deterministic allowlist without recovery tokens or hostile provider values', async () => {
  const value = await active();
  value.notify({ ...notification(), error: 'SECRET argv=/tmp/key TOKEN=abc' });
  const encoded = JSON.stringify({ presentation: value.transport.presentation(), deliveries: value.deliveries });
  expect(encoded).toBe(JSON.stringify({
    presentation: { protocolVersion: 1, adapterId: 'codex-acp', state: 'active', generation, lastTransportSeq: 0 },
    deliveries: [{ state: 'failed', code: 'invalid_notification' }],
  }));
  expect(encoded).not.toContain('SECRET');
  expect(encoded).not.toContain('opaque');
});
