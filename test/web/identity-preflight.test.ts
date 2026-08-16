import { describe, expect, it } from 'vitest';
import { daemonIdentityProvisioner } from '../../src/creation.js';

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

describe('current daemon identity preflight', () => {
  it('uses only the authenticated identities read endpoint', async () => {
    const calls: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
    const provider = daemonIdentityProvisioner(
      { OURS_PORT: '4444', OURS_API_TOKEN: 'test-token' },
      async (url, init) => {
        calls.push({ url, init: init as { headers?: Record<string, string> } });
        return response(200, { identities: [{ name: 'Existing' }] }) as never;
      },
    );
    expect(await provider.exists('Existing')).toBe(true);
    expect(await provider.exists('Missing')).toBe(false);
    expect(provider.create).toBeUndefined();
    expect(provider.remove).toBeUndefined();
    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:4444/identities',
      'http://127.0.0.1:4444/identities',
    ]);
    expect(calls[0].init?.headers).toMatchObject({ 'x-ours-api-token': 'test-token' });
  });

  it('returns unknown for an unavailable or malformed daemon response', async () => {
    const unavailable = daemonIdentityProvisioner(
      { OURS_PORT: '4444' },
      async () => response(503, {}) as never,
    );
    const malformed = daemonIdentityProvisioner(
      { OURS_PORT: '4444' },
      async () => response(200, { unexpected: true }) as never,
    );
    expect(await unavailable.exists('Role')).toBe('unknown');
    expect(await malformed.exists('Role')).toBe('unknown');
  });
});
