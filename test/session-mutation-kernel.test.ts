import { describe, expect, it, vi } from 'vitest';

import { AcpRoleSessionAdapter } from '../src/application/session-control.js';
import {
  interruptSession, queueSessionPrompt, respondSessionPermission, respondSessionPermissionV2,
} from '../src/application/session-mutations.js';
import type { SessionHandle, SubmitPromptOptions, TurnCancellationSource } from '../src/session/types.js';

describe('in-process session mutation kernel', () => {
  it('delegates exact origins/options and resolves on queue acceptance, not terminal completion', async () => {
    const completion = new Promise<never>(() => {});
    const queuePrompt = vi.fn(async (_text: string, options?: SubmitPromptOptions) => ({
      promptId: 'prompt-1', queuedBehind: 2, completion, origin: options?.origin,
    }));
    const session = { queuePrompt } as unknown as SessionHandle;
    const owner = {
      interrupt: true, interruptSource: 'owner' as const,
      origin: { kind: 'owner' as const, requestId: 'wire-digest', displayText: 'hello' },
    };

    await expect(queueSessionPrompt(session, 'wrapped owner prompt', owner)).resolves.toMatchObject({
      promptId: 'prompt-1', queuedBehind: 2, origin: owner.origin,
    });
    expect(queuePrompt).toHaveBeenCalledWith('wrapped owner prompt', owner);
    await queueSessionPrompt(session, 'cli text', { origin: { kind: 'local-console' } });
    expect(queuePrompt).toHaveBeenLastCalledWith(
      'cli text', { origin: { kind: 'local-console' } });
  });

  it('preserves caller interrupt sources and normalizes settled and forced outcomes', async () => {
    const interrupt = vi.fn(async (source?: TurnCancellationSource) => source === 'owner'
      ? { state: 'forced' as const, reasonCode: 'deadline' }
      : undefined);
    const session = { interrupt } as unknown as SessionHandle;
    await expect(interruptSession(session, 'local-console')).resolves.toEqual({ state: 'settled' });
    await expect(interruptSession(session, 'owner')).resolves.toEqual({
      state: 'forced', reasonCode: 'deadline',
    });
    expect(interrupt.mock.calls).toEqual([['local-console'], ['owner']]);
  });

  it('normalizes legacy and generation-bound permission delegation without policy', () => {
    const session = {
      respondPermission: vi.fn(() => false),
      respondPermissionV2: vi.fn((_id, option) => option === 'allow' ? 'accepted' : 'stale'),
    } as unknown as SessionHandle;
    expect(respondSessionPermission(session, 'p1', 'deny')).toBe(false);
    expect(respondSessionPermissionV2(session, 'p2', 'allow', 'g1')).toBe('accepted');
    expect(respondSessionPermissionV2(session, 'p2', 'old', 'g0')).toBe('stale');
    expect(respondSessionPermissionV2(
      { respondPermission: () => false } as unknown as SessionHandle, 'p', 'o', 'g',
    )).toBe('unavailable');
  });

  it('preserves oversized legacy-control admission while the REST adapter rejects it', async () => {
    const oversized = 'x'.repeat(32 * 1024 + 1);
    const queuePrompt = vi.fn(async () => ({
      promptId: 'large', queuedBehind: 0, completion: new Promise<never>(() => {}),
    }));
    await expect(queueSessionPrompt(
      { queuePrompt } as unknown as SessionHandle, oversized,
      { origin: { kind: 'local-console' } },
    )).resolves.toMatchObject({ promptId: 'large' });

    const request = vi.fn();
    const adapter = new AcpRoleSessionAdapter('/state', request);
    await expect(adapter.sendText(oversized)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(request).not.toHaveBeenCalled();
  });
});
