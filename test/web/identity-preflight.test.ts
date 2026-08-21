import { describe, expect, it, vi } from 'vitest';
import { daemonIdentityProvisioner } from '../../src/creation.js';

describe('current daemon identity preflight', () => {
  it('uses only the SDK identity inventory and keeps creation application-owned', async () => {
    const identities = vi.fn(async () => [{ name: 'Existing' }]);
    const attach = vi.fn(async () => ({ identities }));
    const provider = daemonIdentityProvisioner(
      { OURS_CONFIG: '/operator/ours.json' }, attach,
    );
    expect(await provider.exists('Existing')).toBe(true);
    expect(await provider.exists('Missing')).toBe(false);
    expect(provider.create).toBeUndefined();
    expect(provider.remove).toBeUndefined();
    expect(identities).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[0][0]).toMatchObject({
      env: { OURS_CONFIG: '/operator/ours.json' }, clientPid: process.pid,
    });
  });

  it('returns unknown for an unavailable or malformed SDK inventory', async () => {
    const unavailable = daemonIdentityProvisioner({}, async () => { throw new Error('offline'); });
    const malformed = daemonIdentityProvisioner(
      {}, async () => ({ identities: async () => ({ unexpected: true }) as never }),
    );
    expect(await unavailable.exists('Role')).toBe('unknown');
    expect(await malformed.exists('Role')).toBe('unknown');
  });
});
