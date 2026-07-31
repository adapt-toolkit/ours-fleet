import { describe, expect, it } from 'vitest';
import { DaemonAtomicIdentityProvider } from '../../src/infrastructure/daemon-identity.js';

describe('versioned daemon identity transaction provider', () => {
  it('uses a transaction proof for create and rollback removal', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetch = async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.endsWith('/capabilities'))
        return response(200, { protocol: 1, operations: ['reserve', 'create', 'remove_created', 'release'] });
      if (url.endsWith('/identities')) return response(200, { identities: [] });
      if (url.endsWith('/v1/identity-transactions')) return response(200, { transactionId: 'proof-1' });
      return response(200, {});
    };
    const provider = new DaemonAtomicIdentityProvider({
      OURS_MCP_URL: 'http://127.0.0.1:9999', OURS_MCP_TOKEN: 'fixture',
    }, fetch as any);
    expect(await provider.capability()).toMatchObject({ available: true, version: 1 });
    expect(await provider.reserve('Alpha')).toBe(true);
    await provider.create('Alpha', { bio: 'public', persona: 'local' });
    await provider.remove('Alpha');
    await provider.release('Alpha');
    expect(calls.some(call => call.url.endsWith('/proof-1/create'))).toBe(true);
    expect(calls.some(call => call.url.endsWith('/proof-1/created-identity')
      && call.method === 'DELETE')).toBe(true);
    expect(calls.some(call => call.url.endsWith('/proof-1/release'))).toBe(true);
  });

  it('cannot remove an identity without the transaction proof', async () => {
    const provider = new DaemonAtomicIdentityProvider({}, async () => response(200, {}) as any);
    await expect(provider.remove('PreExisting')).rejects.toThrow(/no daemon identity transaction proof/);
  });
});

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}
