import { describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';

describe('browser auth and one-time WebSocket tickets', () => {
  it('binds a purpose/role ticket to one use', () => {
    const auth = new WebAuth('http://127.0.0.1:49271', '127.0.0.1:49271');
    const exchangeRequest = request({
      host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
      authorization: `Bootstrap ${auth.bootstrapSecret}`,
    });
    const session = auth.exchange(exchangeRequest);
    const authenticated = request({
      host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
      cookie: `ofs_session=${session.id}`, 'x-csrf-token': session.csrf,
    });
    const { ticket } = auth.mintTicket(authenticated, 'terminal', 'Alpha');
    expect(auth.consumeTicket(authenticated, ticket, 'terminal', 'Alpha').id).toBe(session.id);
    expect(() => auth.consumeTicket(authenticated, ticket, 'terminal', 'Alpha'))
      .toThrow(/already used/);
  });

  it('idle-expires browser sessions without trusting cookie age', () => {
    let now = 1_000;
    const auth = new WebAuth(
      'http://127.0.0.1:49271', '127.0.0.1:49271', () => now);
    const session = auth.exchange(request({
      host: '127.0.0.1:49271', origin: 'http://127.0.0.1:49271',
      authorization: `Bootstrap ${auth.bootstrapSecret}`,
    }));
    now += 30 * 60_000 + 1;
    expect(() => auth.authenticate(request({
      host: '127.0.0.1:49271', cookie: `ofs_session=${session.id}`,
    }))).toThrow(/expired/);
  });
});

function request(headers: Record<string, string>) {
  return { headers } as any;
}
