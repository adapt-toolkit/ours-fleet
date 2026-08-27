import { describe, expect, it, vi } from 'vitest';
import type { PreparedAgentCreation } from '../src/agent-composition-service.js';
import { AgentCreationTransactionError,
  type AgentCreationResult, type AgentCreationState } from '../src/agent-creation-transaction.js';
import type { VerifiedGenerationReservation } from '../src/agent-generation-reservation.js';
import { AgentRuntimeTransactionError,
  type RuntimeOperationResult, type VerifiedRuntimeOperationRequest } from '../src/agent-runtime-transaction.js';
import { AgentStartService } from '../src/agent-start-service.js';

const prepared = {} as PreparedAgentCreation;
const reservation = Object.freeze({
  agentId: 'agent-1', generation: 7,
  planDigest: `sha256:${'1'.repeat(64)}`,
  snapshotDigest: `sha256:${'2'.repeat(64)}`,
  reservationDigest: `sha256:${'3'.repeat(64)}`,
}) as VerifiedGenerationReservation;
const runtimeEvidence = {} as VerifiedRuntimeOperationRequest;
const nonCompleteStates = [
  'pending', 'create_authorized', 'acquired', 'verifying', 'verified',
  'compensating', 'compensated', 'compensation_failed', 'ambiguous',
] as const satisfies readonly Exclude<AgentCreationState, 'complete'>[];

function harness(creationResult: AgentCreationResult, runtimeResult: RuntimeOperationResult = {
  state: 'ready', runtimeInstanceKey: 'runtime-1',
}) {
  const creation = { persistPrepared: vi.fn(async () => creationResult) };
  const runtime = { start: vi.fn(async () => runtimeResult) };
  return { service: new AgentStartService(creation as never, runtime as never), creation, runtime };
}

