import { describe, expect, it, vi } from 'vitest';

import { TopologyPromoteService } from '../../src/web/topology-promote.js';

const fixture = () => {
  const topology = vi.fn(async () => { throw new Error('must not read topology'); });
  const configuration = {
    read: vi.fn(() => { throw new Error('must not read configuration'); }),
    preview: vi.fn(), write: vi.fn(),
  };
  const drafts = { read: vi.fn(), write: vi.fn() };
  const service = new TopologyPromoteService({
    topology, configuration: configuration as never, drafts: drafts as never,
  });
  return { service, topology, configuration, drafts };
};

const expectNoEffects = (value: ReturnType<typeof fixture>) => {
  expect(value.topology).not.toHaveBeenCalled();
  expect(value.configuration.read).not.toHaveBeenCalled();
  expect(value.configuration.preview).not.toHaveBeenCalled();
  expect(value.configuration.write).not.toHaveBeenCalled();
  expect(value.drafts.read).not.toHaveBeenCalled();
  expect(value.drafts.write).not.toHaveBeenCalled();
};

describe('retired topology sketch promotion', () => {
  it.each(['preview', 'promote'] as const)(
    '%s rejects mixed old-format input with one typed error before every effect', async surface => {
      const value = fixture();
      const request = {
        ids: ['agent:Legacy', 'watchdog:Mixed'], configRevision: 'ignored', draftRevision: 'ignored',
      };

      await expect(value.service[surface](request)).rejects.toMatchObject({
        code: 'incompatible_version', retryable: false,
        message: expect.stringMatching(
          /retired configuration format.*explicit Role, Brain, and Agent resources/u,
        ),
        details: { migration: 'explicit_role_brain_agent_resources' },
      });
      expectNoEffects(value);
    },
  );

  it.each(['preview', 'promote'] as const)(
    '%s rejects an empty request as invalid without touching state', async surface => {
      const value = fixture();
      await expect(value.service[surface]({ ids: [], configRevision: 'ignored' }))
        .rejects.toMatchObject({ code: 'invalid_request' });
      expectNoEffects(value);
    },
  );
});
