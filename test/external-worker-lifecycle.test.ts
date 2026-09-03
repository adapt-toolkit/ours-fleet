import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ controlRequest: vi.fn() }));

vi.mock('../src/session/control.js', () => ({ controlRequest: mocks.controlRequest }));

import {
  FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV, presentFleetWorkerLifecycle,
} from '../src/rooms-tasks/external-worker.js';
import { SessionControlError } from '../src/session/types.js';

const previousLifecycleDir = process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV];

afterEach(() => {
  mocks.controlRequest.mockReset();
  if (previousLifecycleDir === undefined)
    delete process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV];
  else process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV] = previousLifecycleDir;
});

describe('detached Fleet worker lifecycle return path', () => {
  it('can present only validated lifecycle payloads without opening an audit attempt', async () => {
    process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV] = '/state/Coordinator';
    mocks.controlRequest.mockResolvedValue({ version: 1, id: 'response', ok: true });
    const ready = { kind: 'room' as const, operation: 'activate' as const,
      eventId: 'room-ready:2026-09-03T09:00:00.000Z', id: 'room-1', name: 'Room',
      previousState: 'provisioning', newState: 'active', participants: [] };

    await presentFleetWorkerLifecycle([ready]);

    expect(mocks.controlRequest).toHaveBeenCalledOnce();
    expect(mocks.controlRequest).toHaveBeenCalledWith('/state/Coordinator', {
      command: 'fleet_audit_present', audit: { presentations: [ready] },
    }, 15_000);
    expect(mocks.controlRequest.mock.calls.map(call => call[1].command))
      .toEqual(['fleet_audit_present']);
  });

  it('retries only a provably pre-send unavailable control plane', async () => {
    process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV] = '/state/Coordinator';
    mocks.controlRequest
      .mockRejectedValueOnce(new SessionControlError('control-unavailable', 'socket absent'))
      .mockResolvedValueOnce({ version: 1, id: 'response', ok: true });
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    await presentFleetWorkerLifecycle([{ kind: 'room', operation: 'activate',
      eventId: 'room-ready:stable', id: 'room-1', previousState: 'provisioning',
      newState: 'active', participants: [] }], { now: () => now, sleep });
    expect(mocks.controlRequest).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);

    mocks.controlRequest.mockReset()
      .mockRejectedValue(new SessionControlError('timeout', 'possibly accepted'));
    await expect(presentFleetWorkerLifecycle([{ kind: 'room', operation: 'activate',
      eventId: 'room-ready:other', id: 'room-2', previousState: 'provisioning',
      newState: 'active', participants: [] }], { now: () => now, sleep }))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(mocks.controlRequest).toHaveBeenCalledOnce();
  });

  it('has no Owner-control effect outside an inherited managed lifecycle route', async () => {
    delete process.env[FLEET_WORKER_LIFECYCLE_STATE_DIR_ENV];
    await presentFleetWorkerLifecycle([{ kind: 'room', operation: 'activate',
      eventId: 'room-ready:stable', id: 'room-1', previousState: 'provisioning',
      newState: 'active', participants: [] }]);
    expect(mocks.controlRequest).not.toHaveBeenCalled();
  });
});
