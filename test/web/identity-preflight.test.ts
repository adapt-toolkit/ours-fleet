import { describe, expect, it, vi } from 'vitest';
import {
  daemonIdentityInventoryProvisioner, daemonIdentityProvisioner, ensureIdentity,
} from '../../src/creation.js';

describe('current daemon identity preflight', () => {
  it('uses the SDK inventory and exposes deterministic permanent creation', async () => {
    const identities = vi.fn(async () => [{ name: 'Existing' }]);
    const attach = vi.fn(async () => ({ identities }));
    const provider = daemonIdentityProvisioner(
      { OURS_CONFIG: '/operator/ours.json' }, attach,
    );
    expect(await provider.exists('Existing')).toBe(true);
    expect(await provider.exists('Missing')).toBe(false);
    expect(provider.create).toBeTypeOf('function');
    expect(provider.remove).toBeUndefined();
    expect(identities).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[0][0]).toMatchObject({
      env: { OURS_CONFIG: '/operator/ours.json' }, clientPid: process.pid,
    });
  });

  it('creates and releases a permanent identity with the requested local policy', async () => {
    const createIdentity = vi.fn(async () => ({ info: { cid: 'a'.repeat(64) } }));
    const setPersona = vi.fn(async () => ({}));
    const releaseLease = vi.fn(async () => []);
    const attach = vi.fn(async () => ({
      identities: async () => [],
      listIdentities: async () => [{
        name: 'Human', cid: 'b'.repeat(64), kind: 'root' as const, temp: null, session: null,
      }],
      createIdentity, setPersona, releaseLease,
    }));
    const provider = daemonIdentityProvisioner({}, attach);

    const result = await ensureIdentity('Coordinator', {
      bio: 'Coordinates the fleet.', persona: 'Coordinate carefully.',
      exposeLocal: true, localAutoAccept: true,
    }, provider);

    expect(result.state).toBe('created');
    expect(createIdentity).toHaveBeenCalledWith({
      name: 'Coordinator', bio: 'Coordinates the fleet.',
      exposeLocal: true, localAutoAccept: true,
    });
    expect(setPersona).toHaveBeenCalledWith({ persona: 'Coordinate carefully.' });
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('requires a Human identity before creating a permanent role identity', async () => {
    const releaseLease = vi.fn(async () => []);
    const provider = daemonIdentityProvisioner({}, async () => ({
      identities: async () => [], listIdentities: async () => [],
      createIdentity: vi.fn(), releaseLease,
    }));
    await expect(provider.create!('Role', {})).rejects.toThrow(/no Human identity/);
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it('keeps temporary identities visible only to the inventory-only lifecycle', async () => {
    const attach = async () => ({
      identities: async () => [{ name: 'Ephemeral', temporary: true }],
    });
    const permanent = daemonIdentityProvisioner({}, attach);
    const temporary = daemonIdentityInventoryProvisioner({}, attach);

    expect(await permanent.exists('Ephemeral')).toBe(false);
    expect(await temporary.exists('Ephemeral')).toBe(true);
    expect(temporary.create).toBeUndefined();
  });

  it('refuses to adopt a temporary identity as a permanent role', async () => {
    const releaseLease = vi.fn(async () => []);
    const provider = daemonIdentityProvisioner({}, async () => ({
      identities: async () => [{ name: 'Coordinator', temporary: true }],
      listIdentities: async () => [{
        name: 'Coordinator', cid: 'c'.repeat(64), kind: 'role' as const,
        temp: { state: 'other-live' as const, ownerPid: 42 }, session: 'other-live' as const,
      }],
      createIdentity: vi.fn(), releaseLease,
    }));

    await expect(ensureIdentity('Coordinator', {}, provider))
      .rejects.toThrow(/exists but is temporary/);
    expect(releaseLease).toHaveBeenCalledOnce();
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