describe('AgentStartService', () => {
  it('forwards exact prepared, reservation, and opaque evidence references', async () => {
    const creationResult: AgentCreationResult = { state: 'complete', reservation };
    const runtimeResult = { state: 'ready', runtimeInstanceKey: 'runtime-1' };
    const targetEvidence = {};
    const h = harness(creationResult, runtimeResult);

    const result = await h.service.start(prepared, {
      creation: { actionId: 'create-1', targetEvidence }, runtimeEvidence,
    });

    expect(h.creation.persistPrepared).toHaveBeenCalledTimes(1);
    expect(h.creation.persistPrepared.mock.calls[0]![0]).toBe(prepared);
    expect(h.creation.persistPrepared.mock.calls[0]![1]).toEqual({ actionId: 'create-1', targetEvidence });
    expect(h.creation.persistPrepared.mock.calls[0]![1].targetEvidence).toBe(targetEvidence);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
    expect(h.runtime.start.mock.calls[0]![0]).toBe(reservation);
    expect(h.runtime.start.mock.calls[0]![1]).toBe(runtimeEvidence);
    expect(result).toEqual({ stage: 'runtime', creation: creationResult, runtime: runtimeResult });
    if (result.stage === 'runtime') {
      expect(result.creation).toBe(creationResult);
      expect(result.runtime).toBe(runtimeResult);
    }
  });

  it.each(nonCompleteStates)('returns %s at creation stage without a runtime call', async state => {
    const creationResult: AgentCreationResult = {
      state, reservation, ...(state === 'ambiguous' ? { outcome: 'unknown' as const } : {}),
    };
    const h = harness(creationResult);

    const result = await h.service.start(prepared, {
      creation: { actionId: 'create-1' }, runtimeEvidence,
    });

    expect(result).toEqual({ stage: 'creation', creation: creationResult });
    expect(result.creation).toBe(creationResult);
    expect(h.runtime.start).not.toHaveBeenCalled();
  });

  it('copies the authorable creation wrapper before awaiting while preserving opaque references', async () => {
    let release!: (value: AgentCreationResult) => void;
    const targetEvidence = {};
    const creation = { persistPrepared: vi.fn(() => new Promise<AgentCreationResult>(resolve => { release = resolve; })) };
    const runtime = { start: vi.fn(async () => ({ state: 'ready', runtimeInstanceKey: 'runtime-1' })) };
    const service = new AgentStartService(creation as never, runtime as never);
    const creationInput = { actionId: 'create-1', targetEvidence };
    const request = { creation: creationInput, runtimeEvidence };

    const pending = service.start(prepared, request);
    creationInput.actionId = 'mutated';
    creationInput.targetEvidence = { substituted: true };
    request.runtimeEvidence = {} as VerifiedRuntimeOperationRequest;
    release({ state: 'complete', reservation });
    await pending;

    expect(creation.persistPrepared.mock.calls[0]![1].actionId).toBe('create-1');
    expect(creation.persistPrepared.mock.calls[0]![1].targetEvidence).toBe(targetEvidence);
    expect(runtime.start.mock.calls[0]![1]).toBe(runtimeEvidence);
  });

  it('passes creation errors through by identity with zero downstream calls', async () => {
    const thrown = new AgentCreationTransactionError('corrupt_state');
    const creation = { persistPrepared: vi.fn(async () => { throw thrown; }) };
    const runtime = { start: vi.fn() };
    const service = new AgentStartService(creation as never, runtime as never);

    await expect(service.start(prepared, {
      creation: { actionId: 'create-1' }, runtimeEvidence,
    })).rejects.toBe(thrown);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('passes runtime errors through by identity without retry or creation follow-up', async () => {
    const creationResult: AgentCreationResult = { state: 'complete', reservation };
    const thrown = new AgentRuntimeTransactionError('ambiguous');
    const creation = { persistPrepared: vi.fn(async () => creationResult) };
    const runtime = { start: vi.fn(async () => { throw thrown; }) };
    const service = new AgentStartService(creation as never, runtime as never);

    await expect(service.start(prepared, {
      creation: { actionId: 'create-1' }, runtimeEvidence,
    })).rejects.toBe(thrown);
    expect(creation.persistPrepared).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'not_ready', 'ambiguous'])('preserves runtime %s without follow-up', async state => {
    const creationResult: AgentCreationResult = { state: 'complete', reservation };
    const runtimeResult = { state, runtimeInstanceKey: 'runtime-1' };
    const h = harness(creationResult, runtimeResult);

    const result = await h.service.start(prepared, {
      creation: { actionId: 'create-1' }, runtimeEvidence,
    });

    expect(result).toEqual({ stage: 'runtime', creation: creationResult, runtime: runtimeResult });
    expect(h.creation.persistPrepared).toHaveBeenCalledTimes(1);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
  });

  it('keeps no replay cache, journal, or key and delegates once per service call', async () => {
    const firstCreation: AgentCreationResult = { state: 'complete', reservation };
    const secondCreation: AgentCreationResult = { state: 'complete', reservation };
    const firstRuntime = { state: 'ready', runtimeInstanceKey: 'runtime-1' };
    const secondRuntime = { state: 'ready', runtimeInstanceKey: 'runtime-1' };
    const creation = { persistPrepared: vi.fn()
      .mockResolvedValueOnce(firstCreation).mockResolvedValueOnce(secondCreation) };
    const runtime = { start: vi.fn()
      .mockResolvedValueOnce(firstRuntime).mockResolvedValueOnce(secondRuntime) };
    const service = new AgentStartService(creation as never, runtime as never);
    const request = { creation: { actionId: 'create-1' }, runtimeEvidence };

    const first = await service.start(prepared, request);
    const second = await service.start(prepared, request);

    expect(creation.persistPrepared).toHaveBeenCalledTimes(2);
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ stage: 'runtime', creation: firstCreation, runtime: firstRuntime });
    expect(second).toEqual({ stage: 'runtime', creation: secondCreation, runtime: secondRuntime });
  });
});
