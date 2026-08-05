import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebAuth } from '../../src/web/auth.js';
import { TrustedDeviceStore } from '../../src/web/device-store.js';
import { passwordAccess } from '../../src/web/access.js';

const origin = 'http://127.0.0.1:49271';
const host = '127.0.0.1:49271';
const temporaryStore = (now: () => number = Date.now, ttl?: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-device-'));
  return { dir, store: new TrustedDeviceStore(dir, now, ttl) };
};

describe('browser auth and trusted devices', () => {
  it('supports password and intentional unprotected modes without weakening pairing', () => {
    const { store } = temporaryStore();
    const protectedAuth = new WebAuth(origin, host, Date.now, store,
      passwordAccess('correct horse battery staple'));
    expect(protectedAuth.login(request({ host, origin }), 'correct horse battery staple').session.id)
      .toHaveLength(43);
    expect(() => protectedAuth.login(request({ host, origin }), 'wrong password')).toThrow(/invalid/);
    expect(() => protectedAuth.exchange(pairingRequest(protectedAuth))).toThrow(/disabled/);

    const anonymous = new WebAuth(origin, host, Date.now, store, { version: 1, mode: 'none' });
    expect(anonymous.anonymous(request({ host, origin })).id).toHaveLength(43);
    expect(() => anonymous.resume(deviceRequest('missing.token'))).toThrow(/disabled/);
  });

  it('allows a declared proxy to keep its loopback upstream Host while enforcing browser Origin', () => {
    const { store } = temporaryStore();
    const config = passwordAccess('correct horse battery staple');
    const auth = new WebAuth('https://fleet.example.com', 'fleet.example.com', Date.now, store, config);
    auth.setBoundary('https://fleet.example.com', 'fleet.example.com', { hosts: [host] });
    expect(auth.login(request({ host, origin: 'https://fleet.example.com' }),
      'correct horse battery staple').session.id).toHaveLength(43);
    expect(() => auth.login(request({ host, origin: 'http://evil.invalid' }),
      'correct horse battery staple')).toThrow(/Origin/);
  });


  it('binds a purpose/role ticket to one use', () => {
    const { store } = temporaryStore();
    const auth = new WebAuth(origin, host, Date.now, store);
    const { session } = auth.exchange(pairingRequest(auth));
    const authenticated = request({
      host, origin, cookie: `ofs_session=${session.id}`, 'x-csrf-token': session.csrf,
    });
    const { ticket } = auth.mintTicket(authenticated, 'terminal', 'Alpha');
    expect(auth.consumeTicket(authenticated, ticket, 'terminal', 'Alpha').id).toBe(session.id);
    expect(() => auth.consumeTicket(authenticated, ticket, 'terminal', 'Alpha'))
      .toThrow(/already used/);
  });

  it('idle-expires browser sessions without trusting cookie age', () => {
    let now = 1_000;
    const { store } = temporaryStore(() => now);
    const auth = new WebAuth(origin, host, () => now, store);
    const { session } = auth.exchange(pairingRequest(auth));
    now += 30 * 60_000 + 1;
    expect(() => auth.authenticate(request({ host, cookie: `ofs_session=${session.id}` })))
      .toThrow(/expired/);
  });

  it('persists only a strong hash with private modes and resumes after restart', () => {
    let now = 10_000;
    const { dir, store } = temporaryStore(() => now);
    const first = new WebAuth(origin, host, () => now, store);
    const paired = first.exchange(pairingRequest(first));
    const raw = readFileSync(store.path, 'utf8');
    const secret = paired.device.token.split('.')[1];
    expect(raw).not.toContain(paired.device.token);
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw).devices[0].secretHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);

    const restarted = new WebAuth(origin, host, () => now, new TrustedDeviceStore(dir, () => now));
    const resumed = restarted.resume(deviceRequest(paired.device.token));
    expect(resumed.session.id).toHaveLength(43);
    expect(resumed.device.token).not.toBe(paired.device.token);
    expect(() => restarted.resume(deviceRequest(paired.device.token))).toThrow(/revoked/);
    expect(restarted.resume(deviceRequest(resumed.device.token)).session.id).toHaveLength(43);
  });

  it('rejects expired devices, logout revokes current device, and revoke-all clears all', () => {
    let now = 1_000;
    const { store } = temporaryStore(() => now, 100);
    const auth = new WebAuth(origin, host, () => now, store);
    const expired = auth.exchange(pairingRequest(auth));
    now += 101;
    expect(() => auth.resume(deviceRequest(expired.device.token))).toThrow(/expired/);
    expect(store.count()).toBe(0);

    now = 2_000;
    const current = auth.exchange(request({ host, origin, authorization: `Bootstrap ${auth.mintBootstrap()}` }));
    auth.logout(request({
      host, origin,
      // Revocation is bound to the authenticated session, not to a caller-
      // supplied device cookie that could be omitted or substituted.
      cookie: `ofs_session=${current.session.id}`,
      'x-csrf-token': current.session.csrf,
    }));
    expect(() => auth.resume(deviceRequest(current.device.token))).toThrow(/revoked/);

    const another = auth.exchange(request({ host, origin, authorization: `Bootstrap ${auth.mintBootstrap()}` }));
    expect(auth.revokeAllTrustedDevices()).toBe(1);
    expect(() => auth.resume(deviceRequest(another.device.token))).toThrow(/revoked/);
  });

  /**
   * The limiter is production behaviour and stays exactly as strict. The reset
   * exists for a harness that drives one long-lived server through many
   * independent browser sessions; it clears counters and nothing else, and no
   * HTTP route in `buildWebServer` reaches it.
   */
  it('rate-limits pairing and password attempts, and clears only the counters on reset', () => {
    const { store } = temporaryStore();
    const auth = new WebAuth(origin, host, Date.now, store);

    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(() => auth.exchange(request({ host, origin, authorization: 'Bootstrap wrong' })))
        .toThrow(/invalid or expired/);
    // The eleventh in the window is refused before the credential is even read.
    expect(() => auth.exchange(pairingRequest(auth))).toThrow(/rate limit exceeded/);

    auth.clearRateLimits();
    const paired = auth.exchange(request({ host, origin, authorization: `Bootstrap ${auth.mintBootstrap()}` }));
    expect(paired.session.id).toHaveLength(43);
    // The budget is restored, not removed: the limit still bites afterwards.
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(() => auth.exchange(request({ host, origin, authorization: 'Bootstrap wrong' }))).toThrow();
    expect(() => auth.exchange(pairingRequest(auth))).toThrow(/rate limit exceeded/);

    // Sessions, devices and the boundary are untouched by the reset.
    auth.clearRateLimits();
    expect(auth.authenticate(request({ host, cookie: `ofs_session=${paired.session.id}` })).id)
      .toBe(paired.session.id);
    expect(() => auth.exchange(request({ host, origin: 'http://evil.invalid', authorization: 'Bootstrap x' })))
      .toThrow(/Origin/);

    const password = new WebAuth(origin, host, Date.now, store,
      passwordAccess('correct horse battery staple'));
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect(() => password.login(request({ host, origin }), 'wrong password')).toThrow(/invalid/);
    expect(() => password.login(request({ host, origin }), 'correct horse battery staple'))
      .toThrow(/rate limit exceeded/);
    password.clearRateLimits();
    expect(password.login(request({ host, origin }), 'correct horse battery staple').session.id)
      .toHaveLength(43);
  });

  it('fails closed on corrupt content and replaces it only on explicit pairing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ours-fleet-device-corrupt-'));
    writeFileSync(join(dir, 'trusted-devices.json'), '{not-json', { mode: 0o666 });
    const store = new TrustedDeviceStore(dir);
    expect(store.count()).toBe(0);
    const issued = store.issue();
    expect(readFileSync(store.path, 'utf8')).not.toContain(issued.token);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });
});

function pairingRequest(auth: WebAuth) {
  return request({ host, origin, authorization: `Bootstrap ${auth.bootstrapSecret}` });
}

function deviceRequest(token: string) {
  return request({ host, origin, cookie: `ofs_device=${token}` });
}

function request(headers: Record<string, string>) {
  return { headers } as any;
}
